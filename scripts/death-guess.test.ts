// A death is the server's: isDead, a higher respawnCount or a new lifeId (sessionDied in packages/core/src/bot.ts).
// In a disconnect the state is blank for a moment: hp() reads a missing skill as 0 and the player is undefined, so
// `p?.lifeId !== life` is true. A line that sets a death flag must not use those guesses.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const DEATH_SET = /\bdied\s*(?:=|\|\|=)(?!=)|\bdied\s*=\s*true|stats\.died\s*=/;
const GUESSES: [string, RegExp][] = [
    ['hp() <= 0', /\bhp\(\)\s*<=\s*0/],
    ['a lifeId test that a blank player passes', /\?\.lifeId\s*!==(?!\s*undefined\b)/],
];

export function deathGuesses(text: string): { line: number; guess: string }[] {
    return text.split('\n').flatMap((l, i) => DEATH_SET.test(l) ? GUESSES.filter(([, re]) => re.test(l)).map(([guess]) => ({ line: i + 1, guess })) : []);
}

function files(dir: string): string[] {
    return readdirSync(dir).flatMap(n => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : files(p);
        return n.endsWith('.ts') && !n.endsWith('.test.ts') ? [p] : [];
    });
}

test('deathGuesses finds the blank-state guesses and passes the exact check', () => {
    expect(deathGuesses('if (hp() <= 0) died = true;')).toEqual([{ line: 1, guess: 'hp() <= 0' }]);
    expect(deathGuesses('if (life !== undefined && p?.lifeId !== life) died = true;')).toHaveLength(1);
    expect(deathGuesses('if (life !== undefined && (p?.lifeId ?? life) !== life) died = true;')).toEqual([]);
    expect(deathGuesses('if (sessionDied(life0, s.sdk.getState()?.player)) died = true;')).toEqual([]);
    expect(deathGuesses('if (hp() <= 0) break;')).toEqual([]);
    expect(deathGuesses('if (player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId) died = true;')).toEqual([]);
});

test('no script sets a death flag from a blank-state guess', () => {
    const found = [join(root, 'scripts'), join(root, 'packages')].flatMap(files)
        .flatMap(f => deathGuesses(readFileSync(f, 'utf8')).map(g => `${relative(root, f).replaceAll('\\', '/')}:${g.line} ${g.guess}`));
    expect(found).toEqual([]);
});
