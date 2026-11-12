// A child process of controllers.test.ts. It waits for the start time, tries the lease one time and prints the
// result. Then it stays alive, so that its lease stays held while the other children try.
import { takeLease } from '../src/controllers';

const file = process.argv[2]!, startAt = Number(process.argv[3]);
while (Date.now() < startAt) { /* all children try in the same millisecond */ }
console.log(takeLease(file) ? 'TOOK' : 'REFUSED');
await Bun.sleep(3000);
