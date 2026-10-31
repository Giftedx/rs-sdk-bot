import { expect, test } from 'bun:test';
import { tripSize } from './gather-spawn';

test('a stack trip takes all that is left; other items fill the free slots', () => {
    expect(tripSize(176, false, 20)).toBe(20);
    expect(tripSize(5, false, 20)).toBe(5);
    expect(tripSize(2000, true, 2)).toBe(2000);
    expect(tripSize(-3, true, 9)).toBe(0);
});
