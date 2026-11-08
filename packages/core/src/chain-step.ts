// One step of a script chain: a scripts/*.ts path, its arguments and its own environment. scripts/chain.ts runs
// the steps as child processes; packages/core/src/host.ts runs the same step texts inside one host process.
export type Step = { script: string; args: string[]; env: Record<string, string> };

// "scripts/cook-food.ts 2000 lobster CAP=2000" -> script, args ['2000', 'lobster'], env { CAP: '2000' }.
export function parseStep(text: string): Step {
    const [script, ...rest] = text.trim().split(/\s+/);
    if (!script || !/^scripts\/[\w./-]+\.ts$/.test(script)) throw Error(`chain step needs a scripts/*.ts path: ${text}`);
    const env: Record<string, string> = {}, args: string[] = [];
    for (const t of rest) { const m = t.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]!] = m[2]!; else args.push(t); }
    return { script, args, env };
}

export async function runChainSteps(steps: readonly Step[], rounds: number, deps: {
    stopped(): boolean;
    run(step: Step, round: number, index: number): Promise<string>;
    log(line: string): void;
}): Promise<string> {
    if (!steps.length || !Number.isSafeInteger(rounds) || rounds < 0) throw Error('chain needs steps and nonnegative integer ROUNDS');
    let ok = 0, failed = 0, round = 0;
    const summary = (result: string) => `${result} chain rounds=${round} ok=${ok} failed=${failed}`;
    while (rounds === 0 || round < rounds) {
        if (deps.stopped()) return summary('RESULT fail stop file');
        round++;
        for (const [index, step] of steps.entries()) {
            if (deps.stopped()) return summary('RESULT fail stop file');
            let result: string;
            try { result = await deps.run(step, round, index); }
            catch (error) { result = `RESULT fail child threw: ${String(error)}`; }
            const good = /^RESULT ok(?: |$)/.test(result);
            good ? ok++ : failed++;
            deps.log(`CHAIN round=${round} ${step.script} ${good ? 'ok' : 'fail'} ${result.slice(0, 200)}`);
            // Keep death, disconnect and admission failure prefixes visible to the supervisor.
            // No later producer may log in after a failed prerequisite.
            if (!good) return summary(/^RESULT fail(?: |$)/.test(result) ? result : 'RESULT fail child has no result');
        }
    }
    return summary(deps.stopped() ? 'RESULT fail stop file' : 'RESULT ok');
}

