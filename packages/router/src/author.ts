import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Phase 3 v1: a model writes a game script, the practice harness proves it, and failures go back to the model.
// The model runs through the owner's subscription CLI (`claude -p`), headless, with only file and bun tools.

export interface AuthorTask {
    id: string; // file name stem, letters and digits
    goal: string; // what the script must achieve, in game terms
    preset: string; // practice preset the proof starts from (packages/practice/src/presets.ts)
    spot?: string; // where, with the source of that fact
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

export function buildBrief(task: AuthorTask, file: string, failure?: string): string {
    return [
        '<context>',
        'You write one bot script for a RuneScape 2004 (rs-sdk / LostCity rev 289) practice server. The script runs in',
        'process with the game client. Read these before writing:',
        '- scripts/proven/gather.ts and scripts/proven/fight.ts: working examples of the exact shape to copy.',
        '- packages/core/src/bot.ts: openBot(name), finish(sessions, ok, detail), countItems(session, regex).',
        '- packages/core/src/ticks.ts: waitTicks, waitUntil (game ticks, never sleeps).',
        '- vendor/rs-sdk/sdk/API.md: every bot.* and sdk.* method. vendor/rs-sdk/learnings/*.md: tested tips.',
        `The proof starts the bot from preset "${task.preset}" in packages/practice/src/presets.ts. Read it.`,
        '</context>',
        '<task>',
        task.goal,
        task.spot ? `Where: ${task.spot}` : '',
        '</task>',
        '<contract>',
        `- Write exactly one file: ${file}. Do not edit any other file.`,
        '- The bot name is process.argv[2]. Call openBot first; it prints START. End every path with finish(),',
        '  which prints exactly one line "RESULT ok <detail>" or "RESULT fail <reason>" and logs out.',
        '- Pass only when the goal is met, checked from game state (inventory, skills, position), never assumed.',
        '- Count time in game ticks. Give every loop a bound. Wrap the body in try/catch and call finish on errors.',
        `- Check it type-checks: run "bunx tsc --noEmit -p ." from the repo root and fix errors in ${file}.`,
        '- Do not start or stop servers. Do not run the script; the harness proves it on a live server.',
        '</contract>',
        failure ? `<last_proof_failure>\n${failure}\n</last_proof_failure>\nFix ${file} so the proof passes.` : '',
    ].filter(Boolean).join('\n');
}

export function claudeArgs(prompt: string): string[] {
    return [
        '-p', prompt,
        '--output-format', 'json',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash(bun:*)', 'Bash(bunx tsc:*)',
    ];
}

export function parseClaudeJson(out: string): { ok: boolean; text: string; costUsd: number } {
    try {
        const j = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '');
        return { ok: j.is_error === false, text: String(j.result ?? ''), costUsd: Number(j.total_cost_usd ?? 0) };
    } catch {
        return { ok: false, text: out.slice(-500), costUsd: 0 };
    }
}

export async function runClaude(prompt: string, timeoutMs = 900_000): Promise<{ ok: boolean; text: string; costUsd: number }> {
    const proc = Bun.spawn(['claude', ...claudeArgs(prompt)], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    const r = parseClaudeJson(out);
    return r.ok ? r : { ...r, text: `${r.text}\n${err.slice(-500)}` };
}

export interface AuthorDeps {
    runModel(prompt: string): Promise<{ ok: boolean; text: string; costUsd: number }>;
    prove(file: string, task: AuthorTask, runs: number): Promise<{ passes: number; runs: number; tail: string }>;
    exists(file: string): boolean;
}

export interface AuthorResult { ok: boolean; attempts: number; passes: number; runs: number; costUsd: number; file: string; lastTail: string }

export async function authorLoop(task: AuthorTask, opts: { maxFixes: number; proveRuns: number }, deps: AuthorDeps): Promise<AuthorResult> {
    const file = `scripts/generated/${task.id}.ts`;
    let failure: string | undefined;
    let cost = 0;
    let last = { passes: 0, runs: opts.proveRuns, tail: '' };
    for (let attempt = 1; attempt <= opts.maxFixes + 1; attempt++) {
        const m = await deps.runModel(buildBrief(task, file, failure));
        cost += m.costUsd;
        if (!deps.exists(file)) {
            failure = `The file ${file} was not written. Model said: ${m.text.slice(-400)}`;
            continue;
        }
        last = await deps.prove(file, task, opts.proveRuns);
        if (last.passes === last.runs) return { ok: true, attempts: attempt, passes: last.passes, runs: last.runs, costUsd: cost, file, lastTail: last.tail };
        failure = `${last.passes}/${last.runs} runs passed. Output of the failing runs:\n${last.tail}`;
    }
    return { ok: false, attempts: opts.maxFixes + 1, passes: last.passes, runs: last.runs, costUsd: cost, file, lastTail: last.tail };
}

export const fileExists = (file: string) => existsSync(join(repoRoot, file));
