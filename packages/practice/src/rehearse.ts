// Practice rehearsal of one route segment from a library save (or a preset), with ticks measured by the engine.
// A segment names its start, the worker command, the planned ticks and the expected end state (library.json
// `segments`). The runner loads the start under a fresh practice account, runs the worker, reads the engine tick when
// the account enters and leaves the world, and compares the end save with the expectation. With `capture` it also
// stores a state in the library: mid-run from the save endpoint (no logout), or the end save.
// Practice only: the engine is local, on ports, a pid file and logs apart from the shared practice slot (8888), and every bot.env is
// rewritten to that local engine before login.
// Usage: bun packages/practice/src/rehearse.ts <segment-id> [--start] [--out <dir>]
//        bun packages/practice/src/rehearse.ts --specialist <segment.json> --start [--out <dir>]
//   --start  start an isolated practice engine with the save endpoint, and stop it at the end.
import { runRehearseCli } from './rehearse/run';

export {
    ISOLATED,
    ISOLATED_ENGINE_ENV,
    SUPPLIER_ONLINE_TIMEOUT_MS,
    type HelperProcHandle,
    type RehearsalReport,
    type Segment,
    type SupplierSpec,
} from './rehearse/types';

export {
    checkExpect,
    checkSpecialistSegment,
    findSegment,
    itemCount,
    resolveSegmentSuppliers,
    TickWindow,
} from './rehearse/validate';

export {
    isolatedStackOptions,
    pointBotAt,
    rehearsalChildEnv,
    rehearseLockstep,
    startIsolatedStack,
    stopHelperProcs,
    waitForSuppliersOnline,
} from './rehearse/env';

export { rehearse } from './rehearse/run';

if (import.meta.main) {
    await runRehearseCli(process.argv.slice(2));
}
