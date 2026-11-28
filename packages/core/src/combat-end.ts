// The end step of a combat worker. A run that ends while a monster still fights the account cannot log out: the server
// takes no logout for 16 ticks after each hit (logout.ts). The session then ends with no confirmed logout, and the
// account keeps its fleet claim until an authenticated recovery (fleet-trade-claim.ts releaseAfterLogout).
// The step: leave the ground on which the monsters keep a target, wait until no hit landed for the logout window, then
// press logout until the server confirms it. The ground comes from the content data (danger.ts loadRoamers and
// loadHunters), so a new site needs no tile list.
import type { Session } from './inprocess';
import type { PathLength, Tile } from './world';
import { rsPathLength } from './world';
import { combatLevel, hunts, loadHunters, loadRoamers, type Hunter, type Roamer } from './danger';
import { logout } from './logout';
import { defaultEatAt, holdSessionEater, questFoodDefinitions, selectQuestFood, type FoodItem } from './sustain';
import { waitTicks, waitUntil, type TickSource } from './ticks';
import { sessionWalker, walkPath } from './walk';
import { deathRecoveryOf, finish, logoutAdapter } from './bot';

// logout.rs2:27 combat_preventlogout: each hit on the player (auto_retaliate.rs2:2) blocks logout for 16 ticks.
export const LOGOUT_QUIET_TICKS = 17;
export function logoutQuiet(now: number, lastHit: number, inCombat: boolean) { return !inCombat && now - lastHit >= LOGOUT_QUIET_TICKS; }
// Before logout: the retreat walk ends the player's own attack, then the wait runs until no hit lands for the
// logout window. `between` runs before each tick of the wait (scripts/magic-order.ts eats there). The result is
// observed, never assumed.
export async function awaitLogoutQuiet(s: TickSource, o: { lastHit: () => number; retreat: () => Promise<void>; between: () => Promise<unknown>; timeoutTicks: number }) {
    let ended = false; void s.ended?.then(() => { ended = true; });
    const start = s.tick(), quiet = () => logoutQuiet(s.tick(), o.lastHit(), !!s.sdk.getState()?.player?.combat?.inCombat);
    if (quiet()) return { quiet: true, retreated: false, ticks: 0 };
    await o.retreat();
    while (!ended && !quiet() && s.tick() - start < o.timeoutTicks) { await o.between(); await waitTicks(s, 1); }
    return { quiet: quiet(), retreated: true, ticks: s.tick() - start };
}

type SeenNpc = { id: number; name: string; x: number; z: number; tileX?: number; tileZ?: number; hp?: number | null; inCombat?: boolean; combatTargetType?: string };
// A square that the account leaves: `r` tiles in each direction from a spawn.
export type Square = { x: number; z: number; r: number; name: string };
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const outside = (t: { x: number; z: number }, squares: readonly Square[]) => squares.every(q => cheb(t, q) > q.r);

// The ground to leave at `at`: for each kind of monster in view that fights a player, the square on which that kind
// keeps a target, around each of its spawns in `look` tiles; and the square of each monster that hunts this account.
// `margin` tiles more on each side, because a monster stands on a tile of its own size.
export function combatSquares(at: Tile, npcs: readonly SeenNpc[], skills: Record<string, number>,
    data: { roamers?: ReadonlyMap<number, Roamer>; hunters?: readonly Hunter[] } = {}, margin = 2, look = 64): Square[] {
    const roamers = data.roamers ?? loadRoamers(), hunters = data.hunters ?? loadHunters(), combat = combatLevel(skills), out = new Map<string, Square>();
    const add = (name: string, spawns: readonly Tile[], r: number) => {
        for (const sp of spawns) {
            if (sp.level !== at.level || cheb(sp, at) > look + r) continue;
            const key = `${sp.x},${sp.z}`, old = out.get(key);
            if (!old || old.r < r) out.set(key, { x: sp.x, z: sp.z, r, name });
        }
    };
    const fighting = new Set<number>();
    for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i]!;
        if (n.hp !== 0 && (n.combatTargetType === 'player' || n.inCombat)) fighting.add(n.id);
    }
    for (const id of fighting) { const kind = roamers.get(id); if (kind) add(kind.name, kind.spawns, kind.keep + margin); }
    for (const h of hunters) if (hunts(h, combat)) add(h.name, h.spawns, Math.max(h.reach, h.id === undefined ? 0 : roamers.get(h.id)?.keep ?? 0) + margin);
    return [...out.values()];
}

const RING_COS = Array.from({ length: 16 }, (_, i) => Math.cos(i * Math.PI / 8));
const RING_SIN = Array.from({ length: 16 }, (_, i) => Math.sin(i * Math.PI / 8));

// Surface Wilderness (z 3520..6399) and Edgeville Dungeon Wilderness north of the gate (z 9918..12799).
export const inWilderness = (t: { x: number; z: number }): boolean =>
    t.x >= 2944 && t.x < 3392 && ((t.z >= 3520 && t.z < 6400) || (t.z >= 9918 && t.z < 12800));

// Safe-tile retreats never cross into Wilderness from non-Wilderness and never walk deeper north inside Wilderness.
export function crossesWildernessCeiling(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
    if (!inWilderness(to)) return false;
    return !inWilderness(from) || to.z > from.z;
}

// Tiles outside every square, the nearest ring first: 16 directions on each ring around `at`, out to `maxRing` tiles.
export function safeCandidates(at: Tile, squares: readonly Square[], maxRing = 96): Tile[] {
    if (outside(at, squares)) return [at];
    const out: Tile[] = [], seen = new Set<number>();
    for (let r = 2; r <= maxRing; r += 2) {
        for (let i = 0; i < 16; i++) {
            const x = at.x + Math.round(RING_COS[i]! * r), z = at.z + Math.round(RING_SIN[i]! * r);
            const key = (x + 131072) * 262144 + (z + 131072);
            if (seen.has(key)) continue;
            const t = { x, z, level: at.level };
            if (!outside(t, squares) || crossesWildernessCeiling(at, t)) continue;
            seen.add(key); out.push(t);
        }
    }
    return out;
}

// The safe tile with the shortest walk among the first `tries` candidates that a walk reaches, or null.
export function nearestSafeTile(at: Tile, squares: readonly Square[], length: (from: Tile, to: Tile) => number | null, tries = 24): Tile | null {
    let best: Tile | null = null, bestLength = Infinity, checked = 0;
    for (const t of safeCandidates(at, squares)) {
        if (best && cheb(t, at) > bestLength) break; // no later ring can give a shorter walk
        if (checked++ >= tries && best) break;
        const n = t.x === at.x && t.z === at.z ? 0 : length(at, t);
        if (n !== null && n < bestLength) { best = t; bestLength = n; }
        if (checked >= tries * 4) break;
    }
    return best;
}

// `tiles`: the distance from the start tile to the end tile. `eats`: the eat inputs of the step.
export type CombatLeave = { underAttack: boolean; left: boolean; quiet: boolean; ticks: number; from?: Tile; to?: Tile; moves: number; tiles: number; eats: number; detail?: string };
type EatPolicy = {
    // Item ids the step can eat. Default: each food of the content (sustain.ts questFoodDefinitions).
    food?: readonly number[];
    // Eat at this Hitpoints level or below. Default: sustain.ts defaultEatAt.
    eatAt?: number | ((maxHp: number) => number);
};
type LeaveDeps = EatPolicy & {
    // Receives the eater of the step when the account is under attack, and the step then leaves it running: the caller
    // stops it (finishCombat stops it after the logout). Without it the step stops its eater when it returns.
    keepEater?: (eater: EndEater) => void;
    // Walks to the tile and says if the account stands within 2 tiles of it. The default is the session walker.
    walk?: (to: Tile) => Promise<boolean>;
    pathLength?: (from: Tile, to: Tile) => number | null;
    data?: Parameters<typeof combatSquares>[3];
    log?: (line: string) => void;
    walkTicks?: number; quietTicks?: number; moves?: number;
};
// The interface buttons of auto-retaliate (combat tab): 150 on, 151 off. A monster that still fights holds an account
// with auto-retaliate on in place to hit back (scripts/gather-combat.ts leave), so the walk out turns it off.
export const RETALIATE_ON = 150, RETALIATE_OFF = 151;

// The eater of the end step. The eat guard of the session stops for the rest of the session after the worker ate by
// its own input (eat-guard.ts `yielded`), and a combat worker eats by its own input. So the step eats by itself, on
// each tick of its walk and of its wait: when the Hitpoints are at or below the eat level, the pack holds a food with
// an Eat option, and the food delay of the last eat (3 ticks) is over. It holds the eat guard while it runs, so one
// tick never gets two eats.
const EAT_TICKS = 3;
export type EndEater = { eats(): number; stop(): void };
export function startEndEater(s: Pick<Session, 'sdk' | 'tick' | 'onTick' | 'direct'> & { ended?: Promise<unknown> }, o: EatPolicy = {}): EndEater {
    const food = o.food ?? [...questFoodDefinitions().keys()], held = holdSessionEater(s.sdk);
    const eatOption = (i: FoodItem) => i.optionsWithIndex?.find(v => /^eat$/i.test(v.text));
    let stopped = false, sentAt = held.ateAt, eats = 0;
    const off = s.onTick(() => {
        if (stopped || s.tick() - sentAt < EAT_TICKS) return;
        const st = s.sdk.getState();
        if (!st?.player || st.player.isDead) return;
        const choice = selectQuestFood({ ...st, inventory: ((st.inventory ?? []) as FoodItem[]).filter(i => eatOption(i)) }, { food, eatAt: o.eatAt ?? defaultEatAt });
        if (!choice) return;
        sentAt = s.tick(); eats++;
        try { void Promise.resolve(s.direct({ type: 'useInventoryItem', slot: choice.item.slot, optionIndex: eatOption(choice.item)!.opIndex, reason: 'SDK' })).catch(() => {}); } catch { /* the session ended */ }
    });
    const eater = { eats: () => eats, stop() { if (stopped) return; stopped = true; off(); held.release(); } };
    void s.ended?.then(() => eater.stop());
    return eater;
}

// Takes an account that is under attack off the monsters' ground and waits until the logout window is open. An account
// that is not under attack is left where it stands. The state of auto-retaliate is put back as it was.
export async function leaveCombat(s: Session, deps: LeaveDeps = {}): Promise<CombatLeave> {
    const log = deps.log ?? ((l: string) => console.log(l)), start = s.tick();
    const st = () => s.sdk.getState(), me = (): Tile | null => { const p = st()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    let ended = false; void s.ended?.then(() => { ended = true; });
    // The last hit: the state's own tick of the last damage, and each fall of the hitpoints that this step sees.
    let lastHit = st()?.player?.combat?.lastDamageTick ?? -Infinity, hp = st()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? 0;
    const off = s.onTick(() => {
        const now = st()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? hp;
        if (now < hp) lastHit = s.tick();
        hp = now;
        const seen = st()?.player?.combat?.lastDamageTick;
        if (typeof seen === 'number' && seen > lastHit) lastHit = seen;
    });
    const quiet = () => logoutQuiet(s.tick(), lastHit, !!st()?.player?.combat?.inCombat);
    try {
        if (quiet() || !me()) return { underAttack: false, left: false, quiet: quiet(), ticks: 0, moves: 0, tiles: 0, eats: 0 };
        const from = me()!, retaliated = st()?.autoRetaliateEnabled;
        const retaliate = async (on: boolean) => {
            if (st()?.autoRetaliateEnabled === on || st()?.autoRetaliateEnabled === undefined) return;
            await s.direct({ type: 'clickComponent', componentId: on ? RETALIATE_ON : RETALIATE_OFF, reason: `combat end auto-retaliate ${on ? 'on' : 'off'}` });
            await waitUntil(s, () => st()?.autoRetaliateEnabled === on, { timeoutTicks: 5 });
        };
        const measure: PathLength | undefined = deps.pathLength ? undefined : await rsPathLength();
        const length = deps.pathLength ?? ((a: Tile, b: Tile) => measure!(a, b, [], 1));
        const walk = deps.walk ?? (async (to: Tile) => {
            await walkPath(await sessionWalker(s), [{ x: to.x, z: to.z, tol: 1 }], { maxTicks: deps.walkTicks ?? 120, stop: () => ended });
            const p = me(); return !!p && cheb(p, to) <= 2;
        });
        let to: Tile | undefined, left = false, moves = 0, detail: string | undefined;
        // A tile that a walk of this step did not reach is not chosen again.
        const failed: Tile[] = [], untried = (a: Tile, b: Tile) => failed.some(f => f.x === b.x && f.z === b.z) ? null : length(a, b);
        const eater = startEndEater(s, deps);
        deps.keepEater?.(eater);
        try {
            await retaliate(false);
            // A second walk if a hit lands after the first: a different kind of monster was in reach of the first tile.
            for (; moves < (deps.moves ?? 2) && !ended && !quiet(); moves++) {
                const at = me(); if (!at) break;
                const squares = combatSquares(at, st()?.nearbyNpcs ?? [], Object.fromEntries((st()?.skills ?? []).map((k: { name: string; baseLevel?: number; level: number }) => [k.name.toLowerCase(), k.baseLevel ?? k.level])), deps.data);
                const target = nearestSafeTile(at, squares, untried);
                log(`COMBAT_END leave ${JSON.stringify({ tick: s.tick(), at, squares: squares.length, to: target })}`);
                if (!target) { detail = 'no safe tile in reach'; break; }
                to = target;
                if (cheb(at, target) > 0 && !await walk(target)) { failed.push(target); detail = 'walk to the safe tile did not arrive'; continue; }
                left = true; detail = undefined;
                // The eater of the step runs on each tick, so the wait has nothing more to do between two ticks.
                const waited = await awaitLogoutQuiet(s, { lastHit: () => lastHit, retreat: async () => {}, between: async () => {}, timeoutTicks: deps.quietTicks ?? 60 });
                if (waited.quiet) break;
            }
        } finally { if (!deps.keepEater) eater.stop(); if (retaliated !== undefined) await retaliate(retaliated).catch(() => {}); }
        return { underAttack: true, left, quiet: quiet(), ticks: s.tick() - start, from, ...(to ? { to } : {}), moves, tiles: cheb(from, me() ?? from), eats: eater.eats(), ...(detail ? { detail } : {}) };
    } finally { off(); }
}

// Presses logout until the server confirms it: `tries` windows of `windowMs` each. A window that ends with no answer
// is a logout that the server did not take, so the next window waits for the logout window first.
export async function confirmedLogout(s: Session, o: { tries?: number; windowMs?: number; press?: typeof logout; quietTicks?: number } = {}): Promise<{ out: string; tries: number }> {
    const press = o.press ?? logout, max = o.tries ?? 3, adapter = logoutAdapter(s);
    let out = 'timeout', tries = 0;
    while (tries < max) {
        tries++;
        out = await press(adapter, o.windowMs ?? 15_000).catch(e => `error ${String(e)}`);
        if (out !== 'timeout') break;
        if (tries < max) await waitUntil(s, () => !s.sdk.getState()?.player?.combat?.inCombat, { timeoutTicks: o.quietTicks ?? LOGOUT_QUIET_TICKS });
    }
    s.lifecycle?.record('logout', out);
    return { out, tries };
}

// finish() for a combat worker: the end step first, then the settlement with a logout that is pressed until it is
// confirmed. The RESULT line ends with the ticks of the end step and the result of the logout.
// The step has a limit and no stop: at most 2 walks of 120 ticks and 2 waits of 60 ticks, then 3 logout windows of
// 15 s. A stop file or a lost lease that comes in that time does not end it sooner.
export async function finishCombat(s: Session, ok: boolean, detail: string | ((ok: boolean) => string),
    deps: EatPolicy & { leave?: typeof leaveCombat; logout?: typeof confirmedLogout; finish?: typeof finish; recovery?: typeof deathRecoveryOf } = {}): Promise<never> {
    let end: CombatLeave, eater: EndEater | undefined;
    try {
        // A death recovery walks the account by itself (bot.ts): the end step starts after it.
        await (deps.recovery ?? deathRecoveryOf)(s);
        // An account under attack keeps its eater through the logout windows too: the server takes no logout for 16
        // ticks after each hit, and the logout presses for up to 3 windows of 15 s.
        end = await (deps.leave ?? leaveCombat)(s, { food: deps.food, eatAt: deps.eatAt, keepEater: e => { eater = e; } });
    } catch (error) { end = { underAttack: true, left: false, quiet: false, ticks: 0, moves: 0, tiles: 0, eats: 0, detail: String(error).slice(0, 120) }; }
    let logged = { out: 'none', tries: 0 };
    return (deps.finish ?? finish)([s], ok, okNow => `${typeof detail === 'function' ? detail(okNow) : detail} ${combatEndText(eater ? { ...end, eats: eater.eats() } : end, logged)}`,
        { logout: async session => { try { logged = await (deps.logout ?? confirmedLogout)(session); } finally { eater?.stop(); } return logged.out; } });
}
export const combatEndText = (end: CombatLeave, logged: { out: string; tries: number }) =>
    `endTicks=${end.ticks} endUnderAttack=${end.underAttack} endLeft=${end.left} endQuiet=${end.quiet} endTiles=${end.tiles} endEats=${end.eats}${end.detail ? ` endDetail=${JSON.stringify(end.detail)}` : ''} logout=${logged.out === 'logged-out' ? 'confirmed' : logged.out} logoutTries=${logged.tries}`;
