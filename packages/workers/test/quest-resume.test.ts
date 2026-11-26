import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEST_NAMES } from '../src/quest/chain';
import { arenaFrom, arenaJournalStage, questEntry, questResumable, QUEST_RESUME, resumeStart, SELF_RESUME, squireJournalStage } from '../src/quest/resume';
import { REPO_ROOT } from '../src/quest/types';

const QUESTS = 'vendor/rs-sdk/server/content/scripts/quests';

// The `^name = value` constants of the given .constant files.
function constants(...files: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of files) {
        for (const m of readFileSync(join(REPO_ROOT, f), 'utf8').matchAll(/^\^(\w+)\s*=\s*(-?\d+)\s*$/gm)) out[m[1]!] = Number(m[2]);
    }
    return out;
}

// The journal text of each `case` of a server journal's switch, as the client receives it: the string literals of its
// `$text = "..."` and `append($text, "...")` lines in order, colour tags and | line breaks included.
function journalCases(file: string): { labels: string[]; text: string }[] {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    return src.split(/\n\s*case /).slice(1).map((part) => ({
        labels: [...part.slice(0, part.indexOf(':')).matchAll(/\^(\w+)/g)].map((m) => m[1]!),
        text: [...part.matchAll(/(?:\$text = |append\(\$text, )"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).join(''),
    }));
}

describe('arena journal stage', () => {
    test('the journal of each %arenaquest case names its stage', () => {
        const k = constants(`${QUESTS}/quest_arena/configs/quest_arena.constant`, 'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant');
        const cases = journalCases(`${QUESTS}/quest_arena/scripts/arena_journal.rs2`);
        expect(cases.length).toBe(14);
        for (const c of cases) {
            for (const label of c.labels) {
                const stage = k[label];
                expect(stage).toBeNumber();
                expect([label, arenaJournalStage(c.text)]).toEqual([label, Math.min(stage!, 14)]);
            }
        }
        expect(arenaJournalStage('Fight Arena')).toBeUndefined();
    });

    test('the script goes on from the start tile before the ogre and after Bouncer, and refuses in the arena', () => {
        expect([0, 1, 2, 3, 5].map(arenaFrom)).toEqual([0, 1, 2, 3, 5]);
        expect([6, 8, 9, 10, 11].map(arenaFrom)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect([12, 13].map(arenaFrom)).toEqual([12, 12]);
        const arena = QUEST_RESUME.arena!;
        expect(resumeStart(arena, 'Fight Arena', 3)).toEqual({ kind: 'resume', from: 3, spent: [], held: [] });
        expect(resumeStart(arena, 'Fight Arena', 6)).toEqual({ kind: 'refuse', reason: 'refused: Fight Arena journal stage 6 has no resume from the start tile' });
        expect(resumeStart(arena, 'Fight Arena', 14)).toEqual({ kind: 'refuse', reason: 'refused: Fight Arena journal stage 14 is complete' });
    });
});

// The string literals of squire_journal.rs2 in the order they appear, as the client receives them: colour tags and |
// line breaks included.
function squireJournalLines(): string[] {
    const src = readFileSync(join(REPO_ROOT, 'vendor/rs-sdk/server/content/scripts/quests/quest_squire/scripts/squire_journal.rs2'), 'utf8');
    return [...src.matchAll(/append\(\$x, "([^"]*)"\)/g)].map((m) => m[1]!);
}

describe('squire journal stage', () => {
    test('each active line of the server journal names its %squire stage', () => {
        const lines = squireJournalLines();
        const has = (re: RegExp) => lines.filter((l) => re.test(l)).join('');
        // The journal of each stage: the struck lines before it and its own active lines (squire_journal.rs2).
        const start = has(/I can start this quest|in the\|$|courtyard of the|mining level|combat level/);
        const told = has(/I told the Squire|lost\. It could only be made/);
        const found = has(/I found an Imcando|information provided by Reldo|until I gave him a Redberry pie/);
        expect(squireJournalStage(start)).toBe(0);
        expect(squireJournalStage(told + has(/Reldo @dbl@in the|Library @dbl@for information/))).toBe(1);
        expect(squireJournalStage(told + has(/Reldo couldn't give me|southern peninsula|LOVE @dre@redberry pies/))).toBe(2);
        expect(squireJournalStage(told + found + has(/gained his trust through/))).toBe(3);
        expect(squireJournalStage(told + found + has(/needs a @dre@picture of the sword|about obtaining one/))).toBe(4);
        expect(squireJournalStage(told + found + has(/to replace\.\||told me about a @dre@portrait|picture of the sword @dbl@in/))).toBe(5);
        expect(squireJournalStage(told + found + has(/According to @dre@Thurgo|Iron Bars @dbl@and some|deep in the caves|fend off Ice giants/))).toBe(6);
        expect(squireJournalStage(told + found + has(/has now smithed me a replica|return it to the @dre@Squire/))).toBe(6);
        expect(squireJournalStage(told + found + has(/QUEST COMPLETE/))).toBe(7);
        expect(squireJournalStage('The Knight\'s Sword')).toBeUndefined();
    });

    test('the pie is staged only before Thurgo eats it', () => {
        const spent = QUEST_RESUME.squire!.spent!;
        expect(spent(2)).toEqual([]);
        expect(spent(3)).toEqual([2325]);
        expect(spent(6)).toEqual([2325]);
    });
});

describe('quest sweep entry', () => {
    test('a started journal resumes, runs its own branch, or refuses by name', () => {
        expect(questEntry('squire', "The Knight's Sword", 'started').kind).toBe('resume');
        expect(questEntry('priestperil', 'Priest in Peril', 'started').kind).toBe('run');
        expect(questEntry('ball', "Witch's House", 'started')).toEqual({
            kind: 'refuse',
            reason: "refused: Witch's House journal is started and quest-ball.ts has no resume stage",
        });
        expect(questEntry('ball', "Witch's House", 'not started').kind).toBe('run');
        expect(questEntry('ball', "Witch's House", 'unknown').kind).toBe('run');
        expect(questEntry('ball', "Witch's House", 'complete')).toEqual({ kind: 'refuse', reason: "refused: Witch's House is complete" });
    });

    test('a quest point gate refuses only a known total below it', () => {
        expect(questEntry('dragon', 'Dragon Slayer', 'not started', 12)).toEqual({
            kind: 'refuse',
            reason: 'refused: Dragon Slayer needs 32 quest points, the account has 12',
        });
        expect(questEntry('dragon', 'Dragon Slayer', 'not started', 32).kind).toBe('run');
        expect(questEntry('dragon', 'Dragon Slayer', 'not started', undefined).kind).toBe('run');
    });

    test('every resume and self-resume entry names a generated quest with a journal name', () => {
        for (const slug of [...SELF_RESUME, ...Object.keys(QUEST_RESUME)]) {
            expect(QUEST_NAMES[slug]).toBeString();
            expect(questResumable(slug)).toBe(true);
            expect(readFileSync(join(REPO_ROOT, 'scripts/generated', `quest-${slug}.ts`), 'utf8').length).toBeGreaterThan(0);
        }
        expect(questResumable('ball')).toBe(false);
    });
});
