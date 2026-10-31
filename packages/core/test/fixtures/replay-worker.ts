// A worker for replay.test.ts: the same commands as its in-test worker, read from argv like scripts/*.ts.
import { openBot } from '../../src/bot';
import { waitTicks } from '../../src/ticks';
const s = await openBot(process.argv[2]!);
await waitTicks(s, 2);
await s.sdk.sendWalk(3200, 3200);
await waitTicks(s, 3);
const xp = s.sdk.getState()?.skills?.[0]?.experience ?? 0;
await s.sdk.sendWalk(xp > 0 ? Number(process.argv[3]) : 1, 3201);
await waitTicks(s, 1);
await s.direct({ type: 'clickComponent', componentId: 2458, reason: 'SDK' });
