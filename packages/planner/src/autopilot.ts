// Autopilot: writes a fleet side's swarm jobs from the route supply bill, account skills and holdings, and tick waste,
// so no person picks jobs, restarts ended ones or spots loops (plan Lanes table, Autopilot).
// plan() is pure: one assignment per account of this side, highest value per tick first, from proven templates only,
// never more accounts on one resource (a knight spot, a chicken pen, a shop) across all sides than its capacity
// (CAPACITY: two farmers to a knight spot, one to a pen or a shop). A job on a resource another account already holds
// keeps that resource's shared rate of its value (SHARED), so the empty spots fill first.
// Value is an estimate in coins per game tick: each output's rate times its unit value, minus coin spend, times the
// script family's measured work share (1 - idle - move, scripts/tick-waste.ts). A training template is worth a share
// of the best job it unlocks, and reserves that job's resource. assess() reads a job's recent log lines and retires
// it after repeated fail RESULTs or a run that was nearly all idle and walking. finishedTrainers() names the accounts
// whose trainer reached its target, so the next pass needs no timer. scripts/autopilot.ts applies it.
import type { BillRow } from './supply-bill';

export type Acct = { name: string; side: string; skills: Record<string, number>; items: Record<string, number> };
export type Flow = { item: string; perTick: number };
export type Template = {
    id: string; family: string; script: string; args?: string[]; env?: Record<string, string>; role: string; goal: string;
    needs?: { skills?: Record<string, number>; items?: Record<string, number> };
    yields: (a: Acct) => Flow[]; spends?: (a: Acct) => Flow[];
    resources?: string[]; trains?: { skill: string; to: number; unlocks: string[] };
};
// `fund`: the template needs coins the account lacks; a donor of this side sends them first (scripts/autopilot.ts
// places the fleet order), and the account takes the job on the pass after the coins arrive.
export type Funding = { from: string; to: string; coins: number; template: string };
export type Assignment = { account: string; template?: Template; value: number; reason: string; resources: string[]; fund?: Funding };
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
};
export const FUND_RESERVE = 50_000;

// A bill line still short is worth twice its shop value: it is acquisition work the route needs. A unit nobody needs
// is worth half, the price a sale would fetch. A share of a job a training run unlocks counts for the training.
export const BILL_PREMIUM = 2, SURPLUS = 0.5, TRAIN_SHARE = 0.25;
// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
export const FEEDS: Record<string, string[]> = { feather: ['headless arrow'], 'arrow shaft': ['headless arrow'], 'raw lobster': ['lobster'] };
export const norm = (s: string) => s.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim().replace(/s$/, '');
export const pairKey = (account: string, template: string) => `${account.toLowerCase()}:${template}`;

export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>): number {
    const k = norm(item);
    if (k === 'coin') return 1;
    const short = new Set(bill.filter(r => r.short > 0).flatMap(r => [r.item, ...(r.aliases ?? [])].map(norm)));
    return (prices[k] ?? 0) * (short.has(k) || (FEEDS[k] ?? []).some(f => short.has(f)) ? BILL_PREMIUM : SURPLUS);
}

const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }) =>
    Object.entries(needs?.skills ?? {}).every(([s, l]) => (skillOverride?.skill === s ? Math.max(skillOverride.to, a.skills[s] ?? 1) : a.skills[s] ?? 1) >= l)
    && Object.entries(needs?.items ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n);
// The coins a template needs beyond what the account holds, and its needs without the coin line.
const coinShort = (a: Acct, needs: Template['needs']) => Math.max(0, (Object.entries(needs?.items ?? {}).find(([i]) => norm(i) === 'coin')?.[1] ?? 0) - (a.items.coin ?? 0));
const withoutCoins = (needs: Template['needs']): Template['needs'] => ({ ...needs, items: Object.fromEntries(Object.entries(needs?.items ?? {}).filter(([i]) => norm(i) !== 'coin')) });

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste'>): number {
    const gross = t.yields(a).reduce((v, f) => v + f.perTick * unitValue(f.item, inp.bill, inp.prices), 0);
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? 1 : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
}

export function plan(inp: Inputs): Assignment[] {
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    type Cand = { account: string; template: Template; value: number; resources: string[]; reason: string; coins?: number };
    const cands: Cand[] = [];
    for (const a of mine) for (const t of inp.templates) {
        if (inp.retired?.has(pairKey(a.name, t.id))) continue;
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
    // A candidate's worth with the holders taken so far: a resource someone already holds keeps its shared rate.
    const worth = (c: Cand) => c.resources.reduce((v, r) => (used.get(r) ?? 0) > 0 ? v * (inp.shared?.[r] ?? 1) : v, c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // Donor coins above the reserve, spent as funded candidates take them; a funded account gives nothing.
    // A donor that gives stays free this pass, so the fleet agent can log it in for the trade.
    const pool = new Map((inp.donors ?? []).map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)])), gave = new Set<string>();
    // Re-sorted after every assignment: one more holder lowers the worth of the candidates that share its resource.
    for (const rest = [...cands]; rest.length;) {
        rest.sort(order);
        const c = rest.shift()!;
        if (done.has(c.account) || gave.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) continue;
        const value = worth(c);
        let fund: Funding | undefined;
        if (c.coins) {
            const from = [...pool].filter(([n, left]) => n.toLowerCase() !== c.account.toLowerCase() && !done.has(n) && left >= c.coins!).sort((x, y) => y[1] - x[1])[0]?.[0];
            if (!from) continue;
            pool.set(from, pool.get(from)! - c.coins); gave.add(from);
            fund = { from, to: c.account, coins: c.coins, template: c.template.id };
        }
        pool.delete(c.account);
        for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
        done.set(c.account, { account: c.account, template: c.template, value, reason: fund ? `${c.reason}, funded ${c.coins} coins by ${fund.from}` : c.reason, resources: c.resources, ...(fund ? { fund } : {}) });
    }
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass' : 'vacant: no template meets its skills and holdings with a free resource' });
}

// The swarm job for an assignment. `autopilot` marks it as this side's planner job; the CLI replaces only marked jobs.
// A training job does not repeat: its ok RESULT means the target level is met, and a rerun would log in, find the level
// met and log out (a scored login for nothing). The swarm keeps the account's `done` end until the next pass hands it
// a job with a different mission, which the met level unlocks. A run that ends short of the target is a fail RESULT,
// which the supervisor retries and the swarm's standing retry resumes, with or without repeat.
// finishedTrainers() brings that next pass forward.
export function jobFor(x: Assignment, side: string) {
    const t = x.template!;
    return { account: x.account, script: t.script, args: t.args ?? [], env: t.env ?? {}, role: t.role, goal: t.goal, enabled: true, repeat: !t.trains, standing: true,
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
// pack. Counting these as failures retired every knight spot of every account in one server outage.
export const RETIRE_FAILS = 2, WASTE_LIMIT = 0.9;
export const progressed = (result: string) => /\b(?:xp|gained|coinsGained|banked)=[1-9]\d*\b/.test(result);
export const DRAIN_RESULT = /^RESULT fail (?:session ended: disconnected\b|login: \[object WebSocket\]|TickStallError\b)/;
export function assess(lines: readonly string[]): { retire: boolean; reason: string; ok: number; fail: number; drains: number } {
    const clean = lines.map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, ''));
    const drains = clean.filter(l => DRAIN_RESULT.test(l)).length;
    const results = clean.filter(l => /^RESULT (ok|fail)\b/.test(l) && !DRAIN_RESULT.test(l));
    const ok = results.filter(l => l.startsWith('RESULT ok')).length, fail = results.length - ok;
    // goldfarm and thieving60 print died=false on a healthy run: only a bare word or a field that is not false counts.
    const died = results.find(l => /\b(?:died|death)\b(?!=)|\b(?:died|death)=(?!false\b)/i.test(l));
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
// Claim: two farmers can share one knight spot. A pickpocket does not hold the knight: 4 practice bots on the same
// knights each earned 13.3-15.1 coins per tick (mean 14.7) against the 18.8 model, every run RESULT ok and logged out.
// Conditions: practice server, goldfarm.ts at its default spot, 3 runs of 600 ticks and one of 9,000. Evidence:
// research/bot-host.md section 3. Gap: two farmers on one live spot is not measured. KNIGHT_SHARED_RATE is an estimate.
export const KNIGHT_SHARE = 2, KNIGHT_SHARED_RATE = 0.75;
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
export const SHARED: Readonly<Record<string, number>> = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARED_RATE]));

// Proven job templates. Rates are estimates from each script's header model; tick-waste discounts them by measurement.
export function catalogue(): Template[] {
    const goldfarm = KNIGHT_SPOTS.map((spot): Template => ({
        id: `goldfarm@${spot}`, family: 'goldfarm', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot, TICKS: '9000' }, role: 'thieving',
        goal: `goldfarm knights at ${spot}`, needs: { skills: { Thieving: 55 } }, resources: [`knight:${spot}`],
        yields: a => [{ item: 'coins', perTick: knightCoinsPerTick(a.skills.Thieving ?? 1) }],
    }));
    return [
        ...goldfarm,
        { id: 'thieving55', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: '55', CAP: '2500', CLEAN_FOOD: '1' }, role: 'thieving',
            goal: 'train Thieving to 55 for a knight spot', trains: { skill: 'Thieving', to: 55, unlocks: goldfarm.map(g => g.id) }, yields: () => [] },
        ...CHICKEN_PENS.map((pen): Template => ({
            id: `feathers@${pen}`, family: 'gather-feathers', script: 'scripts/gather-feathers.ts', env: { PEN: pen, TICKS: '3000' }, role: 'helper',
            goal: `feathers at the chicken pen ${pen}`, resources: [`pen:${pen}`],
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

// A marked job whose account is in `keep` (an owner pause: a stop file) stays as it is, with its enabled and repeat
// settings, so lifting the pause later resumes that job instead of handing the account a fresh enabled one.
export function mergeJobs(jobs: readonly any[], side: string, out: readonly Assignment[], keep: ReadonlySet<string> = new Set()): { jobs: any[]; fresh: string[] } {
    const mine = (j: any) => j?.autopilot === side, kept = (j: any) => [j?.account, ...(j?.accounts ?? [])].some((a: string) => a && keep.has(a.toLowerCase()));
    const next = jobs.filter(j => !mine(j) || kept(j)), fresh: string[] = [];
    for (const x of out) {
        if (!x.template) continue;
        const prior = jobs.find(j => mine(j) && j.account === x.account && j.template === x.template!.id);
        if (prior) { next.push(prior); continue; }
        fresh.push(x.account);
        // An owner pause belongs to the account: a new template keeps it disabled and keeps its repeat policy.
        const paused = jobs.find(j => mine(j) && j.account === x.account && j.enabled === false);
        next.push(paused ? { ...jobFor(x, side), enabled: false, repeat: paused.repeat } : jobFor(x, side));
    }
    return { jobs: next, fresh };
}
