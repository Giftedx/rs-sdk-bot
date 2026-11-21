// Prayer guard: keeps the active prayers free of point cost, and turns protection and attack prayers on when they help.
//
// Prayer points drain on a 5-tick timer. The timer starts when the first prayer goes on and is cleared when no prayer
// is on (skill_prayer/scripts/prayer.rs2:30-43,163). A flick turns every active prayer off and on, so the timer never
// fires.
//
// A prayer button closes every open window (skill_prayer/scripts/prayers/*.rs2:2, if_close), clears the pending
// interaction (p_clearpendingaction) and clears the weak queue, which holds a skill batch (engine Player.ts
// closeModal). The guard therefore sends a prayer input only at these times:
// - Right before an input of the script that starts an action. The script's input comes after the prayer inputs in
//   the same tick, so the prayer inputs cancel nothing.
// - In a tick with no window open and no interaction pending.
// - In a tick with an attack pending. The guard then sends the same attack again after the prayer inputs.
// At every other time the prayer stays on and drains at the normal rate: a window is open, or an interaction that is
// not an attack runs and the script sends no input.
//
// A script that sends its own prayer input chooses the prayers: from then on the guard turns no prayer on or off, and
// only keeps the active prayers free. A script that turns one prayer off and on in one tick has its own flick: the
// guard then sends nothing more in that session.

export type { AttackStyle, GuardSession, Hunter, PrayerGuardOptions, PrayerGuardStats } from './prayer-guard/types';
export { attackTarget, npcDead, wildernessLevel } from './prayer-guard/threats';
export { afterToggle, PROTECT, protectByStyle } from './prayer-guard/choice';
export { IDLE_TICKS, NEUTRAL } from './prayer-guard/interactions';
export { startPrayerGuard } from './prayer-guard/guard';
