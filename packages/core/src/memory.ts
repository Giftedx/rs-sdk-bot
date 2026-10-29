// Free-memory limits for live bots and practice checks, in GiB of free physical memory (os.freemem).
// One place for every check: the launcher floor, practice startup and source preparation.
// A practice stack (engine, gateway, one bot) uses about 3.2 GB, so a 3.5 GiB reserve covers its startup and
// keeps the 4 GiB floor.
export const FREE_FLOOR_GB = 4;
export const PRACTICE_RESERVE_GB = 3.5;
export const PRACTICE_STARTUP_GB = FREE_FLOOR_GB + PRACTICE_RESERVE_GB;
export const SOURCE_STARTUP_GB = FREE_FLOOR_GB + 3;
