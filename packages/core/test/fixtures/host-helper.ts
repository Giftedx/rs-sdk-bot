// Fixture for host.test.ts: a script whose work and finish() live in a helper module (host-helper-lib.ts).
import { helperRun } from './host-helper-lib';

await helperRun(process.argv[2]!);
console.log(`NEVER ${process.argv[2]}`);
