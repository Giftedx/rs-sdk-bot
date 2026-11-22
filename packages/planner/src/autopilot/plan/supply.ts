// Funding bridge helpers, supply-tier dispatch, bot slot capping, and vacancy constraint formatting.
import { FUND_RESERVE, KIT_BUY, OBSERVATION_FRESH_MS, jobValue } from '../pricing';
import { SQUAD_RESTOCK } from '../claims';
import type { Acct, Assignment } from '../world';
import { coinShort, meets, unmet } from './needs';
import type { Cand, Miss, PlanState } from './context';
import { takeCandidate } from './acquire';

export function assignBridgeHelpers(s: PlanState): void {
    const {
        inp, cands, localByName, earnedCoins, bridges, bridged, used, done, pool, gave, gaveItems, vacated,
        funding, bumpEpoch, canGiveCoins, keeps, makesCoins, values,
    } = s;
    // A recipient that cannot earn its kit may need a helper to become a donor. Reserve one helper for one finite
    // recipient, including the donor's retained cash. Compare full estimated ticks: earning on the recipient avoids
    // that reserve and wins whenever it costs less. Existing donors and kit orders have already had their turn.
    const cash = funding();
    const coinOptions = cands.filter(c => !c.goal && c.supply && makesCoins(c.supply.template, c.supply.account));
    const free = (c: Cand) => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account)
        && c.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1))
        && (!c.coins || [...pool].some(([name, coins]) => !done.has(name) && coins >= c.coins! && canGiveCoins(name, c.account)));
    for (const [recipient, short] of [...cash.army].sort(([x], [y]) => x.localeCompare(y))) {
        const owner = localByName.get(recipient)!;
        if (short <= 0 || done.has(owner.name) || gave.has(owner.name) || gaveItems.has(owner.name) || vacated.has(owner.name)) continue;
        const gap = Math.max(0, (cash.kits.get(recipient) ?? 0) - (owner.items.coin ?? 0) - (earnedCoins.get(recipient) ?? 0));
        const options = coinOptions.filter(c => free(c) && !bridges.has(c.account.toLowerCase())
            && (c.account.toLowerCase() === recipient || (!(cash.army.get(c.account.toLowerCase()) ?? 0) && canGiveCoins(c.account, recipient)
                && (!inp.unfundable?.has(c.account.toLowerCase()) || (inp.current?.get(c.account.toLowerCase()) === c.template.id && c.template.id === c.supply!.template.id)))))
            .map(c => {
                const lower = c.account.toLowerCase(), own = lower === recipient, target = FUND_RESERVE + gap;
                const coins = own ? short : Math.max(0, target - (localByName.get(lower)?.items.coin ?? 0) - (earnedCoins.get(lower) ?? 0));
                const rate = c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : used.get(r) ?? 0),
                    c.supply!.share * jobValue(c.supply!.template, c.supply!.account, values, item => item === 'coin' ? Infinity : 0));
                return { c, own, target, ticks: rate > 0 ? coins / rate : Infinity };
            }).filter(x => Number.isFinite(x.ticks))
            .sort((x, y) => x.ticks - y.ticks || Number(y.own) - Number(x.own) || keeps(y.c) - keeps(x.c) || x.c.account.localeCompare(y.c.account) || x.c.template.id.localeCompare(y.c.template.id));
        const chosen = options[0];
        if (chosen && !chosen.own) { bridges.set(chosen.c.account.toLowerCase(), { recipient: owner.name, target: chosen.target }); bridged.add(recipient); bumpEpoch(); }
    }
}

export function assignSupplyTier(s: PlanState, ready: ReadonlySet<string>): void {
    const { inp, cands, used, done, gave, gaveItems, vacated, keeps, worth, order, goalOrder } = s;
    // The supply tier, re-sorted after every assignment: each job reserves the useful output it can bring before
    // the next pass, and each resource holder lowers the worth of candidates that share its resource.
    let rest = cands.filter(c => !c.goal && !c.lacks && !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account));
    let dirty = true;
    const scores = new Map<Cand, number>();
    while (rest.length) {
        if (dirty) {
            rest = rest.filter(c => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account) && !c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            if (!rest.length) break;
            scores.clear();
            for (const c of rest) scores.set(c, worth(c));
            rest.sort((x, y) => scores.get(y)! - scores.get(x)! || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id));
            dirty = false;
        }
        const c = rest.shift()!;
        const v = scores.get(c)!;
        if (v <= 0) break;
        const prevDone = done.size;
        takeCandidate(s, c, v, ready);
        if (done.size !== prevDone) dirty = true;
    }
    // A fully owned recipe or band may lack only its cash/fare. Keep local work and its donor arbitration first;
    // only a remaining idle slot asks remote cash through the same Funding order.
    for (const c of [...cands.filter(c => c.goal && !c.lacks && c.coins).sort(goalOrder), ...cands.filter(c => !c.goal && !c.lacks && c.coins).sort(order)]) takeCandidate(s, c, worth(c), ready, true);
}

export function enforceBotSlots(s: PlanState): void {
    const { inp, cands, done, gave, gaveItems, gearValue, waits, worth } = s;
    if (inp.slots === undefined) return;
    // A fund or send assignment starts an order that logs in two accounts (the recipient and the donor): it costs two bots.
    const cost = (x: Assignment) => x.fund || x.send ? 2 : 1;
    const jobs = [...done.values()].filter(x => x.template);
    if (jobs.reduce((n, x) => n + cost(x), 0) <= inp.slots) return;
    const holds = (x: Assignment) => !!inp.running?.has(x.account.toLowerCase()) || !!inp.holding?.has(x.account.toLowerCase());
    // The gang squad's stock comes first while the squad is active: its restock, then its supply jobs, then the goal bands.
    // The squad is the live consumer of these lines: a bank trip that is short of one of them ends the squad's run.
    const rank = (x: Assignment): number[] => {
        const id = x.template!.id, c = cands.find(k => k.account === x.account && (k.template.id === id || KIT_BUY + k.template.id === id));
        if (id === SQUAD_RESTOCK.id) return [0, -2, 0];
        if (c?.template.squadOnly) return [0, -1, -worth(c)];
        return c?.goal ? [0, c.goal.band, c.goal.left] : c ? [1, -worth(c), 0] : gearValue.has(x.account) ? [0, 1e6, -gearValue.get(x.account)!] : [2, 0, 0];
    };
    const holders = jobs.filter(holds);
    let room = Math.max(0, inp.slots - holders.reduce((n, x) => n + cost(x), 0));
    const others = jobs.filter(x => !holds(x)).map(x => ({ x, r: rank(x) })).sort((p, q) => { for (let i = 0; i < 3; i++) if (p.r[i] !== q.r[i]) return p.r[i]! - q.r[i]!; return p.x.account.localeCompare(q.x.account); });
    for (const { x } of others) {
        if (cost(x) <= room) { room -= cost(x); continue; }
        done.delete(x.account);
        if (x.fund) gave.delete(x.fund.from);
        if (x.send) gaveItems.delete(x.send.from);
        waits.set(x.account, `vacant: waits for a bot slot (${inp.slots} free, ${holders.length} held by running bots): ${x.template!.id} ranks below the jobs that hold them`);
    }
}

export function formatAssignments(s: PlanState): Assignment[] {
    const { inp, mine, demand, cands, fareShort, misses, used, done, gave, gaveItems, vacated, waits, worth } = s;
    const noFare = (a: Acct) => {
        const x = fareShort.get(a.name)?.find(item => item.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1)));
        return x ? `vacant: lacks ${x.coins} coins for the way to ${x.id} (ferry fare ${x.fare}), and no free account can give them` : undefined;
    };
    const full = (c: Cand) => c.resources.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
    const vacancy = (a: Acct): string => {
        const list = misses.get(a.name) ?? [], has = (gate: Miss['gate']) => list.filter(m => m.gate === gate);
        const job = (): string | undefined => {
            const own = cands.filter(c => c.account === a.name).sort((x, y) => Number(!!y.goal) - Number(!!x.goal) || (x.goal?.band ?? 0) - (y.goal?.band ?? 0) || worth(y) - worth(x) || x.template.id.localeCompare(y.template.id));
            for (const c of own) {
                const id = c.template.id, place = full(c);
                if (place) return `${id} has no free place on ${place}`;
                if (c.lacks) return `${id} needs ${c.lacks.map(l => `${l.count} ${l.of[0]}`).join(', ')} and no source gives them`;
                if (c.coins) return `${id} needs ${c.coins} coins and no free account can give them`;
            }
            const coins = has('coins').find(m => !(m.template.resources ?? []).some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            const crowded = has('coins')[0]?.template.resources?.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
            if (crowded && !coins) return `${has('coins')[0]!.template.id} has no free place on ${crowded}`;
            if (coins) return `${coins.template.id} needs ${coinShort(a, coins.template.needs)} coins and no free account can give them`;
            const none = has('demand')[0];
            const needs = has('needs').map(m => ({ m, lacking: unmet(a, m.template.needs) })).filter(x => x.lacking.length)
                .sort((x, y) => x.lacking.length - y.lacking.length || x.m.template.id.localeCompare(y.m.template.id))[0];
            if (needs && (!none || needs.lacking.length <= 1)) return `${needs.m.template.id} needs ${needs.lacking.join(', ')}`;
            if (none) return `${none.template.id} has no finite demand`;
            const reach = has('reach')[0];
            if (reach) return `${reach.template.id} has no way from where the account stands`;
            const pilot = has('pilot').find(m => meets(a, m.template.needs));
            if (pilot) return `${pilot.template.id} is a pilot that the aio list does not name`;
            const retired = has('retired')[0];
            if (retired) return `${retired.template.id} is retired for this account`;
            return undefined;
        };
        const sourceless = (text: string | undefined) => {
            if (!text || !/ and no source/.test(text)) return text;
            const notes: string[] = [];
            if (inp.now !== undefined && a.observedAt !== undefined && inp.now - a.observedAt > OBSERVATION_FRESH_MS) notes.push(`its own observation is ${Math.round((inp.now - a.observedAt) / 3_600_000 * 10) / 10} h old`);
            if (inp.unobserved?.length) notes.push(`${inp.unobserved.length} free accounts have no observation under ${OBSERVATION_FRESH_MS / 60_000} minutes old, so their stock is not offered`);
            return notes.length ? `${text} (${notes.join('; ')})` : text;
        };
        const roster = has('roster')[0], other = sourceless(demand.some(d => d.short > 0) ? job() : 'no finite route or army supply demand');
        if (roster) return `vacant: not on the army roster (${has('roster').length} bands, nearest ${roster.template.id})${other ? `; otherwise ${other}` : ''}`;
        return `vacant: ${other ?? 'no template meets its skills and holdings'}`;
    };
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass'
        : gaveItems.has(a.name) ? 'vacant: gives a kit item this pass' : waits.get(a.name) ?? vacated.get(a.name) ?? noFare(a) ?? vacancy(a) });
}
