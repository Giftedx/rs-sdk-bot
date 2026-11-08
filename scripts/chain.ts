// Several bot scripts in a row on one account, as one swarm job: fish then cook, gather then fletch. Each step is
// its own child process (packages/core/src/run-child.ts) with its own login and logout, so every step keeps its
// own checks. ROUNDS repeats the list (0: until a stop file or the first failed step).
// Usage: bun scripts/chain.ts <account> "<script> [arg ...] [KEY=value ...]" ["<step>" ...]
//   e.g. bun scripts/chain.ts Masterbaiter "scripts/gather-fish.ts cage 3000" "scripts/cook-food.ts 2000 lobster"
// The account goes in as each script's first argument. KEY=value tokens set that step's environment.
// A host job with this script (packages/core/src/host.ts) runs the same step texts in-process, one bot per account.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runChild } from '../packages/core/src/run-child';
import { parseStep, runChainSteps as runChain, type Step } from '../packages/core/src/chain-step';

export { parseStep, runChain, type Step };


if (import.meta.main) {
    const [account, ...texts] = process.argv.slice(2);
    if (!account || !texts.length) { console.log('RESULT fail usage: chain.ts <account> "<script> [args] [KEY=value]" ...'); process.exit(2); }
    const steps = texts.map(parseStep), rounds = Number(process.env.ROUNDS ?? 1), root = resolve(import.meta.dir, '..');
    const stopped = () => existsSync(join(root, '.practice', `stop-${account}`));
    const result = await runChain(steps, rounds, { stopped, log: console.log,
        run: st => runChild([st.script, account, ...st.args], { ...process.env, ...st.env }),
    });
    console.log(result);
    process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
