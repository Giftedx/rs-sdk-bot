import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEST_NAMES } from '../src/quest/chain';
import { arenaFrom, arenaJournalStage, ballJournalStage, crestHeld, crestJournalStage, crestSpent, dragonFrom, druidJournalStage, dragonHeld, dragonJournalStage, dragonSpent, grailFrom, grailJournalStage, ikovJournalStage, merlinJournalStage, resumeFrom, questEntry, questResumable, QUEST_RESUME, resumeStart, SELF_RESUME, squireJournalStage } from '../src/quest/resume';
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
        expect(resumeStart(arena, 'Fight Arena', 3)).toEqual({ kind: 'resume', from: 3, spent: [], held: [], extra: [] });
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

describe('druid journal stage', () => {
    // The branches of druid_journal.rs2 in order: each `%druidquest = ^name` test, and the final else (complete).
    function druidBranches(): { label: string; text: string }[] {
        const src = readFileSync(join(REPO_ROOT, `${QUESTS}/quest_druid/scripts/druid_journal.rs2`), 'utf8');
        return src.split(/\n\s*(?:\}\s*else\s*)?if\s*\(|\n\s*\}\s*else\s*\{/).slice(1).map((part) => ({
            label: part.match(/^%druidquest = \^(\w+)\)/)?.[1] ?? 'druid_complete',
            text: [...part.matchAll(/(?:\$text = |append\(\$text, )"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).join(''),
        }));
    }

    test('the journal of each %druidquest branch names its stage', () => {
        const k = constants(`${QUESTS}/quest_druid/configs/quest_druid.constant`, 'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant');
        const branches = druidBranches();
        expect(branches.map((b) => b.label)).toEqual(['druid_not_started', 'druid_started', 'druid_spoken_sanfew', 'druid_given_ingredients', 'druid_complete']);
        for (const b of branches) {
            expect(k[b.label]).toBeNumber();
            expect([b.label, druidJournalStage(b.text)]).toEqual([b.label, k[b.label]]);
        }
        expect(druidJournalStage('Druidic Ritual')).toBeUndefined();
    });

    // Live: Moneyshot and Shaftsinker failed "step dip 2132" in the cauldron room at stage 2, and each later login
    // failed "talk kaqemeex 1": Kaqemeex at 1-2 says only "speak to my fellow druid Sanfew" (kaqemeex.rs2:6-8).
    test('a started journal resumes at its stage; the meats are spent at 3', () => {
        expect(questEntry('druid', 'Druidic Ritual', 'started')).toEqual({ kind: 'resume', resume: QUEST_RESUME.druid! });
        const druid = QUEST_RESUME.druid!;
        expect(resumeStart(druid, 'Druidic Ritual', 2)).toEqual({ kind: 'resume', from: 2, spent: [], held: [522, 523, 524, 525], extra: [] });
        expect(resumeStart(druid, 'Druidic Ritual', 3)).toEqual({ kind: 'resume', from: 3, spent: [2132, 2134, 2136, 2138], held: [], extra: [] });
        expect(resumeStart(druid, 'Druidic Ritual', 4)).toEqual({ kind: 'refuse', reason: 'refused: Druidic Ritual journal stage 4 is complete' });
    });

    test('quest-druid.ts starts at the stage and reads its own journal on a direct run', () => {
        const src = readFileSync(join(REPO_ROOT, 'scripts/generated/quest-druid.ts'), 'utf8');
        expect(src).toContain("q.stageFrom('DRUID_FROM')");
        expect(src).toContain("readQuestJournalStage(q, 'druid', /Druidic Ritual/i, druidJournalStage)");
        for (const stage of [1, 2, 3]) expect(src).toContain(`FROM < ${stage}`);
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
        expect(resumeStart(ball, "Witch's House", 2)).toEqual({ kind: 'resume', from: 2, spent: [], held: [2410], extra: [] });
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

// The string literals of grail_journal.rs2 in the order they appear, as the client receives them.
function grailJournalLines(): string[] {
    const src = readFileSync(join(REPO_ROOT, `${QUESTS}/quest_grail/scripts/grail_journal.rs2`), 'utf8');
    return [...src.matchAll(/(?:\$text = |append\(\$text, )"([^"]*)"/g)].map((m) => m[1]!);
}

describe('grail journal stage', () => {
    const lines = grailJournalLines();
    const has = (re: RegExp) => lines.filter((l) => re.test(l)).join('');
    // The journal of each stage: the struck lines of the earlier stages and its own lines (grail_journal.rs2 branches).
    const notStarted = has(/I can start this quest|@dre@Camelot Castle@dbl@, just|must be able to defeat|120 Black Knight Titan/);
    const struckStart = has(/I started my Quest for the Holy Grail|sent me to Merlin for advice/);
    const struckRealm = has(/I spoke to Galahad|gave me a napkin|^@str@King\.\|$|used the napkin|me to the Realm of the Fisher King\.\||I blew the Whistle|teleported to the Realm|path to\|$|castle was blocked|called the Black Knight Titan/);
    const struckTitan = has(/defeated the Black Knight Titan|power\.Once past|couldn't give me the Grail|restores the land|^@str@Grail\.\|$/);
    const struckPercival = has(/I honoured the Fisher King|used a Magic Golden Feather|heard of his father's illness|Castle using a Magic Whistle/);
    const percival = has(/is very sick|son @dre@Sir Percival/);
    const done = struckStart + struckRealm + struckTitan + has(/I returned to the Grail Castle|been renewed|gratitude he allowed|prowess as a Knight|QUEST COMPLETE/);

    test('each stage of the server journal names its %grail stage', () => {
        expect(lines.length).toBe(46);
        expect(grailJournalStage(notStarted)).toBe(0);
        expect(grailJournalStage(has(/has sent me questing|legend\. I should start|study next to the Camelot library/))).toBe(2);
        expect(grailJournalStage(struckStart + has(/suggested two things|lives @dre@West|someone on a '/))).toBe(3);
        expect(grailJournalStage(struckStart + has(/According to a Crone|Six Heads' face|To get the @dre@Magic Whistle|to a @dre@Haunted House/))).toBe(4);
        expect(grailJournalStage(struckStart + struckRealm + has(/find a @dre@weapon/))).toBe(7);
        expect(grailJournalStage(struckStart + struckRealm + struckTitan + percival)).toBe(8);
        // With the feather in the pack (grail_journal.rs2:64-67).
        expect(grailJournalStage(struckStart + struckRealm + struckTitan + percival + has(/magic golden feather@dbl@ to help|I should use it to find him/))).toBe(8);
        // Without and with the grail in the pack (grail_journal.rs2:75-79).
        expect(grailJournalStage(struckStart + struckRealm + struckTitan + struckPercival + has(/I should follow him/))).toBe(9);
        expect(grailJournalStage(struckStart + struckRealm + struckTitan + struckPercival + has(/Now I have the @dre@Grail/))).toBe(9);
        expect(grailJournalStage(done)).toBe(10);
        // %grail 5 or 6: no server script sets them, and the journal holds only the struck start lines.
        expect(grailJournalStage(struckStart)).toBeUndefined();
        expect(grailJournalStage('Holy Grail')).toBeUndefined();
        expect(done.split('|').length).toBeLessThanOrEqual(49);
    });

    test('a resume before the titan gets Excalibur again if lost; after it, Excalibur is not staged', () => {
        expect([2, 3, 4, 7, 8, 9].map(grailFrom)).toEqual([1, 2, 3, 3, 7, 8]);
        expect([5, 6].map(grailFrom)).toEqual([undefined, undefined]);
        const grail = QUEST_RESUME.grail!;
        expect(resumeStart(grail, 'Holy Grail', 4)).toEqual({ kind: 'resume', from: 3, spent: [35], held: [15, 16, 35], extra: [{ id: 995, count: 500 }] });
        expect(resumeStart(grail, 'Holy Grail', 8)).toEqual({ kind: 'resume', from: 7, spent: [35, 1333], held: [15, 16], extra: [] });
        expect(resumeStart(grail, 'Holy Grail', 9)).toEqual({ kind: 'resume', from: 8, spent: [35, 1333], held: [15, 16, 19], extra: [] });
        expect(resumeStart(grail, 'Holy Grail', 6)).toEqual({ kind: 'refuse', reason: 'refused: Holy Grail journal stage 6 has no resume from the start tile' });
    });
});

describe('merlin journal stage', () => {
    test('the journal of each %arthur case names its stage', () => {
        const k = constants(`${QUESTS}/quest_arthur/configs/quest_arthur.constant`, 'vendor/rs-sdk/server/content/scripts/general/configs/quest.constant');
        const cases = journalCases(`${QUESTS}/quest_arthur/scripts/arthur_journal.rs2`);
        expect(cases.map((c) => c.labels[0])).toEqual([
            'arthur_not_started', 'arthur_started', 'arthur_spoken_gawain', 'arthur_spoken_lancelot', 'arthur_spoken_morgan_lefaye',
            'arthur_excalibur_bound', 'arthur_freed_merlin', 'arthur_complete',
        ]);
        // Stage 4 holds both lines of each if/else pair of arthur_journal.rs2:45-63 here; the parser reads neither.
        for (const c of cases) expect([c.labels[0], merlinJournalStage(c.text)]).toEqual([c.labels[0], k[c.labels[0]!]]);
        expect(merlinJournalStage("Merlin's Crystal")).toBeUndefined();
    });

    test('the varp stage maps to the script milestone, and the held and spent items follow the stage', () => {
        const merlin = QUEST_RESUME.merlin!;
        expect(merlin.key).toBe('arthur');
        expect([0, 1, 2, 3, 4, 5, 6].map((s) => resumeFrom(merlin, s))).toEqual([0, 1, 2, 3, 4, 8, 9]);
        expect(resumeStart(merlin, "Merlin's Crystal", 4)).toEqual({ kind: 'resume', from: 4, spent: [], held: [32, 38, 35], extra: [] });
        expect(resumeStart(merlin, "Merlin's Crystal", 5)).toEqual({ kind: 'resume', from: 8, spent: [30], held: [35], extra: [] });
        expect(resumeStart(merlin, "Merlin's Crystal", 6)).toEqual({ kind: 'resume', from: 9, spent: [30, 2309], held: [], extra: [] });
    });
});

// The string literals of ikov_journal.rs2 in the order they appear, as the client receives them.
function ikovJournalLines(): string[] {
    const src = readFileSync(join(REPO_ROOT, `${QUESTS}/quest_ikov/scripts/ikov_journal.rs2`), 'utf8');
    return [...src.matchAll(/append\(\$x, "([^"]*)"\)/g)].map((m) => m[1]!);
}

describe('ikov journal stage', () => {
    const lines = ikovJournalLines();
    // The nth literal that matches: the 20/30 block and the 40+ block both open with the same struck line.
    const pick = (re: RegExp, nth = 0): string => {
        const hit = lines.filter((l) => re.test(l))[nth];
        if (hit === undefined) throw Error(`no journal literal ${re} #${nth}`);
        return hit;
    };
    // The journal of each stage, as the branches of ikov_journal.rs2 build it.
    const start = pick(/I can start this quest/) + pick(/I must have/) + pick(/Level 42 thieving/) + pick(/Level 40 ranged/);
    const started = pick(/^@dre@Lucien@dbl@ has asked me/);
    const struck = pick(/^@str@Lucien has asked me/) + pick(/^@str@the Temple of Ikov/) + pick(/^@str@given me a pendant/);
    const trap = struck + pick(/chamber of fear\. I found a trap on a\|/, 0) + pick(/I pulled the lever\.\|/) + pick(/boots of lightness/) + pick(/Ice Cavern/);
    const fought = struck + pick(/chamber of fear\. I found a trap on a\|/, 1) + pick(/I pulled the lever; I went into/) + pick(/attacked by a Fire Warrior/) + pick(/my trusty bow/);
    const spoken = fought + pick(/My path is blocked by lava/);
    const paid = fought + pick(/My path was blocked by lava/) + pick(/after I got her twenty limpwurt roots/);
    const helping = fought + pick(/I will kill/);
    const armadyl = struck + pick(/I killed\|$/) + pick(/banished him/) + pick(/QUEST COMPLETE/);
    const lucienSide = struck + pick(/I recovered the Staff/) + pick(/staying at his house/) + pick(/made him more powerful/) + pick(/QUEST COMPLETE/);

    test('each branch of the server journal names its %ikov stage', () => {
        expect(lines.length).toBe(27);
        const want: [string, number][] = [[start, 0], [started, 10], [trap, 20], [fought, 40], [spoken, 50], [paid, 60], [helping, 70], [armadyl, 80], [lucienSide, 90]];
        for (const [j, stage] of want) {
            expect(ikovJournalStage(j)).toBe(stage);
            // The client's components, one line each, joined by spaces.
            expect(ikovJournalStage(j.split('|').join(' '))).toBe(stage);
        }
        expect(ikovJournalStage('Temple of Ikov')).toBeUndefined();
    });

    test('each started stage maps to a stage name of quest-ikov.ts; the lit candle is spent after the boots', () => {
        const ikov = QUEST_RESUME.ikov!;
        expect([10, 20, 30, 40, 50, 60, 70].map((s) => resumeFrom(ikov, s))).toEqual([1, 2, 2, 4, 5, 5, 6]);
        expect(resumeStart(ikov, 'Temple of Ikov', 10)).toEqual({ kind: 'resume', from: 1, spent: [], held: [86], extra: [] });
        expect(resumeStart(ikov, 'Temple of Ikov', 20)).toEqual({ kind: 'resume', from: 2, spent: [33, 946], held: [86, 78], extra: [] });
        expect(resumeStart(ikov, 'Temple of Ikov', 90)).toEqual({ kind: 'refuse', reason: 'refused: Temple of Ikov journal stage 90 is complete' });
        // quest-ikov.ts names its stages in this order.
        expect(readFileSync(join(REPO_ROOT, 'scripts/generated/quest-ikov.ts'), 'utf8')).toContain("const STAGES = ['start', 'low', 'arrows', 'warrior', 'winelda', 'teleport', 'lucien'] as const;");
    });
});

describe('dragon', () => {
    const DS_JOURNAL = `${QUESTS}/quest_dragon/scripts/dragon_journal.rs2`;

    // The string literals of dragon_journal.rs2 in file order, as the client receives them: colour tags and | line breaks
    // included. The journal is a chain of `if` blocks and procs, so each test below joins the literals that the blocks of
    // its varp values append, in the order the script appends them.
    const LITS = [...readFileSync(join(REPO_ROOT, DS_JOURNAL), 'utf8').matchAll(/(?:\$text = |append\(\$text, )"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    const one = (re: RegExp): string => {
        const l = LITS.find((x) => re.test(x));
        if (l === undefined) throw Error(`no journal literal ${re}`);
        return l;
    };
    const span = (from: RegExp, to: RegExp): string => {
        const a = LITS.findIndex((x) => from.test(x));
        const b = LITS.findIndex((x, i) => i >= a && to.test(x));
        if (a < 0 || b < a) throw Error(`no journal span ${from} ${to}`);
        return LITS.slice(a, b + 1).join('');
    };

    const GUILD = one(/^@str@The Guildmaster of the Champions' Guild said his friend/);
    const OZIACH = one(/^@dre@Oziach@dbl@ will sell me/);
    const NEED = one(/^@dbl@To defeat the dragon I will need/) + one(/^@dbl@of @dre@protection@dbl@ against/);
    const PIECE = {
        melzar: { found: one(/I found the piece of the map that was hidden in Melzar's/), not: one(/One-third of the map is in @dre@Melzar's Maze/) },
        ice: { found: one(/hidden in beneath Ice/), rhyme: span(/I asked the @dre@Oracle/, /^Last, a bowl that's not seen heat/), not: one(/only the @dre@Oracle@dbl@ on @dre@Ice/) },
        goblin: { found: one(/the goblin, Wormbrain,/), not: one(/stolen by a @dre@goblin/) },
    };
    const SHIELD = { given: one(/The Duke of Lumbridge gave me/), ask: one(/I should ask the @dre@Duke of Lumbridge/) };
    const REPAIR = { need: one(/My ship will need some repairs/), done: one(/I have repaired my ship using/) };
    const BOUGHT = one(/^@str@I bought a ship in Port Sarim/);
    const CAPTAIN = one(/I still need to find a @dre@captain/);
    const NED = one(/^@str@Captain Ned from Draynor Village has agreed/);
    const ALL_FOUND = PIECE.melzar.found + PIECE.ice.found + PIECE.goblin.found;

    type Pieces = { melzar: 'found' | 'not'; ice: 'found' | 'rhyme' | 'not'; goblin: 'found' | 'not'; shield: 'given' | 'ask' };
    const pieces = (p: Pieces) => PIECE.melzar[p.melzar] + PIECE.ice[p.ice] + PIECE.goblin[p.goblin] + SHIELD[p.shield];

    // The journal of each varp state, as dragon_journal.rs2 builds it.
    const J = {
        start: (qp32: boolean) => span(/I can start this quest/, /level 83 dragon/) + one(qp32 ? /^@str@To enter the Champions' Guild/ : /^@dbl@To enter the Champions' Guild/),
        s1: () => GUILD + one(/I should speak to @dre@Oziach/),
        // %dragonquest 2 or 3 with a side varp unset (:26-27, :38-39).
        oziachAgain: () => GUILD + OZIACH + one(/I should return to @dre@Oziach/),
        s2: (p: Pieces) => GUILD + OZIACH + NEED + pieces(p) + one(/ship@dbl@ for sale in @dre@Port Sarim/),
        s3: (p: Pieces) => GUILD + OZIACH + NEED + pieces(p) + BOUGHT + REPAIR.need + CAPTAIN,
        s7: (p: Pieces) => GUILD + OZIACH + NEED + pieces(p) + BOUGHT + REPAIR.done + CAPTAIN,
        s8: (shield: 'given' | 'ask') => GUILD + OZIACH + ALL_FOUND + SHIELD[shield] + BOUGHT + REPAIR.done + NED + one(/Now I should go to my ship/),
        // After the crash %dragonquestvar is 0 (dragonslayer_ned.rs2:24), so the repairs line is the unrepaired one.
        s9: (wall: boolean, repaired = false) => GUILD + OZIACH + ALL_FOUND + SHIELD.given
            + (wall ? one(/secret passage leading from\|/) : NED + (repaired ? REPAIR.done : REPAIR.need)) + one(/Now all I need to do is kill/),
        complete: () => GUILD + span(/^@str@Oziach would sell me Rune Plate Mail/, /QUEST COMPLETE!/),
    };

    const P = (melzar: Pieces['melzar'], ice: Pieces['ice'], goblin: Pieces['goblin'], shield: Pieces['shield']): Pieces => ({ melzar, ice, goblin, shield });

    describe('dragon journal stage', () => {
        test('each varp state of the server journal names its stage', () => {
            expect(dragonJournalStage(J.start(false))).toBe(0);
            expect(dragonJournalStage(J.start(true))).toBe(0);
            expect(dragonJournalStage(J.s1())).toBe(10);
            expect(dragonJournalStage(J.oziachAgain())).toBe(20);
            // %dragonquest 2, side varps set: Oracle not asked (or piece 3 banked), the rhyme, piece 3 in the pack.
            expect(dragonJournalStage(J.s2(P('not', 'not', 'not', 'ask')))).toBe(21);
            expect(dragonJournalStage(J.s2(P('found', 'not', 'not', 'given')))).toBe(21);
            expect(dragonJournalStage(J.s2(P('not', 'rhyme', 'not', 'ask')))).toBe(22);
            expect(dragonJournalStage(J.s2(P('not', 'found', 'not', 'ask')))).toBe(23);
            expect(dragonJournalStage(J.s2(P('found', 'found', 'not', 'given')))).toBe(23);
            expect(dragonJournalStage(J.s3(P('found', 'found', 'not', 'given')))).toBe(30);
            expect(dragonJournalStage(J.s3(P('not', 'not', 'not', 'given')))).toBe(30);
            expect(dragonJournalStage(J.s7(P('found', 'found', 'not', 'given')))).toBe(70);
            expect(dragonJournalStage(J.s7(P('found', 'found', 'found', 'given')))).toBe(70);
            expect(dragonJournalStage(J.s8('given'))).toBe(80);
            expect(dragonJournalStage(J.s8('ask'))).toBe(80);
            expect(dragonJournalStage(J.s9(false))).toBe(90);
            expect(dragonJournalStage(J.s9(false, true))).toBe(90);
            expect(dragonJournalStage(J.s9(true))).toBe(90);
            expect(dragonJournalStage(J.complete())).toBe(100);
            expect(dragonJournalStage('Dragon Slayer')).toBeUndefined();
        });

        test('a journal split into components with the colour carried over still reads', () => {
            // The client joins up to 50 components (packages/core/src/quest-journal.ts): one line each, | removed.
            const lines = J.s2(P('not', 'rhyme', 'not', 'ask')).split('|');
            expect(dragonJournalStage(lines.map((l) => `@dbl@${l}`).join(' '))).toBe(22);
            expect(dragonJournalStage(J.s9(false).split('|').join('   '))).toBe(90);
        });

        // split_init(400, 49, q8_full) shows 49 lines (player/scripts/quest_journal.rs2:3). The engine's own split
        // (FontType.split, run in dragon-lines.ts) breaks no line of this journal at 400 px, so a journal has one line for
        // each | piece, less a trailing empty one: at most 27 (the rhyme with the ship bought, which quest-dragon.ts never
        // leaves), 24 at stage 22.
        test('every journal fits in the 49 lines of split_init, so no stage loses its last lines', () => {
            const lines = (t: string) => t.split('|').filter((l, i, a) => i < a.length - 1 || l !== '').length;
            const all = [J.start(false), J.s1(), J.oziachAgain(), J.s2(P('not', 'rhyme', 'not', 'ask')), J.s2(P('found', 'found', 'found', 'given')),
                J.s3(P('not', 'rhyme', 'not', 'ask')), J.s7(P('not', 'rhyme', 'not', 'ask')), J.s7(P('found', 'found', 'found', 'given')),
                J.s8('given'), J.s9(false), J.s9(true), J.complete()];
            expect(lines(J.s2(P('not', 'rhyme', 'not', 'ask')))).toBe(24);
            expect(Math.max(...all.map(lines))).toBe(27);
        });
    });

    describe('dragon resume', () => {
        test('each stage maps to a DS_FROM milestone, or none past the quest', () => {
            expect([0, 10, 20, 21, 22, 23, 30, 70, 80, 90].map(dragonFrom)).toEqual([0, 1, 1, 2, 3, 4, 11, 12, 14, 15]);
            expect([100, 2, 3, 7, 24].map(dragonFrom)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        });

        test('held quest items and spent preset items follow the server scripts', () => {
            expect(dragonHeld(10)).toEqual([]);
            expect(dragonHeld(22)).toEqual([1542, 1537, 1535, 1540]);
            expect(dragonHeld(21)).toEqual([1542, 1537, 1535, 1540]);
            expect(dragonHeld(70)).toEqual([1535, 1536, 1537, 1538, 1540]);
            expect(dragonHeld(90)).toEqual([1540]);
            expect(dragonSpent(22)).toEqual([]);
            expect(dragonSpent(23)).toEqual([1907, 1791, 301, 950]);
            expect(dragonSpent(80)).toEqual([1907, 1791, 301, 950, 960, 1539, 995]);
            // The second sail after the crash needs the planks and nails again.
            expect(dragonSpent(90)).not.toContain(960);
            expect(dragonSpent(90)).not.toContain(1539);
        });

        test('the sweep resumes at the stage that live runs left, and refuses a complete journal', () => {
            expect(resumeStart(QUEST_RESUME.dragon!, 'Dragon Slayer', 22)).toEqual({ kind: 'resume', from: 3, spent: [], held: [1542, 1537, 1535, 1540], extra: [] });
            expect(resumeStart(QUEST_RESUME.dragon!, 'Dragon Slayer', 90)).toEqual({ kind: 'resume', from: 15, spent: [1907, 1791, 301, 950, 995], held: [1540], extra: [] });
            expect(resumeStart(QUEST_RESUME.dragon!, 'Dragon Slayer', 100)).toEqual({ kind: 'refuse', reason: 'refused: Dragon Slayer journal stage 100 is complete' });
            expect(resumeStart(QUEST_RESUME.dragon!, 'Dragon Slayer', 24)).toEqual({ kind: 'refuse', reason: 'refused: Dragon Slayer journal stage 24 has no resume from the start tile' });
            expect(QUEST_RESUME.dragon!.key).toBe('dragon');
            expect(QUEST_RESUME.dragon!.title.test('@dre@Dragon Slayer')).toBe(true);
        });

        test('the journal button and title are the server ones', () => {
            const src = readFileSync(join(REPO_ROOT, DS_JOURNAL), 'utf8');
            expect(src).toContain('[if_button,questlist:dragon]');
            expect(src).toContain('~quest_journal("Dragon Slayer", $text);');
        });
    });
});
