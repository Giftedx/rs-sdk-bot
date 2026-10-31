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
