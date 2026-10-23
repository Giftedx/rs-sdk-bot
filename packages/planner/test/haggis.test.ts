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
