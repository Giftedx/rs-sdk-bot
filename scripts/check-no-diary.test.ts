import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { flag, flagComments, check } from './check-no-diary';

test('dates in code comments are flagged; dates in code, URLs and paths are not', () => {
    const d = ['2026', '10', '29'].join('-'); // built here, so this file's own comments scan clean
    const t = [`// Measured on ${d}.`, `const at = "${d}"; // a fixture day`, ` * seen ${d}: a death`, `fetch("https://x.test/${d}")`,
        `// Reads research/hiscores-${d}.json.`, `run(); // logged out ${d}`].join('\n');
    expect(flagComments(t).map(f => f.line)).toEqual([1, 3, 6]);
});

test('history in prose is flagged; paths, code, quotes and plain facts are not', () => {
    const t = ['Superheat gives 412 XP per tick.', 'Measured on 2026-10-29.', 'The row (was 45,570) is faster.', 'This replaced the old loop and was replaced by V2.',
        'Update: the gate opens.', 'The first attempt failed.', 'Logs in `.practice/x-20261029/runs.log`.', 'The wall text "was reduced to rubble" ends it.', '```', 'retried 2026-10-29', '```'].join('\n');
    expect(flag(t).map(f => [f.line, f.id])).toEqual([[2, 'date'], [3, 'before-after'], [4, 'history-verb'], [5, 'update-log'], [6, 'attempt-story']]);
});

test('the project docs and swarm.json hold no diary text', () => {
    const found = check(resolve(import.meta.dir, '..'));
    expect(found.map(r => `${r.file}: ${r.flags.length}`)).toEqual([]);
});

test('swarm.json hand notes are checked; planner notes are not', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-diary-'));
    try {
        writeFileSync(join(root, 'swarm.json'), JSON.stringify({ jobs: [
            { account: 'Farmer', autopilot: 'local', note: 'autopilot goldfarm@2652,3318: coins, 11.93 coins/tick (estimate)' },
            { account: 'Hand', note: 'quest chain fails at Murder Mystery' },
        ] }));
        expect(check(root).flatMap(r => r.flags.map(f => `${r.file}: ${f.text}`))).toEqual(['swarm.json: Hand: quest chain fails at Murder Mystery']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
