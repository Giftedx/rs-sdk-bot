import { test, expect } from 'bun:test';
import { bestSet, haggisActivities, loadSnapshot, schedule, XP99, type Activity, type Board } from '../src/haggis';
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

test('the real table loads, schedules without blocks, and covers all 24 boards', () => {
    const boards = loadSnapshot(join(import.meta.dir, '..', '..', '..', 'research', 'hiscores-2026-10-22.json'));
    expect(boards).toHaveLength(24);
    const r = schedule(boards, haggisActivities(), { mode: 'realistic', tricks: new Set() });
    expect(r.blocked).toEqual([]);
    expect(r.boards.every(b => b.finish !== null)).toBe(true);
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
