// Wilderness PK hunt over the whole surface Wilderness.
// The world feed roster shows every player's tile and combat level, so the hunter picks the target it can reach
// first, runs to where that target will be (cutting it off on its way south), freezes it when it runs, and keeps
// attacking with the style the target does not protect against until the target dies, logs out or leaves.
//
// usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=56] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT]
//        [RANGED=bow-name-regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=1000] [BANK_AT=100000]
// The account starts south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt (shared with scripts/pk-hunt.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { tradePartners } from '../packages/core/src/tradeguard';
import { readOpponent } from '../packages/core/src/opponent';
import { fightPlayer, type Kit } from './pk';

// Surface Wilderness (content area_wilderness wilderness_zones: 0_46_55 to 3_52_99, 8 tiles per level).
export function wildLevel(x: number, z: number): number {
    if (x < 2944 || x > 3391 || z < 3520 || z > 3967) return 0;
    return Math.floor((z - 3520) / 8) + 1;
}

// pvp_combat.rs2: the combat gap must be no more than the lower of the two Wilderness levels.
export function canAttack(me: { x: number; z: number; combat: number }, them: { x: number; z: number; combatLevel: number }): boolean {
    const a = wildLevel(me.x, me.z), b = wildLevel(them.x, them.z);
    return a > 0 && b > 0 && Math.abs(me.combat - them.combatLevel) <= Math.min(a, b);
}

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const clampWild = (p: { x: number; z: number }) => ({ x: Math.min(3391, Math.max(2944, p.x)), z: Math.min(3967, Math.max(3520, p.z)) });

export type Track = { name: string; x: number; z: number; combatLevel: number; vx: number; vz: number };

// Where to run to meet a moving target: the first tick t at which we (2 tiles per tick running) can stand on its
// predicted tile. A target running south at full speed from behind has no meeting point; then the hunter heads for
// the tile 30 ticks along its line, which puts it between the target and the south edge.
export function intercept(me: { x: number; z: number }, t: Track, speed = 2, horizon = 120): { x: number; z: number; ticks: number } {
    for (let tick = 0; tick <= horizon; tick++) {
        const p = clampWild({ x: Math.round(t.x + t.vx * tick), z: Math.round(t.z + t.vz * tick) });
        if (cheb(me, p) <= speed * tick) return { ...p, ticks: tick };
    }
    const p = clampWild({ x: Math.round(t.x + t.vx * 30), z: Math.round(t.z + t.vz * 30) });
    return { ...p, ticks: horizon + cheb(me, p) / speed };
}

// The lowest z at which a combat gap is still attackable: Wilderness level >= gap.
export function escapeZ(gap: number): number {
    return 3520 + (Math.max(gap, 1) - 1) * 8;
}

// Tiles a target at the meeting tile must run south to get out of attack range. 16 tiles is 8 ticks running:
// time to freeze it before it escapes.
export const MIN_ESCAPE_TILES = 16;

// The roster target we can meet first, attack at the meeting tile, and freeze before it runs out of range.
export function pickTrack(me: { x: number; z: number; combat: number }, tracks: Track[], friends: ReadonlySet<string>, maxWild: number, skip: ReadonlySet<string> = new Set(), minEscape = MIN_ESCAPE_TILES) {
    let best: { track: Track; at: { x: number; z: number; ticks: number } } | null = null;
    for (const t of tracks) {
        const key = t.name.toLowerCase();
        if (friends.has(key) || skip.has(key) || wildLevel(t.x, t.z) === 0 || wildLevel(t.x, t.z) > maxWild) continue;
        const at = intercept(me, t);
        if (!canAttack({ x: at.x, z: at.z, combat: me.combat }, { x: at.x, z: at.z, combatLevel: t.combatLevel })) continue;
        if (at.z - escapeZ(Math.abs(me.combat - t.combatLevel)) < minEscape) continue;
        if (!best || at.ticks < best.at.ticks) best = { track: t, at };
    }
    return best;
}

// Two roster frames 10 ticks apart give each player's tile and velocity in tiles per tick.
export class Radar {
    private prev = new Map<string, { x: number; z: number; k: number }>();
    tracks = new Map<string, Track>();
    tick = -1;
    at = 0;
    accept(m: { t?: string; k?: number; p?: [number, string, number, number, number, number][] }, now = Date.now()) {
        if (m?.t !== 'roster' || !Array.isArray(m.p) || typeof m.k !== 'number') return;
        const next = new Map<string, Track>();
        for (const [, name, x, z, plane, combatLevel] of m.p) {
            if (plane !== 0 || typeof name !== 'string') continue;
            const key = name.toLowerCase(), old = this.prev.get(key), dt = old ? m.k - old.k : 0;
            next.set(key, { name, x, z, combatLevel, vx: dt > 0 ? (x - old!.x) / dt : 0, vz: dt > 0 ? (z - old!.z) / dt : 0 });
        }
        this.prev = new Map([...next].map(([k, t]) => [k, { x: t.x, z: t.z, k: m.k! }]));
        this.tracks = next;
        this.tick = m.k;
        this.at = now;
    }
    fresh(now = Date.now()) { return now - this.at < 15_000; }
}

function connectRadar(server: string, radar: Radar) {
    const url = `${isLocalServer(server) ? 'ws' : 'wss'}://${server}/worldfeed`;
    const socket = new WebSocket(url);
    let beat: ReturnType<typeof setInterval> | undefined;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'roster', on: true }));
        beat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' })); }, 30_000);
    });
    socket.addEventListener('message', ({ data }) => { try { radar.accept(JSON.parse(String(data))); } catch { /* not a roster frame */ } });
    socket.addEventListener('close', () => { if (beat) clearInterval(beat); });
    return () => { if (beat) clearInterval(beat); socket.close(); };
}

// Strongest freeze the account can cast (components from pack/interface.pack magic:bind/snare/entangle).
export function freezeSpell(magic: number): number | null {
    return magic >= 79 ? 1592 : magic >= 50 ? 1582 : magic >= 20 ? 1572 : null;
}

// friends replaces the fleet list of accounts never to attack (practice passes its own target's absence).
type Cfg = { maxMs: number; maxWild: number; eatAt: number; fleeAt: number; spell: string; ranged?: RegExp; loot: boolean; freeze: boolean; friends?: readonly string[];
    // Pick up stacks worth at least lootMin gp; bank when carried loot reaches bankAt gp (defaults 1,000 and 100,000).
    lootMin?: number; bankAt?: number };

// Sweep tiles across the Wilderness, west to east and back, shallow to deep.
export function sweep(maxWild: number): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    const zs = [3540, 3620, 3700, 3780, 3860, 3940].filter(z => wildLevel(3100, z) <= maxWild);
    zs.forEach((z, i) => { const xs = [2970, 3060, 3150, 3240, 3330]; pts.push(...(i % 2 ? xs.reverse() : xs).map(x => ({ x, z }))); });
    return pts.length ? pts : [{ x: 3090, z: 3524 }];
}

type Item = { id: number; name: string; slot?: number };
// Fight kit for scripts/pk.ts: melee wields the worn weapon and shield, ranged a carried bow (RANGED, default any bow),
// magic a carried staff. Magic with no staff casts with whatever is wielded (an empty list switches nothing).
export function kitFrom(worn: readonly Item[], carried: readonly Item[], ranged = /bow$/i): Kit {
    const kit: Kit = { magic: [] };
    const melee = worn.filter(i => i.slot === 3 || i.slot === 5).filter(i => !ranged.test(i.name) && !/staff/i.test(i.name)).map(i => i.id);
    if (melee.length) kit.melee = melee;
    const bow = [...worn, ...carried].find(i => ranged.test(i.name));
    if (bow) kit.ranged = [bow.id];
    const staff = [...worn, ...carried].find(i => /staff/i.test(i.name));
    if (staff) kit.magic = [staff.id];
    return kit;
}

// Damage spell components (vendor/rs-sdk/sdk/spells.ts) by SPELL name.
const SPELL_IDS: Record<string, number> = { FIRE_STRIKE: 1158, FIRE_BOLT: 1169, FIRE_BLAST: 1181, FIRE_WAVE: 1189 };
export function spellId(name: string): number {
    const n = Number(name);
    return SPELL_IDS[name.toUpperCase()] ?? (Number.isInteger(n) && n > 0 ? n : SPELL_IDS.FIRE_BOLT);
}

// The account's server, from the SERVER line of its bot.env (the same file openBot reads).
export function accountServer(name: string, root = resolve(import.meta.dir, '..')): string {
    return serverFromEnv(readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8'));
}

export async function huntOnce(session: Session, cfg: Cfg, stopped: () => boolean, emit: (e: object) => void, server = accountServer(session.name)) {
    const { sdk, bot } = session;
    const me = () => { const p = sdk.getState()?.player; return p && { x: p.worldX, z: p.worldZ, level: p.level, combat: p.combatLevel, hp: p.hp, maxHp: p.maxHp }; };
    const friends = new Set([...(cfg.friends ?? tradePartners(server))].map(n => n.toLowerCase()));
    friends.add(session.name.toLowerCase());
    const route = sweep(cfg.maxWild);
    let leg = -1;
    const radar = new Radar();
    const closeRadar = connectRadar(server, radar);
    const end = Date.now() + cfg.maxMs;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const freeze = cfg.freeze ? freezeSpell(magic) : null;
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, freezes: 0, chases: 0, loot: [] as string[], lootValue: 0, banked: 0, targets: [] as string[] };
    const walker = await sessionWalker(session);
    const skip = new Set<string>();
    // Roster tracks plus the players the client sees now; the client copy wins for players in view.
    const tracks = (): Track[] => {
        const all = new Map(radar.fresh() ? radar.tracks : []);
        for (const p of sdk.getState()?.nearbyPlayers ?? []) {
            const key = p.name.toLowerCase(), old = all.get(key);
            all.set(key, { name: p.name, x: p.x, z: p.z, combatLevel: p.combatLevel, vx: old?.vx ?? 0, vz: old?.vz ?? 0 });
        }
        return [...all.values()];
    };
    let wentIn = false;
    let spun = -1;
    // The fight kit is read once, as staged: the worn weapon and shield, a bow and a staff carried.
    const kit = kitFrom(sdk.getEquipment(), sdk.getInventory(), cfg.ranged);
    emit({ e: 'kit', kit });
    // Loot and banking: everything staged at the start is kit; anything else carried is loot.
    const keep = new Set([...sdk.getInventory(), ...sdk.getEquipment()].map(i => i.id));
    const startFood = food()[0];
    const foodCount = startFood ? sdk.getInventory().filter(i => i.id === startFood.id).length : 0;
    const valuer = makeValuer(server);
    const lootMin = cfg.lootMin ?? 1000, bankAt = cfg.bankAt ?? 100_000;
    let carried = 0;
    const loot = async (at: { x: number; z: number }) => { carried += await lootAt(session, at, { value: valuer, min: lootMin, stats, emit }); };
    const needBank = () => carried >= bankAt || 28 - sdk.getInventory().length <= 2;
    const bank = async (why: string) => {
        emit({ e: 'bank-trip', why, carried });
        const ok = await bankTrip(session, walker, keep, startFood?.id, foodCount, stopped, emit);
        if (ok) { stats.banked += carried; carried = 0; }
        return ok;
    };

    const survive = async (): Promise<'ok' | 'flee' | 'dead'> => {
        const m = me();
        if (!m) return 'ok';
        if (wildLevel(m.x, m.z) > 0) wentIn = true;
        if (wentIn && cheb(m, { x: 3222, z: 3218 }) <= 6) { stats.deaths++; emit({ e: 'death' }); return 'dead'; }
        if (m.hp * 100 <= m.maxHp * cfg.eatAt && food().length) {
            const r = await bot.eatFood(food()[0]);
            stats.eats++; emit({ e: 'eat', hp: m.hp, ok: r.success });
        } else if (m.hp * 100 <= m.maxHp * cfg.fleeAt && !food().length) return 'flee';
        return 'ok';
    };

    // Fight one target until it dies, logs out, leaves the Wilderness, or the chase stalls.
    const chase = async (name: string): Promise<'kill' | 'gone' | 'left' | 'stall' | 'flee' | 'dead' | 'stop'> => {
        stats.chases++;
        let lastTile: { x: number; z: number } | null = null, lastDist = Infinity, contactAt = session.tick();
        let held = false, freezeReady = 0, lastSeenAt: { x: number; z: number } | null = null;
        while (!stopped() && Date.now() < end) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s !== 'ok') return s;
            const m = me()!;
            const near = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
            const track = radar.tracks.get(name.toLowerCase());
            const opp = near ? readOpponent(session.client, name) : null;
            if (opp?.hp?.fresh && opp.hp.current === 0) {
                stats.kills++; emit({ e: 'kill', target: name, at: lastTile });
                await sdk.waitForTicks(4);
                if (cfg.loot && lastTile) await loot(lastTile);
                return 'kill';
            }
            if (!near && radar.fresh() && !track) { emit({ e: 'gone', target: name, at: lastTile }); if (cfg.loot && lastTile && cheb(m, lastTile) <= 3) await loot(lastTile); return 'gone'; }
            const pos = near ?? track;
            if (!pos) {
                // No radar and out of view: give up after 60 ticks.
                if (session.tick() - contactAt > 60) { emit({ e: 'gone', target: name, at: lastTile }); return 'gone'; }
                await sdk.waitForTicks(1); continue;
            }
            if (wildLevel(pos.x, pos.z) === 0) { emit({ e: 'left', target: name }); return 'left'; }
            lastTile = { x: pos.x, z: pos.z };

            if (near && near.distance <= 15) {
                contactAt = session.tick();
                const fleeing = near.distance > lastDist && near.distance >= 2;
                lastDist = near.distance;
                // The SDK reports every freeze as a hit (the server grants the XP before the hit roll), so a held
                // target is one that stops moving: a move after a freeze means it splashed or ended.
                if (held && lastSeenAt && cheb(lastSeenAt, near) >= 1) { held = false; freezeReady = Math.min(freezeReady, session.tick()); }
                lastSeenAt = { x: near.x, z: near.z };
                // Freeze first, at first reach, before the target can run; freeze again whenever it moves.
                if (freeze && canAttack(m, near) && session.tick() >= freezeReady && !held) {
                    const r = await bot.castSpell(near as any, freeze);
                    if (r.success) { held = true; stats.freezes++; lastSeenAt = { x: near.x, z: near.z }; }
                    freezeReady = session.tick() + 3;
                    emit({ e: 'freeze', target: name, spell: freeze, ok: r.success, msg: r.success ? undefined : r.message });
                    continue;
                }
                if (!canAttack(m, near)) {
                    // Out of level range here: step toward the target, which takes us deeper.
                    await walkPath(walker, [{ x: near.x, z: near.z, tol: 1 }], { maxTicks: 4, idleMs: 9000, stop: stopped });
                    continue;
                }
                // The tribrid fight itself: scripts/pk.ts fightPlayer (style off the overhead, gear switch per turn,
                // food, prayer, glory escape), 50 ticks at a time. It keeps waiting on a target that is still in the
                // scene but out of range or out of the Wilderness (practice: 600 idle ticks), so the chase re-checks
                // range and re-aims between calls.
                stats.attacks++;
                const fight = await fightPlayer(session, name, {
                    kit, freeze: !!freeze, eatAt: cfg.eatAt,
                    escapeAt: Math.ceil((me()?.maxHp ?? 99) * cfg.fleeAt / 100), damageSpell: spellId(cfg.spell), cap: 50,
                    log: line => emit({ e: "fight", line }),
                });
                emit({ e: "fight-end", target: name, outcome: fight.outcome, ticks: fight.ticks, dealt: fight.dealt, taken: fight.taken, eaten: fight.eaten });
                stats.eats += fight.eaten;
                if (fight.outcome === "kill") {
                    stats.kills++;
                    const at = fight.targetAt ?? lastTile;
                    await sdk.waitForTicks(4);
                    if (cfg.loot && at) await loot(at);
                    return "kill";
                }
                if (fight.outcome === "died") { stats.deaths++; return "dead"; }
                if (fight.outcome === "escaped") return "flee";
                lastDist = Infinity;
                continue;
            }
            // Out of view: run to the cut-off tile, re-aimed on each new roster frame.
            if (session.tick() - contactAt > 400) { emit({ e: 'stall', target: name }); return 'stall'; }
            const aim = track ? intercept(m, track) : { ...pos, ticks: 0 };
            const frame = radar.tick;
            await walkPath(walker, [{ x: aim.x, z: aim.z, tol: 2 }], {
                maxTicks: 40, idleMs: 9000,
                stop: () => stopped() || radar.tick !== frame ||
                    !!sdk.getState()?.nearbyPlayers.some(p => p.name.toLowerCase() === name.toLowerCase() && p.distance <= 15),
            });
        }
        return 'stop';
    };

    try {
        while (!stopped() && Date.now() < end) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s === 'dead') break;
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (s === 'flee') {
                emit({ e: 'flee', hp: m.hp });
                await walkPath(walker, [{ x: m.x, z: 3510, tol: 3 }], { maxTicks: 300, idleMs: 9000, stop: stopped });
                break;
            }
            const pick = pickTrack(m, tracks(), friends, cfg.maxWild, skip);
            if (!pick) {
                // Nobody attackable: sweep the Wilderness. Start at the nearest sweep tile, then go round.
                if (leg < 0) leg = route.reduce((b, p, i) => cheb(p, m) < cheb(route[b], m) ? i : b, 0);
                else if (cheb(route[leg], m) <= 4) leg = (leg + 1) % route.length;
                const before = session.tick();
                await walkPath(walker, [{ ...route[leg], tol: 3 }], { maxTicks: 30, idleMs: 9000, stop: () => stopped() || !!pickTrack(me()!, tracks(), friends, cfg.maxWild, skip) });
                // Never spin: a walk that used no tick (blocked or already there) moves to the next leg and waits.
                if (session.tick() === before) { leg = (leg + 1) % route.length; await sdk.waitForTicks(1); }
                continue;
            }
            const name = pick.track.name;
            stats.targets.push(name);
            emit({ e: 'target', target: name, combat: pick.track.combatLevel, wild: wildLevel(pick.track.x, pick.track.z), meetIn: Math.round(pick.at.ticks), at: [pick.track.x, pick.track.z] });
            const outcome = await chase(name);
            emit({ e: 'chase-end', target: name, outcome });
            if (outcome === 'dead' || outcome === 'stop') break;
            if (outcome === 'flee') {
                const at = me()!;
                await walkPath(walker, [{ x: at.x, z: 3510, tol: 3 }], { maxTicks: 300, idleMs: 9000, stop: stopped });
                break;
            }
            if (outcome === 'stall' || outcome === 'left') skip.add(name.toLowerCase());
            if (needBank() && !(await bank(carried >= bankAt ? 'loot value' : 'pack full'))) break;
        }
        // Bank whatever loot is carried before logging out; with none, just leave the Wilderness.
        const m = me();
        if (m && stats.deaths === 0) {
            if (sdk.getInventory().some(i => !keep.has(i.id))) await bank('end of hunt');
            else if (wildLevel(m.x, m.z) > 0) await walkPath(walker, [{ x: 3094, z: 3505, tol: 4 }], { maxTicks: 600, idleMs: 9000, stop: stopped });
        }
    } finally { closeRadar(); }
    return stats;
}

// Item value in gp: the live market (referencePrice, else lastPrice, else basePrice), cached per item; with no market
// (a practice server or a failed request) the item cost in knowledge/items.json. Coins are 1 gp each.
let costs: Map<number, number> | undefined;
export function itemCost(id: number, root = resolve(import.meta.dir, '..')): number {
    costs ??= new Map((JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[]).map(i => [i.id, i.cost ?? 0]));
    return costs.get(id) ?? 0;
}
export function makeValuer(server: string, get: (url: string) => Promise<any> = async url => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()) {
    const cache = new Map<number, number>();
    return async (id: number): Promise<number> => {
        if (id === 995) return 1;
        if (cache.has(id)) return cache.get(id)!;
        let price = 0;
        if (!isLocalServer(server)) {
            try { const r = await get(`https://${server}/api/market/items/${id}`); price = r?.referencePrice ?? r?.lastPrice ?? r?.basePrice ?? 0; }
            catch { /* market down: cost below */ }
        }
        if (!(price > 0)) price = itemCost(id);
        cache.set(id, price);
        return price;
    };
}

type Ground = { id: number; name: string; count: number; x: number; z: number };
// The stacks on and next to the kill tile worth at least min gp, most valuable first.
export function planLoot(ground: readonly Ground[], at: { x: number; z: number }, price: ReadonlyMap<number, number>, min: number) {
    return ground.filter(g => cheb(g, at) <= 1).map(g => ({ ...g, value: (price.get(g.id) ?? 0) * g.count }))
        .filter(g => g.value >= min).sort((a, b) => b.value - a.value);
}

// Picks up the valuable stacks at a kill tile; a full pack eats a food to make room. Returns the gp picked up.
async function lootAt(session: Session, at: { x: number; z: number }, ctx: { value: (id: number) => Promise<number>; min: number; stats: { loot: string[]; lootValue: number }; emit: (e: object) => void }) {
    const { sdk, bot } = session;
    const ground = (sdk.getState()?.groundItems ?? []) as unknown as Ground[];
    const price = new Map<number, number>();
    for (const g of ground) if (cheb(g, at) <= 1 && !price.has(g.id)) price.set(g.id, await ctx.value(g.id));
    let got = 0;
    for (const g of planLoot(ground, at, price, ctx.min)) {
        const stacks = sdk.getInventory().some(i => i.id === g.id && i.count > 1);
        if (sdk.getInventory().length >= 28 && !stacks) {
            const meal = sdk.getInventory().find(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
            if (!meal) { ctx.emit({ e: 'loot-skipped', item: g.name, value: g.value, why: 'pack full' }); continue; }
            await bot.eatFood(meal);
        }
        const live = (sdk.getState()?.groundItems ?? []).find((x: any) => x.id === g.id && x.x === g.x && x.z === g.z);
        if (!live) continue;
        const r = await bot.pickupItem(live as any);
        if (!r.success) { ctx.emit({ e: 'loot-failed', item: g.name, msg: r.message }); continue; }
        got += g.value; ctx.stats.lootValue += g.value; ctx.stats.loot.push(g.name);
        ctx.emit({ e: 'loot', item: g.name, count: g.count, value: g.value });
    }
    return got;
}

export const EDGEVILLE_BANK_TILE = { x: 3094, z: 3492 };
// Walks to Edgeville bank, deposits everything that is not kit, takes food back to its staged count. True when banked.
async function bankTrip(session: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, keep: ReadonlySet<number>, foodId: number | undefined, foodCount: number, stopped: () => boolean, emit: (e: object) => void): Promise<boolean> {
    const { sdk, bot } = session;
    const walk = await walkPath(walker, [{ ...EDGEVILLE_BANK_TILE, tol: 3 }], { maxTicks: 900, idleMs: 9000, stop: stopped });
    if (!walk.ok) { emit({ e: 'bank-failed', why: 'walk', detail: walk.detail }); return false; }
    if (!(await bot.openBank()).success) { emit({ e: 'bank-failed', why: 'open' }); return false; }
    const deposited: string[] = [];
    for (const item of [...sdk.getInventory()]) {
        if (keep.has(item.id) || deposited.includes(item.name)) continue;
        const r = await bot.depositItem(item, -1);
        if (r.success) deposited.push(item.name);
    }
    let restocked = 0;
    const have = foodId === undefined ? 0 : sdk.getInventory().filter(i => i.id === foodId).length;
    if (foodId !== undefined && have < foodCount) {
        const r = await bot.withdrawItem(foodId, foodCount - have);
        if (r.success) restocked = foodCount - have;
    }
    await bot.closeBank();
    emit({ e: 'banked', deposited, restocked });
    return true;
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

if (import.meta.main) {
    const [name, ...args] = process.argv.slice(2);
    if (!name) throw new Error('usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=56] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT] [RANGED=regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=1000] [BANK_AT=100000]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('PK stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '56')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'FIRE_BOLT'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
        lootMin: Number(arg(args, 'LOOT_MIN', '1000')), bankAt: Number(arg(args, 'BANK_AT', '100000')),
    };
    const session = await openBot(name);
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: session.tick(), ...e }));
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    try { result = await huntOnce(session, cfg, stop, emit); }
    catch (error) { failure = String(error); }
    const ok = !!result && !failure;
    const loggedOut = await settle([session], ok, failure ?? `PK hunt: ${result!.kills} kills, ${result!.deaths} deaths, ${result!.attacks} attacks`);
    console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result, loggedOut }));
    process.exitCode = ok && loggedOut ? 0 : 1;
}
