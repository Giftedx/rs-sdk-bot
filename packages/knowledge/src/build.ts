import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { parseJm2, type LocSpawn, type Spawn } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';
import { buildItems } from './items';
import { buildNpcs } from './npcs';
import { buildShops } from './shops';
import { buildTransports, parseTransportHandlers, monkLadderSpawn, type Handler } from './transports';
import { classifyDoor, parseTriggers, openedTeamDoor,type OpenDoorVariant,type DoorKind, type DoorNeed } from './doors';
import { buildDbTables } from './dbtables';
import { buildSkillActions } from './skills';
import { buildQuests, parseConstants } from './quests';
import { parseDrops } from './drops';

interface Door { id: number; loc: string; x: number; z: number; level: number; angle?:number; shape?:number;open?:OpenDoorVariant; kind: DoorKind; need?: DoorNeed; trigger: string; src: string }

const root = contentRoot();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const blocksOf = (ext: string): ConfigBlock[] => listConfigFiles(ext).flatMap(f => parseConfigs(read(f), f));
const pack = (name: string) => parsePack(read(`pack/${name}.pack`));

const objPack = pack('obj');
const items = buildItems(blocksOf('.obj'), objPack);
const certs = [...objPack.values()].filter(n => n.startsWith('cert_')).length;

const npcSpawns: Spawn[] = [];
const locSpawns: LocSpawn[] = [];
for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) {
    const r = parseJm2(f, read(`maps/${f}`));
    npcSpawns.push(...r.npcs);
    locSpawns.push(...r.locs);
}
const npcs = buildNpcs(blocksOf('.npc'), pack('npc'), npcSpawns);
const shops = buildShops(blocksOf('.inv'));

const handlers: Handler[] = [];
const skipped: { locName: string; handler: string }[] = [];
const scriptFiles = listConfigFiles('.rs2').map(f => ({ text: read(f), file: f }));
const triggers = parseTriggers(scriptFiles);
const classified:{locName:string;handler:string;kind:string;reason:string}[]=[];
const ladderDir = 'scripts/ladders+stairs/scripts';
for (const f of readdirSync(join(root, ladderDir)).filter(f => f.endsWith('.rs2'))) {
    const r = parseTransportHandlers(read(`${ladderDir}/${f}`), `${ladderDir}/${f}`,{triggers});
    handlers.push(...r.handlers);
    skipped.push(...r.skipped);
    classified.push(...r.classified);
}
// Ladders that a script outside the ladder folder moves, by loc name. The Observatory has no way in or out on foot: its
// ladder (domeladderdown) goes down to the cavern, and two cavern ladders go up to the observatory (loc_2189) and to the
// reception (loc_2188). Each of the three moves with no condition. The reception ladder down (obs_dungeonladderdown) is
// not here: before the quest ends it opens a dialogue first, and a transport leg cannot answer one.
const namedLadders:Record<string,string[]>={
    'scripts/areas/area_falador/scripts/mining_guild.rs2':['miningguildladder'],
    'scripts/areas/monastery/scripts/prayer_guild.rs2':['monasteryladder'],
    'scripts/minigames/game_ranging/scripts/ranging_guild_door.rs2':['ranging_guild_door'],
    'scripts/quests/quest_itgronigen/scripts/quest_itgronigen.rs2':['loc_2188','loc_2189','domeladderdown'],
};
for(const [file,names] of Object.entries(namedLadders)){
    const r=parseTransportHandlers(read(file),file,{triggers});
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
const doors: Door[] = [];
for (const l of locSpawns) {
    if (l.shape > 3 && l.shape !== 9) continue;
    const name = locPack.get(l.id);
    const cfg = name ? locBlocks.get(name) : undefined;
    if (!name || !cfg) continue;
    const ops = Object.entries(cfg.props).filter(([k]) => /^op\d$/.test(k)).map(([, v]) => v[0]!);
    if (!ops.some(o => /^open$/i.test(o))) continue;
    const c = classifyDoor(name, cfg.props.category?.[0], triggers);
    const openName=cfg.props.param?.find(p=>p.startsWith('next_loc_stage,'))?.split(',')[1]?.trim(),openId=openName?locIds.get(openName):undefined;
    const open=c.kind==='team'&&openName===name+'_open'&&openId!==undefined?openedTeamDoor(name,l,openId):undefined;
    doors.push({ id: l.id, loc: name, x: l.x, z: l.z, level: l.level, ...(c.need?.whenAxis!==undefined?{angle:l.angle,shape:l.shape}:l.shape===9?{shape:9}:{}),...(open?{open}:{}),kind: c.kind, ...(c.need ? { need: c.need } : {}), trigger: c.trigger, src: l.src });
}
// Pickable plants (general_use/scripts/pickables.rs2: potato, wheat, onion, cabbage, flax, each with a Pick option):
// their tiles, so a bot finds the nearest field without reading the map squares at run time.
const PICKABLES = ['potato', 'wheat', 'onion', 'cabbage', 'flax'];
const pickables: Record<string, { name: string; tiles: { x: number; z: number; level: number }[] }> = {};
for (const name of PICKABLES) {
    const id = locIds.get(name);
    if (id === undefined) continue;
    pickables[id] = { name, tiles: locSpawns.filter(l => l.id === id).map(l => ({ x: l.x, z: l.z, level: l.level })) };
}
// Phase 1b: skill actions from dbtables, quests, and drop tables.
const dbTables = buildDbTables(blocksOf('.dbtable'), blocksOf('.dbrow'));
const skillActions = buildSkillActions(dbTables);
const questVarpFolders = new Map<string, string>();
for (const f of listConfigFiles('.varp').filter(f => f.startsWith('scripts/quests/'))) {
    for (const b of parseConfigs(read(f), f)) questVarpFolders.set(b.name, f.split('/')[2]!);
}
const questScripts = new Map<string, { text: string; file: string }[]>();
for (const s of scriptFiles.filter(s => s.file.startsWith('scripts/quests/'))) {
    const k = s.file.split('/')[2]!;
    questScripts.set(k, [...(questScripts.get(k) ?? []), s]);
}
const questFile = 'scripts/general/configs/quest.constant';
const procFile = 'scripts/general/scripts/quests.rs2';
const quests = buildQuests({ constants: parseConstants(read(questFile), questFile), proc: { text: read(procFile), file: procFile }, varpFolders: questVarpFolders, folderScripts: questScripts });
const drops = scriptFiles.flatMap(s => parseDrops(s.text, s.file));

const doorKinds: Record<string, number> = {};
for (const d of doors) doorKinds[d.kind] = (doorKinds[d.kind] ?? 0) + 1;

const out = knowledgeDir();
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 1) + '\n');
write('items.json', items);
write('npcs.json', npcs);
write('shops.json', shops);
write('transports.json', edges);
write('doors.json', doors);
write('dbtables.json', dbTables);
write('skills.json', skillActions);
write('quests.json', quests.quests);
write('drops.json', drops);
write('pickables.json', pickables);

const counts = {
    items: items.length,
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
    '- `skills.json`: one row per skill action from the skill dbtables; `xp` is whole XP (content stores tenths). Smithing XP lives in structs and is `null` for now.',
    '- `quests.json`: varp, complete value, quest points, and XP only from blocks that set the quest complete. The live Quest Points #1 has 141 QP; this build finds fewer (see questLinesSkipped).',
    '- `drops.json`: ai_queue3 tables and shared `label:` tables. Chances are per kill out of the roll die. Tables with two rolls are known to sum over 1.',
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
