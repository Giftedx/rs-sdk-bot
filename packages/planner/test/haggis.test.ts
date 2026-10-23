import { test, expect } from 'bun:test';
import { bestSet, haggisActivities, haggisTravel, haggisUnsourceable, LEVERS, loadSnapshot, schedule, SCENARIOS, suppliesFor, TRICKS, XP99, type Activity, type Board } from '../src/haggis';
import { leg, place, resolve, RUN_TICKS_PER_TILE, START_TICKS, type TravelModel } from '../src/travel';
import { join } from 'node:path';

const clock = (id: Board['id'], deadline: number): Board => ({ id, label: id, rule: { kind: 'clock', deadline } });
const job = (id: string, skill: Activity['serves'][number], ticks: number, extra: Partial<Activity> = {}): Activity => ({
    id, label: id, serves: [skill], ticks: { floor: ticks, realistic: ticks }, xp: { [skill]: 'to99' }, evidence: 'ESTIMATE', source: 'test', ...extra,
});
const opts = { mode: 'floor' as const, tricks: new Set<never>() };
const finish = (r: ReturnType<typeof schedule>, id: string) => r.boards.find(b => b.id === id)!;

test('schedules by earliest deadline, not by input order', () => {
    const boards = [clock('mining', 100), clock('cooking', 20)];
    const r = schedule(boards, [job('mine', 'mining', 50), job('cook', 'cooking', 10)], opts);
    expect(r.order.map(p => p.id)).toEqual(['cook', 'mine']);
    expect(finish(r, 'cooking')).toMatchObject({ finish: 10, slack: 10, status: 'WIN' });
    expect(finish(r, 'mining')).toMatchObject({ finish: 60, slack: 40, status: 'WIN' });
});

test('a prerequisite inherits the earlier deadline of the activity that needs it', () => {
    const boards = [clock('agility', 1000), clock('attack', 100), clock('fishing', 500)];
    const acts = [
        job('fish', 'fishing', 30),
        job('agil', 'agility', 20),
        job('quest', 'attack', 10, { requires: ['agil'] }),
    ];
    const r = schedule(boards, acts, opts);
    expect(r.order.map(p => p.id)).toEqual(['agil', 'quest', 'fish']);
});

test('a background timer overlaps the next foreground activity', () => {
    const boards = [clock('cooking', 40), clock('fletching', 60)];
    const acts: Activity[] = [
        job('wine', 'cooking', 2, { background: { floor: 20, realistic: 20 } }),
        job('fletch', 'fletching', 49),
    ];
    const r = schedule(boards, acts, opts);
    expect(finish(r, 'cooking').finish).toBe(22); // 2 foreground + 20 timer
    expect(finish(r, 'fletching').finish).toBe(51); // starts at 2, not at 22
    expect(r.idle).toBe(0);
});

test('one activity feeding two skills finishes both (superheat, combat Hitpoints)', () => {
    const boards = [clock('smithing', 5000), clock('magic', 5000)];
    const superheat: Activity = { id: 'sh', label: 'sh', serves: ['smithing', 'magic'], train: { skill: 'smithing', toLevel: 99, xpPerTick: { floor: 500, realistic: 500 }, side: { magic: 1 } }, evidence: 'ESTIMATE', source: 'test' };
    const r = schedule(boards, [superheat], opts);
    const ticks = Math.ceil(XP99 / 500);
    expect(r.order[0]!.ticks).toBe(ticks);
    expect(finish(r, 'smithing').finish).toBe(ticks);
    expect(finish(r, 'magic').finish).toBe(ticks);
});

test('lump quest XP counts toward a later training activity', () => {
    const boards = [clock('attack', 10_000)];
    const quest: Activity = { id: 'q', label: 'q', serves: ['attack'], ticks: { floor: 100, realistic: 100 }, lump: true, xp: { attack: XP99 / 2 }, evidence: 'ESTIMATE', source: 'test' };
    const train: Activity = { id: 't', label: 't', serves: ['attack'], train: { skill: 'attack', toLevel: 99, xpPerTick: { floor: 1000, realistic: 1000 } }, requires: ['q'], evidence: 'ESTIMATE', source: 'test' };
    const r = schedule(boards, [quest, train], opts);
    expect(r.order[1]!.ticks).toBe(Math.ceil(XP99 / 2 / 1000));
    expect(finish(r, 'attack').finish).toBe(100 + Math.ceil(XP99 / 2 / 1000));
});

test('detects infeasible boards and reports by how much', () => {
    const boards = [clock('cooking', 38), clock('fletching', 58)];
    const r = schedule(boards, [job('cook', 'cooking', 40), job('fletch', 'fletching', 49)], opts);
    expect(finish(r, 'cooking')).toMatchObject({ status: 'LATE', slack: -2 });
    expect(finish(r, 'fletching')).toMatchObject({ status: 'LATE', slack: -31 });
});

test('a tie with #1 is not a win', () => {
    const r = schedule([clock('cooking', 10)], [job('cook', 'cooking', 10)], opts);
    expect(finish(r, 'cooking').status).toBe('TIE');
});

test('an unmet level requirement with no way to meet it is reported as blocked', () => {
    const r = schedule([clock('attack', 100)], [job('q', 'attack', 5, { minLevel: { agility: 25 } })], opts);
    expect(r.blocked).toEqual(['q']);
    expect(finish(r, 'attack').status).toBe('NEVER');
});

test('best set moves the longest early job to the end (Moore-Hodgson)', () => {
    // EDF: a(10) ok, b(+50 = 60 > 40) late. Dropping b (longest) lets c win too.
    const boards = [clock('cooking', 20), clock('fletching', 40), clock('crafting', 45)];
    const acts = [job('a', 'cooking', 10), job('b', 'fletching', 50), job('c', 'crafting', 30)];
    const { result, sacrificed } = bestSet(boards, acts, opts);
    expect(sacrificed).toEqual(['fletching']);
    expect(result.boards.filter(b => b.status === 'WIN').map(b => b.id).sort()).toEqual(['cooking', 'crafting']);
});

test('variants: a trick option is used only when its flag is on, and only if it is faster', () => {
    const boards = [clock('cooking', 100)];
    const acts: Activity[] = [
        job('legal', 'cooking', 30, { variant: { group: 'c', option: 'legal' } }),
        job('trick', 'cooking', 10, { variant: { group: 'c', option: 'trick', trick: 'loginWine' } }),
    ];
    expect(schedule(boards, acts, opts).chosen).toEqual(['legal']);
    expect(schedule(boards, acts, { mode: 'floor', tricks: new Set(['loginWine'] as const) }).chosen).toEqual(['trick']);
});

test('variants: the route with the earlier Overall finish wins over the raw-tick-best one, per mode', () => {
    // 'split' trains Magic alone (100 ticks) and leaves Smithing to a 200-tick train row; 'combo' (150 floor, 400
    // realistic) gives both 99s. Raw ticks pick 'split' (100 < 150); Overall: floor split 300 vs combo 150.
    const boards = [clock('magic', 1000), clock('smithing', 2000), clock('overall', 5000)];
    const startXp = Object.fromEntries(['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'mining', 'herblore', 'agility', 'thieving', 'runecraft'].map(s => [s, XP99]));
    const acts: Activity[] = [
        job('split', 'magic', 100, { variant: { group: 'g', option: 'split' } }),
        { ...job('combo', 'magic', 150, { variant: { group: 'g', option: 'combo' } }), serves: ['magic', 'smithing'], ticks: { floor: 150, realistic: 400 }, xp: { magic: 'to99', smithing: 'to99' } },
        { id: 'smith', label: 'smith', serves: ['smithing'], train: { skill: 'smithing', toLevel: 99, xpPerTick: { floor: XP99 / 200, realistic: XP99 / 200 } }, evidence: 'ESTIMATE', source: 'test' },
    ];
    const run = (mode: 'floor' | 'realistic', route?: 'ticks') => schedule(boards, acts, { mode, tricks: new Set(), startXp, route });
    expect(run('floor', 'ticks').route).toEqual({ g: 'split' });
    expect(run('floor', 'ticks').overallFinish).toBe(300);
    expect(run('floor')).toMatchObject({ route: { g: 'combo' }, overallFinish: 150 });
    // Realistic: combo 400 > split 300, so the modes choose different routes.
    expect(run('realistic')).toMatchObject({ route: { g: 'split' }, overallFinish: 300, lastSkill: 'smithing' });
    // A forced option is kept; bestSet reports the same route as schedule.
    expect(schedule(boards, acts, { mode: 'floor', tricks: new Set(), startXp, force: { g: 'split' } }).route).toEqual({ g: 'split' });
    expect(bestSet(boards, acts, { mode: 'floor', tricks: new Set(), startXp }).result.route).toEqual({ g: 'combo' });
});

test('a supply made by a row of the route is not staged by a helper', () => {
    const boards = [clock('fletching', 100), clock('ranged', 1000)];
    const acts: Activity[] = [
        job('fletch', 'fletching', 10, { supplies: [{ item: 'arrowtips', count: 5 }] }),
        job('range', 'ranged', 50, { requires: ['fletch'], supplies: [{ item: 'arrow', count: 5, from: 'fletch' }, { item: 'bow', count: 1 }] }),
    ];
    expect(suppliesFor(acts, opts, boards).map(s => s.item)).toEqual(['arrowtips', 'bow']);
    expect(suppliesFor(acts.slice(1), opts, boards).map(s => s.item)).toEqual(['arrow', 'bow']);
});

test('the real table loads, schedules without blocks, and covers all 24 boards', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    expect(boards).toHaveLength(24);
    const r = schedule(boards, haggisActivities(), { mode: 'realistic', tricks: new Set() });
    expect(r.blocked).toEqual([]);
    expect(r.boards.every(b => b.finish !== null)).toBe(true);
});

test('content level gates: gold superheat after Smithing 40, herb rows after Druidic Ritual (Herblore 3)', () => {
    // superheat.rs2:37 + smelting.struct:63 (gold 40); identify.param:1-3 and brew_potion.param:1-3 (Herblore 3).
    const acts = haggisActivities();
    const byId = new Map(acts.map(a => [a.id, a]));
    expect(byId.get('superheat')!.minLevel?.smithing).toBe(40);
    for (const id of ['herb-drops', 'herb-unf', 'herblore-10']) {
        expect(byId.get(id)!.minLevel?.herblore).toBe(3);
        expect(byId.get(id)!.requires).toContain('druid');
    }
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    for (const mode of ['floor', 'realistic'] as const) {
        const r = schedule(boards, acts, { mode, tricks: new Set(), force: { 'magic-smithing': 'superheat' } });
        const at = (id: string) => r.order.find(p => p.id === id)!;
        expect(at('smith-40').end).toBeLessThanOrEqual(at('superheat').start);
        expect(at('druid').landsAt).toBeLessThanOrEqual(at('herb-drops').start);
    }
});

test('a guest fills the dead ticks of its host; the rest runs right after the host', () => {
    const boards = [clock('thieving', 10_000), clock('magic', 10_000)];
    const acts: Activity[] = [
        job('thieve', 'thieving', 100, { deadTicks: { floor: 60, realistic: 60 } }),
        job('enchant', 'magic', 80, { inside: 'thieve' }),
    ];
    const r = schedule(boards, acts, opts);
    expect(finish(r, 'thieving').finish).toBe(100);
    expect(finish(r, 'magic').finish).toBe(120); // 60 of 80 absorbed, 20 after the host
    expect(r.order.find(p => p.id === 'enchant')!.ticks).toBe(20);
    // Without the host the guest runs alone.
    const alone = schedule([clock('magic', 10_000)], [job('enchant', 'magic', 80, { inside: 'thieve' })], opts);
    expect(finish(alone, 'magic').finish).toBe(80);
});

test('a guest that fits completely adds no foreground ticks, and waits for its host even with an earlier deadline', () => {
    const boards = [clock('magic', 50), clock('thieving', 10_000)];
    const acts: Activity[] = [
        job('thieve', 'thieving', 100, { deadTicks: { floor: 60, realistic: 60 } }),
        job('enchant', 'magic', 40, { inside: 'thieve' }),
    ];
    const r = schedule(boards, acts, opts);
    expect(r.order.map(p => p.id)).toEqual(['thieve', 'enchant']);
    expect(finish(r, 'magic').finish).toBe(100); // XP accrues over the host span
    expect(r.endTick).toBe(100);
});

test('stun relog is skipped when the guests use more stun ticks than relog saves', () => {
    const boards = [clock('thieving', 10_000), clock('magic', 10_000)];
    const host = job('thieve', 'thieving', 100, { deadTicks: { floor: 60, realistic: 60 }, trickSpeedup: { trick: 'stunRelog', factor: 0.8 } });
    const relog = { mode: 'floor' as const, tricks: new Set(['stunRelog'] as const) };
    const withGuest = schedule(boards, [host, job('enchant', 'magic', 50, { inside: 'thieve' })], relog);
    expect(finish(withGuest, 'thieving').finish).toBe(100); // 50 absorbed > 20 saved by relog
    const noGuest = schedule(boards, [host, job('enchant', 'magic', 50)], relog);
    expect(finish(noGuest, 'thieving').finish).toBe(80);
});

test('levers: add rows exist only when on, drop rows only when off; owner levers are off by default', () => {
    const boards = [clock('cooking', 100)];
    const acts: Activity[] = [
        job('old', 'cooking', 30, { lever: { id: 'L', role: 'drop' } }),
        job('new', 'cooking', 10, { lever: { id: 'L', role: 'add' } }),
        job('own', 'cooking', 1, { lever: { id: 'O', role: 'add', owner: true } }),
    ];
    expect(schedule(boards, acts, opts).chosen).toEqual(['new']);
    expect(schedule(boards, acts, { ...opts, disable: new Set(['L']) }).chosen).toEqual(['old']);
    expect(schedule(boards, acts, { ...opts, owner: new Set(['O']) }).chosen).toEqual(['new', 'own']);
});

test('lever patches set fields, add requirements and add side XP only while the lever is on', () => {
    const boards = [clock('defence', 100_000), clock('ranged', 100_000)];
    const def: Activity = {
        id: 'def', label: 'def', serves: ['defence'], evidence: 'ESTIMATE', source: 'test',
        train: { skill: 'defence', toLevel: 99, xpPerTick: { floor: 400, realistic: 400 } },
        patches: [{ lever: 'cannon', addRequires: ['cq'], addSide: { ranged: 1 } }],
    };
    const cq = job('cq', 'ranged', 7, { xp: {} });
    const on = schedule(boards, [def, cq], opts);
    expect(on.order.map(p => p.id)).toEqual(['cq', 'def']);
    expect(finish(on, 'ranged').finish).toBe(7 + Math.ceil(XP99 / 400));
    const off = schedule(boards, [def, cq], { ...opts, disable: new Set(['cannon']) });
    expect(finish(off, 'ranged').finish).toBe(null);
});

test('quest points: all points before the leader playtime is a secure win; more points later only holds', () => {
    const qp = (leaderPoints: number, leaderTicks: number): Board => ({ id: 'questpoints', label: 'qp', rule: { kind: 'qp', leaderPoints, leaderTicks, maxPoints: 5 } });
    const q = (id: string, ticks: number, points: number): Activity => ({ id, label: id, serves: ['questpoints'], ticks: { floor: ticks, realistic: ticks }, lump: true, qp: points, evidence: 'ESTIMATE', source: 'test' });
    const acts = [q('a', 10, 3), q('b', 10, 1), q('c', 10, 1)];
    expect(finish(schedule([qp(4, 100)], acts, opts), 'questpoints')).toMatchObject({ status: 'WIN', finish: 30, slack: 70, deadline: 100 });
    expect(finish(schedule([qp(4, 25)], acts, opts), 'questpoints')).toMatchObject({ status: 'HOLD', finish: 30, slack: -5 });
    expect(finish(schedule([qp(4, 25)], acts.slice(0, 2), opts), 'questpoints')).toMatchObject({ status: 'WIN', finish: 20, slack: 5 });
    expect(finish(schedule([qp(4, 15)], acts.slice(0, 2), opts), 'questpoints')).toMatchObject({ status: 'LATE', finish: 20 });
    expect(finish(schedule([qp(5, 25)], acts, opts), 'questpoints')).toMatchObject({ status: 'LATE', finish: 30 });
    // Leader already at the maximum (live: avery 145 at 1,022,262): only an earlier 145 wins.
    expect(finish(schedule([qp(5, 31)], acts, opts), 'questpoints')).toMatchObject({ status: 'WIN', finish: 30, slack: 1 });
});

test('rival levers (research/rival-gap-list.md): ESTIMATE rows, no blocks on or off, no extra quest points', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const acts = haggisActivities();
    const ids = new Set<string>();
    for (const a of acts) {
        if (a.lever?.id.startsWith('rival-')) ids.add(a.lever.id);
        for (const p of a.patches ?? []) if (p.lever.startsWith('rival-')) ids.add(p.lever);
    }
    expect(ids.size).toBe(9);
    for (const a of acts.filter(x => x.id.startsWith('rival-'))) {
        expect(a.ticks?.evidence).toBe('ESTIMATE');
        expect(a.ticks?.source).toContain('bleugreen/rs-sdk@3bd2ab0a');
        expect(a.qp).toBe(0); // their points are inside quests-rest
    }
    for (const disable of [new Set<string>(), ids]) {
        const r = schedule(boards, acts, { mode: 'realistic', tricks: new Set(), disable });
        expect(r.blocked).toEqual([]);
        expect(r.qp).toBe(142);
    }
});

// ---------- Travel (packages/planner/src/travel.ts) ----------

const travelModel = (): TravelModel => ({
    places: { a: { x: 3200, z: 3200 }, b: { x: 3260, z: 3200 }, far: { x: 3200, z: 3500 } },
    cache: {
        legs: { 'a>b': { runTicks: 40, tiles: 80 } },
        nearestBank: { b: { bank: 'bank:x', runTicks: 7, method: 'world.json' } },
        banks: { 'bank:x': { x: 3265, z: 3205 } },
    },
});

test('travel: the walk between two places is added before the second activity', () => {
    const boards = [clock('cooking', 1000), clock('fletching', 1000)];
    const acts = [job('cook', 'cooking', 10, { at: 'a' }), job('fletch', 'fletching', 20, { at: 'b', requires: ['cook'] })];
    const r = schedule(boards, acts, { ...opts, travel: travelModel() });
    const f = r.order.find(p => p.id === 'fletch')!;
    expect(f).toMatchObject({ travel: 40 + START_TICKS, from: 'a', to: 'b', method: 'path', start: 10 + 40 + START_TICKS });
    expect(finish(r, 'fletching').finish).toBe(10 + 42 + 20);
    expect(r.travel).toBe(42);
    // Without a cached leg the estimate is Chebyshev x RUN_TICKS_PER_TILE + start ticks.
    const est = schedule(boards, [job('cook', 'cooking', 10, { at: 'a' }), job('fletch', 'fletching', 20, { at: 'far', requires: ['cook'] })], { ...opts, travel: travelModel() });
    expect(est.order[1]).toMatchObject({ travel: Math.ceil(300 * RUN_TICKS_PER_TILE) + START_TICKS, method: 'estimate' });
});

test('travel: activities at the same place, or anywhere, add 0', () => {
    const boards = [clock('cooking', 1000), clock('fletching', 1000), clock('crafting', 1000)];
    const acts = [
        job('cook', 'cooking', 10, { at: 'a' }),
        job('fletch', 'fletching', 20, { at: 'a', requires: ['cook'] }),
        job('craft', 'crafting', 5, { at: 'anywhere', requires: ['fletch'] }),
    ];
    const r = schedule(boards, acts, { ...opts, travel: travelModel() });
    expect(r.travel).toBe(0);
    expect(r.order.map(p => p.travel ?? 0)).toEqual([0, 0, 0]);
    expect(finish(r, 'crafting').finish).toBe(35);
});

test('travel: bank = the nearest bank of the place (world.json); bank trips and via legs are inside the activity', () => {
    const m = travelModel();
    expect(resolve(m, 'b', 'bank')).toBe('bank:x');
    expect(leg(m, 'b', 'bank:x')).toEqual({ ticks: 7 + START_TICKS, method: 'world.json' });
    const boards = [clock('smithing', 10_000)];
    const r = schedule(boards, [job('smith', 'smithing', 100, { at: 'b', bankTrips: 3 })], { ...opts, travel: m });
    expect(r.order[0]).toMatchObject({ ticks: 100 + 3 * 2 * 9, inner: 54, travel: 0 });
    const v = schedule([clock('runecraft', 10_000)], [job('rc', 'runecraft', 100, { at: 'a', via: ['b'] })], { ...opts, travel: m });
    expect(v.order[0]).toMatchObject({ ticks: 142, inner: 42 });
});

test('travel: a place on an island is reached through its port by boat', () => {
    const isl = { id: 'k', port: 'a', landing: 'b', boatTicks: 18, source: 'test' };
    const m: TravelModel = { places: { a: { x: 3200, z: 3200 }, b: { x: 3100, z: 3100, island: isl }, c: { x: 3110, z: 3100, island: isl } }, cache: { legs: {}, nearestBank: {}, banks: {} } };
    // a is the port: 0 walk, boat 18, then b -> c (estimate 10 x 0.6 -> 6, + 2)
    expect(leg(m, 'a', 'c').ticks).toBe(18 + Math.ceil(10 * RUN_TICKS_PER_TILE) + START_TICKS);
    expect(leg(m, 'b', 'c').method).toBe('estimate');
});

test('OUT rows (content bugs) are never scheduled; the legal Cooking route replaces cook-35', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const acts = haggisActivities();
    const out = acts.filter(a => a.out).map(a => a.id).sort();
    expect(out).toEqual(['charge', 'cook-35', 'craft', 'fletch', 'fm-pyre', 'herb', 'login-wine', 'mage-arena', 'magic', 'mortton-oil', 'relog']);
    for (const tricks of [new Set<never>(), new Set(TRICKS)]) {
        const r = schedule(boards, acts, { mode: 'realistic', tricks, owner: new Set(['charge-spam']), travel: haggisTravel() });
        for (const id of out) expect(r.chosen).not.toContain(id);
        expect(r.chosen).toEqual(expect.arrayContaining(['cooks-assistant', 'cook-range-35', 'bank-wine', 'wine-timer']));
        expect(r.blocked).toEqual([]);
        expect(r.qp).toBe(142);
    }
});

test('no active row needs an item with no legal source at this scale (research/supply-logistics.md)', () => {
    const bad = haggisUnsourceable();
    expect(bad.map(u => u.item)).toEqual(expect.arrayContaining(['torstol potion (unf)', 'snapdragon potion (unf)', 'toadflax potion (unf)', 'uncut dragonstone', 'dragonstone amulet', 'cosmic rune', 'rune dart tips']));
    const max = new Map(bad.map(u => [u.item, u.max]));
    const acts = haggisActivities();
    // Each active row alone, with the supplies its lever patches can set.
    for (const a of acts.filter(a => !a.out)) {
        for (const s of [...(a.supplies ?? []), ...(a.patches ?? []).flatMap(p => p.set?.supplies ?? [])]) {
            if (max.has(s.item)) expect({ row: a.id, item: s.item, count: s.count }).toEqual({ row: a.id, item: s.item, count: Math.min(s.count, max.get(s.item)!) });
        }
    }
    // The summed manifest of every scenario, with and without the safe levers.
    for (const sc of SCENARIOS) for (const disable of [new Set<string>(), new Set(LEVERS.map(l => l.id))]) {
        for (const s of suppliesFor(acts, { mode: 'realistic', tricks: new Set(sc.tricks), disable })) {
            if (max.has(s.item)) expect({ scenario: sc.id, item: s.item, count: s.count }).toEqual({ scenario: sc.id, item: s.item, count: Math.min(s.count, max.get(s.item)!) });
        }
    }
    // Each OUT row for supply names its replacement, and the replacement exists.
    for (const a of acts.filter(a => a.out?.reason.startsWith('no legal source at this scale'))) expect(acts.some(b => b.id === a.out!.replacement && !b.out)).toBe(true);
});

test('every row of the real table has a known place, and the travel schedule has no blocks', () => {
    const m = haggisTravel();
    for (const a of haggisActivities()) {
        expect(a.at).toBeDefined();
        for (const p of [a.at!, a.endAt, ...(a.via ?? [])]) if (p && p !== 'anywhere' && p !== 'bank') expect(() => place(m, p)).not.toThrow();
    }
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const r = schedule(boards, haggisActivities(), { mode: 'floor', tricks: new Set(), travel: m });
    expect(r.blocked).toEqual([]);
    expect(r.travel).toBeGreaterThan(0);
});

test('waterfall-late and def-at-ranged-spot (research/combat-measure.md section 7): each saves Overall ticks as the last lever', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    for (const mode of ['floor', 'realistic'] as const) {
        const run = (disable: string[]) => schedule(boards, acts, { mode, tricks: new Set(), travel, disable: new Set(disable) });
        const all = run([]);
        expect(all.blocked).toEqual([]);
        const overall = finish(all, 'overall').finish!;
        // Defence trains right after the Ranged row, at the same place: no walk between them.
        const ids = all.order.map(p => p.id);
        const def = all.order[ids.indexOf('def-top')]!;
        expect(ids.indexOf('def-top')).toBe(ids.indexOf('ranged') + 1);
        expect(def.travel ?? 0).toBe(0);
        expect(finish(all, 'defence').finish!).toBeLessThan(overall);
        // Waterfall runs after Overall; Strength still reaches 99 before Overall.
        expect(all.order.find(p => p.id === 'waterfall')!.start).toBeGreaterThanOrEqual(overall);
        expect(finish(all, 'strength').finish!).toBeLessThan(overall);
        for (const lever of ['waterfall-late', 'def-at-ranged-spot']) expect(finish(run([lever]), 'overall').finish!).toBeGreaterThan(overall);
    }
});
