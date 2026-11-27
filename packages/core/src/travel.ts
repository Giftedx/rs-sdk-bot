// Travel the route search can use besides walking, ladders and stairs: NPC boats, gliders, carts and tolls
// (knowledge/npc-travel.json), teleports by spell, jewellery, lever and spirit tree (knowledge/teleports.json), and
// agility shortcuts and passages (knowledge/shortcuts.json), and the exit portals of pockets with several landings
// (pocketExitTravel).
// Each edge says what the account needs (coins, quest stages, skills, runes, items held or worn) and how the
// walker runs it. Left out: Entrana boats (no weapon or armour may be carried), moves into the Wilderness (except
// the chaos altar exit, the only way out of that pocket), jails and random-tile teleports (the wizards' teleports
// into the essence mine), runecraft ruins; shortcuts with a failure roll (a
// fall hurts a low-level account), a use-item, a first step (via) or a held-item check. The river log
// (RIVER_LOG_TRAVEL) has a failure roll and is in: its slip still crosses, for 6% of hitpoints.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomicFile } from './atomic-file';
import type { Account, Tile } from './world-types';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');

export type TravelNeed =
    | { varp: string; op: string; value: number }
    | { skill: string; level: number }
    | { held: string; count: number }            // item debugname held in the pack
    | { worn: string };
export type TravelRun =
    // npcId: the config id. Two NPCs can share a name across a fence (borderguard1 925 and borderguard2 926 are both
    // "Border Guard", one tile apart on the two sides of the Al Kharid toll gate).
    | { how: 'npc'; npc: string; npcId?: number; op: number; options: string[]; deck?: boolean; button?: { component: string } }
    | { how: 'spell'; component: string }
    | { how: 'rub'; items: string[]; option: string | null }
    // unlisted: the state's loc list never shows this loc, so the walker sends the op by id and tile.
    | { how: 'loc'; loc: string; op: number; option: string | null; id?: number; at?: Tile; unlisted?: true }
    | { how: 'gate'; loc: string; action: string; at: Tile; choices: string[] };
export interface Travel {
    id: string; kind: string; name: string;
    from: Tile | null;                   // null: from anywhere outside the Wilderness
    to: Tile;                            // where the player stands after it, on the ground
    slips?: Tile[];                      // exact tiles a failed Agility roll ends on, on the far side of the crossing
    slipDamage?: { percent: number; plus: number }; // a slip deals floor(current hitpoints * percent / 100) + plus
    // Other tiles the edge can end on: the server picks one by a state the client does not see (the essence mine
    // exit by the wizard who sent the player in) or at random (the chaos altar exit). A walk that lands on one of
    // these is planned again from there.
    lands?: Tile[];
    coins: number;                       // coins the account must hold
    needs: TravelNeed[];
    runes: { item: string; count: number }[];
    run: TravelRun;
    cost: number;                        // estimate in ticks
}

// The river log east of Tai Bwo Wannai (zq_logbalance 2332, skill_agility/scripts/shortcuts.rs2:49-95) joins the
// jungle east of the river (the Karamja shipyard side) to the land west of it. From the tile next to the log the
// player moves 2 + 2 tiles across on level 0; the shortcuts.json rows say the same, but shortcutTravel skips them for
// their failure roll. A failed roll washes the player to $fail_end_coord on the far bank, never back, for
// floor(hitpoints * 6 / 100) + 1 damage (stat(hitpoints) is the current level): 1 hitpoint dies. The client scene
// keeps the log on level 1 under the bridge flag, so the state's loc list never shows it (quest-tbwt-owned.ts
// trioLogLoc).
const riverLog = (from: Tile, at: Tile, to: Tile, slip: Tile): Travel => ({
    id: `loc:zq_logbalance@${at.x},${at.z},${at.level}>${to.x},${to.z}`, kind: 'shortcut', name: 'zq_logbalance op1',
    from, to, slips: [slip], slipDamage: { percent: 6, plus: 1 }, coins: 0, needs: [], runes: [],
    run: { how: 'loc', loc: 'zq_logbalance', op: 1, option: null, id: 2332, at, unlisted: true }, cost: 8,
});
const ground = (x: number, z: number): Tile => ({ x, z, level: 0 });
export const RIVER_LOG_TRAVEL: readonly Travel[] = [
    riverLog(ground(2910, 3049), ground(2909, 3049), ground(2906, 3049), ground(2903, 3057)),
    riverLog(ground(2906, 3049), ground(2907, 3049), ground(2910, 3049), ground(2909, 3059)),
];

const TELEPORT_COST = 5, NPC_COST = 15, BOAT_COST = 40;

// The ground tile the gangplank's disembark puts the player on (general_use/scripts/gangplank.rs2): two tiles
// from the plank, away from the ship, one level down. Map lines read "level x z: id shape angle".
export function landing(plank: { x: number; z: number; level: number }, angle: number): Tile {
    const dir = angle === 0 || angle === 1 ? 1 : -1;
    return angle === 0 || angle === 2 ? { x: plank.x - 2 * dir, z: plank.z, level: plank.level - 1 } : { x: plank.x, z: plank.z + 2 * dir, level: plank.level - 1 };
}
function mapLine(src: string): string[] | null {
    const m = src.match(/^(.*):(\d+)$/);
    if (!m) return null;
    try { return readFileSync(join(content, m[1]!), 'utf8').split(/\r?\n/)[Number(m[2]) - 1]!.trim().split(/\s+/); } catch { return null; }
}
function mapAngle(src: string): number | null {
    const f = mapLine(src);
    return f ? Number(f[5]) : null;
}
// The loc id of a map line ("level x z: id shape angle").
export function mapLocId(src: string): number | null {
    const id = Number(mapLine(src)?.[3]);
    return Number.isInteger(id) && id > 0 ? id : null;
}

type NpcRecord = { id: string; kind: string; destination: string; npc: { name: string; debugname: string; id?: number }; op: { index: number }; options: { text: string }[]; button?: { component: string; src?: string };
    from: (Tile & { src: string })[]; to: (Tile & { src: string }) | null; fare?: { coins: number | null; rule?: string }; items?: { item: string; use: string }[];
    requires: { varp: string; op: string; value: number }[]; deck?: { onDeck: boolean; gangplank?: Tile & { src: string } } };
export function npcTravel(records: NpcRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const r of records) {
        if (!r.to || /entrana|jail/i.test(`${r.id} ${r.destination}`)) continue;
        if (r.items?.some(i => i.use === 'forbidden')) continue;
        let to: Tile = { x: r.to.x, z: r.to.z, level: r.to.level }, deck = false;
        if (r.deck?.onDeck) {
            const g = r.deck.gangplank, angle = g ? mapAngle(g.src) : null;
            if (!g || angle === null) continue;
            to = landing(g, angle); deck = true;
        }
        const held = (r.items ?? []).filter(i => i.use === 'consumed' && /^[a-z0-9_]+$/.test(i.item)).map(i => ({ held: i.item, count: 1 }));
        // A fare given only as a rule costs 200 coins, unless a consumed item (a pass or a ticket) is the fare.
        const coins = r.fare?.coins ?? (r.fare?.rule && !held.length ? 200 : 0);
        for (const f of r.from) out.push({
            id: `npc:${r.id}@${f.x},${f.z}`, kind: r.kind, name: `${r.npc.name} to ${r.destination}`, from: { x: f.x, z: f.z, level: f.level }, to, coins,
            needs: [...r.requires.map(q => ({ varp: q.varp, op: q.op, value: q.value })), ...held], runes: [],
            run: { how: 'npc', npc: r.npc.name, ...(Number.isInteger(r.npc.id) ? { npcId: r.npc.id } : {}), op: r.op.index, options: r.options.map(o => o.text), ...(r.button ? { button: { component: r.button.component } } : {}), ...(deck ? { deck } : {}) },
            cost: r.kind === 'boat' ? BOAT_COST : NPC_COST,
        });
    }
    return out;
}

type TeleRecord = { id: string; kind: string; name: string; trigger: string; from: (Tile & { wilderness?: number; src?: string })[] | null;
    requires: { type: string; skill?: string; level?: number; varp?: string; op?: string; value?: number; item?: string }[];
    runes?: { item: string; count: number }[]; charges?: { item: string }[];
    to: { option: string | null; candidates: (Tile & { wilderness?: number })[]; maxRadius?: number }[] };
export function teleportTravel(records: TeleRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const r of records) {
        if (!['spell', 'jewellery', 'lever', 'spirit_tree', 'loc'].includes(r.kind)) continue;
        const needs: TravelNeed[] = [];
        for (const q of r.requires) {
            if (q.type === 'skill' && q.skill && q.level !== undefined) needs.push({ skill: q.skill, level: q.level });
            else if (q.type === 'varp' && q.varp && q.op && q.value !== undefined) needs.push({ varp: q.varp, op: q.op, value: q.value });
            else if (q.type === 'worn' && q.item) needs.push({ worn: q.item });
            else if (q.type === 'held' && q.item) needs.push({ held: q.item, count: 1 });
        }
        const op = Number(r.trigger.match(/^\[op(?:loc|npc)(\d)/)?.[1] ?? 1), loc = r.trigger.match(/^\[oploc\d,([a-z0-9_]+)\]/)?.[1];
        for (const d of r.to) {
            if (d.candidates.length !== 1 || (d.candidates[0]!.wilderness ?? 0) > 0) continue;
            const c = d.candidates[0]!, to = { x: c.x, z: c.z, level: c.level };
            const run: TravelRun | null = r.kind === 'spell' ? { how: 'spell', component: r.trigger.match(/\[if_button,([a-z0-9_:]+)\]/)?.[1] ?? '' }
                : r.kind === 'jewellery' ? { how: 'rub', items: (r.charges ?? []).map(c => c.item), option: d.option }
                : loc ? { how: 'loc', loc, op, option: d.option } : null;
            if (!run || (run.how === 'spell' && !run.component) || (run.how === 'rub' && !run.items.length)) continue;
            const froms = r.from?.filter(f => (f.wilderness ?? 0) === 0) ?? [null];
            for (const f of froms) out.push({
                id: `${r.id}:${d.option ?? 'to'}${f ? `@${f.x},${f.z}` : ''}`, kind: r.kind, name: d.option ? `${r.name}: ${d.option}` : r.name,
                from: f ? { x: f.x, z: f.z, level: f.level } : null, to, coins: 0, needs, runes: r.runes ?? [], run,
                cost: r.kind === 'spirit_tree' ? NPC_COST : TELEPORT_COST,
            });
        }
    }
    return out;
}

// The exit portals of closed pockets whose landing the client cannot know: teleports.json runecraft_portal rows with
// more than one landing tile. The essence mine portal (essence_mine.rs2:28-42) sends the player back to the wizard
// who sent it in (%exit_essence_mine_coord, a server varp the client never gets), and the chaos altar portal
// (runecraft.rs2:1-9) to a random one of 9 exit_coord rows. shortcuts.json leaves both out ("destination not
// resolved"), so no route left the essence mine (live: Woodpecker at 2924,4848, "no route" to Edgeville and Catherby).
// Each portal gets one edge for each landing, and each edge lists the other landings in `lands`. Exit portals with one
// landing are shortcuts.json passage rows already.
export function pocketExitTravel(records: TeleRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const r of records) {
        if (r.kind !== 'runecraft_portal') continue;
        const tiles = new Map<string, Tile>();
        for (const d of r.to) for (const c of d.candidates) tiles.set(`${c.x},${c.z},${c.level}`, { x: c.x, z: c.z, level: c.level });
        if (tiles.size < 2) continue;
        const loc = r.id.slice(r.id.indexOf(':') + 1), op = Number(r.trigger.match(/^\[oploc(\d)/)?.[1] ?? 1), lands = [...tiles.values()];
        for (const f of r.from ?? []) {
            const id = f.src ? mapLocId(f.src) : null;
            if (id === null) continue;
            const at = { x: f.x, z: f.z, level: f.level };
            for (const to of lands) out.push({
                id: `${r.id}@${f.x},${f.z},${f.level}>${to.x},${to.z},${to.level}`, kind: 'pocket_exit', name: `${r.name} to ${to.x},${to.z}`,
                from: at, to, lands: lands.filter(t => t !== to), coins: 0, needs: [], runes: [],
                run: { how: 'loc', loc, op, option: null, id, at, unlisted: true }, cost: TELEPORT_COST,
            });
        }
    }
    return out;
}

type ShortcutRecord = { kind: string; locName: string; id: number; option: string; from: Tile; starts?: Tile[]; to: Tile; exact: boolean; bridged?: true; via?: unknown; failure?: unknown; side?: string[];
    requires?: { skills?: { name: string; level: number }[]; varps?: { varp: string; op: string; value: number }[]; items?: unknown[]; useItem?: unknown; coins?: number | null } };
// A row without starts (no standable tile reaches the loc in the collision export) is recorded from the loc tile. A
// sided passage of that kind has one landing per side. Each landing's edge starts at the mirror of the landing through
// the loc tile, on the other side; the world snaps that start to the nearest floor.
export function passageStart(e: { from: Tile; to: Tile; side?: string[] }): Tile {
    return e.side?.length && e.from.level === e.to.level ? { x: 2 * e.from.x - e.to.x, z: 2 * e.from.z - e.to.z, level: e.from.level } : e.from;
}
// Locs in quest scripts that the server crosses with no quest check. Other 'quest' rows include traps and wrong portals.
const UNGATED_QUEST_PASSAGES = new Set(['gertrudefence']);
export function shortcutTravel(edges: ShortcutRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const e of edges) {
        if ((e.kind !== 'shortcut' && e.kind !== 'passage' && !(e.kind === 'quest' && UNGATED_QUEST_PASSAGES.has(e.locName))) || e.via || e.failure || e.requires?.useItem || e.requires?.items?.length) continue;
        if (e.from.level !== e.to.level && Math.abs(e.from.level - e.to.level) > 3) continue;
        const op = Number(e.option.match(/^op(\d)$/)?.[1]);
        if (!op) continue;
        const id = `loc:${e.locName}@${e.from.x},${e.from.z},${e.from.level}>${e.to.x},${e.to.z}`;
        // One edge for each tile the player can operate the loc from (shortcuts.json starts).
        for (const from of e.starts ?? [passageStart(e)]) out.push({
            id: e.starts ? `${id}<${from.x},${from.z}` : id, kind: e.kind, name: `${e.locName} ${e.option}`,
            from, to: e.to, coins: e.requires?.coins ?? 0,
            needs: [...(e.requires?.skills ?? []).map(k => ({ skill: k.name, level: k.level })), ...(e.requires?.varps ?? []).map(v => ({ varp: v.varp, op: v.op, value: v.value }))],
            runes: [], run: { how: 'loc', loc: e.locName, op, option: null, id: e.id, at: e.from, ...(e.bridged ? { unlisted: true as const } : {}) },
            cost: Math.max(Math.abs(from.x - e.to.x), Math.abs(from.z - e.to.z)) + 3,
        });
    }
    return out;
}

// Scripted gates (knowledge/special-crossings.json, from rs2b0t). The route search sees such a gate as a wall, so
// each becomes two edges between the walkable tiles nearest the gate on its two sides: tiles within 3 of the
// gate that lie in different connected areas (components.ts). A gate with one area or more than two is skipped.
type CrossingRecord = { x: number; z: number; level: number; locName: string; action: string; choices: string[]; coins: number;
    item?: { item: string; count: number }; skill?: { name: string; level: number }; label: string; questWaives?: string };
export function crossingTravel(records: CrossingRecord[], areaOf: (t: Tile) => number): Travel[] {
    const out: Travel[] = [];
    for (const c of records) {
        if (c.item) continue;
        const at = { x: c.x, z: c.z, level: c.level }, sides = new Map<number, Tile>();
        for (let r = 1; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const t = { x: c.x + dx, z: c.z + dz, level: c.level }, a = areaOf(t);
            if (a >= 0 && !sides.has(a)) sides.set(a, t);
        }
        if (sides.size !== 2) continue;
        const [a, b] = [...sides.values()];
        for (const [from, to] of [[a!, b!], [b!, a!]]) out.push({
            id: `gate:${c.label}@${c.x},${c.z}:${from.x},${from.z}`, kind: 'gate', name: c.label, from, to, coins: c.coins,
            needs: c.skill ? [{ skill: c.skill.name.toLowerCase(), level: c.skill.level }] : [], runes: [],
            run: { how: 'gate', loc: c.locName, action: c.action, at, choices: c.choices }, cost: 8,
        });
    }
    return out;
}
let crossings: CrossingRecord[] | undefined;
export function loadCrossings(): CrossingRecord[] {
    return crossings ??= (JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'special-crossings.json'), 'utf8')) as { crossings: CrossingRecord[] }).crossings;
}

// A paid crossing: a scripted gate that takes coins in its dialogue and needs no item (the Al Kharid toll gate,
// border_gate.rs2: 10 coins, free with Prince Ali Rescue). The rs-sdk pathfinder unmasks such a gate as a door
// (collision-data.json lists 3268,3227 and 3268,3228), and knowledge/doors.json gives it kind 'unknown', which
// blocks it for every account. A walk crosses it when the account holds the fare and answers its choices.
export type FareCrossing = Tile & { coins: number; choices: readonly string[]; label: string; waived: boolean };
export function fareCrossings(records: readonly CrossingRecord[] = loadCrossings()): FareCrossing[] {
    return records.filter(c => c.coins > 0 && !c.item && !c.skill && c.choices.length > 0)
        .map(c => ({ x: c.x, z: c.z, level: c.level, coins: c.coins, choices: c.choices, label: c.label, waived: !!c.questWaives }));
}
export const fareCrossingAt = (level: number, at: { x: number; z: number }, list: readonly FareCrossing[] = fareCrossings()): FareCrossing | undefined =>
    list.find(c => c.level === level && c.x === at.x && c.z === at.z);

// The stamps cover the data files only: change this name when a builder above changes its output.
const TRAVEL_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'travel-v4.json');
type TravelCache = { v: 1; stamps: [string, string][]; staffs: { rune: string; staffs: string[] }[]; travel: Travel[] };
const fileStamp = (file: string): string => {
    try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return 'missing'; }
};
let all: Travel[] | undefined;
export function loadTravel(cacheFile = TRAVEL_CACHE_FILE): Travel[] {
    if (all && cacheFile === TRAVEL_CACHE_FILE) return all;
    const isDefault = cacheFile === TRAVEL_CACHE_FILE;
    const npcFile = join(repoRoot, 'knowledge', 'npc-travel.json');
    const teleFile = join(repoRoot, 'knowledge', 'teleports.json');
    const cutsFile = join(repoRoot, 'knowledge', 'shortcuts.json');
    const npcStamp = fileStamp(npcFile), teleStamp = fileStamp(teleFile), cutsStamp = fileStamp(cutsFile);
    if (cacheFile) {
        try {
            const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as TravelCache;
            if (parsed?.v === 1 && Array.isArray(parsed.stamps) && Array.isArray(parsed.travel) && Array.isArray(parsed.staffs)
                && parsed.stamps.length >= 3
                && parsed.stamps[0]![0] === 'npc' && parsed.stamps[0]![1] === npcStamp
                && parsed.stamps[1]![0] === 'tele' && parsed.stamps[1]![1] === teleStamp
                && parsed.stamps[2]![0] === 'cuts' && parsed.stamps[2]![1] === cutsStamp) {
                let fresh = true;
                for (let i = 3; i < parsed.stamps.length; i++) {
                    const [rel, stamp] = parsed.stamps[i]!;
                    if (fileStamp(join(content, rel)) !== stamp) { fresh = false; break; }
                }
                if (fresh) {
                    staffs = parsed.staffs;
                    if (isDefault) all = parsed.travel;
                    return parsed.travel;
                }
            }
        } catch { /* cache miss */ }
    }
    const npc = JSON.parse(readFileSync(npcFile, 'utf8')) as { records: NpcRecord[] };
    const tele = JSON.parse(readFileSync(teleFile, 'utf8')) as { teleports: TeleRecord[]; staffs: { rune: string; staffs: string[] }[] };
    staffs = tele.staffs;
    const cuts = JSON.parse(readFileSync(cutsFile, 'utf8')) as { edges: ShortcutRecord[] };
    const built = [...npcTravel(npc.records), ...teleportTravel(tele.teleports), ...pocketExitTravel(tele.teleports), ...shortcutTravel(cuts.edges)];
    if (cacheFile) {
        const stamps: [string, string][] = [['npc', npcStamp], ['tele', teleStamp], ['cuts', cutsStamp]];
        const seenMap = new Set<string>();
        const mapSrcs = [...npc.records.map(r => r.deck?.gangplank?.src),
            ...tele.teleports.filter(r => r.kind === 'runecraft_portal').flatMap(r => (r.from ?? []).map(f => f.src))];
        for (const src of mapSrcs) {
            const m = src?.match(/^(.*):(\d+)$/);
            const rel = m?.[1];
            if (rel && !seenMap.has(rel)) { seenMap.add(rel); stamps.push([rel, fileStamp(join(content, rel))]); }
        }
        try { writeAtomicFile(cacheFile, JSON.stringify({ v: 1, stamps, staffs, travel: built }), { ensureDir: true }); }
        catch { /* optional cache */ }
    }
    if (isDefault) all = built;
    return built;
}
let staffs: { rune: string; staffs: string[] }[] = [];
// Whether a worn staff gives this rune (knowledge/teleports.json `staffs`, read by loadTravel): a cast takes none of it
// from the pack, so a route needs none of it held (travelAllowed) and a bank stop takes none (trip.ts itemsFor).
export function staffCovers(rune: string, worn: readonly string[] | undefined): boolean {
    return !!worn?.length && staffs.some(s => s.rune === rune && s.staffs.some(st => worn.includes(st)));
}

// The completion value of a quest varp (knowledge/quests.json).
let completeByVarp: Map<string, number> | undefined;
export const questCompleteValue = (varp: string): number | undefined => (completeByVarp ??= new Map(
    (JSON.parse(readFileSync(join(resolve(import.meta.dir, '..', '..', '..'), 'knowledge', 'quests.json'), 'utf8')) as { varp?: string; complete?: number }[])
        .filter(q => q.varp && Number.isInteger(q.complete)).map(q => [q.varp!, q.complete!]))).get(varp);
const compare = (have: number, op: string, want: number) => op === '>=' ? have >= want : op === '>' ? have > want : op === '=' ? have === want : op === '<' ? have < want : op === '<=' ? have <= want : false;
// Whether this account can take this travel now. An unknown quest stage counts as not met.
export function travelAllowed(t: Travel, a: Account): boolean {
    if ((a.coins ?? 0) < t.coins) return false;
    const count = (item: string) => a.counts?.[item] ?? (a.items.includes(item) ? 1 : 0);
    for (const n of t.needs) {
        if ('varp' in n) {
            const v = a.questStages?.[n.varp] ?? a.varps[n.varp];
            const publicGlider = v === undefined && n.varp === 'grandtree' && n.op === '=' && n.value === 160
                && t.kind === 'glider' && t.id.startsWith('npc:gnomepilot:') && t.run.how === 'npc' && t.run.npc === 'Gnome pilot'
                && /^glidermap:com_2[1-5]$/.test(t.run.button?.component ?? '') && a.unlocks?.includes('grandtree-glider') === true;
            // A finished quest whose stage is unknown meets a need of exactly its completion value (guild-observation.ts).
            const completed = v === undefined && n.op === '=' && a.unlocks?.includes(`complete:${n.varp}`) === true && questCompleteValue(n.varp) === n.value;
            if (!publicGlider && !completed && (v === undefined || !compare(v, n.op, n.value))) return false;
        }
        else if ('skill' in n) { if ((a.skills[n.skill] ?? 1) < n.level) return false; }
        else if ('held' in n) { if (count(n.held) < n.count) return false; }
        else if (!a.worn?.includes(n.worn)) return false;
    }
    for (const r of t.runes) {
        if (staffCovers(r.item, a.worn)) continue;
        if (count(r.item) < r.count) return false;
    }
    if (t.run.how === 'rub' && !t.run.items.some(i => count(i) > 0)) return false;
    return true;
}
