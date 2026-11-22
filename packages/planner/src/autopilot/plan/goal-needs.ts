// Finite route, army kit, gang squad, and specialist staging demand synthesis (`goalNeeds`).
import { squadRows, squadTarget } from '../../squad';
import { bandLeft, norm, pairKey, type Acct, type GoalNeed, type Inputs, type Lack, type Template } from '../world';
import { KIT_CASH_RESERVE, KIT_COIN_MARGIN, KIT_PRICE_CAPS, SQUAD_UNIT_COST, specialistStagingNeeds } from '../pricing';
import { buildBand } from '../catalogue';
import { kitLacks } from './needs';
import { armourItemsFor, kitStyle, kitStylesOf, rangedStagesFor, toolUpgradeNeed, weaponStageFor } from './kits';

export function goalNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const route: GoalNeed[] = inp.bill.filter(r => r.short > 0).map(r => ({ names: [r.item, ...(r.aliases ?? [])].map(norm), short: r.short, consumer: `Overall route: ${r.item}` }));
    const routeDemand = new Set(route.flatMap(r => r.names));
    const needs = [...route];
    const budget = (consumer: string, cost: () => number, account?: string) => {
        const coins = cost();
        if (coins > 0) needs.push({ names: ['coin'], short: coins, consumer, budget: cost, account });
    };
    const price = (item: string) => inp.market?.[item]?.limit ?? KIT_PRICE_CAPS[item] ?? inp.prices[item] ?? 0;
    const startable = (a: Acct, listed: Template) => {
        if (listed.wilderness && !inp.allowWilderness) return undefined;
        const lower = a.name.toLowerCase(), t = buildBand(listed, a, inp.builds?.get(lower), inp.buildQuests?.get(lower), inp.buildBefore?.get(lower));
        return !t || t.tier !== 'goal' || bandLeft(t, a) <= 0 || (t.pilot && !inp.pilots?.has(t.id)) || inp.retired?.has(pairKey(a.name, t.id)) ? undefined : t;
    };
    // A `once` quest is one account's run: only the first army account (by name, as the kit tier takes them) that can
    // start it asks for its pack, so 21 accounts that meet the Temple of Ikov journal do not ask for 21 packs.
    const onceOwner = new Map<string, string>();
    for (const listed of inp.templates) if (listed.once) {
        const owner = [...mine].sort((x, y) => x.name.localeCompare(y.name)).find(a => inp.army?.has(a.name.toLowerCase()) && !!startable(a, listed) && kitLacks(a, listed.needs, item => !!inp.market?.[item]) !== null);
        if (owner) onceOwner.set(listed.id, owner.name.toLowerCase());
    }
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower)) continue;
        const kit = new Map<string, { count: number; bands: Set<string> }>();
        let cash = 0, keep = 0;
        const bands: { template: Template; lacks?: Lack[] }[] = [];
        for (const listed of inp.templates) {
            const t = startable(a, listed);
            if (!t || (t.once && onceOwner.get(t.id) !== lower)) continue;
            const lacks = kitLacks(a, t.needs, item => !!inp.market?.[item]);
            if (lacks === null) continue;
            bands.push({ template: t, lacks: lacks.length ? lacks : undefined });
            cash = Math.max(cash, ...Object.entries(t.needs?.items ?? {}).filter(([item]) => norm(item) === 'coin').map(([, count]) => count));
            keep = Math.max(keep, t.keepCoins?.(a) ?? 0);
            const batch = t.batchFor?.(a) ?? t.batch;
            for (const lack of lacks) {
                const choices = [...lack.of].sort((x, y) => Number(!!inp.market?.[y]) - Number(!!inp.market?.[x]) || (price(x) || Infinity) - (price(y) || Infinity) || x.localeCompare(y));
                const item = choices[0];
                if (!item) continue;
                const count = Math.max(lack.count, (batch?.[item] ?? 0) - (a.items[item] ?? 0));
                const entry = kit.get(item) ?? { count: 0, bands: new Set<string>() };
                entry.count = Math.max(entry.count, count); entry.bands.add(t.id); kit.set(item, entry);
            }
        }
        bands.sort((x, y) => (x.template.band ?? 0) - (y.template.band ?? 0));
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) kit.set(wStage.item, { count: 1, bands: new Set([wStage.id]) });
        for (const arm of armourItemsFor(a, inp, styles)) for (const item of arm.items) if (!kit.has(item)) kit.set(item, { count: 1, bands: new Set([arm.id]) });
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) for (const { item, count } of stage.items) if (!kit.has(item)) kit.set(item, { count, bands: new Set([stage.id]) });
        const toolItem = toolUpgradeNeed(a, routeDemand);
        if (toolItem && !kit.has(toolItem)) kit.set(toolItem, { count: 1, bands: new Set(['tool-upgrade']) });
        const lines = [...kit].map(([item, entry]) => {
            const need: GoalNeed = { names: [item], short: entry.count, consumer: `army kit ${a.name}: ${[...entry.bands].join(', ')}`, account: lower };
            needs.push(need);
            return { need, price: price(item) };
        });
        budget(`army kit ${a.name}`, () => {
            const cost = lines.reduce((n, l) => n + (l.need.short + (l.need.bought ?? 0)) * l.price, 0);
            return cash + keep + cost + (cost > 0 ? KIT_CASH_RESERVE + KIT_COIN_MARGIN : 0);
        }, lower);
    }
    for (const need of route) if (!need.names.includes('coin')) {
        const cost = Math.max(0, ...need.names.map(item => inp.market?.[item]?.limit ?? inp.prices[item] ?? 0));
        if (cost > 0) budget(need.consumer, () => (need.short + (need.bought ?? 0)) * cost);
    }
    // The gang squad's stock targets, after every kit line: a row has no coin budget, so it never takes coins that a
    // member's own kit buy or a route purchase needs, and it never counts toward their funding.
    for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) needs.push({ names: row.names, short: row.short, consumer: row.consumer, account: row.account });
    if (inp.squad?.active) {
        const arrowTarget = squadTarget('arrow', inp.squad.hours);
        for (const m of inp.squad.members) {
            const shortPoison = Math.max(0, arrowTarget - (m.items['rune arrow(p)'] ?? 0));
            if (shortPoison > 0 && !needs.some(n => n.account === m.name.toLowerCase() && n.names[0] === 'rune arrow(p)')) {
                needs.push({ names: ['rune arrow(p)'], short: shortPoison, consumer: `gang squad ${m.name}: poison rune arrows`, account: m.name.toLowerCase() });
            }
        }
    }
    for (const row of specialistStagingNeeds(inp, mine)) needs.push(row);
    return needs;
}
