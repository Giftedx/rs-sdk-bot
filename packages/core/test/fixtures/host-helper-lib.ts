// Fixture for host.test.ts: a helper module, which the host does not rewrite (like a worker under
// scripts/aio-skiller.ts). Its console, openBot, finish and process.exit must still reach the hosted bot that runs it.
import { finish, openBot } from '../../src/bot';

export async function helperRun(me: string): Promise<never> {
    console.log(`HELPER ${me}`);
    if (me === 'helperexit') process.exit(4);
    const session = me === 'helperopen' ? await openBot(me) : undefined;
    return finish(session ? [session] : [], me !== 'helperfail', `helper bot=${me}`);
}
