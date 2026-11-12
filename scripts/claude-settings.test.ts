import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// .claude/settings.json is shared by every Claude Code session in this repository, the coordinator builds included.
const settings = JSON.parse(readFileSync(join(import.meta.dir, '..', '.claude', 'settings.json'), 'utf8'));

test('Glob skips gitignored files, so a root Glob does not walk .practice and time out', () => {
    expect(settings.env?.CLAUDE_CODE_GLOB_NO_IGNORE).toBe('false');
});

test('tool reads and edits of bot.env are denied', () => {
    expect(settings.permissions?.deny).toEqual(expect.arrayContaining(['Read(**/bot.env)', 'Edit(**/bot.env)']));
});
