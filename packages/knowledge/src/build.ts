import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFilesByExt, parseConfigs, type ConfigBlock } from './config';
import { parseJm2, type LocSpawn, type Spawn } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';
import { buildItems } from './items';
import { buildGear, paramDefaults, parsePvpSpecials, parseRequirements, parseStaffItems } from './gear';
import { buildNpcs } from './npcs';
import { buildShops } from './shops';
import { buildTransports, parseTransportHandlers, monkLadderSpawn, NAMED_TRANSPORT_FILES, type Handler } from './transports';
import { classifyDoor, parseTriggers, openedTeamDoor,type OpenDoorVariant,type DoorKind, type DoorNeed } from './doors';
import { buildDbTables } from './dbtables';
import { buildSkillActions } from './skills';
import { buildQuests, parseConstants } from './quests';
import { parseDrops, parseDropProcs, expandProcItems } from './drops';
import { parseScriptSources, parseShopNpcs, questNames, type GearSources } from './gear-sources';

interface Door { id: number; loc: string; x: number; z: number; level: number; angle?:number; shape?:number;open?:OpenDoorVariant; kind: DoorKind; need?: DoorNeed; trigger: string; src: string }

const root = contentRoot();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const filesByExt = listConfigFilesByExt(['.obj', '.rs2', '.param', '.npc', '.inv', '.loc', '.dbtable', '.dbrow', '.struct', '.varp', '.constant'], root);
const blockCache = new Map<string, ConfigBlock[]>();
const blocksOf = (ext: string): ConfigBlock[] => {
    let cached = blockCache.get(ext);
    if (!cached) {
        cached = (filesByExt.get(ext) ?? []).flatMap(f => parseConfigs(read(f), f));
        blockCache.set(ext, cached);
    }
    return cached;
};
const pack = (name: string) => parsePack(read(`pack/${name}.pack`));

const scriptFiles = filesByExt.get('.rs2')!.map(f => ({ text: read(f), file: f }));
const scriptTextByFile = new Map(scriptFiles.map(s => [s.file, s.text] as const));
const readScript = (rel: string) => scriptTextByFile.get(rel) ?? read(rel);

const objPack = pack('obj');
const objBlocks = blocksOf('.obj');
const items = buildItems(objBlocks, objPack);
const certs = [...objPack.values()].filter(n => n.startsWith('cert_')).length;
const requireFiles = scriptFiles.filter(s => s.file.includes('/levelrequire/'));
const pvpSpecialFile = 'scripts/skill_combat/scripts/pvp/pvp_special_attack.rs2';
const gear = buildGear(objBlocks, objPack, parseRequirements(requireFiles), parsePvpSpecials(readScript(pvpSpecialFile)), paramDefaults(blocksOf('.param')), parseStaffItems(scriptFiles));

const npcSpawns: Spawn[] = [];
const locSpawns: LocSpawn[] = [];
const emptyObjIds = new Set<number>();
for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2')).sort()) {
    const r = parseJm2(f, read(`maps/${f}`), { objIds: emptyObjIds });
    for (const n of r.npcs) npcSpawns.push(n);
    for (const l of r.locs) locSpawns.push(l);
}
const npcBlocks = blocksOf('.npc');
const npcs = buildNpcs(npcBlocks, pack('npc'), npcSpawns);
const shops = buildShops(blocksOf('.inv').filter(b => !b.file.endsWith('/skill_guide.inv') && !b.file.includes('/skill_crafting/') && !b.file.includes('/skill_smithing/')));

const handlers: Handler[] = [];
const skipped: { locName: string; handler: string }[] = [];
const triggers = parseTriggers(scriptFiles);
const classified:{locName:string;handler:string;kind:string;reason:string}[]=[];
const ladderDir = 'scripts/ladders+stairs/scripts';
for (const f of readdirSync(join(root, ladderDir)).filter(f => f.endsWith('.rs2')).sort()) {
    const rel = `${ladderDir}/${f}`;
    const r = parseTransportHandlers(readScript(rel), rel, { triggers });
    handlers.push(...r.handlers);
    skipped.push(...r.skipped);
    classified.push(...r.classified);
}
// Ladders that a script outside the ladder folder moves, by loc name. The Observatory has no way in or out on foot: its
// ladder (domeladderdown) goes down to the cavern, and two cavern ladders go up to the observatory (loc_2189) and to the
// reception (loc_2188). Each of the three moves with no condition. The reception ladder down (obs_dungeonladderdown) is
// not here: before the quest ends it opens a dialogue first, and a transport leg cannot answer one.
for(const [file,names] of Object.entries(NAMED_TRANSPORT_FILES)){
    const r=parseTransportHandlers(readScript(file),file,{triggers});
    handlers.push(...r.handlers.filter(h=>names.includes(h.locName)));
}
const locBlocks = new Map(blocksOf('.loc').map(b => [b.name, b]));
const locPack = pack('loc');
const dynamicSpawns=monkLadderSpawn({triggers},{text:read('scripts/quests/quest_drunkmonk/configs/quest_drunkmonk.constant'),file:'scripts/quests/quest_drunkmonk/configs/quest_drunkmonk.constant'},locPack);
const { edges, unmatchedAngles } = buildTransports(handlers, locSpawns, locPack,locBlocks,dynamicSpawns);

// Doors: wall-layer locs (shape 0-3) whose config has an Open option, like the engine's collision export
// (server/engine/src/web/pages/api.ts:171-248). Rules come from the door's own trigger, else its category's.
// A diagonal door (shape 9, the north door of Juliet's house at 3160,3440) blocks its whole tile; the export
// leaves it out, so it is kept here with its shape and core/src/pathcache.ts opens it.
const locIds=new Map([...locPack].map(([id,name])=>[name,id]));
const doorMetaCache = new Map<string, { c: ReturnType<typeof classifyDoor>; openName?: string; openId?: number } | null>();
const doorMetaFor = (name: string) => {
    let cached = doorMetaCache.get(name);
    if (cached !== undefined) return cached;
    const cfg = locBlocks.get(name);
    if (!cfg) { doorMetaCache.set(name, null); return null; }
    let hasOpen = false;
    for (const k in cfg.props) {
        if (k.length === 3 && k.startsWith('op') && k.charCodeAt(2) >= 48 && k.charCodeAt(2) <= 57 && /^open$/i.test(cfg.props[k]![0]!)) {
            hasOpen = true;
            break;
        }
    }
    if (!hasOpen) { doorMetaCache.set(name, null); return null; }
    const c = classifyDoor(name, cfg.props.category?.[0], triggers);
    const openName = cfg.props.param?.find(p => p.startsWith('next_loc_stage,'))?.split(',')[1]?.trim();
    const openId = openName ? locIds.get(openName) : undefined;
    cached = { c, openName, openId };
    doorMetaCache.set(name, cached);
    return cached;
};
const doors: Door[] = [];
for (const l of locSpawns) {
    if (l.shape > 3 && l.shape !== 9) continue;
    const name = locPack.get(l.id);
    if (!name) continue;
    const meta = doorMetaFor(name);
    if (!meta) continue;
    const { c, openName, openId } = meta;
    const open=c.kind==='team'&&openName===name+'_open'&&openId!==undefined?openedTeamDoor(name,l,openId):undefined;
    doors.push({ id: l.id, loc: name, x: l.x, z: l.z, level: l.level, ...(c.need?.whenAxis!==undefined?{angle:l.angle,shape:l.shape}:l.shape===9?{shape:9}:{}),...(open?{open}:{}),kind: c.kind, ...(c.need ? { need: c.need } : {}), trigger: c.trigger, src: l.src });
}
// Pickable plants (general_use/scripts/pickables.rs2: potato, wheat, onion, cabbage, flax, each with a Pick option):
// their tiles, so a bot finds the nearest field without reading the map squares at run time.
const PICKABLES = ['potato', 'wheat', 'onion', 'cabbage', 'flax'];
const pickables: Record<string, { name: string; tiles: { x: number; z: number; level: number }[] }> = {};
const pickableById = new Map<number, { x: number; z: number; level: number }[]>();
for (const name of PICKABLES) {
    const id = locIds.get(name);
    if (id === undefined) continue;
    const tiles: { x: number; z: number; level: number }[] = [];
    pickables[id] = { name, tiles };
    pickableById.set(id, tiles);
}
for (const l of locSpawns) {
    const tiles = pickableById.get(l.id);
    if (tiles) tiles.push({ x: l.x, z: l.z, level: l.level });
}
// Phase 1b: skill actions from dbtables, quests, and drop tables.
const dbTables = buildDbTables(blocksOf('.dbtable'), blocksOf('.dbrow'));
const skillActions = buildSkillActions(dbTables, { objs: objBlocks, structs: blocksOf('.struct') });
const questVarpFolders = new Map<string, string>();
for (const f of filesByExt.get('.varp')!.filter(f => f.startsWith('scripts/quests/'))) {
    for (const b of parseConfigs(read(f), f)) questVarpFolders.set(b.name, f.split('/')[2]!);
}
const questScripts = new Map<string, { text: string; file: string }[]>();
for (const s of scriptFiles) {
    if (!s.file.startsWith('scripts/quests/')) continue;
    const k = s.file.split('/')[2]!;
    let list = questScripts.get(k);
    if (!list) questScripts.set(k, list = []);
    list.push(s);
}
const questFile = 'scripts/general/configs/quest.constant';
const questConstants = parseConstants(read(questFile), questFile);
for (const cf of filesByExt.get('.constant')!) {
    if (cf === questFile) continue;
    for (const [k, v] of parseConstants(read(cf), cf)) if (!questConstants.has(k)) questConstants.set(k, v);
}
const procFile = 'scripts/general/scripts/quests.rs2';
const quests = buildQuests({ constants: questConstants, proc: { text: readScript(procFile), file: procFile }, varpFolders: questVarpFolders, folderScripts: questScripts });
const drops = scriptFiles.flatMap(s => parseDrops(s.text, s.file));
// Items a roll on a shared drop proc (~randomherb, ~randomjewel, ~ultrarare_getitem, then ~megararetable) can give.
const dropProcs = new Map(scriptFiles.flatMap(s => [...parseDropProcs(s.text, s.file)]));
expandProcItems(drops, dropProcs);

const doorKinds: Record<string, number> = {};
for (const d of doors) doorKinds[d.kind] = (doorKinds[d.kind] ?? 0) + 1;

const questListFile = 'scripts/player/interfaces/questlist.if';
const questListNames = new Map(parseConfigs(read(questListFile), questListFile).filter(b => b.props.buttontype?.[0] === 'normal' && b.props.text?.[0]).map(b => [b.name, b.props.text![0]!] as const));
const spawnsByNpc = new Map(npcs.map(n => [n.debugname, n.spawns.map(s => ({ x: s.x, z: s.z, level: s.level }))] as const));
const scriptSources = parseScriptSources(scriptFiles, new Map(gear.map(g => [g.debugname, g.id] as const)), questNames(quests.quests, questListNames));
const gearSources: GearSources = {
    ...scriptSources,
    npc: scriptSources.npc.map(r => ({ ...r, at: spawnsByNpc.get(r.npc) ?? [] })),
    shopNpcs: parseShopNpcs(npcBlocks, name => spawnsByNpc.get(name) ?? []),
};

const out = knowledgeDir();
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 1) + '\n');
write('items.json', items);
write('gear.json', gear);
write('npcs.json', npcs);
write('shops.json', shops);
write('transports.json', edges);
write('doors.json', doors);
write('dbtables.json', dbTables);
write('skills.json', skillActions);
write('quests.json', quests.quests);
write('drops.json', drops);
write('pickables.json', pickables);
write('gear-sources.json', gearSources);

const counts = {
    items: items.length,
    gear: gear.length,
    certsExcluded: certs,
    npcs: npcs.length,
    npcSpawns: npcSpawns.length,
    shops: shops.length,
    shopStockLines: shops.reduce((n, s) => n + s.stock.length, 0),
    transportHandlers: handlers.length,
    transportEdges: edges.length,
    transportPhysicalEdges:edges.filter(e=>!e.unplaced).length,
    transportInteractionGeometry:edges.filter(e=>e.interaction).length,
    transportInteractionUnknown:edges.filter(e=>!e.interaction&&!e.canonical).length,
    transportDynamic:edges.filter(e=>e.dynamic).length,
    transportSuperseded:edges.filter(e=>e.canonical).length,
    transportSkipped: skipped.length,
    transportMenuCovered:classified.filter(c=>c.kind==='menu-covered').length,
    transportNoMovement:classified.filter(c=>c.kind==='no-movement').length,
    unmatchedAngles,
    dbTables: dbTables.length,
    skillActions: skillActions.length,
    quests: quests.quests.length,
    questPoints: quests.quests.reduce((n, q) => n + q.questPoints, 0),
    questLinesSkipped: quests.skipped.length,
    dropTables: drops.length,
    gearSourceNpc: gearSources.npc.length,
    gearSourceQuest: gearSources.quest.length,
    gearSourceClue: gearSources.clue.length,
    gearShopNpcs: gearSources.shopNpcs.length,
    pickablePlants: Object.values(pickables).reduce((n, p) => n + p.tiles.length, 0),
    doors: doors.length,
    ...Object.fromEntries(Object.entries(doorKinds).map(([k, v]) => [`doors_${k}`, v])),
};
writeFileSync(join(out, 'BUILD.md'), [
    '# Knowledge build',
    '',
    'Generated by `bun packages/knowledge/src/build.ts` from `vendor/rs-sdk/server/content` (rev 289). Do not edit by hand.',
    'Every record has `src`: a path and 1-based line, relative to the content root.',
    '',
    '## Counts',
    '',
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Notes',
    '',
    '- `cost` is the static config value. The Equipment and Bank hiscore boards score this, not market price.',
    '- Banknotes (`cert_*`) are generated by the pack tool and have no config. They are not in items.json.',
    '- `transports.json` holds ladder and stair edges only. Superseded literal rows retain their source and a verified canonical physical route; consumers dispatch its actual loc ID.',
    '- Dynamic transports require a current own-client exact loc observation. Spawn timer/geometry provenance does not establish current availability.',
    '- `doors.json`: wall-layer locs with an Open option, classified from their trigger. About 1459 of the `locked` doors are `macro_maze_wallhigh` walls in the sealed random-event maze (random events are off on this server). `unknown` means the trigger shape was not understood; the router treats those as blocked.',
    '',
    '- `skills.json`: one row per skill action from the skill dbtables; `xp` is whole XP (content stores tenths). Firemaking rows come from the log objects, herblore rows from `brew_potion.struct`, smelting rows from `smelting.struct`; an anvil row takes `bar_amount` x `xpperbar` of its bar struct. `xp` is `null` where the content holds none (a herblore unfinished potion).',
    '- `quests.json`: varp, complete value, quest points, and XP only from blocks that set the quest complete across all 68 quests.',
    '- `drops.json`: ai_queue3 tables and shared `label:` tables. Chances are per kill out of the roll die. Tables with two rolls are known to sum over 1.',
    '- `gear-sources.json`: where a wearable item comes from outside a shop stock line. `npc` rows are `inv_add` calls in a script file with an NPC trigger (a coin check above the call is the price; `gate` is the first `if` of the trigger, with its quest when the file is in a quest folder or the text holds a quest varp). A row whose gate names no quest, a free row with no gate, and a call after the loss of another item (an exchange) are left out. `quest` rows are the same calls in a quest folder without a price, or in a `*complete*` queue. `clue` rows are the clue reward procs. `shopNpcs` maps each `owned_shop` NPC to its spawn tiles.',
    '',
    '## Skipped quest lines (condition form not understood)',
    '',
    ...(quests.skipped.length ? quests.skipped.map(s => `- ${s.line}: \`${s.text}\``) : ['- none']),
    '',
    '## Skipped transport handlers (shape not understood, not guessed)',
    '',
    ...(skipped.length ? skipped.map(s => `- ${s.locName} (${s.handler})`) : ['- none']),
    '',
].join('\n'));
console.log(JSON.stringify(counts));
