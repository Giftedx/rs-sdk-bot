import { expect, test } from 'bun:test';
import { AIR_STOCK, NATURE_STOCK, ARROW_LOW, ARROW_STOCK, FEATHER_STOCK, FIRE_STOCK, BONE_KEEP, BONE_PURSE, BONE_SKILL, BONE_START, LOWE_STOCK, WEAPON, WEAPON_HELD, WEAPON_MARKET, AIO_PLACES, TRAIN_SHARE, aioTemplates, combatLevel, CAPACITY, STRIKE_TILE, COW_BANDS, COW_FIELD_CAPACITY, TROOPER_FIELD_CAPACITY, FEATHER_TARGET, KNIGHT_SHARE, KNIGHT_SPOTS, SHARED, recoveringOwnerJobs, accountFrom, assess, catalogue, freshest, claimFor, finishedTrainers, jobFor, jobResources, knightCoinsPerTick, mergeJobs, pairKey, plan, plannableAccounts, reservedResources, unitValue, type Acct, type Inputs, type Template } from '../src/autopilot';

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
    // A market buy that did not reach the market bank placed no order (live: a stale state at Port Sarim, off the
    // second ferry, in a relayed session). Its two forms are drains; a buy that reached the bank and failed is not.
    const trip = 'RESULT fail market bank travel failed: position=3029,3217,0 currentHP=99 ticks=207; Error: no route to 3185,3436,0';
    const budget = 'RESULT fail Error: market bank travel failed: position=3029,3217,0 currentHP=99 ticks=41; Error: market trip health/stop/tick budget';
    expect(assess([trip, budget])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    expect(assess(['RESULT fail {"ok":false,"phase":"unplaced","acquired":0,"failure":"final bank/reserve/asset reconciliation failed"}', 'RESULT fail {"ok":false,"phase":"unplaced","acquired":0,"failure":"x"}']).retire).toBe(true);
    // A buy refused because the planner's count of the item was stale placed no order either (live: baseline 104
    // against EXPECTED_OWNED 140); the chain's result line carries the step's text.
    const stale = 'RESULT fail {"ok":false,"phase":"unplaced","pending":false,"quantity":10,"acquired":0,"spent":0,"finalItems":104,"ticks":4,"failure":"Error: owned item baseline 104 differs from EXPECTED_OWNED 140"} chain rounds=1 ok=0 failed=1';
    expect(assess([stale, stale])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    expect(assess(['RESULT fail no combat progress: cow stage: walk to Ardougne north bank failed: precondition no route to 2619,3332,0', noRoute]).retire).toBe(false);
    // A cow run that killed and trained before failing made progress; two runs with no kill did not.
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=6 selectedXp=5200', 'RESULT fail mode=cow ok=false creditedKills=2 selectedXp=1600']).retire).toBe(false);
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0', 'RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0']).retire).toBe(true);
    expect(assess(['RESULT fail coinsGained=10 died=true banked=0']).reason).toMatch(/^death/);
    expect(assess(['RESULT ok coinsGained=1000 died=false banked=1000']).retire).toBe(false);
    expect(assess(['LEDGER ticks=1000 xp=0 move=500 anim=10 dialog=0 stun=0 idle=450', 'RESULT ok feathers=0 gained=0']).reason).toMatch(/^tick waste 95%/);
    expect(assess(['LEDGER ticks=1000 xp=0 move=300 anim=600 dialog=0 stun=0 idle=100', 'RESULT ok feathers=90 gained=90']).retire).toBe(false);
    expect(assess(['LEDGER ticks=100 xp=0 move=50 anim=0 dialog=0 stun=0 idle=50']).retire).toBe(false);
    // A fight is mostly ticks between hits: a run that ended ok with progress is not retired on its ledger.
    const fight = 'LEDGER ticks=2000 xp=120 inventory=20 move=700 anim=20 dialog=0 stun=0 idle=1140 idlePct=57.0 xpGain=60000';
    expect(assess([fight, 'RESULT ok mode=giant ok=true creditedKills=30 trainSkill=Defence selectedXp=52000']).retire).toBe(false);
    expect(assess([fight, 'RESULT ok mode=giant ok=true creditedKills=0 trainSkill=Defence selectedXp=0']).reason).toMatch(/^tick waste 92%/);
    expect(assess([fight, 'RESULT fail mode=giant ok=false creditedKills=30 selectedXp=52000 stop=cap']).reason).toMatch(/^tick waste 92%/);
    expect(assess(['RESULT ok mode=giant creditedKills=30 selectedXp=52000', fight]).reason).toMatch(/^tick waste 92%/);
    // A trainer at its tick cap short of the target ends fail with the XP it gained: progress, not a fail toward retirement.
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=16000 ticks=2500 died=false', 'RESULT fail thieving 54 < 55 thieving=54 xp=9000 ticks=2500 died=false'])).toMatchObject({ retire: false, fail: 2 });
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false', 'RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false'])).toMatchObject({ retire: true, fail: 2 });
    // A run stopped by a stop file after such a fail is not a second one.
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false', 'RESULT fail stop file thieving=52 xp=0 ticks=3 died=false'])).toMatchObject({ retire: false, fail: 1, drains: 1 });
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
test('a run that ended on a stop file is a drain: the job was stopped, it did not fail', () => {
    const inner = 'RESULT fail quest-sweep murder Error: worker finished: stop file', outer = 'RESULT fail stop file quest-chain done=drunkmonk failed=murder';
    expect(assess([inner, outer])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 2 });
    expect(assess(['  | ' + inner, outer, 'RESULT fail stop file'])).toMatchObject({ retire: false, fail: 0, drains: 3 });
    // Real fails around a stop still count.
    expect(assess(['RESULT fail no chickens', outer, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
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
    // An account that cannot steal (Thieving under 5) needs 10 pieces of stock. Any mix of the fish, cooked meat and
    // the baker's stall food counts; short of that it stays on the cows.
    const honest = { Thieving: 1 };
    expect(pick([soldier('Soldier', { ...kit, shark: 4, lobster: 3, swordfish: 2, trout: 1 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, shark: 4, 'cooked meat': 6 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, bread: 4, 'slice of cake': 6 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // The kit's two cakes count as two pieces.
    expect(pick([soldier('Soldier', { ...kit, shark: 7 }, honest)])).toEqual({ Soldier: 'army-cow-strength-70' });
    expect(pick([soldier('Soldier', { ...kit, shark: 8 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // The raw beef a cow leaver banked counts: the trooper job cooks it first (TROOPER_COOK).
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 300 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 7 }, honest)])).toEqual({ Soldier: 'army-cow-strength-70' });
    // With Thieving 5 the job steals its food at the baker's stalls, so it starts with none.
    expect(pick([soldier('Soldier', kit, { Thieving: 5 })])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', kit, { Thieving: 4 })])).toEqual({ Soldier: 'army-cow-strength-70' });
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
    expect(pick({ Thieving: 1 }, { shortbow: 1, 'iron arrow': 500 })).not.toBe('army-trooper-ranged-99');
    // A thief feeds itself, so the bow and arrows are all it needs.
    expect(pick({}, { shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 99 }, { ...fish, shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-strength-99');
    const job = jobFor(plan(inputs([acct('Archer', base, { ...fish, shortbow: 1, 'iron arrow': 500 })], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'], env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
});

import { xpForLevel } from '../src/curve';
import { KIT_BUY, KIT_CASH_RESERVE, KIT_PRICE_CAPS, kitLacks, kitReserve, type Market, type Stock } from '../src/autopilot';
const market: Market = { 'mind rune': { id: 558, name: 'Mind rune', limit: KIT_PRICE_CAPS['mind rune']! }, 'air rune': { id: 556, name: 'Air rune', limit: KIT_PRICE_CAPS['air rune']! },
    'nature rune': { id: 561, name: 'Nature rune', limit: KIT_PRICE_CAPS['nature rune']! }, trout: { id: 333, name: 'Trout', limit: KIT_PRICE_CAPS.trout! },
    'bronze arrow': { id: 882, name: 'Bronze arrow', limit: KIT_PRICE_CAPS['bronze arrow']! } };
const strike = () => catalogue().filter(t => t.id === 'army-strike-magic-21' || t.family === 'goldfarm');
// The band alone: an account with no other job to start.
const bandOnly = () => strike().filter(t => t.tier === 'goal');
const mage = (name: string, items: Record<string, number>, skills: Record<string, number> = {}) => acct(name, { Thieving: 99, ...skills }, items);

test('kit lines: what an account lacks, the smallest of several kits, and null when a level stops the job', () => {
    const band = catalogue().find(t => t.id === 'army-strike-magic-21')!, ranged = catalogue().find(t => t.id === 'army-trooper-ranged-99')!;
    expect(kitLacks(acct('A', {}, { 'mind rune': 15, 'air rune': 25 }), band.needs)).toEqual([{ of: ['mind rune'], count: 20 }, { of: ['air rune'], count: 10 }]);
    expect(kitLacks(acct('A', {}, { 'mind rune': 35, 'air rune': 35 }), band.needs)).toEqual([]);
    // Hitpoints 40 is a level, not a kit line.
    expect(kitLacks(acct('A', { Hitpoints: 39 }, {}), ranged.needs)).toBeNull();
    // A shortbow with 25 bronze arrows is the nearest ranged kit: 75 arrows short, and 10 pieces of food for an account
    // that cannot steal them.
    const stock = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake', 'raw beef'];
    expect(kitLacks(acct('A', { Hitpoints: 40 }, { shortbow: 1, 'bronze arrow': 25 }), ranged.needs)).toEqual([{ of: ['bronze arrow'], count: 75 }, { of: stock, count: 10 }]);
    expect(kitLacks(acct('A', { Hitpoints: 40, Thieving: 5 }, { shortbow: 1, 'bronze arrow': 25 }), ranged.needs)).toEqual([{ of: ['bronze arrow'], count: 75 }]);
    expect(kitReserve(catalogue())).toMatchObject({ 'mind rune': 35, 'air rune': 50, 'nature rune': 50, feather: 50, bone: 100 });
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
    // Another side's coins only for an account with no job it can start: with a coin job open it keeps that.
    const far: Stock[] = [{ name: 'CloudBank', side: 'local', items: { coin: 2_000_000 } }];
    expect(ids(plan(inputs([poor], { templates: strike(), army, market, stock: far })))).toEqual({ Poor: expect.stringMatching(/^goldfarm@/) });
    expect(plan(inputs([poor], { templates: bandOnly(), army, market, stock: far }))[0]!.fund).toEqual({ from: 'CloudBank', to: 'Poor', coins: short, template: KIT_BUY + 'army-strike-magic-21' });
    // A running job is never funded: the trade could not reach the account.
    expect(ids(plan(inputs([poor], { templates: strike(), army, market, stock: far, unfundable: new Set(['poor']) })))).toEqual({ Poor: expect.stringMatching(/^goldfarm@/) });
});

test('with no buy, a free account sends the item: this side first, another side next, and never from its own kit', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 });
    const stock: Stock[] = [{ name: 'Far', side: 'local', items: { 'mind rune': 400 } }, { name: 'Near', side, items: { 'mind rune': 60 } }, { name: 'Thin', side, items: { 'mind rune': 54 } }];
    const run = (extra: Partial<Inputs>) => plan(inputs([needy], { templates: strike(), army, ...extra }))[0]!;
    // Near holds 60 and keeps the band's 35: 25 spare covers the 20.
    expect(run({ stock }).send).toEqual({ from: 'Near', to: 'Needy', item: 'mind rune', count: 20, template: 'army-strike-magic-21' });
    // Thin holds 54: 19 spare is one short. Another side gives only to an account with no job it can start (live:
    // 13 of 14 accounts stood parked for another side's sends); with a coin job open the account keeps that.
    expect(run({ stock: [stock[0]!, stock[2]!] }).template!.id).toMatch(/^goldfarm@/);
    expect(run({ stock: [stock[0]!, stock[2]!], templates: bandOnly() }).send).toMatchObject({ from: 'Far' });
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

test('an army account with no other band to start buys the bones its Prayer still needs, dragon bones first, and buries them', () => {
    const army = new Set(['monk']);
    const bones: Market = { ...market, 'dragon bone': { id: 536, name: 'Dragon bones', limit: KIT_PRICE_CAPS['dragon bone']! }, 'big bone': { id: 532, name: 'Big bones', limit: KIT_PRICE_CAPS['big bone']! } };
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 90 };
    const kit = { shark: 40, 'adamant scimitar': 1 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Monk', { ...maxed, ...s }, { ...kit, ...items })], { army, market: bones, capacity: CAPACITY, ...extra }))[0]!;
    const order = (x: { template?: Template }) => x.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number));
    // What Prayer 90 still needs in dragon bones, and the 6 the trainer keeps.
    const need = BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(90)) / 1800);
    const rich = pick({}, { coin: 5_000_000 });
    expect(rich.template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    expect(order(rich)).toEqual([[536, need]]);
    // An account that cannot pay for all of it buys what it can pay for, with the kit reserve left.
    expect(order(pick({}, { coin: 1_700_398 }))).toEqual([[536, 169]]);
    // A buy for a later band comes before a donor's send for an earlier one: 63 bones held leave the held-bones band
    // 37 short, and another side has them, but the account buys its dragon bones. With no bones on the market the
    // donor sends.
    const donor: Stock[] = [{ name: 'Far', side: 'local', items: { bone: 500 } }], near = pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor });
    expect(near.template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    expect(order(near)).toEqual([[536, BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(97)) / 1800)]]);
    expect(near.send).toBeUndefined();
    const boneBands = catalogue().filter(t => /^army-bury-/.test(t.id));
    expect(pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor, market, templates: boneBands }).send).toEqual({ from: 'Far', to: 'Monk', item: 'bone', count: 37, template: 'army-bury-prayer-99' });
    // With a job it can start (the troopers' field, a coin job) it does not wait for another side.
    expect(pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor, market }).send).toBeUndefined();
    // An account with Ranged or Magic still to finish keeps BONE_PURSE back for their kits (Magic 92 here, with its
    // alchemy runes and feathers but no fire, and the Magic Guild shop taken, so it has no other band).
    const mage = { 'nature rune': 604, feather: 500 }, guildBusy = { capacity: { ...CAPACITY, 'shop:magic_guild': 0 } };
    expect(order(pick({ Magic: 92 }, { ...mage, coin: 830_492 }, guildBusy))).toEqual([[536, Math.floor((830_492 - BONE_PURSE - 1_000) / 10_000)]]);
    expect(pick({ Magic: 92 }, { ...mage, coin: BONE_PURSE + 100_000 }, guildBusy).template!.id).not.toBe(KIT_BUY + 'army-bury-dragon-99');
    // With the shop free it fetches its staff first, with nature runes or with none: the guild sells them too.
    expect(pick({ Magic: 92 }, { ...mage, coin: 830_492 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 92 }, { coin: 830_492 }).template!.id).toBe('army-staff-guild');
    // The listed bones finish about three accounts: one with Ranged or Magic under BONE_SKILL buys none, even with its
    // arrow shops taken and millions of coins, and does not bury a stack it happens to hold before those skills.
    const busyShops = { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0, 'shop:dargaud': 0, 'shop:lowe': 0 };
    const { 'bronze arrow': _arrow, 'nature rune': _nature, ...bonesOnly } = bones;
    expect(pick({ Ranged: BONE_SKILL - 1 }, { coin: 8_000_000, shortbow: 1 }, { capacity: busyShops, market: bonesOnly }).template!.id).toBe('army-trooper-prayer-99');
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000 }, { market: bonesOnly, ...guildBusy }).template!.id).toBe('army-trooper-prayer-99');
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000, 'dragon bone': 300 }, { market: bonesOnly, ...guildBusy }).template!.id).toBe('army-trooper-prayer-99');
    // With the Magic Guild free that account goes for its alchemy kit, still not for bones.
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000 }, { market: bonesOnly }).template!.id).toBe('army-staff-guild');
    // The buy replaces the Prayer filler while it runs, as any kit buy does.
    expect(pick({}, { coin: 5_000_000 }, { unfundable: new Set(['monk']), current: new Map([['monk', 'army-trooper-prayer-99']]) }).template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    // With the bones held, a part-filled order too, it buries them before anything else.
    const bury = pick({}, { coin: 1_000, 'dragon bone': BONE_START });
    expect(jobFor(bury, side)).toMatchObject({ script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_ID: '536', BONE_RESERVE: String(BONE_KEEP) }, repeat: true });
    // No dragon bones under the cap: big bones, sized by their own XP. Neither: the filler on the field.
    const { 'dragon bone': _, ...onlyBig } = bones;
    const big = pick({}, { coin: 5_000_000 }, { market: onlyBig });
    expect(big.template!.id).toBe(KIT_BUY + 'army-bury-big-99');
    expect(order(big)).toEqual([[532, BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(90)) / 375)]]);
    expect(pick({}, { coin: 5_000_000, 'big bone': 300 }, { market: onlyBig }).template!.id).toBe('army-bury-big-99');
    expect(pick({}, { coin: 5_000_000 }, { market }).template!.id).toBe('army-trooper-prayer-99');
    // An account with a band it can start keeps to it: bones are for the account that has only the filler left.
    expect(pick({ Defence: 80 }, { coin: 5_000_000 }).template!.id).toBe('army-trooper-defence-99');
    // Prayer 99 buys none.
    expect(pick({ Prayer: 99 }, { coin: 5_000_000 }).template?.id.startsWith(KIT_BUY)).not.toBe(true);
});

test('the alchemy band gets its feathers at Port Sarim, its fire runes at Aubury under Magic 66 and its staff at the Magic Guild from 66', () => {
    const army = new Set(['mage']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Prayer: 99, Magic: 21 };
    const base = { coin: 900_000, shark: 40, 'adamant scimitar': 1, 'nature rune': 1000 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Mage', { ...skills, ...s }, { ...base, ...items })], { army, market, capacity: CAPACITY, ...extra }))[0]!;
    const step = (profile: string, cap: number, items: string, target: number, spend: number) =>
        `scripts/shop-buyer.ts ${profile} ${cap} ITEMS=${items} STOCK_TARGET=${target} STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=${spend + 1000} COIN_RESERVE=500 MAX_SPEND=${spend}`;
    // No feathers: Port Sarim first.
    const feathers = pick({}, {});
    expect(feathers.template!.id).toBe('army-feathers-sarim');
    expect(jobFor(feathers, side)).toMatchObject({ script: 'scripts/chain.ts', args: [step('sarim', 3000, 'feather', FEATHER_STOCK, 10000)], env: { ROUNDS: '1' }, repeat: true, resources: ['shop:sarim'] });
    // Feathers held, no fire, under Magic 66: fire runes at Aubury.
    const fire = pick({}, { feather: 700 });
    expect(fire.template!.id).toBe('army-fire-aubury');
    expect(jobFor(fire, side)).toMatchObject({ args: [step('aubury', 3000, 'fire.rune', FIRE_STOCK, 9000)], resources: ['shop:aubury'] });
    // With the fire runes it casts; when they run under 250 at Magic 66 or more it goes to the Magic Guild.
    expect(pick({}, { feather: 700, 'fire rune': 500 }).template!.id).toBe('army-alch-magic-99');
    const guild = pick({ Magic: 66 }, { feather: 700, 'fire rune': 249 });
    expect(guild.template!.id).toBe('army-staff-guild');
    const runes = [step('magic_guild', 900, 'nature.rune', NATURE_STOCK, 45000), step('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)];
    expect(jobFor(guild, side)).toMatchObject({ args: [step('magic_guild', 1500, 'staff.of.fire', 1, 12000), step('magic_guild', 600, 'fire.rune', FIRE_STOCK, 9000), ...runes], resources: ['shop:magic_guild'] });
    // The guild's shelf is the whole kit from 66: an account with coins and no rune of the band goes there, not to
    // the market or to Port Sarim. Under 80,000 coins it does not.
    expect(pick({ Magic: 66 }, { 'nature rune': 0 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 66 }, {}).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 66 }, { 'nature rune': 0, coin: 79_999 }).template?.id).not.toBe('army-staff-guild');
    // With the guild's air runes it casts on them; with its fire and no nature runes left it goes back for runes only.
    const air = pick({ Magic: 66 }, { 'air rune': AIR_STOCK, 'staff of fire': 1 });
    expect(jobFor(air, side)).toMatchObject({ script: 'scripts/alch-train.ts', args: ['99', '5000'], env: { ALCH_ITEM: 'airrune' }, repeat: true });
    expect(air.template!.id).toBe('army-alch-air-magic-99');
    expect(pick({ Magic: 65 }, { 'air rune': AIR_STOCK, feather: 700, 'staff of fire': 1 }).template!.id).toBe('army-alch-magic-99');
    const top = pick({ Magic: 80 }, { 'nature rune': 49, 'air rune': 30, 'staff of fire': 1 });
    expect(top.template!.id).toBe('army-nature-guild');
    expect(jobFor(top, side)).toMatchObject({ args: runes, resources: ['shop:magic_guild'] });
    expect(pick({ Magic: 80 }, { 'nature rune': 49, 'air rune': 30 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 65 }, { feather: 700, 'fire rune': 249 }).template!.id).toBe('army-fire-aubury');
    expect(pick({ Magic: 66 }, { feather: 700, 'staff of fire': 1 }).template!.id).toBe('army-alch-magic-99');
    // The trips follow the kit buy: with no nature runes held none of them is given, and the buy leaves feathers and
    // fire to them.
    const none = pick({}, { 'nature rune': 0 });
    expect(none.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(none.template!.args!.map(a => a.match(/ITEM_ID=(\d+)/)![1])).toEqual(['561']);
    // Magic 99 needs none of it.
    expect(['army-feathers-sarim', 'army-fire-aubury', 'army-staff-guild', 'army-nature-guild', 'army-alch-air-magic-99']).not.toContain(pick({ Magic: 99 }, {}).template?.id);
});

test('an army account with no better blade buys one adamant scimitar before its Ranged and melee bands, two accounts at a time', () => {
    const army = new Set(['blade', 'edge', 'point']);
    const sold: Market = { ...market, 'adamant scimitar': { id: 1331, name: 'Adamant scimitar', limit: KIT_PRICE_CAPS['adamant scimitar']! } };
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 80, Hitpoints: 90, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { coin: 900_000, shark: 40, 'bronze sword': 1 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Blade', { ...skills, ...s }, items)], { army, market: sold, capacity: CAPACITY, ...extra }))[0]!;
    const buy = pick({}, kit);
    expect(buy.template!.id).toBe(KIT_BUY + WEAPON.id);
    expect(buy.template!.args).toEqual([`scripts/buy-owned-ge-item.ts ITEM_ID=1331 QUANTITY=1 LIMIT_PRICE=${KIT_PRICE_CAPS['adamant scimitar']} CASH_RESERVE=1000 ORDER_KEY=blade-kit0-1331-0to1 ORDER_MS=900000 FILL_WAIT_TICKS=200`]);
    expect(jobFor(buy, side)).toMatchObject({ script: 'scripts/chain.ts', repeat: false, resources: [WEAPON_MARKET] });
    // A later buy takes the account's next order key.
    expect(pick({}, kit, { kitSeq: new Map([['blade', 2]]) }).template!.args![0]).toContain('ORDER_KEY=blade-kit2-1331-0to1');
    // With an adamant or rune blade, worn or banked, it fights on.
    for (const blade of WEAPON_HELD) expect(pick({}, { ...kit, [blade]: 1 }).template!.id).toBe('army-trooper-defence-99');
    // Under Attack 30, short of coins, with no seller under the cap, or after the buy was retired: no buy.
    expect(pick({ Attack: 29 }, kit).template!.id).not.toBe(KIT_BUY + WEAPON.id);
    expect(pick({}, { ...kit, coin: KIT_PRICE_CAPS['adamant scimitar']! }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, kit, { market }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, kit, { retired: new Set([pairKey('Blade', KIT_BUY + WEAPON.id)]) }).template!.id).toBe('army-trooper-defence-99');
    // Every account gets one now: the buy comes before the Ranged band too, and before the Prayer filler.
    expect(pick({ Ranged: 30 }, { ...kit, shortbow: 1, 'iron arrow': 500 }).template!.id).toBe(KIT_BUY + WEAPON.id);
    expect(pick({ Ranged: 30 }, { ...kit, shortbow: 1, 'iron arrow': 500, 'adamant scimitar': 1 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Defence: 99, Prayer: 80 }, kit).template!.id).toBe(KIT_BUY + WEAPON.id);
    // Two accounts are away for it at a time; the third keeps its band.
    const three = ids(plan(inputs(['Blade', 'Edge', 'Point'].map(n => acct(n, skills, kit)), { army, market: sold, capacity: CAPACITY })));
    expect(Object.values(three).sort()).toEqual(['army-trooper-defence-99', KIT_BUY + WEAPON.id, KIT_BUY + WEAPON.id]);
    // An account outside the army is not armed.
    expect(plan(inputs([acct('Blade', skills, kit)], { army: new Set(['other']), market: sold, capacity: CAPACITY })).some(x => x.template?.id === KIT_BUY + WEAPON.id)).toBe(false);
});

test('with no fire on the market the alchemy kit buys its other lines, then the account buys a staff of fire at Zaff\'s', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99' || t.id === 'army-staff-zaff'), army = new Set(['rich']);
    // The staff job is a pilot: a plan names it to turn it on.
    const pilots = new Set(['army-staff-zaff']);
    const pick = (items: Record<string, number>, skills: Record<string, number> = { Magic: 30 }) => plan(inputs([mage('Rich', items, skills)], { templates, army, market, capacity: CAPACITY, pilots }))[0];
    // The market sells nature runes and no fire: the buy takes the nature runes and leaves the fire line to the shop job.
    const buy = pick({ coin: 5_000_000, feather: 500 })!;
    expect(buy.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).join('x'))).toEqual(['561x1000']);
    // With the nature runes and feathers held and no fire, the staff job; with a staff or 250 fire runes, the band.
    const held = { coin: 4_000_000, feather: 500, 'nature rune': 1000 };
    const shop = pick(held)!;
    expect(shop.template!.id).toBe('army-staff-zaff');
    expect(jobFor(shop, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['zaff', '3000'], repeat: true, resources: ['shop:zaff'],
        env: { ITEMS: 'staff of fire', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '1100' } });
    expect(pick({ ...held, 'fire rune': 249 })!.template!.id).toBe('army-staff-zaff');
    expect(pick({ ...held, 'staff of fire': 1 })!.template!.id).toBe('army-alch-magic-99');
    expect(pick({ ...held, 'mystic fire staff': 1 })!.template!.id).toBe('army-alch-magic-99');
    expect(pick({ ...held, 'fire rune': 250 })!.template!.id).toBe('army-alch-magic-99');
    // Under Magic 21, short of coins, or with nothing else of the kit held: no trip to the shop.
    expect(pick(held, { Magic: 20 })?.template?.id).not.toBe('army-staff-zaff');
    expect(pick({ ...held, coin: 14_000 })?.template?.id).not.toBe('army-staff-zaff');
    expect(pick({ coin: 4_000_000, feather: 500, 'nature rune': 49 })?.template?.id).not.toBe('army-staff-zaff');
    // Only the fire line is short and no market sells it: there is nothing to buy on the Grand Exchange.
    expect(plan(inputs([mage('Rich', { coin: 5_000, feather: 500, 'nature rune': 1000 }, { Magic: 30 })], { templates, army, market, capacity: CAPACITY, pilots }))
        .some(x => x.template?.id.startsWith(KIT_BUY))).toBe(false);
    // Unnamed, the staff job is not given.
    expect(plan(inputs([mage('Rich', held, { Magic: 30 })], { templates, army, market, capacity: CAPACITY })).some(x => x.template?.id === 'army-staff-zaff')).toBe(false);
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
    expect(aioIds).toEqual(['aio-flax', 'aio-bowstrings', 'aio-yews', 'aio-shafts', 'aio-ore', 'aio-essence', 'aio-air-runes', 'aio-runite-bars', 'aio-rune-scimitars', 'aio-quest-runemysteries']);
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
    // A fleet snapshot row lists the complete quests by name.
    expect([...accountFrom('S', side, { quests: ['Lost City', "Merlin's Crystal"], skills: [] }, () => undefined).quests!]).toEqual(['lost city', "merlin's crystal"]);
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
    expect(pick({ Thieving: 1 }, { bone: 63 }).template?.id).not.toBe('army-trooper-prayer-99');
    expect(pick({}, { bone: 63 }).template!.id).toBe('army-trooper-prayer-99');
    // An account with melee left takes its trooper band, never the filler.
    expect(pick({ Defence: 82 }, { shark: 30 }).template!.id).toBe('army-trooper-defence-99');
});

test('the Prayer filler waits behind a kit buy and gives way to one while it runs', () => {
    const army = new Set(['archer']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 87, Magic: 99, Prayer: 74 };
    const archer = acct('Archer', skills, { coin: 4_000_000, shark: 40, shortbow: 1 });
    // Its Ranged band lacks only arrows, and other accounts hold the arrow shops: the market buy comes before the filler.
    const capacity = { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0, 'shop:dargaud': 0, 'shop:lowe': 0 };
    expect(plan(inputs([archer], { army, market, capacity }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // The same while the filler is its running job: a kit buy replaces a filler, as it replaces a coin job.
    const busy = { army, market, capacity, unfundable: new Set(['archer']) };
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-prayer-99']]) }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // A band proper still keeps its place over a kit buy.
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-defence-99']]) }))[0]!.template!.id).not.toBe(KIT_BUY + 'army-trooper-ranged-99');
    // With no market for the arrows and the shops taken it fills the time on the field.
    expect(plan(inputs([archer], { army, capacity }))[0]!.template!.id).toBe('army-trooper-prayer-99');
});

test('an army account whose bow is short of arrows buys bronze arrows at the Ardougne shop, one account at a time', () => {
    const army = new Set(['archer', 'bowman']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 80, Hitpoints: 90, Ranged: 1, Magic: 99, Prayer: 99 };
    const kit = { coin: 800_000, shark: 40, shortbow: 1, 'bronze arrow': 25 };
    const pick = (s: Record<string, number>, items: Record<string, number>) => plan(inputs([acct('Archer', { ...skills, ...s }, items)], { army, capacity: CAPACITY }))[0]!;
    // The shop comes at the Ranged band, before the Defence troopers, with no market and no donor.
    const shop = pick({}, kit);
    expect(shop.template!.id).toBe('army-arrows-ardy');
    expect(jobFor(shop, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['ardy', '400'], repeat: true, resources: ['shop:ardy'],
        env: { ITEMS: 'bronze arrow', STOCK_TARGET: String(ARROW_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', COIN_RESERVE: '500', MAX_SPEND: '4000', FLOAT: '5000' } });
    // With ARROW_LOW arrows the bow fires, the account trains Ranged; iron arrows count as bronze do.
    expect(pick({}, { ...kit, 'bronze arrow': ARROW_LOW }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...kit, 'iron arrow': ARROW_LOW }).template!.id).toBe('army-trooper-ranged-99');
    // No bow, too few coins or Ranged 99: no shop run.
    expect(pick({}, { ...kit, shortbow: 0 }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, { ...kit, coin: 4_000 }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({ Ranged: 99 }, kit).template!.id).toBe('army-trooper-defence-99');
    // One account holds each shop: the second walks to Hickton's in Catherby, the third takes the ferries to Lowe's in
    // Varrock, and the fourth keeps its melee band until a shop is free.
    const names = ['Archer', 'Bowman', 'Crossbow', 'Dart'];
    const four = ids(plan(inputs(names.map(n => acct(n, skills, kit)), { army: new Set(names.map(n => n.toLowerCase())), capacity: CAPACITY })));
    expect(Object.values(four).sort()).toEqual(['army-arrows-ardy', 'army-arrows-catherby', 'army-arrows-lowe', 'army-trooper-defence-99']);
    const hickton = plan(inputs([acct('Archer', skills, kit)], { army, capacity: { ...CAPACITY, 'shop:ardy': 0 } }))[0]!;
    expect(jobFor(hickton, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['catherby_arrows', '600'], repeat: true, resources: ['shop:catherby_arrows'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0' } });
    // Arrows of any kind end the shop runs: steel arrows a shortbow cannot fire are a kit matter, not a reason to shop again.
    expect(pick({}, { ...kit, 'steel arrow': ARROW_LOW }).template!.id).toBe('army-trooper-defence-99');
    // From Ranged 40 an account short of arrows goes to the Ranging Guild before any other shop, for a willow shortbow
    // and arrows up to mithril; with arrows of any kind it trains, and under 40 it uses the other shops.
    const guild = pick({ Ranged: 40 }, kit);
    expect(guild.template!.id).toBe('army-arrows-guild');
    expect(jobFor(guild, side)).toMatchObject({ script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeat: true, resources: ['shop:dargaud'] });
    expect(jobFor(guild, side).args).toEqual([
        'scripts/shop-buyer.ts dargaud 800 ITEMS=willow.shortbow STOCK_TARGET=1 STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=4000 COIN_RESERVE=500 MAX_SPEND=3000',
        `scripts/shop-buyer.ts dargaud 800 ITEMS=mithril.arrow|steel.arrow|iron.arrow|bronze.arrow STOCK_TARGET=${ARROW_STOCK} STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=51000 COIN_RESERVE=500 MAX_SPEND=50000`]);
    expect(pick({ Ranged: 39 }, kit).template!.id).toBe('army-arrows-ardy');
    expect(pick({ Ranged: 40 }, { ...kit, 'bronze arrow': 500 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 40 }, { ...kit, 'willow shortbow': 1, 'mithril arrow': 500 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 40 }, { ...kit, coin: 59_000 }).template!.id).toBe('army-arrows-ardy');
    const lowe = plan(inputs([acct('Archer', skills, kit)], { army, capacity: { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0 } }))[0]!;
    expect(jobFor(lowe, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['lowe', '2500'], repeat: true, resources: ['shop:lowe'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0' } });
    // Lowe's trip needs more coins than Aemad's.
    expect(plan(inputs([acct('Archer', skills, { ...kit, coin: 24_000 })], { army, capacity: { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0 } }))[0]!.template!.id).toBe('army-trooper-defence-99');
    // A Grand Exchange buy that acquired its items made progress, however long the trip; one that acquired none did not.
    const trip = 'LEDGER ticks=1400 xp=0 inventory=8 move=600 anim=0 dialog=4 stun=0 idle=780';
    expect(assess([trip, 'RESULT ok {"ok":true,"phase":"settled","quantity":1000,"targetMet":true,"acquired":1000,"refund":554000}', 'RESULT ok chain rounds=1 ok=1 failed=0']).retire).toBe(false);
    expect(assess([trip, 'RESULT ok {"ok":true,"phase":"settled","quantity":1,"acquired":1,"cashDeltaThisSession":-72000}']).retire).toBe(false);
    expect(assess([trip, 'RESULT fail {"ok":false,"phase":"settled","quantity":50,"acquired":0,"refund":1000}']).reason).toMatch(/^tick waste/);
    // A shop run that bought arrows made progress; one that bought none on a long wait is retired as waste.
    const wait = 'LEDGER ticks=1000 xp=0 inventory=12 move=120 anim=0 dialog=0 stun=0 idle=868';
    expect(assess([wait, 'RESULT ok ticks=1000 boughtTotal=96 bankedTotal=96 stop=cap targetMet=0']).retire).toBe(false);
    expect(assess([wait, 'RESULT ok ticks=1000 boughtTotal=0 bankedTotal=0 stop=stock-wait targetMet=0']).reason).toMatch(/^tick waste 99%/);
});

test('a smith with runite ore and coal smelts bars, then smiths rune scimitars, once the plan admits the routes', () => {
    const gear = ['aio-runite-bars', 'aio-rune-scimitars'], gearPrices = { ...aioPrices, 'runite bar': 5000, 'rune scimitar': 25600, 'runite ore': 3200, coal: 45 };
    const run = (a: Acct, pilots = gear) => plan(aioInputs([a], pilots, { prices: gearPrices }))[0]!;
    const smith = (items: Record<string, number>, skills: Record<string, number> = { Smithing: 99 }) => acct('Smith', skills, items);
    // The PC smith's stock: 13 runite ore, a hammer, and coal once mined.
    expect(run(smith({ 'runite ore': 13, coal: 104, hammer: 1 })).template!.id).toBe('aio-runite-bars');
    expect(jobFor(run(smith({ 'runite ore': 13, coal: 104, hammer: 1 })), side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'smithing', 'smelt', '1500', 'runite', 'MAX_MAKE=28', 'ORE_RESERVE=0'] });
    // Without 8 coal a bar, under Smithing 85, or not admitted: no smelt.
    expect(run(smith({ 'runite ore': 13, coal: 15, hammer: 1 })).template).toBeUndefined();
    expect(run(smith({ 'runite ore': 13, coal: 104 }, { Smithing: 84 })).template).toBeUndefined();
    expect(run(smith({ 'runite ore': 13, coal: 104 }), []).template).toBeUndefined();
    // Bars banked: the anvil order, one blade a run, with the hammer and the toll.
    const bars = smith({ 'runite bar': 12, hammer: 1, coin: 5000 });
    expect(run(bars).template!.id).toBe('aio-rune-scimitars');
    expect(jobFor(run(bars), side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'] });
    expect(run(smith({ 'runite bar': 1, hammer: 1, coin: 5000 })).template).toBeUndefined();
    expect(run(smith({ 'runite bar': 12, coin: 5000 })).template).toBeUndefined();
    expect(run(smith({ 'runite bar': 12, hammer: 1, coin: 5000 }, { Smithing: 89 })).template).toBeUndefined();
});

import { LOST_CITY, LOST_CITY_MEALS, LOST_CITY_PLACES, QUEST_BAND } from '../src/autopilot';
test('an army account without Lost City takes the quest chain as a pilot, before Ranged, a few at a time', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 80, Magic: 99, Prayer: 77 };
    const kit = { shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, coin: 100_000 };
    const quests = (...done: string[]) => new Set(done.map(q => q.toLowerCase()));
    const soldier = (name: string, done: ReadonlySet<string> | undefined, s: Record<string, number> = {}, items: Record<string, number> = {}): Acct =>
        ({ ...acct(name, { ...maxed, ...s }, { ...kit, ...items }), ...(done ? { quests: done } : {}) });
    const pilots = new Set(['army-quest-lostcity']);
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, ...extra }));
    const [x] = run([soldier('Kilt', quests())]);
    expect(x!.template!.id).toBe('army-quest-lostcity');
    expect(x!.reason).toBe(`army band ${QUEST_BAND}: Lost City`);
    expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,zanaris'], repeat: false, resources: [LOST_CITY] });
    // Not a pilot the plan names: the account trains Ranged. The same with the quest done, an unknown quest list,
    // Prayer under Protect from Melee, or too few coins for the sweep's shop buys.
    const ranged = (accounts: Acct[], extra: Partial<Inputs> = {}) => run(accounts, extra)[0]!.template!.id;
    expect(ranged([soldier('Kilt', quests())], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests('Lost City'))])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', undefined)])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests(), { Prayer: 42 })])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests(), {}, { coin: 4_000 })])).toBe('army-trooper-ranged-99');
    // With too little of the food the quest eats, the band buys the cheapest of it first, as a candidate of its own:
    // the account could train Ranged, and still goes to the market. Sharks banked count as that food.
    const food: Market = { lobster: { id: 379, name: 'Lobster', limit: KIT_PRICE_CAPS.lobster! }, shark: { id: 385, name: 'Shark', limit: KIT_PRICE_CAPS.shark! } };
    const hungry = (items: Record<string, number>, extra: Partial<Inputs> = {}) => run([soldier('Kilt', quests(), {}, { shark: 0, trout: 200, ...items })], { market: food, ...extra })[0]!;
    const buy = hungry({});
    expect(buy.template!.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[379, LOST_CITY_MEALS]]);
    expect(buy.reason).toBe(`army band ${QUEST_BAND}: buys ${LOST_CITY_MEALS} Lobster for army-quest-lostcity, at most ${LOST_CITY_MEALS * KIT_PRICE_CAPS.lobster!} coins`);
    expect(hungry({ shark: 4 }).template!.args!.map(a => a.match(/QUANTITY=(\d+)/)![1])).toEqual([String(LOST_CITY_MEALS - 4)]);
    expect(hungry({ shark: LOST_CITY_MEALS }).template!.id).toBe('army-quest-lostcity');
    // No such food on the market, or a retired buy: the account trains on.
    expect(hungry({}, { market: {} }).template!.id).toBe('army-trooper-ranged-99');
    expect(hungry({}, { retired: new Set([pairKey('Kilt', KIT_BUY + 'army-quest-lostcity')]) }).template!.id).toBe('army-trooper-ranged-99');
    // LOST_CITY_PLACES accounts are away for it at a time; the rest keep training.
    const many = run(['A', 'B', 'C', 'D'].map(n => soldier(n, quests())));
    expect(many.filter(a => a.template!.id === 'army-quest-lostcity').length).toBe(LOST_CITY_PLACES);
    expect(many.filter(a => a.template!.id === 'army-trooper-ranged-99').length).toBe(4 - LOST_CITY_PLACES);
});

import { MAGIC_BAND, SPLASH_FENCE, SPLASH_KIT, SPLASH_PLACES, SPLASH_START, SPLASH_TO, splashKit } from '../src/autopilot';
test('an army account under the Magic Guild level buys curse runes, then water at the shop, then casts over the fence', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 80, Magic: 21, Prayer: 99 };
    const kit = { shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, coin: 500_000, 'mind rune': 15, 'air rune': 15 };
    const soldier = (name: string, items: Record<string, number> = {}, s: Record<string, number> = {}): Acct => acct(name, { ...maxed, ...s }, { ...kit, ...items });
    const pilots = new Set(['army-splash-magic-66', 'army-water-aubury']);
    const runes: Market = { 'body rune': { id: 559, name: 'Body rune', limit: KIT_PRICE_CAPS['body rune']! }, 'earth rune': { id: 557, name: 'Earth rune', limit: KIT_PRICE_CAPS['earth rune']! } };
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: runes, ...extra }));
    // What a level still casts: 135 curses from Magic 21, ten from Magic 65, the whole kit under Curse's level.
    const need = splashKit(21);
    expect(need).toEqual({ 'body rune': 135, 'earth rune': 405, 'water rune': 270 });
    expect(splashKit(65)).toEqual({ 'body rune': 10, 'earth rune': 30, 'water rune': 30 });
    expect(splashKit(1)).toEqual({ ...SPLASH_KIT });
    // With no runes: one buy of the body and earth runes its level still casts, as a candidate of the band (the
    // account could train Ranged). The water line is the shop job's and holds nothing back.
    const [buy] = run([soldier('Kilt', { 'body rune': 2, 'water rune': 6, 'earth rune': 4 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-splash-magic-66');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[559, need['body rune']! - 2], [557, need['earth rune']! - 4]]);
    // With water runes listed on the market the same buy takes them too.
    const wet = run([soldier('Kilt', { 'body rune': 2, 'water rune': 6, 'earth rune': 4 })], { market: { ...runes, 'water rune': { id: 555, name: 'Water rune', limit: KIT_PRICE_CAPS['water rune']! } } })[0]!;
    expect(wet.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number)).sort((x, y) => x[0]! - y[0]!)).toEqual([[555, need['water rune']! - 6], [557, need['earth rune']! - 4], [559, need['body rune']! - 2]]);
    // Part of a kit is enough to start: the band at once with 200 water runes at Magic 21, and with ten casts' runes
    // at Magic 65, not a shop run for the rest.
    const part = run([soldier('Kilt', { 'body rune': 150, 'earth rune': 425, 'water rune': 200 })], { pilots: new Set([...pilots, 'army-water-betty']) })[0]!;
    expect(part.template!.id).toBe('army-splash-magic-66');
    expect(run([soldier('Kilt', { 'body rune': 25, 'earth rune': 50, 'water rune': 50 }, { Magic: 65 })])[0]!.template!.id).toBe('army-splash-magic-66');
    // An account keeps the runes its own level still casts: one at Magic 21 gives none of its 270 water runes, one
    // past the band gives all.
    const own = (magic: number) => kitReserve(catalogue().filter(t => t.id === 'army-splash-magic-66'), acct('K', { Magic: magic }))['water rune'];
    expect([own(21), kitReserve(catalogue().filter(t => t.id === 'army-splash-magic-66'))['water rune']]).toEqual([270, SPLASH_START['water rune']]);
    // Holding those, short of the start's water: the shop run at Aubury's, up to the kit's water.
    const stocked = { 'body rune': SPLASH_KIT['body rune'], 'earth rune': SPLASH_KIT['earth rune'] };
    const [shop] = run([soldier('Kilt', { ...stocked, 'water rune': 6 })]);
    expect(shop!.template!.id).toBe('army-water-aubury');
    expect(jobFor(shop!, side)).toMatchObject({ script: 'scripts/chain.ts', resources: ['shop:aubury'] });
    expect(shop!.template!.args![0]).toContain(`scripts/shop-buyer.ts aubury 3000 ITEMS=water.rune STOCK_TARGET=${SPLASH_KIT['water rune']} `);
    // A second account short of water, or the first with Aubury's shop taken, goes to Betty's in Port Sarim.
    const two = run(['A', 'B'].map(n => soldier(n, { ...stocked, 'water rune': 6 })), { pilots: new Set([...pilots, 'army-water-betty']) });
    expect(two.map(a => a.template!.id).sort()).toEqual(['army-water-aubury', 'army-water-betty']);
    const betty = run([soldier('Kilt', { ...stocked, 'water rune': 6 })], { pilots: new Set([...pilots, 'army-water-betty']), capacity: { ...CAPACITY, 'shop:aubury': 0 } })[0]!;
    expect(jobFor(betty, side)).toMatchObject({ script: 'scripts/chain.ts', resources: ['shop:betty'] });
    expect(betty.template!.args![0]).toContain(`scripts/shop-buyer.ts betty 3000 ITEMS=water.rune STOCK_TARGET=${SPLASH_KIT['water rune']} `);
    // With the whole kit: the band, to the Magic Guild's level, on the fence tile.
    const full = { ...stocked, 'water rune': SPLASH_KIT['water rune'] };
    const [cast] = run([soldier('Kilt', full)]);
    expect(cast!.template!.id).toBe('army-splash-magic-66');
    expect(cast!.reason).toBe(`army band ${MAGIC_BAND}: Magic to ${SPLASH_TO}`);
    expect(jobFor(cast!, side)).toMatchObject({ script: 'scripts/splash-train.ts', args: [String(SPLASH_TO), '6000'], repeat: true, resources: [SPLASH_FENCE] });
    // A fresh account casts too: Wind Strike needs the two mind and air runes it holds.
    expect(run([soldier('Kilt', full, { Magic: 1 })])[0]!.template!.id).toBe('army-splash-magic-66');
    // At the level the band is done and the Magic Guild's shelf is next. With the pilot off, or with the buy retired
    // and no runes: Ranged.
    const ranged = (accounts: Acct[], extra: Partial<Inputs> = {}) => run(accounts, extra)[0]!.template!.id;
    expect(ranged([soldier('Kilt', full, { Magic: SPLASH_TO })])).toBe('army-staff-guild');
    expect(ranged([soldier('Kilt', full)], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt')], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt')], { retired: new Set([pairKey('Kilt', KIT_BUY + 'army-splash-magic-66')]) })).toBe('army-trooper-ranged-99');
    // An account in the middle of Lost City finishes the quest before the rune buy of the earlier band; one that has
    // not started the quest buys first.
    const questing: Acct = { ...soldier('Kilt'), quests: new Set<string>() }, both = new Set([...pilots, 'army-quest-lostcity']);
    expect(ranged([questing], { pilots: both, current: new Map([['kilt', 'army-quest-lostcity']]) })).toBe('army-quest-lostcity');
    expect(ranged([questing], { pilots: both })).toBe(KIT_BUY + 'army-splash-magic-66');
    // SPLASH_PLACES accounts cast at a time; the rest keep training.
    const many = run(['A', 'B', 'C', 'D'].map(n => soldier(n, full)));
    expect(many.filter(a => a.template!.id === 'army-splash-magic-66').length).toBe(SPLASH_PLACES);
    expect(many.filter(a => a.template!.id === 'army-trooper-ranged-99').length).toBe(4 - SPLASH_PLACES);
});

test('the kit tier uses this side\'s own stock first: a maxed account gives all it holds, and a send brings the batch', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { shark: 40, 'adamant scimitar': 1 };
    // Monk is at Prayer 97 with 6 dragon bones and too few coins for a buy; Done is maxed and holds 41.
    const monk = acct('Monk', { ...maxed, Prayer: 97 }, { ...kit, coin: 20_000, 'dragon bone': 6 });
    const done = acct('Done', maxed, { ...kit, 'dragon bone': 41, 'nature rune': 900 });
    const army = new Set(['monk', 'done', 'half']);
    const near: Stock = { name: 'Done', side, items: done.items }, other: Stock = { name: 'Far', side: 'local', items: { 'dragon bone': 500, coin: 9_000_000 } };
    const bones: Market = { ...market, 'dragon bone': { id: 536, name: 'Dragon bones', limit: KIT_PRICE_CAPS['dragon bone']! } };
    const run = (stock: Stock[], accounts: Acct[] = [monk, done], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army, market: bones, capacity: CAPACITY, stock, ...extra })).find(a => a.account === 'Monk')!;
    // The maxed account of this side keeps nothing: Monk gets every bone it holds, up to what Prayer 99 still needs,
    // in one send, though another side has more bones and the coins to fund a buy.
    const need = BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(97)) / 1800) - 6;
    expect(need).toBeGreaterThan(41);
    expect(run([other, near]).send).toEqual({ from: 'Done', to: 'Monk', item: 'dragon bone', count: 41, template: 'army-bury-dragon-99' });
    // A donor that holds more than the batch sends the batch.
    expect(run([{ ...near, items: { ...near.items, 'dragon bone': 400 } }], [monk, acct('Done', maxed, { ...kit, 'dragon bone': 400 })]).send).toMatchObject({ from: 'Done', count: need });
    // An account of this side outside the army keeps the reserve of every band: its levels say nothing here.
    const mule = (n: number): Stock => ({ name: 'Mule', side, items: { 'dragon bone': n } });
    expect(run([mule(BONE_START + 4)], [monk]).send).toBeUndefined();
    expect(run([mule(BONE_START + 10)], [monk]).send).toEqual({ from: 'Mule', to: 'Monk', item: 'dragon bone', count: 10, template: 'army-bury-dragon-99' });
    // With no stock on this side the other side's coins fund the buy, for an account with no job it can start.
    const boneBands = catalogue().filter(t => /^army-bury-/.test(t.id));
    const funded = run([other], [monk], { templates: boneBands });
    expect(funded.send).toBeUndefined();
    expect(funded.fund).toMatchObject({ from: 'Far', to: 'Monk' });
    expect(run([other], [monk]).fund).toBeUndefined();
    // And with no market for bones the other side sends what the band needs to start, not its whole stock.
    expect(run([other], [monk], { market, templates: boneBands }).send).toEqual({ from: 'Far', to: 'Monk', item: 'dragon bone', count: BONE_START - 6, template: 'army-bury-dragon-99' });
});

import { BLACK_CAVE, BLACK_CAVE_PLACES, HIDE_TARGET, HUNT_ARROWS, HUNT_ARROW_STOCK, HUNT_BAND, HUNT_FOOD, HUNT_KILLS, HUNT_RUNE_STOCK, bandLeft } from '../src/autopilot';
test('a maxed army account hunts black dragons for hides: the key first, the kit bought, two in the cave, and its kit is not spare stock', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, coin: 200_000 };
    const pilots = new Set(['army-hunt-black-dragons', 'army-dusty-key', 'army-hunt-supply']);
    const hunter = (name: string, items: Record<string, number> = kit, s: Record<string, number> = {}): Acct => acct(name, { ...maxed, ...s }, items);
    const caps: Market = Object.fromEntries([['iron arrow', 884, 'Iron arrow'], ['law rune', 563, 'Law rune'], ['magic shortbow', 861, 'Magic shortbow'], ['shark', 385, 'Shark'], ['air rune', 556, 'Air rune'], ['fire rune', 554, 'Fire rune']]
        .map(([k, id, name]) => [k, { id: id as number, name: name as string, limit: KIT_PRICE_CAPS[k as string]! }]));
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: caps, ...extra }));
    // With the kit: the trip, nine kills on iron arrows, in the cave.
    const [trip] = run([hunter('Kilt')]);
    expect(trip!.template!.id).toBe('army-hunt-black-dragons');
    expect(trip!.reason).toBe(`army band ${HUNT_BAND}: ${HIDE_TARGET} dragonhide`);
    expect(jobFor(trip!, side)).toMatchObject({ script: 'scripts/black-dragon-camp.ts', args: ['9000'], env: { KILLS: String(HUNT_KILLS), ARROW: 'iron_arrow', ARROWS: String(HUNT_ARROWS) }, repeat: true, resources: [BLACK_CAVE] });
    // Without the key: the key job, once; the key is not a market line and holds no buy back.
    const { 'dusty key': _key, ...keyless } = kit;
    const [key] = run([hunter('Kilt', keyless)]);
    expect(key!.template!.id).toBe('army-dusty-key');
    expect(jobFor(key!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], repeat: false });
    // Short of sharks: the market buy. Short of arrows after a trip: the shop run, though a market lists arrows.
    const [buy] = run([hunter('Kilt', { ...kit, shark: 1, 'iron arrow': 60 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-hunt-black-dragons');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[385, HUNT_FOOD - 1]]);
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })])[0]!.template!.id).toBe('army-hunt-supply');
    // No account is asked for the shop run's lines (live: a hunter with 123,028 coins stood waiting for 3 air runes
    // from another side). Short of sharks with no market for them: this side's donor at once, another side's only
    // when the account has no job of its own to start.
    const donors = (s: string) => [{ name: 'Giver', side: s, items: { 'air rune': 500, 'iron arrow': 5000, shark: 50 } }];
    const noRunes = hunter('Kilt', { ...kit, 'air rune': 0, 'iron arrow': 60 }), { shark: _shark, ...noSharks } = caps;
    for (const s of [side, 'local']) {
        const out = run([noRunes], { stock: donors(s) })[0]!;
        expect(out.template!.id).toBe('army-hunt-supply');
        expect(out.send).toBeUndefined();
    }
    const hungry = hunter('Kilt', { ...kit, shark: 1, 'iron arrow': 60 });
    expect(run([hungry], { market: noSharks, stock: donors(side) })[0]!.send).toMatchObject({ from: 'Giver', item: 'shark' });
    const first = run([hungry], { market: noSharks, stock: donors('local') })[0]!;
    expect(first.template!.id).toBe('army-hunt-supply');
    expect(first.send).toBeUndefined();
    const huntOnly = catalogue().filter(t => t.id === 'army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, shark: 1 })], { market: noSharks, stock: donors('local') })[0]!.send).toBeUndefined();
    expect(run([hunter('Kilt', { ...kit, shark: 1 })], { market: noSharks, stock: donors('local'), templates: huntOnly })[0]!.send).toMatchObject({ from: 'Giver', item: 'shark', count: HUNT_FOOD - 1 });
    // With no market for iron arrows: the shop run, arrows at Lowe's and then the teleport's runes at Aubury's.
    const { 'iron arrow': _arrows, 'fire rune': _fire, ...noShopLines } = caps;
    const [shop] = run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: noShopLines });
    expect(shop!.template!.id).toBe('army-hunt-supply');
    const job = jobFor(shop!, side);
    expect(job).toMatchObject({ script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeat: true, resources: ['shop:lowe', 'shop:aubury'] });
    expect(job.args![0]).toContain(`scripts/shop-buyer.ts lowe 2500 ITEMS=iron.arrow|bronze.arrow STOCK_TARGET=${HUNT_ARROW_STOCK} `);
    expect(job.args![1]).toContain(`scripts/shop-buyer.ts aubury 800 ITEMS=air.rune|fire.rune STOCK_TARGET=${HUNT_RUNE_STOCK} `);
    // Each step leaves a shelf it has emptied: its wait is under the shelves' restock intervals (10 ticks the least).
    expect(job.args!.map(a => Number(a.match(/NO_BUY_TICKS=(\d+)/)![1]))).toEqual([8, 8]);
    // With a trip's bronze arrows and too few iron: the same trip on bronze, before another shop run. Iron first
    // when both are held. A market that lists bronze arrows does not make them a kit buy.
    const withBronze = new Set([...pilots, 'army-hunt-black-dragons-bronze']);
    const bronze = run([hunter('Kilt', { ...kit, 'iron arrow': 60, 'bronze arrow': HUNT_ARROWS })], { market: noShopLines, pilots: withBronze })[0]!;
    expect(bronze.template!.id).toBe('army-hunt-black-dragons-bronze');
    expect(jobFor(bronze, side)).toMatchObject({ script: 'scripts/black-dragon-camp.ts', env: { KILLS: String(HUNT_KILLS), ARROW: 'bronze_arrow', ARROWS: String(HUNT_ARROWS) }, resources: [BLACK_CAVE] });
    expect(run([hunter('Kilt', { ...kit, 'bronze arrow': HUNT_ARROWS })], { market: noShopLines, pilots: withBronze })[0]!.template!.id).toBe('army-hunt-black-dragons');
    const bronzeListed: Market = { ...noShopLines, 'bronze arrow': { id: 882, name: 'Bronze arrow', limit: KIT_PRICE_CAPS['bronze arrow']! } };
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: bronzeListed, pilots: withBronze })[0]!.template!.id).toBe('army-hunt-supply');
    // The two variants share the cave's two places.
    expect(run(['A', 'B', 'C'].map(n => hunter(n, { ...kit, 'bronze arrow': HUNT_ARROWS, 'iron arrow': n === 'A' ? HUNT_ARROWS : 0 })), { market: noShopLines, pilots: withBronze }).filter(a => /^army-hunt-black-dragons/.test(a.template?.id ?? '')).length).toBe(BLACK_CAVE_PLACES);
    // The same for a teleport's fire rune alone; a full kit hunts, and the run ends with the hunt.
    expect(run([hunter('Kilt', { ...kit, 'fire rune': 0 })], { market: noShopLines })[0]!.template!.id).toBe('army-hunt-supply');
    expect(run([hunter('Kilt')], { market: noShopLines })[0]!.template!.id).toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60, dragonhide: HIDE_TARGET })], { market: noShopLines })[0]!.template?.id).not.toBe('army-hunt-supply');
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: noShopLines, pilots: new Set(['army-hunt-black-dragons']) })[0]!.template?.id).not.toBe('army-hunt-supply');
    // The band stands down at its hides, is off without the pilot, and is not for an account with training left.
    expect(bandLeft(trip!.template!, hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET - 3 }))).toBe(3);
    expect(run([hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET })])[0]!.template?.id).not.toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt')], { pilots: new Set() })[0]!.template?.id).not.toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, shortbow: 1, 'bronze arrow': 500 }, { Ranged: 95 })])[0]!.template!.id).toBe('army-trooper-ranged-99');
    // Two hunters at a time.
    expect(run(['A', 'B', 'C'].map(n => hunter(n))).filter(a => a.template?.id === 'army-hunt-black-dragons').length).toBe(BLACK_CAVE_PLACES);
    // A hunter between trips is a free maxed account, and still keeps its kit: a Prayer account that lacks sharks
    // for nothing of its own gets none of the hunter's six, and gets its spare dragon bones.
    const monk = acct('Monk', { ...maxed, Prayer: 97 }, { 'adamant scimitar': 1, coin: 20_000, 'dragon bone': 6 });
    const idle = hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET - 1, 'dragon bone': 30 });
    const sent = plan(inputs([monk, idle], { army: new Set(['monk', 'kilt']), capacity: { ...CAPACITY, [BLACK_CAVE]: 0 }, pilots, market: caps, stock: [{ name: 'Kilt', side, items: idle.items }] })).find(a => a.account === 'Monk')!;
    expect(sent.send).toMatchObject({ from: 'Kilt', item: 'dragon bone', count: 30 });
});

import { ARMOUR_SETS, FLAX_SPIN, LEATHER_LEVEL, SET_HIDES, SET_SHOP, TAN_COIN } from '../src/autopilot';
test('a hunter makes its hides into armour: flax to Crafting 84 when it cannot hunt, then whole sets, and no flax or hide is traded for it', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, coin: 200_000 };
    const pilots = new Set(['army-hunt-black-dragons', 'army-dusty-key', 'army-hunt-supply', 'army-black-dhide-sets', 'army-leather-flax', 'army-leather-spin']);
    const hunter = (name: string, items: Record<string, number>, crafting: number): Acct => acct(name, { ...maxed, Crafting: crafting }, { ...kit, ...items });
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: {}, ...extra }));
    const first = (a: Acct, extra: Partial<Inputs> = {}) => run([a], extra)[0]!;
    // With arrows it hunts, whatever its Crafting.
    expect(first(hunter('Kilt', { dragonhide: 9 }, 54)).template!.id).toBe('army-hunt-black-dragons');
    // Short of arrows and under Crafting 84: flax first, then the wheel once a run's flax is banked; before the shop.
    const flax = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9 }, 54));
    expect(flax.template!.id).toBe('army-leather-flax');
    expect(flax.reason).toBe(`army band ${HUNT_BAND + 0.2}: Crafting to ${LEATHER_LEVEL}`);
    expect(jobFor(flax, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'], repeat: true });
    const spin = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9, flax: FLAX_SPIN }, 54));
    expect(spin.template!.id).toBe('army-leather-spin');
    expect(jobFor(spin, side).args).toEqual(['skiller', 'crafting', 'bowstrings', '2500', `MAX_MAKE=${FLAX_SPIN}`, 'RAW_RESERVE=0', 'MAX_TRIPS=8']);
    // Under the wheel's Crafting 10 the band is not for it: the shop run.
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9 }, 9)).template!.id).toBe('army-hunt-supply');
    // At Crafting 84 with a set's hides: the sets, before the shop; with fewer hides, or its bodies made, the shop.
    const sets = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES }, LEATHER_LEVEL));
    expect(sets.template!.id).toBe('army-black-dhide-sets');
    expect(sets.reason).toBe(`army band ${HUNT_BAND + 0.1}: ${ARMOUR_SETS} dragonhide body`);
    expect(jobFor(sets, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'crafting', 'black-dhide-sets'], repeat: true });
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES - 1 }, LEATHER_LEVEL)).template!.id).toBe('army-hunt-supply');
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES, 'dragonhide body': ARMOUR_SETS }, LEATHER_LEVEL)).template!.id).toBe('army-hunt-supply');
    expect(catalogue().find(t => t.id === 'army-black-dhide-sets')!.needs!.items!.coins).toBe(SET_HIDES * TAN_COIN + SET_SHOP);
    // One account in the flax field: the second, short of arrows too, takes the shop run.
    const pair = run([hunter('Kilt', { 'iron arrow': 40 }, 54), hunter('Snake', { 'iron arrow': 40 }, 54)]);
    expect(pair.map(a => a.template!.id).sort()).toEqual(['army-hunt-supply', 'army-leather-flax']);
    // No trade for the band's flax or for a set's hides: an account with flax to spare and hides to spare gives none.
    const rich = { name: 'Rich', side, items: { flax: 2000, dragonhide: 40 } }, far = { name: 'Far', side: 'local', items: { flax: 2000, dragonhide: 40 } };
    for (const a of [hunter('Kilt', { 'iron arrow': 40 }, 54), hunter('Kilt', { 'iron arrow': 40, dragonhide: 2 }, LEATHER_LEVEL)]) {
        const out = first(a, { stock: [rich, far] });
        expect(out.send).toBeUndefined();
    }
});

import { JAKUT_CAP, JAKUT_COINS, JAKUT_RESERVE, JAKUT_SWORDS, JAKUT_WAIT } from '../src/autopilot';
test('an account with Lost City buys its dragon longswords from Jakut: the diamond on the market first, then one visit', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const done = new Set(['lost city']), pilots = new Set(['army-jakut-swords']);
    const diamond: Market = { diamond: { id: 1601, name: 'Diamond', limit: KIT_PRICE_CAPS.diamond! } };
    const who = (items: Record<string, number>, quests: ReadonlySet<string> | undefined = done): Acct => ({ ...acct('Snake', maxed, { 'dramen staff': 1, coin: 900_000, ...items }), ...(quests ? { quests } : {}) });
    const first = (a: Acct, extra: Partial<Inputs> = {}) => plan(inputs([a], { army: new Set(['snake']), capacity: CAPACITY, pilots, market: diamond, ...extra }))[0]!;
    // No diamond: the market buy of one, under its cap.
    const buy = first(who({}));
    expect(buy.template!.id).toBe(KIT_BUY + 'army-jakut-swords');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+) .*LIMIT_PRICE=(\d+)/)!.slice(1).map(Number))).toEqual([[1601, 1, 150_000]]);
    // With the diamond: the visit by the shop run, two swords, a buy request each tick on a shelf other players
    // empty, the coins of two units of an emptied shelf over the run's reserve.
    const visit = first(who({ diamond: 1 }));
    expect(visit.template!.id).toBe('army-jakut-swords');
    expect(visit.reason).toBe(`army band ${HUNT_BAND + 0.05}: 1 dragon longsword`);
    expect(jobFor(visit, side)).toMatchObject({ script: 'scripts/chain.ts', repeat: false, resources: ['shop:jukat'],
        args: [`scripts/shop-buyer.ts jukat ${JAKUT_CAP} BLIND_BUY=1 STOCK_TARGET=${JAKUT_SWORDS} STOP_AT_TARGET=1 BANK_AT=0 NO_BUY_TICKS=${JAKUT_WAIT} STALL_TICKS=0 COIN_RESERVE=${JAKUT_RESERVE} FLOAT=${JAKUT_COINS}`] });
    expect(catalogue().find(t => t.id === 'army-jakut-swords')!.needs!.items!.coins).toBe(JAKUT_COINS);
    expect(JAKUT_COINS - JAKUT_RESERVE).toBeGreaterThanOrEqual(JAKUT_SWORDS * 101_000);
    expect(JAKUT_WAIT).toBeGreaterThan(500);
    // One account at the shelf at a time.
    const pair = plan(inputs([who({ diamond: 1 }), { ...who({ diamond: 1 }), name: 'Adder' }], { army: new Set(['snake', 'adder']), capacity: CAPACITY, pilots, market: diamond }));
    expect(pair.filter(a => a.template?.id === 'army-jakut-swords').length).toBe(1);
    // Not with a sword held (one more would cost a second diamond), not without the quest, not without the pilot.
    expect(first(who({ diamond: 1, 'dragon longsword': 1 })).template?.id).not.toBe('army-jakut-swords');
    expect(first(who({ diamond: 1 }, new Set())).template?.id).not.toBe('army-jakut-swords');
    expect(first(who({ diamond: 1 }), { pilots: new Set() }).template?.id).not.toBe('army-jakut-swords');
    // A hunter with arrows hunts first; short of arrows it goes to Jakut before the shop run.
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, diamond: 1 };
    const both = new Set(['army-jakut-swords', 'army-hunt-black-dragons', 'army-hunt-supply']);
    expect(first(who(kit), { pilots: both }).template!.id).toBe('army-hunt-black-dragons');
    expect(first(who({ ...kit, 'iron arrow': 40 }), { pilots: both }).template!.id).toBe('army-jakut-swords');
});

import { GRAIL_BAND, GRAIL_MEALS, GRAIL_PLACE, GRAIL_RUNES } from '../src/autopilot';
test('an army account takes Merlin\'s Crystal and Holy Grail for its Prayer: the runes bought first, one account at a time', () => {
    const base = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 78 };
    const kit = { 'rune scimitar': 1, shark: 40, coin: 300_000, 'law rune': 12, 'air rune': 46, 'water rune': 6, 'fire rune': 1 };
    const pilots = new Set(['army-quest-holygrail']), done = (...q: string[]) => new Set(q.map(n => n.toLowerCase()));
    const who = (name: string, items: Record<string, number> = kit, s: Record<string, number> = {}, quests: ReadonlySet<string> = done('Lost City')): Acct => ({ ...acct(name, { ...base, ...s }, items), quests });
    const runes: Market = Object.fromEntries([['law rune', 563, 'Law rune'], ['air rune', 556, 'Air rune'], ['water rune', 555, 'Water rune'], ['fire rune', 554, 'Fire rune']]
        .map(([k, id, name]) => [k, { id: id as number, name: name as string, limit: KIT_PRICE_CAPS[k as string]! }]));
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: runes, ...extra }));
    // With the kit: the chain of the two quests.
    const [x] = run([who('Monk')]);
    expect(x!.template!.id).toBe('army-quest-holygrail');
    expect(x!.reason).toBe(`army band ${GRAIL_BAND}: Holy Grail`);
    expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'chain', 'merlin,grail'], repeat: false, resources: [GRAIL_PLACE] });
    expect(catalogue().find(t => t.id === 'army-quest-holygrail')!.needs).toMatchObject({ items: { 'rune scimitar': 1, ...GRAIL_RUNES }, pieces: { count: GRAIL_MEALS } });
    // Short of the teleports' law runes: the band's own buy, of what is short.
    const [buy] = run([who('Monk', { ...kit, 'law rune': 2 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-quest-holygrail');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[563, 10]]);
    // One account in Camelot's fights at a time.
    expect(run([who('A'), who('B')]).filter(a => a.template?.id === 'army-quest-holygrail').length).toBe(1);
    // Not once the quest is done, not under the Magic the Camelot teleport asks, not without the pilot.
    expect(run([who('Monk', kit, {}, done('Lost City', "Merlin's Crystal", 'Holy Grail'))])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk', kit, { Magic: 40 })])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk')], { pilots: new Set() })[0]!.template?.id).not.toBe('army-quest-holygrail');
    // Not at Prayer 99, with the kit or short of it: the quests pay a maxed account nothing.
    expect(run([who('Monk', kit, { Prayer: 99 })])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk', { ...kit, 'law rune': 2 }, { Prayer: 99 })])[0]!.template?.id).not.toBe(KIT_BUY + 'army-quest-holygrail');
});


test('an account with a PK build trains to the levels of the build and no further', async () => {
    const { buildBand, catalogue: all } = await import('../src/autopilot');
    const dragon = { Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, pure = { ...dragon, Defence: 1, Prayer: 1 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!;
    const fresh = acct('Build', { Attack: 1, Strength: 1, Defence: 1 });
    // No build: the band as listed. A skill at its level: no band. Defence 1 never trains Defence.
    expect(buildBand(byId('army-cow-defence-45'), fresh)).toBe(byId('army-cow-defence-45'));
    expect(buildBand(byId('army-cow-defence-45'), fresh, pure)).toBeNull();
    expect(buildBand(byId('army-cow-attack-45'), acct('Build', { Attack: 60 }), dragon)).toBeNull();
    // A cow band stops at its own end, and the trooper band at the level of the build.
    expect(buildBand(byId('army-cow-defence-45'), fresh, dragon)!.env!.TARGET_LEVEL).toBe('45');
    const trooper = buildBand(byId('army-trooper-defence-99'), acct('Build', { Defence: 55 }), dragon)!;
    expect(trooper.env!.TARGET_LEVEL).toBe('60');
    expect(trooper.trains!.to).toBe(60);
    expect(buildBand(byId('army-trooper-strength-99'), fresh, dragon)!.env!.TARGET_LEVEL).toBe('99');
    // No band buries bones: bones give Prayer XP. The Prayer band of the trooper field counts kills and keeps the
    // style of the account, so it is refused even for a build with Prayer above the account's level.
    expect(byId('army-trooper-ranged-99').env!.GIANT_BURY).toBe('1');
    expect(buildBand(byId('army-trooper-ranged-99'), fresh, pure)!.env!.GIANT_BURY).toBe('0');
    expect(trooper.env!.GIANT_BURY).toBe('0');
    expect(buildBand(byId('army-trooper-prayer-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    // Prayer comes from held normal bones only, to the level of the build: the worker's target argument.
    const bury = buildBand(byId('army-bury-prayer-99'), acct('Build', { Prayer: 20 }), dragon)!;
    expect(bury.args).toEqual(['43']); expect(bury.trains!.to).toBe(43); expect(bury.env!.BURY_HELD).toBe('1');
    expect(buildBand(byId('army-bury-prayer-99'), acct('Build', { Prayer: 43 }), dragon)).toBeNull();
    expect(buildBand(byId('army-bury-prayer-99'), fresh, pure)).toBeNull();
    expect(buildBand(byId('army-bury-dragon-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    expect(buildBand(byId('army-bury-big-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    for (const t of templates.filter(t => t.tier === 'goal')) for (const build of [pure, dragon]) {
        const got = buildBand(t, fresh, build);
        if (got?.script === 'scripts/gather-combat.ts') { expect(got.env!.GIANT_BURY).toBe('0'); expect(got.env!.GIANT_KILLS).toBeUndefined(); expect(got.env!.TRAIN_SKILL).toBe(got.trains!.skill); }
    }
    // A band of another script that ends above the level, a quest band and a stock band are refused.
    for (const t of templates.filter(t => t.tier === 'goal')) {
        const got = buildBand(t, fresh, pure);
        if (t.quest || t.stock || t.trains?.skill === 'Defence' || t.trains?.skill === 'Prayer') expect(got).toBeNull();
        if (got && got.trains && pure[got.trains.skill as keyof typeof pure] !== undefined) expect(got.trains.to).toBeLessThanOrEqual(pure[got.trains.skill as keyof typeof pure]);
    }
    // In a plan: the build account gets no Defence band, the plain army account does.
    const melee = { Attack: 45, Strength: 45, Defence: 1, Hitpoints: 40 }, kit = { 'bronze sword': 1, 'wooden shield': 1, trout: 30 };
    const army = new Set(['build', 'plain']);
    const planned = plan(inputs([acct('Build', melee, kit), acct('Plain', melee, kit)], { army, builds: new Map([['build', pure]]), capacity: CAPACITY }));
    const of = (name: string) => planned.find(x => x.account === name)?.template;
    expect(of('Plain')?.trains?.skill).toBe('Defence');
    expect(of('Build')?.trains?.skill).not.toBe('Defence');
    if (of('Build')?.script === 'scripts/gather-combat.ts') expect(Number(of('Build')!.env!.TARGET_LEVEL)).toBeLessThanOrEqual(99);
});

test('a build with a Fremennik helm takes The Fremennik Trials under its levels before the quest, and trains to them first', async () => {
    const { buildBand, catalogue: all, FREMENNIK, FREMENNIK_BAND } = await import('../src/autopilot');
    const tank = { Attack: 74, Strength: 73, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, before = { Attack: 68, Strength: 61, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!, band = byId('army-quest-fremennik'), route = ['The Fremennik Trials'];
    expect(band).toMatchObject({ buildOnly: true, pilot: true, band: FREMENNIK_BAND, resources: [FREMENNIK], args: ['quester', 'chain', 'drunkmonk,murder,viking'] });
    const ready = { ...acct('Tank', { Attack: 68, Strength: 61, Defence: 1, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 96, Fletching: 25 }), quests: new Set<string>() };
    // No build: an army account never takes the band. A build with the route: at or under the levels before it.
    expect(buildBand(band, ready)).toBeNull();
    expect(buildBand(band, ready, tank, route, before)).toBe(band);
    expect(buildBand(band, ready, tank, [], before)).toBeNull();
    // One level over a level before the route: the reward would end over the build. Hitpoints are not a limit.
    expect(buildBand(band, { ...ready, skills: { ...ready.skills, Attack: 69 } }, tank, route, before)).toBeNull();
    expect(buildBand(band, { ...ready, skills: { ...ready.skills, Defence: 8 } }, tank, route, before)).toBeNull();
    // While the quest is open a training band stops at the level before the route; with the quest done, at the build.
    const low = { ...ready, skills: { ...ready.skills, Attack: 50, Strength: 50 } };
    expect(buildBand(byId('army-trooper-attack-99'), low, tank, route, before)!.env!.TARGET_LEVEL).toBe('68');
    expect(buildBand(byId('army-trooper-strength-99'), low, tank, route, before)!.env!.TARGET_LEVEL).toBe('61');
    expect(buildBand(byId('army-trooper-attack-99'), ready, tank, route, before)).toBeNull();
    expect(buildBand(byId('army-cow-defence-45'), ready, tank, route, before)!.env!.TARGET_LEVEL).toBe('7');
    const done = { ...low, quests: new Set(['the fremennik trial']) };
    expect(buildBand(byId('army-trooper-attack-99'), done, tank, route, before)!.env!.TARGET_LEVEL).toBe('74');
    // In a plan: the build account with the levels, the coins and the meals is a candidate; a plain army account is not.
    const who = (name: string) => ({ ...acct(name, { ...ready.skills, Hitpoints: 94 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set(['lost city']) });
    const run = (extra: Partial<Inputs>) => plan(inputs([who('Tank')], { army: new Set(['tank']), pilots: new Set(['army-quest-fremennik']), capacity: CAPACITY, ...extra }))[0]!.template?.id;
    expect(run({ builds: new Map([['tank', tank]]), buildQuests: new Map([['tank', route]]), buildBefore: new Map([['tank', before]]) })).toBe('army-quest-fremennik');
    expect(run({})).not.toBe('army-quest-fremennik');
    expect(CAPACITY[FREMENNIK]).toBe(1);
    // The Berserker helm build goes with Attack 7 and Strength 99; an account with neither set of levels does not.
    const zerk = { Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, zBefore = { Attack: 7, Strength: 99, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 99 };
    const z = (strength: number) => ({ ...acct('Zerk', { Attack: 7, Strength: strength, Defence: 1, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94, Fletching: 25 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set(['lost city']) });
    const zrun = (strength: number) => plan(inputs([z(strength)], { army: new Set(['zerk']), pilots: new Set(['army-quest-fremennik']), capacity: CAPACITY,
        builds: new Map([['zerk', zerk]]), buildQuests: new Map([['zerk', ['Lost City', 'The Fremennik Trials']]]), buildBefore: new Map([['zerk', zBefore]]) }))[0]!.template?.id;
    expect(zrun(99)).toBe('army-quest-fremennik');
    expect(zrun(80)).not.toBe('army-quest-fremennik');
});

test('a build with The Fremennik Trials on its route makes headless arrows to Fletching 25 before the quest', async () => {
    const { buildBand, catalogue: all, FLETCH_MAKE, FLETCH_KEEP, FREMENNIK_BAND, ARMY_BANK } = await import('../src/autopilot');
    const { xpForLevel } = await import('../src/curve');
    const tank = { Attack: 74, Strength: 73, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, before = { Attack: 68, Strength: 60, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94 };
    const templates = all(), band = templates.find(t => t.id === 'army-fletch-25')!, route = ['The Fremennik Trials'];
    expect(band).toMatchObject({ buildOnly: true, pilot: true, route: 'The Fremennik Trials', script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeats: false, trains: { skill: 'Fletching', to: 25, unlocks: ['army-quest-fremennik'] } });
    expect(band.band!).toBeLessThan(FREMENNIK_BAND);
    expect(band.args).toEqual([`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, 'scripts/fletch-arrows.ts 3000 headless MAX_MAKE=210 SHAFT_RESERVE=100 FEATHER_RESERVE=100 BANK_PACK=1']);
    // 25 XP an arrow at the server's rate reaches level 25 from level 1; the worker makes sets of 15 and keeps 100.
    expect(FLETCH_MAKE * 25).toBeGreaterThanOrEqual(xpForLevel(25));
    expect(FLETCH_MAKE % 15).toBe(0);
    expect(band.needs).toEqual({ items: { 'arrow shaft': FLETCH_MAKE + FLETCH_KEEP, feather: FLETCH_MAKE + FLETCH_KEEP } });
    const a = { ...acct('Tank', { Attack: 68, Strength: 60, Prayer: 43, Hitpoints: 94 }), quests: new Set<string>() };
    // Only a build with the quest on its route and open: not a plain army account, not another build, not after the quest.
    expect(buildBand(band, a)).toBeNull();
    expect(buildBand(band, a, tank, route, before)).toBe(band);
    expect(buildBand(band, a, tank, ['Lost City'], before)).toBeNull();
    expect(buildBand(band, { ...a, quests: new Set(['the fremennik trial']) }, tank, route, before)).toBeNull();
    // In a plan: with the shafts and the feathers the account takes the band; at Fletching 25 it does not.
    const who = (fletching: number) => ({ ...acct('Tank', { ...a.skills, Ranged: 99, Magic: 99, Fletching: fletching }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, 'arrow shaft': 310, feather: 310 }), quests: new Set(['lost city']) });
    const run = (fletching: number) => plan(inputs([who(fletching)], { army: new Set(['tank']), pilots: new Set(['army-fletch-25', 'army-quest-fremennik']), capacity: CAPACITY,
        builds: new Map([['tank', tank]]), buildQuests: new Map([['tank', route]]), buildBefore: new Map([['tank', before]]) }))[0]!.template?.id;
    expect(run(1)).toBe('army-fletch-25');
    expect(run(25)).toBe('army-quest-fremennik');
});

test('a Defence 1 build buys the two prayer potions of Lost City on the Grand Exchange', async () => {
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43 };
    const who = (items: Record<string, number>) => ({ ...acct('Pure', { Attack: 60, Strength: 99, Ranged: 99, Prayer: 43, Hitpoints: 93 }, { coin: 600_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, ...items }), quests: new Set<string>() });
    const market: Market = { 'prayer potion(4)': { id: 2434, name: 'Prayer potion(4)', limit: KIT_PRICE_CAPS['prayer potion(4)']! } };
    const run = (items: Record<string, number>, extra: Partial<Inputs> = {}) => plan(inputs([who(items)], { army: new Set(['pure']), pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY,
        builds: new Map([['pure', pure]]), buildQuests: new Map([['pure', ['Lost City']]]), buildBefore: new Map([['pure', pure]]), market, ...extra }))[0]!;
    // No potion held: one order of two, at the cap. With the potions: the quest. With no listing: no quest and no buy.
    const buy = run({});
    expect(buy.template!.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+) .*LIMIT_PRICE=(\d+)/)!.slice(1).map(Number))).toEqual([[2434, 2, 260_000]]);
    expect(run({ 'prayer potion(4)': 2 }).template!.id).toBe('army-quest-lostcity');
    expect(run({}, { market: {} }).template?.id).not.toBe(KIT_BUY + 'army-quest-lostcity');
    expect(run({}, { market: {} }).template?.id).not.toBe('army-quest-lostcity');
});

test('an account with a PK build takes a quest band only on the quest route of its kit', async () => {
    const { buildBand, BUILD_QUESTS, catalogue: all } = await import('../src/autopilot');
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!, fresh = acct('Build', { Attack: 1 });
    const lostCity = byId('army-quest-lostcity'), grail = byId('army-quest-holygrail');
    // The route table: Lost City for a build with a dragon dagger, The Fremennik Trials for the Archer helm, no quest
    // for a build whose gear needs none.
    expect(BUILD_QUESTS).toMatchObject({ 'pure-pray': ['Lost City'], 'baby-pure': [], dragon: ['Lost City'], 'tank-range': ['The Fremennik Trials'] });
    // On the route: the band as listed. Off the route, with an empty route or with none: refused.
    expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS['pure-pray'])).toBe(lostCity);
    expect(buildBand(grail, fresh, pure, BUILD_QUESTS['pure-pray'])).toBeNull();
    for (const kit of ['baby-pure', 'tank-range', 'pure-ranger']) expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS[kit])).toBeNull();
    expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS.dragon)).toBe(lostCity);
    expect(buildBand(lostCity, fresh, pure)).toBeNull();
    // A route changes no other band: every band that is not a quest gets the same answer with it and without it.
    for (const t of templates.filter(t => t.tier === 'goal' && !t.quest)) expect(buildBand(t, fresh, pure, ['Lost City'])).toEqual(buildBand(t, fresh, pure));
    for (const t of templates.filter(t => t.tier === 'goal' && t.stock)) expect(buildBand(t, fresh, pure, ['Lost City'])).toBeNull();
    // In a plan: the account with a route is a candidate for Lost City, the account with the same build and no route is not.
    // The account has the levels that the Lost City band asks of every army account (Defence 90 and Hitpoints 90).
    const who = (name: string) => ({ ...acct(name, { Attack: 60, Strength: 99, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 93, Defence: 90 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set<string>() });
    const run = (buildQuests?: Map<string, readonly string[]>) => plan(inputs([who('Build')], { army: new Set(['build']), builds: new Map([['build', pure]]), buildQuests, pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY }))[0]!.template?.id;
    expect(run(new Map([['build', ['Lost City']]]))).toBe('army-quest-lostcity');
    expect(run()).not.toBe('army-quest-lostcity');
    expect(run(new Map([['build', []]]))).not.toBe('army-quest-lostcity');
});

test('a Defence 1 build account takes Lost City with the levels, potions and food of the practice run', async () => {
    const { LOST_CITY_BUILD, KIT_BUY, KIT_PRICE_CAPS } = await import('../src/autopilot');
    // The levels of the `pure-pray` kit (scripts/pk-kits.ts kitSkills): Defence 1 and Magic 1.
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43, Hitpoints: 93 };
    expect(LOST_CITY_BUILD).toEqual({ skills: { Attack: 60, Strength: 99, Prayer: 43, Hitpoints: 93 }, items: { 'prayer potion(4)': 2 }, pieces: { of: ['lobster', 'swordfish', 'shark'], count: 6 } });
    for (const [skill, level] of Object.entries(LOST_CITY_BUILD.skills!)) expect(pure[skill as keyof typeof pure]).toBeGreaterThanOrEqual(level);
    const kit = { coin: 100_000, 'prayer potion(4)': 2, lobster: 6, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 };
    const food: Market = { lobster: { id: 379, name: 'Lobster', limit: KIT_PRICE_CAPS.lobster! } };
    const first = (skills: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) => plan(inputs([{ ...acct('Build', skills, items), quests: new Set<string>() }],
        { army: new Set(['build']), builds: new Map([['build', pure]]), buildQuests: new Map([['build', ['Lost City']]]), pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY, ...extra }))[0]!.template;
    expect(first(pure, kit)!.id).toBe('army-quest-lostcity');
    // One level short, or no prayer potion (no market sells one): no Lost City and no buy for it.
    for (const short of [{ Hitpoints: 92 }, { Prayer: 42 }, { Strength: 98 }, { Attack: 59 }]) expect(first({ ...pure, ...short }, kit, { market: food })?.id ?? '').not.toContain('army-quest-lostcity');
    expect(first(pure, { ...kit, 'prayer potion(4)': 1 }, { market: food })?.id ?? '').not.toContain('army-quest-lostcity');
    // Short of food only: the band buys the 6 meals of the practice pack, not the 10 of an account with Defence 90.
    const buy = first(pure, { ...kit, lobster: 0 }, { market: food })!;
    expect(buy.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[379, 6]]);
});

test('the halberd build trains Thieving and Agility, then takes Underground Pass and Regicide', async () => {
    const { buildBand, catalogue: all, BUILD_QUESTS, ROUTE_BEFORE, UPASS, UPASS_AGILITY, UPASS_THIEVING, UPASS_MEALS, REGICIDE_MEALS, QUEST_BOW_ARROWS, REGICIDE_RUNES, REGICIDE_PACK, KIT_BUY, KIT_PRICE_CAPS } = await import('../src/autopilot');
    // The levels of the `pure-hally` kit and its levels before the route (scripts/pk-kits.ts): the reward of
    // Underground Pass takes Attack from 11 to 61.
    const hally = { Attack: 61, Strength: 99, Defence: 1, Ranged: 99, Magic: 54, Prayer: 43 }, before = { Attack: 11, Strength: 99, Defence: 1, Ranged: 99, Magic: 53, Prayer: 43, Hitpoints: 93 };
    const route = BUILD_QUESTS['pure-hally']!, templates = all(), byId = (id: string) => templates.find(t => t.id === id)!;
    const thieve = byId('army-thieve-50'), agility = byId('army-agility-68'), upass = byId('army-quest-upass'), regicide = byId('army-quest-regicide');
    expect(route).toEqual(['Regicide']);
    expect(ROUTE_BEFORE.Regicide).toEqual(['Underground Pass']);
    expect([UPASS_THIEVING, UPASS_AGILITY, CAPACITY[UPASS]]).toEqual([50, 68, 1]);
    expect(thieve).toMatchObject({ buildOnly: true, pilot: true, route: 'Underground Pass', script: 'scripts/generated/thieving60.ts', env: { TARGET: '50' }, trains: { skill: 'Thieving', to: 50 } });
    expect(agility).toMatchObject({ buildOnly: true, pilot: true, route: 'Underground Pass', args: ['skiller', 'agility', 'order', 'gnome', '68'], trains: { skill: 'Agility', to: 68 } });
    expect(upass).toMatchObject({ buildOnly: true, pilot: true, gives: ['Attack'], args: ['quester', 'chain', 'elena,biohazard,upass'], quest: { name: 'Underground Pass' } });
    expect(regicide).toMatchObject({ buildOnly: true, pilot: true, gives: ['Magic'], args: ['quester', 'chain', 'murder,regicide'], quest: { name: 'Regicide' } });
    expect(upass.needs).toEqual({ skills: { Ranged: 99, Prayer: 43, Hitpoints: 90, Thieving: 50, Agility: 68 }, items: { coins: 5000, 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS, 'prayer potion(4)': 2 },
        pieces: { of: ['lobster', 'swordfish', 'shark'], count: UPASS_MEALS } });
    expect(regicide.needs).toEqual({ quests: ['Underground Pass'], skills: { Ranged: 99, Magic: 51, Prayer: 43, Hitpoints: 90, Agility: 68 }, items: { coins: 2000, 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS, ...REGICIDE_RUNES, ...REGICIDE_PACK },
        pieces: { of: ['lobster', 'swordfish', 'shark'], count: REGICIDE_MEALS } });
    expect(REGICIDE_PACK).toEqual({ coal: 8, 'cooked rabbit': 1, limestone: 1, 'iron fire arrow': 2, 'pestle and mortar': 1, rope: 2 });
    expect([UPASS_MEALS, REGICIDE_MEALS]).toEqual([12, 30]);
    expect([thieve.band!, agility.band!, upass.band!, regicide.band!]).toEqual([...[thieve.band!, agility.band!, upass.band!, regicide.band!]].sort((a, b) => a - b));
    // Every item of the two kits that a buy may order has a price cap.
    for (const item of ['magic shortbow', 'rune arrow', 'prayer potion(4)', 'shark', 'coal', ...Object.keys(REGICIDE_RUNES)]) expect(KIT_PRICE_CAPS[item]).toBeGreaterThan(0);
    const fresh = { ...acct('Hally', before), quests: new Set<string>() }, passed = { ...acct('Hally', { ...before, Attack: 61 }), quests: new Set(['underground pas']) };
    // Only a build with Regicide on its route: not a plain army account, not a build with another route.
    for (const band of [thieve, agility, upass, regicide]) {
        expect(buildBand(band, fresh)).toBeNull();
        expect(buildBand(band, fresh, hally, ['Lost City'], before)).toBeNull();
        expect(buildBand(band, fresh, hally, route, before)).toBe(band);
    }
    // After Underground Pass the two trainers and the quest band of the pass are gone for the planner (the quest band
    // by its target), and Regicide stays although Attack is over its level before the route. Magic over it refuses.
    expect(buildBand(thieve, passed, hally, route, before)).toBeNull();
    expect(buildBand(agility, passed, hally, route, before)).toBeNull();
    expect(buildBand(regicide, passed, hally, route, before)).toBe(regicide);
    expect(buildBand(regicide, { ...passed, skills: { ...passed.skills, Magic: 54 } }, hally, route, before)).toBeNull();
    // Attack over the level before the route refuses Underground Pass: its reward would end over the build.
    expect(buildBand(upass, { ...fresh, skills: { ...fresh.skills, Attack: 12 } }, hally, route, before)).toBeNull();
    // In a plan, step by step.
    const kit = { coin: 100_000, shark: 40, 'magic shortbow': 1, 'rune arrow': 600, 'prayer potion(4)': 2, 'law rune': 5, 'air rune': 3, 'water rune': 5, ...REGICIDE_PACK };
    const pilots = new Set(['army-thieve-50', 'army-agility-68', 'army-quest-upass', 'army-quest-regicide']);
    const first = (skills: Record<string, number>, items: Record<string, number> = kit, quests: string[] = [], extra: Partial<Inputs> = {}) => plan(inputs([{ ...acct('Hally', { ...before, ...skills }, items), quests: new Set(quests) }],
        { army: new Set(['hally']), builds: new Map([['hally', hally]]), buildQuests: new Map([['hally', route]]), buildBefore: new Map([['hally', before]]), pilots, capacity: CAPACITY, ...extra }))[0]!.template?.id;
    expect(first({})).toBe('army-thieve-50');
    expect(first({ Thieving: 50 })).toBe('army-agility-68');
    expect(first({ Thieving: 50, Agility: 67 })).toBe('army-agility-68');
    expect(first({ Thieving: 50, Agility: 68 })).toBe('army-quest-upass');
    expect(first({ Thieving: 50, Agility: 68, Attack: 61 }, kit, ['underground pas'])).toBe('army-quest-regicide');
    // Without the limestone, which no shop and no market sells, the account does not take Regicide.
    expect(first({ Thieving: 50, Agility: 68, Attack: 61 }, { ...kit, limestone: 0 }, ['underground pas'])).not.toBe('army-quest-regicide');
    // Regicide waits for Underground Pass, and neither is given outside the plan's pilots.
    expect(first({ Thieving: 50, Agility: 68 }, { ...kit, 'prayer potion(4)': 0 })).not.toBe('army-quest-regicide');
    expect(first({ Thieving: 50, Agility: 68 }, kit, [], { pilots: new Set() }) ?? '').not.toContain('army-');
    // Short of the bow and the arrows: the band buys them.
    const market: Market = { 'magic shortbow': { id: 861, name: 'Magic shortbow', limit: KIT_PRICE_CAPS['magic shortbow']! }, 'rune arrow': { id: 892, name: 'Rune arrow', limit: KIT_PRICE_CAPS['rune arrow']! } };
    expect(first({ Thieving: 50, Agility: 68 }, { ...kit, coin: 2_000_000, 'magic shortbow': 0, 'rune arrow': 100 }, [], { market })).toBe(KIT_BUY + 'army-quest-upass');
});
