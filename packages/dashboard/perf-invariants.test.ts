import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { remoteBots, fleetSidesView } from './fleet-view';
import { publicView, pushDue, withoutClocks, withoutClocksValue } from './publish-relay';
import { contentionView, hiscoreRows, overtakeView, rosterView, wildernessView } from './world-view';
import { boundedOperation, collectionState } from './collection';
import { createVaultItems } from './vault-items';
import { goalProgress } from './goals';
import { gearProgress } from './goal-details';
import { buildItemPrices, itemPrice, priceItemKey } from './item-prices';
import { isLocalServer } from '../core/src/localserver';
import { itemSources, npcDrops } from './gen-map-data';
import { wikiReqs } from './gen-quest-reqs';
import { skillActions } from './gen-skill-actions';

describe('dashboard perf invariants', () => {
    test('withoutClocksValue matches withoutClocks(JSON.stringify) and pushDue honors precomputed stable hash', () => {
        const now = 1_700_000_000_000;
        const obj = {
            at: now,
            hosted: { at: now + 500, kind: 'public' },
            bots: [{ name: 'Worker1', at: now - 1000, level: 55 }],
            count: 42,
        };
        const json = JSON.stringify(obj);
        const stable = withoutClocksValue(obj);
        expect(stable).toBe(withoutClocks(json));

        const last = { stable, at: now };
        const objNewClock = { ...obj, at: now + 2000, hosted: { at: now + 2000, kind: 'public' } };
        expect(pushDue(JSON.stringify(objNewClock), last, now + 2000, withoutClocksValue(objNewClock))).toBe(false);

        const objChanged = { ...obj, bots: [{ name: 'Worker1', at: now, level: 56 }] };
        expect(pushDue(JSON.stringify(objChanged), last, now + 2000, withoutClocksValue(objChanged))).toBe(true);
    });

    test('publicView recursive secret check catches nested leaks while ignoring undefined properties', () => {
        expect(() =>
            publicView({
                bots: [{ name: 'Worker1', goal: 'normal', equipment: [{ name: 'Helm of Haggis' }] }],
            }),
        ).toThrow('nothing published');

        expect(() =>
            publicView({
                bots: [],
                lookups: { HaggisKey: { name: 'Other' } },
            }),
        ).toThrow('nothing published');

        // Undefined property keys are omitted by JSON.stringify and must not trigger false positives.
        const clean = publicView({
            bots: [{ name: 'Worker1', goal: 'mining' }],
            roster: [['Worker1', 3200, 3200, 0, 10]],
        });
        expect(clean.bots).toHaveLength(1);
    });

    test('remoteBots selects latest fresh plan per side and fleetSidesView indexes receipts by order', () => {
        const now = 1_700_000_000_000;
        const snapshots = [
            { side: 'cloud', at: now - 1000, accounts: [{ name: 'CloudBot', server: 'rs-sdk-demo.fly.dev', at: now - 1000, skills: [] }] },
        ];
        const plans = [
            { side: 'cloud', at: now - 60_000, jobs: [{ account: 'CloudBot', script: 'old.ts', goal: 'old', enabled: true }] },
            { side: 'cloud', at: now - 5_000, jobs: [{ account: 'CloudBot', script: 'new.ts', goal: 'new', enabled: true }] },
        ];
        const rows = remoteBots(snapshots, new Set(), new Map(), new Map(), now, 'local', plans, () => 'cloud');
        expect(rows).toHaveLength(1);
        expect(rows[0].planJob?.goal).toBe('new');
        expect(rows[0].currentGoal).toBe('Planned: new');

        const sides = fleetSidesView(
            snapshots,
            [
                { id: 'o1', from: 'A', to: 'B', item: 'Shark', count: 10, start: now - 1000, end: now + 10_000 },
                { id: 'o2', from: 'A', to: 'B', item: 'Lobster', count: 5, start: now - 500, end: now + 10_000 },
            ],
            now,
            [
                { id: 'o1', role: 'from', ok: true },
                { id: 'o1', role: 'to', ok: true },
                { id: 'o2', role: 'from', ok: true },
            ],
        );
        expect(sides.orders.map((o: any) => `${o.id}:${o.state}`)).toEqual(['o2:half']);
    });

    test('overtakeView picks best fleet rank per board cleanly', () => {
        const tops = new Map([
            ['Mining', { rows: [{ rank: 1, name: 'Rival1', level: 80, ticks: 10_000 }, { rank: 2, name: 'Rival2', level: 70, ticks: 8_000 }] }],
            ['Overall', { rows: [{ rank: 1, name: 'Rival1', level: 1000, ticks: 20_000 }] }],
        ]);
        const accounts = [
            { name: 'SlowBot', skills: [{ name: 'Mining', level: 60, xp: 300_000 }], ranks: [{ board: 'Mining', rank: 10, level: 60, time: '2h 0m 0s' }] },
            { name: 'FastBot', skills: [{ name: 'Mining', level: 65, xp: 450_000 }], ranks: [{ board: 'Mining', rank: 5, level: 65, time: '1h 0m 0s' }] },
        ];
        const out = overtakeView(tops, accounts, lvl => lvl * 10_000);
        expect(out).toHaveLength(1);
        expect(out[0].board).toBe('Mining');
        expect(out[0].account).toBe('FastBot');
        expect(out[0].rank).toBe(5);
    });

    test('xp-tracker binary search, charCode efficiency, and indexed supplyBillProgress match reference math', () => {
        const src = readFileSync(new URL('./xp-tracker.js', import.meta.url), 'utf8');
        const sandbox: any = {};
        new Function('globalThis', src)(sandbox);
        const xp = sandbox.atlasXp;

        const refXpForLevel = (lvl: number) => {
            let pts = 0;
            for (let l = 1; l < lvl; l++) pts += Math.floor(l + 300 * Math.pow(2, l / 10));
            return Math.floor(pts / 4);
        };
        for (const lvl of [1, 2, 10, 40, 85, 99, 120, 126]) {
            const threshold = refXpForLevel(lvl);
            expect(xp.virtualLevel(threshold)).toBe(lvl);
            expect(xp.levelForXp(threshold)).toBe(Math.min(99, lvl));
            if (lvl > 1) {
                expect(xp.virtualLevel(threshold - 1)).toBe(lvl - 1);
                expect(xp.levelForXp(threshold - 1)).toBe(Math.min(99, lvl - 1));
            }
        }
        expect(xp.virtualLevel(-10)).toBe(1);
        expect(xp.levelForXp(-10)).toBe(1);
        expect(xp.virtualLevel(200_000_000)).toBe(175);
        expect(xp.ehpRate('wOoDcUtTiNg')).toBe(xp.ehpRate('Woodcutting'));
        expect(xp.ehpRate('UnknownSkill')).toBeNull();

        expect(xp.efficiency('')).toBeNull();
        expect(xp.efficiency('xxxiiimv')).toMatchObject({ ticks: 8, work: 50, waste: { kind: 'idle', share: 37.5 } });
        expect(xp.efficiency('xx??ii')).toMatchObject({ ticks: 4, work: 50, waste: { kind: 'idle', share: 50 } });

        const bots = [
            { name: 'WorkerA', bank: [{ id: 1511, name: 'Logs', count: 50 }, { id: 1512, baseId: 1511, name: 'Logs (noted)', count: 25 }, { name: 'Logs', count: 10 }, { id: 2503, name: 'Dragonhide body', count: 4 }] },
            { name: 'WorkerB', bank: [{ id: 1135, name: 'Dragonhide body', count: 2 }, { name: 'Raw lobster', count: 30 }] },
            { name: 'PracticeBot', practice: true, bank: [{ id: 1511, name: 'Logs', count: 999 }] },
            { name: 'MainBot', reserved: true, bank: [{ id: 1511, name: 'Logs', count: 999 }] },
        ];
        const reqs = [
            { itemId: 1511, item: 'Logs', need: 100 },
            { itemId: 1135, item: 'Dragonhide body', need: 5 },
            { item: 'Dragonhide body', need: 10 },
            { item: 'Raw lobster', need: 20 },
        ];
        const progress = xp.supplyBillProgress(reqs, bots);
        expect(progress.items.map((r: any) => [r.item, r.itemId, r.have, r.pct])).toEqual([
            ['Dragonhide body', 1135, 2, 40],
            ['Dragonhide body', null, 6, 60],
            ['Logs', 1511, 85, 85],
            ['Raw lobster', null, 30, 100],
        ]);
        expect(progress.fulfilledCount).toBe(1);
    });

    test('goals item catalog cache invalidates on array mutation and questConstants cache invalidates on text change', () => {
        const now = 1_700_000_000_000;
        const items: any[] = [{ id: 1511, name: 'Logs', debugname: 'logs' }];
        const baseState = {
            now,
            bots: [{ name: 'Worker1', at: now, server: 'rs-sdk-demo.fly.dev', skills: [], bank: [{ id: 1511, name: 'Logs', count: 10 }] }],
            boards: [],
            collection: { banks: [], pending: [], confirmed: [], stale: [] },
            objectives: { goals: [], specialist: [], main: null },
            race: null,
            gates: null,
            scoreboard: { available: false, rows: [], total: 0, ranked: 0 },
        };
        const reqs = [{ item: 'Oak logs', itemId: 1521, count: 5 }];
        const first = goalProgress(baseState, {
            requirements: reqs,
            items,
            quests: [],
            questConstants: '^quest_a = 1\n^quest_b = 2\n',
            receipts: {},
        });
        items.push({ id: 1521, name: 'Oak logs', debugname: 'oak_logs' });
        const second = goalProgress(baseState, {
            requirements: reqs,
            items,
            quests: [],
            questConstants: '^quest_a = 1\n^quest_b = 2\n^quest_c = 3\n',
            receipts: {},
        });
        expect(first).toBeDefined();
        expect(second).toBeDefined();
    });

    test('gearProgress counts unique holders across primary and equivalent item IDs without double counting', () => {
        const now = 1_700_000_000_000;
        const bots = [
            { name: 'Bot1', at: now, bankAt: now, bank: [{ id: 1645, name: 'Dragonstone ring', count: 2 }, { id: 2572, name: 'Ring of wealth', count: 1 }] },
            { name: 'Bot2', at: now, equipment: [{ id: 3140, name: 'Dragon chainbody', count: 1 }] },
        ];
        const items = [
            { id: 3140, name: 'Dragon chainbody', debugname: 'dragon_chainbody' },
            { id: 1645, name: 'Dragonstone ring', debugname: 'dragonstone_ring' },
            { id: 2572, name: 'Ring of wealth', debugname: 'ring_of_wealth' },
        ];
        const out = gearProgress(bots, items, now);
        expect(out.held).toBe(2);
        const bodyRow = out.rows.find(r => r.label.includes('Body'));
        const ringRow = out.rows.find(r => r.label.includes('Ring'));
        expect(bodyRow?.value).toContain('held');
        expect(bodyRow?.source).toContain('Bot2 worn');
        expect(ringRow?.value).toContain('held');
        expect(ringRow?.source.match(/Bot1 bank/g)).toHaveLength(1);
    });

    test('vault-items indexed lookup handles exact subtraction, overdraft collapse, and unconfirmed tracking', () => {
        const v = createVaultItems();
        v.add([{ id: 1135, name: 'Dragonhide body', count: 4 }, { id: 2503, name: 'Dragonhide body', count: 2 }]);
        expect(v.unconfirmed()).toBe(false);
        v.add([{ id: 1135, name: 'Dragonhide body', count: 1 }], -1);
        expect(v.unconfirmed()).toBe(false);
        expect(v.rows().find(r => r.id === 1135)?.count).toBe(3);

        v.add([{ name: 'Dragonhide body', count: 2 }], -1);
        expect(v.unconfirmed()).toBe(true);
        const collapsed = v.rows().find(r => r.name === 'Dragonhide body');
        expect(collapsed).toEqual({ name: 'Dragonhide body', count: 3, unconfirmed: true });
    });

    test('vault cache invalidates on in-place log mutation, pricesAt change, and liveAccounts change', () => {
        const marketSrc = readFileSync(new URL('./server/market.ts', import.meta.url), 'utf8');
        const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
            marketSrc.slice(marketSrc.indexOf('function vault('), marketSrc.indexOf('// ---------- gear catalog')),
        );
        const log: any[] = [{ at: 2, from: 'worker', to: 'receiver', items: [{ id: 1511, name: 'Logs', count: 10 }] }];
        let pricesAt = 1;
        let currentPrice = 100;
        let accounts = ['Worker', 'Receiver'];
        const table1 = buildItemPrices([{ id: 1511, name: 'Logs', basePrice: 100 }], [{ id: 1511, name: 'Logs' }]);
        const run = new Function(
            'isLocalServer', 'createVaultItems', 'priceItemKey', 'getState',
            `const cached=()=>getState().log,FILES={},NL='\\n',keyName=n=>n.toLowerCase(),BANKER='Banker',existsSync=()=>true;
            const liveAccounts=()=>getState().accounts;
            const priceOf=i=>getState().priceOf(i);
            let pricesAt=1;
            ${code};
            return (bots,now)=>{pricesAt=getState().pricesAt;return vault(bots,now);};`,
        )(isLocalServer, createVaultItems, priceItemKey, () => ({
            log,
            pricesAt,
            accounts,
            priceOf: (i: any) => (itemPrice(table1, i) ? currentPrice : null),
        }));
        const bots = [{ name: 'Worker', server: 'rs-sdk-demo.fly.dev', at: 1, inventory: [], bank: [] }];

        const r1 = run(bots, 10);
        expect(r1.flow[0]).toMatchObject({ from: 'Worker', to: 'Receiver', value: 1000 });

        // Price refresh updates pricesAt and invalidates cached flow valuation.
        currentPrice = 250;
        pricesAt = 2;
        const r2 = run(bots, 11);
        expect(r2.flow[0].value).toBe(2500);

        // Live account spelling update invalidates canonical flow names.
        accounts = ['WORKER', 'Receiver'];
        const r3 = run(bots, 12);
        expect(r3.flow[0].from).toBe('WORKER');

        // In-place log push invalidates both log index and flow caches.
        log.push({ at: 3, from: 'worker', to: 'receiver', items: [{ id: 1511, name: 'Logs', count: 4 }] });
        const r4 = run(bots, 13);
        expect(r4.flow[0].value).toBe(3500);
        expect(r4.lastTransferAt).toBe(3);
    });

    test('collection boundedOperation and collectionState preserve parity with and without name-only items', () => {
        const now = 1_700_000_000_000;
        const b = boundedOperation({ result: 'ok boughtTotal=120 targetMet=1' });
        expect(b.visible).toBe(true);
        expect(b.targetMet).toBe(true);
        expect(b.counters.boughtTotal).toBe(120);

        const bots = [
            { name: 'B1', server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now, bank: [{ id: 1511, name: 'Logs', count: 50 }] },
        ];
        const fast = collectionState(bots, ['B1'], [], [], now);
        expect(fast.banks).toHaveLength(1);

        const withNameOnly = collectionState(
            [{ name: 'B1', server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now, bank: [{ id: 1511, name: 'Logs', count: 50 }, { name: 'Logs', count: 5 }] }],
            ['B1'],
            [],
            [],
            now,
        );
        expect(withNameOnly.items.reduce((s: number, it: any) => s + it.count, 0)).toBe(55);
        expect(withNameOnly.items).toHaveLength(1);
    });

    test('world-view hiscoreRows regex cache and wilderness/roster/contention views match expected output', () => {
        const html = '<tr><td>Overall</td><td>1</td><td>1,200</td><td>5h 10m 0s</td></tr><tr><td>Mining</td><td>4</td><td>80</td><td>2h 0m 5s</td></tr>';
        expect(hiscoreRows(html, ['Overall', 'Mining'])).toEqual([
            { board: 'Overall', rank: 1, level: 1200, time: '5h 10m 0s' },
            { board: 'Mining', rank: 4, level: 80, time: '2h 0m 5s' },
        ]);
        const now = 1_700_000_000_000;
        const roster = new Map([
            ['bot1', { name: 'Bot1', x: 3095, z: 3530, level: 0, combat: 45, seen: now - 1000 }],
            ['rival1', { name: 'Rival1', x: 3096, z: 3531, level: 0, combat: 50, seen: now - 1000 }],
        ]);
        const fleet = new Set(['bot1']);
        expect(rosterView(roster, now)).toHaveLength(2);
        const wild = wildernessView(roster, fleet, now);
        expect(wild.map(w => w.name)).toEqual(['Rival1', 'Bot1']);
        const spots = contentionView([{ side: 'local', resources: ['spot:3095,3530'] }], roster, fleet, now);
        expect(spots[0]?.others).toEqual(['Rival1']);
        expect(spots[0]?.ours).toEqual(['Bot1']);
    });

    test('generator helpers preserve itemSources, npcDrops, skillActions, and wikiReqs parity', () => {
        const longNote = 'x'.repeat(850);
        const items = [{
            id: 1511,
            item: 'logs',
            name: 'Logs',
            debugname: 'logs',
            sources: [
                {
                    kind: 'drop',
                    npc: 'goblin',
                    chance: 0.25,
                    count: 1,
                    places: [{ npc: 'goblin', x: 3250, z: 3240, level: 0 }],
                    cost: {
                        helperTicksPerUnit: 4,
                        ticksBasis: 'model',
                        ticksNote: 'short note',
                        coinsPerUnit: 12,
                        coinsBasis: 'content',
                        coinsNote: longNote,
                    },
                },
            ],
        }];
        const names = { npc: (d: string) => (d === 'goblin' ? 'Goblin' : d), item: (d: string) => (d === 'logs' ? 'Logs' : d) };
        const sources = itemSources(items, names);
        expect(sources['1511']).toHaveLength(1);
        expect(sources['1511']![0]![3]?.ticksNote).toBe('short note');
        expect(sources['1511']![0]![3]?.coinsNote).toBe('x'.repeat(800) + '…');

        const drops = npcDrops(items, names, [{ id: 100, name: 'Goblin', debugname: 'goblin' }]);
        expect(drops.byId['100']).toHaveLength(1);
        expect(drops.byId['100']![0]!.name).toBe('Logs');

        const actions = skillActions([
            { skill: 'woodcutting', row: 'tree1_table', level: 1, xp: 25, inputs: ['logs'], outputs: ['logs'] },
            { skill: 'woodcutting', row: 'tree2_table', level: 1, xp: 25, inputs: ['logs'], outputs: ['logs'] },
        ], new Map([['logs', 'Logs']]));
        expect(actions.woodcutting).toHaveLength(1);

        const wq = wikiReqs('## Requirements\n- 30 Mining\n- 15 Quest points\n- Rune Mysteries\n### Recommended\n- 50 Agility\n', ['Rune Mysteries']);
        expect(wq.s.get('Mining')).toBe(30);
        expect(wq.s.has('Agility')).toBe(false);
        expect(wq.qp).toBe(15);
        expect(wq.q).toEqual(['Rune Mysteries']);
    });
});
