import { parseConfigs } from '../config';
import {
    DELTA_DEFAULT,
    blocksOf,
    cost,
    read,
    type MakeSource,
    type Place,
    type Rung,
    type Tile,
    type ToolRec,
} from './model';

export interface KnowledgeItem { id: number; name: string; debugname: string; cost: number; members: boolean; tradeable: boolean }
export interface KnowledgeShop { inv: string; stock: { item: string; count: number; restockTicks: number | null; src: string }[] }
export interface KnowledgeDrop { trigger: string; always: any[]; rolls: any[]; uses?: string; src: string }
export interface KnowledgeNpc { debugname: string; combat: number; src: string; spawns: (Tile & { src: string })[] }
export interface KnowledgeDbTable { table: string; rows: { name: string; data: Record<string, string[][]>; src: Record<string, string[]> }[] }
export interface ShopOwnerSpec { npc: string; sell: number; sellSrc: string; delta: number }
export interface ToolsFile {
    records: ToolRec[];
    axes: { item: string; successChance: Record<string, { low: number; high: number; src: string }> }[];
}

// shopkeeper.param: shop_sell_multiplier default=100 (line 7), shop_delta default=10 (line 15).
const SELL_DEFAULT = { v: 100, src: 'scripts/shop/configs/shopkeeper.param:7' };

export function loadNpcAndShopData(
    npcByName: ReadonlyMap<string, KnowledgeNpc>,
    rs2: readonly string[],
    readCached: (rel: string) => string,
    linesOf: (rel: string) => string[],
) {
    const npcBlocks = blocksOf('.npc');
    const npcsInCategory = new Map<string, string[]>();
    const shopOwners = new Map<string, ShopOwnerSpec[]>();
    const deathDrop = new Map<string, { item: string; src: string }>();
    const attackable = new Set<string>();

    for (const b of npcBlocks) {
        const cat = b.props.category?.[0];
        if (cat) npcsInCategory.set(cat, [...(npcsInCategory.get(cat) ?? []), b.name]);
        const params = new Map<string, { v: string; line: number }>();
        (b.props.param ?? []).forEach((p, i) => {
            const [k, ...v] = p.split(',');
            params.set(k!, { v: v.join(','), line: b.propLines.param![i]! });
        });
        const dd = params.get('death_drop');
        if (dd) deathDrop.set(b.name, { item: dd.v, src: `${b.file}:${dd.line}` });
        if (b.props.op2?.[0] === 'Attack' && (npcByName.get(b.name)?.spawns.length ?? 0) > 0) attackable.add(b.name);
        const inv = params.get('owned_shop');
        if (!inv) continue;
        const sell = params.get('shop_sell_multiplier'), delta = params.get('shop_delta');
        shopOwners.set(inv.v, [...(shopOwners.get(inv.v) ?? []), {
            npc: b.name,
            sell: sell ? Number(sell.v) : SELL_DEFAULT.v,
            sellSrc: sell ? `${b.file}:${sell.line}` : SELL_DEFAULT.src,
            delta: delta ? Number(delta.v) : DELTA_DEFAULT,
        }]);
    }

    // ~openshop(inv, buy, sell, delta, title) calls: the shop's NPC is the opnpc trigger around the call, or the
    // opnpc trigger that calls the enclosing proc.
    const procCallers = new Map<string, string[]>();
    const openshopCalls: { inv: string; sell: number; delta: number; src: string; trigger: string; subject: string }[] = [];
    for (const f of rs2) {
        if (!readCached(f).includes('~')) continue;
        let trig = '', subj = '';
        linesOf(f).forEach((line, i) => {
            const h = line.match(/^\[(\w+),([^\]]+)\]/);
            if (h) { trig = h[1]!; subj = h[2]!; }
            const m = line.match(/~openshop\((\w+),\s*(\d+),\s*(\d+),\s*(\d+)/);
            if (m) openshopCalls.push({ inv: m[1]!, sell: Number(m[3]), delta: Number(m[4]), src: `${f}:${i + 1}`, trigger: trig, subject: subj });
            for (const c of line.matchAll(/~(\w+)/g)) if (trig.startsWith('opnpc')) procCallers.set(c[1]!, [...(procCallers.get(c[1]!) ?? []), subj]);
        });
    }
    for (const c of openshopCalls) {
        const list = c.trigger.startsWith('opnpc') ? [c.subject] : c.trigger === 'proc' ? (procCallers.get(c.subject) ?? []) : [];
        for (const n of new Set(list)) shopOwners.set(c.inv, [...(shopOwners.get(c.inv) ?? []), { npc: n, sell: c.sell, sellSrc: c.src, delta: c.delta }]);
    }

    return { npcsInCategory, shopOwners, deathDrop, attackable };
}

export function loadSmeltRecipes(): Map<string, { item: string; count: number; src: string }[]> {
    // Smelting recipes (skill_smithing/configs/smelting/smelting.struct): ladders.json smelt rungs list no inputs.
    const smelt = new Map<string, { item: string; count: number; src: string }[]>();
    const file = 'scripts/skill_smithing/configs/smelting/smelting.struct';
    for (const b of parseConfigs(read(file), file)) {
        const p = new Map<string, { v: string; src: string }>();
        (b.props.param ?? []).forEach((x, i) => {
            const [k, ...v] = x.split(',');
            p.set(k!, { v: v.join(','), src: `${b.file}:${b.propLines.param![i]}` });
        });
        const product = p.get('product')?.v, first = p.get('ingredient'), second = p.get('ingredient_secondary');
        if (!product || !first) continue;
        smelt.set(product, [
            { item: first.v, count: Number(p.get('bar_count')?.v ?? 1), src: first.src },
            ...(second ? [{ item: second.v, count: Number(p.get('ingredient_secondary_count')?.v ?? 1), src: second.src }] : []),
        ]);
    }
    return smelt;
}

export function loadFood(): Map<string, { heal: number; src: string }> {
    // Food: consume_table rows that heal hitpoints (player/configs/consumption/*.dbrow).
    const food = new Map<string, { heal: number; src: string }>();
    for (const f of ['scripts/player/configs/consumption/consume_normal.dbrow', 'scripts/player/configs/consumption/consume_effects.dbrow']) {
        for (const b of parseConfigs(read(f), f)) {
            if (b.props.table?.[0] !== 'consume_table') continue;
            const heal = (b.props.data ?? []).find(d => d.startsWith('stat_heal,hitpoints,'));
            const n = heal ? Number(heal.split(',')[2]) : 0;
            if (n > 0) (b.props.data ?? []).forEach((d, i) => {
                if (d.startsWith('consumable,')) food.set(d.slice(11), { heal: n, src: `${f}:${b.propLines.data![i]}` });
            });
        }
    }
    return food;
}

export function loadBowMakes(
    tablesByName: ReadonlyMap<string, KnowledgeDbTable>,
    toolsFile: ToolsFile,
): Map<string, MakeSource[]> {
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
    return bowMakes;
}

export function loadTanning(npcsFor: (name: string) => string[], npcPlace: (name: string) => Place): Map<string, MakeSource> {
    // Tanning (areas/area_alkharid/scripts/tanner.rs2): the tanner npc turns hides into leather for coins.
    const tanCost = new Map<string, { v: number; src: string }>();
    const constFile = 'scripts/areas/area_alkharid/configs/tanner.constant';
    read(constFile).split(/\r?\n/).forEach((l, i) => {
        const m = l.match(/^\^(\w+) = (\d+)/);
        if (m) tanCost.set(m[1]!, { v: Number(m[2]), src: `${constFile}:${i + 1}` });
    });
    const tanning = new Map<string, MakeSource>();
    const file = 'scripts/areas/area_alkharid/scripts/tanner.rs2';
    let label = '';
    read(file).split(/\r?\n/).forEach((line, i) => {
        const h = line.match(/^\[label,(\w+)\]/);
        if (h) label = h[1]!;
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
    return tanning;
}
