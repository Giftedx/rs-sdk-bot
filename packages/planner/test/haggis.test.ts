import { test, expect } from 'bun:test';
import { applyLevers, bestSet, haggisActivities, haggisTravel, haggisUnsourceable, LEVERS, loadSnapshot, overallRequirementsFor, schedule, scheduleOverall, SCENARIOS, suppliesFor, TRICKS, XP99, type Activity, type Board } from '../src/haggis';
import { leg, place, resolve, RUN_TICKS_PER_TILE, START_TICKS, TRAVEL_FILE, type TravelModel } from '../src/travel';
import { join } from 'node:path';
import { xpForLevel } from '../src/curve';
import { readFileSync } from 'node:fs';
import { supplyBill } from '../src/supply-bill';

test.each([
    ['magic', 'sapphire ring', 1637, 1649],
    ['magic', 'emerald ring', 1639, 1650],
    ['magic', 'ruby ring', 1641, 1651],
    ['magic', 'diamond ring', 1643, 1652],
    ['magic', 'dragonstone amulet', 1702, 1683],
    ['ranged', 'magic shortbow', 861, 72],
    ['ranged', 'yew shortbow', 857, 68],
    ['trade-start', 'pot of flour', 1933, 2516],
    ['trade-start', 'raw shrimps', 317, 2514],
    ['trade-start', 'coins', 995, 617],
    ['woodcut', 'logs', 1511, 2511],
    ['fish', 'logs', 1511, 2511],
    ['fm-burn', 'logs', 1511, 2511],
] as const)('route supply identity: %s stages %s as native item %i', (activityId, item, itemId, otherId) => {
    const catalog = JSON.parse(readFileSync(join(import.meta.dir, '../../../knowledge/items.json'), 'utf8'));
    const activity = haggisActivities().find(a => a.id === activityId)!;
    const demand = suppliesFor([activity], { mode: 'realistic', tricks: new Set() }).find(s => s.item === item)!;
    expect(demand).toMatchObject({ item, itemId });
    expect(demand.count).toBeGreaterThan(0);
    const otherStock = supplyBill([demand], catalog, [{ name: 'Other', bank: [{ id: otherId, count: demand.count }] }]);
    expect(otherStock).toMatchObject([{ itemId, ids: [itemId], owned: 0, short: demand.count }]);
    const usableStock = supplyBill([demand], catalog, [{ name: 'Usable', bank: [{ id: itemId, count: demand.count }] }]);
    expect(usableStock).toMatchObject([{ itemId, ids: [itemId], owned: demand.count, short: 0 }]);
});

test('selected runecraft route supplies enough full essence packs for 99', () => {
    const bodySupplies = suppliesFor(haggisActivities(), { mode: 'realistic', tricks: new Set() });
    const natureSupplies = suppliesFor(haggisActivities(), { mode: 'realistic', tricks: new Set(), disable: new Set(['spiders-combat']) });
    let natureXp = 0, natureUsed = 0;
    while (natureXp < xpForLevel(99)) {
        natureXp += 27 * (natureXp < xpForLevel(44) ? 125 : 225);
        natureUsed += 27;
    }
    let bodyXp = 0, bodyUsed = 0;
    while (bodyXp < xpForLevel(99)) {
        bodyXp += 27 * (bodyXp < xpForLevel(20) ? 125 : 187.5);
        bodyUsed += 27;
    }
    expect(bodySupplies.find(s => s.item === 'rune essence')!.count).toBeGreaterThanOrEqual(bodyUsed);
    expect(bodySupplies).toContainEqual({ item: 'air talisman', count: 1 });
    expect(bodySupplies).toContainEqual({ item: 'body talisman', count: 1 });
    expect(natureSupplies.find(s => s.item === 'rune essence')!.count).toBeGreaterThanOrEqual(natureUsed);
    expect(natureSupplies).toContainEqual({ item: 'air talisman', count: 1 });
    expect(natureSupplies).toContainEqual({ item: 'nature talisman', count: 1 });
});

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

test('Overall stages the started route rows and skips later goals and unchosen variants', () => {
    const acts: Activity[] = [
        job('make', 'fletching', 8, { supplies: [{ item: 'arrowtips', count: 5 }] }),
        job('range', 'ranged', 30, { variant:{group:'range',option:'bow'}, supplies: [
            { item: 'arrow', count: 5, from: 'make' },
            { item: 'bow', count: 1 },
            { item: 'food', count: 3, from: 'later' },
        ] }),
        job('alt', 'ranged', 2, { variant:{group:'range',option:'other'}, supplies: [{ item: 'alternate', count: 1 }] }),
        job('later', 'cooking', 5, { supplies: [{ item: 'raw food', count: 3 }] }),
    ];
    const row=(id:string,start:number,end:number)=>({id,label:id,start,end,landsAt:end,ticks:end-start,deadline:100});
    const plan={overallFinish:20,route:{range:'bow'},order:[row('make',0,8),row('range',8,38),row('later',38,43)]};
    expect(overallRequirementsFor(acts, opts, plan).supplies).toEqual([
        {item:'arrowtips',count:5,consumers:['make']},
        {item:'bow',count:1,consumers:['range']},
        {item:'food',count:3,consumers:['range']},
    ]);
    expect(() => overallRequirementsFor(acts, opts, {...plan,overallFinish:null})).toThrow('Overall has no modeled finish');
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
        const r = schedule(boards, acts, { mode, tricks: new Set(), force: { 'magic-smithing': 'superheat', 'herblore-method':'herb-drops' } });
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

test('levers: gameplay techniques need no owner approval; explicit disable remains a comparison option', () => {
    const boards = [clock('cooking', 100)];
    const acts: Activity[] = [
        job('old', 'cooking', 30, { lever: { id: 'L', role: 'drop' } }),
        job('new', 'cooking', 10, { lever: { id: 'L', role: 'add' } }),
        job('own', 'cooking', 1, { lever: { id: 'O', role: 'add', owner: true } }),
    ];
    expect(schedule(boards, acts, opts).chosen).toEqual(['new','own']);
    expect(schedule(boards, acts, { ...opts, disable: new Set(['L']) }).chosen).toEqual(['old','own']);
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
    expect(ids.size).toBe(10);
    for (const a of acts.filter(x => x.id.startsWith('rival-'))) {
        // A rival row is the rival's estimate until we run it ourselves (rival-mm: research/quest-plan.md 1h).
        if (a.ticks?.evidence === 'MEASURED') expect(a.ticks.source).toContain('research/quest-plan.md');
        else {
            expect(a.ticks?.evidence).toBe('ESTIMATE');
            expect(a.ticks?.source).toContain('bleugreen/rs-sdk@3bd2ab0a');
        }
        expect(a.qp).toBe(0); // their points are inside quests-rest
    }
    for (const disable of [new Set<string>(), ids]) {
        const r = schedule(boards, acts, { mode: 'realistic', tricks: new Set(), disable });
        expect(r.blocked).toEqual([]);
        expect(r.qp).toBe(145); // MAX_QP: every quest (research/quest-points-board.md)
    }
    // A retired rival lever (rival-dragon-combat) only runs when named; Doric's 1 QP moves out of quests-short.
    const r = schedule(boards, acts, { mode: 'realistic', tricks: new Set(), disable: new Set(['pvp-relog-combat']), owner: new Set(['rival-dragon-combat']) });
    expect(r.blocked).toEqual([]);
    expect(r.qp).toBe(145);
    expect(r.order.findIndex(p => p.id === 'dragon')).toBeLessThan(r.order.findIndex(p => p.id === 'def-top'));
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

test.each(['hitpoints', 'fishing'] as const)('the Overall plan can relax %s for placement and keep its record deadline', skill => {
    const boards = [clock(skill, 100), clock('mining', 200), clock('overall', 1000)];
    const startXp = Object.fromEntries(['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
        'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting', 'smithing', 'herblore', 'agility',
        'thieving', 'runecraft'].filter(s => s !== skill).map(s => [s, XP99]));
    const acts = [job('early', skill, 10, { at: 'b' }), job('mine', 'mining', 10, { at: 'a' })];
    const options = { ...opts, startXp, travel: { ...travelModel(), start: 'a' } };
    const baseline = schedule(boards, acts, options);
    const overall = scheduleOverall(boards, acts, options);
    expect(baseline.order.map(p => p.id)).toEqual(['early', 'mine']);
    expect(overall.order.map(p => p.id)).toEqual(['mine', 'early']);
    expect(overall.overallFinish!).toBeLessThan(baseline.overallFinish!);
    expect(finish(overall, skill)).toMatchObject({ deadline: 100, sacrificed: true });
    const opposite = { ...options, travel: { ...options.travel, start: 'b' } };
    expect(scheduleOverall(boards, acts, opposite)).toEqual(schedule(boards, acts, opposite));
});

test('the Overall plan tries prerequisites first when deadlines tie', () => {
    const boards = [clock('cooking', 1000), clock('fletching', 1000), clock('smithing', 1000), clock('overall', 1000)];
    const startXp = Object.fromEntries(['attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic',
        'woodcutting', 'fishing', 'firemaking', 'crafting', 'mining', 'herblore', 'agility', 'thieving', 'runecraft'].map(s => [s, XP99]));
    const acts = [job('smith', 'smithing', 10, { at: 'b' }), job('cook', 'cooking', 10, { at: 'a' }),
        job('fletch', 'fletching', 10, { at: 'b', requires: ['cook'] })];
    const options = { ...opts, startXp, travel: { ...travelModel(), start: 'a' } };
    const baseline = schedule(boards, acts, options);
    const overall = scheduleOverall(boards, acts, options);
    expect(baseline.order.map(p => p.id)).toEqual(['smith', 'cook', 'fletch']);
    expect(overall.order.map(p => p.id)).toEqual(['cook', 'smith', 'fletch']);
    expect(overall.overallFinish!).toBeLessThan(baseline.overallFinish!);
    const opposite = { ...options, travel: { ...options.travel, start: 'b' } };
    expect(scheduleOverall(boards, acts, opposite)).toEqual(schedule(boards, acts, opposite));
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
    // Outbound is the recorded bank leg (9); return is a 5-tile estimate (5).
    expect(r.order[0]).toMatchObject({ ticks: 100 + 3 * (9 + 5), inner: 42, travel: 0 });
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

test('no gameplay or supply policy can exclude a route', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const acts = haggisActivities();
    const out = acts.filter(a => a.out).map(a => a.id).sort();
    expect(out).toEqual([]);
    for(const id of ['charge','cook-35','fm-pyre','login-wine','mage-arena','mortton-oil','relog'])expect(acts.find(a=>a.id===id)?.out).toBeUndefined();
    expect(LEVERS.filter(l=>l.owner)).toEqual([]);
    expect(SCENARIOS[0]!.tricks).toEqual(TRICKS);
    for (const tricks of [new Set<never>(), new Set(TRICKS)]) {
        const r = schedule(boards, acts, { mode: 'realistic', tricks, owner: new Set(['charge-spam']), travel: haggisTravel() });
        for (const id of out) expect(r.chosen).not.toContain(id);
        expect(r.blocked).toEqual([]);
        expect(r.qp).toBe(145); // MAX_QP: every quest (research/quest-points-board.md)
    }
});

test('supply research is a procurement lead, not an availability cap or route ban', () => {
    expect(haggisUnsourceable().map(u=>u.item)).toContain('uncut dragonstone');
    const row=job('missing-stock','crafting',10,{supplies:[{item:'uncut dragonstone',count:305}],out:{reason:'old shortage',replacement:'other'}});
    expect(applyLevers([row],{}).map(a=>a.id)).toEqual(['missing-stock']);
    expect(suppliesFor([row],{mode:'realistic',tricks:new Set()})).toEqual([{item:'uncut dragonstone',count:305}]);
});

test('restored supply routes are alternatives, not duplicated training obligations',()=>{
    const acts=haggisActivities();
    for(const [first,second]of [['craft','craft-diamond'],['fletch','fletch-arrows'],['herb','herb-drops']]){
        const a=acts.find(a=>a.id===first)!,b=acts.find(a=>a.id===second)!;
        expect(a.variant?.group).toBeTruthy();expect(a.variant?.group).toBe(b.variant?.group);expect(a.variant?.option).not.toBe(b.variant?.option);
    }
    expect(acts.find(a=>a.id==='bank-wine')!.requires).not.toContain('cook-range-35');
    const live=applyLevers(acts,{}).map(a=>a.id);
    expect(live.includes('magic')&&live.includes('magic-teleport')).toBe(false);
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
        const run = (disable: string[]) => schedule(boards, acts, { mode, tricks: new Set(), travel, disable: new Set(['pvp-relog-combat', ...disable]) });
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

test('anvil route finishes Magic and Smithing and beats Family Crest plus superheat', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    const run = (option: string) => schedule(boards, haggisActivities(), { mode: 'realistic', tricks: new Set(TRICKS), travel: haggisTravel(), force: { 'magic-smithing': option } });
    const anvil = run('anvil'), superheat = run('superheat');
    const at = (r: typeof anvil, id: string) => r.boards.find(b => b.id === id)!.finish;
    expect(anvil.blocked).toEqual([]);
    expect(at(anvil, 'magic')).not.toBeNull();
    expect(at(anvil, 'smithing')).not.toBeNull();
    // Magic trains in the foreground: as a stun guest it would wait on thieving, which waits on Magic 75.
    expect(haggisActivities().find(a => a.id === 'magic-anvil')!.inside).toBeUndefined();
    expect(anvil.overallFinish!).toBeLessThan(superheat.overallFinish!);
});

test('specialist ranged and agility routes beat live targets without double-counting', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    const only = (id: string) => new Set(boards.filter(b => b.id !== id).map(b => b.id));
    const soloRanged = schedule(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel, sacrificed: only('ranged'), disable: new Set(['pvp-relog-combat']) });
    const soloAgility = schedule(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), sacrificed: only('agility'), disable: new Set(['pvp-relog-combat']) });
    expect(soloRanged.blocked).toEqual([]);
    expect(finish(soloRanged, 'ranged').status).toBe('WIN');
    expect(finish(soloRanged, 'ranged').finish!).toBeLessThanOrEqual(5483);
    expect(soloAgility.blocked).toEqual([]);
    expect(finish(soloAgility, 'agility').status).toBe('WIN');
    expect(finish(soloAgility, 'agility').finish!).toBeLessThanOrEqual(6031);
});

test('overall route uses teleports, spirit trees, stun-guest chaining, and keeps 145 QP', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    const floor = scheduleOverall(boards, acts, { mode: 'floor', tricks: new Set(TRICKS), travel });
    const real = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel });
    expect(floor.blocked).toEqual([]);
    expect(real.blocked).toEqual([]);
    expect(floor.qp).toBe(145);
    expect(real.qp).toBe(145);
    // Ceilings above the measured pvp-relog-combat + quest burst model: floor 26,704 and realistic 28,386 (< 29,372 target for 2% margin under 29,972).
    expect(floor.overallFinish!).toBeLessThanOrEqual(27500);
    expect(real.overallFinish!).toBeLessThanOrEqual(29372);
    expect(real.route['agility-route']).toBe('tourist-trap');
    // PvP relog combat keeps Waterfall/Dragon/Cannon/MM/Fight Arena/Witch after Overall and trains at Deserted Keep.
    const overall = finish(real, 'overall').finish!;
    for (const id of ['waterfall', 'dragon', 'cannon', 'rival-mm', 'rival-fight-arena', 'witch']) {
        expect(real.order.find(p => p.id === id)!.start).toBeGreaterThanOrEqual(overall);
    }
    expect(real.order.find(p => p.id === 'str-top')!.travel ?? 0).toBe(0);
    expect(real.order.find(p => p.id === 'def-top')!.travel ?? 0).toBe(0);
    expect(real.order.find(p => p.id === 'ranged')!.travel ?? 0).toBe(0);
    // Spirit tree cuts travel after tree completes, and deep Wildy exits via lever rather than teleporting.
    expect(real.order.some(p => p.method === 'spirit-tree')).toBe(true);
    const arenaExit = real.order.find(p => p.from === 'mage-arena-lever')!;
    expect(arenaExit.method).toBe('wildy-exit-lever');
}, 15_000);

test('legacy stun-guest route absorbs superheat-stun and charge inside thieve when pvp-relog-combat is disabled', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    const legacyReal = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel, disable: new Set(['pvp-relog-combat']) });
    expect(legacyReal.order.find(p => p.id === 'superheat-stun')!.ticks).toBe(0);
    expect(legacyReal.order.find(p => p.id === 'charge')!.ticks).toBe(0);
}, 15_000);

test('superheat-stun and q-burst levers reduce smithing and burst quests cleanly', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    const force = {
        cooking: 'loginWine', 'fletching-method': 'fletch', 'crafting-method': 'craft',
        'herblore-method': 'herb', firemaking: 'burn', 'magic-smithing': 'anvil',
        'agility-route': 'grandtree', 'ranged-entry-method': 'melee-cannon',
    };
    const real = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel, force, disable: new Set(['pvp-relog-combat']) });
    const noSuperheat = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel, force, disable: new Set(['pvp-relog-combat', 'superheat-stun']) });
    const noBurst = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel, force, disable: new Set(['pvp-relog-combat', 'q-burst']) });
    expect(real.order.find(p => p.id === 'smith-anvil')!.ticks).toBeLessThan(noSuperheat.order.find(p => p.id === 'smith-anvil')!.ticks);
    expect(real.order.find(p => p.id === 'tree')!.ticks).toBe(noBurst.order.find(p => p.id === 'tree')!.ticks - 114);
    expect(real.order.find(p => p.id === 'druid')!.ticks).toBe(noBurst.order.find(p => p.id === 'druid')!.ticks - 31);
    expect(real.order.find(p => p.id === 'imp-catcher')!.ticks).toBe(noBurst.order.find(p => p.id === 'imp-catcher')!.ticks - 29);
});

test('a Haggis travel model built with a leg cache path prices the same route as the default model', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const finish = (travel: TravelModel) => scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel }).overallFinish;
    const model = haggisTravel(undefined, TRAVEL_FILE);
    expect((model as { start?: string }).start).toBe('lumbridge-spawn');
    expect(finish(model)).toBe(finish(haggisTravel()));
}, 15_000);

test('jewellery teleports (Amulet of glory, Ring of dueling) unlock after trade-start and quests-rest uses 3-seed measurements', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-live.json'));
    const acts = haggisActivities();
    const travel = haggisTravel();
    const real = scheduleOverall(boards, acts, { mode: 'realistic', tricks: new Set(TRICKS), travel });
    const floor = scheduleOverall(boards, acts, { mode: 'floor', tricks: new Set(TRICKS), travel });
    const tradeStartAt = real.order.find(p => p.id === 'trade-start')!.landsAt;
    const jewelleryLegs = real.order.filter(p => p.method?.startsWith('teleport:glory-') || p.method?.startsWith('teleport:dueling-'));
    expect(jewelleryLegs.length).toBeGreaterThan(0);
    for (const p of jewelleryLegs) expect(p.start).toBeGreaterThanOrEqual(tradeStartAt);
    expect(real.travel).toBeLessThan(2800);
    expect(floor.overallFinish!).toBeLessThan(27500);
    expect(real.overallFinish!).toBeLessThan(29372);
    const questsRest = acts.find(a => a.id === 'quests-rest')!;
    expect(questsRest.evidence).toBe('MEASURED');
    expect(questsRest.ticks).toMatchObject({ floor: 12951, realistic: 14145, evidence: 'MEASURED' });
    expect(finish(real, 'questpoints').finish!).toBeLessThan(103358);
}, 15_000);
