import { expect, test } from 'bun:test';
import { AIO_PLACES, TRAIN_SHARE, aioTemplates, combatLevel, CAPACITY, STRIKE_TILE, COW_BANDS, COW_FIELD_CAPACITY, TROOPER_FIELD_CAPACITY, FEATHER_TARGET, KNIGHT_SHARE, KNIGHT_SPOTS, SHARED, recoveringOwnerJobs, accountFrom, assess, catalogue, freshest, claimFor, finishedTrainers, jobFor, jobResources, knightCoinsPerTick, mergeJobs, pairKey, plan, plannableAccounts, reservedResources, unitValue, type Acct, type Inputs, type Template } from '../src/autopilot';

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

test('a knight spot takes KNIGHT_SHARE farmers, each worth less: the empty spots fill first, then the least-held', () => {
    const fresh = [acct('NewA'), acct('NewB'), acct('NewC')];
    const knights = (n: number) => Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, n]));
    const shared = (taken: Record<string, number>) => plan(inputs(fresh, { taken, capacity: CAPACITY, shared: SHARED }));
    // One empty spot: the first account takes it at full worth, the others take a second place on a held spot.
    const one = shared({ ...knights(1), 'knight:2582,3297': 0 });
    expect(ids(one)).toEqual({ NewA: 'thieving55', NewB: 'thieving55', NewC: 'thieving55' });
    expect(one[0]!.resources).toEqual(['knight:2582,3297']);
    const holders = (taken: Record<string, number>, out: ReturnType<typeof plan>) => out.reduce((m, x) => ({ ...m, [x.resources[0]!]: (m[x.resources[0]!] ?? 0) + 1 }), { ...taken });
    expect(Math.max(...Object.values(holders({ ...knights(1), 'knight:2582,3297': 0 }, one)))).toBe(2);
    expect(one[1]!.value).toBeCloseTo(one[0]!.value * SHARED['knight:2652,3318']!, 9);
    // No account takes a place beyond a spot's capacity.
    expect(KNIGHT_SHARE).toBe(4);
    expect(ids(shared({ ...knights(KNIGHT_SHARE), 'knight:2582,3297': KNIGHT_SHARE - 1 }))).toEqual({ NewA: 'thieving55', NewB: expect.stringMatching(/^feathers@/), NewC: expect.stringMatching(/^feathers@/) });
    expect(Object.values(ids(shared(knights(KNIGHT_SHARE)))).every(id => id.startsWith('feathers@'))).toBe(true);
    // With every spot at two farmers, the third places still take fresh accounts, one to a spot, each worth less than a
    // second place.
    const third = shared(knights(2));
    expect(ids(third)).toEqual({ NewA: 'thieving55', NewB: 'thieving55', NewC: 'thieving55' });
    expect(Math.max(...Object.values(holders(knights(2), third)))).toBe(3);
    expect(third[0]!.value).toBeCloseTo(one[0]!.value * SHARED['knight:2652,3318']! ** 2, 9);
    expect(third[0]!.value).toBeLessThan(one[1]!.value);
    // Two accounts of this side on empty spots spread out instead of sharing.
    const spread = shared({});
    expect(new Set(spread.map(x => x.resources[0])).size).toBe(3);
    expect(spread.every(x => x.value === spread[0]!.value)).toBe(true);
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
test('an account whose pack meets the feather target gets no feather job', () => {
    const knights = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, 1]));
    expect(ids(plan(inputs([acct('Full', {}, { feather: FEATHER_TARGET })], { taken: knights }))).Full).not.toMatch(/^feathers@/);
    expect(ids(plan(inputs([acct('Room', {}, { feather: FEATHER_TARGET - 1 })], { taken: knights }))).Room).toMatch(/^feathers@/);
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
    // A training job runs once: its ok RESULT is the target met, so a repeat would be a no-op login.
    const [fresh] = plan(inputs([acct('Fresh')]));
    expect(fresh!.template!.id).toBe('thieving55');
    expect(jobFor(fresh!, side)).toMatchObject({ script: 'scripts/generated/thieving60.ts', repeat: false, standing: true });
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
    // A job carrying the template's id but another script, args or env (a hand edit, or a template changed in code) is
    // replaced by the template's own job; an owner pause on it holds.
    for (const drift of [{ script: 'scripts/gather-combat.ts' }, { env: { ...job.env, KNIGHT_SPOT: '0,0' } }, { args: ['5000'] }]) {
        expect(mergeJobs([{ ...job, ...drift }], side, [x!])).toEqual({ jobs: [job], fresh: ['ThiefA'] });
        expect(mergeJobs([{ ...job, ...drift, enabled: false, repeat: false }], side, [x!]).jobs).toEqual([{ ...job, enabled: false, repeat: false }]);
    }
});

test('a training job does not repeat, and its ok RESULT names the account for an early pass', () => {
    const [x] = plan(inputs([acct('NewA')]));
    const trainer = jobFor(x!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', enabled: true, repeat: false, standing: true });
    const farm = jobFor(plan(inputs([acct('ThiefA', { Thieving: 80 })]))[0]!, side);
    const assigned = { NewA: { template: 'thieving55', offset: 10 }, ThiefA: { template: farm.template, offset: 0 } };
    const logs: Record<string, string[]> = { NewA: ['[x] RESULT ok thieving=55 xp=16000 ticks=1736 died=false'], ThiefA: ['RESULT ok coinsGained=900 died=false banked=900'] };
    const lines = (a: string, offset: number) => offset === assigned[a as keyof typeof assigned].offset ? logs[a]! : [];
    // Only a trains template counts; a producing job's ok RESULT is its normal repeat.
    expect(finishedTrainers([trainer, farm], side, assigned, catalogue(), lines)).toEqual(['NewA']);
    expect(finishedTrainers([trainer], side, assigned, catalogue(), () => ['RESULT fail thieving 52 < 55 ...'])).toEqual([]);
    // A job the state no longer assigns, or another side's, is not this planner's trainer.
    expect(finishedTrainers([trainer], side, { NewA: { template: 'goldfarm@2582,3297', offset: 10 } }, catalogue(), lines)).toEqual([]);
    expect(finishedTrainers([{ ...trainer, autopilot: 'cloud' }], side, assigned, catalogue(), lines)).toEqual([]);
});

test('existing jobs hold their resources, chain steps included', () => {
    expect(jobResources({ script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' } })).toEqual(['knight:2671,3313']);
    expect(jobResources({ script: 'scripts/goldfarm.ts' })).toEqual(['knight:2653,3300']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/shop-buyer.ts harry 300', 'scripts/goldfarm.ts KNIGHT_SPOT=2582,3297'] })).toEqual(['shop:harry', 'knight:2582,3297']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'] })).toEqual(['catherby:lobster']);
    expect(jobResources({ script: 'scripts/gather-fish.ts', args: ['harpoon'] })).toEqual([]);
    // Ranged training kills the Lumbridge pen's chickens, so a side running it holds that pen against feather jobs.
    expect(jobResources({ script: 'scripts/ranged-train.ts', args: ['97', '30000'], env: { FOOD: '2' } })).toEqual(['pen:3229,3298']);
    expect(jobResources({ script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' } })).toEqual(['pen:3017,3288']);
    expect(jobResources({ script: 'x', resources: ['shop:betty'] })).toEqual(['shop:betty']);
});

test('assess retires repeated fails, a death and near-total waste, and keeps progress', () => {
    expect(assess(['RESULT ok feathers=30 gained=30', 'RESULT fail no chickens']).retire).toBe(false);
    expect(assess(['[x] RESULT fail no chickens', '| RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2 });
    expect(assess(['RESULT fail died at 2652,3318']).reason).toMatch(/^death/);
    // A world planner `no route` is where the account stands, not the job's failure: a drain, never a retirement.
    const noRoute = 'RESULT fail travel to Ardougne from 3185,3436 failed: precondition no route to 2654,3283,0';
    expect(assess([noRoute, noRoute])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    expect(assess(['RESULT fail no combat progress: cow stage: walk to Ardougne north bank failed: precondition no route to 2619,3332,0', noRoute]).retire).toBe(false);
    // A cow run that killed and trained before failing made progress; two runs with no kill did not.
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=6 selectedXp=5200', 'RESULT fail mode=cow ok=false creditedKills=2 selectedXp=1600']).retire).toBe(false);
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0', 'RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0']).retire).toBe(true);
    expect(assess(['RESULT fail coinsGained=10 died=true banked=0']).reason).toMatch(/^death/);
    expect(assess(['RESULT ok coinsGained=1000 died=false banked=1000']).retire).toBe(false);
    expect(assess(['LEDGER ticks=1000 xp=0 move=500 anim=10 dialog=0 stun=0 idle=450', 'RESULT ok feathers=0 gained=0']).reason).toMatch(/^tick waste 95%/);
    expect(assess(['LEDGER ticks=1000 xp=0 move=300 anim=600 dialog=0 stun=0 idle=100', 'RESULT ok feathers=90 gained=90']).retire).toBe(false);
    expect(assess(['LEDGER ticks=100 xp=0 move=50 anim=0 dialog=0 stun=0 idle=50']).retire).toBe(false);
    // A trainer at its tick cap short of the target ends fail with the XP it gained: progress, not a fail toward retirement.
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=16000 ticks=2500 died=false', 'RESULT fail thieving 54 < 55 thieving=54 xp=9000 ticks=2500 died=false'])).toMatchObject({ retire: false, fail: 2 });
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false', 'RESULT fail stop file thieving=52 xp=0 ticks=3 died=false'])).toMatchObject({ retire: true, fail: 2 });
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

test('a paused handed-over job keeps its pen reserved', () => {
    const jobs = [
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' }, enabled: true, autopilot: side },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', env: { PEN: '3229,3298' }, enabled: true, autopilot: side },
        { account: 'CoinCock', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' }, enabled: true },
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: false },
    ];
    expect(Object.keys(reservedResources(jobs, side, new Set(['hocuspokeus']))).sort()).toEqual(['knight:2671,3313', 'pen:3017,3288']);
});

test('the claim lists every spot, pen and shop the enabled jobs of this side hold, planner-made or not, once per job', () => {
    const jobs = [
        { account: 'Pocketpython', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2582,3297' }, enabled: true },
        { account: 'Shaftsinker', script: 'scripts/chain.ts', args: ['scripts/goldfarm.ts KNIGHT_SPOT=2653,3300'], env: { ROUNDS: '1', RUN: '2' }, enabled: true },
        { account: 'PickpockDick', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2653,3302' }, enabled: true },
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side, template: 'feathers@3017,3288', resources: ['pen:3017,3288'] },
        { account: 'Woodpecker', script: 'scripts/chain.ts', args: ['scripts/generated/thieving60.ts TARGET=55 CAP=3000', 'scripts/goldfarm.ts KNIGHT_SPOT=2669,3298'], enabled: false },
        { account: 'Quickhandjob', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2652,3318' }, enabled: true },
        { accounts: ['NabTheKnob', 'Swordinhand'], host: true, script: 'scripts/quest-chain.ts', enabled: true },
        { account: 'Haggis', script: '', enabled: false },
    ];
    const claim = claimFor(jobs, side, a => a === 'Quickhandjob' ? 'cloud' : side, 1234);
    // Shaftsinker and PickpockDick both farm the 2653,3300 knights, so the other sides count two farmers there.
    expect(claim).toEqual({ side, at: 1234, resources: ['knight:2582,3297', 'knight:2653,3300', 'knight:2653,3300', 'pen:3017,3288'] });
    expect(claimFor([], side, () => side, 5).resources).toEqual([]);
    // Only a job with an active account holds its resources: a parked job's spot is free for the other sides.
    expect(claimFor(jobs, side, a => a === 'Quickhandjob' ? 'cloud' : side, 1234, a => a === 'Pocketpython' || a === 'Hocuspokeus').resources).toEqual(['knight:2582,3297', 'pen:3017,3288']);
});

test('an account the coordinator is recovering keeps its own job in the claim; other coordinator work does not', () => {
    const own = [
        { account: 'Kiltlifter', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, autopilot: side, resources: ['knight:2671,3313'] },
        { account: 'SporranDip', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2652,3318' }, enabled: true, autopilot: side, resources: ['knight:2652,3318'] },
        { account: 'Knightstick', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2669,3298' }, enabled: true, autopilot: side, resources: ['knight:2669,3298'] },
    ];
    const coord = [
        { account: 'Kiltlifter', script: 'scripts/session-check.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'Knightstick', script: 'scripts/generated/quest-cook.ts', enabled: true, coordinatorOwner: 'coordinator' },
    ];
    expect(recoveringOwnerJobs(own, coord).map(j => j.account)).toEqual(['Kiltlifter']);
    expect(recoveringOwnerJobs(own, [{ ...coord[0], script: './scripts/session-check.ts' }]).map(j => j.account)).toEqual(['Kiltlifter']);
    expect(recoveringOwnerJobs(own, [])).toEqual([]);
    // The merged plan drops both shadowed jobs; adding the recovering one back keeps only Kiltlifter's place.
    const merged = [own[1]!, ...coord];
    expect(claimFor([...merged, ...recoveringOwnerJobs(own, coord)], side, () => side, 1).resources).toEqual(['knight:2652,3318', 'knight:2671,3313']);
});

test('a marked reservation opts its account in, and planning replaces it with an enabled job', () => {
    const jobs = [
        { account: 'Magicwanda', script: '', enabled: true, autopilot: 'local' },
        { account: 'Pocketpython', script: 'scripts/goldfarm.ts', enabled: false, env: { KNIGHT_SPOT: '2582,3297' } },
        { account: 'Moneyshot', script: 'scripts/goldfarm.ts', enabled: true, env: { KNIGHT_SPOT: '2652,3318' } },
    ];
    expect(plannableAccounts(jobs, 'local', ['Magicwanda', 'Pocketpython', 'Moneyshot', 'Wandwaver'], new Set())).toEqual(['Magicwanda', 'Wandwaver']);
    expect(reservedResources(jobs, 'local', new Set())).toEqual({ 'knight:2652,3318': 1 });
    const t = catalogue().find(x => x.id === 'goldfarm@2669,3298')!;
    const { jobs: next, fresh } = mergeJobs(jobs, 'local', [{ account: 'Magicwanda', template: t, value: 10, resources: ['knight:2669,3298'], reason: 'best' }]);
    expect(fresh).toEqual(['Magicwanda']);
    const made = next.find(j => j.account === 'Magicwanda')!;
    expect(made.enabled).toBe(true); expect(made.script).toBe('scripts/goldfarm.ts'); expect(made.env.KNIGHT_SPOT).toBe('2669,3298');
    expect(next.filter(j => j.account === 'Magicwanda')).toHaveLength(1);
});

test('the freshest observation wins by its time stamp; nothing observed is null', () => {
    const status = { at: 10, skills: [{ name: 'Thieving', level: 1 }] }, snapshotRow = { at: 20, skills: [{ name: 'Thieving', level: 99 }] };
    expect(freshest(status, snapshotRow)).toBe(snapshotRow);
    expect(freshest(snapshotRow, status)).toBe(snapshotRow);
    expect(freshest(null, snapshotRow)).toBe(snapshotRow);
    expect(freshest(undefined, null)).toBeNull();
    expect(accountFrom('Quickhandjob', 'claude-cloud', freshest(null, snapshotRow), () => undefined).skills.Thieving).toBe(99);
});

test('on a value tie an account keeps the template it holds, so a level change does not move it to another spot', () => {
    const a = acct('UnderMyKilt', { Thieving: 99 }), b = acct('TheFullMonty', { Thieving: 99 });
    expect(ids(plan(inputs([a, b])))).toEqual({ TheFullMonty: 'goldfarm@2582,3297', UnderMyKilt: 'goldfarm@2652,3318' });
    const current = new Map([['undermykilt', 'goldfarm@2669,3298'], ['thefullmonty', 'goldfarm@2671,3313']]);
    expect(ids(plan(inputs([a, b], { current })))).toEqual({ TheFullMonty: 'goldfarm@2671,3313', UnderMyKilt: 'goldfarm@2669,3298' });
    // A held spot another side now claims is taken: the account moves, the other keeps its own.
    expect(ids(plan(inputs([a, b], { current, taken: { 'knight:2669,3298': 1 } })))).toEqual({ TheFullMonty: 'goldfarm@2671,3313', UnderMyKilt: 'goldfarm@2582,3297' });
});

test('a farmer keeps its knight place while the spot has room, so sides do not chase each other\'s claims', () => {
    const a = acct('UnderMyKilt', { Thieving: 99 }), current = new Map([['undermykilt', 'goldfarm@2669,3298']]);
    const held = (others: number) => plan(inputs([a], { current, capacity: CAPACITY, shared: SHARED, taken: { 'knight:2669,3298': others } }));
    // Two other farmers on its spot while four spots stand empty: it stays.
    expect(ids(held(2))).toEqual({ UnderMyKilt: 'goldfarm@2669,3298' });
    // A full spot (KNIGHT_SHARE other farmers) moves it to an empty spot.
    expect(ids(held(KNIGHT_SHARE)).UnderMyKilt).toMatch(/^goldfarm@/);
    expect(ids(held(KNIGHT_SHARE)).UnderMyKilt).not.toBe('goldfarm@2669,3298');
    // An account with no place still takes an empty spot over the crowded one.
    const fresh = plan(inputs([acct('NewA', { Thieving: 99 })], { capacity: CAPACITY, shared: SHARED, taken: { 'knight:2669,3298': 2 } }));
    expect(ids(fresh).NewA).not.toBe('goldfarm@2669,3298');
});

test('a server outage is a drain: a socket error at login or a stalled tick stream never retires a job', () => {
    const login = 'RESULT fail login: [object WebSocket]', stall = 'RESULT fail TickStallError: tick stream stalled: no new game tick for 15000ms';
    expect(assess([login, login, stall, stall])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 4 });
    expect(assess(['RESULT fail no chickens', login, stall, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 2 });
    expect(assess(['RESULT fail login: LoginError: Account already logged in', 'RESULT fail login: LoginError: Account already logged in']).retire).toBe(true);
});
test('a login refused while a dropped session holds the fleet claim is a drain, not a failure', () => {
    const held = 'RESULT fail Error: fleet account claim held by swarm';
    expect(assess([held, held, held])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 3 });
    expect(assess(['RESULT fail fleet account claim held by swarm'])).toMatchObject({ fail: 0, drains: 1 });
    expect(assess(['RESULT fail no chickens', held, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
});

test('a held account refusing logins after a drop is a drain: the refusal as the worker logs it (`login: Error: …`) never retires the spot', () => {
    const drop = 'RESULT fail session ended: disconnected', held = 'RESULT fail login: Error: fleet account claim held by swarm';
    expect(assess([drop, held, held, held])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 4 });
    expect(assess(['RESULT fail no chickens', held, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
});
test('a run the gateway dropped is a drain, not a failure: two drains keep the job, two real fails after them retire it', () => {
    const drain = 'RESULT fail session ended: disconnected';
    expect(assess([drain, drain])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 2 });
    expect(assess(['RESULT fail no chickens', drain, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
    expect(assess(['RESULT fail no chickens', drain, 'RESULT ok feathers=30 gained=30'])).toMatchObject({ retire: false, ok: 1, fail: 1, drains: 1 });
});

test('goal bands go only to army accounts, before any coin job, earliest band first and nearest target first', () => {
    const band = (id: string, n: number, skill: string, to: number, extra: Partial<Template> = {}): Template => ({ id, family: 'combat-train', script: 'scripts/gather-combat.ts', role: 'combat',
        goal: `${skill} to ${to}`, tier: 'goal', band: n, trains: { skill, to, unlocks: [] }, yields: () => [], resources: ['giant:edge'], ...extra });
    const bands = [band('str60', 0, 'Strength', 60), band('att60', 1, 'Attack', 60)];
    const farm = catalogue().filter(t => t.family === 'goldfarm');
    const thief = (name: string, skills: Record<string, number> = {}) => acct(name, { Thieving: 99, ...skills });
    const army = new Set(['nearer', 'farther']);
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => ids(plan(inputs(accounts, { templates: [...bands, ...farm], army, capacity: { 'giant:edge': 1 }, ...extra })));
    // An army account trains even though goldfarm pays coins; a specialist off the roster keeps farming.
    expect(run([thief('Nearer'), thief('Specialist')])).toEqual({ Nearer: 'str60', Specialist: expect.stringMatching(/^goldfarm@/) });
    // One giant place, shared by both bands: the account nearest its band target takes it, and the other, with no free
    // band left, falls to the coin tier rather than idling.
    expect(run([thief('Nearer', { Strength: 50 }), thief('Farther', { Strength: 10 })])).toEqual({ Nearer: 'str60', Farther: expect.stringMatching(/^goldfarm@/) });
    // A met band is skipped: Strength 60 goes on to Attack.
    expect(run([thief('Nearer', { Strength: 60 })])).toEqual({ Nearer: 'att60' });
    // Kit money: a band an account cannot pay for is funded by a donor of its side, or left to the coin tier.
    const kit = [band('str60', 0, 'Strength', 60, { needs: { items: { coins: 100_000 } } })];
    expect(ids(plan(inputs([thief('Nearer')], { templates: [...kit, ...farm], army })))).toEqual({ Nearer: expect.stringMatching(/^goldfarm@/) });
    const funded = plan(inputs([thief('Nearer')], { templates: [...kit, ...farm], army, donors: [{ name: 'Bank', coins: 1_000_000 }] }));
    expect(funded[0]).toMatchObject({ template: { id: 'str60' }, fund: { from: 'Bank', to: 'Nearer', coins: 100_000 } });
});

test('the Ardougne cow bands train army accounts, fresh ones too, with 14 HP of food and the bronze kit, as repeating jobs', () => {
    const kit = { trout: 2, 'bronze sword': 1, 'wooden shield': 1 };
    const fighter = (name: string, skills: Record<string, number>, items: Record<string, number> = kit) => acct(name, { Thieving: 99, ...skills }, items);
    const holders = Array.from({ length: COW_FIELD_CAPACITY }, (_, i) => `Holder${i + 1}`);
    const army = new Set(['cowhand', 'pure', 'broke', ...holders.map(h => h.toLowerCase())]);
    const run = (accounts: Acct[]) => plan(inputs(accounts, { army, capacity: CAPACITY }));
    const pick = (accounts: Acct[]) => ids(run(accounts));
    // Strength, Attack, then Defence to 45; then each on through 60, 70, 80, 90 and 99; then the coin tier.
    expect(pick([fighter('Cowhand', { Hitpoints: 35 })])).toEqual({ Cowhand: 'army-cow-strength-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45 })])).toEqual({ Cowhand: 'army-cow-attack-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45, Attack: 45 })])).toEqual({ Cowhand: 'army-cow-defence-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45, Attack: 45, Defence: 45 })])).toEqual({ Cowhand: 'army-cow-strength-60' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 60, Attack: 60, Defence: 60 })])).toEqual({ Cowhand: 'army-cow-strength-70' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 70, Attack: 61, Defence: 60 })])).toEqual({ Cowhand: 'army-cow-attack-70' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 99, Attack: 99, Defence: 90 })])).toEqual({ Cowhand: 'army-cow-defence-99' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 99, Attack: 99, Defence: 99 })]).Cowhand).toMatch(/^goldfarm@/);
    expect(COW_BANDS.map(b => b.band)).toEqual([0, 1, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    // A first pass outranks a second: a fresh account takes a place from a holder training past 45.
    const second = { Hitpoints: 50, Strength: 50, Attack: 45, Defence: 45 };
    const current = new Map(holders.map(h => [h.toLowerCase(), 'army-cow-strength-60']));
    const pass = ids(plan(inputs([fighter('Cowhand', { Hitpoints: 35 }), ...holders.map(h => fighter(h, second))], { army, capacity: CAPACITY, current })));
    expect(pass.Cowhand).toBe('army-cow-strength-45');
    expect(Object.values(pass).filter(id => id === 'army-cow-strength-60')).toHaveLength(COW_FIELD_CAPACITY - 1);
    // With no giant band, a range pure at Hitpoints 82 trains Strength on the cows too; Hitpoints 10 has too little
    // food margin and farms.
    expect(pick([fighter('Pure', { Hitpoints: 82 })])).toEqual({ Pure: 'army-cow-strength-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 10 })])).toEqual({ Cowhand: 'army-cow-strength-45' });
    // Cake counts by its bites: a 2/3 cake and a slice heal 12 HP, short of 14, and the account farms; add a whole cake
    // (pack or bank) and it trains.
    const bronze = { 'bronze sword': 1, 'wooden shield': 1 };
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { ...bronze, '2/3 cake': 1, 'slice of cake': 1 })]).Broke).toMatch(/^goldfarm@/);
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { ...bronze, '2/3 cake': 1, 'slice of cake': 1, cake: 1 })])).toEqual({ Broke: 'army-cow-strength-45' });
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { trout: 2 })]).Broke).toMatch(/^goldfarm@/);
    // The field takes COW_FIELD_CAPACITY (six); one more army account farms.
    expect(COW_FIELD_CAPACITY).toBe(6);
    const full = pick([fighter('Cowhand', { Hitpoints: 35 }), ...holders.map((h, i) => fighter(h, { Hitpoints: 36 + i }))]);
    expect(Object.values(full).filter(id => id.startsWith('army-cow-'))).toHaveLength(COW_FIELD_CAPACITY);
    // Cow mode runs a fixed 8 kills, so its job repeats until the band's target moves the account on.
    const job = jobFor(run([fighter('Cowhand', { Hitpoints: 35 })])[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['3000', 'cow'], env: { TRAIN_SKILL: 'Strength', COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1' }, repeat: true, resources: ['cow:ardougne-north'] });
});

test('army accounts at 60 in all three melee skills train to 99 on the Khazard troopers when they hold 10 fish', () => {
    const ready = Array.from({ length: TROOPER_FIELD_CAPACITY + 1 }, (_, i) => `Ready${i + 1}`);
    const army = new Set(['soldier', 'young', ...ready.map(n => n.toLowerCase())]);
    const kit = { 'bronze sword': 1, 'wooden shield': 1, cake: 2 };
    const soldier = (name: string, items: Record<string, number> = { ...kit, shark: 10 }, skills: Record<string, number> = {}) =>
        acct(name, { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 84, ...skills }, items);
    const pick = (accounts: Acct[]) => ids(plan(inputs(accounts, { army, capacity: CAPACITY })));
    expect(pick([soldier('Soldier')])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // Any mix of the four fish and cooked meat counts; cake does not, and an account short of food stays on the cows.
    expect(pick([soldier('Soldier', { ...kit, shark: 4, lobster: 3, swordfish: 2, trout: 1 })])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, shark: 4, 'cooked meat': 6 })])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, shark: 9 })])).toEqual({ Soldier: 'army-cow-strength-70' });
    expect(pick([soldier('Soldier', { ...kit, cake: 30, 'slice of cake': 30 })])).toEqual({ Soldier: 'army-cow-strength-70' });
    // The raw beef a cow leaver banked counts: the trooper job cooks it first (TROOPER_COOK).
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 300 })])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 9 })])).toEqual({ Soldier: 'army-cow-strength-70' });
    // Strength, Attack, then Defence; an account under 60 in any of them finishes the cow passes to 60 first.
    expect(pick([soldier('Soldier', undefined, { Strength: 99 })])).toEqual({ Soldier: 'army-trooper-attack-99' });
    expect(pick([soldier('Young', undefined, { Attack: 45, Strength: 45, Defence: 45 })])).toEqual({ Young: 'army-cow-strength-60' });
    // The battlefield takes TROOPER_FIELD_CAPACITY; one more ready account trains on the cows.
    expect(TROOPER_FIELD_CAPACITY).toBe(14);
    const full = pick(ready.map(n => soldier(n)));
    expect(Object.values(full).filter(id => id.startsWith('army-trooper-'))).toHaveLength(TROOPER_FIELD_CAPACITY);
    expect(Object.values(full).filter(id => id === 'army-cow-strength-70')).toHaveLength(1);
    const job = jobFor(plan(inputs([soldier('Soldier')], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'], env: { TRAIN_SKILL: 'Strength', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
});

test('army accounts alch Magic to 99 with natures, feathers and fire, then bury held bones for Prayer', () => {
    const army = new Set(['caster']);
    const melee = { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 84, Magic: 48, Prayer: 74 };
    const pick = (skills: Record<string, number>, items: Record<string, number>) => ids(plan(inputs([acct('Caster', { ...melee, ...skills }, items)], { army, capacity: CAPACITY }))).Caster;
    const alch = { 'nature rune': 50, feather: 50 };
    // Magic comes before the troopers and the later cow passes; fire is 250 runes or any fire staff.
    expect(pick({}, { ...alch, 'fire rune': 250, shark: 20 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'staff of fire': 1 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'mystic fire staff': 1 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'fire rune': 249 })).not.toBe('army-alch-magic-99');
    expect(pick({}, { 'nature rune': 49, feather: 50, 'fire rune': 250 })).not.toBe('army-alch-magic-99');
    // Below Magic 21 the Wind Strike start comes first, one account at a time on its tile; it needs only mind and air runes.
    const strike = { 'mind rune': 35, 'air rune': 35 };
    expect(pick({ Magic: 1 }, { ...alch, 'fire rune': 250, ...strike })).toBe('army-strike-magic-21');
    expect(pick({ Magic: 20 }, strike)).toBe('army-strike-magic-21');
    expect(pick({ Magic: 1 }, { ...alch, 'fire rune': 250, 'mind rune': 34, 'air rune': 35 })).not.toBe('army-strike-magic-21');
    expect(pick({ Magic: 21 }, { ...alch, 'fire rune': 250, ...strike })).toBe('army-alch-magic-99');
    const pair = ids(plan(inputs(['Caster', 'Second'].map(n => acct(n, { ...melee, Magic: 1 }, strike)), { army: new Set(['caster', 'second']), capacity: CAPACITY })));
    expect(Object.values(pair).filter(id => id === 'army-strike-magic-21')).toHaveLength(1);
    expect(CAPACITY[STRIKE_TILE]).toBe(1);
    // Prayer comes next and needs 100 bones (accountFrom keys items by norm, so Bones is 'bone'); with fewer it moves on.
    expect(pick({ Magic: 99 }, { bone: 1674 })).toBe('army-bury-prayer-99');
    expect(pick({}, { bone: 1674 })).toBe('army-bury-prayer-99');
    expect(pick({ Magic: 99 }, { bone: 99 })).not.toBe('army-bury-prayer-99');
    expect(pick({ Magic: 99, Prayer: 99 }, { bone: 1674 })).not.toBe('army-bury-prayer-99');
    const job = jobFor(plan(inputs([acct('Caster', { ...melee, Magic: 99 }, { bone: 500 })], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, repeat: true, resources: [] });
});

test('army accounts train Ranged to 99 on the troopers with a bow they wield and 100 arrows it fires', () => {
    const army = new Set(['archer']);
    const base = { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 62, Magic: 99, Prayer: 99, Ranged: 1 };
    const pick = (skills: Record<string, number>, items: Record<string, number>) => ids(plan(inputs([acct('Archer', { ...base, ...skills }, items)], { army, capacity: CAPACITY }))).Archer;
    const fish = { shark: 20 };
    expect(pick({}, { ...fish, shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...fish, longbow: 1, 'bronze arrow': 100 })).toBe('army-trooper-ranged-99');
    // A yew bow needs Ranged 40; a shortbow cannot fire rune arrows; 99 arrows are too few; no fish, no band.
    expect(pick({}, { ...fish, 'yew shortbow': 1, 'rune arrow': 500 })).toBe('army-trooper-strength-99');
    expect(pick({ Ranged: 40 }, { ...fish, 'yew shortbow': 1, 'rune arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...fish, shortbow: 1, 'rune arrow': 500 })).toBe('army-trooper-strength-99');
    expect(pick({}, { ...fish, shortbow: 1, 'iron arrow': 99 })).toBe('army-trooper-strength-99');
    expect(pick({}, { shortbow: 1, 'iron arrow': 500 })).not.toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 99 }, { ...fish, shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-strength-99');
    const job = jobFor(plan(inputs([acct('Archer', base, { ...fish, shortbow: 1, 'iron arrow': 500 })], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'], env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
});

import { KIT_BUY, KIT_CASH_RESERVE, KIT_PRICE_CAPS, kitLacks, kitReserve, type Market, type Stock } from '../src/autopilot';
const market: Market = { 'mind rune': { id: 558, name: 'Mind rune', limit: KIT_PRICE_CAPS['mind rune']! }, 'air rune': { id: 556, name: 'Air rune', limit: KIT_PRICE_CAPS['air rune']! },
    'nature rune': { id: 561, name: 'Nature rune', limit: KIT_PRICE_CAPS['nature rune']! }, trout: { id: 333, name: 'Trout', limit: KIT_PRICE_CAPS.trout! },
    'bronze arrow': { id: 882, name: 'Bronze arrow', limit: KIT_PRICE_CAPS['bronze arrow']! } };
const strike = () => catalogue().filter(t => t.id === 'army-strike-magic-21' || t.family === 'goldfarm');
const mage = (name: string, items: Record<string, number>, skills: Record<string, number> = {}) => acct(name, { Thieving: 99, ...skills }, items);

test('kit lines: what an account lacks, the smallest of several kits, and null when a level stops the job', () => {
    const band = catalogue().find(t => t.id === 'army-strike-magic-21')!, ranged = catalogue().find(t => t.id === 'army-trooper-ranged-99')!;
    expect(kitLacks(acct('A', {}, { 'mind rune': 15, 'air rune': 25 }), band.needs)).toEqual([{ of: ['mind rune'], count: 20 }, { of: ['air rune'], count: 10 }]);
    expect(kitLacks(acct('A', {}, { 'mind rune': 35, 'air rune': 35 }), band.needs)).toEqual([]);
    // Hitpoints 40 is a level, not a kit line.
    expect(kitLacks(acct('A', { Hitpoints: 39 }, {}), ranged.needs)).toBeNull();
    // A shortbow with 25 bronze arrows is the nearest ranged kit: 75 arrows and 10 pieces of food short.
    expect(kitLacks(acct('A', { Hitpoints: 40 }, { shortbow: 1, 'bronze arrow': 25 }), ranged.needs)).toEqual([{ of: ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'raw beef'], count: 10 }, { of: ['bronze arrow'], count: 75 }]);
    expect(kitReserve(catalogue())).toMatchObject({ 'mind rune': 35, 'air rune': 35, 'nature rune': 50, feather: 50, bone: 100 });
});

test('a rich army account buys its missing kit with its own coins in one login, in place of a coin job', () => {
    const army = new Set(['rich']), rich = mage('Rich', { coin: 5_000_000, 'mind rune': 15, 'air rune': 25 });
    // No market and no donor: a coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
    // In a running coin job (unfundable) it still takes the buy: a buy needs no trade partner.
    const [x] = plan(inputs([rich], { templates: strike(), army, market, unfundable: new Set(['rich']) }));
    expect(x!.template!.id).toBe(KIT_BUY + 'army-strike-magic-21');
    expect(x!.template!.script).toBe('scripts/chain.ts');
    expect(x!.template!.args).toEqual([
        'scripts/buy-owned-ge-item.ts ITEM_ID=558 QUANTITY=20 EXPECTED_OWNED=15 LIMIT_PRICE=120 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-558-15to35 ORDER_MS=900000 FILL_WAIT_TICKS=200',
        'scripts/buy-owned-ge-item.ts ITEM_ID=556 QUANTITY=10 EXPECTED_OWNED=25 LIMIT_PRICE=160 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-556-25to35 ORDER_MS=900000 FILL_WAIT_TICKS=200']);
    expect(jobFor(x!, side)).toMatchObject({ repeat: false, standing: true, template: KIT_BUY + 'army-strike-magic-21', env: { ROUNDS: '1' } });
    // With the kit held it takes the band.
    expect(ids(plan(inputs([mage('Rich', { coin: 5_000_000, 'mind rune': 35, 'air rune': 35 })], { templates: strike(), army, market })))).toEqual({ Rich: 'army-strike-magic-21' });
    // The band's place is full: no kit for it, and the account keeps a coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army, market, capacity: CAPACITY, taken: { [STRIKE_TILE]: 1 } })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
    // An account off the roster keeps its coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army: new Set(), market })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
});

test('a kit buy brings the batch, not one start: 1,000 nature runes for alchemy', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const [x] = plan(inputs([mage('Rich', { coin: 5_000_000, 'nature rune': 10, feather: 500, 'staff of fire': 1 }, { Magic: 30 })], { templates: alch, army, market }));
    expect(x!.template!.args).toEqual(['scripts/buy-owned-ge-item.ts ITEM_ID=561 QUANTITY=990 EXPECTED_OWNED=10 LIMIT_PRICE=800 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-561-10to1000 ORDER_MS=900000 FILL_WAIT_TICKS=200']);
    expect(x!.reason).toContain('at most 792000 coins');
});

test('an account that cannot pay gets the coins first: from this side, else from a free account of another side', () => {
    const army = new Set(['poor']), poor = mage('Poor', { coin: 100, 'mind rune': 15, 'air rune': 25 }), cost = 20 * 120 + 10 * 160, short = cost + KIT_CASH_RESERVE - 100;
    const own = plan(inputs([poor], { templates: strike(), army, market, donors: [{ name: 'Bank', coins: 1_000_000 }] }))[0]!;
    expect(own.fund).toEqual({ from: 'Bank', to: 'Poor', coins: short, template: KIT_BUY + 'army-strike-magic-21' });
    const far: Stock[] = [{ name: 'CloudBank', side: 'local', items: { coin: 2_000_000 } }];
    expect(plan(inputs([poor], { templates: strike(), army, market, stock: far }))[0]!.fund).toEqual({ from: 'CloudBank', to: 'Poor', coins: short, template: KIT_BUY + 'army-strike-magic-21' });
    // A running job is never funded: the trade could not reach the account.
    expect(ids(plan(inputs([poor], { templates: strike(), army, market, stock: far, unfundable: new Set(['poor']) })))).toEqual({ Poor: expect.stringMatching(/^goldfarm@/) });
});

test('with no buy, a free account sends the item: this side first, another side next, and never from its own kit', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 });
    const stock: Stock[] = [{ name: 'Far', side: 'local', items: { 'mind rune': 400 } }, { name: 'Near', side, items: { 'mind rune': 60 } }, { name: 'Thin', side, items: { 'mind rune': 54 } }];
    const run = (extra: Partial<Inputs>) => plan(inputs([needy], { templates: strike(), army, ...extra }))[0]!;
    // Near holds 60 and keeps the band's 35: 25 spare covers the 20.
    expect(run({ stock }).send).toEqual({ from: 'Near', to: 'Needy', item: 'mind rune', count: 20, template: 'army-strike-magic-21' });
    // Thin holds 54: 19 spare is one short, so the other side gives.
    expect(run({ stock: [stock[0]!, stock[2]!] }).send).toMatchObject({ from: 'Far' });
    expect(run({ stock: [stock[2]!] }).template!.id).toMatch(/^goldfarm@/);
    // A buy that failed twice is retired for the pair, and the donors take over.
    const paying = { accounts: [mage('Needy', { ...needy.items, coin: 1_000_000 })] };
    expect(run({ ...paying, stock, market }).template!.id).toBe(KIT_BUY + 'army-strike-magic-21');
    expect(run({ ...paying, stock, market, retired: new Set([pairKey('Needy', KIT_BUY + 'army-strike-magic-21')]) }).send).toMatchObject({ from: 'Near' });
});

test('an army account in a coin job leaves it for a kit order; one on a band or a kit buy stays', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 }), stock: Stock[] = [{ name: 'Near', side, items: { 'mind rune': 60 } }];
    const run = (current: string) => plan(inputs([needy], { templates: [...strike(), ...catalogue().filter(t => t.id === 'army-bury-prayer-99')], army, stock, unfundable: new Set(['needy']), current: new Map([['needy', current]]) }))[0]!;
    const left = run('goldfarm@2652,3318');
    expect(left.template).toBeUndefined();
    expect(left.reason).toBe('vacant: leaves its job for 20 mind rune from Near for army-strike-magic-21');
    expect(run('army-bury-prayer-99').template!.id).toMatch(/^goldfarm@/);
    expect(run(KIT_BUY + 'army-strike-magic-21').template!.id).toMatch(/^goldfarm@/);
});

test('a donor that gives a kit item takes no job on that pass', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 }), near = mage('Near', { 'mind rune': 60 });
    const out = plan(inputs([needy, near], { templates: strike(), army, stock: [{ name: 'Near', side, items: near.items }] }));
    expect(out.find(x => x.account === 'Needy')!.send).toMatchObject({ from: 'Near', count: 20 });
    const giver = out.find(x => x.account === 'Near')!;
    expect(giver.template).toBeUndefined();
    expect(giver.reason).toBe('vacant: gives a kit item this pass');
});

import { COIN_GLUT, COIN_GLUT_VALUE, coinValueFor } from '../src/autopilot';
test('a side that banks the glut level counts a coin as almost nothing, so a short bill line beats a coin job', () => {
    expect(coinValueFor(COIN_GLUT - 1)).toBe(1);
    expect(coinValueFor(COIN_GLUT)).toBe(COIN_GLUT_VALUE);
    expect(unitValue('coins', [], prices, COIN_GLUT_VALUE)).toBe(COIN_GLUT_VALUE);
    const thief = acct('Thief', { Thieving: 99 }, { coin: 5_000_000 }), shortTips = [row('rune arrowtips', 1588)];
    const pick = (coinValue?: number) => ids(plan(inputs([thief], { bill: shortTips, coinValue })))['Thief'];
    expect(pick()).toMatch(/^goldfarm@/);
    expect(pick(COIN_GLUT_VALUE)).toBe('shop-arrowtips');
    // With nothing else to do, the coin job stays as the last job.
    expect(ids(plan(inputs([thief], { templates: catalogue().filter(t => t.family === 'goldfarm'), coinValue: COIN_GLUT_VALUE })))['Thief']).toMatch(/^goldfarm@/);
});

test('a kit buy RESULT with "died":false is not a death, and a real death still is', () => {
    const ok = '  | RESULT ok {"ok":true,"phase":"settled","acquired":30,"died":false,"damaged":false}';
    expect(assess([ok])).toMatchObject({ retire: false, ok: 1 });
    expect(assess(['RESULT fail {"ok":false,"died":true}']).retire).toBe(true);
    expect(assess(['RESULT fail died after 1 runs']).retire).toBe(true);
    expect(assess(['RESULT ok ticks=9001 died=false']).retire).toBe(false);
});

test('a later top-up from the same holding gets a new order key', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const rich = mage('Rich', { coin: 5_000_000, feather: 500, 'staff of fire': 1 }, { Magic: 30 });
    const key = (kitSeq?: Map<string, number>) => plan(inputs([rich], { templates: alch, army, market, kitSeq }))[0]!.template!.args![0]!.match(/ORDER_KEY=(\S+)/)![1];
    expect(key()).toBe('rich-kit0-561-0to1000');
    expect(key(new Map([['rich', 3]]))).toBe('rich-kit3-561-0to1000');
});

test('with no fire staff the alchemy kit buys fire runes, not a staff no market sells', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const full: Market = { ...market, 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! }, feather: { id: 314, name: 'Feather', limit: KIT_PRICE_CAPS.feather! } };
    const [x] = plan(inputs([mage('Rich', { coin: 5_000_000 }, { Magic: 30 })], { templates: alch, army, market: full }));
    expect(x!.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(x!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).join('x'))).toEqual(['561x1000', '314x50', '554x250']);
    // With no rule for what it can get, the nearest kit is the one-item staff.
    const band = alch[0]!;
    expect(kitLacks(mage('Rich', {}, { Magic: 30 }), band.needs)!.at(-1)).toEqual({ of: ['staff of fire'], count: 1 });
    expect(kitLacks(mage('Rich', {}, { Magic: 30 }), band.needs, i => !/staff/.test(i))!.at(-1)).toEqual({ of: ['fire rune'], count: 250 });
});

test('a line no market sells is sent first; a pair whose order failed is not asked again', () => {
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45' || t.family === 'goldfarm'), army = new Set(['needy']);
    const needy = acct('Needy', { Thieving: 99, Hitpoints: 35 }, { 'wooden shield': 1, coin: 100_000 });
    const stock: Stock[] = [{ name: 'Near', side, items: { 'bronze sword': 3, trout: 500 } }, { name: 'Next', side, items: { 'bronze sword': 2 } }];
    const run = (extra: Partial<Inputs> = {}) => plan(inputs([needy], { templates: cow, army, market, stock, capacity: CAPACITY, ...extra }))[0]!;
    // The sword has no market entry, so no one buy covers the kit: the sword comes by order, the trout by a later buy.
    expect(run().send).toEqual({ from: 'Near', to: 'Needy', item: 'bronze sword', count: 1, template: 'army-cow-strength-45' });
    expect(run({ noSend: new Set(['near>needy']) }).send).toMatchObject({ from: 'Next' });
    const armed = acct('Needy', { Thieving: 99, Hitpoints: 35 }, { 'wooden shield': 1, 'bronze sword': 1, coin: 100_000 });
    expect(plan(inputs([armed], { templates: cow, army, market, stock, capacity: CAPACITY }))[0]!.template!.args).toEqual([
        'scripts/buy-owned-ge-item.ts ITEM_ID=333 QUANTITY=30 LIMIT_PRICE=100 CASH_RESERVE=1000 ORDER_KEY=needy-kit0-333-0to30 ORDER_MS=900000 FILL_WAIT_TICKS=200']);
});

test('an account in a running band job gets no kit buy over it', () => {
    const army = new Set(['busy']), templates = [...strike(), ...catalogue().filter(t => t.id === 'army-bury-prayer-99')];
    const busy = mage('Busy', { coin: 5_000_000, 'mind rune': 15, 'air rune': 35, bone: 40 });
    const on = (current: string) => plan(inputs([busy], { templates, army, market, unfundable: new Set(['busy']), current: new Map([['busy', current]]) }))[0]!.template!.id;
    // Its bones dipped under the band's start count while it buries: the kit tier leaves it to the rule it had before.
    expect(on('army-bury-prayer-99')).toMatch(/^goldfarm@/);
    expect(on('goldfarm@2652,3318')).toBe(KIT_BUY + 'army-strike-magic-21');
});

test('an account that cannot pay for the batch buys only the start kit', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['thin']);
    const thin = mage('Thin', { coin: 50_000, 'nature rune': 10, feather: 500, 'staff of fire': 1 }, { Magic: 30 });
    const [x] = plan(inputs([thin], { templates: alch, army, market, unfundable: new Set(['thin']) }));
    expect(x!.template!.args![0]).toContain('QUANTITY=40 EXPECTED_OWNED=10 LIMIT_PRICE=800');
    expect(x!.reason).toContain('at most 32000 coins');
});

// AIO routes (aioTemplates): practice-proved options the plan's `aio` list admits.
const aioIds = aioTemplates().map(t => t.id);
const aioPrices = { flax: 5, 'iron ore': 17, 'copper ore': 3, 'tin ore': 3, 'rune essence': 4, 'air rune': 4, 'bow string': 10, 'arrow shaft': 1, 'yew log': 160 };
const aioInputs = (accounts: Acct[], pilots: string[], extra: Partial<Inputs> = {}): Inputs =>
    inputs(accounts, { templates: aioTemplates(), bill: [], prices: aioPrices, pilots: new Set(pilots), capacity: CAPACITY, ...extra });
const sweepKit = { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1, trout: 4, 'bronze pickaxe': 1 };

test('every AIO template is in the catalogue as a pilot that runs the dispatcher with its category first', () => {
    const all = new Map(catalogue().map(t => [t.id, t]));
    expect(aioIds).toEqual(['aio-flax', 'aio-bowstrings', 'aio-yews', 'aio-shafts', 'aio-ore', 'aio-essence', 'aio-air-runes', 'aio-quest-runemysteries']);
    for (const t of aioTemplates()) {
        expect(all.get(t.id)).toBeDefined();
        expect(t.pilot).toBe(true);
        expect(t.script).toBe('scripts/aio.ts');
        expect(t.args![0]).toBe(t.aio!.split(':')[0]!);
        expect(t.worker).toMatch(/^scripts\/[a-z-]+\.ts$/);
        for (const r of t.resources ?? []) expect(CAPACITY[r]).toBe(1);
    }
});

test('no AIO route is planned until the plan admits its id', () => {
    const rich = acct('A', { Crafting: 20, Woodcutting: 70, Attack: 30, Strength: 30 }, { flax: 100, knife: 1, log: 50, 'rune axe': 1, 'rune pickaxe': 1, 'air talisman': 1, 'rune essence': 100, ...sweepKit });
    expect(ids(plan(aioInputs([rich], [])))).toEqual({ A: 'vacant' });
    expect(ids(plan(inputs([rich], { prices: { ...prices, ...aioPrices }, bill: [] }))).A).not.toMatch(/^aio-/);
    expect(ids(plan(aioInputs([rich], ['aio-flax'])))).toEqual({ A: 'aio-flax' });
});

test('an AIO job runs scripts/aio.ts with its category and route as arguments', () => {
    const [x] = plan(aioInputs([acct('A')], ['aio-flax']));
    const job = jobFor(x!, side);
    expect(job).toMatchObject({ account: 'A', script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'], repeat: true, standing: true, template: 'aio-flax', resources: [AIO_PLACES.flax] });
});

test('the ore route needs combat 13 and a pickaxe; the status combat level wins over the one worked out from skills', () => {
    const run = (a: Acct) => ids(plan(aioInputs([a], ['aio-ore']))).A;
    expect(combatLevel({ Hitpoints: 10 })).toBe(3);
    expect(combatLevel({ Attack: 20, Strength: 20, Hitpoints: 10 })).toBe(15);
    expect(run(acct('A', {}, { 'bronze pickaxe': 1 }))).toBe('vacant');
    expect(run(acct('A', { Attack: 20, Strength: 20 }, {}))).toBe('vacant');
    expect(run(acct('A', { Attack: 20, Strength: 20 }, { 'bronze pickaxe': 1 }))).toBe('aio-ore');
    expect(run({ ...acct('A', { Attack: 20, Strength: 20 }, { 'bronze pickaxe': 1 }), combat: 12 })).toBe('vacant');
    expect(run({ ...acct('A', {}, { 'rune pickaxe': 1 }), combat: 13 })).toBe('aio-ore');
});

test('the production routes need their level and a whole batch of the input', () => {
    const run = (a: Acct, id: string) => ids(plan(aioInputs([a], [id]))).A;
    expect(run(acct('A', { Crafting: 9 }, { flax: 56 }), 'aio-bowstrings')).toBe('vacant');
    expect(run(acct('A', { Crafting: 10 }, { flax: 55 }), 'aio-bowstrings')).toBe('vacant');
    expect(run(acct('A', { Crafting: 10 }, { flax: 56 }), 'aio-bowstrings')).toBe('aio-bowstrings');
    expect(run(acct('A', {}, { knife: 1, log: 24 }), 'aio-shafts')).toBe('vacant');
    expect(run(acct('A', {}, { knife: 1, log: 25 }), 'aio-shafts')).toBe('aio-shafts');
    expect(run(acct('A', { Woodcutting: 59 }, { 'bronze axe': 1 }), 'aio-yews')).toBe('vacant');
    expect(run(acct('A', { Woodcutting: 60 }, { 'bronze axe': 1 }), 'aio-yews')).toBe('aio-yews');
    expect(run(acct('A', {}, { 'air talisman': 1, 'rune essence': 27 }), 'aio-air-runes')).toBe('vacant');
    expect(run(acct('A', {}, { 'air talisman': 1, 'rune essence': 28 }), 'aio-air-runes')).toBe('aio-air-runes');
});

test('Rune Mysteries is planned for the essence mine it unlocks, once, and only with the sweep pack', () => {
    const both = ['aio-quest-runemysteries', 'aio-essence'];
    const [x] = plan(aioInputs([acct('A', {}, sweepKit)], both));
    expect(x!.template!.id).toBe('aio-quest-runemysteries');
    expect(x!.reason).toBe('completes Rune Mysteries Quest for aio-essence');
    expect(x!.value).toBeCloseTo(TRAIN_SHARE * 0.03 * 4 * 0.5);
    expect(x!.resources).toEqual([AIO_PLACES.essence]);
    expect(jobFor(x!, side)).toMatchObject({ args: ['quester', 'sweep', 'runemysteries'], repeat: false });
    // No essence route admitted, a missing rune, three meals, or no pickaxe for the mine: no quest run.
    expect(ids(plan(aioInputs([acct('A', {}, sweepKit)], ['aio-quest-runemysteries'])))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, 'law rune': 1 })], both)))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, trout: 3 })], both)))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, 'bronze pickaxe': 0 })], both)))).toEqual({ A: 'vacant' });
    // The status reports the quest complete: the account mines essence, and the quest is never run again.
    const done: Acct = { ...acct('A', {}, sweepKit), quests: new Set(['rune mysteries quest']) };
    expect(ids(plan(aioInputs([done], both)))).toEqual({ A: 'aio-essence' });
    expect(ids(plan(aioInputs([done], ['aio-quest-runemysteries'])))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { 'bronze pickaxe': 1 })], ['aio-essence'])))).toEqual({ A: 'vacant' });
});

test('a place takes one AIO account, and a retired pair stays out', () => {
    expect(ids(plan(aioInputs([acct('A'), acct('B')], ['aio-flax'])))).toEqual({ A: 'aio-flax', B: 'vacant' });
    expect(ids(plan(aioInputs([acct('A')], ['aio-flax'], { retired: new Set([pairKey('A', 'aio-flax')]) })))).toEqual({ A: 'vacant' });
});

test('a quest job with an ok RESULT is re-planned at once, as a finished trainer is', () => {
    const [x] = plan(aioInputs([acct('A', {}, sweepKit)], ['aio-quest-runemysteries', 'aio-essence']));
    const job = jobFor(x!, side), assigned = { A: { template: job.template, offset: 0 } };
    expect(finishedTrainers([job], side, assigned, aioTemplates(), () => ['RESULT ok quest-sweep runemysteries'])).toEqual(['A']);
    expect(finishedTrainers([job], side, assigned, aioTemplates(), () => [])).toEqual([]);
});

test('an account row carries its combat level and its complete quests', () => {
    const a = accountFrom('A', side, { combat: 23, quests: [{ name: 'Rune Mysteries Quest', state: 'complete' }, { name: 'Imp Catcher', state: 'not started' }], skills: [], inventory: [] }, () => undefined);
    expect(a.combat).toBe(23);
    expect([...a.quests!]).toEqual(['rune mysteries quest']);
    const bare = accountFrom('B', side, null, () => undefined);
    expect(bare.combat).toBeUndefined();
    expect(bare.quests).toBeUndefined();
});

import { PRAYER_FIELD_BAND } from '../src/autopilot';
test('a melee-maxed army account buries trooper bones for Prayer when no band and no kit serves it', () => {
    const army = new Set(['maxed']);
    const melee = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 89 };
    const field = catalogue().find(t => t.id === 'army-trooper-prayer-99')!;
    expect(field).toMatchObject({ band: PRAYER_FIELD_BAND, filler: true, resources: ['trooper:battlefield'] });
    const pick = (skills: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Maxed', { ...melee, ...skills }, items)], { army, capacity: CAPACITY, ...extra }))[0]!;
    // Short of the 100 bones the bones-held band needs, it kills troopers for theirs; no coin job takes it.
    const x = pick({}, { shark: 30, bone: 63 });
    expect(x.template!.id).toBe('army-trooper-prayer-99');
    expect(jobFor(x, side)).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
    // With the bones held, that band comes first; at Prayer 99 neither is a candidate; without food it has no place.
    expect(pick({}, { shark: 30, bone: 100 }).template!.id).toBe('army-bury-prayer-99');
    expect(pick({ Prayer: 99 }, { shark: 30, bone: 63 }).template?.id ?? 'vacant').not.toMatch(/^army-/);
    expect(pick({}, { bone: 63 }).template?.id).not.toBe('army-trooper-prayer-99');
    // An account with melee left takes its trooper band, never the filler.
    expect(pick({ Defence: 82 }, { shark: 30 }).template!.id).toBe('army-trooper-defence-99');
});

test('the Prayer filler waits behind a kit buy and gives way to one while it runs', () => {
    const army = new Set(['archer']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 87, Magic: 99, Prayer: 74 };
    const archer = acct('Archer', skills, { coin: 4_000_000, shark: 40, shortbow: 1 });
    // Its Ranged band lacks only arrows the market sells: the buy comes before the filler.
    expect(plan(inputs([archer], { army, market, capacity: CAPACITY }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // The same while the filler is its running job: a kit buy replaces a filler, as it replaces a coin job.
    const busy = { army, market, capacity: CAPACITY, unfundable: new Set(['archer']) };
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-prayer-99']]) }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // A band proper still keeps its place over a kit buy.
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-defence-99']]) }))[0]!.template!.id).not.toBe(KIT_BUY + 'army-trooper-ranged-99');
    // With no market for the arrows it fills the time on the field.
    expect(plan(inputs([archer], { army, capacity: CAPACITY }))[0]!.template!.id).toBe('army-trooper-prayer-99');
});
