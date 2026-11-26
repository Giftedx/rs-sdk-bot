import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEST_NAMES } from '../src/quest/chain';
import { questEntry, questResumable, QUEST_RESUME, SELF_RESUME, squireJournalStage } from '../src/quest/resume';
import { REPO_ROOT } from '../src/quest/types';

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
