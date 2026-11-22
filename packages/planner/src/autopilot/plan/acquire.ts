// Candidate admission, donor/market kit acquisition, goal tier ordering, squad restock, and gear pass.
import { GEAR_GE_ID, GEAR_GE_PILOT, GEAR_SHOP_PILOT, gearJobFor, gearShopId } from '../../gear-want-jobs';
import { SQUAD_FOOD_HEAL, squadRows } from '../../squad';
import {
    ARMY_BANK, ARMOUR_MARKET, PLACES, WEAPON_MARKET, bandLeft, norm, pairKey, placeOf,
    type Acct, type Funding, type KitLine, type Lack, type Template,
} from '../world';
import { KIT_BUY, KIT_CASH_RESERVE, KIT_COIN_MARGIN, SQUAD_UNIT_COST, WEAPON, usableTool } from '../pricing';
import { FRAIL_FOOD_BUY_ID } from '../catalogue';
import { SQUAD_RESTOCK, exactItemIds } from '../claims';
import { kitLacks } from './needs';
import { kitBuyTemplate, proportionalLines } from './kits';
import type { Cand, PlanState } from './context';

export function takeCandidate(s: PlanState, c: Cand, value: number, ready: ReadonlySet<string>, far = false): void {
    const { inp, localByName, bridges, used, done, pool, gave, gaveItems, vacated, finiteOrder, cashSource, meetOf, reserveOutput, reserveKit } = s;
    if (c.lacks || (!c.goal && value <= 0) || done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
    if (far && (ready.has(c.account) || inp.unfundable?.has(c.account.toLowerCase()) || inp.running?.has(c.account.toLowerCase()))) return;
    const selected = finiteOrder(c.template, localByName.get(c.account.toLowerCase())!); if (!selected) return;
    let fund: Funding | undefined;
    if (c.coins) {
        const from = cashSource(c.account, c.coins, far);
        if (!from) return;
        if (pool.has(from)) pool.set(from, pool.get(from)! - c.coins);
        gave.add(from);
        fund = { from, to: c.account, coins: c.coins, template: c.template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) };
    }
    pool.delete(c.account);
    for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
    const bridge = bridges.get(c.account.toLowerCase()), reason = bridge ? `${c.reason} for ${bridge.recipient}'s army kit, up to ${bridge.target} coins including donor reserve` : c.reason;
    done.set(c.account, { account: c.account, template: selected, value, reason: fund ? `${reason}, funded ${c.coins} coins by ${fund.from}${c.fare ? `, ferry fare ${c.fare}` : ''}` : reason, resources: c.resources, ...(fund ? { fund } : {}) });
    if (c.supply) reserveOutput(c.supply.template.id === selected.id ? selected : c.supply.template, c.supply.account);
    if (c.kit) reserveKit(c.account, c.kit);
}

function acquireCandidate(s: PlanState, c: Cand, step: 'buy' | 'send', far: boolean, ready: ReadonlySet<string>): void {
    const {
        inp, byName, cands, stock, used, done, pool, gave, gaveItems, vacated, meetOf,
        cachedWayCost, worth, spare, cashSource, reachesMeet, goalNow, shopLine, reserveKit, reserveOutput,
    } = s;
    const a = byName.get(c.account)!, busy = !!inp.unfundable?.has(c.account.toLowerCase()), buyId = KIT_BUY + c.template.id;
    const banded = (id: string) => s.byId.get(id)?.tier === 'goal' && !s.byId.get(id)?.filler;
    if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account)) return;
    if (!c.goal && (worth(c) <= 0 || inp.running?.has(c.account.toLowerCase()))) return;
    // Another side's stock and coins are asked only for an account with no job it can start and none running: such
    // a trade needs the account offline until the other side's agent runs it, up to the order's window (live: 13
    // of 14 accounts stood parked at once, most for 1 to 13 items of another side, one with 123,028 coins for 3
    // air runes that a shop sells).
    if (far && (busy || ready.has(c.account))) return;
    // An account in a running band job keeps the rule it had before the kit tier: its live holdings dip while it
    // works (food eaten, runes cast), and a kit buy must not replace a band that is still running. A weapon or
    // armour buy is the exception: the band does not use the item up, the account lacks it for as long as the
    // band runs (live: Attack 99, Strength 99, Defence 94 and 1,090,000 coins with a bronze sword, held on the
    // Defence band), and one buy run pays back on every later tick. The buy below starts only from the account's
    // own coins: a busy account takes no funding and no item order.
    const now = inp.current?.get(c.account.toLowerCase());
    const wornKit = c.resources.includes(WEAPON_MARKET) || c.resources.includes(ARMOUR_MARKET);
    if (busy && now && !now.startsWith(KIT_BUY) && banded(now) && !wornKit) return;
    // No kit for a band whose place is full: the account tries its next band.
    if (c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
    const donorFor = (item: string, count: number, remote = far) => stock.find(st => (st.side !== inp.side) === remote && st.name.toLowerCase() !== c.account.toLowerCase() && !done.has(st.name) && !gave.has(st.name) && !gaveItems.has(st.name) && spare(st, item) >= count
        && !inp.noSend?.has(`${st.name}>${c.account}`.toLowerCase()) && reachesMeet(st.name));
    // Fund the worker's own cash prerequisite first, then reobserve before acquiring its missing items.
    // fundOrders parks the intended worker until this one owned transfer settles.
    if (c.coins) {
        if (busy) return;
        const mountain = inp.mountain?.(a) ?? true, toMeet = cachedWayCost(a.pos, ARMY_BANK, mountain), fromMeet = cachedWayCost(ARMY_BANK, placeOf(c.template), mountain);
        // The cash transfer precedes the item trip. Its recipient can use that staged cash for the meeting
        // fare, and must still retain the consumer's cash and return fare after the item arrives.
        const canMeet = toMeet !== null && fromMeet !== null;
        const itemSource = (item: string, count: number) => donorFor(item, count, false) ?? (far ? donorFor(item, count, true) : undefined);
        const obtainable = (item: string, count: number) => !!c.template.ownSupply?.includes(item) || !c.template.shopKit && !!inp.market?.[item] || canMeet && !!itemSource(item, count);
        const lacks = kitLacks(a, c.template.needs, obtainable);
        if (!lacks || lacks.some(l => !l.of.some(item => obtainable(item, l.count)))) return;
        const owned = canMeet && lacks.some(l => l.of.some(item => !!itemSource(item, l.count)));
        const detour = a.pos && owned ? Math.max(0, toMeet! + fromMeet! - (cachedWayCost(a.pos, placeOf(c.template), mountain) ?? 0)) : 0;
        const coins = c.coins + detour;
        const from = cashSource(c.account, coins, far);
        if (!from) return;
        if (pool.has(from)) pool.set(from, pool.get(from)! - coins);
        gave.add(from); pool.delete(c.account);
        done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `funds ${coins} coins before preparing ${c.template.id}`, resources: [],
            fund: { from, to: c.account, coins, template: c.template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) } });
        return;
    }
    if (step === 'buy' && (c.template.shopKit || cachedWayCost(a.pos, PLACES['shop:zaff'], inp.mountain?.(a) ?? true) === null)) return;
    const own = (l: Lack) => l.of.some(i => !!c.template.ownSupply?.includes(i));
    const picks = c.lacks!.filter(l => !shopLine(l) && !own(l)).map(l => { const item = l.of.filter(i => inp.market?.[i] && usableTool(a, i)).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]; return item ? { item, count: l.count } : null; });
    if (step === 'buy' && picks.length && picks.every(p => p !== null) && !inp.retired?.has(pairKey(c.account, buyId))) {
        // The batch when the account can pay for it, else only what the band needs to start. A one-line band with
        // `partBatch` takes as much of its batch as the account can pay for.
        const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
        // `held` is what the buy script will count (EXPECTED_OWNED, the order key): the unnoted units. The batch top-up counts every unit, notes included.
        const sized = (batch: boolean): KitLine[] => picks.map(p => { const owned = a.items[p!.item] ?? 0, held = a.exact ? a.exact[p!.item] ?? 0 : owned, m = inp.market![p!.item]!; return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(p!.count, batch ? (batchOf?.[p!.item] ?? 0) - owned : 0) }; });
        const price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0), coins = a.items.coin ?? 0;
        const keep = Math.max(c.template.keepCoins?.(a) ?? 0, ...Object.entries(c.template.needs?.items ?? {}).filter(([item]) => norm(item) === 'coin').map(([, count]) => count));
        const free = coins - keep;
        // The buy script refuses a round whose escrow and reserve pass the coins it finds, and the status that sized the buy is older than
        // the run: KIT_COIN_MARGIN keeps the planned buy under the coins by what a few minutes of fares, food and fees can take.
        const room = KIT_CASH_RESERVE + KIT_COIN_MARGIN;
        const full = sized(true), start = sized(false), part = Math.floor((free - room) / (full[0]?.limit ?? 1));
        const frailFood = c.template.id === FRAIL_FOOD_BUY_ID;
        const lines = frailFood || price(full) + room <= free ? full
            : c.template.partBatch && full.length === 1 && part > start[0]!.quantity ? [{ ...full[0]!, quantity: Math.min(full[0]!.quantity, part) }]
            : c.template.partBatch && full.length > 1 ? proportionalLines(full, start, free - room) : start;
        const template = kitBuyTemplate(c.template, c.account, lines, inp.kitSeq?.get(c.account.toLowerCase()) ?? 0, KIT_CASH_RESERVE + keep), cost = price(lines), short = cost + room - free;
        const what = lines.map(l => `${l.quantity} ${l.item}`).join(', ');
        // A `once` quest buys its kit for one account at a time, and for QUEST_DEMAND_PLACES quests at a time: the buy holds
        // the places of the quest, and the run that follows holds them too.
        const purchaseResources = c.template.id === WEAPON.id || c.template.id.startsWith('army-weapon-') || c.template.id.startsWith('army-armour-') || c.template.once || frailFood ? c.resources : [];
        const reservePurchase = () => { for (const r of purchaseResources) used.set(r, (used.get(r) ?? 0) + 1); reserveKit(c.account, lines); if (c.supply) reserveOutput(c.supply.template, c.supply.account); };
        const buyReason = `${c.goal && c.template.kitFirst ? `army band ${c.goal.band}: ` : ''}buys ${what} for ${c.template.id}, at most ${cost} coins`;
        if (short <= 0) { done.set(c.account, { account: c.account, template, value: 0, reason: buyReason, resources: purchaseResources }); reservePurchase(); return; }
        if (frailFood) return;
        if (!busy && meetOf.get(c.account) !== null) {
            // A coin donor of this side, else a free account of another side with coins above the reserve.
            const from = cashSource(c.account, short, far);
            if (from) {
                if (pool.has(from)) pool.set(from, pool.get(from)! - short);
                gave.add(from); pool.delete(c.account);
                done.set(c.account, { account: c.account, template, value: 0, reason: `${c.reason}, funded ${short} coins by ${from} to buy ${what}`, resources: purchaseResources, fund: { from, to: c.account, coins: short, template: template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) } });
                reservePurchase();
                return;
            }
        }
    }
    if (step === 'buy') return;
    // An item order meets at the Ardougne north bank (scripts/autopilot.ts itemOrder). A party of this side whose
    // place is known must have a way there and hold the fare of that way. A party with no known place has no rule.
    if (!reachesMeet(c.account)) return;
    // A market alternative can be unaffordable while a donor holds another complete kit. Reconsider the choice
    // against this pass's reachable, unreserved stock, including donors already taken by another account.
    const lacks = kitLacks(a, c.template.needs, (item, count) => !!donorFor(item, count)) ?? [];
    // One order per pass. A line no market sells goes first, so the lines left at the end are one buy.
    const sold = (l: Lack) => Number(l.of.some(i => !!inp.market?.[i]));
    for (const l of lacks.sort((x, y) => sold(x) - sold(y))) for (const item of l.of) {
        const from = donorFor(item, l.count);
        if (!from) continue;
        // A donor of this side sends the band's batch, as a buy would bring it, as far as its spare stock goes: one
        // trade, not one for every start amount. Another side's donor sends what the band needs to start.
        const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
        const count = far ? l.count : Math.min(spare(from, item), Math.max(l.count, (batchOf?.[item] ?? 0) - (a.items[item] ?? 0)));
        // A trade needs the account offline with no stop file (scripts/fleet-agent.ts). One in a coin job leaves that
        // job on this pass and gets the order on the next; one already on a band or a kit buy keeps it.
        // The donor is held for this account, so a second account does not leave its job for the same stock.
        if (busy) { if (!goalNow(c.account)) { vacated.set(c.account, `vacant: leaves its job for ${count} ${item} from ${from.name} for ${c.template.id}`); gaveItems.add(from.name); pool.delete(from.name); } return; }
        gaveItems.add(from.name); pool.delete(from.name); pool.delete(c.account);
        const resources = c.template.id === FRAIL_FOOD_BUY_ID ? c.resources : [];
        for (const resource of resources) used.set(resource, (used.get(resource) ?? 0) + 1);
        const sendId = exactItemIds().get(item);
        done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `${c.reason}, sent ${count} ${item} by ${from.name}`, resources, send: { from: from.name, to: c.account, item, count, template: c.template.id, ...(sendId !== undefined ? { itemId: sendId } : {}) } });
        reserveKit(c.account, [{ item, quantity: count }], false);
        if (c.supply) reserveOutput(c.supply.template, c.supply.account);
        return;
    }
    void cands;
}

export function assignGoalsAndKits(s: PlanState, ready: ReadonlySet<string>): void {
    const { inp, cands, keeps, worth, order, goalOrder } = s;
    const kits = [...cands.filter(c => c.goal && c.lacks).sort(goalOrder), ...cands.filter(c => !c.goal && c.lacks).sort(order)];
    // An active gang squad's supply jobs take their places first: a goal band that takes the same shop (army-hunt-supply holds
    // shop:lowe) would leave the squad's line with no place. A place that a running job of its current template holds stays
    // with that job, and an account that runs a job keeps it. An account with a goal band (ready, or short of its kit) keeps the
    // band's way: the squad's supply goes first to the accounts with no band.
    if (inp.squad?.active || (inp.specialists?.length ?? 0) > 0) {
        const runningHolds = new Set(cands.filter(k => inp.running?.has(k.account.toLowerCase()) && inp.current?.get(k.account.toLowerCase()) === k.template.id).flatMap(k => k.resources));
        const banded = new Set(cands.filter(k => k.goal).map(k => k.account));
        for (const c of cands.filter(c => c.template.squadOnly && !banded.has(c.account) && !inp.running?.has(c.account.toLowerCase()) && !c.resources.some(r => runningHolds.has(r))).sort((p, q) => worth(q) - worth(p)))
            takeCandidate(s, c, worth(c), ready);
    }
    for (const c of cands.filter(c => c.goal && !c.lacks && !!c.template.quest && keeps(c)).sort(goalOrder)) takeCandidate(s, c, 0, ready);
    for (const c of cands.filter(c => c.goal && !c.template.filler).sort(goalOrder)) {
        if (!c.lacks) {
            if (c.template.family === 'shop-buyer' && !inp.running?.has(c.account.toLowerCase()))
                for (const kit of kits.filter(kit => kit.account === c.account && kit.goal?.band === c.goal!.band)) acquireCandidate(s, kit, 'send', false, ready);
            takeCandidate(s, c, 0, ready);
        } else if (c.template.kitFirst) { acquireCandidate(s, c, 'send', false, ready); acquireCandidate(s, c, 'buy', false, ready); }
    }
    for (const c of kits) acquireCandidate(s, c, 'send', false, ready);
    for (const c of kits) acquireCandidate(s, c, 'buy', false, ready);
    for (const step of ['buy', 'send'] as const) for (const c of kits) acquireCandidate(s, c, step, true, ready);
}

export function restockSquad(s: PlanState): void {
    const { inp, byName, stock, memberStock, freeMembers, done, gave, gaveItems, vacated, pool, cachedWayCost, spare } = s;
    if (!inp.squad?.active) return;
    // The gang squad's restock, after every kit order: a free donor of this side sends a member that is short a line it
    // holds above its own reserve, one order for a member in a pass. The member must be a plannable, offline account
    // that no kit order or job took; a member that runs a hand job is restocked when it is free.
    for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) {
        const member = byName.get([...byName.keys()].find(n => n.toLowerCase() === row.account) ?? '');
        if (!member || done.has(member.name) || gave.has(member.name) || gaveItems.has(member.name) || vacated.has(member.name) || inp.unfundable?.has(row.account)) continue;
        const cost = (p: Acct | undefined) => cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true);
        for (const item of row.names) {
            const from = [...stock, ...memberStock.filter(st => freeMembers.has(st.name.toLowerCase()))].find(st => st.side === inp.side && st.name.toLowerCase() !== row.account && !done.has(st.name) && !gave.has(st.name) && !gaveItems.has(st.name) && spare(st, item) >= 1
                && !inp.noSend?.has(`${st.name}>${member.name}`.toLowerCase()) && (cost(byName.get(st.name)) ?? -1) >= 0 && (cost(member) ?? -1) >= 0);
            if (!from) continue;
            // A food row is in lobsters (squad.ts): a donor's item is counted by the HP it heals against the lobster's.
            const count = Math.min(spare(from, item), item in SQUAD_FOOD_HEAL ? Math.ceil(row.short * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL[item]!) : row.short);
            const sendId = exactItemIds().get(item);
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(member.name);
            done.set(member.name, { account: member.name, template: SQUAD_RESTOCK, value: 0, reason: `restocks ${count} ${item} for the gang squad, sent by ${from.name}`, resources: [],
                send: { from: from.name, to: member.name, item, count, template: SQUAD_RESTOCK.id, ...(sendId !== undefined ? { itemId: sendId } : {}) } });
            break;
        }
    }
}

export function assignGearPass(s: PlanState): void {
    const { inp, mine, done, gave, gaveItems, vacated, used, gearValue } = s;
    for (const a of mine) {
        const lower = a.name.toLowerCase(), rows = inp.gearWants?.get(lower);
        if (!rows?.length || done.has(a.name) || gave.has(a.name) || gaveItems.has(a.name) || vacated.has(a.name)) continue;
        // Both jobs are pilots: nothing starts live until the `aio` list of swarm.json names `gear-ge` or `gear-shop` (Inputs.pilots).
        // The room keeps what the account's bands keep (keepCoins), as the kit buy of a band does.
        const keepCoins = Math.max(0, ...inp.templates.filter(t => t.tier === 'goal' && bandLeft(t, a) > 0 || t.id === inp.current?.get(lower)).map(t => t.keepCoins?.(a) ?? 0));
        const job = gearJobFor(rows, { coins: a.items.coin ?? 0, room: KIT_CASH_RESERVE + KIT_COIN_MARGIN + keepCoins, running: !!inp.running?.has(lower),
            held: id => !inp.pilots?.has(id === GEAR_GE_ID ? GEAR_GE_PILOT : GEAR_SHOP_PILOT) || !!inp.retired?.has(pairKey(a.name, id === GEAR_GE_ID ? KIT_BUY + id : id)) });
        if (!job) continue;
        const place = job.kind === 'ge' ? ARMOUR_MARKET : `shop:${job.profile}`;
        if ((used.get(place) ?? 0) >= (inp.capacity?.[place] ?? 1)) continue;
        used.set(place, (used.get(place) ?? 0) + 1);
        gearValue.set(a.name, job.value);
        const bonus = `${job.gain.toFixed(1)} points of bonus`;
        if (job.kind === 'ge') {
            const lines: KitLine[] = job.lines.map(l => ({ item: l.name, id: l.id, quantity: 1, held: 0, limit: l.limit }));
            const template = kitBuyTemplate({ id: GEAR_GE_ID, goal: 'wear better gear' } as Template, a.name, lines, inp.kitSeq?.get(lower) ?? 0, KIT_CASH_RESERVE);
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${lines.map(l => l.item).join(', ')} on the market for ${bonus}, at most ${job.cost} coins` });
        } else {
            const items = job.items.map(i => i.name.replace(/[^a-zA-Z0-9 '-]/g, c => `\\${c}`)).join('|');
            const template: Template = { id: gearShopId(job.profile), family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: [job.profile, '1500'],
                env: { ITEMS: items, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(job.spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(job.spend) },
                role: 'supply', goal: `buy ${job.items.map(i => i.name).join(', ')} from the ${job.shop} to wear better gear`, repeats: false, resources: [place], yields: () => [] };
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${job.items.map(i => i.name).join(', ')} at ${job.shop} for ${bonus}, at most ${job.spend} coins` });
        }
    }
}
