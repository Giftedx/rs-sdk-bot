import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGangRecord, recordedReturns, squadStallTicks, STALL_DEFAULT_TICKS, STALL_MARGIN } from '../src/pvp/pk-squad-stall';

describe('squad stall bound', () => {
    test('the bound is the longest recorded return of a gang account times the margin, never under the default', () => {
        const group = { returnToPost: { value: { ticksAfterADeath: [1154], ticksAfterAWalkOut: [1431] } } };
        expect(recordedReturns(group)).toEqual([1431, 1154]);
        expect(squadStallTicks(group)).toBe(Math.ceil(1431 * 1.25));
        expect(squadStallTicks({ returnToPost: { value: { ticksAfterADeath: [200] } } })).toBe(STALL_DEFAULT_TICKS);
    });
    test('a record with no return keeps the default', () => {
        for (const group of [null, {}, { returnToPost: {} }, { returnToPost: { value: { ticksAfterADeath: [] } } }, { returnToPost: { value: { ticksAfterADeath: ['x', -1, 0] } } }]) expect(squadStallTicks(group)).toBe(STALL_DEFAULT_TICKS);
    });
    test('the committed clone record gives a bound over the longest return that it holds', () => {
        const group = JSON.parse(readFileSync(join(import.meta.dir, '../../../scripts/pk-gang-record', 'group.json'), 'utf8'));
        const longest = recordedReturns(group)[0]!;
        expect(longest).toBeGreaterThan(1000);
        expect(squadStallTicks(readGangRecord())).toBeGreaterThan(longest);
    });
    test('the margin covers the spread of the committed record: the longest return over the shortest', () => {
        const returns = recordedReturns(JSON.parse(readFileSync(join(import.meta.dir, '../../../scripts/pk-gang-record', 'group.json'), 'utf8')));
        expect(returns.length).toBeGreaterThan(1);
        expect(STALL_MARGIN).toBeGreaterThanOrEqual(returns[0]! / returns[returns.length - 1]!);
    });
    test('importing the module in a test leaves STALL_TICKS alone', () => {
        expect(process.env.STALL_TICKS).toBeUndefined();
    });
});
