import { unwrapGuarded } from '../worker-execution';

// The prayer guard of a session (guard.ts) registers its hold here, by the session's SDK object. A loop that chooses
// and sends its own prayers holds the guard from its start to its stop: the PvP fight loop
// (packages/workers/src/pvp/fight.ts fightPlayer). While a hold is on, the guard sends no input.
// A prayer button toggles its prayer (content skill_prayer/scripts/prayers/*.rs2). Two senders that each turn on a
// prayer that their view shows off send two toggles, and the prayer goes off again.
type PrayerHold = () => { release(): void };
const sessionPrayers = new WeakMap<object, PrayerHold>();
export const registerSessionPrayer = (sdk: object, hold: PrayerHold): void => { sessionPrayers.set(unwrapGuarded(sdk), hold); };
export const holdSessionPrayer = (sdk: object): { release(): void } => sessionPrayers.get(unwrapGuarded(sdk))?.() ?? { release() {} };
