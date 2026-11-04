import { expect, test } from 'bun:test';
import { accountFrom, assess, catalogue, jobFor, jobResources, knightCoinsPerTick, mergeJobs, pairKey, plan, plannableAccounts, reservedResources, unitValue, type Acct, type Inputs } from '../src/autopilot';

const side = 'claude-cloud';
const acct = (name: string, skills: Record<string, number> = {}, items: Record<string, number> = {}, s = side): Acct => ({ name, side: s, skills: { Hitpoints: 10, ...skills }, items });
const row = (item: string, short: number) => ({ item, need: short, owned: 0, short, ids: [1], holders: [] });
const prices = { feather: 2, 'headless arrow': 1, lobster: 150, 'fire rune': 4, 'air rune': 4, 'earth rune': 4, 'rune arrowtip': 200, 'adamant arrowtip': 80, 'arrow shaft': 1 };
const bill = [row('feathers', 800), row('headless arrows', 3615), row('lobster', 610), row('fire rune', 2000)];
const inputs = (accounts: Acct[], extra: Partial<Inputs> = {}): Inputs => ({
    side, accounts, owners: new Map(accounts.map(a => [a.name.toLowerCase(), { side: a.side }])), bill, templates: catalogue(), prices, ...extra,
});
const ids = (xs: ReturnType<typeof plan>) => Object.fromEntries(xs.map(x => [x.account, x.template?.id ?? 'vacant']));

test('a bill line still short, or one it feeds, is worth the premium; coins are worth one', () => {
    expect(unitValue('Feather', bill, prices)).toBe(4);
    expect(unitValue('Feather', [row('feathers', 0), row('headless arrows', 10)], prices)).toBe(4);
    expect(unitValue('Feather', [row('feathers', 0)], prices)).toBe(1);
    expect(unitValue('coins', [], prices)).toBe(1);
});

test('knight coins scale with Thieving and are zero below 55', () => {
    expect(knightCoinsPerTick(54)).toBe(0);
    expect(knightCoinsPerTick(99)).toBeCloseTo(18.8, 5);
    expect(knightCoinsPerTick(70)).toBeGreaterThan(knightCoinsPerTick(55));
});

test('only this side plans, one account per exclusive resource, and taken resources stay taken', () => {
    const accounts = [acct('ThiefA', { Thieving: 80 }), acct('ThiefB', { Thieving: 70 }), acct('Theirs', { Thieving: 99 }, {}, 'local')];
    const taken = { 'knight:2652,3318': 1, 'knight:2653,3300': 1, 'knight:2669,3298': 1, 'knight:2671,3313': 1 };
    const out = plan(inputs(accounts, { taken }));
    expect(out.map(x => x.account)).toEqual(['ThiefA', 'ThiefB']);
    expect(ids(out).ThiefA).toBe('goldfarm@2582,3297');
    expect(ids(out).ThiefB).toMatch(/^feathers@/);
    // An account the owners file gives another side is never planned, whatever its status says.
    const owners = new Map([['thiefa', { side: 'local' }], ['thiefb', { side }]]);
    expect(plan({ ...inputs(accounts), owners }).map(x => x.account)).toEqual(['ThiefB']);
});

test('a fresh account trains toward a free knight spot and reserves it; with no free spot it gathers', () => {
    const fresh = [acct('NewA'), acct('NewB')];
    const four = { 'knight:2652,3318': 1, 'knight:2653,3300': 1, 'knight:2669,3298': 1, 'knight:2671,3313': 1 };
    const out = plan(inputs(fresh, { taken: four }));
    expect(ids(out)).toEqual({ NewA: 'thieving55', NewB: expect.stringMatching(/^feathers@/) });
    expect(out[0]!.resources).toEqual(['knight:2582,3297']);
    expect(ids(plan(inputs(fresh, { taken: { ...four, 'knight:2582,3297': 1 } })))).toEqual({ NewA: expect.stringMatching(/^feathers@/), NewB: expect.stringMatching(/^feathers@/) });
});

test('skills and holdings gate templates; coins pick a shop; a retired pair picks the next best', () => {
    const fisher = acct('Fisher', { Fishing: 60, Cooking: 60 }, { 'lobster pot': 1 });
    expect(ids(plan(inputs([fisher])))).toEqual({ Fisher: 'lobster-chain' });
    expect(ids(plan(inputs([acct('Fisher', { Fishing: 60, Cooking: 60 })])))).toEqual({ Fisher: expect.stringMatching(/^thieving55$|^feathers@/) });
    expect(ids(plan(inputs([fisher], { retired: new Set([pairKey('Fisher', 'lobster-chain')]) }))).Fisher).not.toBe('lobster-chain');
    const knights = Object.fromEntries(['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'].map(s => [`knight:${s}`, 1]));
    expect(ids(plan(inputs([acct('Rich', {}, { coin: 50_000 })], { taken: knights }))).Rich).toBe('shop-feathers');
    expect(ids(plan(inputs([acct('Fletch', {}, { 'arrow shaft': 1000, feather: 1000 })]))).Fletch).toBe('fletch-headless');
});

test('a shop blocked only by coins is funded by the richest free donor above its reserve', () => {
    const knights = Object.fromEntries(['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'].map(s => [`knight:${s}`, 1]));
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const poor = acct('Poor', {}, { coin: 500 });
    const out = plan(inputs([poor], { templates: shops, taken: knights, donors: [{ name: 'Small', coins: 51_000 }, { name: 'Big', coins: 900_000 }] }));
    expect(out[0]!.template?.id).toBe('shop-feathers');
    expect(out[0]!.fund).toEqual({ from: 'Big', to: 'Poor', coins: 1_500, template: 'shop-feathers' });
    // No donor holds the need above FUND_RESERVE (50,000): the account stays vacant and nothing is funded.
    const none = plan(inputs([poor], { templates: shops, donors: [{ name: 'Small', coins: 51_000 }] }));
    expect(none[0]!.template).toBeUndefined();
    // Without donors the old rule stands: the coin need gates the shop.
    expect(plan(inputs([poor], { templates: shops }))[0]!.template).toBeUndefined();
});

test('a donor that gives stays free that pass; an account that holds the coins needs no fund', () => {
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const show = (out: ReturnType<typeof plan>) => Object.fromEntries(out.map(x => [x.account, x.fund ? `funded by ${x.fund.from}` : x.template?.id ?? x.reason]));
    const opts = (donor: string) => ({ templates: shops, capacity: { 'shop:sarim': 2 }, donors: [{ name: donor, coins: 900_000 }] });
    // Equal values go in name order. Poor comes first: Zed funds it and takes no job.
    expect(show(plan(inputs([acct('Poor'), acct('Zed', {}, { coin: 900_000 })], opts('Zed'))))).toEqual({ Poor: 'funded by Zed', Zed: 'vacant: gives coins this pass' });
    // Big comes first and takes the job itself: an assigned account never gives.
    expect(show(plan(inputs([acct('Poor'), acct('Big', {}, { coin: 900_000 })], opts('Big'))))).toEqual({ Poor: expect.stringMatching(/^vacant: no template/), Big: 'shop-feathers' });
    expect(plan(inputs([acct('Rich', {}, { coin: 5_000 })], { templates: shops, donors: [{ name: 'Big', coins: 900_000 }] }))[0]!.fund).toBeUndefined();
});

test('an account with an enabled job is never funded, so no running job is removed for a trade', () => {
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const out = plan(inputs([acct('Poor', {}, { coin: 500 })], { templates: shops, donors: [{ name: 'Big', coins: 900_000 }], unfundable: new Set(['poor']) }));
    expect(out[0]!.fund).toBeUndefined();
    expect(out[0]!.template).toBeUndefined();
});

test('an account with nothing useful is vacant with its constraint', () => {
    const out = plan(inputs([acct('Idle')], { templates: catalogue().filter(t => t.id === 'lobster-chain') }));
    expect(out).toEqual([{ account: 'Idle', value: 0, resources: [], reason: expect.stringMatching(/^vacant: /) }]);
});

test('tick waste discounts a family', () => {
    const a = [acct('ThiefA', { Thieving: 80 })];
    const plain = plan(inputs(a))[0]!.value, wasted = plan(inputs(a, { waste: { goldfarm: 0.5 } }))[0]!.value;
    expect(wasted).toBeCloseTo(plain / 2, 5);
});

test('planner jobs carry the marker, repeat and standing, and the merge keeps unmarked and unchanged jobs', () => {
    const [x] = plan(inputs([acct('ThiefA', { Thieving: 80 })]));
    const job = jobFor(x!, side);
    expect(job).toMatchObject({ account: 'ThiefA', script: 'scripts/goldfarm.ts', enabled: true, repeat: true, standing: true, autopilot: side, template: x!.template!.id });
    const human = { account: 'Other', script: 'scripts/goldfarm.ts', enabled: true }, theirs = { account: 'Far', script: 'x', enabled: true, autopilot: 'cloud' };
    const stale = { account: 'Gone', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side, template: 'feathers@3229,3298' };
    const kept = { ...job, note: 'kept as is' };
    const merged = mergeJobs([human, theirs, stale, kept], side, [x!]);
    expect(merged.jobs).toEqual([human, theirs, kept]);
    expect(merged.fresh).toEqual([]);
    expect(mergeJobs([human], side, [x!]).fresh).toEqual(['ThiefA']);
    // An owner pause on the old template stays on the new one.
    const paused = { ...stale, account: 'ThiefA', enabled: false, repeat: false };
    expect(mergeJobs([paused], side, [x!]).jobs).toEqual([{ ...job, enabled: false, repeat: false }]);
});

test('existing jobs hold their resources, chain steps included', () => {
    expect(jobResources({ script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' } })).toEqual(['knight:2671,3313']);
    expect(jobResources({ script: 'scripts/goldfarm.ts' })).toEqual(['knight:2653,3300']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/shop-buyer.ts harry 300', 'scripts/goldfarm.ts KNIGHT_SPOT=2582,3297'] })).toEqual(['shop:harry', 'knight:2582,3297']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'] })).toEqual(['catherby:lobster']);
    expect(jobResources({ script: 'scripts/gather-fish.ts', args: ['harpoon'] })).toEqual([]);
    expect(jobResources({ script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' } })).toEqual(['pen:3017,3288']);
    expect(jobResources({ script: 'x', resources: ['shop:betty'] })).toEqual(['shop:betty']);
});

test('assess retires repeated fails, a death and near-total waste, and keeps progress', () => {
    expect(assess(['RESULT ok feathers=30 gained=30', 'RESULT fail no chickens']).retire).toBe(false);
    expect(assess(['[x] RESULT fail no chickens', '| RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2 });
    expect(assess(['RESULT fail died at 2652,3318']).reason).toMatch(/^death/);
    expect(assess(['RESULT fail coinsGained=10 died=true banked=0']).reason).toMatch(/^death/);
    expect(assess(['RESULT ok coinsGained=1000 died=false banked=1000']).retire).toBe(false);
    expect(assess(['LEDGER ticks=1000 xp=0 move=500 anim=10 dialog=0 stun=0 idle=450', 'RESULT ok feathers=0 gained=0']).reason).toMatch(/^tick waste 95%/);
    expect(assess(['LEDGER ticks=1000 xp=0 move=300 anim=600 dialog=0 stun=0 idle=100', 'RESULT ok feathers=90 gained=90']).retire).toBe(false);
    expect(assess(['LEDGER ticks=100 xp=0 move=50 anim=0 dialog=0 stun=0 idle=50']).retire).toBe(false);
});

test('a status file becomes base levels and held counts by name', () => {
    const a = accountFrom('Pal', side, { skills: [{ name: 'Thieving', level: 56 }], inventory: [{ id: 314, name: 'Feather', count: 40 }], bank: [{ id: 314, count: 60 }], equipment: null }, id => id === 314 ? 'Feather' : undefined);
    expect(a).toEqual({ name: 'Pal', side, skills: { Hitpoints: 10, Thieving: 56 }, items: { feather: 100 } });
    expect(accountFrom('New', side, null, () => undefined).skills).toEqual({ Hitpoints: 10 });
});

test('the planner gets handed-over and unnamed accounts; enabled jobs, reservations and stop files keep theirs', () => {
    const jobs = [
        { account: 'Haggis', script: '', enabled: false },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side },
        { account: 'YewFirst', script: 'scripts/session-check.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'YewFirst', script: 'scripts/shop-buyer.ts', enabled: true, autopilot: side },
        { account: 'Shaftmaker', script: 'scripts/firemaking-order.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'Moneyshot', script: 'scripts/quest-cook-job.ts', enabled: true, coordinatorOwner: 'coordinator' },
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side },
        { accounts: ['NabTheKnob', 'Swordinhand'], host: true, script: 'scripts/quest-chain.ts', enabled: false, standing: true },
    ];
    const listed = ['Haggis', 'Woodpecker', 'YewFirst', 'Shaftmaker', 'Moneyshot', 'Hocuspokeus', 'NabTheKnob', 'Fresh'];
    expect(plannableAccounts(jobs, side, listed, new Set(['hocuspokeus']))).toEqual(['Woodpecker', 'YewFirst', 'Fresh']);
    expect(plannableAccounts(jobs, 'other', listed, new Set())).toEqual(['Fresh']);
});

test('a paused handed-over job stays in the merge with its own settings', () => {
    const jobs = [
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: false, repeat: false, autopilot: side, template: 'feathers@3017,3288' },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', enabled: true, repeat: true, autopilot: side, template: 'feathers@3229,3298' },
        { account: 'Haggis', script: '', enabled: false },
    ];
    const merged = mergeJobs(jobs, side, [], new Set(['hocuspokeus']));
    expect(merged.jobs.map(j => j.account)).toEqual(['Hocuspokeus', 'Haggis']);
    expect(merged.jobs[0]).toEqual(jobs[0]);
    expect(mergeJobs(jobs, side, []).jobs.map(j => j.account)).toEqual(['Haggis']);
});

test('a paused handed-over job keeps its pen reserved and claimed', () => {
    const jobs = [
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' }, enabled: true, autopilot: side },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', env: { PEN: '3229,3298' }, enabled: true, autopilot: side },
        { account: 'CoinCock', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' }, enabled: true },
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: false },
    ];
    const r = reservedResources(jobs, side, new Set(['hocuspokeus']), a => a === 'CoinCock' ? 'other' : side);
    expect(Object.keys(r.taken).sort()).toEqual(['knight:2671,3313', 'pen:3017,3288']);
    expect(r.ownHeld).toEqual(['pen:3017,3288']);
});
