// NPC-operated travel: boats, gliders, carts, toll gates and NPC teleports that this server's
// content implements. Each fact (coordinate, fare, dialogue string, requirement) is read from a
// cited content line; the spec below names the file and a unique needle for that line, and the
// build fails if the needle is missing. Spawns come from knowledge/npcs.json.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { parseJm2 } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';

export type TravelKind = 'boat' | 'charter' | 'carpet' | 'glider' | 'cart' | 'npc-teleport' | 'toll' | 'other';
export interface Tile { x: number; z: number; level: number }
export interface SrcTile extends Tile { src: string }
export interface Requirement { varp: string; op: '>=' | '>' | '<' | '=' | '!=' | 'in' | 'not-in'; value: number | number[]; constant: string | string[]; src: string }
export interface TravelRecord {
    id: string;
    kind: TravelKind;
    destination: string;
    npc: { debugname: string; name: string; id: number; src: string };
    op: { index: number; label: string | null; src: string | null; trigger: string };
    options: { text: string; src: string }[];
    button?: { component: string; src: string };
    from: SrcTile[];
    fromFilter?: { rule: string; src: string };
    to: (SrcTile & { raw: string; radius?: number; radiusSrc?: string; steps?: string[] }) | null;
    toCandidates?: SrcTile[];
    candidateRadius?: { radius: number; src: string };
    returnTo?: SrcTile & { radius: number; radiusSrc: string };
    fare: { coins: number | null; src: string | null; rule?: string; ruleSrc?: string[] };
    items: { item: string; use: 'consumed' | 'required' | 'confiscated' | 'forbidden'; src: string }[];
    requires: Requirement[];
    members: { checked: boolean; src?: string };
    deck: { onDeck: boolean; gangplank?: { loc: string; id: number; x: number; z: number; level: number; distance: number; src: string; handler: string } };
    notes: string[];
    gaps: string[];
}
export interface ExcludedRecord { npc: string; src: string; reason: string }

const root = contentRoot();
const S = 'scripts/';
const fileCache = new Map<string, string[]>();
function lines(file: string): string[] {
    let l = fileCache.get(file);
    if (!l) { l = readFileSync(join(root, file), 'utf8').split(/\r?\n/); fileCache.set(file, l); }
    return l;
}
type Hit = { n: number; text: string; src: string };
// First line at or after `after` (1-based) that contains `needle`. Throws when absent so a content change fails the build.
export function find(file: string, needle: string, after = 1): Hit {
    const l = lines(file);
    for (let i = Math.max(0, after - 1); i < l.length; i++) if (l[i]!.includes(needle)) return { n: i + 1, text: l[i]!, src: `${file}:${i + 1}` };
    throw new Error(`npc-travel: needle not found in ${file} (after line ${after}): ${needle}`);
}

export function parseCoord(raw: string): Tile {
    const m = raw.match(/^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/);
    if (!m) throw new Error(`npc-travel: not a coord literal: ${raw}`);
    const [level, mx, mz, lx, lz] = m.slice(1).map(Number) as [number, number, number, number, number];
    return { x: mx * 64 + lx, z: mz * 64 + lz, level };
}

// ^name = value from every .constant file.
const constants = new Map<string, { value: string; src: string }>();
for (const f of listConfigFiles('.constant')) lines(f).forEach((t, i) => {
    const m = t.match(/^\^(\w+)\s*=\s*(\S+)/);
    if (m && !constants.has(m[1]!)) constants.set(m[1]!, { value: m[2]!, src: `${f}:${i + 1}` });
});
function constant(name: string): { value: string; src: string } {
    const c = constants.get(name);
    if (!c) throw new Error(`npc-travel: constant ^${name} not found`);
    return c;
}
const num = (name: string) => Number(constant(name).value);

const npcBlocks = new Map<string, ConfigBlock>();
for (const f of listConfigFiles('.npc')) for (const b of parseConfigs(readFileSync(join(root, f), 'utf8'), f)) npcBlocks.set(b.name, b);
type NpcRow = { id: number; name: string; debugname: string; src: string; spawns: SrcTile[] };
const npcs = new Map<string, NpcRow>((JSON.parse(readFileSync(join(knowledgeDir(), 'npcs.json'), 'utf8')) as NpcRow[]).map(n => [n.debugname, n]));

// A coordinate on a cited line: the first coord literal, or the first ^constant that holds one.
function coordOn(hit: Hit): SrcTile & { raw: string; steps: string[] } {
    const lit = hit.text.match(/\b(\d+_\d+_\d+_\d+_\d+)\b/);
    if (lit) return { ...parseCoord(lit[1]!), raw: lit[1]!, src: hit.src, steps: [hit.src] };
    for (const m of hit.text.matchAll(/\^(\w+)/g)) {
        const c = constants.get(m[1]!);
        if (c && /^\d+_\d+_\d+_\d+_\d+$/.test(c.value)) return { ...parseCoord(c.value), raw: c.value, src: c.src, steps: [hit.src, c.src] };
    }
    throw new Error(`npc-travel: no coord on ${hit.src}: ${hit.text.trim()}`);
}
const MOVE = /movecoord\([^,]+,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
function radiusOn(hit: Hit): number {
    const m = hit.text.match(/map_findsquare\([^,]+,\s*(\d+),\s*(\d+)/);
    if (!m) throw new Error(`npc-travel: no map_findsquare on ${hit.src}`);
    return Number(m[2]);
}

// ---- spec ----
type At = { file: string; needle: string; after?: string };
type ReqSpec = { varp: string; op: Requirement['op']; constant: string | string[]; at: At };
interface Spec {
    kind: TravelKind;
    destination: string;
    npc: string;
    op: number;
    trigger: At;
    options?: (string | { text: string; file: string; after?: string })[];
    optionsFile?: string;
    button?: At & { component: string };
    from?: { rule: string; at: At; keep: (t: Tile) => boolean };
    to?: { at: At; offsets?: At[]; radius?: At };
    candidates?: { file: string; returnConst: string; returnRadius: At };
    fare: { coins: number; at: At } | { coins: 0; free: string } | { coins: null; rule: string; at: At[] };
    items?: { item: string; use: TravelRecord['items'][number]['use']; at: At }[];
    requires?: ReqSpec[];
    members?: At;
    notes?: string[];
    gaps?: string[];
}
const hitAt = (a: At) => find(a.file, a.needle, a.after ? find(a.file, a.after).n : 1);
const zone = (c: string, r: number) => { const t = parseCoord(constant(c).value); return (p: Tile) => p.level === t.level && Math.abs(p.x - t.x) <= r && Math.abs(p.z - t.z) <= r; };
const box = (lo: string, hi: string) => { const a = parseCoord(lo), b = parseCoord(hi); return (p: Tile) => p.x >= a.x && p.x <= b.x && p.z >= a.z && p.z <= b.z && p.level >= a.level && p.level <= b.level; };

const F = {
    sailors: `${S}areas/area_port_sarim/scripts/sailors.rs2`,
    barnaby: `${S}areas/area_ardougne_east/scripts/captain_barnaby.rs2`,
    customs: `${S}areas/area_karamja/scripts/customs_officer.rs2`,
    sarimMonk: `${S}areas/area_port_sarim/scripts/monk_of_entrana.rs2`,
    entranaMonk: `${S}areas/area_entrana/scripts/monk_of_entrana.rs2`,
    shanks: `${S}areas/area_karamja/scripts/captain_shanks.rs2`,
    seravel: `${S}areas/area_shilo/scripts/seravel.rs2`,
    jenkins: `${S}areas/area_port_sarim/scripts/cabin_boy_jenkins.rs2`,
    holgartLand: `${S}areas/area_ardougne_east/scripts/holgart_ardougne.rs2`,
    holgartPlatform: `${S}areas/area_fishing_platform/scripts/holgart_platform.rs2`,
    holgartIsland: `${S}areas/area_fishing_platform/scripts/holgart_island.rs2`,
    miscSailor: `${S}areas/area_miscellania/scripts/misc_sailor.rs2`,
    vikingSailor: `${S}quests/quest_viking/scripts/viking_sailor.rs2`,
    ned: `${S}quests/quest_dragon/scripts/dragonslayer_ned.rs2`,
    sail: `${S}interface_boat/scripts/sail.rs2`,
    hajedy: `${S}areas/area_brimhaven/scripts/hajedy.rs2`,
    vigroy: `${S}areas/area_shilo/scripts/vigroy.rs2`,
    yohnus: `${S}areas/area_shilo/scripts/yohnus.rs2`,
    border: `${S}areas/area_alkharid/scripts/border_gate.rs2`,
    shantayPass: `${S}areas/area_alkharid/scripts/shantay_pass.rs2`,
    shantay: `${S}areas/area_alkharid/scripts/shantay.rs2`,
    glider: `${S}areas/area_gnome/scripts/gnome_glider.rs2`,
    daero: `${S}quests/quest_mm/scripts/mm_daero.rs2`,
    waydar: `${S}quests/quest_mm/scripts/mm_waydar.rs2`,
    lumdo: `${S}quests/quest_mm/scripts/mm_lumdo.rs2`,
    ess: `${S}skill_runecraft/scripts/essence_mine.rs2`,
    essEnum: `${S}skill_runecraft/configs/essence_mine_teleports.enum`,
    cromperty: `${S}areas/area_ardougne_east/scripts/wizard_cromperty.rs2`,
    aubury: `${S}areas/area_varrock/scripts/aubury.rs2`,
    sedridor: `${S}areas/area_wizard_tower/scripts/sedridor.rs2`,
    distentor: `${S}areas/area_yanille/scripts/wizard_distentor.rs2`,
    brimstail: `${S}areas/area_gnome/scripts/brimstail.rs2`,
    winelda: `${S}quests/quest_ikov/scripts/winelda.rs2`,
    elkoy: `${S}areas/area_gnome/scripts/elkoy.rs2`,
    mosol: `${S}quests/quest_zombiequeen/scripts/mosol_rei.rs2`,
    caveMonk: `${S}areas/area_entrana/scripts/cave_monk.rs2`,
    enclave: `${S}quests/quest_itwatchtower/scripts/enclave_guard.rs2`,
};

const sailorBoat = (npc: string): Spec => ({
    kind: 'boat', destination: 'Karamja (Musa Point)', npc, op: 1,
    trigger: { file: F.sailors, needle: '[opnpc1,_sailor]' },
    options: ['Yes please.'], optionsFile: F.sailors,
    to: { at: { file: F.sailors, needle: '@karamja_sailor_dialogue("Karamja", ' } },
    fare: { coins: 30, at: { file: F.sailors, needle: 'inv_del(inv, coins, 30);' } },
    notes: ['During Dragon Slayer (%dragonquest from quest_dragon_spoken_to_oziach until dragon_complete) the menu adds "I\'d rather go to Crandor Isle.", which the sailor refuses.'],
});
const essence = (npc: string, op: number, file: string, trigger: string, ret: string): Spec => ({
    kind: 'npc-teleport', destination: 'Rune essence mine', npc, op,
    trigger: { file, needle: trigger },
    candidates: { file: F.essEnum, returnConst: ret, returnRadius: { file: F.ess, needle: 'def_coord $coord = map_findsquare(%exit_essence_mine_coord, 0, 2,' } },
    to: { at: { file: F.ess, needle: 'p_telejump($coord);' }, radius: { file: F.ess, needle: '$coord = map_findsquare($coord, 0, 1, ^map_findsquare_lineofsight);' } },
    fare: { coins: 0, free: 'teleport_to_essence_mine removes no coins' },
    requires: [{ varp: 'runemysteries', op: '>=', constant: 'runemysteries_complete', at: { file: F.ess, needle: 'if(%runemysteries < ^runemysteries_complete) {' } }],
    notes: [`The direct op${op} Teleport needs no dialogue. The mine exit portal returns the player to ^${ret}.`],
});
const gliderOut = (dest: string, label: string, com: string): Spec => ({
    kind: 'glider', destination: label, npc: 'gnomepilot', op: 1,
    trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
    options: ['Can you take me on the glider?'], optionsFile: F.glider,
    button: { file: F.glider, needle: `[if_button,glidermap:${com}] @gnomeglider_fly(^${dest});`, component: `glidermap:${com}` },
    from: { rule: 'pilot within 8 tiles of ^ta_quir_priw (calc_gliderstart)', at: { file: F.glider, needle: 'if(inzone(movecoord(^ta_quir_priw, -8, 0, -8)' }, keep: zone('ta_quir_priw', 8) },
    to: { at: { file: `${S}areas/area_gnome/configs/glider.constant`, needle: `^${dest} = ` }, radius: { file: F.glider, needle: 'p_teleport(map_findsquare($dest, 0, 1, ^map_findsquare_lineofwalk));' } },
    fare: { coins: 0, free: 'gnomeglider_fly removes no coins' },
    requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_complete', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' } }],
    members: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' },
    notes: ['Only legs that start or end at Ta Quir Priw fly (gnomeglider_fly refuses others).'],
});
const gliderHome = (start: string, label: string): Spec => ({
    kind: 'glider', destination: `Ta Quir Priw (Grand Tree) from ${label}`, npc: 'gnomepilot', op: 1,
    trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
    options: ['Can you take me on the glider?'], optionsFile: F.glider,
    button: { file: F.glider, needle: '[if_button,glidermap:com_22] @gnomeglider_fly(^ta_quir_priw);', component: 'glidermap:com_22' },
    from: { rule: `pilot within 8 tiles of ^${start} (${label}, calc_gliderstart)`, at: { file: F.glider, needle: `inzone(movecoord(^${start}, -8, 0, -8)` }, keep: zone(start, 8) },
    to: { at: { file: `${S}areas/area_gnome/configs/glider.constant`, needle: '^ta_quir_priw = ' }, radius: { file: F.glider, needle: 'p_teleport(map_findsquare($dest, 0, 1, ^map_findsquare_lineofwalk));' } },
    fare: { coins: 0, free: 'gnomeglider_fly removes no coins' },
    requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_complete', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' } }],
    members: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' },
});

export const SPECS: Spec[] = [
    // ---- ships ----
    sailorBoat('captain_tobias'), sailorBoat('seaman_lorris'), sailorBoat('seaman_thresnor'),
    {
        kind: 'boat', destination: 'Brimhaven', npc: 'captain_barnaby', op: 1,
        trigger: { file: F.barnaby, needle: '[opnpc1,captain_barnaby]' },
        options: ['Yes please.'], optionsFile: F.sailors,
        to: { at: { file: F.barnaby, needle: '@karamja_sailor_dialogue("Brimhaven", ' } },
        fare: { coins: 30, at: { file: F.sailors, needle: 'inv_del(inv, coins, 30);' } },
        notes: ['Uses the Port Sarim sailor label karamja_sailor_dialogue.'],
    },
    {
        kind: 'boat', destination: 'Ardougne', npc: 'customs_officer', op: 1,
        trigger: { file: F.customs, needle: '[opnpc1,customs_officer]' },
        options: ['Can I journey on this ship?', 'Search away, I have nothing to hide.', 'Ok.'], optionsFile: F.customs,
        from: { rule: 'officer x < 2815 (Brimhaven)', at: { file: F.customs, needle: 'if(coordx(npc_coord) < 2815) {' }, keep: t => t.x < 2815 },
        to: { at: { file: F.customs, needle: '~set_sail("Ardougne", ' } },
        fare: { coins: 30, at: { file: F.customs, needle: 'inv_del(inv, coins, 30);' } },
        items: [{ item: 'karamja_rum', use: 'confiscated', at: { file: F.customs, needle: 'inv_del(inv, karamja_rum, 28);' } }],
        notes: ['With %hunt >= 2 the search is skipped: pick "Can I journey on this ship?" then "Ok.". Carrying Karamja rum ends the talk after confiscation.'],
    },
    {
        kind: 'boat', destination: 'Port Sarim', npc: 'customs_officer', op: 1,
        trigger: { file: F.customs, needle: '[opnpc1,customs_officer]' },
        options: ['Can I journey on this ship?', 'Search away, I have nothing to hide.', 'Ok.'], optionsFile: F.customs,
        from: { rule: 'officer x >= 2815 (Musa Point)', at: { file: F.customs, needle: 'if(coordx(npc_coord) < 2815) {' }, keep: t => t.x >= 2815 },
        to: { at: { file: F.customs, needle: '~set_sail("Port Sarim", ' } },
        fare: { coins: 30, at: { file: F.customs, needle: 'inv_del(inv, coins, 30);' } },
        items: [{ item: 'karamja_rum', use: 'confiscated', at: { file: F.customs, needle: 'inv_del(inv, karamja_rum, 28);' } }],
        notes: ['With %hunt >= 2 the search is skipped: pick "Can I journey on this ship?" then "Ok.". Carrying Karamja rum ends the talk after confiscation.'],
    },
    {
        kind: 'boat', destination: 'Entrana', npc: 'shipmonk', op: 1,
        trigger: { file: F.sarimMonk, needle: '[opnpc1,shipmonk]' },
        options: ["Yes, okay, I'm ready to go."], optionsFile: F.sarimMonk,
        to: { at: { file: F.sarimMonk, needle: '~set_sail("Entrana", ' } },
        fare: { coins: 0, free: 'shipmonk removes no coins' },
        items: [{ item: 'any weapon or armour category, worn or held, or cannon parts', use: 'forbidden', at: { file: F.sarimMonk, needle: '[proc,has_entrana_restricted_items]' } }],
        members: { file: F.sarimMonk, needle: 'if(map_members = ^false) {' },
    },
    {
        kind: 'boat', destination: 'Port Sarim', npc: 'shipmonk2', op: 1,
        trigger: { file: F.entranaMonk, needle: '[opnpc1,shipmonk2]' },
        options: ["Yes, I'm ready to go."], optionsFile: F.entranaMonk,
        to: { at: { file: F.entranaMonk, needle: '~set_sail("Port Sarim", ' } },
        fare: { coins: 0, free: 'shipmonk2 removes no coins' },
    },
    ...(['Port Khazard', 'Port Sarim'] as const).map((dest): Spec => ({
        kind: 'boat', destination: dest, npc: 'captain_shanks', op: 1,
        trigger: { file: F.shanks, needle: '[opnpc1,captain_shanks]' },
        options: [dest === 'Port Khazard' ? 'Khazard Port please.' : 'Port Sarim please.'], optionsFile: F.shanks,
        to: { at: { file: F.shanks, needle: dest === 'Port Khazard' ? '~set_sail_cairn("You arrive safely' : '~set_sail_cairn("The ship arrives in busy Port Sarim.' } },
        fare: { coins: null, rule: 'One shiloshipticket per trip: 25 coins from Seravel in Shilo Village, or ~random_range(26, 45) coins from Captain Shanks when no ticket is held.', at: [{ file: F.seravel, needle: 'inv_del(inv, coins, 25);' }, { file: F.shanks, needle: 'def_int $price = ~random_range(26, 45);' }] },
        items: [
            { item: 'shiloshipticket', use: 'consumed', at: { file: F.shanks, needle: 'inv_del(inv, shiloshipticket, 1);', after: dest === 'Port Khazard' ? '[label,shanks_khazard]' : '[label,shanks_sarim]' } },
            { item: 'karamja_rum', use: 'confiscated', at: { file: F.shanks, needle: 'inv_del(inv, karamja_rum, ^max_32bit_int);' } },
        ],
        requires: [{ varp: 'zombiequeen', op: '>=', constant: 'zombiequeen_complete', at: { file: F.shanks, needle: 'if(%zombiequeen < ^zombiequeen_complete) {' } }],
        notes: ['Captain Shanks stands on the Lady of the Waves deck (level 1). Without a ticket the first choice is "Yes, I\'ll buy a ticket for the ship.", then the destination.'],
    })),
    {
        kind: 'boat', destination: 'Port Sarim dock (leave the Lady Lumbridge)', npc: 'cabin_boy_jenkins', op: 1,
        trigger: { file: F.jenkins, needle: '[opnpc1,cabin_boy_jenkins]' },
        options: ["I'm ready to go back to shore."], optionsFile: F.jenkins,
        to: { at: { file: F.jenkins, needle: 'p_telejump(0_47_50_39_4);' } },
        fare: { coins: 0, free: 'cabin_boy_jenkins removes no coins' },
    },
    {
        kind: 'boat', destination: 'Fishing Platform', npc: 'holgartland', op: 1,
        trigger: { file: F.holgartLand, needle: '[opnpc1,holgartland]' },
        options: ["Okay, let's do it."], optionsFile: F.holgartLand,
        to: { at: { file: F.holgartLand, needle: 'p_telejump(^seaslug_platform_coord);' } },
        fare: { coins: 0, free: 'holgartland removes no coins' },
        requires: [{ varp: 'seaslugquest', op: '=', constant: 'seaslug_complete', at: { file: F.holgartLand, needle: 'case ^seaslug_complete : @holgart_fancy;' } }],
        items: [{ item: 'torch_lit (becomes torch_unlit)', use: 'consumed', at: { file: F.holgartLand, needle: 'inv_del(inv, torch_lit, $count);' } }],
        notes: ['Before quest completion the same trip runs from holgart_strangethings ("Will you take me there?") at the stages that fall to case default, and once from holgart_paste after the swamp paste is handed in.'],
    },
    {
        kind: 'boat', destination: 'Witchaven shore', npc: 'holgartplatform', op: 1,
        trigger: { file: F.holgartPlatform, needle: '[opnpc1,holgartplatform]' },
        options: ["Okay, let's go back."], optionsFile: F.holgartPlatform,
        to: { at: { file: F.holgartPlatform, needle: 'p_telejump(^seaslug_shore_coord);' } },
        fare: { coins: 0, free: 'holgartplatform removes no coins' },
        requires: [{ varp: 'seaslugquest', op: '!=', constant: 'seaslug_spoken_kennith', at: { file: F.holgartPlatform, needle: 'case ^seaslug_spoken_kennith : @holgart_something_strange;' } }],
        notes: ['At %seaslugquest = ^seaslug_saved_kennith the talk goes to shore with no menu.'],
    },
    {
        kind: 'boat', destination: 'Fishing Platform', npc: 'holgartsunkboat', op: 1,
        trigger: { file: F.holgartIsland, needle: '[opnpc1,holgartsunkboat]' },
        options: [],
        to: { at: { file: F.holgartLand, needle: 'p_telejump(^seaslug_platform_coord);' } },
        fare: { coins: 0, free: 'holgartsunkboat removes no coins' },
        requires: [{ varp: 'seaslugquest', op: '!=', constant: 'seaslug_sailed_kent', at: { file: F.holgartIsland, needle: 'if(%seaslugquest ! ^seaslug_sailed_kent) {' } }],
        notes: ['Return leg from the Sea Slug island; the island is reached only by quest steps.'],
    },
    {
        kind: 'boat', destination: 'Rellekka', npc: 'misc_sailor', op: 1,
        trigger: { file: F.miscSailor, needle: '[opnpc1,misc_sailor]' },
        options: ["Let's go!"], optionsFile: F.miscSailor,
        to: { at: { file: F.miscSailor, needle: '~misc_longship_sail(^from_miscellania_tele_coord' } },
        fare: { coins: 0, free: 'misc_sailor removes no coins' },
    },
    {
        kind: 'boat', destination: 'Miscellania', npc: 'viking_sailor', op: 1,
        trigger: { file: F.vikingSailor, needle: '[opnpc1,viking_sailor]' },
        options: ["Let's go!"], optionsFile: F.vikingSailor,
        to: { at: { file: F.vikingSailor, needle: '~misc_longship_sail(^to_miscellania_tele_coord' } },
        fare: { coins: 0, free: 'viking_sailor removes no coins' },
        requires: [{ varp: 'viking', op: '=', constant: 'viking_complete', at: { file: F.vikingSailor, needle: '} else if(%viking = ^viking_complete) {' } }],
    },
    {
        kind: 'boat', destination: 'Crandor', npc: 'dragonslayer_ned', op: 1,
        trigger: { file: F.ned, needle: '[opnpc1,dragonslayer_ned]' },
        options: ['Yep lets go!'], optionsFile: F.ned,
        from: { rule: 'Ned on the Lady Lumbridge deck (coordy(coord) = 3)', at: { file: F.ned, needle: '& coordy(coord) = 3) {' }, keep: t => t.level === 3 },
        to: { at: { file: F.ned, needle: 'p_telejump(^crandor_tele_coord);' } },
        fare: { coins: 0, free: 'dragonslayer_ned removes no coins' },
        requires: [{ varp: 'dragonquest', op: 'in', constant: ['quest_dragon_ned_given_map', 'quest_dragon_sailed_to_crandor'], at: { file: F.ned, needle: 'if ((%dragonquest = ^quest_dragon_ned_given_map | %dragonquest = ^quest_dragon_sailed_to_crandor)' } }],
        notes: ['Dragon Slayer quest leg; the ship is wrecked on arrival and Ned does not sail back.'],
    },
    // ---- carts ----
    {
        kind: 'cart', destination: 'Shilo Village', npc: 'brimhavencartdriver', op: 1,
        trigger: { file: F.hajedy, needle: '[opnpc1,brimhavencartdriver]' },
        options: ["Yes please, I'd like to go to Shilo Village."], optionsFile: F.hajedy,
        to: { at: { file: F.hajedy, needle: 'p_teleport(0_44_46_18_7);' } },
        fare: { coins: null, rule: '5% of carried coins, minimum 10, maximum 200 (calc_shilocart_cost).', at: [{ file: F.hajedy, needle: 'def_int $cost = calc((inv_total(inv, coins) * 5) / 100);' }, { file: F.hajedy, needle: '$cost = 10;' }, { file: F.hajedy, needle: '$cost = 200;' }] },
        requires: [{ varp: 'zombiequeen', op: '>=', constant: 'zombiequeen_complete', at: { file: F.hajedy, needle: 'if(%zombiequeen < ^zombiequeen_complete) {' } }],
        notes: ['The brimhavencart loc op2 starts the same dialogue when Hajedy is within 7 tiles.'],
    },
    {
        kind: 'cart', destination: 'Brimhaven', npc: 'shilocartdriver', op: 1,
        trigger: { file: F.vigroy, needle: '[opnpc1,shilocartdriver]' },
        options: ["Yes please, I'd like to go to Brimhaven."], optionsFile: F.vigroy,
        to: { at: { file: F.vigroy, needle: 'p_teleport(0_43_50_24_14);' } },
        fare: { coins: null, rule: '5% of carried coins, minimum 10, maximum 200 (calc_shilocart_cost in hajedy.rs2).', at: [{ file: F.hajedy, needle: 'def_int $cost = calc((inv_total(inv, coins) * 5) / 100);' }, { file: F.hajedy, needle: '$cost = 10;' }, { file: F.hajedy, needle: '$cost = 200;' }] },
        notes: ['The shilocart loc op2 starts the same dialogue when Vigroy is within 7 tiles. The handler checks no quest varp.'],
    },
    // ---- tolls and passes ----
    {
        kind: 'toll', destination: 'Al Kharid (east of the toll gate)', npc: 'borderguard1', op: 1,
        trigger: { file: F.border, needle: '[opnpc1,borderguard1]' },
        options: ['Yes, ok.'], optionsFile: F.border,
        to: { at: { file: F.border, needle: 'def_coord $coord = 0_51_50_4_27;' }, offsets: [{ file: F.border, needle: '$coord = movecoord($coord, -1, 0, 0);' }, { file: F.border, needle: '$destination = movecoord(coord, 1, 0, 0);' }] },
        fare: { coins: 10, at: { file: F.border, needle: 'inv_del(inv, coins, 10);' } },
        notes: ['Free with %princequest >= ^prince_saved (no menu). The border_gate_toll_left/right loc op1 also starts this talk.'],
        requires: [],
    },
    {
        kind: 'toll', destination: 'Lumbridge side (west of the toll gate)', npc: 'borderguard2', op: 1,
        trigger: { file: F.border, needle: '[opnpc1,borderguard2]' },
        options: ['Yes, ok.'], optionsFile: F.border,
        to: { at: { file: F.border, needle: 'def_coord $coord = 0_51_50_4_27;' }, offsets: [{ file: F.border, needle: '$destination = movecoord(coord, -1, 0, 0);' }] },
        fare: { coins: 10, at: { file: F.border, needle: 'inv_del(inv, coins, 10);' } },
        notes: ['Free with %princequest >= ^prince_saved (no menu). The border_gate_toll_left/right loc op1 also starts this talk.'],
    },
    {
        kind: 'toll', destination: 'Kharidian Desert (south of Shantay Pass)', npc: 'shantay_guard_still', op: 1,
        trigger: { file: F.shantayPass, needle: '[opnpc1,shantay_guard_still]' },
        options: ["I'd like to go into the desert please.", "Yeah, that poster doesn't scare me!"], optionsFile: F.shantayPass,
        to: { at: { file: F.shantayPass, needle: 'p_teleport(0_51_48_40_46);' }, offsets: [{ file: F.shantayPass, needle: 'p_telejump(movecoord(coord, 0, 0, -3));' }] },
        fare: { coins: null, rule: 'One shantay_pass per trip; Shantay sells it for 5 coins ("I want to buy a shantay pass for 5 gold coins.").', at: [{ file: F.shantay, needle: 'inv_del(inv, coins, 5);', after: '[label,shantay_buy_shantay_pass]' }, { file: F.shantay, needle: '"I want to buy a shantay pass for 5 gold coins."' }] },
        items: [{ item: 'shantay_pass', use: 'consumed', at: { file: F.shantayPass, needle: 'inv_del(inv, shantay_pass, 1);' } }],
        members: { file: F.shantayPass, needle: 'if (map_members = ^false) {' },
        notes: ['The poster choice appears only without thshantaydisc; the first trip adds the disclaimer. The shantay_pass_henge_doorway loc op1 does the same check; going north through it is free.'],
    },
    {
        kind: 'toll', destination: 'Shilo Village furnace building', npc: 'shilofurnaceowner', op: 1,
        trigger: { file: F.yohnus, needle: '[opnpc1,shilofurnaceowner]' },
        options: ['Use Furnace - 20 Gold'], optionsFile: F.yohnus,
        to: { at: { file: F.yohnus, needle: '~forcemove(0_44_46_40_19);' }, offsets: [{ file: F.yohnus, needle: 'p_teleport(movecoord(coord, 0, 0, 1));' }] },
        fare: { coins: 20, at: { file: F.yohnus, needle: 'inv_del(inv, coins, 20);' } },
    },
    {
        kind: 'other', destination: 'Port Sarim jail', npc: 'shantay', op: 1,
        trigger: { file: F.shantay, needle: '[opnpc1,shantay]' },
        options: ['What is this place?', 'I am definitely an outlaw, prepare to die!', "No thanks, you're not having my money.", 'No, do your worst!'], optionsFile: F.shantay,
        to: { at: { file: F.shantay, needle: 'p_telejump(0_47_49_9_46);' } },
        fare: { coins: 0, free: 'shantay_send_player_to_port_sarim removes no coins' },
        notes: ['Shantay first jails the player at 0_51_48_32_52, then the refusal path sends the player to Port Sarim.'],
        gaps: ['The Port Sarim jail exit is not in knowledge/doors.json near the arrival tile; the way out is not verified.'],
    },
    // ---- gliders ----
    gliderOut('gandius', 'Gandius (Karamja shipyard)', 'com_21'),
    gliderOut('sindarpos', 'Sindarpos (White Wolf Mountain)', 'com_23'),
    gliderOut('lemanto_andra', 'Lemanto Andra (Digsite, east of Varrock)', 'com_24'),
    gliderOut('kar_hewo', 'Kar-Hewo (Al Kharid)', 'com_25'),
    gliderHome('gandius', 'Gandius'), gliderHome('sindarpos', 'Sindarpos'), gliderHome('kar_hewo', 'Kar-Hewo'),
    {
        kind: 'glider', destination: 'Karamja crash site', npc: 'gnomepilot', op: 1,
        trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
        options: ['Take me to Karamja please!'], optionsFile: F.glider,
        from: { rule: 'pilot in 3_38_54_31_43..3_38_54_35_47', at: { file: F.glider, needle: 'inzone(3_38_54_31_43, 3_38_54_35_47, npc_coord)' }, keep: box('3_38_54_31_43', '3_38_54_35_47') },
        to: { at: { file: F.glider, needle: 'p_teleport(0_45_47_37_50);' } },
        fare: { coins: 0, free: 'gnomepilot removes no coins' },
        requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_released_prison', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_released_prison & inzone(' } }],
        notes: ['The Grand Tree quest leg.'],
    },
    {
        kind: 'glider', destination: 'Crash Island', npc: 'mm_waydar', op: 1,
        trigger: { file: F.waydar, needle: '[opnpc1,mm_waydar]' },
        options: ['Yes'], optionsFile: F.waydar,
        from: { rule: 'Waydar outside the Crash Island square 0_45_42', at: { file: F.waydar, needle: 'if(inzone(0_45_42_0_0, 0_45_42_63_63, npc_coord) = true) {' }, keep: t => !box('0_45_42_0_0', '0_45_42_63_63')(t) },
        to: { at: { file: F.waydar, needle: 'p_teleport(0_45_42_13_37);' } },
        fare: { coins: 0, free: 'waydar_fly_crash_island removes no coins' },
        requires: [{ varp: 'mm_daero', op: '=', constant: 'daero_complete', at: { file: F.waydar, needle: 'if(%mm_daero = ^daero_complete) {' } }],
        notes: ['Waydar waits in the underground glider hangar; Daero takes the player there.'],
    },
    {
        kind: 'glider', destination: 'Gnome Stronghold (near the Gnomeball pitch)', npc: 'mm_waydar', op: 1,
        trigger: { file: F.waydar, needle: '[opnpc1,mm_waydar]' },
        options: ['I need to return to your kingdom.'], optionsFile: F.waydar,
        from: { rule: 'Waydar inside the Crash Island square 0_45_42', at: { file: F.waydar, needle: 'if(inzone(0_45_42_0_0, 0_45_42_63_63, npc_coord) = true) {' }, keep: box('0_45_42_0_0', '0_45_42_63_63') },
        to: { at: { file: F.waydar, needle: 'p_teleport(0_37_54_25_10);' } },
        fare: { coins: 0, free: 'waydar_return removes no coins' },
        requires: [
            { varp: 'mm_waydar', op: '=', constant: 'waydar_arrived_island', at: { file: F.waydar, needle: 'case ^waydar_arrived_island :' } },
            { varp: 'mm_main', op: '>', constant: 'mm_shown_seal', at: { file: F.waydar, needle: 'if(%mm_main > ^mm_shown_seal) {' } },
        ],
    },
    // ---- Monkey Madness transfers ----
    {
        kind: 'other', destination: 'Underground glider hangar', npc: 'mm_daero', op: 1,
        trigger: { file: F.daero, needle: '[opnpc1,mm_daero]' },
        options: [],
        from: { rule: 'Daero outside the hangar squares 0_37_154 and 0_40_70..0_41_71', at: { file: F.daero, needle: 'if(inzone(0_37_154_0_0, 0_37_154_63_63, npc_coord) = true | inzone(0_40_70_0_0, 0_41_71_63_63, npc_coord) = true) {' }, keep: t => !box('0_37_154_0_0', '0_37_154_63_63')(t) && !box('0_40_70_0_0', '0_41_71_63_63')(t) },
        to: { at: { file: F.daero, needle: 'else p_teleport(0_41_70_25_36);' } },
        fare: { coins: 0, free: 'daero_move_hangar removes no coins' },
        requires: [
            { varp: 'mm_narnode', op: '>=', constant: 'narnode_received_orders', at: { file: F.daero, needle: 'if(%mm_narnode < ^narnode_received_orders) {' } },
            { varp: 'mm_main', op: '=', constant: 'mm_complete_training', at: { file: F.daero, needle: 'if(%mm_main = ^mm_complete_training) {' } },
            { varp: 'mm_daero', op: '>=', constant: 'daero_reinit_complete', at: { file: F.daero, needle: 'if(%mm_daero < ^daero_reinit_complete) p_teleport(0_37_154_25_36);' } },
        ],
        notes: ['At %mm_main = ^mm_complete Daero runs the one-time training instead; after it the talk goes to the hangar. During the quest (%mm_daero >= ^daero_left_grandtree) the menu answer is "Yes".'],
    },
    {
        kind: 'other', destination: 'Ape Atoll', npc: 'mm_lumdo', op: 1,
        trigger: { file: F.lumdo, needle: '[opnpc1,mm_lumdo]' },
        options: [],
        from: { rule: 'Lumdo outside 0_43_42 (Ape Atoll) and 0_42_143', at: { file: F.lumdo, needle: 'if(inzone(0_43_42_0_0, 0_43_42_63_63, npc_coord) = true) {' }, keep: t => !box('0_43_42_0_0', '0_43_42_63_63')(t) && !box('0_42_143_0_0', '2_42_143_63_63')(t) },
        to: { at: { file: F.lumdo, needle: 'p_teleport(0_43_42_50_19);' } },
        fare: { coins: 0, free: 'mm_lumdo removes no coins' },
        requires: [{ varp: 'mm_lumdo', op: '=', constant: 'lumdo_travelled', at: { file: F.lumdo, needle: 'case ^lumdo_travelled :' } }],
        notes: ['The script shows a fade; it names no vehicle.'],
    },
    {
        kind: 'other', destination: 'Crash Island', npc: 'mm_lumdo', op: 1,
        trigger: { file: F.lumdo, needle: '[opnpc1,mm_lumdo]' },
        options: [],
        from: { rule: 'Lumdo inside 0_43_42 (Ape Atoll)', at: { file: F.lumdo, needle: 'if(inzone(0_43_42_0_0, 0_43_42_63_63, npc_coord) = true) {' }, keep: box('0_43_42_0_0', '0_43_42_63_63') },
        to: { at: { file: F.lumdo, needle: 'p_teleport(0_45_42_14_38);' } },
        fare: { coins: 0, free: 'mm_lumdo removes no coins' },
    },
    // ---- NPC teleports ----
    essence('ardounge_wizard', 3, F.cromperty, '[opnpc3,ardounge_wizard]', 'essence_mine_to_cromperty'),
    essence('aubury', 4, F.aubury, '[opnpc4,aubury]', 'essence_mine_to_aubury'),
    essence('head_wizard', 3, F.sedridor, '[opnpc3,head_wizard]', 'essence_mine_to_sedridor'),
    essence('guild_wizard', 3, F.distentor, '[opnpc3,guild_wizard]', 'essence_mine_to_disentor'),
    essence('gnome_brimstail', 3, F.brimstail, '[opnpc3,gnome_brimstail]', 'essence_mine_to_brimstail'),
    ...([['before the crate is delivered', 'def_coord $coord = 0_41_51_25_7;', '<'], ['after the crate is delivered', '$coord = 0_41_51_14_57;', '>=']] as const).map(([label, needle, op]): Spec => ({
        kind: 'npc-teleport', destination: `Cromperty's other teleport block (${label})`, npc: 'ardounge_wizard', op: 1,
        trigger: { file: F.cromperty, needle: '[opnpc1,ardounge_wizard]' },
        options: ['So what have you invented?', 'Can I be teleported please?', 'Yes, that sounds good. Teleport me!'], optionsFile: F.cromperty,
        to: { at: { file: F.cromperty, needle } },
        fare: { coins: 0, free: 'rpdt_teleport removes no coins' },
        requires: [
            { varp: 'totemquest', op: '<', constant: 'totem_complete', at: { file: F.cromperty, needle: 'if(%totemquest < ^totem_complete) {' } },
            { varp: 'totemquest', op, constant: 'totem_crate_delivered', at: { file: F.cromperty, needle: 'if(%totemquest >= ^totem_crate_delivered) {' } },
        ],
        notes: ['Tribal Totem leg; after quest completion the teleport fails with no movement.'],
    })),
    {
        kind: 'npc-teleport', destination: 'Temple of Ikov, across the lava', npc: 'ikov_winelda', op: 1,
        trigger: { file: F.winelda, needle: '[opnpc1,ikov_winelda]' },
        options: [],
        to: { at: { file: F.winelda, needle: 'p_teleport(0_41_154_40_20);' } },
        fare: { coins: 0, free: 'ikov_winelda_teleport removes no coins' },
        requires: [{ varp: 'ikov', op: 'not-in', constant: ['ikov_defeated_fire_warrior', 'ikov_spoken_winelda'], at: { file: F.winelda, needle: 'Hi again. Could you do the honours again please?' } }],
        items: [{ item: 'limpwurt_root x20 (first trip, at ^ikov_spoken_winelda)', use: 'consumed', at: { file: F.winelda, needle: 'inv_del(inv, limpwurt_root, 20);' } }],
        notes: ['The case default branch teleports with no menu; at ^ikov_spoken_winelda the first trip costs 20 limpwurt roots.'],
    },
    // ---- other NPC-led moves ----
    {
        kind: 'other', destination: 'Tree Gnome Village (inside the maze)', npc: 'elkoy', op: 1,
        trigger: { file: F.elkoy, needle: '[opnpc1,elkoy]' },
        options: ['Yes please.'], optionsFile: F.elkoy,
        to: { at: { file: F.elkoy, needle: 'def_coord $dest_coord = ^elkoy_maze_coord;', after: '[label,elkoy_jumpmaze_postquest]' } },
        fare: { coins: 0, free: 'elkoy removes no coins' },
        requires: [{ varp: 'treequest', op: '>=', constant: 'tree_started', at: { file: F.elkoy, needle: 'case ^tree_started, ^tree_spoken_montai' } }],
        notes: ['Post-quest path shown; quest stages use the same answer "Yes please." except where the menu differs per stage.'],
    },
    {
        kind: 'other', destination: 'Tree Gnome Village maze entrance', npc: 'elkoy_village', op: 1,
        trigger: { file: F.elkoy, needle: '[opnpc1,elkoy_village]' },
        options: ['Yes please.'], optionsFile: F.elkoy,
        to: { at: { file: F.elkoy, needle: '$dest_coord = ^elkoy_entrance_coord;', after: '[label,elkoy_jumpmaze_postquest]' } },
        fare: { coins: 0, free: 'elkoy_village removes no coins' },
        requires: [{ varp: 'treequest', op: '>=', constant: 'tree_started', at: { file: F.elkoy, needle: 'case ^tree_started, ^tree_spoken_montai', after: '[opnpc1,elkoy_village]' } }],
        notes: ['Post-quest path shown. At stages ^tree_retrieved_orb and ^tree_returned_first_orb the answer is "Can you show me out of the village?".'],
    },
    {
        kind: 'other', destination: 'Shilo Village gate (inside)', npc: 'mosol_rei', op: 1,
        trigger: { file: F.mosol, needle: '[opnpc1,mosol_rei]' },
        options: ["Yes, I'll give it a go!"], optionsFile: F.mosol,
        to: { at: { file: F.mosol, needle: 'p_telejump(0_44_46_50_8);' } },
        fare: { coins: 0, free: 'mosol_rei removes no coins' },
        requires: [
            { varp: 'junglepotion', op: '>=', constant: 'junglepotion_complete', at: { file: F.mosol, needle: 'if(%junglepotion < ^junglepotion_complete) {' } },
            { varp: 'zombiequeen', op: 'in', constant: ['zombiequeen_complete', 'zombiequeen_complete_spoken_trufitus1', 'zombiequeen_complete_spoken_trufitus2'], at: { file: F.mosol, needle: 'case ^zombiequeen_complete, ^zombiequeen_complete_spoken_trufitus1' } },
        ],
    },
    {
        kind: 'other', destination: 'Entrana dungeon (one way)', npc: 'cave_monk', op: 1,
        trigger: { file: F.caveMonk, needle: '[opnpc1,cave_monk]' },
        options: ['Well that is a risk I will have to take.'], optionsFile: F.caveMonk,
        to: { at: { file: F.caveMonk, needle: 'p_telejump(0_44_152_6_46);' } },
        fare: { coins: 0, free: 'cave_monk removes no coins' },
        notes: ['Prayer drops (stat_sub(prayer, 0, 95)). The only exit is a portal to deep Wilderness (monk dialogue).'],
    },
    {
        kind: 'other', destination: 'Skavid cave by the enclave', npc: 'enclave_guard', op: 1,
        trigger: { file: F.enclave, needle: '[opnpc1,enclave_guard]' },
        options: ['I want to go in there.'], optionsFile: F.enclave,
        to: { at: { file: F.enclave, needle: 'p_teleport(0_40_147_28_2);' } },
        fare: { coins: 0, free: 'enclave_guard removes no coins' },
        requires: [{ varp: 'itwatchtower', op: '>=', constant: 'itwatchtower_complete', at: { file: F.enclave, needle: 'if(%itwatchtower >= ^itwatchtower_complete) {' } }],
        notes: ['Before quest completion the answer starts a fight; using nightshade on the guard passes from ^itwatchtower_skavid_crystal.'],
    },
];

// Handlers that move the player but are not travel legs a router can use.
const EXCLUDED: { npc: string; at: At; reason: string }[] = [
    { npc: 'arenamage1', at: { file: `${S}areas/area_mage_arena/scripts/kolodion.rs2`, needle: 'p_teleport(^mage_arena_start_coord);' }, reason: 'Enters the Mage Arena fight and spawns the boss.' },
    { npc: 'holgartplatform', at: { file: F.holgartPlatform, needle: 'p_telejump(^seaslug_island_coord);' }, reason: 'Sea Slug quest step (stage seaslug_spoken_kennith or seaslug_sailed_kent).' },
    { npc: 'murphy', at: { file: `${S}minigames/game_trawler/scripts/trawler_start.rs2`, needle: 'p_teleport(map_findsquare(^trawler_start_center_under' }, reason: 'Fishing Trawler minigame start, returns to Port Khazard.' },
    { npc: 'ogre_guard1', at: { file: `${S}quests/quest_itwatchtower/scripts/ogre_guard.rs2`, needle: 'p_teleport(^gutanoth_hill);' }, reason: 'Guards eject the player; entry is the gate loc via @enter_gutanoth.' },
    { npc: 'regicide gate guard', at: { file: `${S}quests/quest_regicide/scripts/regicide_arandar_gate_guard.rs2`, needle: 'p_teleport(movecoord(coord, 0, 0, 2));' }, reason: 'Arandar gate passage, a player-relative step through a gate.' },
    { npc: 'legends_guard', at: { file: `${S}quests/quest_legends/scripts/legends_guard.rs2`, needle: 'p_teleport($inside_dest);' }, reason: 'Legends Guild gate passage.' },
    { npc: 'gujuo', at: { file: `${S}quests/quest_legends/scripts/gujuo.rs2`, needle: 'p_teleport(^legends_gujuo_guide_coord);' }, reason: 'Gujuo has no static spawn (npcs.json spawns empty).' },
    { npc: 'caveguide5', at: { file: `${S}quests/quest_upass/scripts/koftik.rs2`, needle: 'p_teleport(0_38_151_49_53);' }, reason: 'Underground Pass quest ending.' },
    { npc: 'grandtree_foreman', at: { file: `${S}quests/quest_grandtree/scripts/foreman.rs2`, needle: 'p_teleport(0_46_47_11_25);' }, reason: 'Grand Tree quest step (office cutscene).' },
    { npc: 'general_khazard', at: { file: `${S}quests/quest_arena/scripts/general_khazard.rs2`, needle: 'p_teleport(0_40_49_45_5);' }, reason: 'Fight Arena quest jail.' },
    { npc: 'captain_siad', at: { file: `${S}quests/quest_desertrescue/scripts/captain_siad.rs2`, needle: 'p_teleport(^desertrescue_prison_coord);' }, reason: 'Desert mining camp jail.' },
    { npc: 'desertminingmercenary2', at: { file: `${S}quests/quest_desertrescue/scripts/camp_guard.rs2`, needle: 'p_teleport(^desertrescue_underground_prison_coord);' }, reason: 'Desert mining camp jail.' },
    { npc: 'bedabin_guard', at: { file: `${S}quests/quest_desertrescue/scripts/bedabin_nomad_guard.rs2`, needle: 'p_teleport(0_49_47_33_38);' }, reason: 'Tent doorway step.' },
    { npc: 'grandtree_glough', at: { file: `${S}quests/quest_grandtree/scripts/glough.rs2`, needle: 'p_telejump(^grandtree_jail_coord);' }, reason: 'Grand Tree quest jail.' },
    { npc: 'grandtree_narnode', at: { file: `${S}quests/quest_grandtree/scripts/king_narnode.rs2`, needle: 'p_telejump(movecoord(coord, -1, 0, 6399));' }, reason: 'Grand Tree quest trapdoor step.' },
];

const SAIL_PROCS = new Set(['~set_sail(', '~set_sail_cairn(', '~misc_longship_sail(']);

// ---- gangplanks for deck arrivals ----
function gangplanks(): { name: string; id: number; x: number; z: number; level: number; src: string }[] {
    const locBlocks = listConfigFiles('.loc').flatMap(f => parseConfigs(readFileSync(join(root, f), 'utf8'), f));
    const names = new Set(locBlocks.filter(b => b.props.category?.[0] === 'gangplank_disembark').map(b => b.name));
    const ids = new Map<number, string>();
    for (const [id, name] of parsePack(readFileSync(join(root, 'pack/loc.pack'), 'utf8'))) if (names.has(name)) ids.set(id, name);
    const out: { name: string; id: number; x: number; z: number; level: number; src: string }[] = [];
    for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) {
        for (const l of parseJm2(f, readFileSync(join(root, 'maps', f), 'utf8')).locs) {
            const name = ids.get(l.id);
            if (name) out.push({ name, id: l.id, x: l.x, z: l.z, level: l.level, src: l.src });
        }
    }
    return out;
}

export function buildNpcTravel(): { records: TravelRecord[]; excluded: ExcludedRecord[] } {
    const planks = gangplanks();
    const disembark = find(`${S}general_use/scripts/gangplank.rs2`, '[oploc1,_gangplank_disembark]').src;
    const records: TravelRecord[] = [];
    for (const s of SPECS) {
        const npc = npcs.get(s.npc);
        if (!npc) throw new Error(`npc-travel: ${s.npc} not in npcs.json`);
        const block = npcBlocks.get(s.npc);
        const trig = hitAt(s.trigger);
        const opLabel = block?.props[`op${s.op}`]?.[0] ?? null;
        const opSrc = block?.propLines[`op${s.op}`]?.[0] ? `${block.file}:${block.propLines[`op${s.op}`]![0]}` : null;
        if (s.trigger.needle.startsWith('[opnpc1,_')) {
            const cat = s.trigger.needle.slice(9, -1);
            if (block?.props.category?.[0] !== cat) throw new Error(`npc-travel: ${s.npc} is not in category ${cat}`);
        }
        const options = (s.options ?? []).map(o => {
            const text = typeof o === 'string' ? o : o.text, file = typeof o === 'string' ? s.optionsFile! : o.file;
            return { text, src: find(file, `"${text}"`).src };
        });
        let to: TravelRecord['to'] = null;
        let toCandidates: SrcTile[] | undefined;
        let returnTo: TravelRecord['returnTo'];
        let candidateRadius: TravelRecord['candidateRadius'];
        if (s.candidates) {
            const head = find(s.candidates.file, '[essence_mine_teleports]').n;
            toCandidates = lines(s.candidates.file).flatMap((t, i) => {
                const m = i >= head && t.match(/^val=\d+,(\d+_\d+_\d+_\d+_\d+)$/);
                return m ? [{ ...parseCoord(m[1]!), src: `${s.candidates!.file}:${i + 1}` }] : [];
            });
            const rh = hitAt(s.candidates.returnRadius), rc = constant(s.candidates.returnConst);
            returnTo = { ...parseCoord(rc.value), src: rc.src, radius: radiusOn(rh), radiusSrc: rh.src };
            if (s.to?.radius) { const r = hitAt(s.to.radius); candidateRadius = { radius: radiusOn(r), src: r.src }; }
        } else if (s.to) {
            const hit = hitAt(s.to.at);
            const c = coordOn(hit);
            const steps = [...c.steps];
            let { x, z, level } = c;
            for (const o of s.to.offsets ?? []) {
                const oh = hitAt(o), m = oh.text.match(MOVE);
                if (!m) throw new Error(`npc-travel: no movecoord on ${oh.src}`);
                x += Number(m[1]); level += Number(m[2]); z += Number(m[3]);
                steps.push(oh.src);
            }
            if ([...SAIL_PROCS].some(p => hit.text.includes(p))) {
                const proc = hit.text.includes('~set_sail(') ? find(F.sail, 'p_telejump($destination);') : hit.text.includes('~set_sail_cairn(') ? find(F.shanks, 'p_telejump($destination);') : find(F.miscSailor, 'p_telejump($dest);');
                steps.push(proc.src);
            }
            to = { x, z, level, raw: c.raw, src: c.src, steps };
            if (s.to.radius) { const r = hitAt(s.to.radius); to.radius = radiusOn(r); to.radiusSrc = r.src; }
        }
        let fromRows = npc.spawns;
        let fromFilter: TravelRecord['fromFilter'];
        if (s.from) { fromRows = fromRows.filter(s.from.keep); fromFilter = { rule: s.from.rule, src: hitAt(s.from.at).src }; }
        const fare: TravelRecord['fare'] = 'at' in s.fare && !Array.isArray(s.fare.at)
            ? (() => { const h = hitAt(s.fare.at as At); const m = h.text.match(/coins,\s*(\d+)/); if (!m || Number(m[1]) !== s.fare.coins) throw new Error(`npc-travel: fare mismatch on ${h.src}`); return { coins: Number(m[1]), src: h.src }; })()
            : 'free' in s.fare ? { coins: 0, src: null, rule: s.fare.free }
            : { coins: null, src: null, rule: (s.fare as { rule: string }).rule, ruleSrc: (s.fare.at as At[]).map(a => hitAt(a).src) };
        const requires = (s.requires ?? []).map(r => {
            const names = Array.isArray(r.constant) ? r.constant : [r.constant];
            return { varp: r.varp, op: r.op, constant: r.constant, value: Array.isArray(r.constant) ? names.map(num) : num(names[0]!), src: hitAt(r.at).src };
        });
        let deck: TravelRecord['deck'] = { onDeck: false };
        if (to && to.level === 1) {
            const near = planks.filter(p => p.level === 1).map(p => ({ p, d: Math.max(Math.abs(p.x - to!.x), Math.abs(p.z - to!.z)) })).sort((a, b) => a.d - b.d)[0];
            deck = { onDeck: true, ...(near && near.d <= 8 ? { gangplank: { loc: near.p.name, id: near.p.id, x: near.p.x, z: near.p.z, level: near.p.level, distance: near.d, src: near.p.src, handler: disembark } } : {}) };
        }
        const gaps = [...(s.gaps ?? [])];
        if (deck.onDeck && !deck.gangplank) gaps.push('Arrival is on a ship deck (level 1) but no gangplank_disembark loc lies within 8 tiles.');
        if (!fromRows.length) gaps.push('No static spawn matches this NPC branch.');
        if (!opLabel) gaps.push(`npc config has no op${s.op} label.`);
        records.push({
            id: `${s.npc}:${s.destination.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
            kind: s.kind, destination: s.destination,
            npc: { debugname: npc.debugname, name: npc.name, id: npc.id, src: npc.src },
            op: { index: s.op, label: opLabel, src: opSrc, trigger: trig.src },
            options,
            ...(s.button ? { button: { component: s.button.component, src: hitAt(s.button).src } } : {}),
            from: fromRows, ...(fromFilter ? { fromFilter } : {}),
            to, ...(toCandidates ? { toCandidates, candidateRadius } : {}), ...(returnTo ? { returnTo } : {}),
            fare,
            items: (s.items ?? []).map(i => ({ item: i.item, use: i.use, src: hitAt(i.at).src })),
            requires,
            members: s.members ? { checked: true, src: hitAt(s.members).src } : { checked: false },
            deck, notes: s.notes ?? [], gaps,
        });
    }
    const ids = new Set<string>();
    for (const r of records) { if (ids.has(r.id)) throw new Error(`npc-travel: duplicate id ${r.id}`); ids.add(r.id); }
    const excluded = EXCLUDED.map(e => ({ npc: e.npc, src: hitAt(e.at).src, reason: e.reason }));
    return { records, excluded };
}

if (import.meta.main) {
    const { records, excluded } = buildNpcTravel();
    const absent = ['charter', 'carpet', 'balloon (transport)', 'canoe', 'Pest Control', "Mos Le'Harmless", 'Lunar Isle', 'Port Phasmatys', 'Abyss (Mage of Zamorak)'];
    writeFileSync(join(knowledgeDir(), 'npc-travel.json'), JSON.stringify({
        note: 'Generated by bun packages/knowledge/src/npc-travel.ts. Do not edit by hand. src is content-relative path:line.',
        absent: { kinds: absent, evidence: 'No .npc or .loc config name or debugname in content matches these travel methods; party room balloons are not transport.' },
        records, excluded,
    }, null, 1) + '\n');
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    console.log(`npc-travel: ${records.length} records, ${excluded.length} excluded`);
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
}
