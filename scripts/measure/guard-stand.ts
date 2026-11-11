// Bench worker for the prayer guard (packages/core/src/prayer-guard.ts): stands on its start tile for a number of
// ticks and sends no input, so each prayer input in the run is the guard's.
// Usage: bun scripts/measure/guard-stand.ts <bot> <ticks>
import { finish, openBot } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const [name, ticks = '300'] = process.argv.slice(2);
if (!name || !Number.isSafeInteger(Number(ticks)) || Number(ticks) < 1) throw new Error('usage: guard-stand.ts <bot> <ticks>');
const s = await openBot(name);
const hitpoints = () => s.sdk.getState()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? 0;
const before = hitpoints();
await waitTicks(s, Number(ticks));
const after = hitpoints(), alive = !s.sdk.getState()?.player?.isDead;
console.log(`RESULT ${alive ? 'ok' : 'fail'} ticks=${ticks} hp=${before}->${after}`);
await finish([s], alive, 'stood');
