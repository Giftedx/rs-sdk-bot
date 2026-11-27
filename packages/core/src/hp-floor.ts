// HP floor: the last guard against a death, in every session.
//
// startInProcessSession (inprocess/connect.ts) installs one floor in each session it opens, so no script can run
// without it; openBot (bot/open.ts) only gives it the session's log, stop and quest reserve. The guards above it (the
// eat guard, the flee guard, the script's own eater) act first at their own lines. The floor acts when they did not:
//
// - The floor line is FLOOR_HITS hits of the largest hit in reach: the larger of the largest Hitpoints drop of one
//   tick in the last HIT_WINDOW ticks and the summed max-hit estimate of the attackers in view (npcMaxHitEstimate for
//   an NPC, playerMaxHitEstimate for a player). It is never a fixed number.
// - At or under the line, while damage arrives (a drop in the last ATTACK_TICKS ticks, or an attacker in view), the
//   floor eats any held food that is not reserved. It does not wait for a script attack, and a hold or a yield of the
//   eat guard does not stop it. It eats at most once in EAT_TICKS ticks, and never in the EAT_TICKS ticks after any
//   eat of the session.
// - With no food (or REFUSED_EATS eats in a row that removed no food), the floor escapes. It refuses each script input
//   that moves the player or starts an interaction, casts a free-to-play teleport when the runes and the Magic level
//   are held outside deep Wilderness, and walks away from the attackers: first to a tile of its own trail from the
//   last TRAIL_TICKS ticks (the client walked there, so it has a client route), then along eight rays. A tile that the
//   client refuses, or that the player does not move toward, is never picked again. While the flee guard's job moves
//   the player, the floor lets it walk; when that job stands still, the floor stops it and walks itself.
// - Once no damage arrived for CALM_TICKS ticks and no attacker is in view, or ESCAPE_BUDGET ticks after the escape
//   began, the floor ends the run with `stop=hp-floor ...`: openBot then prints `RESULT fail stop=hp-floor ...` and
//   logs the account out (the server allows a logout 16 ticks after combat; the logout retries for 15 s). The floor
//   keeps walking under the logout while damage still arrives.
// - Each eat, the escape start and the stop write one `HP_FLOOR <kind> ...` line.
//
// A death ends the escape at once: death recovery (death-recovery.ts) owns the session after it.
// Only a local practice server runs a session with no floor (hpFloorOff): with SESSION_HP_FLOOR=0
// (scripts/measure/death-probe.ts dies on purpose), and for a PvP worker, whose spar benches fight to a death.

// The floor imports no session module (inprocess, bot, randomevents): inprocess/connect.ts imports it, and those
// modules import inprocess.
import { PLAIN_FOOD } from './eat-guard';
import { logout } from './logout';
import { wildernessLevel } from './prayer-guard';
import { allFoodIds, selectQuestFood } from './sustain';

/**
 * An estimate of an NPC's max hit from its combat level, for the flee line (randomevents/combat.ts) and the floor:
 * level 9 (Wizard) 3, level 15 (Unicorn) 3, level 25 (Wolf) 5, level 33 (Black Knight) 6. An unknown level gives 4.
 */
export function npcMaxHitEstimate(combatLevel: number | null | undefined): number {
    if (typeof combatLevel !== 'number' || !(combatLevel > 0)) return 4;
    return Math.max(2, Math.ceil(combatLevel / 8) + 1);
}

// The same rules as randomevents/model.ts targetsMe and tileOf: an NPC whose target is a player slot that no other
// nearby player holds targets this player.
const targetsMe = (st: any, n: any) =>
    n.targetIndex >= 32768 && !(st?.nearbyPlayers ?? []).some((p: any) => p.index === n.targetIndex - 32768);
const tileOf = (n: any): { x: number; z: number } => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

export interface HpFloorSession {
    name?: string;
    sdk: { getState(): any };
    tick(): number;
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    client?: unknown;
    ended?: Promise<unknown>;
}

export interface HpFloorConfig {
    // Receives each HP_FLOOR line. Default console.log.
    log?: (line: string) => void;
    // Ends the run with this reason (openBot: RESULT fail <reason>, then the logout). Default: the floor prints
    // `RESULT fail <reason>` and logs the account out itself.
    // false: the run already ends for another reason (a flee stop), and its RESULT keeps that reason.
    stop?: (reason: string) => boolean | void;
    // For each item id, the count the floor never eats (quest-sweep questReserved).
    reserved?: () => Readonly<Record<number, number>>;
    // True while another guard's flee walk holds the session (the random event watcher's flee job).
    fleeActive?: () => boolean;
    // Stops the other movers (the watcher and its flee job) before the floor walks itself.
    takeOver?: () => void;
}

export const FLOOR_HITS = 2;
export const HIT_WINDOW = 300;
export const ATTACK_TICKS = 16;
export const CALM_TICKS = 8;
export const ESCAPE_BUDGET = 60;
export const EAT_TICKS = 3;
export const REFUSED_EATS = 3;
export const TRAIL_TICKS = 400;
export const ESCAPE_DIST = 10;
// Standard teleports cannot be cast above this Wilderness level.
export const TELEPORT_WILD_MAX = 20;
const RAY_DISTANCES = [6, 10, 14, 20];
const STUCK_TICKS = 3;
const RESEND_TICKS = 3;
// The client routes inside its build area; a farther trail tile only gives a walk to the scene edge.
const TRAIL_REACH = 40;

/**
 * True when a session gets no floor. Only on a local practice server: with SESSION_HP_FLOOR=0, and for a PvP worker
 * (the file-name rule of the flee guard in bot/open.ts), whose benches measure fights to a death. A live session always
 * gets the floor.
 */
export const hpFloorOff = (env: Readonly<Record<string, string | undefined>>, local: boolean, script: string): boolean =>
    local && (env.SESSION_HP_FLOOR === '0' || /pk|pvp|spar|gang/i.test(script.split(/[\\/]/).at(-1) ?? ''));

/** An estimate of a player's max hit from its combat level: level 100 hits up to 26. */
export const playerMaxHitEstimate = (combatLevel: number | null | undefined): number =>
    typeof combatLevel === 'number' && combatLevel > 0 ? Math.max(4, Math.ceil(combatLevel / 4) + 1) : 10;

/** The Hitpoints at or under which the floor acts: FLOOR_HITS hits of the largest hit in reach. 0 with no hit known. */
export const floorLine = (maxHit: number): number => maxHit > 0 ? FLOOR_HITS * maxHit : 0;

type Tile = { x: number; z: number; level: number };
type Action = { type: string; [k: string]: unknown };

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const key = (t: { x: number; z: number }) => `${t.x},${t.z}`;

// Script inputs that move the player or start an interaction. During an escape the floor refuses them; eats, prayers,
// interface clicks (the logout) and dialog inputs pass.
const MOVES = new Set([
    'walkTo', 'interactNpc', 'interactPlayer', 'interactLoc', 'talkToNpc', 'pickupItem', 'interactGroundItem',
    'spellOnNpc', 'spellOnPlayer', 'spellOnGroundItem', 'useItemOnLoc', 'useItemOnNpc', 'bankDeposit', 'bankWithdraw',
    'shopBuy', 'shopSell',
]);

type Teleport = { name: string; componentId: number; level: number; runes: Record<number, number>; to: { x: number; z: number; level: number } };
type TeleportTable = { list: Teleport[]; runeCost(runeId: number, qty: number, worn: readonly { id: number; slot: number }[]): number };

// The free-to-play standard teleports, read from the content once per process. Null when the content is missing.
let teleports: TeleportTable | null | undefined;
async function loadTeleports(): Promise<TeleportTable | null> {
    if (teleports !== undefined) return teleports;
    try {
        const [{ nativeTeleport, elementalRuneCost }, { componentId }] = await Promise.all([import('./magic-data'), import('./logout')]);
        const list = ['varrock', 'lumbridge', 'falador'].map(n => nativeTeleport(n)).filter(t => !t.members)
            .map(t => ({ name: t.name, componentId: componentId(t.component), level: t.level, runes: t.runes, to: t.to }));
        teleports = { list, runeCost: (id, qty, worn) => elementalRuneCost(id, qty, worn) };
    } catch { teleports = null; }
    return teleports;
}

export interface HpFloorStats { eats: number; refused: number; escapes: number; walks: number; refusedTiles: number; blocked: number; teleports: number; stopped: boolean }

export interface HpFloor {
    configure(cfg: HpFloorConfig): void;
    stats(): HpFloorStats;
    // The current floor line and the largest hit in reach, for tests and reports.
    line(): { floor: number; maxHit: number };
    escaping(): boolean;
    stop(): void;
}

const floors = new WeakMap<object, HpFloor>();
/** The HP floor of a session, or undefined when none was installed. */
export const hpFloorOf = (s: object): HpFloor | undefined => floors.get(s);

/** Installs the HP floor in `s` once; a second call returns the first floor. */
export function installHpFloor(s: HpFloorSession, cfg: HpFloorConfig = {}): HpFloor {
    const existing = floors.get(s);
    if (existing) { existing.configure(cfg); return existing; }
    const floor = startHpFloor(s, cfg);
    floors.set(s, floor);
    return floor;
}

export function startHpFloor(s: HpFloorSession, initial: HpFloorConfig = {}): HpFloor {
    let cfg: HpFloorConfig = { ...initial };
    // The send path at install time: the random event gate wraps s.direct later and holds inputs during its jobs; the
    // floor's own inputs must never wait in that queue.
    const send = s.direct.bind(s);
    let edible: ReadonlySet<number>;
    try { edible = new Set([...PLAIN_FOOD, ...allFoodIds()]); } catch { edible = new Set(PLAIN_FOOD); }
    const foodList = [...edible];
    void loadTeleports();
    const own = new WeakSet<object>();
    const stats: HpFloorStats = { eats: 0, refused: 0, escapes: 0, walks: 0, refusedTiles: 0, blocked: 0, teleports: 0, stopped: false };
    const log = (line: string) => (cfg.log ?? ((l: string) => console.log(l)))(line);

    let stopped = false, hpIdx = -1, lastHp: number | undefined, lastLife: unknown;
    const drops: { tick: number; damage: number }[] = [];
    let lastDropTick = -Infinity;
    let foodCount = 0, consumedAt = -Infinity;
    let pendingEat: { id: number; before: number; at: number } | null = null;
    let refusedStreak = 0;
    const trail: (Tile & { tick: number })[] = [];
    let curFloor = 0, curMaxHit = 0;

    // The escape, from its start to the end of the session or a death.
    let escape: {
        at: number; from: Tile; dest: Tile | null; sentAt: number; sentFrom: string; refused: Set<string>;
        teleport: 'none' | 'sent' | 'done'; teleportAt: number; took: boolean; stopSent: boolean; how: string; by: string;
        lastMoveAt: number; lastPos: string; hp: number; max: number;
    } | null = null;

    const ownSend = (a: Action) => {
        own.add(a);
        try { return Promise.resolve(send(a)).catch(() => ({ success: false })); }
        catch { return Promise.resolve({ success: false }); }
    };

    const client = s.client as { executeBotAction?: (action: unknown) => unknown } | undefined;
    const original = client?.executeBotAction;
    const blocker = typeof original === 'function' ? function (this: unknown, action: unknown) {
        const a = action as Action | null;
        // Until the floor takes over, the watcher's flee walks (gate.ts send, reason 'random-event') pass: the floor
        // lets that job walk while it moves the player.
        const delegated = escape && !escape.took && a?.reason === 'random-event';
        if (escape && !stopped && a && typeof a === 'object' && !own.has(a) && MOVES.has(a.type) && !delegated) {
            stats.blocked++;
            return { success: false, phase: 'validation', reason: 'hp_floor', message: 'hp floor: the session escapes at low Hitpoints' };
        }
        return original.call(this, action);
    } : undefined;
    if (client && blocker) client.executeBotAction = blocker;

    const hpOf = (st: any): { hp: number; max: number } | null => {
        const skills = st?.skills;
        let skill = hpIdx >= 0 && skills?.[hpIdx]?.name === 'Hitpoints' ? skills[hpIdx] : undefined;
        if (!skill && skills) for (let i = 0; i < skills.length; i++) if (skills[i]?.name === 'Hitpoints') { hpIdx = i; skill = skills[i]; break; }
        const hp = skill?.level ?? st?.player?.hp, max = skill?.baseLevel ?? st?.player?.maxHp;
        return Number.isFinite(hp) && Number.isFinite(max) && max > 0 ? { hp, max } : null;
    };
    const edibleCount = (st: any): number => {
        let n = 0;
        for (const i of st?.inventory ?? []) if (i && edible.has(i.id)) n += i.count ?? 1;
        return n;
    };
    const countOf = (st: any, id: number): number => {
        let n = 0;
        for (const i of st?.inventory ?? []) if (i?.id === id) n += i.count ?? 1;
        return n;
    };
    const attackersOf = (st: any) => {
        const npcs = (st?.nearbyNpcs ?? []).filter((n: any) => n && targetsMe(st, n));
        const others = st?.nearbyPlayers ?? [];
        const players = others.filter((q: any) => q && q.combatTargetType === 'player' && typeof q.combatTargetIndex === 'number'
            && q.combatTargetIndex >= 0 && !others.some((o: any) => o?.index === q.combatTargetIndex));
        return { npcs, players };
    };
    const describe = (att: ReturnType<typeof attackersOf>) => {
        const names = [...att.npcs.map((n: any) => `${String(n.name ?? 'npc').replace(/\s+/g, '_')}#${n.id}`), ...att.players.map((q: any) => `player:${q.name ?? q.index}`)];
        return names.length ? names.join(',') : 'unseen';
    };

    const foodChoice = (st: any, line: number) =>
        selectQuestFood(st, { food: foodList, eatAt: line, reserved: cfg.reserved?.() });
    // True while the pack holds food with an Eat or Drink option above its reserve, at any Hitpoints.
    const holdsFood = (st: any): boolean => {
        const reserved = cfg.reserved?.() ?? {};
        for (const i of st?.inventory ?? []) {
            if (!i || !edible.has(i.id) || countOf(st, i.id) <= (reserved[i.id] ?? 0)) continue;
            if ((i.optionsWithIndex ?? []).some((o: any) => /^(eat|drink)$/i.test(o.text ?? ''))) return true;
        }
        return false;
    };

    const pickDest = (me: Tile, danger: { x: number; z: number }, refused: ReadonlySet<string>): Tile | null => {
        const here = cheb(me, danger);
        // The newest trail tile far enough from the danger: the shortest walk back the way the player came.
        let best: Tile | null = null, bestFar: Tile | null = null, bestFarD = here + 2;
        for (let i = trail.length - 1; i >= 0; i--) {
            const t = trail[i]!;
            if (t.level !== me.level || refused.has(key(t)) || cheb(t, me) > TRAIL_REACH || cheb(t, me) <= 1) continue;
            const d = cheb(t, danger);
            if (d >= ESCAPE_DIST) { best = t; break; }
            if (d > bestFarD) { bestFar = t; bestFarD = d; }
        }
        if (best ?? bestFar) return { x: (best ?? bestFar)!.x, z: (best ?? bestFar)!.z, level: me.level };
        // Eight rays, the one straight away from the danger first.
        const sx = Math.sign(me.x - danger.x) || 1, sz = Math.sign(me.z - danger.z);
        const dirs: [number, number][] = [];
        for (let ux = -1; ux <= 1; ux++) for (let uz = -1; uz <= 1; uz++) if ((ux || uz) && !(ux === sx && uz === sz)) dirs.push([ux, uz]);
        dirs.sort((a, b) => (b[0] * sx + b[1] * sz) - (a[0] * sx + a[1] * sz));
        dirs.unshift([sx, sz]);
        for (const dist of RAY_DISTANCES) for (const [ux, uz] of dirs) {
            const t = { x: me.x + ux * dist, z: me.z + uz * dist, level: me.level };
            if (!refused.has(key(t))) return t;
        }
        return null;
    };

    const teleportFor = (st: any, me: Tile): Teleport | null => {
        if (!teleports || wildernessLevel(me.x, me.z) > TELEPORT_WILD_MAX) return null;
        const magic = (st?.skills ?? []).find((k: any) => k?.name === 'Magic')?.level ?? 0;
        const worn = (st?.equipment ?? []).filter(Boolean).map((i: any) => ({ id: i.id, slot: i.slot }));
        for (const t of teleports.list) {
            if (magic < t.level) continue;
            if (Object.entries(t.runes).every(([id, qty]) => countOf(st, Number(id)) >= teleports!.runeCost(Number(id), qty, worn))) return t;
        }
        return null;
    };

    const endRun = (reason: string) => {
        if (stats.stopped) return;
        stats.stopped = true;
        const bot = s.name ? ` bot=${s.name}` : '';
        if (cfg.stop) { const took = cfg.stop(reason); log(`HP_FLOOR stop ${reason}${took === false ? ' run=already-ending' : ''}${bot}`); return; }
        log(`HP_FLOOR stop ${reason}${bot}`);
        // A session opened without openBot: print the result and log out (the logout retries through the combat window).
        console.log(`RESULT fail ${reason}`);
        if (s.ended) void logout({ sdk: { sendClickComponent: id => ownSend({ type: 'clickComponent', componentId: id, reason: 'hp-floor' }) }, ended: s.ended as Promise<{ reason: string }> }, 15_000).catch(() => {});
    };

    const off = s.onTick(() => {
        if (stopped) return;
        const st = s.sdk.getState(), p = st?.player, now = s.tick();
        if (!p) return;
        const life = p.lifeId ?? p.respawnCount;
        if (p.isDead || (lastLife !== undefined && life !== undefined && life !== lastLife)) {
            // A death: the floor failed, death recovery owns the session. A new life starts with a clean record.
            if (escape) log(`HP_FLOOR dead hp=${lastHp ?? '?'} floor=${curFloor} escapeTicks=${now - escape.at}${s.name ? ` bot=${s.name}` : ''}`);
            escape = null; pendingEat = null; refusedStreak = 0; lastHp = undefined; drops.length = 0; lastDropTick = -Infinity; trail.length = 0;
            if (!p.isDead) lastLife = life;
            return;
        }
        if (life !== undefined) lastLife = life;
        const h = hpOf(st);
        if (!h || h.hp <= 0) return;
        const me: Tile = { x: p.worldX, z: p.worldZ, level: p.level ?? 0 };

        if (lastHp !== undefined && h.hp < lastHp) { drops.push({ tick: now, damage: lastHp - h.hp }); lastDropTick = now; }
        lastHp = h.hp;
        while (drops.length && now - drops[0]!.tick > HIT_WINDOW) drops.shift();
        const food = edibleCount(st);
        if (food < foodCount) consumedAt = now;
        foodCount = food;
        const last = trail[trail.length - 1];
        if (!last || last.x !== me.x || last.z !== me.z || last.level !== me.level) trail.push({ ...me, tick: now });
        while (trail.length && now - trail[0]!.tick > TRAIL_TICKS) trail.shift();

        const att = attackersOf(st);
        let biggest = 0;
        for (const d of drops) biggest = Math.max(biggest, d.damage);
        let estimate = 0;
        for (const n of att.npcs) estimate += npcMaxHitEstimate(typeof n.combatLevel === 'number' ? n.combatLevel : null);
        for (const q of att.players) estimate += playerMaxHitEstimate(q.combatLevel);
        curMaxHit = Math.max(biggest, estimate);
        curFloor = floorLine(curMaxHit);
        const attacked = now - lastDropTick <= ATTACK_TICKS || att.npcs.length > 0 || att.players.length > 0;

        if (pendingEat) {
            if (countOf(st, pendingEat.id) < pendingEat.before) { stats.eats++; refusedStreak = 0; pendingEat = null; }
            else if (now - pendingEat.at >= EAT_TICKS) { stats.refused++; refusedStreak++; pendingEat = null; }
        }

        // The eat: at or under the floor while damage arrives, with no eat of the session in the last EAT_TICKS ticks.
        if (h.hp <= curFloor && attacked && !pendingEat && now - consumedAt >= EAT_TICKS) {
            const choice = foodChoice(st, curFloor);
            if (choice) {
                const before = countOf(st, choice.item.id);
                void ownSend({ type: 'useInventoryItem', slot: choice.item.slot, optionIndex: choice.opIndex, reason: 'hp-floor' });
                pendingEat = { id: choice.item.id, before, at: now };
                log(`HP_FLOOR eat hp=${h.hp}/${h.max} floor=${curFloor} maxHit=${curMaxHit} food=${choice.item.id} left=${food - 1} by=${describe(att)}${s.name ? ` bot=${s.name}` : ''}`);
            }
        }

        if (!escape && h.hp <= curFloor && attacked && !(holdsFood(st) && refusedStreak < REFUSED_EATS)) {
            stats.escapes++;
            escape = {
                at: now, from: me, dest: null, sentAt: -Infinity, sentFrom: '', refused: new Set(), teleport: 'none', teleportAt: -Infinity,
                took: false, stopSent: false, how: 'none', by: describe(att), lastMoveAt: now, lastPos: key(me), hp: h.hp, max: h.max,
            };
            log(`HP_FLOOR escape hp=${h.hp}/${h.max} floor=${curFloor} maxHit=${curMaxHit} food=${food} refusedEats=${refusedStreak} by=${escape.by} at=${me.x},${me.z},${me.level} wild=${wildernessLevel(me.x, me.z)}${s.name ? ` bot=${s.name}` : ''}`);
        }
        if (!escape) return;

        const e = escape;
        const pos = key(me);
        if (pos !== e.lastPos) { e.lastPos = pos; e.lastMoveAt = now; }
        const reason = () => `stop=hp-floor hp=${e.hp}/${e.max} floor=${curFloor} maxHit=${curMaxHit} food=${food} by=${e.by} escape=${e.how} at=${me.x},${me.z},${me.level} ticks=${now - e.at}`;
        const calm = now - lastDropTick >= CALM_TICKS && att.npcs.length === 0 && att.players.length === 0;
        if (!e.stopSent && (calm || now - e.at >= ESCAPE_BUDGET)) {
            e.stopSent = true;
            if (!calm) e.how = `${e.how}-timeout`;
            endRun(reason());
        }
        if (calm) return;

        // A teleport that landed ends the walk.
        if (e.teleport === 'sent') {
            if (cheb(me, e.from) > 30 || me.level !== e.from.level) { e.teleport = 'done'; e.how = 'teleport'; stats.teleports++; return; }
            if (now - e.teleportAt < 5) return;
            e.teleport = 'done';
        }
        if (e.teleport === 'done' && e.how === 'teleport') return;
        if (e.teleport === 'none') {
            const t = teleportFor(st, me);
            if (t) {
                cfg.takeOver?.(); e.took = true;
                e.teleport = 'sent'; e.teleportAt = now; e.how = 'teleport-sent';
                void ownSend({ type: 'clickComponent', componentId: t.componentId, reason: 'hp-floor' });
                return;
            }
            e.teleport = 'done';
        }

        // The flee guard's walk goes first while it moves the player.
        if (!e.took && cfg.fleeActive?.() && now - e.lastMoveAt < STUCK_TICKS) { e.how = 'flee-guard'; return; }
        if (!e.took) { cfg.takeOver?.(); e.took = true; }

        if (e.dest) {
            const reached = cheb(me, e.dest) <= 1;
            const stuck = now - e.sentAt >= STUCK_TICKS && now - e.lastMoveAt >= STUCK_TICKS;
            if (reached || stuck) { e.refused.add(key(e.dest)); stats.refusedTiles++; e.dest = null; }
        }
        const att0 = [...att.npcs, ...att.players].map((a: any) => tileOf(a)).filter(t => Number.isFinite(t.x) && Number.isFinite(t.z));
        const danger = att0.length
            ? { x: Math.round(att0.reduce((n, a) => n + a.x, 0) / att0.length), z: Math.round(att0.reduce((n, a) => n + a.z, 0) / att0.length) }
            : e.from;
        if (!e.dest) {
            e.dest = pickDest(me, danger, e.refused);
            if (!e.dest) { e.refused.clear(); e.dest = pickDest(me, danger, e.refused); }
            e.sentAt = -Infinity;
        }
        if (e.dest && now - e.sentAt >= RESEND_TICKS) {
            const to = e.dest;
            e.sentAt = now; e.how = 'walk'; stats.walks++;
            void ownSend({ type: 'walkTo', x: to.x, z: to.z, running: true, reason: 'hp-floor' }).then((r: any) => {
                if (r && r.success === false && escape === e && e.dest === to) { e.refused.add(key(to)); stats.refusedTiles++; e.dest = null; }
            });
        }
    });

    const stop = () => {
        if (stopped) return;
        stopped = true;
        off();
        if (client && blocker && client.executeBotAction === blocker) client.executeBotAction = original;
    };
    void s.ended?.then(stop, stop);
    return {
        configure(next: HpFloorConfig) { cfg = { ...cfg, ...next }; },
        stats: () => ({ ...stats }),
        line: () => ({ floor: curFloor, maxHit: curMaxHit }),
        escaping: () => escape !== null,
        stop,
    };
}
