import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs } from '../config';
import { parseJm2 } from '../jm2';
import { parsePack } from '../pack';
import { contentRoot, knowledgeDir } from '../paths';
import { inWilderness, json, read, sourceTiles, type MakeSource, type Place, type Rung, type Tile, type ToolRec } from './model';
import { loadBowMakes, loadFood, loadNpcAndShopData, loadSmeltRecipes, loadTanning, type KnowledgeDbTable, type KnowledgeDrop, type KnowledgeItem, type KnowledgeNpc, type KnowledgeShop, type ShopOwnerSpec, type ToolsFile } from './recipes';

export interface ScriptAction { trigger: string; subject: string; src: string }

export interface SourceCatalog {
    byName: Map<string, KnowledgeItem>;
    ladders: Rung[];
    toolsFile: ToolsFile;
    shops: KnowledgeShop[];
    drops: KnowledgeDrop[];
    npcByName: Map<string, KnowledgeNpc>;
    tablesByName: Map<string, KnowledgeDbTable>;
    stackable: Set<string>;
    npcsInCategory: Map<string, string[]>;
    shopOwners: Map<string, ShopOwnerSpec[]>;
    deathDrop: Map<string, { item: string; src: string }>;
    attackable: Set<string>;
    smelt: Map<string, { item: string; count: number; src: string }[]>;
    food: Map<string, { heal: number; src: string }>;
    bowMakes: Map<string, MakeSource[]>;
    tanning: Map<string, MakeSource>;
    needed: Map<string, Set<string>>;
    makers: Map<string, Rung[]>;
    actions: Map<string, ScriptAction[]>;
    objSpawns: Map<string, (Tile & { src: string; count: number })[]>;
    readCached: (rel: string) => string;
    linesOf: (rel: string) => string[];
    npcPlace: (name: string) => Place;
    locPlace: (name: string) => Place;
    npcsFor: (name: string) => string[];
    dbRow: (table: string, row: string) => KnowledgeDbTable['rows'][number] | undefined;
    inputsOf: (r: Rung, item: string) => { item: string; count: number | null }[];
    recsFor: (r: Rung) => ToolRec[];
    toolGroups: (r: Rung) => string[][];
    baitOf: (r: Rung) => string[];
}

function collectNeededAndMakers(
    ladders: readonly Rung[],
    toolGroups: (r: Rung) => string[][],
    baitOf: (r: Rung) => string[],
    inputsOf: (r: Rung, item: string) => { item: string; count: number | null }[],
    food: ReadonlyMap<string, { heal: number; src: string }>,
    bowMakes: ReadonlyMap<string, MakeSource[]>,
    tanning: ReadonlyMap<string, MakeSource>,
) {
    const needed = new Map<string, Set<string>>();
    const need = (item: string | null | undefined, by: string) => {
        if (!item || item === 'coins' || item.startsWith('_')) return false;
        const fresh = !needed.has(item);
        if (fresh) needed.set(item, new Set());
        needed.get(item)!.add(by);
        return fresh;
    };
    for (const r of ladders) {
        for (const i of r.inputs) need(i.debugname, r.id);
        for (const q of r.requires) need(q.debugname, `${r.id} (requires)`);
        for (const g of toolGroups(r)) for (const it of g) need(it, `${r.id} (tool)`);
        for (const b of baitOf(r)) need(b, `${r.id} (bait)`);
    }
    for (const r of ladders) if (r.skill === 'cooking') for (const o of r.outputs) if (food.has(o.debugname)) need(o.debugname, 'food (combat rungs)');

    const makers = new Map<string, Rung[]>();
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const r of ladders) for (const o of r.outputs) if (o.debugname) push(makers, o.debugname, r);
    for (let grew = true; grew;) {
        grew = false;
        for (const item of [...needed.keys()]) for (const r of makers.get(item) ?? []) {
            for (const i of inputsOf(r, item)) grew = need(i.item, `${r.id} (makes ${item})`) || grew;
            for (const g of toolGroups(r)) for (const it of g) grew = need(it, `${r.id} (tool for ${item})`) || grew;
            for (const b of baitOf(r)) grew = need(b, `${r.id} (bait for ${item})`) || grew;
        }
        for (const item of [...needed.keys()]) for (const m of [...(bowMakes.get(item) ?? []), ...(tanning.has(item) ? [tanning.get(item)!] : [])]) {
            for (const i of m.inputs) grew = need(i.item, `${m.src} (makes ${item})`) || grew;
            for (const g of m.tools) for (const it of g) grew = need(it, `${m.src} (tool for ${item})`) || grew;
        }
    }
    return { needed, makers };
}

function collectScriptActions(
    rs2: readonly string[],
    readCached: (rel: string) => string,
    linesOf: (rel: string) => string[],
    needed: ReadonlyMap<string, Set<string>>,
    makers: ReadonlyMap<string, Rung[]>,
): Map<string, ScriptAction[]> {
    // Script actions that add a needed item to the pack (`inv_add(inv, item, ...)`): the trigger around the call, or the
    // triggers that call its proc or label. Skill scripts are left out for items a rung already makes or gathers.
    const actions = new Map<string, ScriptAction[]>();
    const callers = new Map<string, { trigger: string; subject: string }[]>();
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const f of rs2) {
        const text = readCached(f);
        if (!text.includes('~') && !text.includes('@')) continue;
        let trig = '', subj = '';
        for (const line of linesOf(f)) {
            if (line.charCodeAt(0) === 91) {
                const h = line.match(/^\[(\w+),([^\]]+)\]/);
                if (h) { trig = h[1]!; subj = h[2]!; continue; }
            }
            if (!trig || (!line.includes('~') && !line.includes('@'))) continue;
            for (const c of line.matchAll(/[~@](\w+)/g)) push(callers, c[1]!, { trigger: trig, subject: subj });
        }
    }
    const entryTriggers = (name: string, depth = 0): { trigger: string; subject: string }[] => (callers.get(name) ?? []).flatMap(c =>
        c.trigger === 'proc' || c.trigger === 'label' ? (depth < 2 && c.subject !== name ? entryTriggers(c.subject, depth + 1) : []) : [c]);
    for (const f of rs2) {
        if (!readCached(f).includes('inv_add')) continue;
        let trig = '', subj = '';
        const lines = linesOf(f);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.charCodeAt(0) === 91) {
                const h = line.match(/^\[(\w+),([^\]]+)\]/);
                if (h) { trig = h[1]!; subj = h[2]!; continue; }
            }
            if (!line.includes('inv_add')) continue;
            const m = line.match(/inv_add\(inv,\s*(\w+),/);
            if (!m || !needed.has(m[1]!) || (f.startsWith('scripts/skill_') && makers.has(m[1]!))) continue;
            const at = trig === 'proc' || trig === 'label' ? entryTriggers(subj).slice(0, 4) : [{ trigger: trig, subject: subj }];
            let list = actions.get(m[1]!);
            if (!list) { list = []; actions.set(m[1]!, list); }
            for (const a of at) if (!list.some(x => x.trigger === a.trigger && x.subject === a.subject)) list.push({ ...a, src: `${f}:${i + 1}` });
        }
    }
    return actions;
}

function collectMapSpawns(
    ladders: readonly Rung[],
    actions: ReadonlyMap<string, ScriptAction[]>,
    needed: ReadonlyMap<string, Set<string>>,
    byName: ReadonlyMap<string, KnowledgeItem>,
) {
    // Loc and obj spawns for the locs gather rungs and script actions name, and the needed items.
    const locNames = new Set([...ladders.flatMap(r => r.where?.locs ?? []), ...[...actions.values()].flat().filter(a => a.trigger.includes('loc')).map(a => a.subject)]);
    const locPack = parsePack(read('pack/loc.pack')), objPack = parsePack(read('pack/obj.pack'));
    const neededLocIds = new Set<number>();
    for (const [id, name] of locPack) if (locNames.has(name)) neededLocIds.add(id);
    const neededIds = new Set([...needed.keys()].map(n => byName.get(n)?.id).filter((x): x is number => x !== undefined));
    const locSpawns = new Map<string, (Tile & { src: string })[]>(), objSpawns = new Map<string, (Tile & { src: string; count: number })[]>();
    const jm2Filter = { locIds: neededLocIds, objIds: neededIds, npcs: false };
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const f of readdirSync(join(contentRoot(), 'maps')).filter(f => f.endsWith('.jm2')).sort()) {
        const m = parseJm2(f, read(`maps/${f}`), jm2Filter);
        for (const l of m.locs) push(locSpawns, locPack.get(l.id)!, l);
        for (const o of m.objs) push(objSpawns, objPack.get(o.id)!, o);
    }
    const locPlace = (name: string): Place => {
        const sp = locSpawns.get(name) ?? [];
        return { loc: name, spawns: sp.length, tiles: sourceTiles(sp), src: sp[0]?.src ?? null, wilderness: sp.length > 0 && sp.every(inWilderness) };
    };
    return { objSpawns, locPlace };
}

export function loadSourceCatalog(): SourceCatalog {
    const kdir = knowledgeDir();
    const items = json(join(kdir, 'items.json')) as KnowledgeItem[];
    const byName = new Map(items.map(i => [i.debugname, i]));
    const ladders = Object.values((json(join(kdir, 'ladders.json')) as { ladders: Record<string, Rung[]> }).ladders).flat();
    const toolsFile = json(join(kdir, 'skill-tools.json')) as ToolsFile;
    const shops = json(join(kdir, 'shops.json')) as KnowledgeShop[];
    const drops = json(join(kdir, 'drops.json')) as KnowledgeDrop[];
    const npcs = json(join(kdir, 'npcs.json')) as KnowledgeNpc[];
    const dbtables = json(join(kdir, 'dbtables.json')) as KnowledgeDbTable[];
    const npcByName = new Map(npcs.map(n => [n.debugname, n]));
    const tablesByName = new Map(dbtables.map(t => [t.table, t]));

    const textCache = new Map<string, string>(), lineCache = new Map<string, string[]>();
    const readCached = (rel: string): string => {
        let text = textCache.get(rel);
        if (text === undefined) { text = read(rel); textCache.set(rel, text); }
        return text;
    };
    const linesOf = (rel: string): string[] => {
        let lines = lineCache.get(rel);
        if (!lines) { lines = readCached(rel).split(/\r?\n/); lineCache.set(rel, lines); }
        return lines;
    };

    const stackable = new Set<string>();
    for (const f of listConfigFiles('.obj')) {
        const text = read(f);
        if (!text.includes('stackable=yes')) continue;
        for (const b of parseConfigs(text, f)) if (b.props.stackable?.[0] === 'yes') stackable.add(b.name);
    }
    const rs2 = listConfigFiles('.rs2');
    const { npcsInCategory, shopOwners, deathDrop, attackable } = loadNpcAndShopData(npcByName, rs2, readCached, linesOf);

    const npcPlace = (name: string): Place => {
        const n = npcByName.get(name);
        const sp = n?.spawns ?? [];
        return { npc: name, spawns: sp.length, tiles: sourceTiles(sp), src: sp[0]?.src ?? n?.src ?? null, wilderness: sp.length > 0 && sp.every(inWilderness) };
    };
    const npcsFor = (name: string) => name.startsWith('_')
        ? (npcsInCategory.get(name.slice(1)) ?? [])
        : (npcsInCategory.get(name)?.length && !npcByName.has(name) ? npcsInCategory.get(name)! : [name]);
    const dbRow = (table: string, row: string) => tablesByName.get(table)?.rows.find(r => r.name === row);

    const smelt = loadSmeltRecipes();
    const inputsOf = (r: Rung, item: string): { item: string; count: number | null }[] =>
        r.inputs.length || r.kind !== 'smelt' ? r.inputs.map(i => ({ item: i.debugname, count: i.count })) : (smelt.get(item) ?? []).map(({ item, count }) => ({ item, count }));

    const recsFor = (r: Rung) => toolsFile.records.filter(t => t.appliesTo.rungs.includes(r.id) && !/^(woodcutting\/axe|mining\/pickaxe)\//.test(t.id));
    const toolGroups = (r: Rung) => recsFor(r).flatMap(t => t.items.filter(i => i.role === 'tool' || i.role === 'access').map(i => i.anyOf.filter(x => !x.startsWith('_')))).filter(g => g.length);
    const baitOf = (r: Rung) => recsFor(r).flatMap(t => t.items.filter(i => i.role === 'bait').flatMap(i => i.anyOf));

    const food = loadFood();
    const bowMakes = loadBowMakes(tablesByName, toolsFile);
    const tanning = loadTanning(npcsFor, npcPlace);
    const { needed, makers } = collectNeededAndMakers(ladders, toolGroups, baitOf, inputsOf, food, bowMakes, tanning);
    const actions = collectScriptActions(rs2, readCached, linesOf, needed, makers);
    const { objSpawns, locPlace } = collectMapSpawns(ladders, actions, needed, byName);

    return {
        byName, ladders, toolsFile, shops, drops, npcByName, tablesByName, stackable,
        npcsInCategory, shopOwners, deathDrop, attackable, smelt, food, bowMakes, tanning,
        needed, makers, actions, objSpawns,
        readCached, linesOf, npcPlace, locPlace, npcsFor, dbRow, inputsOf, recsFor, toolGroups, baitOf,
    };
}
