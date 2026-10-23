// Fixture for host.test.ts: a script shaped like the bot scripts, with no login. It reads its bot name from
// process.argv[2] after an await, prints, and finishes; a line after finish() must never print.
import { finish } from '../../src/bot';

const me = process.argv[2];
console.log(`HELLO ${me} env=${process.env.HOST_TEST_TAG}`);
await Bun.sleep(20);
console.log(`AFTER ${process.argv[2]}`);
if (me === 'exiter') process.exit(3);
await finish([], me !== 'failer', `bot=${me}`);
console.log(`NEVER ${me}`);
