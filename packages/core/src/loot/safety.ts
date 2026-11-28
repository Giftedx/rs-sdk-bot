import { lootCapacity, type LootStackDefinition } from '../loot-policy';
import { wildernessLevel } from '../prayer-guard';
import { LOOT_RULES, pileValue, unitValue, type Ground, type Held, type LootRules, type LootTables } from './valuation';

// Ticks after a hit on the player in which the player counts as in a fight (the engine's 8-tick combat lock).
const COMBAT_TICKS = 8;
// Players within this many tiles count as a threat in the Wilderness.
const PLAYER_RANGE = 15;
// Outside the Wilderness, a pile this close to its edge is skipped: the path to it can cross the edge.
const NEAR_WILD = 4;
// Bait trails: a player can drop item after item to lead a bot into the Wilderness or to a monster. Three guards
// stop it. Every pile must lie within maxDistance of the anchor, the tile where a run of pickups began; the anchor
// moves only after ANCHOR_RESET ticks with no pickup. LURE_PICKUPS pickups inside LURE_TICKS ticks stop all pickups
// for LURE_PAUSE ticks. And no pickup goes near the Wilderness edge or a stronger hunting NPC (lootRisk).
const ANCHOR_RESET = 100;
const LURE_PICKUPS = 3;
const LURE_TICKS = 100;
export const LURE_PAUSE = 300;

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const tileOf = (n: any) => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

// True when a tile within NEAR_WILD tiles of the pile is in the Wilderness.
function nearWild(g: { x: number; z: number }): boolean {
    for (const dx of [-NEAR_WILD, 0, NEAR_WILD]) {
        for (const dz of [-NEAR_WILD, 0, NEAR_WILD]) {
            if (wildernessLevel(g.x + dx, g.z + dz) > 0) return true;
        }
    }
    return false;
}

// Null when the pickup is safe, else the reason it is not. Rule: the pickup adds no risk that the script does not
// already take. The player goes no deeper into the Wilderness, meets no stranger there, and walks into the range
// of no hunting NPC that does not already have the player in range.
export function lootRisk(st: any, g: Ground, danger: ReadonlyMap<number, number>, friends: ReadonlySet<string>, r: LootRules = LOOT_RULES): string | null {
    const p = st?.player;
    if (!p) return 'no-state';
    if (g.reachable === false) return 'unreachable';
    const hp = p.hp ?? 0, max = p.maxHp ?? 0;
    if (max <= 0 || hp / max < r.minHp) return 'hp';
    const tick = st.tick ?? 0, hit = p.combat?.lastDamageTick ?? -1;
    if (p.combat?.inCombat || (hit >= 0 && tick - hit <= COMBAT_TICKS)) return 'combat';
    const me = { x: p.worldX ?? p.x, z: p.worldZ ?? p.z };
    const wildMe = wildernessLevel(me.x, me.z), wildThere = wildernessLevel(g.x, g.z);
    if (wildThere > wildMe) return 'deeper';
    if (wildMe === 0 && nearWild(g)) return 'near-wild';
    if (Math.max(wildMe, wildThere) > 0 && (st.nearbyPlayers ?? []).some((q: any) => !friends.has(String(q.name ?? '').toLowerCase()) && (q.distance ?? 0) <= PLAYER_RANGE))
        return 'player';
    const combat = p.combatLevel ?? 3;
    for (const n of st.nearbyNpcs ?? []) {
        const range = danger.get(n.id);
        if (range === undefined) continue;
        const t = tileOf(n);
        // A stronger hunter near the pile always stops the pickup, even one that already has the player in range.
        if (cheb(t, g) <= range && (cheb(t, me) > range || (n.combatLevel ?? 0) > combat)) return 'npc';
    }
    return null;
}

// The anchor and the bait-trail pause of one session. `allow` answers for a pile; `picked` records a pickup.
export function lureGuard(r: LootRules = LOOT_RULES) {
    let anchor: { x: number; z: number; level: number } | null = null, last = -Infinity, pausedTo = -Infinity;
    const picks: number[] = [];
    return {
        // Null when the pile may be taken, else the reason it may not.
        allow(now: number, me: { x: number; z: number; level: number }, g: { x: number; z: number }): string | null {
            if (now < pausedTo) return 'lure-pause';
            if (!anchor || now - last > ANCHOR_RESET) anchor = { ...me };
            if (anchor.level !== me.level || cheb(anchor, g) > r.maxDistance) return 'far-anchor';
            return null;
        },
        // Records a pickup. True when it starts the bait-trail pause.
        picked(now: number): boolean {
            last = now;
            picks.push(now);
            while (picks.length && now - picks[0]! > LURE_TICKS) picks.shift();
            if (picks.length < LURE_PICKUPS) return false;
            pausedTo = now + LURE_PAUSE;
            picks.length = 0;
            return true;
        },
        anchor: () => anchor,
    };
}

// Room for the pile: 'ok', the slot to drop first, or null. The only item the job drops is one of several slots
// of one item (a resource the script gathers, not a tool it holds once) that is worth under a tenth of the pile,
// is not kept and is not reserved.
export function lootRoom(pack: readonly Held[], g: Ground, t: LootTables, keep: (id: number) => boolean, definition?: LootStackDefinition): 'ok' | number | null {
    const native = definition?.(g.id);
    if (typeof native?.stackable !== 'boolean') return null;
    if (lootCapacity({ inventory: pack }, g, native)) return 'ok';
    if (pack.length > 28 || !Number.isSafeInteger(g.count) || g.count < 1 || g.count > 2147483647) return null;
    let heldTarget = 0;
    const slots = new Map<number, number>();
    for (let k = 0; k < pack.length; k++) {
        const i = pack[k]!;
        if (!Number.isSafeInteger(i.count) || i.count < 1 || i.count > 2147483647) return null;
        slots.set(i.id, (slots.get(i.id) ?? 0) + 1);
        if (i.id === g.id) heldTarget += i.count;
    }
    const freeAfterDrop = 28 - pack.length + 1;
    const worth = pileValue(g, t);
    let best: Held | null = null, bestValue = Infinity;
    for (let k = 0; k < pack.length; k++) {
        const i = pack[k]!;
        if (keep(i.id) || (slots.get(i.id) ?? 0) < 2) continue;
        const fits = native.stackable
            ? (((i.id === g.id ? heldTarget - i.count : heldTarget) > 0 || freeAfterDrop >= 1) && (i.id === g.id ? heldTarget - i.count : heldTarget) + g.count <= 2147483647)
            : freeAfterDrop >= g.count;
        if (!fits) continue;
        const v = unitValue(i.id, t) * i.count;
        if (v * 10 >= worth || v > bestValue) continue;
        if (v < bestValue || (best && i.slot > best.slot)) { best = i; bestValue = v; }
    }
    return best ? best.slot : null;
}

// One claim per pile across the sessions of one process (the bot host runs many bots in one process), so two of
// our bots never walk to the same pile.
const claims = new Map<string, { by: string; until: number }>();
export const pileKey = (level: number, g: Pick<Ground, 'id' | 'x' | 'z'>) => `${level}:${g.x}:${g.z}:${g.id}`;

export function claimPile(key: string, by: string, now = Date.now(), ms = 20_000): boolean {
    const c = claims.get(key);
    if (c && c.by !== by && c.until > now) return false;
    claims.set(key, { by, until: now + ms });
    return true;
}

export const releasePile = (key: string, by: string) => { if (claims.get(key)?.by === by) claims.delete(key); };
