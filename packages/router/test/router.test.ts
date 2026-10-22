import { test, expect } from 'bun:test';
import { buildBrief, claudeArgs, parseClaudeJson, authorLoop, type AuthorDeps } from '../src/author';

const task = { id: 'copper5', goal: 'Mine copper ore until 5 are in the pack.', preset: 'measure_mine', spot: 'SE Varrock mine (3285, 3365), vendor/rs-sdk/learnings/mining.md' };

test('the brief carries the task, the output contract, the file to write, and the example to copy', () => {
    const b = buildBrief(task, 'scripts/generated/copper5.ts');
    expect(b).toContain('<task>');
    expect(b).toContain(task.goal);
    expect(b).toContain('scripts/generated/copper5.ts');
    expect(b).toContain('START');
    expect(b).toContain('RESULT ok');
    expect(b).toContain('scripts/proven/gather.ts');
});

test('the CLI is run headless with only read, write and bun tools allowed', () => {
    const a = claudeArgs('do it');
    expect(a.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(a).toContain('--output-format');
    expect(a.join(' ')).toContain('Bash(bun:*)');
    expect(a.join(' ')).not.toContain('dangerously');
});

test('parseClaudeJson reads the result text and cost, and reports errors', () => {
    expect(parseClaudeJson('{"type":"result","is_error":false,"result":"done","total_cost_usd":0.12}')).toEqual({ ok: true, text: 'done', costUsd: 0.12 });
    expect(parseClaudeJson('not json').ok).toBe(false);
});

test('authorLoop writes, proves, feeds the failure back once, and stops on the first full pass', async () => {
    const prompts: string[] = [];
    let proofs = 0;
    const deps: AuthorDeps = {
        runModel: async p => { prompts.push(p); return { ok: true, text: 'wrote it', costUsd: 0.1 }; },
        prove: async () => { proofs++; return proofs === 1 ? { passes: 1, runs: 3, tail: 'RESULT fail no rock found' } : { passes: 3, runs: 3, tail: 'RESULT ok' }; },
        exists: () => true,
    };
    const r = await authorLoop(task, { maxFixes: 2, proveRuns: 3 }, deps);
    expect(r).toMatchObject({ ok: true, attempts: 2, passes: 3 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('RESULT fail no rock found');
});

test('authorLoop gives up after maxFixes and reports the last failure', async () => {
    const deps: AuthorDeps = {
        runModel: async () => ({ ok: true, text: '', costUsd: 0 }),
        prove: async () => ({ passes: 0, runs: 3, tail: 'RESULT fail stuck' }),
        exists: () => true,
    };
    const r = await authorLoop(task, { maxFixes: 1, proveRuns: 3 }, deps);
    expect(r).toMatchObject({ ok: false, attempts: 2 });
});
