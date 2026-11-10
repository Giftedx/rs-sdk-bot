// Autopilot: writes a fleet side's swarm jobs from the route supply bill, account skills and holdings, and tick waste,
// so no person picks jobs, restarts ended ones or spots loops (plan Lanes table, Autopilot).
// plan() is pure: one assignment per account of this side, highest value per tick first, from proven templates only,
// never more accounts on one resource (a knight spot, a chicken pen, a shop) across all sides than its capacity
// (CAPACITY: four farmers to a knight spot, one to a pen or a shop). A job on a resource other accounts already hold
// keeps that resource's shared rate of its value once per holder (SHARED), so the empty spots fill first.
// Value is an estimate in coins per game tick: each output's rate times its unit value, minus coin spend, times the
// script family's measured work share (1 - idle - move, scripts/tick-waste.ts). A training template is worth a share
// of the best job it unlocks, and reserves that job's resource. assess() reads a job's recent log lines and retires
// it after repeated fail RESULTs or a run that was nearly all idle and walking. finishedTrainers() names the accounts
// whose trainer reached its target, so the next pass needs no timer. scripts/autopilot.ts applies it.
import type { BillRow } from './supply-bill';
import { missionSignature } from '../../core/src/session-admission';

export type Acct = { name: string; side: string; skills: Record<string, number>; items: Record<string, number> };
export type Flow = { item: string; perTick: number };
// `under`: skills that must stay below a level (a band hands an account on to the next band at that level).
// `holdsUnder`: holdings that end the job at once. The account must hold fewer, or the run finds its target met and fails.
// `food`: HP the account's food heals, pack and bank (FOOD_HEAL). `pieces`: at least `count` items of any of `of`.
// `anyOf`: at least one of these needs met in full (fire runes or a fire staff; a bow the account wields with arrows it fires).
export type Needs = {
    skills?: Record<string, number>; items?: Record<string, number>; under?: Record<string, number>; holdsUnder?: Record<string, number>; food?: number;
    pieces?: { of: readonly string[]; count: number }; anyOf?: readonly Needs[];
};
export type Template = {
    id: string; family: string; script: string; args?: string[]; env?: Record<string, string>; role: string; goal: string;
    needs?: Needs;
    yields: (a: Acct) => Flow[]; spends?: (a: Acct) => Flow[];
    resources?: string[]; trains?: { skill: string; to: number; unlocks: string[] };
    // A goal band (AGENTS.md goals: the PK army of maxed tribrids) trains an army account toward its target and is
    // assigned before any coin job; `band` orders the bands by PK value, lowest first. Gold only buys their kits.
    tier?: 'goal'; band?: number;
    // A trainer whose script runs a fixed amount (not to its target level) repeats until the planner moves it on.
    repeats?: boolean;
    // The stock a kit buy brings an item up to, by item name: more than the start minimum in `needs`, so one login
    // buys a batch (nature runes for many alchemy casts) and not one start's worth.
    batch?: Record<string, number>;
};
// One missing kit line: `count` more units of any one item of `of`.
export type Lack = { of: readonly string[]; count: number };
// `send`: a free account (this side first, then another side) gives the item; scripts/autopilot.ts places the fleet
// order, and the account takes the band on the pass after the item arrives.
export type ItemFunding = { from: string; to: string; item: string; count: number; template: string };
// A free account that can give: no enabled job on its side, no stop file, no open order. `items` by norm() name.
export type Stock = { name: string; side: string; items: Record<string, number> };
// Items a kit buy may order on the Grand Exchange, by norm() name: the item id, its display name and the unit price cap.
export type Market = Readonly<Record<string, { id: number; name: string; limit: number }>>;
// `fund`: the template needs coins the account lacks; a donor of this side sends them first (scripts/autopilot.ts
// places the fleet order), and the account takes the job on the pass after the coins arrive.
export type Funding = { from: string; to: string; coins: number; template: string };
export type Assignment = { account: string; template?: Template; value: number; reason: string; resources: string[]; fund?: Funding; send?: ItemFunding };
export type Inputs = {
    side: string; accounts: readonly Acct[]; owners: ReadonlyMap<string, { side: string }>; bill: readonly BillRow[];
    templates: readonly Template[]; prices: Readonly<Record<string, number>>; waste?: Readonly<Record<string, number>>;
    taken?: Readonly<Record<string, number>>; retired?: ReadonlySet<string>; capacity?: Readonly<Record<string, number>>;
    // The share of its value a job keeps on a resource another account already holds (default 1).
    shared?: Readonly<Record<string, number>>;
    // The template each account holds now, by lower-case name: on a value tie the account keeps it.
    current?: ReadonlyMap<string, string>;
    // Accounts of this side free to trade now (no enabled swarm job), with their coins. Each keeps FUND_RESERVE.
    donors?: readonly { name: string; coins: number }[];
    // Lower-case names of accounts with an enabled job. Funding one would remove its running job, and the stop file
    // scripts/swarm.ts writes for it would block the trade, so such an account is never funded.
    unfundable?: ReadonlySet<string>;
    // Lower-case names of the accounts on this side's army roster: only they take goal bands. A specialist's board
    // time counts every tick it plays, so combat training is opt-in per account, never global.
    army?: ReadonlySet<string>;
    // Free accounts of every side with their holdings: item and coin donors for an army account's kit. This side's
    // donors give first; another side's give only when none of this side can.
    stock?: readonly Stock[];
    // The items a kit buy may order. Absent: the planner plans no buy.
    market?: Market;
    // What one coin is worth to this side now (coinValueFor; default 1).
    coinValue?: number;
    // Each account's kit-buy count, by lower-case name (kitBuyTemplate `seq`; default 0).
    kitSeq?: ReadonlyMap<string, number>;
    // Donor and recipient pairs whose item order failed lately, as `from>to` in lower case: no new order for them.
    noSend?: ReadonlySet<string>;
};
export const FUND_RESERVE = 50_000;
// The template id of a kit buy for a goal band: `kit-buy:<band id>`. A retired pair (two fail RESULTs with no
// progress: no stock under the cap) sends the account to the donors instead.
export const KIT_BUY = 'kit-buy:', KIT_BUY_SCRIPT = 'scripts/buy-owned-ge-item.ts';
// The coins a kit buy leaves in the bank (the buy script's CASH_RESERVE). A kit costs far less than FUND_RESERVE, which
// guards a coin donor, so a buyer keeps only this.
export const KIT_CASH_RESERVE = 1_000;
// Unit price caps for kit buys, in coins. Estimates: the owner's hand jobs cap a law rune at 1,600 (shop value 40) and
// a shark at 810 to 1,200 (shop value 300), so a rune caps at about 40 times and food at about 4 times its shop value.
// An offer fills at or under its cap, and scripts/buy-owned-ge-item.ts refunds what does not fill. Gap: no measured
// Grand Exchange price for these items.
export const KIT_PRICE_CAPS: Readonly<Record<string, number>> = {
    'mind rune': 120, 'air rune': 160, 'fire rune': 160, 'nature rune': 800, feather: 20,
    'bronze arrow': 20, 'iron arrow': 40, 'steel arrow': 100, 'mithril arrow': 200, 'adamant arrow': 400, 'rune arrow': 1200,
    trout: 100, lobster: 500, swordfish: 700, shark: 1200,
};

// A bill line still short is worth twice its shop value: it is acquisition work the route needs. A unit nobody needs
// is worth half, the price a sale would fetch. A share of a job a training run unlocks counts for the training.
export const BILL_PREMIUM = 2, SURPLUS = 0.5, TRAIN_SHARE = 0.25;
// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
export const FEEDS: Record<string, string[]> = { feather: ['headless arrow'], 'arrow shaft': ['headless arrow'], 'raw lobster': ['lobster'] };
export const norm = (s: string) => s.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim().replace(/s$/, '');
export const pairKey = (account: string, template: string) => `${account.toLowerCase()}:${template}`;
// HP one held item heals over all its bites, by item name: scripts/gather-combat.ts COW_FOOD_BITES × COW_BITE_HEAL
// (trout 7; a cake bite 4, a chocolate cake bite 5). scripts/autopilot.test.ts checks the two tables agree.
export const FOOD_HEAL: Readonly<Record<string, number>> = {
    trout: 7, cake: 12, '2/3 cake': 8, 'slice of cake': 4, 'chocolate cake': 15, '2/3 chocolate cake': 10, 'chocolate slice': 5,
};
export const foodHeal = (a: Acct) => Object.entries(FOOD_HEAL).reduce((n, [item, hp]) => n + (a.items[item] ?? 0) * hp, 0);

// Gold is a supply, never a goal (AGENTS.md). A side that banks COIN_GLUT coins or more holds more than its kits and
// supplies cost, so one more coin is worth COIN_GLUT_VALUE: a coin job then ranks under every job that makes a short
// bill line, and stays only as the last job for an account nothing else fits. Estimate: the level is not priced from
// the bill.
export const COIN_GLUT = 10_000_000, COIN_GLUT_VALUE = 0.01;
export const coinValueFor = (sideCoins: number) => sideCoins >= COIN_GLUT ? COIN_GLUT_VALUE : 1;
export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>, coin = 1): number {
    const k = norm(item);
    if (k === 'coin') return coin;
    const short = new Set(bill.filter(r => r.short > 0).flatMap(r => [r.item, ...(r.aliases ?? [])].map(norm)));
    return (prices[k] ?? 0) * (short.has(k) || (FEEDS[k] ?? []).some(f => short.has(f)) ? BILL_PREMIUM : SURPLUS);
}

const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }): boolean =>
    Object.entries(needs?.skills ?? {}).every(([s, l]) => (skillOverride?.skill === s ? Math.max(skillOverride.to, a.skills[s] ?? 1) : a.skills[s] ?? 1) >= l)
    && Object.entries(needs?.items ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n)
    && Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
    && Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n)
    && foodHeal(a) >= (needs?.food ?? 0)
    && (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0) >= (needs?.pieces?.count ?? 0)
    && (needs?.anyOf === undefined || needs.anyOf.some(alt => meets(a, alt, skillOverride)));
// The coins a template needs beyond what the account holds, and its needs without the coin line.
const coinShort = (a: Acct, needs: Template['needs']) => Math.max(0, (Object.entries(needs?.items ?? {}).find(([i]) => norm(i) === 'coin')?.[1] ?? 0) - (a.items.coin ?? 0));
const withoutCoins = (needs: Template['needs']): Template['needs'] => ({ ...needs, items: Object.fromEntries(Object.entries(needs?.items ?? {}).filter(([i]) => norm(i) !== 'coin')) });

// The kit lines an account still lacks for these needs, or null when a level it does not have (or a holding it must
// not have) stops the job: no item fixes that. The coin line is not a kit line (coinShort). Of several `anyOf`
// kits the account takes one whose every line it `can` get (a buy: 250 fire runes, not a fire staff no market sells),
// then the one with the fewest missing units.
export function kitLacks(a: Acct, needs: Template['needs'], can: (item: string) => boolean = () => true): Lack[] | null {
    if (!Object.entries(needs?.skills ?? {}).every(([s, l]) => (a.skills[s] ?? 1) >= l)
        || !Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
        || !Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n)) return null;
    const out: Lack[] = [];
    for (const [i, n] of Object.entries(needs?.items ?? {})) {
        const short = n - (a.items[norm(i)] ?? 0);
        if (norm(i) !== 'coin' && short > 0) out.push({ of: [norm(i)], count: short });
    }
    const hp = (needs?.food ?? 0) - foodHeal(a);
    if (hp > 0) out.push({ of: ['trout'], count: Math.ceil(hp / FOOD_HEAL.trout!) });
    const pieces = (needs?.pieces?.count ?? 0) - (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0);
    if (pieces > 0) out.push({ of: needs!.pieces!.of.map(norm), count: pieces });
    if (needs?.anyOf) {
        const units = (lacks: readonly Lack[]) => lacks.reduce((n, l) => n + l.count, 0), blocked = (lacks: readonly Lack[]) => lacks.filter(l => !l.of.some(can)).length;
        const kits = needs.anyOf.map(alt => kitLacks(a, alt, can)).filter((k): k is Lack[] => k !== null).sort((x, y) => blocked(x) - blocked(y) || units(x) - units(y));
        if (!kits.length) return null;
        out.push(...kits[0]!);
    }
    return out;
}
// The most of each item any goal band needs to start, by norm() name: a donor keeps that many, so it never gives away
// its own kit.
export function kitReserve(templates: readonly Template[]): Record<string, number> {
    const reserve: Record<string, number> = {};
    const count = (needs: Template['needs']) => {
        for (const [i, n] of Object.entries(needs?.items ?? {})) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        for (const i of needs?.pieces?.of ?? []) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, needs!.pieces!.count);
        for (const alt of needs?.anyOf ?? []) count(alt);
    };
    for (const t of templates) if (t.tier === 'goal') count(t.needs);
    delete reserve.coin;
    return reserve;
}
// One Grand Exchange order of a kit buy. `held` is what the account holds now: the buy script tops up exactly that many.
export type KitLine = { item: string; id: number; quantity: number; held: number; limit: number };
// The job that buys an army account's missing kit for a goal band: one login, one capped order per item
// (scripts/chain.ts runs scripts/buy-owned-ge-item.ts once per line). The buy script keeps one journal per order key
// and never buys again under a settled key. The key names the account's kit-buy count (`seq`, which
// scripts/autopilot.ts raises when the account leaves a kit buy) and the holding before and after: a rerun of one buy
// continues its order, and a later top-up from the same holding is a new order. Not a trainer: it does not repeat, and
// the account takes the band on the pass after its RESULT.
export function kitBuyTemplate(band: Template, account: string, lines: readonly KitLine[], seq = 0): Template {
    const step = (l: KitLine) => [KIT_BUY_SCRIPT, `ITEM_ID=${l.id}`, `QUANTITY=${l.quantity}`, ...(l.held > 0 ? [`EXPECTED_OWNED=${l.held}`] : []), `LIMIT_PRICE=${l.limit}`,
        `CASH_RESERVE=${KIT_CASH_RESERVE}`, `ORDER_KEY=${account.toLowerCase()}-kit${seq}-${l.id}-${l.held}to${l.held + l.quantity}`, 'ORDER_MS=900000', 'FILL_WAIT_TICKS=200'].join(' ');
    return { id: KIT_BUY + band.id, family: 'kit-buy', script: 'scripts/chain.ts', args: lines.map(step), env: { ROUNDS: '1' }, role: 'supply',
        goal: `buy ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} on the Grand Exchange to ${band.goal}`, repeats: false, yields: () => [] };
}

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste' | 'coinValue'>): number {
    const coin = inp.coinValue ?? 1;
    const gross = t.yields(a).reduce((v, f) => v + f.perTick * unitValue(f.item, inp.bill, inp.prices, coin), 0);
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? coin : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
}

export function plan(inp: Inputs): Assignment[] {
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    type Cand = { account: string; template: Template; value: number; resources: string[]; reason: string; coins?: number; goal?: { band: number; left: number }; lacks?: Lack[] };
    const cands: Cand[] = [];
    for (const a of mine) for (const t of inp.templates) {
        if (inp.retired?.has(pairKey(a.name, t.id))) continue;
        if (t.tier === 'goal') {
            // One candidate per goal band whose target an army account has not met; never for anyone else.
            if (!inp.army?.has(a.name.toLowerCase()) || !t.trains || (a.skills[t.trains.skill] ?? 1) >= t.trains.to) continue;
            const goal = { band: t.band ?? 0, left: t.trains.to - (a.skills[t.trains.skill] ?? 1) }, reason = `army band ${goal.band}: ${t.trains.skill} to ${t.trains.to}`;
            if (meets(a, t.needs)) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
            else if (inp.donors?.length && !inp.unfundable?.has(a.name.toLowerCase()) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)))
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, coins: coinShort(a, t.needs) });
            else if (coinShort(a, t.needs) === 0) {
                // The band lacks only kit items: a buy with the account's own coins, or a free account's spare stock.
                const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
                if (lacks?.length) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, lacks });
            }
            continue;
        }
        if (t.trains) {
            if ((a.skills[t.trains.skill] ?? 1) >= t.trains.to || !meets(a, t.needs)) continue;
            const trained: Acct = { ...a, skills: { ...a.skills, [t.trains.skill]: t.trains.to } };
            for (const u of t.trains.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(a, u.needs, t.trains)) continue;
                const value = TRAIN_SHARE * jobValue(u, trained, inp);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `trains ${t.trains.skill} ${t.trains.to} for ${u.id}` });
            }
        } else if (meets(a, t.needs)) {
            const value = jobValue(t, a, inp);
            if (value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+') });
        } else if (inp.donors?.length && !inp.unfundable?.has(a.name.toLowerCase()) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) {
            const value = jobValue(t, a, inp);
            if (value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), coins: coinShort(a, t.needs) });
        }
    }
    // On a value tie an account keeps the template it holds: a level change must not move it to another spot of the
    // same worth, which would replace a running job with a fresh one that changes nothing useful.
    const keeps = (c: Cand) => inp.current?.get(c.account.toLowerCase()) === c.template.id ? 1 : 0;
    const used = new Map(Object.entries(inp.taken ?? {})), done = new Map<string, Assignment>();
    // A candidate's worth with the holders taken so far: each holder of a resource scales it by that resource's shared
    // rate, so a third farmer on a spot is worth less than a second and new farmers spread over the spots. The place an
    // account already holds keeps its full worth: crowding counts only against a move, so a farmer stays put until its
    // spot is full (capacity is a hard limit below), and sides do not chase each other's lagging claims.
    const worth = (c: Cand) => c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : (used.get(r) ?? 0)), c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // Donor coins above the reserve, spent as funded candidates take them; a funded account gives nothing.
    // A donor that gives stays free this pass, so the fleet agent can log it in for the trade.
    const pool = new Map((inp.donors ?? []).map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)])), gave = new Set<string>();
    // Accounts that give an item this pass, and accounts that leave a coin job so a kit order can reach them.
    const gaveItems = new Set<string>(), vacated = new Map<string, string>();
    const take = (c: Cand, value: number) => {
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        let fund: Funding | undefined;
        if (c.coins) {
            const from = [...pool].filter(([n, left]) => n.toLowerCase() !== c.account.toLowerCase() && !done.has(n) && left >= c.coins!).sort((x, y) => y[1] - x[1])[0]?.[0];
            if (!from) return;
            pool.set(from, pool.get(from)! - c.coins); gave.add(from);
            fund = { from, to: c.account, coins: c.coins, template: c.template.id };
        }
        pool.delete(c.account);
        for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
        done.set(c.account, { account: c.account, template: c.template, value, reason: fund ? `${c.reason}, funded ${c.coins} coins by ${fund.from}` : c.reason, resources: c.resources, ...(fund ? { fund } : {}) });
    };
    // The goal tier first: each army account takes the earliest band it can (a full band's resource sends it to the
    // next), the account nearest its target first; it never competes with coin jobs on coins per tick.
    const goalOrder = (x: Cand, y: Cand) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    for (const c of cands.filter(c => c.goal && !c.lacks).sort(goalOrder)) take(c, 0);
    // Then the kit tier: an army account with no band it can start gets the kit of its earliest band, before any coin
    // job, so banked gold becomes a band and not more gold. A buy is one login with the account's own coins. A send
    // takes a partner off its work for a trade window, so it comes second: this side's donors, then another side's.
    const reserve = kitReserve(inp.templates), byName = new Map(mine.map(a => [a.name, a]));
    const stock = [...(inp.stock ?? [])].sort((x, y) => Number(y.side === inp.side) - Number(x.side === inp.side));
    const spare = (s: Stock, item: string) => (s.items[item] ?? 0) - (reserve[item] ?? 0);
    const goalNow = (account: string) => { const id = inp.current?.get(account.toLowerCase()); return !!id && (id.startsWith(KIT_BUY) || byId.get(id)?.tier === 'goal'); };
    const acquire = (c: Cand) => {
        const a = byName.get(c.account)!, busy = !!inp.unfundable?.has(c.account.toLowerCase()), buyId = KIT_BUY + c.template.id;
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account)) return;
        // An account in a running band job keeps the rule it had before the kit tier: its live holdings dip while it
        // works (food eaten, runes cast), and a kit buy must not replace a band that is still running.
        const now = inp.current?.get(c.account.toLowerCase());
        if (busy && now && !now.startsWith(KIT_BUY) && byId.get(now)?.tier === 'goal') return;
        // No kit for a band whose place is full: the account tries its next band.
        if (c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        const picks = c.lacks!.map(l => { const item = l.of.filter(i => inp.market?.[i]).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]; return item ? { item, count: l.count } : null; });
        if (picks.every(p => p !== null) && !inp.retired?.has(pairKey(c.account, buyId))) {
            // The batch when the account can pay for it, else only what the band needs to start.
            const sized = (batch: boolean): KitLine[] => picks.map(p => { const held = a.items[p!.item] ?? 0, m = inp.market![p!.item]!; return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(p!.count, batch ? (c.template.batch?.[p!.item] ?? 0) - held : 0) }; });
            const price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0), coins = a.items.coin ?? 0;
            const lines = price(sized(true)) + KIT_CASH_RESERVE <= coins ? sized(true) : sized(false);
            const template = kitBuyTemplate(c.template, c.account, lines, inp.kitSeq?.get(c.account.toLowerCase()) ?? 0), cost = price(lines), short = cost + KIT_CASH_RESERVE - coins;
            const what = lines.map(l => `${l.quantity} ${l.item}`).join(', ');
            if (short <= 0) { done.set(c.account, { account: c.account, template, value: 0, reason: `buys ${what} for ${c.template.id}, at most ${cost} coins`, resources: [] }); return; }
            if (!busy) {
                // A coin donor of this side, else a free account of another side with coins above the reserve.
                const coinsOf = (s: Stock) => Math.max(0, (s.items.coin ?? 0) - FUND_RESERVE);
                const own = [...pool].filter(([n, left]) => n.toLowerCase() !== c.account.toLowerCase() && !done.has(n) && !gaveItems.has(n) && left >= short).sort((x, y) => y[1] - x[1])[0]?.[0];
                const far = own ? undefined : stock.filter(s => s.side !== inp.side && !gave.has(s.name) && !gaveItems.has(s.name) && coinsOf(s) >= short).sort((x, y) => coinsOf(y) - coinsOf(x))[0]?.name;
                const from = own ?? far;
                if (from) {
                    if (own) pool.set(own, pool.get(own)! - short);
                    gave.add(from); pool.delete(c.account);
                    done.set(c.account, { account: c.account, template, value: 0, reason: `${c.reason}, funded ${short} coins by ${from} to buy ${what}`, resources: [], fund: { from, to: c.account, coins: short, template: template.id } });
                    return;
                }
            }
        }
        // One order per pass. A line no market sells goes first, so the lines left at the end are one buy.
        const sold = (l: Lack) => Number(l.of.some(i => !!inp.market?.[i]));
        for (const l of [...c.lacks!].sort((x, y) => sold(x) - sold(y))) for (const item of l.of) {
            const from = stock.find(s => s.name.toLowerCase() !== c.account.toLowerCase() && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= l.count
                && !inp.noSend?.has(`${s.name}>${c.account}`.toLowerCase()));
            if (!from) continue;
            // A trade needs the account offline with no stop file (scripts/fleet-agent.ts). One in a coin job leaves that
            // job on this pass and gets the order on the next; one already on a band or a kit buy keeps it.
            // The donor is held for this account, so a second account does not leave its job for the same stock.
            if (busy) { if (!goalNow(c.account)) { vacated.set(c.account, `vacant: leaves its job for ${l.count} ${item} from ${from.name} for ${c.template.id}`); gaveItems.add(from.name); pool.delete(from.name); } return; }
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(c.account);
            done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `${c.reason}, sent ${l.count} ${item} by ${from.name}`, resources: [], send: { from: from.name, to: c.account, item, count: l.count, template: c.template.id } });
            return;
        }
    };
    for (const c of cands.filter(c => c.goal && c.lacks).sort(goalOrder)) acquire(c);
    // The coin tier, re-sorted after every assignment: one more holder lowers the worth of the candidates that share
    // its resource.
    for (const rest = cands.filter(c => !c.goal); rest.length;) {
        rest.sort(order);
        const c = rest.shift()!;
        take(c, worth(c));
    }
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass'
        : gaveItems.has(a.name) ? 'vacant: gives a kit item this pass' : vacated.get(a.name) ?? 'vacant: no template meets its skills and holdings with a free resource' });
}

// The swarm job for an assignment. `autopilot` marks it as this side's planner job; the CLI replaces only marked jobs.
// A training job does not repeat: its ok RESULT means the target level is met, and a rerun would log in, find the level
// met and log out (a scored login for nothing). The swarm keeps the account's `done` end until the next pass hands it
// a job with a different mission, which the met level unlocks. A run that ends short of the target is a fail RESULT,
// which the supervisor retries and the swarm's standing retry resumes, with or without repeat.
// finishedTrainers() brings that next pass forward.
export function jobFor(x: Assignment, side: string) {
    const t = x.template!;
    return { account: x.account, script: t.script, args: t.args ?? [], env: t.env ?? {}, role: t.role, goal: t.goal, enabled: true, repeat: t.repeats ?? !t.trains, standing: true,
        autopilot: side, template: t.id, resources: x.resources, note: `autopilot ${t.id}: ${x.reason}, ${x.value.toFixed(2)} coins/tick (estimate)` };
}

// Accounts whose planner trainer has reached its target: the job's template trains, the state still assigns that
// template, and the job's log since the assignment holds an ok RESULT. The daemon re-plans these accounts at once.
export function finishedTrainers(jobs: readonly any[], side: string, assigned: Readonly<Record<string, { template: string; offset: number }>>, templates: readonly Template[],
    linesSince: (account: string, offset: number, job: any) => readonly string[]): string[] {
    const trains = new Set(templates.filter(t => t.trains).map(t => t.id));
    return jobs.filter(j => j?.autopilot === side && typeof j.account === 'string' && trains.has(j.template) && assigned[j.account]?.template === j.template
        && assess(linesSince(j.account, assigned[j.account]!.offset, j)).ok > 0).map(j => j.account);
}

// Retirement from a job's own log lines (since the autopilot assigned it): the last RETIRE_FAILS RESULTs all fail with
// no progress, a RESULT reports a death, or the last LEDGER spent WASTE_LIMIT or more of its ticks idle or walking.
// A trainer that hits its tick cap short of the target ends fail with the XP it gained (scripts/generated/thieving60.ts
// prints xp=<gain>), so the supervisor runs it again; such a fail is progress and does not count toward retirement.
// A run the server or the relayed gateway dropped says nothing about the job, so it is counted as a drain, never as a
// failure: a dropped session (`RESULT fail session ended: disconnected`; the cloud proxy's 1012 `server_draining`
// closes), a game socket that errors at login (`RESULT fail login: [object WebSocket]`), and a server that stops
// ticking (`RESULT fail TickStallError`). Its supervisor logs the account back in and the next run banks the carried
// pack. Counting these as failures retired every knight spot of every account in one server outage. A login refused
// because a dropped session still holds the account's fleet claim (the worker logs `RESULT fail login: Error: fleet
// account claim held by swarm` until an authenticated recovery confirms the logout) is a drain too: the job never ran,
// and the recovered account resumes it. So is a world planner `precondition no route to`: it says where the account
// stands, not whether the job works, and a routing fix makes the same job run.
export const RETIRE_FAILS = 2, WASTE_LIMIT = 0.9;
// Cow mode reports its progress as selectedXp, damageXp and creditedKills.
export const progressed = (result: string) => /\b(?:xp|gained|coinsGained|banked|selectedXp|damageXp|creditedKills)=[1-9]\d*\b/.test(result);
export const DRAIN_RESULT = /^RESULT fail (?:session ended: disconnected\b|login: \[object WebSocket\]|TickStallError\b|(?:login: )?(?:Error: )?fleet account claim held\b|.*\bprecondition no route to\b)/;
export function assess(lines: readonly string[]): { retire: boolean; reason: string; ok: number; fail: number; drains: number } {
    const clean = lines.map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, ''));
    const drains = clean.filter(l => DRAIN_RESULT.test(l)).length;
    const results = clean.filter(l => /^RESULT (ok|fail)\b/.test(l) && !DRAIN_RESULT.test(l));
    const ok = results.filter(l => l.startsWith('RESULT ok')).length, fail = results.length - ok;
    // goldfarm and thieving60 print died=false on a healthy run, and scripts/buy-owned-ge-item.ts prints "died":false in
    // its JSON: only a bare word or a field that is not false counts.
    const died = results.find(l => /\b(?:died|death)\b(?!=|"\s*:\s*false\b)|\b(?:died|death)=(?!false\b)/i.test(l));
    if (died) return { retire: true, reason: `death: ${died.slice(0, 120)}`, ok, fail, drains };
    const tail = results.slice(-RETIRE_FAILS);
    if (tail.length === RETIRE_FAILS && tail.every(l => l.startsWith('RESULT fail') && !progressed(l))) return { retire: true, reason: `${RETIRE_FAILS} fail RESULTs: ${tail.at(-1)!.slice(0, 120)}`, ok, fail, drains };
    const ledger = clean.filter(l => l.startsWith('LEDGER ')).at(-1)?.match(/^LEDGER ticks=(\d+).* move=(\d+).* idle=(\d+)/);
    if (ledger && +ledger[1]! >= 300 && (+ledger[2]! + +ledger[3]!) / +ledger[1]! >= WASTE_LIMIT)
        return { retire: true, reason: `tick waste ${(100 * (+ledger[2]! + +ledger[3]!) / +ledger[1]!).toFixed(0)}% idle+move`, ok, fail, drains };
    return { retire: false, reason: '', ok, fail, drains };
}

// Thieving success at a knight of Ardougne (pickpocket.dbrow: 50..240 of 256 from level 1 to 99), scaled from the
// goldfarm model of 18.8 coins per tick at 99 (scripts/goldfarm.ts header). Estimate.
export const knightCoinsPerTick = (thieving: number) => thieving < 55 ? 0 : 18.8 * (50 + 190 * (Math.min(99, thieving) - 1) / 98) / 240;
export const KNIGHT_SPOTS = ['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'];
export const CHICKEN_PENS = ['3229,3298', '3017,3288', '3187,3277', '3197,3353'];
// scripts/gather-feathers.ts stops when its pack holds TARGET feathers.
export const FEATHER_TARGET = 2000;
// Claim: four farmers can share one knight spot. A pickpocket does not hold the knight. Practice: 4 bots at one spot
// each earned 13.3-15.1 coins per tick (mean 14.7) against the 18.8 model, every run RESULT ok and logged out
// (goldfarm.ts at its default spot 2653,3302, 3 runs of 600 ticks and one of 9,000; research/bot-host.md section 3).
// Live (claude-cloud-3 swarm logs): two full 9,000-tick goldfarm runs, RESULT ok and logged out, made 7.46
// coins per tick with 3 holders on 2652,3318 and 7.57 with 3 holders on 2669,3298 (4 for its last part), against about
// 8.1 near-solo. Gap: one live run per condition, not three matched, so KNIGHT_SHARED_RATE is an estimate, applied
// once per holder; the planner's tick-waste discount and retirement still apply per job.
export const KNIGHT_SHARE = 4, KNIGHT_SHARED_RATE = 0.75;
// Ardougne north cow field: six army accounts at once on its ten cows. Practice (research/combat-measure.md), 8-kill
// runs: solo median 550 ticks; 3 triples 9/9 RESULT ok, median 590 per account; 3 sets of six fresh accounts 18/18
// RESULT ok, median 779, so six make about 1.5 times the field output of three. More than six is not measured.
export const COW_FIELD = 'cow:ardougne-north', COW_FIELD_CAPACITY = 6;
// Gnome battlefield Khazard troopers: about 41 on multiway ground. Practice, fourteen accounts at once, 3 sets: 42 of
// 42 RESULT ok at a median 38.4 Strength XP per tick an account (49.7 with nine, 56.7 with six, 61-63 alone), the
// slowest 29.5, and a field total 20% over nine (research/combat-measure.md, troopers shared). The cows give about 16,
// so every army account trains there. Gap: more than fourteen at once is not measured.
export const TROOPER_FIELD = 'trooper:battlefield', TROOPER_FIELD_CAPACITY = 14;
// The Wind Strike tile north of the Ardougne north bank (scripts/alch-train.ts STRIKE): one Guard dog, fought by one
// player at a time. Practice: of three accounts at once, one landed no cast in 200 ticks, in each of three sets.
export const STRIKE_TILE = 'strike:ardougne-guard-dog';
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, [COW_FIELD]: COW_FIELD_CAPACITY, [TROOPER_FIELD]: TROOPER_FIELD_CAPACITY, [STRIKE_TILE]: 1, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
export const SHARED: Readonly<Record<string, number>> = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARED_RATE]));
// Army goal bands (AGENTS.md goals: maxed tribrids), in order: Strength, Attack, Magic, Prayer, Ranged, Defence
// last. Bands 6-8 are the Khazard troopers (TROOPER_BANDS), 9 is free. Ardougne cows (scripts/gather-combat.ts cow mode, north bank profile, MAX_KILLS=8): live 4/4 runs
// RESULT ok at 15.7 Strength XP per tick from Strength 1 to 46 (research/combat-measure.md, live cow training);
// practice 3/3 from Hitpoints 32 with trout and 3/3 with cake only (claude-cloud-4 .practice/combat-ladder). This
// server's level table puts 45 at 22,767 XP, 60 at 66,193, 70 at 133,230, 80 at 267,169, 90 at 534,888 and 99 at
// 998,458, so the cows take each skill to 45 (about 1,450 ticks) and, while nothing faster is qualified, on through 60,
// 70, 80, 90 and 99 (about 2,800, 4,200, 8,400, 16,700 and 29,000 more ticks a pass; estimates, as XP per kill is
// fixed). Live, TrouserSnake and TheFullMonty finished the 45 and 60 passes with RESULT ok runs. Cow mode
// needs 14 HP of trout or cake held (COW_FOOD_HP) and the bronze sword and wooden shield held or worn, starts at the
// north bank and never wields better gear; COW_STAGE=1 (scripts/cow-stage.ts) walks the account there and takes the
// sword, shield and food from its bank first, banking the rest of the pack: 3/3 on practice from the knight spot
// with the kit and 8 HP of cake banked, RESULT ok with 8 kills and logged out (.practice/cow-stage-proof). A fresh
// account (every combat skill 1, Hitpoints 10) runs it too: practice 7/7 RESULT ok with 8 kills, Strength 1 to 28, at
// most one bite eaten and lowest HP 6, with trout (4 runs) and with cake only (3 runs), three at once
// (research/combat-measure.md, fresh accounts). Gap: the rate above level 46 is not measured.
// The first pass takes bands 0, 1 and 5; each later pass takes the next three bands from 10.
export const COW_PASSES = [45, 60, 70, 80, 90, 99] as const;
export const COW_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number; to: number }[] = COW_PASSES.flatMap((to, k) =>
    (['Strength', 'Attack', 'Defence'] as const).map((skill, i) => ({ skill, to, band: k === 0 ? [0, 1, 5][i]! : 7 + 3 * k + i })));
// Khazard troopers (scripts/gather-combat.ts TARGET=trooper): practice 3/3 RESULT ok at xpRate 25 for an account with
// Attack 69, Strength 60, Defence 61, Hitpoints 84, a bronze sword and banked sharks, Strength 60 to 72-73 in 1,585
// ticks (60.9-63.4 XP per tick, about 4 times the cows), 0-3 sharks eaten, lowest HP 41 (research/combat-measure.md).
// It walks to the Ardougne north bank from anywhere, wields the best owned metal blade, carries GIANT_FOOD one-bite
// food (shark, swordfish, lobster, trout or cooked meat; no cake) and eats at half HP. Bands 6-8 come after the first
// cow pass and before the cow passes from 60, for accounts at 60 or more in all three skills; without the food an
// account stays on the cows. Raw beef counts as food (TROOPER_STOCK): an account leaves the cows with one raw beef a
// kill banked, and TROOPER_COOK=1 cooks it at the range by the bank before the run (scripts/trooper-food.ts). Live, TheFullMonty trained Ranged 1 to 61 and Strength 61 to 78 there. GIANT_BURY=1 has the trainer bury
// the bones each kill leaves until Prayer 99: practice, six at once, about 2.5 Prayer XP per tick for 16% of the
// Strength rate (research/combat-measure.md, bones buried on the field). Gap: live rates with several accounts at
// once are not measured.
export const TROOPER_FOOD = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat'] as const;
export const TROOPER_STOCK = [...TROOPER_FOOD, 'raw beef'] as const;
export const TROOPER_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number }[] = [
    { skill: 'Strength', band: 6 }, { skill: 'Attack', band: 7 }, { skill: 'Defence', band: 8 },
];
// Magic, band 2: alchemy at the Ardougne north bank (scripts/alch-train.ts) walks there from anywhere, banks the pack,
// takes nature runes, fire (runes, or a fire staff it wields) and feathers, low-alchs to 55 and high-alchs to the
// target. Practice at xpRate 25: 1,625 XP a High Alchemy cast at 6.5-7 ticks, 233-250 XP a tick, about 10 times
// combat training, so Magic 50 to 99 is about 4,000 ticks. A run that runs out of supplies ends ok after a level;
// the account takes the band again once restocked. Prayer, band 3: scripts/train-prayer.ts BURY_HELD=1 buries the held
// bones above BONE_RESERVE up to 99 from the Ardougne north bank (entry within 60 tiles) and ends ok when they run
// out after a level; practice from the knights buried 114 of 120 bones in 282 ticks to Prayer 75, about 2.2 ticks a
// bone. Gap: neither is run live.
export const MAGIC_BAND = 2, PRAYER_BAND = 3;
// Ranged, band 4: trooper mode with TRAIN_SKILL=Ranged wields the best owned bow for the Ranged level and the best
// owned arrows that bow fires (an arrow's level may not exceed the bow's), on rapid, and restocks arrows on bank trips;
// out of arrows it ends stop=ammo, ok after kills. Practice 3/3 RESULT ok: Ranged 1 to 63-66 in about 1,690 ticks,
// 49.6-59.9 XP a tick, 0-2 sharks, about 5.4 iron arrows per 1,000 XP (about 5,400 for 1 to 99). It shares the
// battlefield with the melee trooper bands. Gap: not run live.
export const RANGED_BAND = 4;
const BOWS: readonly (readonly [string, number])[] = [['shortbow', 1], ['longbow', 1], ['oak shortbow', 5], ['oak longbow', 5], ['willow shortbow', 20],
    ['willow longbow', 20], ['maple shortbow', 30], ['maple longbow', 30], ['yew shortbow', 40], ['yew longbow', 40], ['magic shortbow', 50], ['magic longbow', 50]];
const ARROWS: readonly (readonly [string, number])[] = [['bronze arrow', 1], ['iron arrow', 1], ['steel arrow', 5], ['mithril arrow', 20], ['adamant arrow', 30], ['rune arrow', 40]];
// A bow the account's Ranged level wields, with 100 arrows of one kind that bow fires.
export const RANGED_KIT: readonly Needs[] = BOWS.flatMap(([bow, level]) =>
    ARROWS.filter(([, arrowLevel]) => arrowLevel <= level).map(([arrow]) => ({ skills: { Ranged: level }, items: { [bow]: 1, [arrow]: 100 } })));

// Proven job templates. Rates are estimates from each script's header model; tick-waste discounts them by measurement.
export function catalogue(): Template[] {
    const goldfarm = KNIGHT_SPOTS.map((spot): Template => ({
        id: `goldfarm@${spot}`, family: 'goldfarm', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot, TICKS: '9000' }, role: 'thieving',
        goal: `goldfarm knights at ${spot}`, needs: { skills: { Thieving: 55 } }, resources: [`knight:${spot}`],
        yields: a => [{ item: 'coins', perTick: knightCoinsPerTick(a.skills.Thieving ?? 1) }],
    }));
    const cows = COW_BANDS.map(({ skill, band, to }): Template => ({
        id: `army-cow-${skill.toLowerCase()}-${to}`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['3000', 'cow'],
        env: { TRAIN_SKILL: skill, COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1' }, role: 'combat', goal: `train ${skill} to ${to} on the Ardougne cows`,
        tier: 'goal', band, repeats: true, trains: { skill, to, unlocks: [] }, resources: [COW_FIELD], yields: () => [],
        needs: { food: 14, items: { 'bronze sword': 1, 'wooden shield': 1 } },
        // One trip to the Grand Exchange brings food for many runs, not the two trout one start needs.
        batch: { trout: 30 },
    }));
    const troopers = TROOPER_BANDS.map(({ skill, band }): Template => ({
        id: `army-trooper-${skill.toLowerCase()}-99`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, role: 'combat', goal: `train ${skill} to 99 on the Khazard troopers`,
        tier: 'goal', band, repeats: true, trains: { skill, to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, pieces: { of: TROOPER_STOCK, count: 10 } },
        batch: { trout: 100 },
    }));
    const magic: Template = {
        id: 'army-alch-magic-99', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['99', '5000'], role: 'combat', goal: 'train Magic to 99 with alchemy at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [] }, yields: () => [],
        needs: { skills: { Magic: 21 }, items: { 'nature rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...['staff of fire', 'fire battlestaff', 'mystic fire staff'].map(staff => ({ items: { [staff]: 1 } }))] },
        // High Alchemy gives 1,625 XP a cast at xpRate 25, so Magic 99 takes about 8,000 nature runes; a buy brings 1,000.
        batch: { 'nature rune': 1000 },
    };
    // Magic 1 to 21 for Low Alchemy: Wind Strike on the fenced Guard dog (scripts/alch-train.ts strikeStart). Practice,
    // fresh accounts started at the goldfarm knights: Magic 1 to 21-23 in 17-22 casts, no damage taken, about 180 ticks alone.
    const strike: Template = {
        id: 'army-strike-magic-21', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['21', '1500'], role: 'combat', goal: 'train Magic to 21 with Wind Strike from the safe tile at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 21, unlocks: [magic.id] }, resources: [STRIKE_TILE], yields: () => [],
        needs: { items: { 'mind rune': 35, 'air rune': 35 } },
    };
    const prayer: Template = {
        id: 'army-bury-prayer-99', family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, role: 'combat',
        goal: 'train Prayer to 99 burying the held bones', tier: 'goal', band: PRAYER_BAND, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { items: { bones: 100 } },
    };
    const ranged: Template = {
        id: 'army-trooper-ranged-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, role: 'combat', goal: 'train Ranged to 99 on the Khazard troopers',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Hitpoints: 40 }, pieces: { of: TROOPER_STOCK, count: 10 }, anyOf: RANGED_KIT },
        batch: { trout: 100, ...Object.fromEntries(ARROWS.map(([arrow]) => [arrow, 1000])) },
    };
    return [
        ...goldfarm,
        ...cows,
        ...troopers,
        strike,
        magic,
        prayer,
        ranged,
        { id: 'thieving55', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: '55', CAP: '2500', CLEAN_FOOD: '1' }, role: 'thieving',
            goal: 'train Thieving to 55 for a knight spot', trains: { skill: 'Thieving', to: 55, unlocks: goldfarm.map(g => g.id) }, yields: () => [] },
        ...CHICKEN_PENS.map((pen): Template => ({
            id: `feathers@${pen}`, family: 'gather-feathers', script: 'scripts/gather-feathers.ts', env: { PEN: pen, TICKS: '3000', TARGET: String(FEATHER_TARGET) }, role: 'helper',
            goal: `feathers at the chicken pen ${pen}`, resources: [`pen:${pen}`], needs: { holdsUnder: { feather: FEATHER_TARGET } },
            // chicken.rs2: 15 feathers 1/4, 5 feathers 1/4 -> 5 a kill; about one kill and pickup per 16 ticks.
            yields: () => [{ item: 'feather', perTick: 0.3 }],
        })),
        { id: 'lobster-chain', family: 'gather-fish', script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'], role: 'fishing',
            goal: 'Catherby lobsters, caught and cooked', needs: { skills: { Fishing: 40, Cooking: 40 }, items: { 'lobster pot': 1 } }, resources: ['catherby:lobster'],
            yields: a => [{ item: 'lobster', perTick: 0.04 + 0.001 * Math.min(59, (a.skills.Fishing ?? 1) - 40) }] },
        { id: 'shop-runes', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['betty'], env: { ITEMS: 'fire rune|air rune|earth rune', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy elemental runes at Betty', needs: { items: { coins: 3000 } }, resources: ['shop:betty'],
            yields: () => [{ item: 'fire rune', perTick: 0.7 }, { item: 'air rune', perTick: 0.7 }, { item: 'earth rune', perTick: 0.7 }], spends: () => [{ item: 'coins', perTick: 2.1 * 5 }] },
        { id: 'shop-feathers', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['sarim'], env: { ITEMS: 'feather', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy feathers at Gerrant', needs: { items: { coins: 2000 } }, resources: ['shop:sarim'],
            yields: () => [{ item: 'feather', perTick: 3 }], spends: () => [{ item: 'coins', perTick: 3 * 3 }] },
        { id: 'shop-arrowtips', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby'], env: { ITEMS: 'rune arrowtips|adamant arrowtips', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy rune and adamant arrowtips at Catherby', needs: { items: { coins: 20000 } }, resources: ['shop:catherby'],
            yields: () => [{ item: 'rune arrowtips', perTick: 0.05 }, { item: 'adamant arrowtips', perTick: 0.05 }], spends: () => [{ item: 'coins', perTick: 0.05 * 260 + 0.05 * 104 }] },
        { id: 'fletch-headless', family: 'fletch', script: 'scripts/fletch-arrows.ts', args: ['15000', 'headless'], env: { BANK_PACK: '1', MAX_MAKE: '390' }, role: 'fletching',
            goal: 'headless arrows from owned shafts and feathers', needs: { items: { 'arrow shaft': 215, feather: 215 } },
            yields: () => [{ item: 'headless arrow', perTick: 5 }] },
    ];
}

// The exclusive resources an existing swarm job holds, planner-made or not, so no two accounts share one.
export function jobResources(job: { script?: string; args?: string[]; env?: Record<string, string>; resources?: string[] }): string[] {
    if (Array.isArray(job.resources)) return job.resources.filter(r => typeof r === 'string');
    const script = String(job.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    // A scripts/chain.ts job runs each argument as a step with its own KEY=value environment.
    const steps = script === 'scripts/chain.ts' ? (job.args ?? []).map(t => t.trim().split(/\s+/)) : [[script, ...(job.args ?? [])]];
    const cheb = (s: string, x: number, z: number) => { const [sx, sz] = s.split(',').map(Number); return Math.max(Math.abs(sx! - x), Math.abs(sz! - z)); };
    const out: string[] = [];
    for (const [file, ...rest] of steps) {
        const env: Record<string, string> = { ...job.env }, args: string[] = [];
        for (const t of rest) { const m = t.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]!] = m[2]!; else args.push(t); }
        if (file === 'scripts/goldfarm.ts') {
            const m = (env.KNIGHT_SPOT ?? '2653,3302').match(/^(\d+),(\d+)$/), x = Number(m?.[1] ?? 2653), z = Number(m?.[2] ?? 3302);
            out.push(`knight:${KNIGHT_SPOTS.reduce((b, s) => cheb(s, x, z) < cheb(b, x, z) ? s : b)}`);
        }
        if (file === 'scripts/gather-feathers.ts') out.push(`pen:${env.PEN ?? '3229,3298'}`);
        // Ranged training kills the Lumbridge pen's chickens (scripts/ranged-train.ts OUT ends at 3233,3297), so it holds
        // that pen like a feather job does: two sides must not farm one pen.
        if (file === 'scripts/ranged-train.ts') out.push('pen:3229,3298');
        if (file === 'scripts/shop-buyer.ts' && args[0]) out.push(`shop:${args[0]}`);
        if (file === 'scripts/gather-fish.ts' && (args[0] ?? 'cage') === 'cage') out.push('catherby:lobster');
    }
    return [...new Set(out)];
}

// The freshest of an account's observations by `at`: its status file and its row in the side's fleet snapshot. A fresh
// cloud container has no status files, so without the snapshot every account would plan as a level-1 start.
export function freshest(...observations: readonly any[]): any {
    return observations.filter(o => o && typeof o === 'object').reduce((best, o) => (Number(o.at) || 0) > (Number(best?.at) || 0) ? o : best, null);
}

// An account as the planner sees it, from its status file (.practice/status/<name>.json) or a fleet snapshot row:
// base levels, and pack, bank and worn counts by item name. No status: a fresh account at level 1 (Hitpoints 10).
export function accountFrom(name: string, side: string, status: any, itemName: (id: number) => string | undefined): Acct {
    const skills: Record<string, number> = { Hitpoints: 10 }, items: Record<string, number> = {};
    for (const k of Array.isArray(status?.skills) ? status.skills : []) if (typeof k?.name === 'string' && Number.isFinite(k.level)) skills[k.name] = k.level;
    for (const r of [status?.inventory, status?.bank, status?.equipment].flatMap(x => Array.isArray(x) ? x : [])) {
        const n = typeof r?.name === 'string' ? r.name : itemName(r?.baseId ?? r?.id);
        if (n && Number.isFinite(r.count)) items[norm(n)] = (items[norm(n)] ?? 0) + r.count;
    }
    return { name, side, skills, items };
}

// This side's new swarm job list: every job without this side's marker stays as it is; a planner job whose account
// keeps its template stays unchanged (its swarm revision and run go on); a changed or new assignment gets a fresh job.
// The accounts this side's planner may give a job: those a marked job names (handed over), or those no job names at all
// (a fresh account). An enabled unmarked job (a hand job or a coordinator run) keeps its account, a reservation (no
// script) keeps its account, and an owner pause (a stop file) keeps its account. An unmarked job that is off holds an
// account only when no marked job names it: a finished coordinator run does not block a handover, but by itself it
// frees nothing, since the coordinator may plan that account next.
export function plannableAccounts(jobs: readonly any[], side: string, listed: readonly string[], paused: ReadonlySet<string>): string[] {
    const names = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean).map((a: string) => a.toLowerCase());
    const mine = (j: any) => j?.autopilot === side;
    const hard = new Set(jobs.filter(j => !mine(j) && (j?.enabled !== false || !j?.script)).flatMap(names));
    const optIn = new Set(jobs.filter(mine).flatMap(names)), named = new Set(jobs.flatMap(names));
    return listed.filter(n => { const k = n.toLowerCase(); return !hard.has(k) && !paused.has(k) && (optIn.has(k) || !named.has(k)); });
}

const jobNames = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean) as string[];

// Resources the jobs in the file hold against this side's planning: every enabled unmarked job, and every enabled
// marked job whose account is paused (a stop file; mergeJobs keeps that job as it is, so its pen or spot stays its own).
export function reservedResources(jobs: readonly any[], side: string, paused: ReadonlySet<string>): Record<string, number> {
    const taken: Record<string, number> = {};
    const holds = (j: any) => j?.enabled !== false && (j?.autopilot !== side || jobNames(j).some(a => paused.has(a.toLowerCase())));
    for (const j of jobs) if (holds(j)) for (const r of jobResources(j)) taken[r] = (taken[r] ?? 0) + 1;
    return taken;
}

// This side's fleet claim (fleet/claims/<side>.json on the fleet-data branch): every exclusive resource an enabled job
// of this side's own accounts holds, planner-made or hand-made, from the plan the swarm runs, when one of the job's
// accounts is `active` (scripts/fleet-sync.ts: seen in the world within CLAIM_MAX_AGE_MS). A plan with more enabled
// jobs than the swarm admits parks some for days; a parked job's spot is free for the other sides, and when the job
// does start, the planner that took the spot sees this side's claim on its next pass and moves its account. fleet-sync
// writes the claim on every sync, so it never depends on the planner running; scripts/autopilot.ts on every side
// ignores a claim older than CLAIM_MAX_AGE_MS, so a side that stops syncing releases its spots. A resource is listed
// once for each job that holds it, so the other sides count both farmers on a shared knight spot.
export const CLAIM_MAX_AGE_MS = 2 * 3600_000;
export function claimFor(jobs: readonly any[], side: string, sideOf: (account: string) => string, now = Date.now(), active: (account: string) => boolean = () => true): { side: string; at: number; resources: string[] } {
    const held = jobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => sideOf(a) === side) && jobNames(j).some(active)).flatMap(jobResources);
    return { side, at: now, resources: held.sort() };
}

// A recovery the coordinator runs for an account (scripts/session-check.ts, coordinatorOwner "coordinator") shadows that
// account's own job in the merged plan (packages/core/src/coordinator-jobs.ts mergeJobs). The account returns to its own
// job, so the side's claim keeps that job's places while the recovery runs; without them the other sides see the places
// free and fill them. Other coordinator work keeps the merged plan's claim.
export const RECOVERY_JOB_SCRIPT = 'scripts/session-check.ts';
export function recoveringOwnerJobs(ownerJobs: readonly any[], coordinatorJobs: readonly any[]): any[] {
    const script = (j: any) => String(j?.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const recovering = new Set(coordinatorJobs.filter(j => j?.coordinatorOwner === 'coordinator' && script(j) === RECOVERY_JOB_SCRIPT)
        .flatMap(jobNames).map(a => a.toLowerCase()));
    return ownerJobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => recovering.has(a.toLowerCase())));
}

// A marked job whose account is in `keep` (an owner pause: a stop file) stays as it is, with its enabled and repeat
// settings, so lifting the pause later resumes that job instead of handing the account a fresh enabled one.
export function mergeJobs(jobs: readonly any[], side: string, out: readonly Assignment[], keep: ReadonlySet<string> = new Set()): { jobs: any[]; fresh: string[] } {
    const mine = (j: any) => j?.autopilot === side, kept = (j: any) => [j?.account, ...(j?.accounts ?? [])].some((a: string) => a && keep.has(a.toLowerCase()));
    const next = jobs.filter(j => !mine(j) || kept(j)), fresh: string[] = [];
    for (const x of out) {
        if (!x.template) continue;
        // A job keeps its run only while it still runs its template (script, args and env, as the swarm signs a mission):
        // a hand edit, or a template changed in code, gets a fresh job.
        const prior = jobs.find(j => mine(j) && j.account === x.account && j.template === x.template!.id);
        if (prior && missionSignature(prior) === missionSignature(jobFor(x, side))) { next.push(prior); continue; }
        fresh.push(x.account);
        // An owner pause belongs to the account: a new template keeps it disabled and keeps its repeat policy.
        const paused = jobs.find(j => mine(j) && j.account === x.account && j.enabled === false);
        next.push(paused ? { ...jobFor(x, side), enabled: false, repeat: paused.repeat } : jobFor(x, side));
    }
    return { jobs: next, fresh };
}
