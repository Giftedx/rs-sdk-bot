// Fine timers for the lockstep practice engine and its bots on Windows.
// A Windows timer fires on the system clock interrupt, 15.6 ms apart by default: setTimeout(1) takes 15 ms and
// Bun.sleep(20) takes 31 ms (measured on this PC with Bun 1.3.14). The lockstep gate of the engine and the tick
// acknowledgement of each bot poll with timers of 1 ms and 5 ms, so each poll cost one interrupt. timeBeginPeriod(1)
// sets the interrupt of this process to 1 ms (setTimeout(1) then takes 1.5 ms). Windows keeps the setting for the
// process only and drops it when the process ends. Other platforms have fine timers and need no call.
// This module is also the engine's preload (packages/practice/src/stack.ts engineCommand): loaded with
// SIM_LOCKSTEP=1 it makes the call.
// Fine timers are on by default on Windows lockstep runs so 1 ms and 5 ms polls run without 15 ms timer quantization;
// set SIM_FINE_TIMERS=0 to opt out.
let state: boolean | undefined;
export function fineTimers(env: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
    if (platform !== 'win32' || env.SIM_FINE_TIMERS === '0') return false;
    if (state !== undefined) return state;
    try {
        const { dlopen } = require('bun:ffi') as typeof import('bun:ffi');
        const winmm = dlopen('winmm.dll', { timeBeginPeriod: { args: ['u32'], returns: 'u32' } });
        state = winmm.symbols.timeBeginPeriod(1) === 0;
    } catch { state = false; } // the timers stay coarse; the run is slower and no result changes
    return state;
}
if (process.env.SIM_LOCKSTEP === '1') fineTimers();
