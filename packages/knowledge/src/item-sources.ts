// Every supported source of every item a ladder rung consumes or requires, with a cost per source.
// Usage: bun packages/knowledge/src/item-sources.ts [--market <file>] [--owned] [--practice <dir>] [--out <file>]
//   writes knowledge/item-sources.json and knowledge/item-sources-gaps.md.
//   --market: GE snapshot, either .practice/coordinator/market-prices.json ({debugname: {at, ask, bid, sell}}) or a
//     research/market-*.json (scripts/market-snapshot.ts). Default: <practice>/coordinator/market-prices.json if it
//     exists, else the newest research/market-*.json.
//   --owned: fill the owned slot from <practice>/status/*.json and the other sides' fleet/snapshots. Live stock is not
//     committed, so the default output then is <practice>/coordinator/item-sources.json.
// Item set: rung inputs and requires (knowledge/ladders.json), the tools, bait and access items of the skill-tools
// records that apply to a rung (knowledge/skill-tools.json), healing food from the cooking outputs, and then the inputs
// and tools of every rung that makes or gathers an item already in the set, until the set stops growing.
// Every source cites a content-relative path and 1-based line under vendor/rs-sdk/server/content, or the snapshot file.
// Each cost keeps three numbers apart (helper ticks, coins, risk) and adds a wall-clock number; each says what it rests on.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { parseJm2 } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

// rates.ts:11 and rates.json measure XP per tick at the server's 25x; ladder xpPerAction is base content XP.
const XP_RATE = 25;
// research/supply-costs.md:20: the live server ticks every 400 ms.
const LIVE_TICK_SECONDS = 0.4;
// rates.json craft_air_runes_trade_loop evidence: a helper trade of one pack takes 12 ticks (scripts/measure/trade-supply.ts).
const TRADE_TICKS = 12;
const PACK_SLOTS = 28;
const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
// The shop buy button takes at most 10 per click (shop.rs2 inv_button4 buys 10); one click per tick is a model.
const SHOP_UNITS_PER_TICK = 10;
// Wilderness bounds (x 2944-3391, z 3520-3967, level 0): a model of where death drops items to other players.
const inWilderness = (t: { x: number; z: number }) => t.x >= 2944 && t.x < 3392 && t.z >= 3520 && t.z < 3968;
const GATHER_KINDS = new Set(['woodcutting_trees', 'mining_table', 'catch', 'pickpocket', 'stealing', 'trapped_chest']);

export type Basis = 'content' | 'model' | 'measured' | 'unknown';
export interface Cost {
    helperTicksPerUnit: number | null; ticksBasis: Basis; ticksNote: string;
    coinsPerUnit: number | null; coinsBasis: Basis; coinsNote: string;
    risk: number | null; riskBasis: Basis; riskNote: string;
    realSecondsPerUnit: number | null; realBasis: Basis; realNote: string;
}
export interface Tile { x: number; z: number; level: number }
export interface Place { npc?: string; loc?: string; spawns: number; tiles: Tile[]; src: string | null; wilderness: boolean }
interface Base { kind: string; src: string; blocked: string | null; gate: string | null; cost: Cost }
export interface GatherSource extends Base { kind: 'gather'; rung: string; skill: string; level: number; tools: string[][]; bait: string[]; places: Place[]; yieldPerAction: number | null; respawnTicks: number | null; respawnSrc: string | null; successChance: { low: number; high: number; src: string } | null }
export interface PickupSource extends Base { kind: 'pickup'; spawns: number; countPerSpawn: number; tiles: Tile[]; wilderness: boolean }
export interface ShopSource extends Base { kind: 'shop'; shop: string; owners: Place[]; basePrice: number; priceAtFullStock: number; stock: number; restockTicks: number | null; sellMultiplier: number; sellMultiplierSrc: string; delta: number }
export interface DropSource extends Base { kind: 'drop'; npc: string; combat: number | null; chance: number; countMin: number; countMax: number; conditional: boolean; condition: string | null; via: string | null; places: Place[] }
export interface ActionSource extends Base { kind: 'action'; trigger: string; subject: string; places: Place[] }
export interface MakeSource extends Base { kind: 'make'; rung: string | null; skill: string; level: number; inputs: { item: string; count: number | null }[]; outputs: string[]; tools: string[][] }
export interface GeSource extends Base { kind: 'ge'; at: string; ask: number | null; bid: number | null; sellers: number }
export interface OwnedSource extends Base { kind: 'owned'; at: string; total: number; holders: { account: string; count: number; side: string }[] }
export type Source = GatherSource | PickupSource | ShopSource | DropSource | MakeSource | ActionSource | GeSource | OwnedSource;
export interface Substitute { group: string; items: string[]; note: string; src: string }
export interface ItemSources {
    item: string; id: number | null; name: string | null; cost: number | null; members: boolean | null; tradeable: boolean | null; stackable: boolean;
    neededBy: string[]; substitutes: Substitute[];
    delivery: { scoredTicksPerTrade: number; helperTicksPerTrade: number; unitsPerTrade: number | null; basis: Basis; note: string };
    sources: Source[]; usable: number; blocked: boolean;
}
interface Rung {
    id: string; skill: string; level: number; kind: string; src: string; xpPerAction: number | null; xpPerTick: number | null; ticksPerAction?: number | null; timing?: { basis?: string } | null;
    inputs: { debugname: string; count: number | null }[]; outputs: { debugname: string; count: number | null }[]; requires: { debugname: string }[];
    where: { locs: string[]; npcs: string[] } | null; quest: { name: string } | null; members: boolean | null;
}
interface ToolRec { id: string; skill: string; appliesTo: { kinds: string[]; rungs: string[] }; items: { anyOf: string[]; role: string; src: string }[]; option?: { spot: string } }

const read = (rel: string) => readFileSync(join(contentRoot(), rel), 'utf8');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const blocksOf = (ext: string): ConfigBlock[] => listConfigFiles(ext).flatMap(f => parseConfigs(read(f), f));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const cost = (c: Partial<Cost>): Cost => ({
    helperTicksPerUnit: null, ticksBasis: 'unknown', ticksNote: '', coinsPerUnit: null, coinsBasis: 'unknown', coinsNote: '',
    risk: null, riskBasis: 'unknown', riskNote: '', realSecondsPerUnit: null, realBasis: 'unknown', realNote: '', ...c,
});

// Marginal price of buying one unit at stock `stock` of normal stock `base` (shop.rs2 calc_shop_value, price_mod).
export function shopUnitPrice(objCost: number, sell: number, delta: number, stock: number, base: number): number {
    const mod = Math.min(1000, Math.max(-5000, (stock - base) * delta));
    return Math.max(1, Math.floor((Math.max(100, sell - mod) * objCost) / 1000));
}

export interface Market { at: string; file: string; prices: Record<string, { ask: number | null; bid: number | null; sell: number }> }
export function readMarket(file: string): Market {
    const raw = json(file);
    // Shown relative to the checkout that holds it, so the output does not name this machine's folders.
    const norm = file.replace(/\\/g, '/'), cut = norm.search(/\/(\.practice|research)\//);
    const rel = cut >= 0 ? norm.slice(cut + 1) : norm;
    if (raw.items && raw.takenAt) {
        const prices: Market['prices'] = {};
        for (const [k, v] of Object.entries<any>(raw.items)) prices[k] = { ask: v.market?.ask ?? null, bid: v.market?.bid ?? null, sell: v.market?.sellQuantity ?? 0 };
        return { at: raw.takenAt, file: rel, prices };
    }
    const prices: Market['prices'] = {};
    let at = 0;
    for (const [k, v] of Object.entries<any>(raw)) { prices[k] = { ask: v.ask ?? null, bid: v.bid ?? null, sell: v.sell ?? 0 }; at = Math.max(at, v.at ?? 0); }
    return { at: new Date(at).toISOString(), file: rel, prices };
}

// Live holdings by account: this side's status files, then accounts other sides published. The main account is left out.
export function readOwned(practice: string, fleetDir: string): { at: string; accounts: { name: string; side: string; items: Map<number, number> }[] } {
    const out: { name: string; side: string; items: Map<number, number> }[] = [];
    const add = (s: any, side: string) => {
        // Live server only, as supply-bill.ts liveHelperStatuses: practice accounts hold nothing the fleet can trade.
        if (typeof s?.name !== 'string' || s.server !== LIVE_SERVER || s.name.toLowerCase() === 'haggis' || out.some(o => o.name.toLowerCase() === s.name.toLowerCase())) return;
        const items = new Map<number, number>();
        for (const r of [...(s.inventory ?? []), ...(s.equipment ?? []), ...(s.bank ?? [])]) {
            const id = r?.baseId ?? r?.id;
            if (Number.isInteger(id) && r.count > 0) items.set(id, (items.get(id) ?? 0) + r.count);
        }
        out.push({ name: s.name, side, items });
    };
    const files = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    for (const f of files(join(practice, 'status'))) { try { add(json(join(practice, 'status', f)), 'local'); } catch { /* partial write */ } }
    for (const f of files(fleetDir)) { try { const x = json(join(fleetDir, f)); for (const a of x.accounts ?? []) add(a, x.side ?? 'other'); } catch { /* partial write */ } }
    return { at: new Date().toISOString(), accounts: out };
}

export interface Options { market?: Market | null; owned?: ReturnType<typeof readOwned> | null }

export function buildItemSources(opts: Options = {}) {
    const kdir = knowledgeDir();
    const items = json(join(kdir, 'items.json')) as { id: number; name: string; debugname: string; cost: number; members: boolean; tradeable: boolean }[];
    const byName = new Map(items.map(i => [i.debugname, i]));
    const ladders = Object.values((json(join(kdir, 'ladders.json')) as { ladders: Record<string, Rung[]> }).ladders).flat();
    const toolsFile = json(join(kdir, 'skill-tools.json')) as { records: ToolRec[]; axes: { item: string; successChance: Record<string, { low: number; high: number; src: string }> }[] };
    const shops = json(join(kdir, 'shops.json')) as { inv: string; stock: { item: string; count: number; restockTicks: number | null; src: string }[] }[];
    const drops = json(join(kdir, 'drops.json')) as { trigger: string; always: any[]; rolls: any[]; uses?: string; src: string }[];
    const npcs = json(join(kdir, 'npcs.json')) as { debugname: string; combat: number; src: string; spawns: (Tile & { src: string })[] }[];
    const dbtables = json(join(kdir, 'dbtables.json')) as { table: string; rows: { name: string; data: Record<string, string[][]>; src: Record<string, string[]> }[] }[];
    const npcByName = new Map(npcs.map(n => [n.debugname, n]));

    // Stackable flag and npc params from config blocks.
    const stackable = new Set(blocksOf('.obj').filter(b => b.props.stackable?.[0] === 'yes').map(b => b.name));
    const npcBlocks = blocksOf('.npc');
    const npcsInCategory = new Map<string, string[]>();
    const shopOwners = new Map<string, { npc: string; sell: number; sellSrc: string; delta: number }[]>();
    // shopkeeper.param: shop_sell_multiplier default=100 (line 7), shop_delta default=10 (line 15).
    const SELL_DEFAULT = { v: 100, src: 'scripts/shop/configs/shopkeeper.param:7' }, DELTA_DEFAULT = 10;
    // npc_combat.param: death_drop default=bones (line 31).
    const DEATH_DEFAULT = { item: 'bones', src: 'scripts/skill_combat/configs/npc_combat.param:31' };
    const deathDrop = new Map<string, { item: string; src: string }>(), attackable = new Set<string>();
    for (const b of npcBlocks) {
        const cat = b.props.category?.[0];
        if (cat) npcsInCategory.set(cat, [...(npcsInCategory.get(cat) ?? []), b.name]);
        const params = new Map<string, { v: string; line: number }>();
        (b.props.param ?? []).forEach((p, i) => { const [k, ...v] = p.split(','); params.set(k!, { v: v.join(','), line: b.propLines.param![i]! }); });
        const dd = params.get('death_drop');
        if (dd) deathDrop.set(b.name, { item: dd.v, src: `${b.file}:${dd.line}` });
        if (b.props.op2?.[0] === 'Attack' && (npcByName.get(b.name)?.spawns.length ?? 0) > 0) attackable.add(b.name);
        const inv = params.get('owned_shop');
        if (!inv) continue;
        const sell = params.get('shop_sell_multiplier'), delta = params.get('shop_delta');
        shopOwners.set(inv.v, [...(shopOwners.get(inv.v) ?? []), {
            npc: b.name, sell: sell ? Number(sell.v) : SELL_DEFAULT.v, sellSrc: sell ? `${b.file}:${sell.line}` : SELL_DEFAULT.src, delta: delta ? Number(delta.v) : DELTA_DEFAULT,
        }]);
    }
    // ~openshop(inv, buy, sell, delta, title) calls: the shop's NPC is the opnpc trigger around the call, or the
    // opnpc trigger that calls the enclosing proc.
    const rs2 = listConfigFiles('.rs2');
    const procCallers = new Map<string, string[]>();
    const openshopCalls: { inv: string; sell: number; delta: number; src: string; trigger: string; subject: string }[] = [];
    for (const f of rs2) {
        const text = read(f);
        if (!text.includes('~')) continue;
        let trig = '', subj = '';
        text.split(/\r?\n/).forEach((line, i) => {
            const h = line.match(/^\[(\w+),([^\]]+)\]/);
            if (h) { trig = h[1]!; subj = h[2]!; }
            const m = line.match(/~openshop\((\w+),\s*(\d+),\s*(\d+),\s*(\d+)/);
            if (m) openshopCalls.push({ inv: m[1]!, sell: Number(m[3]), delta: Number(m[4]), src: `${f}:${i + 1}`, trigger: trig, subject: subj });
            for (const c of line.matchAll(/~(\w+)/g)) if (trig.startsWith('opnpc')) procCallers.set(c[1]!, [...(procCallers.get(c[1]!) ?? []), subj]);
        });
    }
    for (const c of openshopCalls) {
        const npcsFor = c.trigger.startsWith('opnpc') ? [c.subject] : c.trigger === 'proc' ? (procCallers.get(c.subject) ?? []) : [];
        for (const n of new Set(npcsFor)) shopOwners.set(c.inv, [...(shopOwners.get(c.inv) ?? []), { npc: n, sell: c.sell, sellSrc: c.src, delta: c.delta }]);
    }

    const npcPlace = (name: string): Place => {
        const n = npcByName.get(name);
        const sp = n?.spawns ?? [];
        return { npc: name, spawns: sp.length, tiles: sp.slice(0, 3).map(({ x, z, level }) => ({ x, z, level })), src: sp[0]?.src ?? n?.src ?? null, wilderness: sp.length > 0 && sp.every(inWilderness) };
    };
    const npcsFor = (name: string) => name.startsWith('_') ? (npcsInCategory.get(name.slice(1)) ?? []) : (npcsInCategory.get(name)?.length && !npcByName.has(name) ? npcsInCategory.get(name)! : [name]);

    const tablesByName = new Map(dbtables.map(t => [t.table, t]));
    const dbRow = (table: string, row: string) => tablesByName.get(table)?.rows.find(r => r.name === row);

    // Tool records per rung, and substitutes from records with several items.
    // Smelting recipes (skill_smithing/configs/smelting/smelting.struct): ladders.json smelt rungs list no inputs.
    const smelt = new Map<string, { item: string; count: number; src: string }[]>();
    for (const b of parseConfigs(read('scripts/skill_smithing/configs/smelting/smelting.struct'), 'scripts/skill_smithing/configs/smelting/smelting.struct')) {
        const p = new Map<string, { v: string; src: string }>();
        (b.props.param ?? []).forEach((x, i) => { const [k, ...v] = x.split(','); p.set(k!, { v: v.join(','), src: `${b.file}:${b.propLines.param![i]}` }); });
        const product = p.get('product')?.v, first = p.get('ingredient'), second = p.get('ingredient_secondary');
        if (!product || !first) continue;
        smelt.set(product, [{ item: first.v, count: Number(p.get('bar_count')?.v ?? 1), src: first.src }, ...(second ? [{ item: second.v, count: Number(p.get('ingredient_secondary_count')?.v ?? 1), src: second.src }] : [])]);
    }
    const inputsOf = (r: Rung, item: string): { item: string; count: number | null }[] =>
        r.inputs.length || r.kind !== 'smelt' ? r.inputs.map(i => ({ item: i.debugname, count: i.count })) : (smelt.get(item) ?? []).map(({ item, count }) => ({ item, count }));

    // The nearest `if` that encloses a content line (less indented, up to 6 lines above), or null.
    const enclosingIf = (src: string): string | null => {
        const i = src.lastIndexOf(':'), lines = read(src.slice(0, i)).split(/\r?\n/), at = Number(src.slice(i + 1)) - 1;
        const indent = (s: string) => s.match(/^\s*/)![0].length;
        for (let k = at - 1; k >= Math.max(0, at - 6); k--) if (/\bif\s*\(/.test(lines[k]!) && indent(lines[k]!) < indent(lines[at]!)) return lines[k]!.trim();
        return null;
    };
    // A branch nested only in `if (map_members = ^true)` is open on this members world (vendor/rs-sdk/fly.toml).
    const MEMBERS_ONLY = /^(\}\s*else\s*)?if\s*\(\s*map_members\s*=\s*\^?true\s*\)\s*\{?$/;

    const recsFor = (r: Rung) => toolsFile.records.filter(t => t.appliesTo.rungs.includes(r.id) && !/^(woodcutting\/axe|mining\/pickaxe)\//.test(t.id));
    const toolGroups = (r: Rung) => recsFor(r).flatMap(t => t.items.filter(i => i.role === 'tool' || i.role === 'access').map(i => i.anyOf.filter(x => !x.startsWith('_')))).filter(g => g.length);
    const baitOf = (r: Rung) => recsFor(r).flatMap(t => t.items.filter(i => i.role === 'bait').flatMap(i => i.anyOf));

    // Food: consume_table rows that heal hitpoints (player/configs/consumption/*.dbrow).
    const food = new Map<string, { heal: number; src: string }>();
    for (const f of ['scripts/player/configs/consumption/consume_normal.dbrow', 'scripts/player/configs/consumption/consume_effects.dbrow']) {
        for (const b of parseConfigs(read(f), f)) {
            if (b.props.table?.[0] !== 'consume_table') continue;
            const heal = (b.props.data ?? []).find(d => d.startsWith('stat_heal,hitpoints,'));
            const n = heal ? Number(heal.split(',')[2]) : 0;
            if (n > 0) (b.props.data ?? []).forEach((d, i) => { if (d.startsWith('consumable,')) food.set(d.slice(11), { heal: n, src: `${f}:${b.propLines.data![i]}` }); });
        }
    }

    // Cutting logs into unstrung bows (fletch_bow_table, cut_logs.dbrow): ladders.json leaves these out (no level column
    // there); the row gives [bow, level, XP in tenths]. The knife comes from the fletching/cut-logs tool record.
    const bowMakes = new Map<string, MakeSource[]>();
    const knife = toolsFile.records.find(t => t.id === 'fletching/cut-logs')?.items.filter(i => i.role === 'tool').map(i => i.anyOf) ?? [];
    for (const row of tablesByName.get('fletch_bow_table')?.rows ?? []) {
        const log = row.data.log?.[0]?.[0];
        for (const col of ['shortbow', 'longbow']) {
            const v = row.data[col]?.[0];
            if (!v || !log) continue;
            bowMakes.set(v[0]!, [...(bowMakes.get(v[0]!) ?? []), {
                kind: 'make', rung: null, skill: 'fletching', level: Number(v[1]), inputs: [{ item: log, count: 1 }], outputs: [v[0]!], tools: knife,
                src: row.src[col]![0]!, gate: null, blocked: null,
                cost: cost({ ticksNote: 'no measured rate; not a ladders.json rung', coinsNote: 'the cost of one log; see that item', risk: 0, riskBasis: 'content', riskNote: 'no combat' }),
            }]);
        }
    }

    // Tanning (areas/area_alkharid/scripts/tanner.rs2): the tanner npc turns hides into leather for coins.
    const tanCost = new Map<string, { v: number; src: string }>();
    read('scripts/areas/area_alkharid/configs/tanner.constant').split(/\r?\n/).forEach((l, i) => { const m = l.match(/^\^(\w+) = (\d+)/); if (m) tanCost.set(m[1]!, { v: Number(m[2]), src: `scripts/areas/area_alkharid/configs/tanner.constant:${i + 1}` }); });
    const tanning = new Map<string, MakeSource>();
    {
        const file = 'scripts/areas/area_alkharid/scripts/tanner.rs2';
        let label = '';
        read(file).split(/\r?\n/).forEach((line, i) => {
            const h = line.match(/^\[label,(\w+)\]/); if (h) label = h[1]!;
            const soft = line.match(/~tan_leather\((\w+), (\w+), \$cost/), dragon = line.match(/@tan_dragonhide\((\w+), (\w+), 1\)/);
            const pair = soft ?? dragon;
            if (!pair || tanning.has(pair[2]!)) return;
            const c = tanCost.get(dragon ? 'tanner_dragonhide_cost' : label === 'tan_hard_leather' ? 'tanner_hard_leather_cost' : 'tanner_soft_leather_cost');
            const tanners = npcsFor('tanner');
            tanning.set(pair[2]!, {
                kind: 'make', rung: null, skill: 'none (tanner npc)', level: 0, inputs: [{ item: pair[1]!, count: 1 }, { item: 'coins', count: c?.v ?? null }], outputs: [pair[2]!], tools: [],
                src: `${file}:${i + 1}`, gate: null, blocked: tanners.map(npcPlace).every(p => p.spawns === 0) ? 'no tanner spawn in the maps' : null,
                cost: cost({
                    helperTicksPerUnit: 1 / 28, ticksBasis: 'model', ticksNote: 'one tan-all dialog per pack of hides; travel not included',
                    coinsPerUnit: c?.v ?? null, coinsBasis: 'content', coinsNote: `tanning fee (${c?.src}); plus the hide's own cost`, risk: 0, riskBasis: 'content', riskNote: 'no combat',
                }),
            });
        });
    }

    // Seed set.
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
    for (const r of ladders) for (const o of r.outputs) if (o.debugname) makers.set(o.debugname, [...(makers.get(o.debugname) ?? []), r]);
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

    // Script actions that add a needed item to the pack (`inv_add(inv, item, ...)`): the trigger around the call, or the
    // triggers that call its proc or label. Skill scripts are left out for items a rung already makes or gathers.
    const actions = new Map<string, { trigger: string; subject: string; src: string }[]>();
    {
        const files = rs2.map(f => ({ f, lines: read(f).split(/\r?\n/) }));
        const callers = new Map<string, { trigger: string; subject: string }[]>();
        for (const { lines } of files) {
            let trig = '', subj = '';
            for (const line of lines) {
                const h = line.match(/^\[(\w+),([^\]]+)\]/);
                if (h) { trig = h[1]!; subj = h[2]!; continue; }
                if (!trig) continue;
                for (const c of line.matchAll(/[~@](\w+)/g)) callers.set(c[1]!, [...(callers.get(c[1]!) ?? []), { trigger: trig, subject: subj }]);
            }
        }
        // The player-facing triggers that reach a proc or label, through up to 3 proc or label calls.
        const entryTriggers = (name: string, depth = 0): { trigger: string; subject: string }[] => (callers.get(name) ?? []).flatMap(c =>
            c.trigger === 'proc' || c.trigger === 'label' ? (depth < 2 && c.subject !== name ? entryTriggers(c.subject, depth + 1) : []) : [c]);
        for (const { f, lines } of files) {
            let trig = '', subj = '';
            lines.forEach((line, i) => {
                const h = line.match(/^\[(\w+),([^\]]+)\]/);
                if (h) { trig = h[1]!; subj = h[2]!; return; }
                const m = line.match(/inv_add\(inv,\s*(\w+),/);
                if (!m || !needed.has(m[1]!) || (f.startsWith('scripts/skill_') && makers.has(m[1]!))) return;
                const at = trig === 'proc' || trig === 'label' ? entryTriggers(subj).slice(0, 4) : [{ trigger: trig, subject: subj }];
                for (const a of at) {
                    const list = actions.get(m[1]!) ?? [];
                    if (!list.some(x => x.trigger === a.trigger && x.subject === a.subject)) actions.set(m[1]!, [...list, { ...a, src: `${f}:${i + 1}` }]);
                }
            });
        }
    }

    // Loc and obj spawns for the locs gather rungs and script actions name, and the needed items.
    const locNames = new Set([...ladders.flatMap(r => r.where?.locs ?? []), ...[...actions.values()].flat().filter(a => a.trigger.includes('loc')).map(a => a.subject)]);
    const locPack = parsePack(read('pack/loc.pack')), objPack = parsePack(read('pack/obj.pack'));
    const neededIds = new Set([...needed.keys()].map(n => byName.get(n)?.id).filter((x): x is number => x !== undefined));
    const locSpawns = new Map<string, (Tile & { src: string })[]>(), objSpawns = new Map<string, (Tile & { src: string; count: number })[]>();
    for (const f of readdirSync(join(contentRoot(), 'maps')).filter(f => f.endsWith('.jm2'))) {
        const m = parseJm2(f, read(`maps/${f}`));
        for (const l of m.locs) { const n = locPack.get(l.id); if (n && locNames.has(n)) locSpawns.set(n, [...(locSpawns.get(n) ?? []), l]); }
        for (const o of m.objs) if (neededIds.has(o.id)) { const n = objPack.get(o.id)!; objSpawns.set(n, [...(objSpawns.get(n) ?? []), o]); }
    }
    const locPlace = (name: string): Place => {
        const sp = locSpawns.get(name) ?? [];
        return { loc: name, spawns: sp.length, tiles: sp.slice(0, 3).map(({ x, z, level }) => ({ x, z, level })), src: sp[0]?.src ?? null, wilderness: sp.length > 0 && sp.every(inWilderness) };
    };

    // Shared drop procs (drop tables/scripts/shared_droptables.rs2): cumulative `$random < T` branches over random(N),
    // each ending in `return (item, count)` or `return (~proc)`. A branch with a further `if` is conditional.
    type DropRow = { item: string; chance: number; count: number; countMax: number; conditional: boolean; src: string; via: string | null };
    type ProcRow = { item?: string; ref?: string; chance: number; count: number; conditional: boolean; src: string };
    const procTables = new Map<string, ProcRow[]>();
    {
        const file = 'scripts/drop tables/scripts/shared_droptables.rs2';
        let name = '', die = 0, prev = 0, at = 0, cond = false;
        read(file).split(/\r?\n/).forEach((line, i) => {
            const h = line.match(/^\[proc,(\w+)\]/);
            if (h) { name = h[1]!; die = 0; prev = 0; procTables.set(name, []); return; }
            if (!name) return;
            for (const m of line.matchAll(/random\((\d+)\)/g)) die = Math.max(die, Number(m[1]));
            const t = line.match(/\$random < (\d+)/);
            if (t) { prev = at; at = Number(t[1]); cond = false; return; }
            if (/^\s+if\s*\(/.test(line) && !/^\s+if\s*\(\s*map_members\s*=\s*\^true\s*\)\s*\{?\s*$/.test(line)) cond = true;
            const ret = line.match(/return\s*\((?:(\w+),\s*(\d+)|~(\w+))\)/);
            if (ret && die && at) {
                const chance = (at - prev) / die;
                procTables.get(name)!.push(ret[3] ? { ref: ret[3], chance, count: 1, conditional: cond, src: `${file}:${i + 1}` } : { item: ret[1]!, chance, count: Number(ret[2]), conditional: cond, src: `${file}:${i + 1}` });
            }
        });
    }
    const procRows = (name: string, factor: number, depth = 0): DropRow[] => (procTables.get(name) ?? []).flatMap(r => r.ref
        ? (depth < 3 ? procRows(r.ref, factor * r.chance, depth + 1) : [])
        : [{ item: r.item!, chance: factor * r.chance, count: r.count, countMax: r.count, conditional: r.conditional, src: r.src, via: name }]);

    // Drop tables by npc, with shared label tables and drop procs expanded.
    const labels = new Map(drops.filter(d => d.trigger.startsWith('label:')).map(d => [d.trigger.slice(6), d]));
    const rowsOf = (d: { always: any[]; rolls: any[]; uses?: string }, factor = 1, via: string | null = null, depth = 0): DropRow[] => {
        const out: DropRow[] = [];
        for (const a of d.always) out.push({ item: a.item, chance: factor, count: a.count, countMax: a.count, conditional: a.conditional, src: a.src, via });
        for (const r of d.rolls) {
            if (r.item) out.push({ item: r.item, chance: factor * r.chance, count: r.count ?? 1, countMax: r.countMax ?? r.count ?? 1, conditional: r.conditional, src: r.src, via });
            else if (r.table && labels.has(r.table) && depth < 2) out.push(...rowsOf(labels.get(r.table)!, factor * r.chance, r.table, depth + 1));
            else if (r.table && procTables.has(r.table)) out.push(...procRows(r.table, factor * r.chance).map(x => ({ ...x, conditional: x.conditional || r.conditional })));
        }
        if (d.uses && labels.has(d.uses) && depth < 2) out.push(...rowsOf(labels.get(d.uses)!, factor, d.uses, depth + 1));
        return out;
    };
    const dropSources = new Map<string, DropSource[]>();
    const addDrop = (trigger: string, names: string[], row: DropRow) => {
        if (!needed.has(row.item)) return;
        // A condition on a varp (%name) is quest or account state: a gate. Area or inventory conditions are kept as text only.
        const condition = row.conditional ? enclosingIf(row.src) : null;
        if (condition && MEMBERS_ONLY.test(condition)) row = { ...row, conditional: false };
        const gate = row.conditional && (condition === null || condition.includes('%')) ? `state condition: ${condition ?? 'not found near the drop line'}` : null;
        const places = names.map(npcPlace).filter(p => p.spawns > 0);
        const combat = names.map(n => npcByName.get(n)?.combat).filter((c): c is number => typeof c === 'number');
        const avg = (row.count + row.countMax) / 2, wild = places.length > 0 && places.every(p => p.wilderness);
        dropSources.set(row.item, [...(dropSources.get(row.item) ?? []), {
            kind: 'drop', npc: trigger, combat: combat.length ? Math.min(...combat) : null, chance: Math.round(row.chance * 1e6) / 1e6, countMin: row.count, countMax: row.countMax,
            conditional: row.conditional, condition: row.conditional ? condition : null, via: row.via, places, src: row.src, gate,
            blocked: places.length === 0 ? 'no spawn of this npc in the maps' : null,
            cost: cost({
                ticksNote: `${r3(1 / (row.chance * avg))} kills per unit (content drop rate); kill time not modelled: npc hitpoints are not in knowledge/npcs.json`,
                coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent; food and ammunition are not counted',
                risk: null, riskBasis: wild ? 'model' : 'unknown', riskNote: `npc combat ${combat.length ? Math.min(...combat) : '?'}; death chance not modelled${wild ? '; every spawn is in the Wilderness, so a death loses carried items' : ''}`,
            }),
        }]);
    };
    const tabled = new Set<string>();
    for (const d of drops) {
        if (d.trigger.startsWith('label:')) continue;
        const names = npcsFor(d.trigger);
        names.forEach(n => tabled.add(n));
        for (const row of rowsOf(d)) {
            if (row.item !== 'death_drop') { addDrop(d.trigger, names, row); continue; }
            // npc_param(death_drop): each npc's own param, default bones.
            const byItem = new Map<string, string[]>();
            for (const n of names) { const dd = deathDrop.get(n) ?? DEATH_DEFAULT; if (dd.item !== 'null') byItem.set(dd.item, [...(byItem.get(dd.item) ?? []), n]); }
            for (const [item, ns] of byItem) addDrop(d.trigger, ns, { ...row, item, src: row.src, via: `death_drop param (${(deathDrop.get(ns[0]!) ?? DEATH_DEFAULT).src})` });
        }
    }
    // Attackable npcs with no drop table of their own die by npc_default_death (npc_combat.rs2:97-101): their death_drop.
    for (const n of attackable) {
        if (tabled.has(n)) continue;
        const dd = deathDrop.get(n) ?? DEATH_DEFAULT;
        if (dd.item !== 'null') addDrop(n, [n], { item: dd.item, chance: 1, count: 1, countMax: 1, conditional: false, src: dd.src, via: 'npc_default_death (scripts/skill_combat/scripts/npc/npc_combat.rs2:97)' });
    }


    const ticksFrom = (r: Rung, perAction: number | null): Pick<Cost, 'helperTicksPerUnit' | 'ticksBasis' | 'ticksNote'> => {
        // A measured rate (rates.json, xpPerTick at 25x) wins over the content timing model (ticksPerAction, timing.basis).
        const one = perAction === null ? '; assumes 1 unit per action' : '';
        if (r.xpPerTick && r.xpPerAction) return { helperTicksPerUnit: r3((r.xpPerAction * XP_RATE) / r.xpPerTick / (perAction ?? 1)), ticksBasis: 'measured', ticksNote: `${r.id} rate from knowledge/rates.json via ladders.json${one}` };
        if (r.ticksPerAction) return { helperTicksPerUnit: r3(r.ticksPerAction / (perAction ?? 1)), ticksBasis: 'model', ticksNote: `${r.id} ticksPerAction from knowledge/ladders.json (timing ${r.timing?.basis ?? 'model'}, at the unlock level)${one}` };
        return { helperTicksPerUnit: null, ticksBasis: 'unknown', ticksNote: `no rate or timing for ${r.id} in knowledge/ladders.json` };
    };

    const out: ItemSources[] = [];
    for (const [item, by] of [...needed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const def = byName.get(item);
        const sources: Source[] = [];
        // gather and make
        for (const r of makers.get(item) ?? []) {
            const o = r.outputs.find(x => x.debugname === item)!;
            const gate = r.quest ? `quest ${r.quest.name}` : null;
            const tools = toolGroups(r);
            if (GATHER_KINDS.has(r.kind)) {
                const row = r.id.split('/')[1]!;
                const mine = r.kind === 'mining_table' ? dbRow('mining_table', row) : null, tree = r.kind === 'woodcutting_trees' ? dbRow('woodcutting_trees', row) : null;
                const respawn = mine?.data.rock_respawnrate?.[0]?.[0] ?? tree?.data.respawnrate?.[0]?.[0];
                const respawnSrc = mine?.src.rock_respawnrate?.[0] ?? tree?.src.respawnrate?.[0] ?? null;
                const sc = mine ? { low: Number(mine.data.rock_successchance![0]![0]), high: Number(mine.data.rock_successchance![0]![1]), src: mine.src.rock_successchance![0]! } : null;
                const spots = recsFor(r).map(t => t.option?.spot).filter((s): s is string => !!s);
                const places = [...(r.where?.locs ?? []).map(locPlace), ...(r.where?.npcs ?? []).map(npcPlace), ...spots.flatMap(s => (npcsInCategory.get(s) ?? []).map(npcPlace))];
                const wild = places.length > 0 && places.every(p => p.wilderness || p.spawns === 0) && places.some(p => p.wilderness);
                sources.push({
                    kind: 'gather', rung: r.id, skill: r.skill, level: r.level, tools, bait: baitOf(r), places, yieldPerAction: o.count, respawnTicks: respawn === undefined ? null : Number(respawn), respawnSrc,
                    successChance: sc ?? (tree ? toolsFile.axes.find(a => a.successChance[row])?.successChance[row] ?? null : null),
                    src: r.src, gate, blocked: places.length && places.every(p => p.spawns === 0) ? 'no spawn of the loc or npc in the maps' : null,
                    cost: cost({
                        ...ticksFrom(r, o.count),
                        coinsPerUnit: baitOf(r).length ? null : 0, coinsBasis: baitOf(r).length ? 'unknown' : 'content', coinsNote: baitOf(r).length ? `consumes ${baitOf(r).join(', ')} per catch; see that item's sources` : 'no coins spent; tools are separate items',
                        risk: wild ? null : 0, riskBasis: wild ? 'model' : 'content', riskNote: wild ? 'every spawn is in the Wilderness' : (r.kind === 'pickpocket' ? 'a failed pickpocket stuns and damages; damage is not a death risk modelled here' : 'no combat at this place'),
                        realSecondsPerUnit: respawn !== undefined && Number(respawn) > 0 ? r3((Number(respawn) * LIVE_TICK_SECONDS) / Math.max(1, places.reduce((a, p) => a + p.spawns, 0))) : null,
                        realBasis: respawn !== undefined ? 'model' : 'unknown', realNote: respawn !== undefined ? 'respawn ticks x 0.4 s spread over every spawn: the floor when one account clears them all' : 'respawn not read for this method',
                    }),
                });
            } else {
                sources.push({
                    kind: 'make', rung: r.id, skill: r.skill, level: r.level, inputs: inputsOf(r, item), outputs: r.outputs.map(x => x.debugname), tools,
                    src: r.inputs.length || !smelt.has(item) ? r.src : smelt.get(item)![0]!.src, gate, blocked: null,
                    cost: cost({
                        ...ticksFrom(r, o.count),
                        coinsPerUnit: null, coinsBasis: 'unknown', coinsNote: inputsOf(r, item).length ? `the sum of the inputs' costs; see each input${r.inputs.length ? '' : ' (recipe from smelting.struct)'}` : `recipe inputs are not in knowledge/ladders.json for ${r.id}`,
                        risk: 0, riskBasis: 'content', riskNote: 'no combat',
                    }),
                });
            }
        }
        for (const m of bowMakes.get(item) ?? []) sources.push(m);
        if (tanning.has(item)) sources.push(tanning.get(item)!);
        // script actions
        for (const a of actions.get(item) ?? []) {
            const places = a.trigger.includes('loc') && !a.subject.startsWith('_') ? [locPlace(a.subject)] : a.trigger.includes('npc') && !a.subject.startsWith('_') ? npcsFor(a.subject).map(npcPlace) : [];
            const quest = a.src.startsWith('scripts/quests/');
            sources.push({
                kind: 'action', trigger: a.trigger, subject: a.subject, places, src: a.src,
                gate: quest ? 'quest script: may give the item once or only at a quest stage' : null,
                blocked: places.length && places.every(p => p.spawns === 0) ? 'no spawn of the loc or npc in the maps' : null,
                cost: cost({ ticksNote: 'script action; time not modelled', coinsNote: 'the script may take coins or items; read the cited line', riskNote: 'not modelled' }),
            });
        }
        // ground spawns
        const os = objSpawns.get(item) ?? [];
        if (os.length) sources.push({
            kind: 'pickup', spawns: os.length, countPerSpawn: os[0]!.count, tiles: os.slice(0, 3).map(({ x, z, level }) => ({ x, z, level })), wilderness: os.every(inWilderness), src: os[0]!.src, gate: null, blocked: null,
            cost: cost({ ticksNote: 'walk and take; respawn time is the engine default and is not read here', coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent', risk: os.every(inWilderness) ? null : 0, riskBasis: os.every(inWilderness) ? 'model' : 'content', riskNote: os.every(inWilderness) ? 'every spawn is in the Wilderness' : 'no combat at the spawn' }),
        });
        // shops
        for (const s of shops) {
            if (/^(skill_guide|smithing_)/.test(s.inv)) continue;
            for (const st of s.stock) {
                if (st.item !== item || st.count <= 0) continue;
                const owners = shopOwners.get(s.inv) ?? [];
                const o = owners[0] ?? { sell: 1000, sellSrc: 'no owner found: sell multiplier 1000 assumed', delta: DELTA_DEFAULT };
                const objCost = def?.cost ?? 0, n = Math.min(st.count, PACK_SLOTS);
                let total = 0;
                for (let i = 0; i < n; i++) total += shopUnitPrice(objCost, o.sell, o.delta, st.count - i, st.count);
                const places = [...new Set(owners.map(x => x.npc))].map(npcPlace);
                sources.push({
                    kind: 'shop', shop: s.inv, owners: places, basePrice: objCost, priceAtFullStock: shopUnitPrice(objCost, o.sell, o.delta, st.count, st.count), stock: st.count, restockTicks: st.restockTicks,
                    sellMultiplier: o.sell, sellMultiplierSrc: o.sellSrc, delta: o.delta, src: st.src, gate: /quest/i.test(s.inv) ? 'shop name says quest' : null,
                    blocked: owners.length && places.every(p => p.spawns === 0) ? 'no spawn of the shop owner in the maps' : null,
                    cost: cost({
                        helperTicksPerUnit: 1 / SHOP_UNITS_PER_TICK, ticksBasis: 'model', ticksNote: 'buy-10 button at one click per tick; travel and banking not included',
                        coinsPerUnit: r3(total / Math.max(1, n)), coinsBasis: 'model', coinsNote: `mean price of the first ${n} bought from full stock (shop.rs2 calc_shop_value, obj cost ${objCost}, sell ${o.sell}, delta ${o.delta})`,
                        risk: 0, riskBasis: 'content', riskNote: 'no combat to buy',
                        realSecondsPerUnit: st.restockTicks ? r3(st.restockTicks * LIVE_TICK_SECONDS) : null, realBasis: st.restockTicks ? 'content' : 'unknown',
                        realNote: st.restockTicks ? `after the ${st.count} in stock: +1 unit per ${st.restockTicks} ticks (World.ts restock) at 0.4 s per tick` : 'no restock value',
                    }),
                });
            }
        }
        for (const d of dropSources.get(item) ?? []) sources.push(d);
        // GE
        const m = opts.market?.prices[item];
        if (opts.market && def?.tradeable) sources.push({
            kind: 'ge', at: opts.market.at, ask: m?.ask ?? null, bid: m?.bid ?? null, sellers: m?.sell ?? 0, src: opts.market.file, gate: null,
            blocked: (m?.sell ?? 0) > 0 ? null : `0 sellers in the snapshot of ${opts.market.at}`,
            cost: cost({
                ticksNote: 'GE trip not measured', coinsPerUnit: m?.ask ?? null, coinsBasis: m?.ask ? 'measured' : 'unknown', coinsNote: m?.ask ? `lowest ask in the snapshot; ${m.sell} for sale` : 'no ask',
                risk: 0, riskBasis: 'content', riskNote: 'no combat', realNote: 'the wait for new sellers is not modelled',
            }),
        });
        // owned
        if (opts.owned && def) {
            const holders = opts.owned.accounts.map(a => ({ account: a.name, side: a.side, count: a.items.get(def.id) ?? 0 })).filter(h => h.count > 0).sort((a, b) => b.count - a.count);
            const total = holders.reduce((a, h) => a + h.count, 0);
            if (total > 0) sources.push({
                kind: 'owned', at: opts.owned.at, total, holders, src: '.practice/status/*.json + fleet/snapshots', gate: null, blocked: null,
                cost: cost({
                    helperTicksPerUnit: stackable.has(item) ? 0 : r3(TRADE_TICKS / PACK_SLOTS), ticksBasis: 'measured', ticksNote: `one ${TRADE_TICKS}-tick trade per pack (scripts/measure/trade-supply.ts)`,
                    coinsPerUnit: 0, coinsBasis: 'measured', coinsNote: 'already held', risk: 0, riskBasis: 'content', riskNote: 'no combat',
                }),
            });
        }
        // substitutes
        const subs: Substitute[] = [];
        for (const t of toolsFile.records) for (const g of t.items) if (g.anyOf.length > 1 && g.anyOf.includes(item) && !subs.some(s => s.group === t.id)) subs.push({ group: t.id, items: g.anyOf.filter(x => x !== item), note: `any one of these meets ${t.id} (${g.role})`, src: g.src });
        for (const row of tablesByName.get('magic_staff_table')?.rows ?? []) if (row.data.rune?.[0]?.[0] === item) subs.push({ group: 'magic_staff_table', items: row.data.staff!.map(s => s[0]!), note: 'a worn staff in this row supplies this rune for spells', src: row.src.staff![0]! });
        if (food.has(item)) subs.push({ group: 'food', items: [...needed.keys()].filter(x => food.has(x) && x !== item), note: `any healing food; this one heals ${food.get(item)!.heal}`, src: food.get(item)!.src });

        const usable = sources.filter(s => !s.blocked && !s.gate && s.kind !== 'owned').length;
        out.push({
            item, id: def?.id ?? null, name: def?.name ?? null, cost: def?.cost ?? null, members: def?.members ?? null, tradeable: def?.tradeable ?? null, stackable: stackable.has(item),
            neededBy: [...by].sort(), substitutes: subs,
            delivery: { scoredTicksPerTrade: TRADE_TICKS, helperTicksPerTrade: TRADE_TICKS, unitsPerTrade: stackable.has(item) ? null : PACK_SLOTS, basis: 'measured', note: 'helper trade to the scored account (scripts/measure/trade-supply.ts); a stackable item takes one slot for any count' },
            sources, usable, blocked: usable === 0,
        });
    }
    return out;
}

export function counts(rows: ItemSources[]) {
    const byKind: Record<string, number> = {};
    for (const r of rows) for (const s of r.sources) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    return {
        items: rows.length, withSource: rows.filter(r => r.sources.some(s => s.kind !== 'owned')).length,
        noSource: rows.filter(r => !r.sources.some(s => s.kind !== 'owned')).length, onlyBlocked: rows.filter(r => r.blocked && r.sources.some(s => s.kind !== 'owned')).length, byKind,
    };
}

// Blocked and gated sources grouped by kind and reason, with a count and up to three examples.
function reasons(sources: Source[]) {
    const groups = new Map<string, string[]>();
    for (const s of sources) {
        const key = `${s.kind}: ${s.blocked ?? s.gate}`;
        groups.set(key, [...(groups.get(key) ?? []), s.kind === 'shop' ? s.shop : s.kind === 'drop' ? s.npc : s.kind === 'action' ? s.subject : 'rung' in s && s.rung ? s.rung : '']);
    }
    return [...groups].map(([k, v]) => { const ex = [...new Set(v.filter(Boolean))]; return `${k}${v.length > 1 ? ` (${v.length})` : ''}${ex.length ? ` [${ex.slice(0, 3).join(', ')}${ex.length > 3 ? ', ...' : ''}]` : ''}`; }).join('; ');
}
export function gapsMarkdown(rows: ItemSources[], market: Market | null) {
    const c = counts(rows), L: string[] = [];
    L.push('# Item source gaps', '', 'Generated by `bun packages/knowledge/src/item-sources.ts` from `knowledge/*.json` and the pinned content. Do not edit by hand.');
    L.push(`GE snapshot: ${market ? `\`${market.file}\` taken ${market.at}` : 'none'}. The server is a members world (\`vendor/rs-sdk/fly.toml\` NODE_MEMBERS), so members items are not a block.`, '');
    L.push(`Items ${c.items}; with a source ${c.withSource}; no source ${c.noSource}; only blocked or gated sources ${c.onlyBlocked}.`, '');
    L.push('A missing source does not remove a method. Each gap is acquisition work: compare gathering, shops, owned stock, trading and substitutes.', '');
    L.push('## Items with no supported source', '');
    for (const r of rows.filter(r => !r.sources.some(s => s.kind !== 'owned'))) L.push(`- \`${r.item}\` (${r.name ?? 'no item config'})${r.substitutes.length ? `; substitutes: ${r.substitutes.map(s => s.group).join(', ')}` : ''}; needed by ${r.neededBy.slice(0, 3).join(', ')}${r.neededBy.length > 3 ? ` and ${r.neededBy.length - 3} more` : ''}`);
    L.push('', '## Items whose only sources are blocked or gated', '');
    for (const r of rows.filter(r => r.blocked && r.sources.some(s => s.kind !== 'owned'))) L.push(`- \`${r.item}\` (${r.name ?? '?'}): ${reasons(r.sources.filter(s => s.kind !== 'owned'))}`);
    return L.join('\n') + '\n';
}

if (import.meta.main) {
    const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
    const practice = resolve(arg('--practice') ?? join(repoRoot, '.practice'));
    const marketFile = arg('--market') ?? (existsSync(join(practice, 'coordinator/market-prices.json')) ? join(practice, 'coordinator/market-prices.json')
        : readdirSync(join(repoRoot, 'research')).filter(f => /^market-.*\.json$/.test(f)).sort().map(f => join(repoRoot, 'research', f)).pop());
    const market = marketFile ? readMarket(resolve(marketFile)) : null;
    const owned = process.argv.includes('--owned') ? readOwned(practice, join(repoRoot, 'fleet', 'snapshots')) : null;
    const rows = buildItemSources({ market, owned });
    const file = arg('--out') ?? (owned ? join(practice, 'coordinator/item-sources.json') : join(knowledgeDir(), 'item-sources.json'));
    writeFileSync(file, JSON.stringify({
        generatedBy: 'bun packages/knowledge/src/item-sources.ts',
        notes: [
            'src is a content-relative path and 1-based line under vendor/rs-sdk/server/content, or the snapshot file for ge and owned.',
            'cost keeps helper ticks, coins and risk apart; realSecondsPerUnit is wall-clock wait beyond the ticks. Each has a basis: content, model, measured or unknown.',
            'helperTicksPerUnit is the work of one unit; the same ticks fall on the scored account when it does the work itself. delivery gives the trade cost to the scored account.',
            'blocked: the source cannot be used now. gate: a quest or condition to clear first. usable counts sources with neither, owned stock left out.',
        ],
        market: market ? { file: market.file, at: market.at } : null, owned: owned ? { at: owned.at, accounts: owned.accounts.length } : null,
        counts: counts(rows), items: rows,
    }, null, 1) + '\n');
    if (!owned) writeFileSync(join(knowledgeDir(), 'item-sources-gaps.md'), gapsMarkdown(rows, market));
    console.log(JSON.stringify(counts(rows)));
}
