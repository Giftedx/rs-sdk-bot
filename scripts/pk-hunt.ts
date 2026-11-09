// Wilderness PK hunt over the whole surface Wilderness.
// The world feed roster shows every player's tile and combat level, so the hunter picks the target it can reach
// first, runs to where that target will be (cutting it off on its way south), freezes it when it runs, and keeps
// attacking with the style the target does not protect against until the target dies, logs out or leaves.
//
// usage: bun scripts/pk-hunt.ts <account> [MAX_MINUTES=20] [MAX_WILD=56] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT]
//        [RANGED=bow-name-regex] [LOOT=1] [FREEZE=1]
// The account starts south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { tradePartners } from '../packages/core/src/tradeguard';
import { openStyles, readOpponent, type CombatStyle } from '../packages/core/src/opponent';

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

// The roster target we can meet first and attack at the meeting tile.
export function pickTrack(me: { x: number; z: number; combat: number }, tracks: Track[], friends: ReadonlySet<string>, maxWild: number, skip: ReadonlySet<string> = new Set()) {
    let best: { track: Track; at: { x: number; z: number; ticks: number } } | null = null;
    for (const t of tracks) {
        const key = t.name.toLowerCase();
        if (friends.has(key) || skip.has(key) || wildLevel(t.x, t.z) === 0 || wildLevel(t.x, t.z) > maxWild) continue;
        const at = intercept(me, t);
        if (!canAttack({ x: at.x, z: at.z, combat: me.combat }, { x: at.x, z: at.z, combatLevel: t.combatLevel })) continue;
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

type Cfg = { maxMs: number; maxWild: number; eatAt: number; fleeAt: number; spell: string; ranged?: RegExp; loot: boolean; freeze: boolean };

// The account's server, from the SERVER line of its bot.env (the same file openBot reads).
export function accountServer(name: string, root = resolve(import.meta.dir, '..')): string {
    return serverFromEnv(readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8'));
}

export async function huntOnce(session: Session, cfg: Cfg, stopped: () => boolean, emit: (e: object) => void, server = accountServer(session.name)) {
    const { sdk, bot } = session;
    const me = () => { const p = sdk.getState()?.player; return p && { x: p.worldX, z: p.worldZ, level: p.level, combat: p.combatLevel, hp: p.hp, maxHp: p.maxHp }; };
    const friends = new Set([...tradePartners(server)].map(n => n.toLowerCase()));
    friends.add(session.name.toLowerCase());
    const radar = new Radar();
    const closeRadar = connectRadar(server, radar);
    const end = Date.now() + cfg.maxMs;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    const freeze = cfg.freeze ? freezeSpell(magic) : null;
    const styles = (): CombatStyle[] => [
        'melee',
        ...(cfg.ranged && [...sdk.getInventory(), ...sdk.getEquipment()].some(i => cfg.ranged!.test(i.name)) ? ['ranged' as const] : []),
        ...(magic >= 13 ? ['magic' as const] : []),
    ];
    const meleeWeapon = sdk.getEquipment().find(i => i.slot === 3)?.name;
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, freezes: 0, chases: 0, loot: [] as string[], targets: [] as string[] };
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
    let style: CombatStyle = 'melee';
    let wentIn = false;

    const setStyle = async (s: CombatStyle, target: string) => {
        if (s === style) return;
        if (s === 'ranged' && cfg.ranged) await bot.equipItem(cfg.ranged);
        if (s === 'melee' && style === 'ranged' && meleeWeapon) await bot.equipItem(new RegExp('^' + meleeWeapon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
        style = s;
        emit({ e: 'style', style: s, target });
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
        let lastTile: { x: number; z: number } | null = null, lastDist = Infinity, frozeAt = -100, contactAt = session.tick();
        while (!stopped() && Date.now() < end) {
            const s = await survive();
            if (s !== 'ok') return s;
            const m = me()!;
            const near = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
            const track = radar.tracks.get(name.toLowerCase());
            const opp = near ? readOpponent(session.client, name) : null;
            if (opp?.hp?.fresh && opp.hp.current === 0) {
                stats.kills++; emit({ e: 'kill', target: name, at: lastTile });
                await sdk.waitForTicks(4);
                if (cfg.loot && lastTile) await lootAt(session, lastTile, stats, emit);
                return 'kill';
            }
            if (!near && radar.fresh() && !track) { emit({ e: 'gone', target: name, at: lastTile }); if (cfg.loot && lastTile && cheb(m, lastTile) <= 3) await lootAt(session, lastTile, stats, emit); return 'gone'; }
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
                // Freeze a runner, then close in.
                if (freeze && fleeing && session.tick() - frozeAt > 25) {
                    const r = await bot.castSpell(near as any, freeze);
                    frozeAt = session.tick();
                    if (r.success) stats.freezes++;
                    emit({ e: 'freeze', target: name, spell: freeze, ok: r.success, msg: r.success ? undefined : r.message });
                    continue;
                }
                const open = opp ? openStyles(opp, styles()) : styles();
                await setStyle(open.includes(style) ? style : open[0] ?? style, name);
                const engaged = sdk.getState()?.player?.combat?.targetType === 'player';
                if (!engaged || style === 'magic') {
                    if (!canAttack(m, near)) {
                        // Out of level range here: step toward the target, which takes us deeper.
                        await walkPath(walker, [{ x: near.x, z: near.z, tol: 1 }], { maxTicks: 4, idleMs: 9000, stop: stopped });
                        continue;
                    }
                    const r = style === 'magic' ? await bot.castSpell(near as any, cfg.spell) : await bot.attack(near as any);
                    stats.attacks++;
                    emit({ e: 'attack', target: name, style, protect: opp?.protect, hp: opp?.hp, ok: r.success, msg: r.success ? undefined : r.message });
                }
                await sdk.waitForTicks(1);
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
                // Nobody attackable: walk north into the Wilderness so the level range opens up.
                const goal = { x: m.x < 2960 || m.x > 3380 ? 3090 : m.x, z: Math.min(3520 + cfg.maxWild * 8 - 4, m.z + 24) };
                await walkPath(walker, [{ ...goal, tol: 3 }], { maxTicks: 30, idleMs: 9000, stop: () => stopped() || !!pickTrack(me()!, tracks(), friends, cfg.maxWild, skip) });
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
        }
        const m = me();
        if (m && wildLevel(m.x, m.z) > 0 && stats.deaths === 0) {
            await walkPath(walker, [{ x: 3094, z: 3505, tol: 4 }], { maxTicks: 600, idleMs: 9000, stop: stopped });
        }
    } finally { closeRadar(); }
    return stats;
}

async function lootAt(session: Session, at: { x: number; z: number }, stats: { loot: string[] }, emit: (e: object) => void) {
    const { sdk, bot } = session;
    for (let i = 0; i < 12; i++) {
        const item = (sdk.getState()?.groundItems ?? []).find((g: any) => Math.abs(g.x - at.x) <= 1 && Math.abs(g.z - at.z) <= 1);
        if (!item || sdk.getInventory().length >= 28) break;
        const r = await bot.pickupItem(item as any);
        if (r.success) { stats.loot.push(item.name); emit({ e: 'loot', item: item.name, count: item.count }); }
        else break;
    }
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

if (import.meta.main) {
    const [name, ...args] = process.argv.slice(2);
    if (!name) throw new Error('usage: bun scripts/pk-hunt.ts <account> [MAX_MINUTES=20] [MAX_WILD=56] [EAT_AT=50] [FLEE_AT=30] [SPELL=FIRE_BOLT] [RANGED=regex] [LOOT=1] [FREEZE=1]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('pk-hunt stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '56')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'FIRE_BOLT'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
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
