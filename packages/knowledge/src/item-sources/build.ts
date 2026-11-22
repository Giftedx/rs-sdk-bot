import { buildDropSources } from './drops';
import { loadSourceCatalog, type SourceCatalog } from './lookup';
import {
    DELTA_DEFAULT,
    GATHER_KINDS,
    LIVE_TICK_SECONDS,
    PACK_SLOTS,
    SHOP_UNITS_PER_TICK,
    TRADE_TICKS,
    XP_RATE,
    cost,
    inWilderness,
    r3,
    shopUnitPrice,
    sourceTiles,
    type Cost,
    type GatherSource,
    type ItemSources,
    type MakeSource,
    type Options,
    type Rung,
    type ShopSource,
    type Source,
    type Substitute,
} from './model';
import { geSource, ownedSource } from './stock-adapter';

function ticksFrom(r: Rung, perAction: number | null): Pick<Cost, 'helperTicksPerUnit' | 'ticksBasis' | 'ticksNote'> {
    // A measured rate (rates.json, xpPerTick at 25x) wins over the content timing model (ticksPerAction, timing.basis).
    const one = perAction === null ? '; assumes 1 unit per action' : '';
    if (r.xpPerTick && r.xpPerAction) {
        const measured = r.measuredRate;
        const provenance = measured ? `; ${measured.method}, measured level ${measured.level}${measured.runs === undefined ? '' : `, ${measured.runs} runs`}${measured.tickMs === undefined ? '' : `, ${measured.tickMs} ms ticks`}; ${measured.evidence}${measured.note ? `; ${measured.note}` : ''}` : '';
        return { helperTicksPerUnit: r3((r.xpPerAction * XP_RATE) / r.xpPerTick / (perAction ?? 1)), ticksBasis: 'measured', ticksNote: `${r.id} rate from knowledge/rates.json via ladders.json${provenance}${one}` };
    }
    if (r.ticksPerAction) return { helperTicksPerUnit: r3(r.ticksPerAction / (perAction ?? 1)), ticksBasis: 'model', ticksNote: `${r.id} ticksPerAction from knowledge/ladders.json (timing ${r.timing?.basis ?? 'model'}, at the unlock level)${one}` };
    return { helperTicksPerUnit: null, ticksBasis: 'unknown', ticksNote: `no rate or timing for ${r.id} in knowledge/ladders.json` };
}

function buildGatherSource(r: Rung, yieldCount: number | null, gate: string | null, tools: string[][], catalog: SourceCatalog): GatherSource {
    const row = r.id.split('/')[1]!;
    const mine = r.kind === 'mining_table' ? catalog.dbRow('mining_table', row) : null;
    const tree = r.kind === 'woodcutting_trees' ? catalog.dbRow('woodcutting_trees', row) : null;
    const respawn = mine?.data.rock_respawnrate?.[0]?.[0] ?? tree?.data.respawnrate?.[0]?.[0];
    const respawnSrc = mine?.src.rock_respawnrate?.[0] ?? tree?.src.respawnrate?.[0] ?? null;
    const sc = mine ? { low: Number(mine.data.rock_successchance![0]![0]), high: Number(mine.data.rock_successchance![0]![1]), src: mine.src.rock_successchance![0]! } : null;
    const spots = catalog.recsFor(r).map(t => t.option?.spot).filter((s): s is string => !!s);
    const places = [...(r.where?.locs ?? []).map(catalog.locPlace), ...(r.where?.npcs ?? []).map(catalog.npcPlace), ...spots.flatMap(s => (catalog.npcsInCategory.get(s) ?? []).map(catalog.npcPlace))];
    const wild = places.length > 0 && places.every(p => p.wilderness || p.spawns === 0) && places.some(p => p.wilderness);
    const bait = catalog.baitOf(r);
    return {
        kind: 'gather', rung: r.id, skill: r.skill, level: r.level, tools, bait, places, yieldPerAction: yieldCount,
        respawnTicks: respawn === undefined ? null : Number(respawn), respawnSrc,
        successChance: sc ?? (tree ? catalog.toolsFile.axes.find(a => a.successChance[row])?.successChance[row] ?? null : null),
        src: r.src, gate, blocked: places.length && places.every(p => p.spawns === 0) ? 'no spawn of the loc or npc in the maps' : null,
        cost: cost({
            ...ticksFrom(r, yieldCount),
            coinsPerUnit: bait.length ? null : 0, coinsBasis: bait.length ? 'unknown' : 'content', coinsNote: bait.length ? `consumes ${bait.join(', ')} per catch; see that item's sources` : 'no coins spent; tools are separate items',
            risk: wild ? null : 0, riskBasis: wild ? 'model' : 'content', riskNote: wild ? 'every spawn is in the Wilderness' : (r.kind === 'pickpocket' ? 'a failed pickpocket stuns and damages; damage is not a death risk modelled here' : 'no combat at this place'),
            realSecondsPerUnit: respawn !== undefined && Number(respawn) > 0 ? r3((Number(respawn) * LIVE_TICK_SECONDS) / Math.max(1, places.reduce((a, p) => a + p.spawns, 0))) : null,
            realBasis: respawn !== undefined ? 'model' : 'unknown', realNote: respawn !== undefined ? 'respawn ticks x 0.4 s spread over every spawn: the floor when one account clears them all' : 'respawn not read for this method',
        }),
    };
}

function buildMakeSource(r: Rung, item: string, yieldCount: number | null, gate: string | null, tools: string[][], catalog: SourceCatalog): MakeSource {
    const inputs = catalog.inputsOf(r, item);
    return {
        kind: 'make', rung: r.id, skill: r.skill, level: r.level, inputs, outputs: r.outputs.map(x => x.debugname), tools,
        src: r.inputs.length || !catalog.smelt.has(item) ? r.src : catalog.smelt.get(item)![0]!.src, gate, blocked: null,
        cost: cost({
            ...ticksFrom(r, yieldCount),
            coinsPerUnit: null, coinsBasis: 'unknown', coinsNote: inputs.length ? `the sum of the inputs' costs; see each input${r.inputs.length ? '' : ' (recipe from smelting.struct)'}` : `recipe inputs are not in knowledge/ladders.json for ${r.id}`,
            risk: 0, riskBasis: 'content', riskNote: 'no combat',
        }),
    };
}

function buildShopSources(item: string, objCost: number, catalog: SourceCatalog): ShopSource[] {
    const out: ShopSource[] = [];
    for (const s of catalog.shops) {
        if (/^(skill_guide|smithing_)/.test(s.inv)) continue;
        for (const st of s.stock) {
            if (st.item !== item || st.count <= 0) continue;
            const owners = catalog.shopOwners.get(s.inv) ?? [];
            const o = owners[0] ?? { sell: 1000, sellSrc: 'no owner found: sell multiplier 1000 assumed', delta: DELTA_DEFAULT };
            const n = Math.min(st.count, PACK_SLOTS);
            let total = 0;
            for (let i = 0; i < n; i++) total += shopUnitPrice(objCost, o.sell, o.delta, st.count - i, st.count);
            const places = [...new Set(owners.map(x => x.npc))].map(catalog.npcPlace);
            out.push({
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
    return out;
}

function buildSubstitutes(item: string, catalog: SourceCatalog): Substitute[] {
    const subs: Substitute[] = [];
    for (const t of catalog.toolsFile.records) for (const g of t.items) if (g.anyOf.length > 1 && g.anyOf.includes(item) && !subs.some(s => s.group === t.id)) {
        subs.push({ group: t.id, items: g.anyOf.filter(x => x !== item), note: `any one of these meets ${t.id} (${g.role})`, src: g.src });
    }
    for (const row of catalog.tablesByName.get('magic_staff_table')?.rows ?? []) if (row.data.rune?.[0]?.[0] === item) {
        subs.push({ group: 'magic_staff_table', items: row.data.staff!.map(s => s[0]!), note: 'a worn staff in this row supplies this rune for spells', src: row.src.staff![0]! });
    }
    if (catalog.food.has(item)) {
        subs.push({ group: 'food', items: [...catalog.needed.keys()].filter(x => catalog.food.has(x) && x !== item), note: `any healing food; this one heals ${catalog.food.get(item)!.heal}`, src: catalog.food.get(item)!.src });
    }
    return subs;
}

export function buildItemSources(opts: Options = {}): ItemSources[] {
    const catalog = loadSourceCatalog();
    const dropSources = buildDropSources(catalog);
    const out: ItemSources[] = [];

    for (const [item, by] of [...catalog.needed.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const def = catalog.byName.get(item);
        const sources: Source[] = [];

        for (const r of catalog.makers.get(item) ?? []) {
            const o = r.outputs.find(x => x.debugname === item)!;
            const gate = r.quest ? `quest ${r.quest.name}` : null;
            const tools = catalog.toolGroups(r);
            sources.push(GATHER_KINDS.has(r.kind) ? buildGatherSource(r, o.count, gate, tools, catalog) : buildMakeSource(r, item, o.count, gate, tools, catalog));
        }
        for (const m of catalog.bowMakes.get(item) ?? []) sources.push(m);
        if (catalog.tanning.has(item)) sources.push(catalog.tanning.get(item)!);

        for (const a of catalog.actions.get(item) ?? []) {
            const places = a.trigger.includes('loc') && !a.subject.startsWith('_') ? [catalog.locPlace(a.subject)] : a.trigger.includes('npc') && !a.subject.startsWith('_') ? catalog.npcsFor(a.subject).map(catalog.npcPlace) : [];
            const quest = a.src.startsWith('scripts/quests/');
            sources.push({
                kind: 'action', trigger: a.trigger, subject: a.subject, places, src: a.src,
                gate: quest ? 'quest script: may give the item once or only at a quest stage' : null,
                blocked: places.length && places.every(p => p.spawns === 0) ? 'no spawn of the loc or npc in the maps' : null,
                cost: cost({ ticksNote: 'script action; time not modelled', coinsNote: 'the script may take coins or items; read the cited line', riskNote: 'not modelled' }),
            });
        }

        const os = catalog.objSpawns.get(item) ?? [];
        if (os.length) sources.push({
            kind: 'pickup', spawns: os.length, countPerSpawn: os[0]!.count, tiles: sourceTiles(os), wilderness: os.every(inWilderness), src: os[0]!.src, gate: null, blocked: null,
            cost: cost({ ticksNote: 'walk and take; respawn time is the engine default and is not read here', coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent', risk: os.every(inWilderness) ? null : 0, riskBasis: os.every(inWilderness) ? 'model' : 'content', riskNote: os.every(inWilderness) ? 'every spawn is in the Wilderness' : 'no combat at the spawn' }),
        });

        sources.push(...buildShopSources(item, def?.cost ?? 0, catalog));
        sources.push(...(dropSources.get(item) ?? []));
        const ge = geSource(item, def?.tradeable, opts.market);
        if (ge) sources.push(ge);
        const owned = ownedSource(item, def?.id, opts.owned, catalog.stackable);
        if (owned) sources.push(owned);

        const usable = sources.filter(s => !s.blocked && !s.gate && s.kind !== 'owned').length;
        out.push({
            item, id: def?.id ?? null, name: def?.name ?? null, cost: def?.cost ?? null, members: def?.members ?? null, tradeable: def?.tradeable ?? null, stackable: catalog.stackable.has(item),
            neededBy: [...by].sort(), substitutes: buildSubstitutes(item, catalog),
            delivery: { scoredTicksPerTrade: TRADE_TICKS, helperTicksPerTrade: TRADE_TICKS, unitsPerTrade: catalog.stackable.has(item) ? null : PACK_SLOTS, basis: 'measured', note: 'helper trade to the scored account (scripts/measure/trade-supply.ts); a stackable item takes one slot for any count' },
            sources, usable, blocked: usable === 0,
        });
    }
    return out;
}
