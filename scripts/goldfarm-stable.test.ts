import { expect, test } from 'bun:test';
import { ARDOUGNE_RADIUS, BANK_SPOT, COURIER_COOLDOWN, COURIER_WANT_BELOW, courierCheckDue, farmStartProblem, stallAllowed } from './goldfarm-stable';
import { isNoProgressFailure } from '../packages/practice/src/supervise';
import { classify } from '../packages/practice/src/supervise-host';

const at = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });

test('the farm starts only in Ardougne market with Thieving 55 or more', () => {
    expect(farmStartProblem(at(BANK_SPOT.x, BANK_SPOT.z), 99)).toBeNull();
    expect(farmStartProblem(at(2653, 3302), 99)).toBeNull(); // knights
    expect(farmStartProblem(at(2655, 3310), 55)).toBeNull(); // stall
    expect(farmStartProblem(at(BANK_SPOT.x + ARDOUGNE_RADIUS, BANK_SPOT.z), 99)).toBeNull();
});

test('starts that killed or idled live thieves on 2026-10-25 are refused before any walk', () => {
    expect(farmStartProblem(at(3096, 3279), 99)).toMatch(/start in Ardougne market/); // Draynor: walked, died
    expect(farmStartProblem(at(3222, 3218), 99)).toMatch(/start in Ardougne market/); // Lumbridge respawn
    expect(farmStartProblem(at(3044, 3276), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(at(BANK_SPOT.x, BANK_SPOT.z, 1), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(undefined, 99)).toMatch(/position unknown/);
    expect(farmStartProblem(at(2654, 3312), 1)).toMatch(/below 55/); // mmsmk1232: idle 2400 ticks, RESULT ok
});

test('a refused start blocks the account in both supervisors instead of logging it in again', () => {
    for (const why of [farmStartProblem(at(3096, 3279), 99)!, farmStartProblem(at(2654, 3312), 1)!, 'no goldfarm progress: idle 300 ticks with no pickpocket']) {
        const line = `RESULT fail ${why} ticks=1`;
        expect(isNoProgressFailure(line)).toBe(true);
        expect(classify(line, false)).toBe('blocked');
    }
});

test('an idle farm with no food stops (resumable); with food it is a stuck farm (blocked)', () => {
    expect(classify('RESULT fail no food: waited 300 ticks with no pickpocket and no food ticks=300', false)).toBe('stopped');
    expect(classify('RESULT fail no goldfarm progress: idle 300 ticks with no pickpocket ticks=300', false)).toBe('blocked');
});

test('a thief at the knights answers the courier only when it is in view, once per cooldown', () => {
    const here = [{ name: 'Knight' }, { name: 'bigpackage' }];
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN + 1, 'Bigpackage', here)).toBe(false);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', [{ name: 'Bigpackage2' }, {}])).toBe(false);
    expect(courierCheckDue(1000, -100_000, '', here)).toBe(false);
    // A fed thief (26 food on 2026-10-25) keeps picking; the wait is for one that is running short.
    expect(COURIER_WANT_BELOW).toBeGreaterThan(2);
    expect(COURIER_WANT_BELOW).toBeLessThan(26);
});

test('with no food the stall is never entered, not even at full HP', () => {
    expect(stallAllowed(10, 10, 0)).toBe(false); // Pocketrocket, 2026-10-25 06:5x: entered at 10/10, died
    expect(stallAllowed(9, 10, 0)).toBe(false);
    expect(stallAllowed(7, 10, 0)).toBe(false); // Pocketrocket, 2026-10-25: entered at 7, died
    expect(stallAllowed(4, 11, 0)).toBe(false);
    expect(stallAllowed(4, 10, 3)).toBe(true); // with food the stall loop eats first
});
