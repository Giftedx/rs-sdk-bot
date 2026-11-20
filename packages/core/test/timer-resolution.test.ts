import { expect, test } from 'bun:test';
import { fineTimers } from '../src/timer-resolution';

test('fine timers: off outside Windows or when SIM_FINE_TIMERS=0', () => {
    expect(fineTimers({}, 'linux')).toBe(false);
    expect(fineTimers({ SIM_FINE_TIMERS: '1' }, 'linux')).toBe(false);
    expect(fineTimers({ SIM_FINE_TIMERS: '0' }, 'win32')).toBe(false);
});

test.skipIf(process.platform !== 'win32')('fine timers: enabled by default on Windows and a 1 ms timer takes under 8 ms', async () => {
    expect(fineTimers({}, 'win32')).toBe(true);
    expect(fineTimers({ SIM_FINE_TIMERS: '1' }, 'win32')).toBe(true);
    const waits: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); await new Promise(r => setTimeout(r, 1)); waits.push(performance.now() - t); }
    waits.sort((a, b) => a - b);
    expect(waits[10]!).toBeLessThan(8); // 15 ms with the default 15.6 ms clock interrupt
});
