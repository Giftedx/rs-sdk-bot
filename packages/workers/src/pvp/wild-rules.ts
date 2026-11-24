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
import { join } from 'node:path';
import { openBot, serverFromEnv, settle } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { assertSideOwns } from '../../../core/src/fleet';
import { ensureCredential } from '../../../core/src/fleet-vault';
import { lootCapacity } from '../../../core/src/loot-policy';
import { isLocalServer } from '../../../core/src/localserver';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { RosterFeed } from '../../../core/src/roster-feed';
import { gameDialAddress } from '../../../core/src/websocket-proxy';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { tradePartners } from '../../../core/src/tradeguard';
import { readOpponent, readOpponents } from '../../../core/src/opponent';
import { componentId } from '../../../core/src/logout';
import { MARKET_FILE, marketQuotes } from '../../../core/src/market-cache';
import { bestFood, castableFreeze, dangerReason, defaultSpec, estMaxHit, fightPlayer, freezeSpell, getObjNames, isMulti, observePlayer, packGain, recordKillLoot } from './fight';
export { castableFreeze, freezeSpell };
import { armourDefence } from './pk-read';
import { REPO_ROOT, type FightOptions, type Kit } from './types';

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

export const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
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

export function readScoutIntel(file = join(REPO_ROOT, '.practice', 'pk-roam', 'intel.json'), now = Date.now()): ScoutIntel[] {
    try {
        const rows = JSON.parse(readFileSync(file, 'utf8')) as ScoutIntel[];
        return Array.isArray(rows) ? rows.filter(r => now - r.at <= SCOUT_INTEL_TTL_MS) : [];
    } catch { return []; }
}

export function publishScoutIntel(entry: ScoutIntel, file = join(REPO_ROOT, '.practice', 'pk-roam', 'intel.json')): void {
    try {
        const fresh = readScoutIntel(file, entry.at).filter(r => r.target.toLowerCase() !== entry.target.toLowerCase());
        fresh.push(entry);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(fresh));
    } catch { /* scout handoff is best-effort */ }
}

export function clearScoutIntel(target: string, file = join(REPO_ROOT, '.practice', 'pk-roam', 'intel.json'), now = Date.now()): void {
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

const ESCAPE_LEVER = WILDERNESS_ESCAPES.find(e => e.id === 1815)!;
const MAGE_BANK_LADDER = WILDERNESS_ESCAPES.find(e => e.id === 2871)!;
const MAGE_BANK_EAST_WEB = WILDERNESS_ESCAPES.find(w => w.id === 733 && w.x === 3095 && w.z === 3957);
const ESCAPE_OBSTACLES = WILDERNESS_ESCAPES.filter(e => e.kind === 'gate' || e.kind === 'web');

// Choose the fastest rev-289 escape route from current coordinates: glory <=30, teleport <=20, nearby lever/safe ladder, else run south.
export function planWildernessEscape(pos: { x: number; z: number }, has: { glory: boolean; teleport: boolean }): WildernessEscapePlan {
    const level = wildLevel(pos.x, pos.z);
    if (level === 0) return { kind: 'out', distance: 0, detail: 'outside Wilderness' };
    if (has.glory && level <= 30) return { kind: 'glory', distance: 0, detail: `glory at level ${level}` };
    if (has.teleport && level <= 20) return { kind: 'teleport', distance: 0, detail: `teleport at level ${level}` };

    const targetZ = has.glory ? 3755 : has.teleport ? 3675 : 3518;
    const southDist = Math.max(0, pos.z - targetZ);
    const leverDist = cheb(pos, ESCAPE_LEVER);
    const ladderDist = cheb(pos, MAGE_BANK_LADDER);
    const bestLoc = leverDist <= ladderDist ? ESCAPE_LEVER : MAGE_BANK_LADDER;
    const bestDist = leverDist <= ladderDist ? leverDist : ladderDist;
    if (bestDist <= 35 && bestDist < southDist) {
        const web = bestLoc.id === 2871 && pos.x >= 3093 ? MAGE_BANK_EAST_WEB : undefined;
        return { kind: bestLoc.kind as 'lever' | 'ladder', loc: bestLoc, web, distance: bestDist, detail: `${bestLoc.name} (${bestDist} tiles)` };
    }
    let obstacle: WildernessEscapeLoc | undefined;
    for (let i = 0; i < ESCAPE_OBSTACLES.length; i++) {
        const e = ESCAPE_OBSTACLES[i]!;
        if (Math.abs(e.x - pos.x) <= 6 && e.z <= pos.z && pos.z - e.z <= 20) {
            obstacle = e;
            break;
        }
    }
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
    const wild = wildLevel(me.x, me.z);
    const multi = wild > 0 && multiAt(me.x, me.z);
    let hostilesCount = 0;
    let outclassedBy: (typeof nearby)[number] | undefined;
    let pjWaiters = 0;
    let pileCount = 0;
    let pileName0 = '';
    let pileName1 = '';
    let pileName2 = '';
    for (let i = 0; i < nearby.length; i++) {
        const p = nearby[i]!;
        if (p.distance > 12 || friends.has(p.name.toLowerCase())) continue;
        if (!canAttack({ x: me.x, z: me.z, combat: me.combat }, { x: p.x ?? me.x, z: p.z ?? me.z, combatLevel: p.combatLevel })) continue;
        hostilesCount++;
        if (!outclassedBy && outclasses({ combat: me.combat, weaponValue: me.weaponValue }, { combatLevel: p.combatLevel, weapon: p.wornWeapon })) {
            outclassedBy = p;
        }
        if (p.distance <= 8) {
            if (!p.inCombat) pjWaiters++;
            if (multi) {
                if (pileCount === 0) pileName0 = p.name;
                else if (pileCount === 1) pileName1 = p.name;
                else if (pileCount === 2) pileName2 = p.name;
                pileCount++;
            }
        }
    }
    const multiPile = multi && pileCount >= PILE_SIZE
        ? `multi pile: ${pileCount} attackable enemies (${pileCount === 2 ? `${pileName0}, ${pileName1}` : `${pileName0}, ${pileName1}, ${pileName2}`}) within 8 tiles`
        : null;
    const escapePlan = planWildernessEscape(me, { glory: me.glory, teleport: me.teleport });
    const pjUnsafe = !multi && hostilesCount >= 2 && pjWaiters >= 1 && me.foodCount <= 4;
    const retreatReason = outclassedBy ? `threat: ${outclassedBy.name} (combat ${outclassedBy.combatLevel}) at ${outclassedBy.distance} tiles`
        : multiPile ? multiPile
        : pjUnsafe ? `pj risk: ${hostilesCount} attackable hostiles (${pjWaiters} idle) with ${me.foodCount} food`
        : null;
    return { multi, hostilesCount, outclassedBy, multiPile, pjWaiters, escapePlan, retreatReason };
}

const AIR_STAFF = /staff of air|air battlestaff|mystic air staff/i;
const FIRE_STAFF = /staff of fire|fire battlestaff|mystic fire staff/i;
const LAW_RUNE_RE = /^law rune$/i;
const AIR_RUNE_RE = /^air rune$/i;
const FIRE_RUNE_RE = /^fire rune$/i;

// Magic 25 Varrock Teleport runes: 1 law rune, 3 air runes (or air staff), 1 fire rune (or fire staff).
export function hasVarrockTeleport(magic: number, inventory: readonly { name: string; count?: number }[], equipment: readonly { name: string }[]): boolean {
    if (magic < 25) return false;
    let laws = 0;
    let airs = 0;
    let fires = 0;
    for (let i = 0; i < inventory.length; i++) {
        const item = inventory[i]!;
        const c = item.count ?? 1;
        if (LAW_RUNE_RE.test(item.name)) laws += c;
        else if (AIR_RUNE_RE.test(item.name)) airs += c;
        else if (FIRE_RUNE_RE.test(item.name)) fires += c;
    }
    if (laws < 1) return false;
    let hasAirStaff = airs >= 3;
    let hasFireStaff = fires >= 1;
    if (hasAirStaff && hasFireStaff) return true;
    for (let i = 0; i < equipment.length; i++) {
        const name = equipment[i]!.name;
        if (!hasAirStaff && AIR_STAFF.test(name)) hasAirStaff = true;
        if (!hasFireStaff && FIRE_STAFF.test(name)) hasFireStaff = true;
        if (hasAirStaff && hasFireStaff) return true;
    }
    return false;
}

// In multi-way combat, PILE_SIZE or more attackable strangers within 8 tiles can focus and stack out a solo roamer.
export function multiPileThreat(me: { x: number; z: number; combat: number }, nearby: readonly { name: string; x?: number; z?: number; combatLevel: number; distance: number }[],
    friends: ReadonlySet<string>, multiAt: (x: number, z: number) => boolean = isMulti, pileSize = PILE_SIZE): string | null {
    if (wildLevel(me.x, me.z) === 0 || !multiAt(me.x, me.z)) return null;
    let count = 0;
    const sample: string[] = [];
    for (let i = 0; i < nearby.length; i++) {
        const p = nearby[i]!;
        if (p.distance <= 8 && !friends.has(p.name.toLowerCase()) && canAttack(me, { x: p.x ?? me.x, z: p.z ?? me.z, combatLevel: p.combatLevel })) {
            count++;
            if (sample.length < 3) sample.push(p.name);
        }
    }
    return count >= pileSize ? `multi pile: ${count} attackable enemies (${sample.join(', ')}) within 8 tiles` : null;
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
        let pile = 0;
        for (let oIdx = 0; oIdx < tracks.length; oIdx++) {
            const o = tracks[oIdx]!;
            if (o !== t && !friends.has(o.name.toLowerCase()) && cheb(o, t) <= 6 && canAttack({ x: t.x, z: t.z, combat: me.combat }, o)) {
                pile++;
                if (pile >= PILE_SIZE) break;
            }
        }
        if (pile >= PILE_SIZE) continue;
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
        const nextPrev = new Map<string, { x: number; z: number; k: number }>();
        const k = m.k;
        for (let i = 0; i < m.p.length; i++) {
            const [, name, x, z, plane, combatLevel] = m.p[i]!;
            if (plane !== 0 || typeof name !== 'string') continue;
            const key = name.toLowerCase(), old = this.prev.get(key), dt = old ? k - old.k : 0;
            next.set(key, { name, x, z, combatLevel, vx: dt > 0 ? (x - old!.x) / dt : 0, vz: dt > 0 ? (z - old!.z) / dt : 0 });
            nextPrev.set(key, { x, z, k });
        }
        this.prev = nextPrev;
        this.tracks = next;
        this.tick = k;
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
    // The threat radar (scripts/pk-threat.ts, the THREAT=1 argument): a protect prayer for the style of a threat, the armour swap of the pack, and an escape
    // when a player outclasses us or a team comes. threatAct false only logs and records.
    threat?: boolean; threatAct?: boolean;
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
    // PK_AXE=1: a rune throwing axe stack among the items is part of the ranged kit, so `defaultSpec` (scripts/pk.ts) gives
    // the account the axe special. Off by default: no live account changes its special.
    const axe = process.env.PK_AXE === '1' ? [...worn, ...carried].find(i => /^rune thrownaxe$/i.test(i.name)) : undefined;
    if (bow || axe) kit.ranged = [...(bow ? [bow.id] : []), ...(axe ? [axe.id] : [])];
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
export function accountServer(name: string, root = REPO_ROOT): string {
    return serverFromEnv(readFileSync(resolveBotEnvPath(name, root), 'utf8'));
}

// The account's server for a check that runs before openBot (the death ledger). A bot.env that this machine lacks comes from the
// fleet vault the way openBot restores it: after the side check, before the read. A bot.env that stays unreadable throws.
export function accountServerBeforeLogin(name: string, deps: { assertOwn: (n: string) => void; restore: (n: string) => void; read: (n: string) => string } = { assertOwn: assertSideOwns, restore: ensureCredential, read: n => accountServer(n) }): string {
    deps.assertOwn(name);
    deps.restore(name);
    return deps.read(name);
}

// Item value in gp: the live market (referencePrice, else lastPrice, else basePrice), cached per item; with no market
// (a practice server or a failed request) the item cost in knowledge/items.json. Coins are 1 gp each.
const costsByRoot = new Map<string, Map<number, number>>();
export function itemCost(id: number, root = REPO_ROOT): number {
    let costs = costsByRoot.get(root);
    if (!costs) {
        const rows = JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[];
        costs = new Map<number, number>();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            costs.set(row.id, row.cost ?? 0);
        }
        costsByRoot.set(root, costs);
    }
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
    const out: (Ground & { value: number })[] = [];
    for (let i = 0; i < ground.length; i++) {
        const g = ground[i]!;
        if (cheb(g, at) > 1) continue;
        const value = (price.get(g.id) ?? 0) * g.count;
        if (value >= min) out.push({ ...g, value });
    }
    out.sort((a, b) => b.value - a.value);
    return out;
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
export async function bankTrip(session: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, startPack: ReadonlyMap<string, number>, kitKey: (i: { id: number; name: string }) => string,
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

// Restock before a trip: what to buy from the runes held (bank and pack), the coins held and the observed market.
// A price is never a fixed number. The limit of a buy is the lowest ask of the market cache plus RESTOCK_MARGIN_PERCENT
// (scripts/market-cache.ts, at most 30 minutes old): a thin book can move a little between the snapshot and the order.
// A limit above the ask costs nothing extra: an order fills at the asks that it meets, and the unused escrow returns.
// An item with no ask, or with fewer units offered than a step needs, has no step. An offer with no seller waits and
// holds its escrow, and the escrow of an order is its quantity times its limit, so the plan counts each step at its limit.
// Water runes have no GE sellers: Betty's rune shop (scripts/shop-buyer.ts betty) sells them, with a spend cap.
// 1,000 coins always stay.
export type RestockStep = { kind: 'ge'; item: number; quantity: number; limit: number; owned: number } | { kind: 'shop'; profile: 'betty'; maxSpend: number };
// `ask`: the lowest price asked, or null; `sell`: the units offered at any price (scripts/market-cache.ts MarketQuote).
export type RestockQuote = { ask: number | null; sell: number };
export type RestockMarket = Readonly<Record<number, RestockQuote>>;
export const RESTOCK_MARGIN_PERCENT = 10;
// What a gear or glory buy leaves in the bank for the next restock.
export const GLORY_RESERVE = 10_000;
export const GEAR_RESERVE = 20_000;
export const restockLimit = (market: RestockMarket, item: number): number | null => {
    const quote = market[item];
    return quote && quote.ask !== null && quote.ask > 0 && quote.sell >= 1 ? Math.ceil(quote.ask * (100 + RESTOCK_MARGIN_PERCENT) / 100) : null;
};
// The market for a plan: the fresh quotes of the market cache, or nothing when the file is missing or old. With nothing,
// a plan has no GE step.
export function restockMarket(root = REPO_ROOT, now = Date.now()): { market: RestockMarket; at: number | null } {
    let raw: any; try { raw = JSON.parse(readFileSync(join(root, MARKET_FILE), 'utf8')); } catch { return { market: {}, at: null }; }
    const market = marketQuotes(raw, now);
    return { market, at: Object.keys(market).length ? raw.at : null };
}
export function restockPlan(held: { law: number; nature: number; water: number; coins: number; magic: number;
    food?: number; sharks?: number; ranged?: number; defence?: number; magicShortbow?: boolean; runeBody?: boolean;
    glory?: boolean; prayerPots?: number; superPots?: boolean; antipoison?: boolean }, market: RestockMarket): RestockStep[] {
    const steps: RestockStep[] = [];
    let coins = held.coins - 1000;
    // Buys up to `want` of an item with the coins above `keep`, when at least `least` units fit. It returns the units bought.
    const buy = (item: number, want: number, least: number, owned: number, keep = 0): number => {
        const limit = restockLimit(market, item);
        if (limit === null) return 0;
        const quantity = Math.min(want, Math.floor((coins - keep) / limit), market[item]!.sell);
        if (quantity < least) return 0;
        steps.push({ kind: 'ge', item, quantity, limit, owned });
        coins -= quantity * limit;
        return quantity;
    };
    // Law runes: Varrock Teleport is the escape, so up to 10 while under 2 are held.
    if (held.law < 2) buy(563, 10, 1, held.law);
    // Charged glory (<30 wild emergency escape) prioritized when explicitly tracked as missing.
    if (held.glory === false) buy(1712, 1, 1, 0, GLORY_RESERVE);
    // Prayer potions (4-dose) for sustained protection and overhead flick backups.
    if (held.prayerPots !== undefined && held.prayerPots < 2) buy(2434, 4 - held.prayerPots, 1, held.prayerPots);
    // Freezes need both nature and water runes: keep the water budget back before buying nature runes.
    const waterShort = held.magic >= 50 && held.water < 10;
    let nature = held.nature;
    if (held.magic >= 50 && held.nature < 8) nature += buy(561, 20, 4, held.nature, waterShort ? 500 : 0);
    // Water alone cannot freeze: buy it only with 4 or more nature runes (Bind needs 2, Entangle 4) held after.
    if (waterShort && nature >= 4 && coins >= 500) { steps.push({ kind: 'shop', profile: 'betty', maxSpend: 500 }); coins -= 500; }
    // Sharks up to 20. `owned` is EXPECTED_OWNED for buy-owned-ge-item.ts: the sharks already held, which it tops up from.
    if (held.food !== undefined && held.food < 15) buy(385, 20 - held.food, 5, held.sharks ?? 0);
    if (held.superPots === true) { buy(2440, 1, 1, 0); buy(2436, 1, 1, 0); }
    // The super antipoison first, then the plain one: the first with a seller.
    if (held.antipoison === true) for (const item of [2448, 2446]) if (buy(item, 1, 1, 0) > 0) break;
    if ((held.ranged ?? 1) >= 50 && held.magicShortbow === false) buy(861, 1, 1, 0, GEAR_RESERVE);
    if ((held.defence ?? 1) >= 40 && held.runeBody === false) buy(1113, 1, 1, 0, GEAR_RESERVE);
    return steps;
}

// Compute restock GE/shop steps directly from combined bank + inventory + equipment stock counts.
export function restockPlanFromStock(stock: readonly { id: number; count: number }[], skills: { magic: number; ranged?: number; defence?: number }, coins: number, market: RestockMarket): RestockStep[] {
    let hasGlory = false;
    let prayerPots = 0;
    let sharks = 0;
    let law = 0;
    let nature = 0;
    let water = 0;
    for (let i = 0; i < stock.length; i++) {
        const row = stock[i]!;
        switch (row.id) {
            case 1712:
            case 1710:
            case 1708:
            case 1706:
                if (row.count > 0) hasGlory = true;
                break;
            case 2434:
            case 139:
            case 141:
            case 143:
                prayerPots += row.count;
                break;
            case 385:
                sharks += row.count;
                break;
            case 563:
                law += row.count;
                break;
            case 561:
                nature += row.count;
                break;
            case 555:
                water += row.count;
                break;
        }
    }
    return restockPlan({
        law, nature, water, coins,
        magic: skills.magic, ranged: skills.ranged, defence: skills.defence,
        food: sharks, sharks, glory: hasGlory, prayerPots,
    }, market);
}
