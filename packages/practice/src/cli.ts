import { createBot } from './bots';
import { isLiteRunning } from './lite';
import { portInUse } from './ports';
import { prove, wcPass } from './prove';
import { startStack, stopStack } from './stack';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

switch (cmd) {
    case 'up': {
        const tick = flag('tick');
        const stack = await startStack({ tickMs: tick ? Number(tick) : 300 });
        console.log(`up: engine :8888, gateway :7780, logs ${stack.logs.engine}`);
        break;
    }
    case 'down':
        await stopStack();
        console.log('down');
        break;
    case 'status':
        console.log(`engine :8888 ${(await portInUse(8888)) ? 'up' : 'down'}`);
        console.log(`gateway :7780 ${(await portInUse(7780)) ? 'up' : 'down'}`);
        for (const b of args) console.log(`lite ${b} ${isLiteRunning(b) ? 'up' : 'down'}`);
        break;
    case 'bot': {
        const r = await createBot(args[0]!);
        console.log(`bot ${r.name}: ${r.envPath}`);
        break;
    }
    case 'prove': {
        const [bot, script, runs] = args;
        const r = await prove({ bot: bot!, script: script!, runs: Number(runs), preset: flag('preset'), pass: wcPass });
        for (const [i, x] of r.results.entries()) console.log(`run ${i + 1}: ${x.ok ? 'PASS' : 'FAIL'} ${x.seconds.toFixed(1)}s\n${x.tail}`);
        console.log(`proved ${r.passes}/${r.runs}`);
        process.exit(r.passes === r.runs ? 0 : 1);
    }
    default:
        console.log('usage: cli.ts up [--tick N] | down | status [bots..] | bot <name> | prove <bot> <script> <runs> [--preset P]');
        process.exit(2);
}
