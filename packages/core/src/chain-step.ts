// One step of a script chain: a scripts/*.ts path, its arguments and its own environment. scripts/chain.ts runs
// the steps as child processes; packages/core/src/host.ts runs the same step texts inside one host process.
export type Step = { script: string; args: string[]; env: Record<string, string> };

// Step text is data, never a shell command. Single quotes keep their contents
// literally; double quotes use JSON escapes so generated text can retain newlines
// and backslashes. Groups start at a token boundary or after an option's =; embedded
// JSON quotes, apostrophes and unquoted backslashes keep their legacy meaning.
export function tokenizeStep(text: string): string[] {
    const tokens: string[] = [];
    let token = '', started = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (/\s/.test(char)) {
            if (started) { tokens.push(token); token = ''; started = false; }
        } else if (char === "'" && (!started || /^(?:--)?[A-Za-z_][A-Za-z0-9_-]*=$/.test(token))) {
            const end = text.indexOf("'", i + 1);
            if (end < 0) throw Error('unterminated single-quoted chain token');
            token += text.slice(i + 1, end); started = true; i = end;
        } else if (char === '"' && (!started || /^(?:--)?[A-Za-z_][A-Za-z0-9_-]*=$/.test(token))) {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
            if (i >= text.length) throw Error('unterminated double-quoted chain token');
            try { token += JSON.parse(text.slice(start, i + 1)) as string; }
            catch { throw Error('invalid JSON escape in double-quoted chain token'); }
            started = true;
        } else { token += char; started = true; }
    }
    if (started) tokens.push(token);
    return tokens;
}

// "scripts/cook-food.ts 2000 lobster CAP=2000" -> script, args ['2000', 'lobster'], env { CAP: '2000' }.
// Generated steps put environment settings before -- and preserve every later
// token as argv, including KEY=value options read by workers such as pk-roam.
export function parseStep(text: string): Step {
    const [script, ...rest] = tokenizeStep(text);
    if (!script || !/^scripts\/[\w./-]+\.ts$/.test(script)) throw Error(`chain step needs a scripts/*.ts path: ${text}`);
    const env: Record<string, string> = {}, args: string[] = [];
    let literalArgs = false;
    for (const t of rest) {
        if (!literalArgs && t === '--') { literalArgs = true; continue; }
        const m = !literalArgs && t.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (m) env[m[1]!] = m[2]!; else args.push(t);
    }
    return { script, args, env };
}

export function formatStep(step: Step): string {
    if (!/^scripts\/[\w./-]+\.ts$/.test(step.script)) throw Error(`chain step needs a scripts/*.ts path: ${step.script}`);
    // Keep simple code paths visible to workerEntries' literal dependency scan.
    const quote = (token: string) => !token || /[\s'"\\]/.test(token) ? JSON.stringify(token) : token;
    const env = Object.entries(step.env).map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw Error(`invalid chain environment key: ${key}`);
        return quote(`${key}=${value}`);
    });
    return [step.script, ...env, '--', ...step.args.map(quote)].join(' ');
}

export async function runChainSteps(steps: readonly Step[], rounds: number, deps: {
    stopped(): boolean;
    run(step: Step, round: number, index: number): Promise<string>;
    log(line: string): void;
}): Promise<string> {
    if (!steps.length || !Number.isSafeInteger(rounds) || rounds < 0) return 'RESULT fail chain needs steps and nonnegative integer ROUNDS';
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

