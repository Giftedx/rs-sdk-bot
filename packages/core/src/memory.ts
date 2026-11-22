// Free-memory limits for live bots and practice checks, in GiB of free physical memory (os.freemem).
// One place for every check: the launcher floor, practice startup and source preparation.
// A practice stack (engine, gateway, one bot) peaked at 1.68 GB (Rune check, 60 s sample), so a 2.5 GiB reserve
// covers it and keeps the 4 GiB floor.
export const FREE_FLOOR_GB = 4;
export const PRACTICE_RESERVE_GB = 2.5;
export const PRACTICE_STARTUP_GB = FREE_FLOOR_GB + PRACTICE_RESERVE_GB;
export const SOURCE_STARTUP_GB = FREE_FLOOR_GB + 2;

// The memory that one engine of the AIO bench needs, alone (BENCH_ENGINE_GB) and beside a live fleet (BENCH_CASE_GB:
// the engine, the worker and its account tools).
export const BENCH_ENGINE_GB = 0.9;
export const BENCH_CASE_GB = 1.5;
// The free memory that the start of a bench needs: the floor, the reserve that a swarm holds back for the bots that it
// starts now, and the engines. The bench (scripts/measure/bench-start-check.ts) refuses a start under this, and hosted
// checks admit a native start only at or over it, so admission never passes a start that the bench then refuses.
export function benchStartGB(o: { floorGB: number; reserveGB?: number; engines: number; fleet: boolean }): number {
    return o.floorGB + (o.reserveGB ?? 0) + o.engines * (o.fleet ? BENCH_CASE_GB : BENCH_ENGINE_GB);
}
// The exit codes of a command that ended because the host had no room, with no gameplay run: a bench that refused to
// start or stopped to give the fleet its memory, and a script that passes on the host deferral of a command under it
// (EX_TEMPFAIL). A delivery reads them as a deferral, not as a failure of the code.
export const BENCH_START_REFUSED_EXIT = 2;
export const BENCH_FLEET_STOP_EXIT = 4;
export const HOST_DEFERRED_EXIT = 75;
