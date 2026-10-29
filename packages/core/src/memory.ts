// Free-memory limits for live bots and practice checks, in GiB of free physical memory (os.freemem).
// One place for every check: the launcher floor, practice startup and source preparation.
// A practice stack (engine, gateway, one bot) peaked at 1.68 GB (Rune check, 60 s sample), so a 2.5 GiB reserve
// covers it and keeps the 4 GiB floor.
export const FREE_FLOOR_GB = 4;
export const PRACTICE_RESERVE_GB = 2.5;
export const PRACTICE_STARTUP_GB = FREE_FLOOR_GB + PRACTICE_RESERVE_GB;
export const SOURCE_STARTUP_GB = FREE_FLOOR_GB + 3;
