// Shared planning pass state: funding/demand caches, travel fare memoization, valuation, and donor stock pools.
import { squadKeeps } from '../../squad';
import {
    ARMY_BANK, PLACES, bandLeft, meetFor, norm, wayCost,
    type Acct, type Assignment, type GoalNeed, type Inputs, type KitLine, type Lack, type Spot, type Stock, type Template,
} from '../world';
import {
    FEEDS, FUND_RESERVE, KIT_BUY, PILOT_FALLBACK_SHARE, SHOP_SUPPLIED, VALUE_TICKS,
    feedUnits, jobValue, selfServePilot,
} from '../pricing';
import { coinShort, kitReserve } from './needs';
import { goalNeeds } from './goal-needs';

export type Cand = {
    account: string; template: Template; value: number; resources: string[]; reason: string;
    coins?: number; fare?: number; goal?: { band: number; left: number }; lacks?: Lack[];
    supply?: { template: Template; account: Acct; share: number }; kit?: readonly KitLine[];
};
export type Miss = { template: Template; gate: 'retired' | 'pilot' | 'demand' | 'reach' | 'roster' | 'needs' | 'coins' };

export function createPlanState(input: Inputs) {
    let inp: Inputs = { ...input, templates: input.templates.filter(t => (!t.wilderness || !!input.allowWilderness) && (!t.once || (!!input.questsDone && !!t.quest && !input.questsDone.has(norm(t.quest.name))))) };
    // An active squad's members never give their kit or supplies to another account's order: they leave the donor stock
    // and the coin donors, and only the squad's own restock reads their stock, above their squad reserve.
    const squadNames = new Set(inp.squad?.active ? (inp.squad.all ?? inp.squad.members.map(m => m.name)).map(n => n.toLowerCase()) : []);
    const memberStock = (inp.stock ?? []).filter(s => squadNames.has(s.name.toLowerCase()));
    // Only the members that are free (`members`: observed, with no live session or stop file) may send each other stock: a held member is in `all`, not here.
    const freeMembers = new Set((inp.squad?.active ? inp.squad.members : []).map(m => m.name.toLowerCase()));
    if (squadNames.size) inp = { ...inp, stock: (inp.stock ?? []).filter(s => !squadNames.has(s.name.toLowerCase())), donors: (inp.donors ?? []).filter(d => !squadNames.has(d.name.toLowerCase())) };
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    // An active squad's members take no band, kit buy or supply job: they are held for the squad's staging, and only its restock gives them anything.
    const demand = goalNeeds(inp, mine.filter(a => !squadNames.has(a.name.toLowerCase()))), fed = new Map<string, number>();
    const values: Inputs = { ...inp, coinValue: 1, bill: demand.map(d => ({ item: d.names[0]!, aliases: d.names.slice(1), short: d.short, need: d.short, owned: 0, ids: [], holders: [] })) };
    const localByName = new Map(mine.map(a => [a.name.toLowerCase(), a])), byName = new Map(mine.map(a => [a.name, a]));
    const earnedCoins = new Map<string, number>(), bridges = new Map<string, { recipient: string; target: number }>(), bridged = new Set<string>();
    const fundingDonors = (inp.donors ?? []).filter(d => !inp.unfundable?.has(d.name.toLowerCase()) && !inp.running?.has(d.name.toLowerCase())
        && (inp.owners.get(d.name.toLowerCase())?.side ?? inp.side) === inp.side);

    const fareCache = new Map<string, number | null>();
    const cachedWayCost = (from: Spot | undefined, to: Spot | undefined, mountain: boolean): number | null => {
        if (!to) return 0;
        if (!from) return wayCost(from, to, mountain);
        const k = `${from.x},${from.z},${from.level ?? 0}>${to.x},${to.z},${to.level ?? 0}:${mountain ? 1 : 0}`;
        if (fareCache.has(k)) return fareCache.get(k)!;
        const c = wayCost(from, to, mountain);
        fareCache.set(k, c);
        return c;
    };
    const canGiveCache = new Map<string, boolean>();
    const canGiveCoins = (name: string, recipient: string) => {
        const lower = recipient.toLowerCase(), fromKey = name.toLowerCase(), cacheKey = `${fromKey}>${lower}`;
        if (canGiveCache.has(cacheKey)) return canGiveCache.get(cacheKey)!;
        const to = localByName.get(lower), from = localByName.get(fromKey);
        let ok = false;
        if (to && fromKey !== lower && !inp.unfundable?.has(lower)) {
            const meet = meetFor(to.pos);
            if (meet !== null) {
                const fare = cachedWayCost(from?.pos, meet === 'ardougne' ? ARMY_BANK : PLACES['shop:zaff'], from ? inp.mountain?.(from) ?? true : true);
                ok = fare !== null && (fare === 0 || (from?.items.coin ?? 0) >= fare);
            }
        }
        canGiveCache.set(cacheKey, ok);
        return ok;
    };

    // Own kit cash stays with its recipient. A free donor contributes only transferable surplus, once across all
    // recipients. One donor must be able to give each credited share: several small, unusable trades are no funding.
    let fundingEpoch = 0;
    const bumpEpoch = () => { fundingEpoch++; };
    let cachedFunding: { epoch: number; value: { army: Map<string, number>; kits: Map<string, number>; route: number } } | undefined;
    const funding = () => {
        if (cachedFunding?.epoch === fundingEpoch) return cachedFunding.value;
        const army = new Map<string, number>();
        let route = 0;
        for (const d of demand) if (d.budget) {
            if (d.account) army.set(d.account, (army.get(d.account) ?? 0) + d.budget());
            else route += d.budget();
        }
        const cash = new Map(mine.map(a => [a.name.toLowerCase(), (a.items.coin ?? 0) + (earnedCoins.get(a.name.toLowerCase()) ?? 0)]));
        const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE - (army.get(d.name.toLowerCase()) ?? 0))]));
        const given = new Map<string, number>(), lacks = new Map<string, number>();
        for (const [name, cost] of [...army].sort(([x], [y]) => x.localeCompare(y))) {
            let short = Math.max(0, cost - (cash.get(name) ?? 0));
            const donor = [...pool].filter(([from, left]) => left > 0 && canGiveCoins(from, name)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
            if (donor && short > 0) {
                const coins = Math.min(short, donor[1]);
                short -= coins; pool.set(donor[0], donor[1] - coins);
                given.set(donor[0].toLowerCase(), (given.get(donor[0].toLowerCase()) ?? 0) + coins);
            }
            lacks.set(name, short);
        }
        let available = [...cash].reduce((n, [name, coins]) => n + Math.max(0, coins - Math.max(army.get(name) ?? 0, bridges.get(name)?.target ?? 0) - (given.get(name) ?? 0)), 0);
        for (const [name, coins] of pool) if (!cash.has(name.toLowerCase()) && mine.some(a => canGiveCoins(name, a.name))) available += coins;
        const value = { army: lacks, kits: army, route: Math.max(0, route - available) };
        cachedFunding = { epoch: fundingEpoch, value };
        return value;
    };

    // Banked inputs already cover their downstream need. Reserve direct bill stock and army kits before treating
    // an input as spare; producing it again would count the same route requirement twice.
    const inputStock = new Map<string, number>();
    const armyKits = mine.filter(a => inp.army?.has(a.name.toLowerCase())).map(a => [a, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a)] as const);
    for (const item of Object.keys(FEEDS)) {
        const holders = new Map<string, number>();
        for (const a of inp.accounts) holders.set(a.name.toLowerCase(), a.items[item] ?? 0);
        for (const s of inp.stock ?? []) holders.set(s.name.toLowerCase(), Math.max(holders.get(s.name.toLowerCase()) ?? 0, s.items[item] ?? 0));
        const rows = inp.bill.filter(r => [r.item, ...(r.aliases ?? [])].some(name => norm(name) === item));
        const held = Math.max([...holders.values()].reduce((n, count) => n + count, 0), rows.reduce((n, r) => n + r.owned, 0));
        const army = armyKits.reduce((n, [a, kit]) => n + Math.min(a.items[item] ?? 0, kit[item] ?? 0), 0);
        inputStock.set(item, Math.max(0, held - rows.reduce((n, r) => n + r.need, 0) - army));
    }
    let demandCacheEpoch = -1, directCache = new Map<string, number>(), strictDirectCache = new Map<string, number>(), downstreamCache = new Map<string, number>();
    const ensureDemandCaches = () => {
        if (demandCacheEpoch === fundingEpoch) return;
        demandCacheEpoch = fundingEpoch;
        directCache = new Map<string, number>(); strictDirectCache = new Map<string, number>(); downstreamCache = new Map<string, number>();
        for (const d of demand) if (!d.budget && d.short > 0) {
            for (const name of new Set(d.names.flatMap(n => [n, norm(n)]))) directCache.set(name, (directCache.get(name) ?? 0) + d.short);
            if (d.names.length === 1) for (const name of new Set([d.names[0]!, norm(d.names[0]!)])) strictDirectCache.set(name, (strictDirectCache.get(name) ?? 0) + d.short);
        }
    };
    const direct = (item: string, strict = false) => { ensureDemandCaches(); return (strict ? strictDirectCache : directCache).get(item) ?? 0; };
    const downstream = (item: string) => {
        ensureDemandCaches();
        if (downstreamCache.has(item)) return downstreamCache.get(item)!;
        const val = demand.reduce((n, d) => n + (d.names.includes(item) ? 0 : d.short * Math.max(0, ...d.names.map(name => feedUnits(item, name)))), 0);
        downstreamCache.set(item, val);
        return val;
    };
    const needed = (item: string, account?: string, strict = false) => {
        if (item !== 'coin') return direct(item, strict) + (strict ? 0 : Math.max(0, downstream(item) - (inputStock.get(item) ?? 0) - (fed.get(item) ?? 0)));
        const cash = funding(), lower = account?.toLowerCase(), bridge = lower ? bridges.get(lower) : undefined;
        const own = lower ? bridged.has(lower) ? 0 : cash.army.get(lower) ?? 0 : [...cash.army.values()].reduce((n, coins) => n + coins, 0);
        const gift = bridge ? Math.max(0, bridge.target - (localByName.get(lower!)?.items.coin ?? 0) - (earnedCoins.get(lower!) ?? 0)) : 0;
        return direct(item) + cash.route + own + gift;
    };
    const finiteOrder = (t: Template, a: Acct): Template | null => {
        const p = t.production; if (!p) return t.script === 'scripts/train-prayer.ts' && t.env?.BURY_HELD === '1'
            ? { ...t, repeats: false, env: { ...t.env, AUTOPILOT_ORDER: String(inp.kitSeq?.get(a.name.toLowerCase()) ?? 0) } } : t;
        const dem = Math.ceil(needed(norm(p.output), a.name, !!p.strictOutput) / p.outputPerUnit);
        if (dem < 1) return null;
        const available = Math.min(...Object.entries(p.inputs).map(([item, n]) => Math.max(0, Math.floor(((a.items[norm(item)] ?? 0) - (p.reserves?.[item] ?? 0)) / n))));
        const units = Math.min(p.maximum, dem, available > 0 ? available : Infinity), items = { ...t.needs?.items };
        for (const [item, n] of Object.entries(p.inputs)) items[item] = n * units + (p.reserves?.[item] ?? 0);
        const resized = p.resize(units, a.items[norm(p.output)] ?? 0);
        const baseline = JSON.stringify([a.items[norm(p.output)] ?? 0, ...Object.keys(p.inputs).sort().map(item => [norm(item), a.items[norm(item)] ?? 0])]);
        return { ...t, ...resized, env: { ...t.env, ...resized.env, AUTOPILOT_ORDER: baseline }, repeats: false,
            needs: { ...t.needs, items }, production: { ...p, maximum: units } };
    };
    const consume = (item: string, count: number, account?: string, bought = false) => {
        for (const d of demand) if (count > 0 && !d.budget && d.names.some(n => n === item || norm(n) === item) && (account === undefined || d.account === account.toLowerCase())) {
            const used = Math.min(d.short, count); d.short -= used; count -= used;
            if (bought) d.bought = (d.bought ?? 0) + used;
            if (used > 0) fundingEpoch++;
        }
        return count;
    };
    const reserveKit = (account: string, lines: readonly { item: string; quantity: number }[], bought = true) => {
        for (const l of lines) consume(norm(l.item), l.quantity, account, bought);
    };
    const reserveOutput = (t: Template, a: Acct) => {
        const strict = !!t.production?.strictOutput;
        for (const f of t.yields(a)) {
            const item = norm(f.item), count = Math.min(t.production && item === norm(t.production.output) ? t.production.maximum * t.production.outputPerUnit : Math.max(0, f.perTick) * VALUE_TICKS, needed(item, a.name, strict));
            const rest = consume(item, count);
            if (item === 'coin') { earnedCoins.set(a.name.toLowerCase(), (earnedCoins.get(a.name.toLowerCase()) ?? 0) + rest); if (rest > 0) fundingEpoch++; }
            else if (rest > 0) fed.set(item, (fed.get(item) ?? 0) + rest);
        }
    };
    const onList = (t: Template) => !t.pilot || !!inp.pilots?.has(t.id);
    const admitted = (t: Template, a?: Acct) => onList(t) || (!!inp.pilotFallback && selfServePilot(t) && !(a && (inp.army?.has(a.name.toLowerCase()) || squadNames.has(a.name.toLowerCase()))));
    const valueOf = (t: Template, a: Acct) => jobValue(t, a, values, item => needed(item, a.name, !!t.production?.strictOutput)) * (onList(t) ? 1 : PILOT_FALLBACK_SHARE);
    const makesCoins = (t: Template, a: Acct) => t.yields(a).some(f => norm(f.item) === 'coin' && f.perTick > 0);
    const shopLine = (l: Lack) => !l.of.some(i => inp.market?.[i]) && l.of.some(i => SHOP_SUPPLIED.has(i));
    const meetOf = new Map(mine.map(a => [a.name, meetFor(a.pos)]));
    const fundable = (a: Acct) => (!!inp.donors?.length || !!inp.stock?.some(s => s.side !== inp.side && (s.items.coin ?? 0) > FUND_RESERVE))
        && !inp.unfundable?.has(a.name.toLowerCase()) && meetOf.get(a.name) !== null;
    const fareShort = new Map<string, { id: string; coins: number; fare: number; resources: string[] }[]>();
    const lacksFare = (a: Acct, t: Template, fare: number) => { fareShort.set(a.name, [...(fareShort.get(a.name) ?? []), { id: t.id, coins: coinShort(a, t.needs), fare, resources: t.resources ?? [] }]); };
    const misses = new Map<string, Miss[]>();
    const miss = (a: Acct, template: Template, gate: Miss['gate']) => { const list = misses.get(a.name); if (list) list.push({ template, gate }); else misses.set(a.name, [{ template, gate }]); };

    const cands: Cand[] = [];
    const used = new Map(Object.entries(inp.taken ?? {})), done = new Map<string, Assignment>();
    const keeps = (c: Cand) => inp.current?.get(c.account.toLowerCase()) === c.template.id ? 1 : 0;
    const worth = (c: Cand) => c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : (used.get(r) ?? 0)),
        c.supply ? c.supply.share * valueOf(c.supply.template, c.supply.account) : c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    const goalOrder = (x: Cand, y: Cand) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)]));
    const gave = new Set<string>(), gaveItems = new Set<string>(), vacated = new Map<string, string>(), gearValue = new Map<string, number>(), waits = new Map<string, string>();

    const reserve = kitReserve(inp.templates);
    const stock = [...(inp.stock ?? [])].sort((x, y) => Number(y.side === inp.side) - Number(x.side === inp.side));
    const ownReserve = new Map<string, Record<string, number>>();
    const squadKeep = inp.squad?.active ? squadKeeps(inp.squad.hours) : undefined, squadMember = new Set((inp.squad?.all ?? inp.squad?.members.map(m => m.name) ?? []).map(n => n.toLowerCase()));
    const keepsOf = (s: Stock) => {
        if (squadKeep && squadMember.has(s.name.toLowerCase())) return { ...reserve, ...Object.fromEntries(Object.entries(squadKeep).map(([i, n]) => [i, Math.max(n, reserve[i] ?? 0)])) };
        const a = s.side === inp.side ? byName.get(s.name) : undefined;
        if (!a || !inp.army?.has(a.name.toLowerCase())) return reserve;
        if (!ownReserve.has(a.name)) ownReserve.set(a.name, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a));
        return ownReserve.get(a.name)!;
    };
    const spare = (s: Stock, item: string) => Math.max(0, (s.items[item] ?? 0) - (keepsOf(s)[item] ?? 0));
    const cashSource = (recipient: string, coins: number, far: boolean): string | undefined => {
        const own = [...pool].filter(([name, left]) => left >= coins && !done.has(name) && !gaveItems.has(name) && canGiveCoins(name, recipient)).sort((x, y) => y[1] - x[1])[0]?.[0];
        if (own || !far) return own;
        return stock.filter(s => s.side !== inp.side && !gave.has(s.name) && !gaveItems.has(s.name) && !done.has(s.name)
            && !inp.unfundable?.has(s.name.toLowerCase()) && !inp.running?.has(s.name.toLowerCase())
            && !inp.noSend?.has(`${s.name}>${recipient}`.toLowerCase()) && (s.items.coin ?? 0) - FUND_RESERVE >= coins && canGiveCoins(s.name, recipient))
            .sort((x, y) => (y.items.coin ?? 0) - (x.items.coin ?? 0) || x.name.localeCompare(y.name))[0]?.name;
    };
    const reachesMeet = (name: string) => { const p = byName.get(name), cost = cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true); return cost !== null && (cost === 0 || (p!.items.coin ?? 0) >= cost); };
    const banded = (id: string) => byId.get(id)?.tier === 'goal' && !byId.get(id)?.filler;
    const goalNow = (account: string) => { const id = inp.current?.get(account.toLowerCase()); return !!id && (id.startsWith(KIT_BUY) || banded(id)); };

    return {
        inp, byId, mine, squadNames, memberStock, freeMembers, demand, values, localByName, byName, earnedCoins, bridges, bridged,
        cands, fareShort, misses, used, done, pool, gave, gaveItems, vacated, gearValue, waits, stock, meetOf,
        bumpEpoch, cachedWayCost, canGiveCoins, funding, needed, finiteOrder, reserveKit, reserveOutput, valueOf, makesCoins,
        onList, admitted, shopLine, fundable, lacksFare, miss, keeps, worth, order, goalOrder, spare, cashSource, reachesMeet, goalNow,
    };
}
export type PlanState = ReturnType<typeof createPlanState>;
