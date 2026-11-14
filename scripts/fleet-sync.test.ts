import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAccounts, carriedPrior, ensureWorktree, keepPublished, planView, pullFleetData, reattach, sideCapacity, sideCard, snapshot, worktreeProblem } from './fleet-sync';
import { SWARM_STOP } from './swarm';
import { CLAIM_MAX_AGE_MS } from '../packages/planner/src/autopilot';
import { mergeJobs } from '../packages/core/src/coordinator-jobs';
import { observedStock } from '../packages/planner/src/supply-bill';

test('a coordinator job takes its account in the view, as the swarm runs it', () => {
    const owners = new Map([['oreelse', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const owner = [{ account: 'OreElse', script: 'scripts/goldfarm.ts', enabled: true }];
    const coordinator = [{ account: 'OreElse', script: 'scripts/magic-order.ts', enabled: true, goal: 'run-magic' }];
    expect(planView(mergeJobs(owner, coordinator), 'local', owners, 1).jobs.filter(j => j.enabled)).toEqual([{ account: 'OreElse', script: 'scripts/magic-order.ts', enabled: true, goal: 'run-magic' }]);
});

test('the plan view holds only this side\'s jobs, never the main account or job notes', () => {
    const owners = new Map([['oreelse', { side: 'local', server: 'rs-sdk-demo.fly.dev' }], ['haggis', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['quickhandjob', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['shaftsinker', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const jobs = [
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, standing: true, note: 'old story' },
        { account: 'Haggis', role: 'main', script: '', enabled: false },
        { account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true },
        { accounts: ['OreElse', 'Quickhandjob'], script: 'scripts/fleet-trade.ts', enabled: true },
        { accounts: ['OreElse', 'Shaftsinker'], script: 'scripts/quest-chain.ts', enabled: false },
    ];
    expect(planView(jobs, 'local', owners, 7)).toEqual({ side: 'local', at: 7, jobs: [
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, standing: true },
        { accounts: ['OreElse', 'Shaftsinker'], script: 'scripts/quest-chain.ts', enabled: false },
    ] });
});

test('the snapshot keeps a published row for an account with no local status or a staler one, never another side\'s row', () => {
    const owners = new Map([['quickhandjob', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['trousersnake', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['bigchopper', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const row = (name: string, at: number, level: number) => ({ name, server: 'rs-sdk-demo.fly.dev', at, bank: [], inventory: [], equipment: [], skills: [{ name: 'Thieving', level }] });
    const prior = [row('TrouserSnake', 100, 99), row('Quickhandjob', 100, 99), row('Bigchopper', 100, 50)];
    // A fresh container: no status files. Both rows of this side stay; the local side's row is not this side's to publish.
    expect(snapshot([], 'claude-cloud', owners, 5, prior).accounts.map(a => [a.name, a.skills[0]!.level])).toEqual([['TrouserSnake', 99], ['Quickhandjob', 99]]);
    // A newer status replaces its row; an older one (a stale file copied in) does not.
    const status = (name: string, at: number, level: number) => ({ name, server: 'rs-sdk-demo.fly.dev', at, skills: [{ name: 'Thieving', level }], bank: [{ id: 995, name: 'Coins', count: 7 }] });
    const next = snapshot([status('Quickhandjob', 200, 99), status('TrouserSnake', 50, 1)], 'claude-cloud', owners, 5, prior).accounts;
    expect(next.map(a => [a.name, a.at, a.skills[0]!.level])).toEqual([['TrouserSnake', 100, 99], ['Quickhandjob', 200, 99]]);
    expect(next[1]!.bank).toEqual([{ id: 995, name: 'Coins', count: 7 }]);
});

test('a snapshot shares observed skill, gear and quest detail with original observation times and an explicit field list', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const quests = [
        { id: 7333, name: "Cook's Assistant", state: 'complete', privateText: 'private-journal' },
        { id: 7335, name: 'Rune Mysteries', state: 'started' },
        { id: 7344, name: 'Sheep Shearer', state: 'unknown' },
    ];
    const [account] = snapshot([{
        name: 'Worker', server: 'rs-sdk-demo.fly.dev', at: 1_000, bankAt: 100, questsAt: 800,
        bank: [{ id: 996, baseId: 995, name: 'Coins', count: 50, password: 'private-item' }],
        inventory: [], equipment: [{ id: 1387, name: 'Staff of fire', count: 1, slot: 3, secret: 'private-gear' }], equipmentObserved: true,
        skills: [{ name: 'Magic', level: 60, currentLevel: 65, xp: 300_001, credential: 'private-skill' }],
        combat: 80, pos: { x: 2618, z: 3333, level: 0, session: 'private-position' },
        guildFacts: { varps: { qp: 35, secret: 'private-varp' }, privateSession: 'private-guild' }, quests,
        password: 'private-password', env: { TOKEN: 'private-token' }, sessionAttemptId: 'private-session',
    }], 'cloud', owners, 2_000).accounts;
    expect(account).toEqual({
        name: 'Worker', server: 'rs-sdk-demo.fly.dev', at: 1_000, bankAt: 100, questsAt: 800,
        bank: [{ id: 995, name: 'Coins', count: 50 }], inventory: [], inventoryIds: 'raw',
        equipment: [{ id: 1387, name: 'Staff of fire', count: 1, slot: 3 }], equipmentObserved: true,
        skills: [{ name: 'Magic', level: 60, currentLevel: 65, xp: 300_001 }],
        combat: 80, pos: { x: 2618, z: 3333, level: 0 }, guildFacts: { varps: { qp: 35 } },
        quests: ["Cook's Assistant"], questJournal: quests.map(({ privateText: _private, ...q }) => q),
    });
    expect(JSON.stringify(account)).not.toContain('private-');
});

test('unknown containers and journals stay unknown while observed empty containers stay empty', () => {
    const owners = new Map(['unknown', 'empty', 'invalid'].map(name => [name, { side: 'cloud', server: 's' }])) as any;
    const accounts = snapshot([
        { name: 'Unknown', server: 's', at: 100, bank: null, equipment: null, equipmentObserved: false, quests: null },
        { name: 'Empty', server: 's', at: 100, bank: [], bankAt: 50, inventory: [], equipment: [], equipmentObserved: true },
        { name: 'Invalid', server: 's', at: 100, bank: 'unavailable', bankAt: 50, inventory: [{ id: 995, count: 0 }], equipment: [{ id: -1, count: 1 }], equipmentObserved: true },
    ], 'cloud', owners, 200).accounts;
    expect(accounts.map(a => [a.bank, a.bankAt, a.inventory, a.equipment, a.equipmentObserved, a.questJournal, a.questsAt])).toEqual([
        [null, null, null, null, false, null, null],
        [[], 50, [], [], true, null, null],
        [null, null, null, null, false, null, null],
    ]);
    expect(accounts.every(a => !('quests' in a))).toBe(true);
});

test('snapshot inventory preserves noted rope and weapon identities while stock still counts their base items', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    // Pinned obj.pack:955=cert_rope, 1334=cert_rune_scimitar. Neither note can be used as its base item.
    const [account] = snapshot([{ name: 'Worker', server: 's', at: 1_000, inventory: [
        { id: 955, baseId: 954, name: 'Rope', count: 2, privateData: 'private-note' },
        { id: 1334, baseId: 1333, name: 'Rune scimitar', count: 1 },
        { id: 995, name: 'Coins', count: 50 },
    ] }], 'cloud', owners, 2_000).accounts;
    expect(account.inventoryIds).toBe('raw');
    expect(account.inventory).toEqual([{ id: 955, baseId: 954, name: 'Rope', count: 2 },
        { id: 1334, baseId: 1333, name: 'Rune scimitar', count: 1 }, { id: 995, baseId: 995, name: 'Coins', count: 50 }]);
    expect(account.inventory.some((i: any) => i.id === 954 || i.id === 1333)).toBe(false);
    expect([...observedStock(account)]).toEqual([[954, 2], [1333, 1], [995, 50]]);
});

test('only known projected inventory receives a raw-ID marker and invalid raw IDs stay unknown', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const current = { name: 'Worker', server: 's', at: 1_000 };
    const [empty] = snapshot([{ ...current, inventory: [] }], 'cloud', owners, 2_000).accounts;
    expect(empty).toMatchObject({ inventory: [], inventoryIds: 'raw' });
    for (const inventory of [null, undefined, [{ baseId: 954, count: 1 }], [{ id: -1, baseId: 954, count: 1 }],
        [{ id: '955', baseId: 954, count: 1 }], [{ id: 955, baseId: -1, count: 1 }], [{ id: NaN, baseId: 954, count: 1 }]]) {
        const [unknown] = snapshot([{ ...current, inventory }], 'cloud', owners, 2_000).accounts;
        expect(unknown.inventory).toBeNull(); expect(unknown).not.toHaveProperty('inventoryIds');
    }
    const legacy = { ...current, inventory: [{ id: 954, count: 2 }] };
    const [carried] = snapshot([], 'cloud', owners, 2_000, [legacy]).accounts;
    expect(carried).toEqual(legacy); expect(carried).not.toHaveProperty('inventoryIds');
    const [fresh] = snapshot([{ ...current, at: 3_000 }], 'cloud', owners, 4_000, [legacy]).accounts;
    expect(fresh.inventory).toBeNull(); expect(fresh).not.toHaveProperty('inventoryIds');
});

test('snapshots do not infer observation ages or optional actor facts from missing or invalid values', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]) as any;
    const quests = [{ id: 7333, name: "Cook's Assistant", state: 'complete' }];
    const status = { name: 'Worker', server: 's', at: 1_000, bank: [], quests,
        skills: [{ name: 'Magic', level: 60, currentLevel: -1, xp: '300001' }],
        combat: NaN, pos: { x: 2618, z: 3333, level: 4 }, guildFacts: { varps: { qp: -1 } } };
    for (const at of [undefined, null, 0, -1, 1_001, NaN, Infinity, '900']) {
        const [account] = snapshot([{ ...status, bankAt: at, questsAt: at }], 'cloud', owners, 2_000).accounts;
        expect(account.bankAt).toBeNull();
        expect(account.questsAt).toBeNull();
        expect(account.questJournal).toEqual(quests);
        expect(account.skills).toEqual([{ name: 'Magic', level: 60 }]);
        for (const key of ['combat', 'pos', 'guildFacts']) expect(account).not.toHaveProperty(key);
    }
    const [invalidJournal] = snapshot([{ ...status, quests: [quests[0], { ...quests[0] }] }], 'cloud', owners, 2_000).accounts;
    expect(invalidJournal.questJournal).toBeNull();
    expect(invalidJournal.questsAt).toBeNull();
});

test('an adopted account keeps sanitized bank and journal observations through its first unknown status', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const prior = { name: 'Worker', server: 's', at: 1_000, bankAt: 100, questsAt: 800,
        bank: [{ id: 996, baseId: 995, name: 'Coins', count: 50, secret: 'private-bank' }],
        questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'complete', secret: 'private-journal' }],
        quests: ['wrong legacy completion'], inventory: [{ id: 385, count: 10 }], equipment: [{ id: 1289, count: 1, slot: 3 }],
        guildFacts: { varps: { qp: 35 } }, result: 'ok old run', ledger: { xp: 100 }, sessionAttemptId: 'private-session' };
    const carried = carriedPrior([], [{ side: 'local', accounts: [prior] }], 'cloud', owners);
    const [account] = snapshot([{ name: 'worker', server: 'S', at: 2_000, bank: null, quests: null }], 'cloud', owners, 3_000, carried).accounts;
    expect(account).toMatchObject({ name: 'worker', server: 'S', at: 2_000, bankAt: 100, questsAt: 800,
        bank: [{ id: 995, name: 'Coins', count: 50 }], inventory: null, equipment: null,
        questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'complete' }], quests: ["Cook's Assistant"] });
    for (const key of ['guildFacts', 'result', 'ledger', 'sessionAttemptId']) expect(account).not.toHaveProperty(key);
    expect(JSON.stringify(account)).not.toContain('private-');
});

test('explicit bank and full-journal observations replace carried data, including an empty bank and no completed quests', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const old = { name: 'Worker', server: 's', at: 1_000, bankAt: 100, bank: [{ id: 995, count: 50 }], questsAt: 800,
        questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'complete' }], quests: ["Cook's Assistant"] };
    const quests = [{ id: 7333, name: "Cook's Assistant", state: 'not started' }];
    const [account] = snapshot([{ name: 'Worker', server: 's', at: 2_000, bank: [], bankAt: 1_800, quests, questsAt: 1_900 }], 'cloud', owners, 3_000, [old]).accounts;
    expect(account).toMatchObject({ bank: [], bankAt: 1_800, questJournal: quests, questsAt: 1_900, quests: [] });
});

test('carried observations retain unknown ages and never borrow an account timestamp or another identity', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const current = { name: 'Worker', server: 's', at: 2_000, bank: null, quests: null };
    const prior = { name: 'Worker', server: 's', at: 1_000, bank: [{ id: 995, count: 50 }],
        questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'complete' }] };
    for (const observedAt of [undefined, null, 0, -1, 1_001, NaN, Infinity, '900']) {
        const [account] = snapshot([current], 'cloud', owners, 3_000, [{ ...prior, bankAt: observedAt, questsAt: observedAt }]).accounts;
        expect(account.bank).toEqual([{ id: 995, count: 50 }]);
        expect(account.questJournal).toEqual(prior.questJournal);
        expect(account.bankAt).toBeNull(); expect(account.questsAt).toBeNull();
    }
    for (const invalid of [{ ...prior, name: 'Stranger' }, { ...prior, server: 'other' },
        { ...prior, bank: [{ id: 995, count: -1 }], questJournal: [prior.questJournal[0], prior.questJournal[0]], quests: ['wrong legacy completion'] }]) {
        const [account] = snapshot([current], 'cloud', owners, 3_000, [invalid]).accounts;
        expect(account.bank).toBeNull(); expect(account.questJournal).toBeNull();
        expect(account).not.toHaveProperty('quests');
    }
});

test('legacy-only completed names survive unknown statuses without inventing journal details or ages', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const old = { name: 'Worker', server: 's', at: 1_000, quests: ["Cook's Assistant"] };
    const current = { name: 'Worker', server: 's', at: 2_000, quests: null };
    const first = snapshot([current], 'cloud', owners, 3_000, [old]).accounts;
    const [account] = snapshot([{ ...current, at: 4_000 }], 'cloud', owners, 5_000, first).accounts;
    expect(account).toMatchObject({ questJournal: null, questsAt: null, quests: ["Cook's Assistant"] });
    const [full] = snapshot([current], 'cloud', owners, 3_000, [{ ...old, questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'unknown' }] }]).accounts;
    expect(full).not.toHaveProperty('quests');
});

test('current name-only quest statuses retain legacy summaries and only explicit observation ages', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const current = { name: 'Worker', server: 's', at: 2_000, quests: [
        { name: "Cook's Assistant", state: 'complete' }, { name: 'Rune Mysteries', state: 'started' },
    ] };
    const [undated] = snapshot([current], 'cloud', owners, 3_000).accounts;
    expect(undated).toMatchObject({ quests: ["Cook's Assistant"], questJournal: null, questsAt: null });
    const [dated] = snapshot([{ ...current, questsAt: 1_800 }], 'cloud', owners, 3_000).accounts;
    expect(dated).toMatchObject({ quests: ["Cook's Assistant"], questJournal: null, questsAt: 1_800 });
    const old = { name: 'Worker', server: 's', at: 1_000, questJournal: null, quests: ['Old quest'], questsAt: 800 };
    const [replaced] = snapshot([{ ...current, quests: [{ name: "Cook's Assistant", state: 'not started' }], questsAt: 1_900 }], 'cloud', owners, 3_000, [old]).accounts;
    expect(replaced).toMatchObject({ quests: [], questJournal: null, questsAt: 1_900 });
    const full = { ...old, questJournal: [{ id: 7333, name: "Cook's Assistant", state: 'complete' }], quests: ["Cook's Assistant"] };
    const [retained] = snapshot([{ ...current, quests: [{ name: "Cook's Assistant", state: 'not started' }], questsAt: 1_900 }], 'cloud', owners, 3_000, [full]).accounts;
    expect(retained).toMatchObject({ quests: ["Cook's Assistant"], questJournal: full.questJournal, questsAt: 800 });
});

test('malformed or mixed explicit quest IDs cannot become name-only completion summaries', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const entry = { name: "Cook's Assistant", state: 'complete' };
    const invalid = [
        ...[undefined, null, -1, '7333', NaN].map(id => [{ ...entry, id }]),
        [{ ...entry, id: 7333 }, { name: 'Rune Mysteries', state: 'complete', id: 7333 }],
        [{ ...entry, id: 7333 }, { name: 'Rune Mysteries', state: 'complete' }],
        [entry, { ...entry, state: 'started' }], [{ ...entry, name: '' }], [{ ...entry, state: 'invalid' }],
    ];
    for (const quests of invalid) {
        const [account] = snapshot([{ name: 'Worker', server: 's', at: 2_000, quests, questsAt: 1_800 }], 'cloud', owners, 3_000).accounts;
        expect(account).not.toHaveProperty('quests');
        expect(account.questJournal).toBeNull(); expect(account.questsAt).toBeNull();
    }
});

test('snapshots share only supported current guild lower bounds and durable unlocks', () => {
    const owners = new Map([['worker', { side: 'cloud', server: 's' }]]);
    const current = { name: 'Worker', server: 's', at: 1_000, guildFacts: {
        varps: { qp: 35, heroquest: 15, castlewars: 1 }, questStages: { heroquest: 15, legendsquest: 50, mcannon: 2, secret: 99 },
        unlocks: ['prayer-guild', 'dwarf-tower', 'grandtree-glider', 'prayer-guild', 'castlewars-team', 'private-unlock'],
        castlewarsTeam: 1, doorStates: { '0,1,2': true }, admission: { legendsEntry: 'crossed' }, session: 'private-session' } };
    const first = snapshot([current], 'cloud', owners, 2_000).accounts;
    expect(first[0]).toMatchObject({ at: 1_000, guildFacts: { varps: { qp: 35 }, questStages: { heroquest: 15, legendsquest: 50, mcannon: 2 },
        unlocks: ['prayer-guild', 'dwarf-tower', 'grandtree-glider'] } });
    expect(JSON.stringify(first[0].guildFacts)).not.toMatch(/castlewars|doorStates|admission|private|session/);
    const [unknown] = snapshot([{ name: 'Worker', server: 's', at: 3_000 }], 'cloud', owners, 4_000, first).accounts;
    expect(unknown).not.toHaveProperty('guildFacts');
    for (const value of [-1, 1.5, NaN, Infinity, '15', null]) {
        const [invalid] = snapshot([{ ...current, guildFacts: { varps: { qp: value }, questStages: { heroquest: value, legendsquest: value, mcannon: value }, unlocks: ['castlewars-team'] } }], 'cloud', owners, 2_000).accounts;
        expect(invalid).not.toHaveProperty('guildFacts');
    }
    const [tooHigh] = snapshot([{ ...current, guildFacts: { questStages: { heroquest: 16, legendsquest: 76, mcannon: 12 } } }], 'cloud', owners, 2_000).accounts;
    expect(tooHigh).not.toHaveProperty('guildFacts');
});

test('an account is active for the claim when its snapshot row was written within CLAIM_MAX_AGE_MS', () => {
    const now = 10 * CLAIM_MAX_AGE_MS;
    const active = activeAccounts([{ name: 'Pocketpython', at: now - 60_000 }, { name: 'Billionaire', at: now - CLAIM_MAX_AGE_MS }, { name: 'Broken', at: 'x' }], now);
    expect(['Pocketpython', 'pocketpython', 'Billionaire', 'Broken', 'PickpockDick'].map(active)).toEqual([true, true, false, false, false]);
    expect(activeAccounts([], now)('Pocketpython')).toBe(false);
});

test('an empty plan keeps a fresh published claim that holds resources or a fresh published plan that holds jobs; a planned job, or a stale or empty one, does not', () => {
    const fresh = { side: 'claude-cloud', at: 1_000_000, resources: ['knight:2669,3298'] };
    expect(keepPublished([], fresh, 1_000_000 + 60_000)).toBe(true);
    expect(keepPublished([{ account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true }], fresh, 1_000_000 + 60_000)).toBe(false);
    expect(keepPublished([], { ...fresh, resources: [] }, 1_000_000 + 60_000)).toBe(false);
    expect(keepPublished([], fresh, 1_000_000 + CLAIM_MAX_AGE_MS)).toBe(false);
    expect(keepPublished([], null)).toBe(false);
    // A Ranged or quest job holds no exclusive resource: its claim is empty, so the fresh published plan that holds it is
    // what keeps an empty-plan session from erasing it; a stale or empty plan does not.
    const plan = { side: 'claude-cloud', at: 1_000_000, jobs: [{ account: 'TrouserSnake', script: 'scripts/ranged-train.ts', enabled: true }] };
    expect(keepPublished([], { ...fresh, resources: [] }, 1_000_000 + 60_000, plan)).toBe(true);
    expect(keepPublished([], null, 1_000_000 + 60_000, plan)).toBe(true);
    expect(keepPublished([], null, 1_000_000 + CLAIM_MAX_AGE_MS, plan)).toBe(false);
    expect(keepPublished([], null, 1_000_000 + 60_000, { ...plan, jobs: [] })).toBe(false);
    expect(keepPublished([{ account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true }], null, 1_000_000 + 60_000, plan)).toBe(false);
});

test('a detached worktree goes back on its branch with its commits, and a diverged branch refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-sync-reattach-'));
    const run = (...args: string[]) => { const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, windowsHide: true }); if (p.exitCode !== 0) throw Error(p.stderr.toString()); return p.stdout.toString().trim(); };
    const commit = (text: string) => { writeFileSync(join(dir, 'f'), text); run('add', 'f'); run('commit', '-q', '-m', text); return run('rev-parse', 'HEAD'); };
    try {
        run('init', '-q', '-b', 'fleet-data');
        const first = commit('one');
        expect(reattach(dir, 'fleet-data')).toBe(false);
        run('checkout', '-q', '--detach');
        const second = commit('two');
        expect(run('rev-parse', 'fleet-data')).toBe(first);
        expect(reattach(dir, 'fleet-data')).toBe(true);
        expect(run('symbolic-ref', 'HEAD')).toBe('refs/heads/fleet-data');
        expect(run('rev-parse', 'fleet-data')).toBe(second);
        run('checkout', '-q', '--detach', first);
        expect(() => reattach(dir, 'fleet-data')).toThrow('holds commits that HEAD lacks');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a side card carries the plan\'s capacity and only the owner\'s pauses of its own accounts', () => {
    expect(sideCapacity({ maxBots: 4 })).toBe(4);
    expect(sideCapacity({ maxBots: 4, fleetCapacity: 9 })).toBe(9);
    expect(sideCapacity(null)).toBeNull();
    // The stop files carry the registry spelling (stop-Fatstack), as the swarm writes them; the card names them in lower case.
    const owned = ['Fatstack', 'Bravo', 'Charlie'];
    const stops: Record<string, string> = { Fatstack: 'owner: hold for the quest', Bravo: SWARM_STOP.job, charlie: 'owner hold', Kilo: 'owner hold' };
    expect(sideCard('claude-cloud', 4, owned, n => stops[n])).toEqual({ side: 'claude-cloud', capacity: 4, paused: ['charlie', 'fatstack'], died: [], stopped: false });
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? 'owner stopped the side' : undefined).stopped).toBe(true);
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? SWARM_STOP.all : undefined).stopped).toBe(false);
});

test('an adopted account keeps its last row from the side that ran it; a row this side has stays', () => {
    const owners = new Map([['fatstack', { side: 'local', server: 'rs-sdk-demo.fly.dev' }], ['kilo', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['other', { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }]]);
    const files = [{ side: 'claude-cloud', at: 9, accounts: [{ name: 'Fatstack', server: 'rs-sdk-demo.fly.dev', at: 9, skills: [{ name: 'Thieving', level: 99 }] }, { name: 'Kilo', at: 9 }] },
        { side: 'cloud', at: 9, accounts: [{ name: 'Other', at: 9 }] }];
    const prior = [{ name: 'Kilo', at: 5 }];
    const out = carriedPrior(prior, files, 'local', owners);
    expect(out.map(r => [r.name, r.at])).toEqual([['Kilo', 5], ['Fatstack', 9]]);
    expect(out[1]).not.toHaveProperty('side');
    // The snapshot this side publishes then holds it, so every reader sees Thieving 99 before its first login here.
    expect(snapshot([], 'local', owners, 10, out).accounts.find(a => a.name === 'Fatstack')?.skills).toEqual([{ name: 'Thieving', level: 99 }]);
});

test('a side card lists its accounts whose last end was a death', () => {
    expect(sideCard('local', 4, ['Fatstack', 'Kilo'], () => undefined, ['fatstack', 'Stranger']).died).toEqual(['fatstack']);
});

test('the pull keeps a rewritten committed receipt and a staged order removal, and takes the other side\'s commit', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
    const base = mkdtempSync(join(tmpdir(), 'fleet-pull-'));
    const saved = { name: process.env.GIT_AUTHOR_NAME, email: process.env.GIT_AUTHOR_EMAIL, cname: process.env.GIT_COMMITTER_NAME, cemail: process.env.GIT_COMMITTER_EMAIL };
    Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' });
    try {
        const remote = join(base, 'remote.git'), here = join(base, 'here'), other = join(base, 'other');
        g(base, 'init', '--bare', '-b', 'fleet-data', remote);
        g(base, 'clone', '-q', remote, here);
        g(here, 'checkout', '-q', '-b', 'fleet-data');
        writeFileSync(join(here, 'receipt.json'), '{"phase":"waiting"}\n'); writeFileSync(join(here, 'order.json'), '{}\n');
        g(here, 'add', '.'); g(here, 'commit', '-qm', 'sync'); g(here, 'push', '-q', 'origin', 'fleet-data');
        g(base, 'clone', '-q', '--branch', 'fleet-data', remote, other);
        writeFileSync(join(other, 'snapshot.json'), '{}\n'); g(other, 'add', '.'); g(other, 'commit', '-qm', 'other side'); g(other, 'push', '-q', 'origin', 'fleet-data');
        // A trade step rewrites the committed receipt, and the order is withdrawn with git rm: a plain rebase pull refuses.
        writeFileSync(join(here, 'receipt.json'), '{"phase":"failed"}\n'); g(here, 'rm', '-q', 'order.json');
        expect(() => g(here, 'pull', '-q', '--rebase', 'origin', 'fleet-data')).toThrow();
        pullFleetData(here);
        expect(g(here, 'log', '--format=%s', '-1')).toBe('other side');
        expect(g(here, 'show', ':receipt.json')).toBe('{"phase":"waiting"}');
        // core.autocrlf=true (Git for Windows' system default) puts the restored file back with CRLF ends.
        expect(require('node:fs').readFileSync(join(here, 'receipt.json'), 'utf8').replace(/\r/g, '')).toBe('{"phase":"failed"}\n');
        expect(require('node:fs').existsSync(join(here, 'order.json'))).toBe(false);
        // The other side rewrites the same receipt: the stash pop conflicts, the pull exits 0, and pullFleetData stops.
        g(here, 'add', '.'); g(here, 'commit', '-qm', 'sync 2'); g(here, 'push', '-q', 'origin', 'fleet-data');
        g(other, 'pull', '-q', '--rebase', 'origin', 'fleet-data');
        writeFileSync(join(other, 'receipt.json'), '{"phase":"settled"}\n'); g(other, 'add', '.'); g(other, 'commit', '-qm', 'other side 2'); g(other, 'push', '-q', 'origin', 'fleet-data');
        writeFileSync(join(here, 'receipt.json'), '{"phase":"reconcile"}\n');
        expect(() => pullFleetData(here)).toThrow('local changes conflict with the fetched fleet data in receipt.json');
    } finally {
        for (const [k, v] of [['GIT_AUTHOR_NAME', saved.name], ['GIT_AUTHOR_EMAIL', saved.email], ['GIT_COMMITTER_NAME', saved.cname], ['GIT_COMMITTER_EMAIL', saved.cemail]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        rmSync(base, { recursive: true, force: true });
    }
});

test('a clone of master alone gets the published fleet-data branch, never one made from the code', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
    const base = mkdtempSync(join(tmpdir(), 'fleet-wt-'));
    try {
        const remote = join(base, 'remote.git'), seed = join(base, 'seed'), clone = join(base, 'clone');
        g(base, 'init', '--bare', remote); g(base, 'init', '-b', 'master', seed);
        writeFileSync(join(seed, 'code.ts'), 'code\n'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'code');
        g(seed, 'checkout', '-q', '--orphan', 'fleet-data'); g(seed, 'rm', '-rq', '--cached', '.');
        writeFileSync(join(seed, 'owners.json'), '{}\n'); g(seed, 'add', 'owners.json'); g(seed, 'commit', '-qm', 'fleet data');
        g(seed, 'remote', 'add', 'origin', remote); g(seed, 'push', '-q', 'origin', 'master', 'fleet-data');
        // A Codex checkout: master only, so `git fetch origin fleet-data` alone leaves origin/fleet-data missing.
        g(base, 'clone', '-q', '--single-branch', '--branch', 'master', remote, clone);
        const wt = ensureWorktree(join(clone, 'fleet'), clone);
        expect(g(wt, 'log', '--format=%s', '-1')).toBe('fleet data');
        expect(worktreeProblem(wt, 0)).toBeNull();
        // The worktree the old fetch made: fleet-data from the code. It holds commits the published branch lacks.
        const bogus = join(clone, 'bogus');
        g(clone, 'worktree', 'add', '-q', '-b', 'stray', bogus, 'master');
        expect(worktreeProblem(bogus, 0)).toContain('not the fleet-data branch');
        // Unpublished fleet data (pushes refused, say) is never taken for the code, however many commits.
        for (const n of [1, 2, 3]) { writeFileSync(join(wt, `receipt-${n}.json`), '{}\n'); g(wt, 'add', '.'); g(wt, 'commit', '-qm', `receipt ${n}`); }
        expect(worktreeProblem(wt, 0)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
});
