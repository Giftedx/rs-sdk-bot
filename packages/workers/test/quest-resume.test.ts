import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEST_NAMES } from '../src/quest/chain';
import { arenaFrom, arenaJournalStage, ballJournalStage, crestHeld, crestJournalStage, crestSpent, questEntry, questResumable, QUEST_RESUME, resumeStart, SELF_RESUME, squireJournalStage } from '../src/quest/resume';
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
        expect(questEntry('ball', "Witch's House", 'started').kind).toBe('resume');
        expect(questEntry('imp', 'Imp Catcher', 'started')).toEqual({
            kind: 'refuse',
            reason: 'refused: Imp Catcher journal is started and quest-imp.ts has no resume stage',
        });
        expect(questEntry('imp', 'Imp Catcher', 'not started').kind).toBe('run');
        expect(questEntry('imp', 'Imp Catcher', 'unknown').kind).toBe('run');
        expect(questEntry('imp', 'Imp Catcher', 'complete')).toEqual({ kind: 'refuse', reason: 'refused: Imp Catcher is complete' });
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
        expect(questResumable('imp')).toBe(false);
    });
});

describe('ball journal stage', () => {
    test('the journal of each %ballquest case names its stage; 3 and 5 share one text', () => {
        const k = constants(`${QUESTS}/quest_ball/configs/quest_ball.constant`, 'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant');
        const cases = journalCases(`${QUESTS}/quest_ball/scripts/ball_journal.rs2`);
        expect(cases.map((c) => c.labels)).toEqual([
            ['ball_not_started'], ['ball_started'], ['ball_found_magnet'], ['ball_unlocked_mousedoor', 'ball_read_diary_after_door'],
            ['ball_defeated_experiment'], ['ball_complete'],
        ]);
        expect(k.ball_read_diary_after_door).toBe(5);
        for (const c of cases) expect([c.labels[0], ballJournalStage(c.text)]).toEqual([c.labels[0], k[c.labels[0]!]]);
        expect(ballJournalStage("Witch's House")).toBeUndefined();
    });

    test('the cheese is spent from 3; the magnet and the shed key are withdrawn where the bank blocks them', () => {
        const ball = QUEST_RESUME.ball!;
        expect([1, 2, 3, 6].map((s) => ball.spent!(s))).toEqual([[], [], [1985], [1985]]);
        expect([1, 2, 3, 5, 6].map((s) => ball.held!(s))).toEqual([[], [2410], [2411], [2411], []]);
        expect(resumeStart(ball, "Witch's House", 2)).toEqual({ kind: 'resume', from: 2, spent: [], held: [2410] });
    });
});

// The string literals of crest_journal.rs2 in the order they appear, as the client receives them: colour tags and |
// line breaks included. The first struck line is a plain assignment (`$text = "..."`), the rest are append() calls.
function crestJournalLines(): string[] {
    const src = readFileSync(join(REPO_ROOT, `${QUESTS}/quest_crest/scripts/crest_journal.rs2`), 'utf8');
    return [...src.matchAll(/(?:append\(\$text, |\$text = )"([^"]*)"/g)].map((m) => m[1]!);
}

// The journal of a %crestquest stage, built as crest_journal.rs2 builds it, from the literals the fragments pick.
// `pack` is what the inventory holds for the inv_total lines at 2 (fish) and 7 (jewellery).
function crestJournal(stage: number, pack: { fish?: boolean; jewellery?: boolean } = {}): string {
    const lines = crestJournalLines();
    const one = (re: RegExp): string => {
        const hits = lines.filter((l) => re.test(l));
        if (hits.length !== 1) throw Error(`${re} matched ${hits.length} literals`);
        return hits[0]!;
    };
    const all = (...res: RegExp[]) => res.map(one).join('');
    if (stage === 0) return all(/I can start this quest/, /^@dre@Varrock\|$/, /To complete this quest I need/, /Level 40 Mining/, /Level 40 Crafting/, /Level 40 Smithing/, /Level 59 Magic/, /level 170 Demon/);
    let t = one(/I have agreed to restore/);
    if (stage > 1) t += all(/I found Caleb working as a Chef/, /my Quest for his father/, /split into three/, /three sons taking a piece/);
    else t += all(/I need to find his son/, /White Wolf Mountain/);
    if (stage > 2) t += all(/I gave Caleb the Swordfish/, /needed for his salad/);
    else if (stage === 2) {
        t += one(/will let me have/);
        for (const fish of ['Tuna', 'Bass', 'Salmon', 'Shrimp', 'Swordfish']) t += one(pack.fish ? new RegExp(`I have cooked ${fish}`) : new RegExp(`one cooked ${fish}`));
    }
    if (stage === 3) t += one(/crest piece, I need to find the other/);
    if (stage === 4) t += all(/told me his brother/, /should search for him there/);
    if (stage === 5) t += all(/Gem Trader@dbl@ told me/, /yellow cape/);
    if (stage > 6) t += one(/I found Avan by some gold rocks/);
    else if (stage === 6) t += all(/find a dwarf named/, /knows where to find/);
    if (stage > 7) t += all(/Avan gave me his crest piece/, /ruby necklace made of high quality/);
    else if (stage === 7) {
        t += all(/will give me his @dre@crest piece/, /^@dre@ring@dbl@ and/, /can be found @dre@underground/, /difficult to get to/);
        t += one(pack.jewellery ? /I have a ruby ring made of/ : /I need to make a @dre@ruby ring/);
        t += one(pack.jewellery ? /I have a ruby necklace made of/ : /I need to make a @dre@ruby necklace/);
    }
    if (stage === 8) t += all(/final crest@dbl@ piece/, /magical demon hunter/);
    if (stage > 9) t += all(/I found Johnathan looking very ill/, /He soon recovered/, /^@str@him\.\|$/);
    else if (stage === 9) t += one(/I found @dre@Johnathon@dbl@ looking very ill/);
    if (stage > 10) t += all(/I took all three pieces/, /As a reward Dimintheis/, /could be enchanted by his sons/, /would always return/, /reclaim if I ever lost/, /QUEST COMPLETE/);
    else if (stage === 10) t += all(/lost his piece of the family crest/, /named @dre@Chronozon/, /is very powerful/, /four spells of death/);
    return t;
}

describe('crest journal stage', () => {
    test('each stage of the server journal names its %crestquest stage', () => {
        // 62 literals: 8 not-started lines and 54 started lines (crest_journal.rs2:7-101).
        expect(crestJournalLines()).toHaveLength(62);
        for (let stage = 0; stage <= 11; stage++) expect(crestJournalStage(crestJournal(stage))).toBe(stage);
        expect(crestJournalStage(crestJournal(2, { fish: true }))).toBe(2);
        expect(crestJournalStage(crestJournal(7, { jewellery: true }))).toBe(7);
        expect(crestJournalStage('Family Crest')).toBeUndefined();
    });

    test('the live client text: each line in its own component, joined by spaces', () => {
        // readQuestJournalStage joins the 50 component texts with spaces; a wrapped line breaks at a space.
        for (let stage = 0; stage <= 11; stage++) {
            const components = crestJournal(stage).split('|').map((l) => l.trim());
            expect(crestJournalStage(components.join(' '))).toBe(stage);
        }
    });
});

describe('crest resume start', () => {
    test('every started stage resumes from the start tile at its own stage; complete refuses', () => {
        for (let stage = 1; stage <= 10; stage++) {
            const start = resumeStart(QUEST_RESUME.crest!, 'Family Crest', stage);
            expect(start.kind).toBe('resume');
            if (start.kind === 'resume') expect(start.from).toBe(stage);
        }
        expect(resumeStart(QUEST_RESUME.crest!, 'Family Crest', 11)).toEqual({ kind: 'refuse', reason: 'refused: Family Crest journal stage 11 is complete' });
    });

    test('the fish are spent from 3, the bars and rubies from 6; the pieces are held', () => {
        expect(crestSpent(2)).toEqual([]);
        expect(crestSpent(3)).toEqual([373, 365, 361, 329, 315]);
        expect(crestSpent(5)).toEqual([373, 365, 361, 329, 315]);
        expect(crestSpent(6)).toEqual([373, 365, 361, 329, 315, 2365, 1603]);
        expect(crestHeld(2)).toEqual([]);
        expect(crestHeld(4)).toEqual([779]);
        expect(crestHeld(7)).toEqual([779, 773, 774]);
        expect(crestHeld(8)).toEqual([779, 780]);
        expect(crestHeld(10)).toEqual([779, 780, 781, 782]);
    });
});
