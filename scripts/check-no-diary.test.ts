import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { flag, check } from './check-no-diary';

test('history in prose is flagged; paths, code, quotes and plain facts are not', () => {
    const t = ['Superheat gives 412 XP per tick.', 'Measured on 2026-10-29.', 'The row (was 45,570) is faster.', 'This replaced the old loop and was replaced by V2.',
        'Update: the gate opens.', 'The first attempt failed.', 'Logs in `.practice/x-20261029/runs.log`.', 'The wall text "was reduced to rubble" ends it.', '```', 'retried 2026-10-29', '```'].join('\n');
    expect(flag(t).map(f => [f.line, f.id])).toEqual([[2, 'date'], [3, 'before-after'], [4, 'history-verb'], [5, 'update-log'], [6, 'attempt-story']]);
});

test('the project docs and swarm.json hold no diary text', () => {
    const found = check(resolve(import.meta.dir, '..'));
    expect(found.map(r => `${r.file}: ${r.flags.length}`)).toEqual([]);
});
