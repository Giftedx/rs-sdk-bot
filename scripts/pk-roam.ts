// Wilderness PK hunt over the whole surface Wilderness.
// The world feed roster shows every player's tile and combat level, so the hunter picks the target it can reach
// first, runs to where that target will be (cutting it off on its way south), freezes it when it runs, and keeps
// attacking with the style the target does not protect against until the target dies, logs out or leaves.
//
// usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO]
//        [RANGED=bow-name-regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=20000] [BANK_AT=30000]
//        [FRIENDS=name,name] (the accounts never to attack, in place of the owned and listed accounts; FRIENDS= is none)
// The account starts south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt (shared with scripts/pk-hunt.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { lootCapacity } from '../packages/core/src/loot-policy';
import { isLocalServer } from '../packages/core/src/localserver';
import { RosterFeed } from '../packages/core/src/roster-feed';
import { gameDialAddress } from '../packages/core/src/websocket-proxy';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { tradePartners } from '../packages/core/src/tradeguard';
import { readOpponent, readOpponents } from '../packages/core/src/opponent';
import { componentId } from '../packages/core/src/logout';
import { bestFood, castableFreeze, dangerReason, defaultSpec, estMaxHit, fightPlayer, freezeSpell, getObjNames, isMulti, observePlayer, type FightOptions, type Kit } from './pk';
export { castableFreeze, freezeSpell };
import { armourDefence } from './pk-read';

// Surface Wilderness (content area_wilderness wilderness_zones: 0_46_55 to 3_52_99, 8 tiles per level).
export function wildLevel(x: number, z: number): number {
    if (x < 2944 || x > 3391 || z < 3520 || z > 3967) return 0;
    return Math.floor((z - 3520) / 8) + 1;
}

// Wilderness level across both surface (2944..3391, 3520..3967) and dungeon (z 9920..10367); safe zones like Mage Bank cellar return 0.
export function wildernessDepth(x: number, z: number): number {
    if (x >= 2944 && x <= 3391 && z >= 9920 && z <= 10367) return Math.floor((z - 9920) / 8) + 1;
    return wildLevel(x, z);
}

// pvp_combat.rs2: the combat gap must be no more than the lower of the two Wilderness levels.
export function canAttack(me: { x: number; z: number; combat: number }, them: { x: number; z: number; combatLevel: number }): boolean {
    const a = wildLevel(me.x, me.z), b = wildLevel(them.x, them.z);
    return a > 0 && b > 0 && Math.abs(me.combat - them.combatLevel) <= Math.min(a, b);
}

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const clampWild = (p: { x: number; z: number }) => ({ x: Math.min(3391, Math.max(2944, p.x)), z: Math.min(3967, Math.max(3520, p.z)) });

// Roster tile and speed; the rest is known only for players in view (client state and the opponent sensor).
export type Track = {
    name: string; x: number; z: number; combatLevel: number; vx: number; vz: number;
    fighting?: 'npc' | 'player'; skulled?: boolean; protect?: readonly string[]; hpFrac?: number; weapon?: number;
};

// Multi-combat zones (scripts/pk.ts isMulti).
export { isMulti };

// Lower is better: ticks to meet, less a bonus for prey that is weak, busy, carrying everything or unable to teleport.
// A skulled player drops all its items; a player fighting an NPC or another player is already losing HP and looking
// away; above Wilderness level 20 normal teleports fail and above 30 a glory fails (amulet_of_glory.rs2).
export function preyScore(t: Track, meetTicks: number, ganged = false): number {
    const lvl = wildLevel(t.x, t.z);
    return meetTicks
        - (t.skulled ? 40 : 0)
        - (t.fighting ? 30 : 0)
        - (t.hpFrac !== undefined ? (1 - t.hpFrac) * 60 : 0)
        - (t.protect && t.protect.length === 0 ? 10 : 0)
        - (lvl > 30 ? 25 : lvl > 20 ? 10 : 0)
        - (ganged ? 30 : 0);
}

// Target claims shared by our hunters (one file per side's checkout): in single-way combat only one attacker can
// fight a target, so a claimed target is left to its hunter; in multi-combat a claimed target is ganged.
export type Claims = Map<string, { hunter: string; at: number }>;
export const CLAIM_TTL_MS = 60_000;
export const SCOUT_INTEL_TTL_MS = 25_000;

export type ScoutIntel = {
    target: string;
    x: number;
    z: number;
    combatLevel: number;
    hpFrac?: number;
    skulled?: boolean;
    multi: boolean;
    wild: number;
    scout: string;
    at: number;
};

export function readScoutIntel(file = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'intel.json'), now = Date.now()): ScoutIntel[] {
    try {
        const rows = JSON.parse(readFileSync(file, 'utf8')) as ScoutIntel[];
        return Array.isArray(rows) ? rows.filter(r => now - r.at <= SCOUT_INTEL_TTL_MS) : [];
    } catch { return []; }
}

export function publishScoutIntel(entry: ScoutIntel, file = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'intel.json')): void {
    try {
        const fresh = readScoutIntel(file, entry.at).filter(r => r.target.toLowerCase() !== entry.target.toLowerCase());
        fresh.push(entry);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(fresh));
    } catch { /* scout handoff is best-effort */ }
}

export function clearScoutIntel(target: string, file = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'intel.json'), now = Date.now()): void {
    try {
        const left = readScoutIntel(file, now).filter(r => r.target.toLowerCase() !== target.toLowerCase());
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(left));
    } catch { /* ignore */ }
}

// Select the highest-priority scouted target for a roaming squad/army within maxWild and attackable combat bracket.
export function pickScoutTargetForSquad(opts: {
    me: { x: number; z: number; combat: number };
    intel: readonly ScoutIntel[];
    maxWild: number;
    friends?: ReadonlySet<string>;
    now?: number;
}): ScoutIntel | null {
    const { me, intel, maxWild, friends = new Set(), now = Date.now() } = opts;
    const candidates = intel.filter(i => now - i.at <= SCOUT_INTEL_TTL_MS
        && !friends.has(i.target.toLowerCase())
        && i.wild > 0 && i.wild <= maxWild
        && Math.abs(i.combatLevel - me.combat) <= i.wild);
    if (!candidates.length) return null;
    candidates.sort((a, b) => Number(b.multi) - Number(a.multi)
        || Number(Boolean(b.skulled)) - Number(Boolean(a.skulled))
        || (a.hpFrac ?? 1) - (b.hpFrac ?? 1)
        || cheb(me, a) - cheb(me, b));
    return candidates[0] ?? null;
}
// A target this many combat levels above us outclasses us; this many strangers within 6 tiles of it is a pile.
export const OUTCLASS_GAP = 3;
export const PILE_SIZE = 2;

// A player outclasses us when its combat is more than OUTCLASS_GAP above ours, or when it is within 5 levels of ours
// and its weapon is worth more than twice ours (items.json cost). Goondelf (126, dragon dagger) outclasses Mightyrod
// (126, adamant scimitar).
export function outclasses(me: { combat: number; weaponValue?: number }, them: { combatLevel: number; weapon?: number }): boolean {
    if (them.combatLevel > me.combat + OUTCLASS_GAP) return true;
    return me.weaponValue !== undefined && them.weapon !== undefined && them.combatLevel >= me.combat - 5 && itemCost(them.weapon) > 2 * me.weaponValue;
}

// Where the escape stands at a Wilderness level with what the pack holds: a glory works to level 30
// (amulet_of_glory.rs2), a teleport spell to level 20; deeper than both, run south until one works.
export function escapeStep(level: number, has: { glory: boolean; teleport: boolean }): 'glory' | 'teleport' | 'run' | 'out' {
    if (level === 0) return 'out';
    if (has.glory && level <= 30) return 'glory';
    if (has.teleport && level <= 20) return 'teleport';
    return 'run';
}

export type WildernessEscapeLoc = {
    id: number;
    kind: 'lever' | 'ladder' | 'gate' | 'web';
    name: string;
    option: string;
    x: number;
    z: number;
    wildLevel: number;
};

// Verified rev 289 Wilderness escape landmarks (Deserted Keep lever, Mage Bank cellar ladder/webs, member gates).
export const WILDERNESS_ESCAPES: readonly WildernessEscapeLoc[] = [
    { id: 1815, kind: 'lever', name: 'Deserted Keep lever', option: 'Pull', x: 3153, z: 3923, wildLevel: 51 },
    { id: 2871, kind: 'ladder', name: 'Mage Bank cellar ladder', option: 'Climb-down', x: 3091, z: 3957, wildLevel: 55 },
    { id: 733, kind: 'web', name: 'Mage Bank east web', option: 'Slash', x: 3095, z: 3957, wildLevel: 55 },
    { id: 733, kind: 'web', name: 'Mage Bank west web', option: 'Slash', x: 3093, z: 3957, wildLevel: 55 },
    { id: 1765, kind: 'ladder', name: 'Wilderness mirror ladder west', option: 'Climb-down', x: 3017, z: 3849, wildLevel: 42 },
    { id: 1767, kind: 'ladder', name: 'Wilderness mirror ladder east', option: 'Climb-down', x: 3069, z: 3856, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'Lava Maze gate', option: 'Open', x: 3071, z: 3857, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'KBD fence gate', option: 'Open', x: 3008, z: 3850, wildLevel: 42 },
    { id: 1596, kind: 'gate', name: 'West Wilderness gate', option: 'Open', x: 2948, z: 3904, wildLevel: 49 },
    { id: 1596, kind: 'gate', name: 'East Wilderness deep gate', option: 'Open', x: 3202, z: 3856, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'East Wilderness fence gate', option: 'Open', x: 3225, z: 3904, wildLevel: 49 },
];

export type WildernessEscapePlan = {
    kind: 'out' | 'glory' | 'teleport' | 'lever' | 'ladder' | 'run';
    distance: number;
    loc?: WildernessEscapeLoc;
    web?: WildernessEscapeLoc;
    obstacle?: WildernessEscapeLoc;
    detail: string;
};

// Choose the fastest rev-289 escape route from current coordinates: glory <=30, teleport <=20, nearby lever/safe ladder, else run south.
export function planWildernessEscape(pos: { x: number; z: number }, has: { glory: boolean; teleport: boolean }): WildernessEscapePlan {
    const level = wildLevel(pos.x, pos.z);
    if (level === 0) return { kind: 'out', distance: 0, detail: 'outside Wilderness' };
    if (has.glory && level <= 30) return { kind: 'glory', distance: 0, detail: `glory at level ${level}` };
    if (has.teleport && level <= 20) return { kind: 'teleport', distance: 0, detail: `teleport at level ${level}` };

    const targetZ = has.glory ? 3755 : has.teleport ? 3675 : 3518;
    const southDist = Math.max(0, pos.z - targetZ);
    const exits = WILDERNESS_ESCAPES
        .filter(e => e.id === 1815 || e.id === 2871)
        .map(e => ({ loc: e, dist: cheb(pos, e) }))
        .sort((a, b) => a.dist - b.dist);
    const bestExit = exits[0];
    if (bestExit && bestExit.dist <= 35 && bestExit.dist < southDist) {
        const web = bestExit.loc.id === 2871 && pos.x >= 3093
            ? WILDERNESS_ESCAPES.find(w => w.id === 733 && w.x === 3095 && w.z === 3957)
            : undefined;
        return { kind: bestExit.loc.kind as 'lever' | 'ladder', loc: bestExit.loc, web, distance: bestExit.dist, detail: `${bestExit.loc.name} (${bestExit.dist} tiles)` };
    }
    const obstacle = WILDERNESS_ESCAPES.find(e => (e.kind === 'gate' || e.kind === 'web') && Math.abs(e.x - pos.x) <= 6 && e.z <= pos.z && pos.z - e.z <= 20);
    return { kind: 'run', obstacle, distance: southDist, detail: `run south to level ${has.glory ? 30 : has.teleport ? 20 : 0}` };
}

// Slash a bigweb_slashable (id 733) repeatedly until it disappears (web.rs2:26 fails 50% of attempts with random(2)=1).
export async function slashWebThrough(
    s: Pick<Session, 'sdk' | 'bot'>,
    web: { id: number; option: string; x: number; z: number },
    stop: () => boolean = () => false,
    maxTries = 6,
): Promise<boolean> {
    const findWeb = () => {
        const locs = s.sdk.getState()?.nearbyLocs ?? [];
        return locs.find(l => l.id === web.id && Math.max(Math.abs(l.x - web.x), Math.abs(l.z - web.z)) <= 2)
            ?? locs.find(l => l.id === web.id);
    };
    for (let i = 0; i < maxTries && !stop(); i++) {
        const live = findWeb();
        if (!live) return true;
        if (typeof s.bot?.interactLoc !== 'function') return false;
        await s.bot.interactLoc(live, web.option).catch(() => {});
        await s.sdk.waitForTicks(2);
    }
    return !findWeb();
}

export function wildernessCombatMargin(me: { z: number; combat: number }, opponentCombat: number) {
    const level = Math.floor((Math.max(3520, me.z) - 3520) / 8) + 1;
    const wild = me.z >= 3520 ? level : 0;
    const gap = Math.abs(me.combat - opponentCombat);
    return {
        wildernessLevel: wild,
        attackable: wild > 0 && gap <= wild,
        minCombat: Math.max(3, me.combat - wild),
        maxCombat: Math.min(126, me.combat + wild),
        levelsToDrop: gap === 0 ? wild : Math.max(0, wild - gap + 1),
    };
}

export function assessWildernessThreat(
    me: { x: number; z: number; combat: number; weaponValue?: number; foodCount: number; glory: boolean; teleport: boolean },
    nearby: readonly { name: string; x?: number; z?: number; combatLevel: number; distance: number; inCombat?: boolean; combatTargetType?: string; wornWeapon?: number }[],
    friends: ReadonlySet<string>,
    multiAt: (x: number, z: number) => boolean = isMulti,
) {
    const multi = wildLevel(me.x, me.z) > 0 && multiAt(me.x, me.z);
    const hostiles = nearby.filter(p => !friends.has(p.name.toLowerCase()) && p.distance <= 12
        && canAttack({ x: me.x, z: me.z, combat: me.combat }, { x: p.x ?? me.x, z: p.z ?? me.z, combatLevel: p.combatLevel }));
    const outclassedBy = hostiles.find(p => outclasses({ combat: me.combat, weaponValue: me.weaponValue }, { combatLevel: p.combatLevel, weapon: p.wornWeapon }));
    const multiPile = multiPileThreat(me, nearby, friends, multiAt);
    const pjWaiters = hostiles.filter(p => p.distance <= 8 && !p.inCombat).length;
    const escapePlan = planWildernessEscape(me, { glory: me.glory, teleport: me.teleport });
    const pjUnsafe = !multi && hostiles.length >= 2 && pjWaiters >= 1 && me.foodCount <= 4;
    const retreatReason = outclassedBy ? `threat: ${outclassedBy.name} (combat ${outclassedBy.combatLevel}) at ${outclassedBy.distance} tiles`
        : multiPile ? multiPile
        : pjUnsafe ? `pj risk: ${hostiles.length} attackable hostiles (${pjWaiters} idle) with ${me.foodCount} food`
        : null;
    return { multi, hostilesCount: hostiles.length, outclassedBy, multiPile, pjWaiters, escapePlan, retreatReason };
}

const AIR_STAFF = /staff of air|air battlestaff|mystic air staff/i;
const FIRE_STAFF = /staff of fire|fire battlestaff|mystic fire staff/i;

// Magic 25 Varrock Teleport runes: 1 law rune, 3 air runes (or air staff), 1 fire rune (or fire staff).
export function hasVarrockTeleport(magic: number, inventory: readonly { name: string; count?: number }[], equipment: readonly { name: string }[]): boolean {
    if (magic < 25) return false;
    const held = (re: RegExp) => inventory.filter(i => re.test(i.name)).reduce((n, i) => n + (i.count ?? 1), 0);
    const worn = (re: RegExp) => equipment.some(i => re.test(i.name));
    return held(/^law rune$/i) >= 1 && (held(/^air rune$/i) >= 3 || worn(AIR_STAFF)) && (held(/^fire rune$/i) >= 1 || worn(FIRE_STAFF));
}

// In multi-way combat, PILE_SIZE or more attackable strangers within 8 tiles can focus and stack out a solo roamer.
export function multiPileThreat(me: { x: number; z: number; combat: number }, nearby: readonly { name: string; x?: number; z?: number; combatLevel: number; distance: number }[],
    friends: ReadonlySet<string>, multiAt: (x: number, z: number) => boolean = isMulti, pileSize = PILE_SIZE): string | null {
    if (wildLevel(me.x, me.z) === 0 || !multiAt(me.x, me.z)) return null;
    const hostiles = nearby.filter(p => !friends.has(p.name.toLowerCase()) && p.distance <= 8 && canAttack(me, { x: p.x ?? me.x, z: p.z ?? me.z, combatLevel: p.combatLevel }));
    return hostiles.length >= pileSize ? `multi pile: ${hostiles.length} attackable enemies (${hostiles.slice(0, 3).map(p => p.name).join(', ')}) within 8 tiles` : null;
}

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

// Tiles a target at the meeting tile must run south to get out of attack range. A freeze cycle is the hold plus 5
// immune ticks (pvp_magic.rs2:85-104) in which the target runs about 10 tiles; a tough target takes several cycles
// (practice: 95 HP in rune armour lost 19 HP in a 24-tick Entangle), so 40 tiles leaves about four.
export const MIN_ESCAPE_TILES = 40;

// The best prey we can attack at the meeting tile and freeze before it runs out of range. In single-way combat a
// player already fighting another player, or claimed by another of our hunters, cannot be attacked; in multi-combat
// both are fair game and a claimed target is ganged.
export function pickTrack(me: { x: number; z: number; combat: number; name?: string; weaponValue?: number }, tracks: Track[], friends: ReadonlySet<string>, maxWild: number,
    skip: ReadonlySet<string> = new Set(), minEscape = MIN_ESCAPE_TILES, claims: Claims = new Map(), now = Date.now(), multiAt: (x: number, z: number) => boolean = isMulti) {
    let best: { track: Track; at: { x: number; z: number; ticks: number }; score: number } | null = null;
    for (const t of tracks) {
        const key = t.name.toLowerCase();
        if (friends.has(key) || skip.has(key) || wildLevel(t.x, t.z) === 0 || wildLevel(t.x, t.z) > maxWild) continue;
        const at = intercept(me, t);
        if (!canAttack({ x: at.x, z: at.z, combat: me.combat }, { x: at.x, z: at.z, combatLevel: t.combatLevel })) continue;
        if (at.z - escapeZ(Math.abs(me.combat - t.combatLevel)) < minEscape) continue;
        const multiHere = multiAt(t.x, t.z);
        const claim = claims.get(key);
        const claimedByOther = !!claim && now - claim.at < CLAIM_TTL_MS && claim.hunter !== me.name?.toLowerCase();
        if (!multiHere && (t.fighting === 'player' || claimedByOther)) continue;
        // Survival first: never pick a fight with someone who outclasses us, or a pile of attackable strangers.
        if (outclasses(me, t)) continue;
        if (tracks.filter(o => o !== t && !friends.has(o.name.toLowerCase()) && cheb(o, t) <= 6 && canAttack({ x: t.x, z: t.z, combat: me.combat }, o)).length >= PILE_SIZE) continue;
        const score = preyScore(t, at.ticks, multiHere && claimedByOther);
        if (!best || score < best.score) best = { track: t, at, score };
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

export function connectRadar(server: string, radar: Radar) {
    const url = `${isLocalServer(server) ? 'ws' : 'wss'}://${server}/worldfeed`;
    const socket = new WebSocket(gameDialAddress(url)), feed = new RosterFeed();
    let beat: ReturnType<typeof setInterval> | undefined;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'roster', on: true }));
        beat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' })); }, 30_000);
    });
    socket.addEventListener('message', ({ data }) => { try { radar.accept(feed.expand(JSON.parse(String(data)))); } catch { /* not a roster frame */ } });
    socket.addEventListener('close', () => { if (beat) clearInterval(beat); });
    return () => { if (beat) clearInterval(beat); socket.close(); };
}

// Wear the glory in the pack (after a rub: the game rubs a glory only from the pack).
export async function wearGlory(s: Session): Promise<void> {
    const g = s.sdk.getInventory().find(i => /^amulet of glory\([1-4]\)$/i.test(i.name));
    const op = g?.optionsWithIndex?.find((o: { text: string }) => /^wear$/i.test(o.text));
    if (g && op && !s.sdk.getEquipment().some(i => /^amulet of glory/i.test(i.name))) { await s.sdk.sendUseItem(g.slot, op.opIndex); await s.sdk.waitForTicks(1); }
}

// friends replaces the fleet list of accounts never to attack (practice passes its own target's absence).
export type Cfg = { maxMs: number; maxWild: number; eatAt: number; fleeAt: number; spell: string; ranged?: RegExp; loot: boolean; freeze: boolean; friends?: readonly string[];
    // Fight options added to each fight of the hunt (the army's allies and shared freeze, scripts/pk-army.ts).
    fight?: Partial<FightOptions>;
    // While hold() is true the chase closes to 3 tiles of its target and casts and attacks nothing (the army's
    // opening in one tick, scripts/pk-army.ts).
    hold?: () => boolean;
    // The tiles the hold closes to (default 3).
    holdRange?: number;
    // While true, the chase toward a target out of view waits (the army's pace, scripts/pk-army.ts PACE).
    pace?: () => boolean;
    specAll?: boolean;
    maxTicks?: number;
    // Pick up stacks worth at least lootMin gp; bank when carried loot reaches bankAt gp (defaults 1,000 and 100,000).
    lootMin?: number; bankAt?: number };

// A hunter's first sweep tile, from its name: hunters spread round the loop instead of starting together.
export function sectorStart(name: string, legs: number): number {
    let h = 0;
    for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return legs > 0 ? h % legs : 0;
}

// Sweep tiles across the Wilderness, west to east and back, shallow to deep.
export function sweep(maxWild: number): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    const zs = [3540, 3620, 3700, 3780, 3860, 3940].filter(z => wildLevel(3100, z) <= maxWild);
    zs.forEach((z, i) => { const xs = [2970, 3060, 3150, 3240, 3330]; pts.push(...(i % 2 ? xs.reverse() : xs).map(x => ({ x, z }))); });
    return pts.length ? pts : [{ x: 3090, z: 3524 }];
}

type Item = { id: number; name: string; slot?: number };
const MELEE_WEAPON = /dagger|scimitar|longsword|sword|mace|battleaxe|warhammer|spear|halberd/i;
// Fight kit for scripts/pk.ts: melee wields the worn weapon and shield (or a carried melee weapon/shield if a bow or
// staff is worn at start), ranged a carried bow (RANGED, default any bow), magic a carried staff. A style is
// present only when the account carries its weapon: fightPlayer skips a style with an empty kit (pk.ts hasStyle).
export function kitFrom(worn: readonly Item[], carried: readonly Item[], ranged = /bow$/i): Kit {
    const kit: Kit = {};
    const wornWep = worn.find(i => i.slot === 3 && !ranged.test(i.name) && !/staff/i.test(i.name));
    const wornShield = worn.find(i => i.slot === 5);
    const wep = wornWep ?? carried.find(i => !ranged.test(i.name) && !/staff/i.test(i.name) && MELEE_WEAPON.test(i.name));
    const shield = wornShield ?? (wep ? carried.find(i => /shield$/i.test(i.name)) : undefined);
    const melee = [wep?.id, shield?.id].filter((id): id is number => id !== undefined);
    if (melee.length) kit.melee = melee;
    const bow = [...worn, ...carried].find(i => ranged.test(i.name));
    if (bow) kit.ranged = [bow.id];
    const staff = [...worn, ...carried].find(i => /staff/i.test(i.name));
    if (staff) kit.magic = [staff.id];
    return kit;
}

// Damage spell components (vendor/rs-sdk/sdk/spells.ts) by SPELL name.
const SPELL_IDS: Record<string, number> = {
    FIRE_STRIKE: 1158, FIRE_BOLT: 1169, FIRE_BLAST: 1181, FIRE_WAVE: 1189,
    SARADOMIN_STRIKE: 1190, CLAWS_OF_GUTHIX: 1191, FLAMES_OF_ZAMORAK: 1192, IBAN_BLAST: 1539,
};
export function spellId(name: string): number {
    const n = Number(name);
    return SPELL_IDS[name.toUpperCase()] ?? (Number.isInteger(n) && n > 0 ? n : SPELL_IDS.FIRE_BOLT);
}

const GOD_SPELLS: readonly { staffId: number; spell: number; fire: number; blood: number; air: number }[] = [
    { staffId: 2415, spell: 1190, fire: 2, blood: 2, air: 4 }, // Saradomin Strike
    { staffId: 2416, spell: 1191, fire: 1, blood: 2, air: 4 }, // Claws of Guthix
    { staffId: 2417, spell: 1192, fire: 4, blood: 2, air: 1 }, // Flames of Zamorak
];

// The strongest fire spell the Magic level and carried runes allow (a fire staff or fire runes assumed):
// Fire Wave 75 (blood), Fire Blast 59 (death), Fire Bolt 35 (chaos), else Fire Strike.
export function bestFireSpell(magic: number, carried: readonly { id: number; count: number }[]): number {
    const has = (id: number) => carried.some(i => i.id === id && i.count > 0);
    if (magic >= 75 && has(565)) return SPELL_IDS.FIRE_WAVE!;
    if (magic >= 59 && has(560)) return SPELL_IDS.FIRE_BLAST!;
    if (magic >= 35 && has(562)) return SPELL_IDS.FIRE_BOLT!;
    return SPELL_IDS.FIRE_STRIKE!;
}

// Prefer a 2004 God Spell when Magic >= 60, the matching God Staff is held/worn, and its runes are carried.
export function bestDamageSpell(magic: number, carried: readonly { id: number; count: number }[], worn: readonly { id: number }[] = []): number {
    const countOf = (id: number) => carried.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    if (magic >= 60) {
        for (const g of GOD_SPELLS) {
            const hasStaff = worn.some(i => i.id === g.staffId) || carried.some(i => i.id === g.staffId);
            if (hasStaff && countOf(554) >= g.fire && countOf(565) >= g.blood && countOf(556) >= g.air) return g.spell;
        }
    }
    return bestFireSpell(magic, carried);
}

export function canCastCharge(magic: number, carried: readonly { id: number; count: number }[], damageSpell: number): boolean {
    if (magic < 80 || !GOD_SPELLS.some(g => g.spell === damageSpell)) return false;
    const countOf = (id: number) => carried.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    return countOf(565) >= 3 && countOf(554) >= 3 && countOf(556) >= 3;
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
    // cfg.maxTicks: the hunt also ends after that many game ticks, so a practice run gets the same game time whatever
    // the machine's speed (the wall clock gave 213 to 3,169 ticks to one minute, extra:roam-field).
    const tickEnd = cfg.maxTicks ? session.tick() + cfg.maxTicks : Infinity;
    const going = () => Date.now() < end && session.tick() < tickEnd;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    // The fight loop casts the freeze the level allows, so it freezes only when that one is castable.
    const freezeNow = () => cfg.freeze ? castableFreeze(magic, sdk.getInventory()) : null;
    const freeze = freezeNow();
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, freezes: 0, chases: 0, loot: [] as string[], lootValue: 0, banked: 0, escapes: 0, targets: [] as string[] };
    const walker = await sessionWalker(session);
    const skip = new Set<string>();
    // Roster tracks plus the players the client sees now; the client copy wins for players in view.
    const tracks = (): Track[] => {
        const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
        const all = new Map(radar.fresh() ? radar.tracks : []);
        for (const p of sdk.getState()?.nearbyPlayers ?? []) {
            const key = p.name.toLowerCase(), old = all.get(key);
            const o = seen.get(key);
            const fighting = p.inCombat && (p.combatTargetType === 'npc' || p.combatTargetType === 'player') ? p.combatTargetType : undefined;
            all.set(key, { name: p.name, x: p.x, z: p.z, combatLevel: p.combatLevel, vx: old?.vx ?? 0, vz: old?.vz ?? 0, fighting,
                skulled: o?.skulled, protect: o?.protect, hpFrac: o?.hp ? o.hp.current / o.hp.max : undefined, weapon: o?.worn.rhand });
        }
        return [...all.values()];
    };
    const claimsFile = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'claims.json');
    const readClaims = (): Claims => {
        try { return new Map(Object.entries(JSON.parse(readFileSync(claimsFile, 'utf8')))) as Claims; } catch { return new Map(); }
    };
    const writeClaims = (edit: (c: Claims) => void) => {
        try {
            const c = readClaims(); edit(c);
            mkdirSync(join(claimsFile, '..'), { recursive: true });
            writeFileSync(claimsFile, JSON.stringify(Object.fromEntries(c)));
        } catch { /* claims are a courtesy between our hunters */ }
    };
    const myName = session.name.toLowerCase();
    // Our own weapon's value: the best of the staged melee and ranged weapons.
    const myWeaponValue = () => Math.max(0, ...[...(kit.melee ?? []), ...(kit.ranged ?? []), ...(kit.magic ?? [])].map(id => itemCost(id)));
    const intelFile = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'intel.json');
    const shareIntel = (t: Pick<Track, 'name' | 'x' | 'z' | 'combatLevel' | 'hpFrac' | 'skulled'>) => {
        const wild = wildLevel(t.x, t.z);
        if (wild > 0) publishScoutIntel({
            target: t.name, x: t.x, z: t.z, combatLevel: t.combatLevel,
            hpFrac: t.hpFrac, skulled: t.skulled, multi: isMulti(t.x, t.z),
            wild, scout: myName, at: Date.now(),
        }, intelFile);
    };
    const claim = (target: string) => writeClaims(c => c.set(target.toLowerCase(), { hunter: myName, at: Date.now() }));
    const release = (target: string) => {
        writeClaims(c => { if (c.get(target.toLowerCase())?.hunter === myName) c.delete(target.toLowerCase()); });
        clearScoutIntel(target, intelFile);
    };
    const pickNow = (m: { x: number; z: number; combat: number }) =>
        pickTrack({ ...m, name: myName, weaponValue: myWeaponValue() }, tracks(), friends, cfg.maxWild, skip, MIN_ESCAPE_TILES, readClaims(), Date.now());
    let wentIn = false;
    let spun = -1;
    // The fight kit is read once, as staged: the worn weapon and shield, a bow and a staff carried.
    const kit = kitFrom(sdk.getEquipment(), sdk.getInventory(), cfg.ranged);
    emit({ e: 'kit', kit });
    // Loot and banking: everything staged at the start is kit; anything else carried is loot.
    // The kit is the pack's count of each item at the start: loot often is the same items (a maxed target drops rune
    // arrows, a staff, rune armour, a dagger, a glory and runes), so an id kept as kit left all of it in the pack
    // and each bank trip deposited nothing (extra:roam-field, finding 70). An item counts in any dose or charge (a
    // drunk Prayer potion(2) or a rubbed glory is still kit): the key is its name without the "(n)".
    const GLORY = /^amulet of glory\([1-4]\)$/i;
    const kitKey = (i: { id: number; name: string }) => i.name.replace(/\(\d\)$/, '').toLowerCase();
    const startPack = new Map<string, number>();
    // Worn items count too: the fight loop's escape takes a worn glory off to rub it and leaves it in the pack.
    for (const i of [...sdk.getInventory(), ...sdk.getEquipment()]) startPack.set(kitKey(i), (startPack.get(kitKey(i)) ?? 0) + i.count);
    const extraLoot = () => { const now = new Map<string, number>(); for (const i of [...sdk.getInventory(), ...sdk.getEquipment()]) now.set(kitKey(i), (now.get(kitKey(i)) ?? 0) + i.count); return [...now].some(([k, n]) => n > (startPack.get(k) ?? 0)); };
    const startFood = food()[0];
    const foodCount = startFood ? sdk.getInventory().filter(i => i.id === startFood.id).length : 0;
    const valuer = makeValuer(server);
    // 20,000 gp a stack: in extra:roam-field (seeds 1 to 8) it kept about 97% of the loot value of 1,000 and gave 24
    // kills of 32 against 21; the cheap stacks (sharks, runes) cost the ticks of a kill.
    const lootMin = cfg.lootMin ?? 20_000, bankAt = cfg.bankAt ?? 30_000;
    let carried = 0;
    const loot = async (at: { x: number; z: number }) => { carried += await lootAt(session, at, { value: valuer, min: lootMin, stats, emit }); };
    // A full pack sends the hunt to the bank only with loot to put there: the fight kit itself (18 sharks, runes,
    // potions, the bow) leaves 2 slots or fewer, and each chase then ended in a 156-tick walk to the bank and back
    // with nothing deposited (extra:army-route-spear-pair-x5, finding 68).
    const needBank = () => carried >= bankAt || (carried > 0 && 28 - sdk.getInventory().length <= 2);
    const bank = async (why: string) => {
        emit({ e: 'bank-trip', why, carried });
        const ok = await bankTrip(session, walker, startPack, kitKey, startFood?.id, foodCount, stopped, emit);
        if (ok) { stats.banked += carried; carried = 0; }
        return ok;
    };

    // Damage taken from players, for the danger checks between fights (the fight loop keeps its own).
    const hits: { tick: number; damage: number; src: number }[] = [];
    let seenHit = 0;
    const recordHits = () => {
        let maxHit = seenHit;
        for (const e of sdk.getState()?.combatEvents ?? []) {
            const id = e.observationId ?? e.tick;
            if (id <= seenHit) continue;
            if (id > maxHit) maxHit = id;
            if (e.type === 'damage_taken' && e.sourceType === 'other_player') hits.push({ tick: session.tick(), damage: e.damage, src: e.sourceIndex });
        }
        seenHit = maxHit;
    };
    const canTeleport = () => hasVarrockTeleport(sdk.getSkill('Magic')?.level ?? 1, sdk.getInventory(), sdk.getEquipment());
    // Leave the Wilderness: glory, else teleport, else run south (eating) until one works. Ends the hunt.
    const escape = async (why: string) => {
        stats.escapes++;
        emit({ e: 'escape', why, hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0 });
        // A stop request does not end the escape: live, a stop file froze Mightyrod at level 36 and it died.
        let blocked = 0, removeTries = 0;
        for (let step = 0; step < 120; step++) {
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (m.hp * 100 <= m.maxHp * cfg.eatAt) { const meal = bestFood(sdk.getInventory() as any); if (meal) await bot.eatFood(meal as any); }
            const glory = sdk.getInventory().find(i => GLORY.test(i.name));
            const worn = sdk.getEquipment().find(i => GLORY.test(i.name));
            const how = escapeStep(wildLevel(m.x, m.z), { glory: !!glory || (!!worn && removeTries < 3), teleport: canTeleport() });
            if (how === 'out') { emit({ e: 'escaped', at: [m.x, m.z], hp: m.hp }); return true; }
            // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option): a worn one comes off
            // first, into a free slot (a full pack eats a food for one). Without this a roam with its glory worn
            // walked out, and a blocked walk stood 908 ticks at level 14. Three tries, then the walk.
            if (how === 'glory' && !glory) {
                const meal = sdk.getInventory().length >= 28 ? bestFood(sdk.getInventory() as any) : undefined;
                if (meal) await bot.eatFood(meal as any);
                else { removeTries++; await sdk.sendUseEquipmentItem?.(worn!.slot, 1); }
                await sdk.waitForTicks(1); continue;
            }
            if (how === 'glory') {
                const op = glory!.optionsWithIndex?.find((o: any) => /^rub$/i.test(o.text));
                await sdk.sendUseItem(glory!.slot, op?.opIndex ?? 4);
                for (let i = 0; i < 6 && !sdk.getDialog()?.isOpen; i++) await sdk.waitForTicks(1);
                await sdk.clickDialogByText(/^Edgeville/i);
                await sdk.waitForTicks(6);
                // A glory that came off to be rubbed goes back on: left in the pack, the rubbed one (a new item id)
                // read as loot and the next bank trip deposited it.
                if (removeTries > 0) await wearGlory(session);
            } else if (how === 'teleport') {
                await sdk.sendClickComponent(componentId('magic:varrock_teleport'));
                await sdk.waitForTicks(6);
            } else {
                const plan = planWildernessEscape(m, { glory: !!glory || (!!worn && removeTries < 3), teleport: canTeleport() });
                const findLoc = (loc: { id: number; x: number; z: number }) => sdk.getState()?.nearbyLocs.find(l => l.id === loc.id && Math.max(Math.abs(l.x - loc.x), Math.abs(l.z - loc.z)) <= 2)
                    ?? sdk.getState()?.nearbyLocs.find(l => l.id === loc.id);
                if ((plan.kind === 'lever' || plan.kind === 'ladder') && plan.loc) {
                    if (plan.web && cheb(m, plan.web) <= 3) await slashWebThrough(session, plan.web, () => false);
                    await walkPath(walker, [{ x: plan.loc.x, z: plan.loc.z, tol: 2 }], { maxTicks: 16, idleMs: 9000 });
                    const exitLoc = findLoc(plan.loc);
                    if (exitLoc && typeof bot.interactLoc === 'function') {
                        await bot.interactLoc(exitLoc, plan.loc.option).catch(() => {});
                        await sdk.waitForTicks(4);
                        continue;
                    }
                }
                if (plan.obstacle && cheb(m, plan.obstacle) <= 3) {
                    if (plan.obstacle.kind === 'web') await slashWebThrough(session, plan.obstacle, () => false);
                    else {
                        const obstacleLoc = findLoc(plan.obstacle);
                        if (obstacleLoc && typeof bot.interactLoc === 'function') await bot.interactLoc(obstacleLoc, plan.obstacle.option).catch(() => {});
                    }
                }
                // A walk that moved us nowhere goes 10 tiles to the side, east and west in turn, before south again.
                const side = blocked ? (blocked % 2 ? 10 : -10) : 0;
                await walkPath(walker, [{ x: m.x + side, z: Math.max(3510, m.z - (side ? 4 : 20)), tol: 2 }], { maxTicks: 12, idleMs: 9000 });
                const n = me();
                blocked = n && n.x === m.x && n.z === m.z ? blocked + 1 : 0;
            }
        }
        return false;
    };
    const survive = async (): Promise<'ok' | 'flee' | 'dead'> => {
        const m = me();
        if (!m) return 'ok';
        recordHits();
        if (wildLevel(m.x, m.z) > 0) wentIn = true;
        if (wentIn && cheb(m, { x: 3222, z: 3218 }) <= 6) { stats.deaths++; emit({ e: 'death' }); return 'dead'; }
        const attackers = (sdk.getState()?.nearbyPlayers ?? []).filter(p => hits.some(h => h.src === p.index && session.tick() - h.tick <= 10));
        const oppMax = estMaxHit(Math.max(m.combat, ...attackers.map(p => p.combatLevel)));
        if (m.hp <= Math.max(m.maxHp * cfg.eatAt / 100, oppMax + 8) && food().length) {
            const r = await bot.eatFood(bestFood(sdk.getInventory() as any) as any ?? food()[0]);
            stats.eats++; emit({ e: 'eat', hp: m.hp, ok: r.success });
        }
        const danger = wildLevel(m.x, m.z) > 0 ? dangerReason({ hp: m.hp, maxHp: m.maxHp, food: food().length > 0, prayer: sdk.getState()?.prayers?.prayerPoints ?? 1,
            // No race here: this check does not see the damage dealt, so every fight's hits read as a lost race
            // (dealt 0) and ended the hunt after its first timeout (finding 63). The fight loop runs the race itself.
            oppMax, hits, dealt: [], now: session.tick(), race: process.env.ROAM_RACE === '1', noFoodAt: cfg.fight?.noFoodAt }) : null;
        if (danger) { await escape(danger); return 'flee'; }
        if (wildLevel(m.x, m.z) > 0) {
            const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
            const threat = (sdk.getState()?.nearbyPlayers ?? []).find(p => !friends.has(p.name.toLowerCase()) && p.distance <= 12 && outclasses(
                { combat: m.combat, weaponValue: myWeaponValue() }, { combatLevel: p.combatLevel, weapon: seen.get(p.name.toLowerCase())?.worn.rhand }));
            if (threat) { await escape(`threat: ${threat.name} (combat ${threat.combatLevel}) at ${threat.distance} tiles`); return 'flee'; }
            const pile = multiPileThreat(m, sdk.getState()?.nearbyPlayers ?? [], friends);
            if (pile) { await escape(pile); return 'flee'; }
            if (wildLevel(m.x, m.z) > cfg.maxWild) { await escape(`deeper than the limit (${wildLevel(m.x, m.z)} > ${cfg.maxWild})`); return 'flee'; }
        }
        return 'ok';
    };

    // Fight one target until it dies, logs out, leaves the Wilderness, or the chase stalls.
    // The feed shows no armour, so the first pick is by reach. Once the target is in view, the chase moves, before its
    // first fight, to an idle player in view whose melee armour is at least ROAM_SOFTER (40) stab defence lower
    // (research/pvp-fight-loop.md finding 62). ROAM_SWITCH=0 keeps the first pick.
    const switchOn = process.env.ROAM_SWITCH !== '0', softer = Number(process.env.ROAM_SOFTER ?? 40);
    // cfg.specAll: every special goes at any health and with no reserve (the army leader's LEADER_SPEC=all).
    const specAll = <T extends { below: number } | undefined>(spec: T): T => (cfg.specAll && spec ? { ...spec, below: 1 } : spec);
    const stabOf = (index: number) => { const o = observePlayer(session.client, index); return o ? armourDefence(o.worn.map(id => getObjNames().get(id) ?? '')).melee : null; };
    let chasing = '';
    const chase = async (first: string): Promise<'kill' | 'gone' | 'left' | 'stall' | 'flee' | 'dead' | 'stop'> => {
        let name = chasing = first, fought = false;
        stats.chases++;
        let lastTile: { x: number; z: number } | null = null, lastDist = Infinity, contactAt = session.tick();
        let held = false, freezeReady = 0, lastSeenAt: { x: number; z: number } | null = null;
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s !== 'ok') return s;
            const m = me()!;
            const near = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
            const track = radar.tracks.get(name.toLowerCase());
            const opp = near ? readOpponent(session.client, name) : null;
            if (session.tick() % 10 === 0) {
                claim(name);
                if (near) shareIntel({ name, x: near.x, z: near.z, combatLevel: near.combatLevel, hpFrac: opp?.hp?.fresh ? opp.hp.current / Math.max(1, opp.hp.max) : undefined, skulled: opp?.skulled });
                else if (track) shareIntel(track);
            }
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
            // Never follow a target past the depth limit: live, a chase took Mightyrod from level 5 to 36, past the
            // reach of its teleport (20), and it died there.
            if (wildLevel(pos.x, pos.z) > cfg.maxWild || wildLevel(m.x, m.z) > cfg.maxWild) { emit({ e: 'too-deep', target: name, wild: wildLevel(m.x, m.z) }); return 'left'; }
            lastTile = { x: pos.x, z: pos.z };

            if (near && near.distance <= 15 && switchOn && !fought) {
                const mine = stabOf(near.index);
                const soft = mine === null ? undefined : (sdk.getState()?.nearbyPlayers ?? [])
                    .filter(p => p.index !== near.index && !friends.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && p.distance <= 15 && !p.inCombat && canAttack(m, p))
                    .map(p => ({ p, stab: stabOf(p.index) })).filter(x => x.stab !== null && x.stab + softer <= mine)
                    .sort((a, b) => a.stab! - b.stab! || a.p.distance - b.p.distance)[0];
                if (soft) {
                    emit({ e: 'switch', from: name, to: soft.p.name, stab: [mine, soft.stab] });
                    release(name); name = chasing = soft.p.name; claim(name); stats.targets.push(name);
                    lastDist = Infinity; held = false; lastSeenAt = null; continue;
                }
            }
            if (near && near.distance <= 15) {
                contactAt = session.tick();
                const fleeing = near.distance > lastDist && near.distance >= 2;
                lastDist = near.distance;
                // The SDK reports every freeze as a hit (the server grants the XP before the hit roll), so a held
                // target is one that stops moving: a move after a freeze means it splashed or ended.
                if (held && lastSeenAt && cheb(lastSeenAt, near) >= 1) { held = false; freezeReady = Math.max(freezeReady, session.tick() + 5); }
                lastSeenAt = { x: near.x, z: near.z };
                // Freeze first, at first reach, before the target can run; freeze again whenever it moves.
                const castable = freezeNow();
                if (cfg.hold?.()) {
                    const range = cfg.holdRange ?? 3;
                    if (near.distance > range && !cfg.pace?.()) await walkPath(walker, [{ x: near.x, z: near.z, tol: range }], { maxTicks: 2, idleMs: 9000, stop: stopped });
                    else await sdk.waitForTicks(1);
                    continue;
                }
                if (castable && canAttack(m, near) && session.tick() >= freezeReady && !held) {
                    // A cast on an immune or held target gives no XP; the SDK then waits out its timeout, so keep it short:
                    // 2.4 s is 6 live ticks (400 ms). Live, 1 s (2.5 ticks) reported every Snare as unproved.
                    const r = await bot.castSpell(near as any, castable, 2400);
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
                // special, food, prayer, glory escape). It exits immediately if the target leaves range or the
                // Wilderness, exceeds maxWild, or a stop condition fires.
                stats.attacks++; fought = true;
                const damageSpell = cfg.spell.toUpperCase() === 'AUTO' ? bestDamageSpell(magic, sdk.getInventory(), sdk.getEquipment()) : spellId(cfg.spell);
                const fight = await fightPlayer(session, name, {
                    // eatAt is a percentage here and an HP value in fightPlayer. Live, a 26 HP account given 50 ate a shark every
                    // 3 ticks at full HP.
                    kit, spec: specAll(defaultSpec(kit)), freeze: freezeNow() !== null ? 'flee' : false, predictPrayer: true, snapPrayer: true, eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), exitOnDanger: true,
                    escapeAt: Math.ceil((me()?.maxHp ?? 99) * cfg.fleeAt / 100), damageSpell, ...(canCastCharge(magic, sdk.getInventory(), damageSpell) ? { charge: true } : {}),
                    escapeOutnumbered: 2, allies: [...friends],
                    cap: 120, maxWild: cfg.maxWild, maxDistance: 15, ...cfg.fight, stop: () => stopped() || !going(),
                    log: line => emit({ e: "fight", line }),
                });
                emit({ e: "fight-end", target: name, outcome: fight.outcome, ticks: fight.ticks, dealt: fight.dealt, taken: fight.taken, eaten: fight.eaten });
                stats.eats += fight.eaten;
                stats.freezes += fight.freezes;
                if (fight.outcome === "kill") {
                    stats.kills++;
                    const at = fight.targetAt ?? lastTile;
                    await sdk.waitForTicks(4);
                    if (cfg.loot && at) await loot(at);
                    return "kill";
                }
                if (fight.outcome === "died") { stats.deaths++; return "dead"; }
                if (fight.outcome === "escaped") return "flee";
                if (fight.outcome === "danger") {
                    // The fight loop's own escape first (ROAM_FLEE, default on): protect prayer off the attacker's style,
                    // food, glory or the teleport spell, else a run with freezes on a chaser; as the hunt does (finding 61).
                    if (process.env.ROAM_FLEE !== '0') {
                        stats.escapes++;
                        emit({ e: 'escape', why: fight.danger ?? 'danger', hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0, flee: true });
                        const e = await fightPlayer(session, name, { kit, exitOnDanger: false, cap: 200, predictPrayer: true, snapPrayer: true, flee: true,
                            eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), maxDistance: 15,
                            escapeSpell: canTeleport() ? componentId('magic:varrock_teleport') : undefined, log: line => emit({ e: 'fight', line }) });
                        emit({ e: 'flee-end', outcome: e.outcome, hp: me()?.hp });
                        if (e.outcome === 'died') { stats.deaths++; return 'dead'; }
                        const m2 = me();
                        if (m2 && wildLevel(m2.x, m2.z) === 0) return 'flee';
                    }
                    await escape(fight.danger ?? "danger"); return "flee";
                }
                lastDist = Infinity;
                continue;
            }
            // Out of view: run to the cut-off tile, re-aimed on each new roster frame.
            if (session.tick() - contactAt > 400) { emit({ e: 'stall', target: name }); return 'stall'; }
            // A group's pace: while pace() is true (someone is behind) the chase waits a tick for it.
            if (cfg.pace?.()) { await sdk.waitForTicks(1); continue; }
            const aim = track ? intercept(m, track) : { ...pos, ticks: 0 };
            const frame = radar.tick;
            await walkPath(walker, [{ x: aim.x, z: aim.z, tol: 2 }], {
                maxTicks: 40, idleMs: 9000,
                stop: () => stopped() || radar.tick !== frame || !!cfg.pace?.() ||
                    !!sdk.getState()?.nearbyPlayers.some(p => p.name.toLowerCase() === name.toLowerCase() && p.distance <= 15),
            });
        }
        return 'stop';
    };

    try {
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s === 'dead') break;
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (s === 'flee') break;
            const pick = pickNow(m);
            if (!pick) {
                // Nobody attackable: sweep the Wilderness. Start at the nearest sweep tile, then go round.
                // Each hunter starts at its own point of the loop, so several hunters spread over the Wilderness.
                if (leg < 0) leg = sectorStart(session.name, route.length);
                else if (cheb(route[leg], m) <= 4) leg = (leg + 1) % route.length;
                const before = session.tick();
                const walk = await walkPath(walker, [{ ...route[leg], tol: 3 }], { maxTicks: 30, idleMs: 9000, stop: () => stopped() || !!pickNow(me()!) });
                // Never spin: a walk that used no tick (blocked or already there) moves to the next leg and waits.
                if (session.tick() === before) {
                    if (!walk.ok) emit({ e: 'sweep-blocked', leg: route[leg], at: [m.x, m.z], detail: walk.detail });
                    leg = (leg + 1) % route.length; await sdk.waitForTicks(1);
                }
                continue;
            }
            const name = pick.track.name;
            stats.targets.push(name);
            emit({ e: 'target', target: name, combat: pick.track.combatLevel, wild: wildLevel(pick.track.x, pick.track.z), meetIn: Math.round(pick.at.ticks), at: [pick.track.x, pick.track.z] });
            claim(name);
            shareIntel(pick.track);
            const outcome = await chase(name).finally(() => release(chasing));
            emit({ e: 'chase-end', target: chasing, outcome });
            if (outcome === 'dead' || outcome === 'stop') break;
            if (outcome === 'flee') break;
            if (outcome === 'stall' || outcome === 'left') skip.add(chasing.toLowerCase());
            if (needBank() && !(await bank(carried >= bankAt ? 'loot value' : 'pack full'))) break;
        }
        // Bank whatever loot is carried before logging out; with none, just leave the Wilderness.
        const m = me();
        if (m && stats.deaths === 0) {
            // Out of the Wilderness first, whatever ended the hunt (a stop request included).
            if (wildLevel(m.x, m.z) > 0) await escape(stopped() ? 'stop requested' : 'end of hunt');
            if (extraLoot()) await bank('end of hunt');
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
            try { const r = await get(gameDialAddress(`https://${server}/api/market/items/${id}`)); price = r?.referencePrice ?? r?.lastPrice ?? r?.basePrice ?? 0; }
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
export async function lootAt(session: Session, at: { x: number; z: number }, ctx: { value: (id: number) => Promise<number>; min: number; stats: { loot: string[]; lootValue: number }; emit: (e: object) => void }) {
    const { sdk, bot } = session;
    const ground = (sdk.getState()?.groundItems ?? []) as unknown as Ground[];
    const price = new Map<number, number>();
    for (const g of ground) if (cheb(g, at) <= 1 && !price.has(g.id)) price.set(g.id, await ctx.value(g.id));
    let got = 0;
    for (const g of planLoot(ground, at, price, ctx.min)) {
        const definition=(session.client as {objType?:(id:number)=>{stackable:boolean}|undefined}|undefined)?.objType?.(g.id);
        if(typeof definition?.stackable!=='boolean'){ctx.emit({e:'loot-skipped',item:g.name,value:g.value,why:'stackability unknown'});continue;}
        if (!lootCapacity({inventory:sdk.getInventory()},g,definition)) {
            const meal = sdk.getInventory().find(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
            if (!meal || !lootCapacity({inventory:sdk.getInventory().filter(i=>i.slot!==meal.slot)},g,definition)) { ctx.emit({ e: 'loot-skipped', item: g.name, value: g.value, why: 'pack full' }); continue; }
            const before=sdk.getInventory().filter(i=>i.id===meal.id).reduce((n,i)=>n+i.count,0);
            await bot.eatFood(meal);
            if(sdk.getInventory().filter(i=>i.id===meal.id).reduce((n,i)=>n+i.count,0)!==before-1){ctx.emit({e:'loot-skipped',item:g.name,value:g.value,why:'food debit does not reconcile'});break;}
            if(!lootCapacity({inventory:sdk.getInventory()},g,definition)){ctx.emit({e:'loot-skipped',item:g.name,value:g.value,why:'no observed room'});continue;}
        }
        const live = (sdk.getState()?.groundItems ?? []).find((x: any) => x.id === g.id && x.x === g.x && x.z === g.z);
        if (!live || live.count!==g.count || !lootCapacity({inventory:sdk.getInventory()},live,definition)) continue;
        const before=sdk.getInventory().filter(i=>i.id===live.id).reduce((n,i)=>n+i.count,0);
        const r = await bot.pickupItem(live as any);
        if (!r.success) { ctx.emit({ e: 'loot-failed', item: g.name, msg: r.message }); continue; }
        const gained=sdk.getInventory().filter(i=>i.id===live.id).reduce((n,i)=>n+i.count,0)-before;
        if(gained!==live.count){ctx.emit({e:'loot-failed',item:g.name,msg:'pickup quantity does not reconcile'});continue;}
        const value=(price.get(g.id)??0)*gained;
        got += value; ctx.stats.lootValue += value; ctx.stats.loot.push(g.name);
        ctx.emit({ e: 'loot', item: g.name, count: gained, value });
    }
    return got;
}

export const EDGEVILLE_BANK_TILE = { x: 3094, z: 3492 };
// Walks to Edgeville bank, deposits everything that is not kit, takes food back to its staged count. True when banked.
async function bankTrip(session: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, startPack: ReadonlyMap<string, number>, kitKey: (i: { id: number; name: string }) => string,
    foodId: number | undefined, foodCount: number, stopped: () => boolean, emit: (e: object) => void): Promise<boolean> {
    const { sdk, bot } = session;
    const walk = await walkPath(walker, [{ ...EDGEVILLE_BANK_TILE, tol: 3 }], { maxTicks: 900, idleMs: 9000, stop: stopped });
    if (!walk.ok) { emit({ e: 'bank-failed', why: 'walk', detail: walk.detail }); return false; }
    if (!(await bot.openBank()).success) { emit({ e: 'bank-failed', why: 'open' }); return false; }
    // Each item beyond the pack's count at the start goes in the bank.
    const deposited: string[] = [];
    const held = new Map<number, { item: ReturnType<typeof sdk.getInventory>[number]; count: number }>();
    for (const i of sdk.getInventory()) { const h = held.get(i.id); held.set(i.id, { item: h?.item ?? i, count: (h?.count ?? 0) + i.count }); }
    const kitLeft = new Map(startPack);
    for (const w of sdk.getEquipment()) kitLeft.set(kitKey(w), (kitLeft.get(kitKey(w)) ?? 0) - w.count);
    for (const { item, count } of held.values()) {
        const k = kitKey(item), keepN = Math.min(count, kitLeft.get(k) ?? 0);
        kitLeft.set(k, (kitLeft.get(k) ?? 0) - keepN);
        if (count - keepN <= 0) continue;
        const r = await bot.depositItem(item, count - keepN);
        if (r.success) deposited.push(`${item.name} x${count - keepN}`);
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
    if (!name) throw new Error('usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO] [RANGED=regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=20000] [BANK_AT=30000] [MAX_TICKS=n] [FRIENDS=name,name]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('PK stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '30')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'AUTO'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
        lootMin: Number(arg(args, 'LOOT_MIN', '20000')), bankAt: Number(arg(args, 'BANK_AT', '30000')),
        ...(arg(args, 'MAX_TICKS', '') ? { maxTicks: Number(arg(args, 'MAX_TICKS', '')) } : {}),
        // A practice run registers its accounts as owned (tradeguard.ts), so its target is a friend unless FRIENDS names the list.
        ...(args.some(a => a.startsWith('FRIENDS=')) ? { friends: arg(args, 'FRIENDS', '').split(',').filter(Boolean) } : {}),
    };
    // ROAM_PROFILE=<profile of scripts/pk-spar.ts>: that profile's fight options (its reading, prayers, freezes,
    // armour, reserve and crowd rules) for each fight of the hunt; the kit, spec weapon and caps stay the roam's.
    // auto (default): the champion for a maxed account (combat 115 or more), whose fights against a target that
    // defends on the champion went 379 dealt, 360 taken where the roam's own options went 307, 404 (research finding
    // 58); the roam's own options for a lower build (finding 37). none: the roam's own options.
    const session = await openBot(name);
    const roamProfile = arg(args, 'ROAM_PROFILE', 'auto'), combat = session.sdk.getState()?.player?.combatLevel ?? 0;
    const chosen = roamProfile === 'auto' ? (combat >= 115 ? 'champion' : '') : roamProfile === 'none' ? '' : roamProfile;
    if (chosen) {
        const { PROFILES } = await import('./pk-spar');
        const { specBelow: _below, ...profile } = PROFILES[chosen] ?? (() => { throw new Error(`unknown ROAM_PROFILE ${chosen}`); })();
        cfg.fight = { ...cfg.fight, ...profile };
    }
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: session.tick(), ...e }));
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    try { result = await huntOnce(session, cfg, stop, emit); }
    catch (error) { failure = String(error); }
    const ok = !!result && !failure;
    const loggedOut = await settle([session], ok, failure ?? `PK hunt: ${result!.kills} kills, ${result!.deaths} deaths, ${result!.attacks} attacks`);
    console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result, loggedOut }));
    process.exitCode = ok && loggedOut ? 0 : 1;
}

// Restock before a trip: what to buy from the runes held (bank and pack) and the coins held.
// Law runes: GE at most 1,600 gp each (live ask 1,345), up to 10, while under 2 are held: Varrock Teleport is the
// escape. Nature runes for freezes: GE at most 300 gp (ask 250), up to 20. Water runes have no GE sellers; Betty's
// rune shop (scripts/shop-buyer.ts betty) sells them, with a spend cap. 1,000 coins always stay.
export type RestockStep = { kind: 'ge'; item: number; quantity: number; limit: number; owned: number } | { kind: 'shop'; profile: 'betty'; maxSpend: number };
// Food and gear come after the escape runes (GE, live prices): sharks up to 20 at 700 gp (ask 563, 2 million for
// sale); a magic shortbow at 110,000 (ask 96,000) for Ranged 50+ without one; a rune chainbody at 300,000 (ask
// 278,874) for Defence 40+ without rune body armour. Rune scimitars, platebodies, platelegs and kiteshields had no
// sellers. Each gear buy also keeps 20,000 coins for the next restock.
export function restockPlan(held: { law: number; nature: number; water: number; coins: number; magic: number;
    food?: number; sharks?: number; ranged?: number; defence?: number; magicShortbow?: boolean; runeBody?: boolean;
    glory?: boolean; prayerPots?: number; superPots?: boolean; antipoison?: boolean }): RestockStep[] {
    const steps: RestockStep[] = [];
    let coins = held.coins - 1000;
    if (held.law < 2) {
        const quantity = Math.min(10, Math.floor(coins / 1600));
        if (quantity >= 1) { steps.push({ kind: 'ge', item: 563, quantity, limit: 1600, owned: held.law }); coins -= quantity * 1600; }
    }
    // Charged glory (<30 wild emergency escape) prioritized when explicitly tracked as missing.
    if (held.glory === false && coins >= 50_000 + 10_000) {
        steps.push({ kind: 'ge', item: 1712, quantity: 1, limit: 50_000, owned: 0 }); coins -= 50_000;
    }
    // Prayer potions (4-dose) for sustained protection and overhead flick backups.
    if (held.prayerPots !== undefined && held.prayerPots < 2) {
        const quantity = Math.min(4 - held.prayerPots, Math.floor(coins / 3500));
        if (quantity >= 1) { steps.push({ kind: 'ge', item: 2434, quantity, limit: 3500, owned: held.prayerPots }); coins -= quantity * 3500; }
    }
    // Freezes need both nature and water runes: keep the water budget back before buying nature runes.
    const waterShort = held.magic >= 50 && held.water < 10;
    let nature = held.nature;
    if (held.magic >= 50 && held.nature < 8) {
        const quantity = Math.min(20, Math.floor((coins - (waterShort ? 500 : 0)) / 300));
        if (quantity >= 4) { steps.push({ kind: 'ge', item: 561, quantity, limit: 300, owned: held.nature }); coins -= quantity * 300; nature += quantity; }
    }
    // Water alone cannot freeze: buy it only with 4 or more nature runes (Bind needs 2, Entangle 4) held after.
    if (waterShort && nature >= 4 && coins >= 500) { steps.push({ kind: 'shop', profile: 'betty', maxSpend: 500 }); coins -= 500; }
    if (held.food !== undefined && held.food < 15) {
        const quantity = Math.min(20 - held.food, Math.floor(coins / 700));
        // owned is EXPECTED_OWNED for buy-owned-ge-item.ts: the sharks already held, which it tops up from.
        if (quantity >= 5) { steps.push({ kind: 'ge', item: 385, quantity, limit: 700, owned: held.sharks ?? 0 }); coins -= quantity * 700; }
    }
    if (held.superPots === true && coins >= 5000) {
        steps.push({ kind: 'ge', item: 2440, quantity: 1, limit: 2500, owned: 0 }); coins -= 2500;
        steps.push({ kind: 'ge', item: 2436, quantity: 1, limit: 2500, owned: 0 }); coins -= 2500;
    }
    if (held.antipoison === true && coins >= 2500) {
        steps.push({ kind: 'ge', item: 2448, quantity: 1, limit: 2500, owned: 0 }); coins -= 2500;
    }
    if ((held.ranged ?? 1) >= 50 && held.magicShortbow === false && coins >= 110_000 + 20_000) {
        steps.push({ kind: 'ge', item: 861, quantity: 1, limit: 110_000, owned: 0 }); coins -= 110_000;
    }
    if ((held.defence ?? 1) >= 40 && held.runeBody === false && coins >= 300_000 + 20_000) {
        steps.push({ kind: 'ge', item: 1113, quantity: 1, limit: 300_000, owned: 0 }); coins -= 300_000;
    }
    return steps;
}

// Compute restock GE/shop steps directly from combined bank + inventory + equipment stock counts.
export function restockPlanFromStock(stock: readonly { id: number; count: number }[], skills: { magic: number; ranged?: number; defence?: number }, coins: number): RestockStep[] {
    const count = (ids: readonly number[]) => stock.filter(i => ids.includes(i.id)).reduce((n, i) => n + i.count, 0);
    const hasGlory = count([1712, 1710, 1708, 1706]) > 0;
    const prayerPots = count([2434, 139, 141, 143]);
    const sharks = count([385]);
    return restockPlan({
        law: count([563]), nature: count([561]), water: count([555]), coins,
        magic: skills.magic, ranged: skills.ranged, defence: skills.defence,
        food: sharks, sharks, glory: hasGlory, prayerPots,
    });
}
