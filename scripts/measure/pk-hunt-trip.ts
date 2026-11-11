// One whole hunter trip on a practice engine: the hunter restocks its kit at Edgeville bank, walks to a hunt spot,
// fights the target that stands there, loots and goes on to the cap. The target is a second account of the run; it
// stands at the spot and hits back by auto-retaliate. The run passes when the restock gave a trip, the hunter killed
// the target and did not die.
// Usage: bun scripts/measure/pk-hunt-trip.ts <hunter> <target> [CAP ticks] [snare|staff|auto]   (auto: the hunter picks the trip from its bank)
import { openBot, finish } from '../../packages/core/src/bot';
import { tickWaits } from '../../packages/core/src/tick-stream';
import { nextTick } from '../pk';
import { HUNT_SPOTS, SNARE_KIT, SNARE_TRIP, TRIBRID_KIT, TRIP, hunt } from '../pk-hunt';

const [hunterName, targetName, capArg, kitArg] = process.argv.slice(2);
if (!hunterName || !targetName) { console.log('RESULT fail usage: bun scripts/measure/pk-hunt-trip.ts <hunter> <target> [CAP ticks] [snare]'); process.exit(2); }
const kitName = kitArg ?? (process.env.PK_KIT === 'snare' ? 'snare' : 'staff');
// The wait for the logins counts as a tick wait: a lockstep engine holds each tick for an account with no waiter.
tickWaits.active++;
const hunter = await openBot(hunterName);
const target = await openBot(targetName, { onStop: async () => {} });
tickWaits.active--;
let done = false;
// The target waits on each tick, so the lockstep engine does not hold the tick for it.
const idle = (async () => { while (!done && await nextTick(target)) { /* stands at the spot */ } })();
const r = await hunt(hunter, { cap: Number(capArg ?? 900), food: Number(process.env.HUNT_FOOD ?? 18), minFood: 6, escapeAt: 35, stop: () => false,
    ...(kitName === 'snare' ? { kit: SNARE_KIT, trip: SNARE_TRIP } : kitName === 'auto' ? {} : { kit: TRIBRID_KIT, trip: TRIP }), spots: [{ ...HUNT_SPOTS[0]!, dwell: 60 }] });
done = true;
await Promise.race([idle, new Promise(resolve => setTimeout(resolve, 2000))]);
console.log('HUNT ' + JSON.stringify(r));
const ok = r.trips >= 1 && r.kills >= 1 && r.deaths === 0 && !/failed|lacks|short|did not open|died/.test(r.end);
await finish([hunter, target], ok, `hunt-trip kit=${kitName} trips=${r.trips} fights=${r.fights} kills=${r.kills} deaths=${r.deaths} looted=${r.looted} end=${r.end}`);
