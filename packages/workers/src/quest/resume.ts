// What a quest sweep does with the journal state that it finds at entry. Quest varps never reach the client
// (packages/core/src/quest-status.ts), so a run that ended mid-quest leaves a started journal and nothing else. A generated
// quest script starts at its first step, and the NPC of that step no longer says the text that the step waits for: the
// restart fails the same way on every login (live: "fail talk squire 1" after "fail talk thurgo pie").
// A quest in QUEST_RESUME reads its stage from the journal text and starts the script at that stage (q.stageFrom in
// scripts/generated/quest-lib.ts). A quest in SELF_RESUME reads the started journal in its own script or sweep branch.
// Any other started quest ends at entry with a named refusal, and the planner does not choose it for that account.
import { journalText } from '../../../core/src/quest-journal';

export type QuestJournalState = 'not started' | 'started' | 'complete' | 'unknown';

export type QuestResume = {
    // questlist:<key>, the quest list button that opens the journal.
    readonly key: string;
    // The journal title (interface 8144).
    readonly title: RegExp;
    // The varp stage that the journal text names, or undefined.
    readonly stage: (body: string) => number | undefined;
    // The varp stage at completion: a journal at this stage or higher has nothing to resume.
    readonly complete: number;
    // Items of the start preset that the quest takes before a stage: the sweep does not stage them for that stage.
    readonly spent?: (stage: number) => readonly number[];
    // The script's FROM value for a varp stage (default: the stage itself). Undefined: the script cannot go on from the
    // start tile at that stage (the account stands in a cell, an arena or a cutscene), and the sweep refuses by name.
    readonly from?: (stage: number) => number | undefined;
    // Quest items that the account got before a stage and that the script needs: the sweep withdraws them when the
    // pack and the worn slots do not hold them.
    readonly held?: (stage: number) => readonly number[];
};

// The script's FROM value for a journal stage, or undefined for a stage with no resume from the start tile.
export function resumeFrom(resume: QuestResume, stage: number): number | undefined {
    return resume.from ? resume.from(stage) : stage;
}

// The Knight's Sword: %squire (varp 122), quests/quest_squire/configs/quest_squire.constant and quest.constant:55. The
// active lines of squire_journal.rs2, from the highest stage down.
export function squireJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 7;
    if (/to make a replica sword he will need two Iron Bars/i.test(text) || /Thurgo has now smithed me a replica of Sir Vyvin's sword/i.test(text)) return 6;
    if (/The Squire told me about a portrait of Sir Vyvin's father/i.test(text)) return 5;
    if (/Thurgo needs a picture of the sword before he can help/i.test(text)) return 4;
    if (/He will help me now I have gained his trust through pie/i.test(text)) return 3;
    if (/they dislike strangers, and LOVE redberry pies/i.test(text)) return 2;
    if (/The Squire suggests I speak to Reldo/i.test(text)) return 1;
    if (/I can start this quest by talking to the Squire/i.test(text)) return 0;
    return undefined;
}

// Fight Arena: %arenaquest (varp 17), quests/quest_arena/configs/quest_arena.constant and quest.constant:3 (complete 14
// and 15). Each stage's own line of arena_journal.rs2, from the highest stage down: a stage's line comes back struck at
// later stages, and journalText drops the colour tags that tell them apart.
export function arenaJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 14;
    if (/General Khazard was a tough foe, but I eventually killed him/i.test(text)) return 13;
    if (/He challenged me to fight him, but I ran away/i.test(text)) return 12;
    if (/but he wants to kill me himself/i.test(text)) return 11;
    if (/General Khazard ordered me to fight his pet, Bouncer/i.test(text)) return 10;
    if (/I'm going to have to fight in the Arena!/i.test(text)) return 9;
    if (/I should talk to Jeremy in the Fight Arena!/i.test(text)) return 8;
    if (/I need to protect Jeremy and his father from a huge Ogre/i.test(text)) return 6;
    if (/Now I've got the keys I should try to rescue Lady Servil's family/i.test(text)) return 5;
    if (/One of the guards told me that he really likes Khali Brew/i.test(text)) return 3;
    if (/Luckily I found some Khazard armour in a chest/i.test(text)) return 2;
    if (/I should go to the Fight Arena and try to find her family/i.test(text)) return 1;
    if (/I can start this quest by speaking to Lady Servil/i.test(text)) return 0;
    return undefined;
}

// quest-arena.ts goes on from the start tile beside Lady Servil before the ogre fight (1-5: the chest gives the Khazard
// armour again and the drunk guard spare keys, quest_arena.rs2:5-28, khazard_guard.rs2:78-83) and after it (12-13: Lady
// Servil queues the completion, lady_servil.rs2:8-13). At 6-11 the account stands in the arena or the cells: the arena
// door from the inside starts the ogre fight again at 6 (quest_arena.rs2:118-123), and the cells hold it at 9.
export function arenaFrom(stage: number): number | undefined {
    if (stage <= 5) return stage;
    if (stage === 12 || stage === 13) return 12;
    return undefined;
}

// Family Crest: %crestquest (varp 148), quests/quest_crest/configs/quest_crest.constant:1-11 and quest.constant:13
// (complete 11). The journal reads no other varp; the fish lines at 2 and the jewellery lines at 7 read the pack
// (crest_journal.rs2:37-41, 73-74). Each stage's own active line of crest_journal.rs2, from the highest stage down.
// The longest journal (stage 10) has about 20 lines, under the 49 that split_init shows.
export function crestJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 11;
    if (/Johnathon lost his piece of the family crest to a demon/i.test(text)) return 10;
    if (/I found Johnathon looking very ill at the Jolly Boar Inn/i.test(text)) return 9;
    if (/The final crest piece is with their brother Johnathon/i.test(text)) return 8;
    if (/Avan will give me his crest piece if I can bring him a ruby/i.test(text)) return 7;
    if (/I should find a dwarf named Boot who lives somewhere in/i.test(text)) return 6;
    if (/The Al-Kharid Gem Trader told me that Avan is wearing a/i.test(text)) return 5;
    if (/Caleb told me his brother Avan is on a treasure hunt/i.test(text)) return 4;
    if (/I have one crest piece, I need to find the other two/i.test(text)) return 3;
    if (/Caleb will let me have his piece in return for/i.test(text)) return 2;
    if (/I need to find his son Caleb\. The last Dimintheis heard of/i.test(text)) return 1;
    if (/I can start this quest by speaking to Dimintheis/i.test(text)) return 0;
    return undefined;
}

// Caleb takes the 5 cooked fish at 2 -> 3 (crest_caleb.rs2:64-79). quest-crest.ts makes the ring and necklace from the
// 2 'perfect' gold bars and 2 rubies after the gem trader (5) and before Avan's first talk (6), so they are spent from 6.
// At 5 the journal does not tell whether the jewellery is made, so the bars and rubies are staged. Johnathon takes one
// of the 2 antipoisons (crest_johnathon.rs2:21) and the script drinks the other, so neither is in `spent`.
const CREST_FISH = [373, 365, 361, 329, 315]; // swordfish, bass, tuna, salmon, shrimp
const CREST_BAR = 2365, CREST_RUBY = 1603;
// The server names Caleb's piece avan_crest (779) and Avan's piece caleb_crest (780) (crest_caleb.rs2:79, crest_man.rs2:59).
const CREST_PIECE_CALEB = 779, CREST_PIECE_AVAN = 780, CREST_PIECE_JOHNATHON = 781, FAMILY_CREST = 782;
const CREST_RING = 773, CREST_NECKLACE = 774;

export function crestSpent(stage: number): readonly number[] {
    return [...(stage >= 3 ? CREST_FISH : []), ...(stage >= 6 ? [CREST_BAR, CREST_RUBY] : [])];
}

// The quest items of a stage that quest-crest.ts needs: Caleb's piece from 3 (crest_caleb.rs2:79); the 'perfect' ring
// and necklace from 5 until Avan takes them at 7 -> 8 (crest_man.rs2:53-59); Avan's piece from 8; at 10 Johnathon's
// piece (Chronozon's drop, crest_chronozon.rs2:4-5) or the joined crest (quest_crest.rs2:117-123).
export function crestHeld(stage: number): readonly number[] {
    if (stage >= 10) return [CREST_PIECE_CALEB, CREST_PIECE_AVAN, CREST_PIECE_JOHNATHON, FAMILY_CREST];
    if (stage >= 8) return [CREST_PIECE_CALEB, CREST_PIECE_AVAN];
    if (stage >= 5) return [CREST_PIECE_CALEB, CREST_RING, CREST_NECKLACE];
    if (stage >= 3) return [CREST_PIECE_CALEB];
    return [];
}

// Witch's House: %ballquest (varp 226), quests/quest_ball/configs/quest_ball.constant:1-6 and quest.constant:5. The
// active lines of ball_journal.rs2, from the highest stage down. Stages 3 and 5 (the diary read after the mouse) show
// one text (ball_journal.rs2:30-33): the parser names 3, and quest-ball.ts runs both alike.
export function ballJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 7;
    if (/Now the shapeshifter is dead I should return the boy's ball/i.test(text)) return 6;
    if (/I have worked out how to unlock the back door to the garden/i.test(text)) return 3;
    if (/I have found a magnet in a cupboard in the basement/i.test(text)) return 2;
    if (/I should find a way into the garden where the ball is/i.test(text)) return 1;
    if (/I can start this quest by speaking to the little boy/i.test(text)) return 0;
    return undefined;
}

const BALL_CHEESE = 1985, BALL_MAGNET = 2410, BALL_SHED_KEY = 2411;

const SQUIRE_PIE = 2325;

export const QUEST_RESUME: Readonly<Record<string, QuestResume>> = {
    // Thurgo eats the redberry pie at stage 2 -> 3 (quest_squire.rs2:125-151).
    squire: { key: 'squire', title: /Knight's Sword/i, stage: squireJournalStage, complete: 7, spent: (stage) => (stage >= 3 ? [SQUIRE_PIE] : []) },
    // The pack has no item that the quest takes: the barman's 5 coins come from the staged 20.
    arena: { key: 'arena', title: /Fight Arena/i, stage: arenaJournalStage, complete: 14, from: arenaFrom },
    // quest-crest.ts goes on from the start tile beside Dimintheis at every stage 1-10: each later block starts with a
    // teleport (the Lumbridge teleport and the toll gate into Al Kharid at 5-7, the Varrock teleport at 10).
    crest: { key: 'crest', title: /Family Crest/i, stage: crestJournalStage, complete: 11, spent: crestSpent, held: crestHeld },
    // The mouse hole takes the cheese before the magnet unlocks the back door (quest_ball.rs2:80-86, 111-112). The
    // cupboard gives a magnet and the fountain a shed key only when the pack and the bank hold none (:67-70, :163-165),
    // so the sweep withdraws a banked one.
    ball: {
        key: 'ball', title: /Witch's House/i, stage: ballJournalStage, complete: 7,
        spent: (stage) => (stage >= 3 ? [BALL_CHEESE] : []),
        held: (stage) => (stage === 2 ? [BALL_MAGNET] : stage === 3 || stage === 5 ? [BALL_SHED_KEY] : []),
    },
};

// Quests whose script or sweep branch reads a started journal itself: the journal stage parsers of priestperil, zanaris,
// rj and totem, the journal-flag branches of cook, druidspirit, fluffs, hetty, hunt, priest, runemysteries, sheepherder
// and vampire, the held armour and Ceril's greeting of hazeelcult, and the sweep's own Black Knight return to Amik
// (sweep-plan.ts returnToAmik).
export const SELF_RESUME: ReadonlySet<string> = new Set([
    'blackknight', 'cook', 'druidspirit', 'fluffs', 'hazeelcult', 'hetty', 'hunt', 'priest', 'priestperil', 'rj',
    'runemysteries', 'sheepherder', 'totem', 'vampire', 'zanaris',
]);

// A quest that can go on from a started journal.
export function questResumable(slug: string): boolean {
    return SELF_RESUME.has(slug) || Object.hasOwn(QUEST_RESUME, slug);
}

// The quest points that the start of a quest tests: the Champions' Guild door before the guildmaster of Dragon Slayer
// (live quest_board:dragon: "The door won't open - you need at least 32 Quest Points"), the Heroes' Guild for Heroes'
// Quest and the Legends' Guild for Legends' Quest. The server sends %qp (varp 101, packages/core/src/guild-facts.ts).
export const QUEST_POINTS_REQUIRED: Readonly<Record<string, number>> = { dragon: 32, hero: 55, legends: 107 };

export type QuestEntry =
    | { readonly kind: 'run' }
    | { readonly kind: 'resume'; readonly resume: QuestResume }
    | { readonly kind: 'refuse'; readonly reason: string };

export type QuestResumeStart =
    | { readonly kind: 'resume'; readonly from: number; readonly spent: readonly number[]; readonly held: readonly number[] }
    | { readonly kind: 'refuse'; readonly reason: string };

// What the sweep does with the journal stage that it read: the script's FROM value and the items to leave out or fetch,
// or a named refusal.
export function resumeStart(resume: QuestResume, name: string, stage: number): QuestResumeStart {
    if (stage >= resume.complete) return { kind: 'refuse', reason: `refused: ${name} journal stage ${stage} is complete` };
    const from = resumeFrom(resume, stage);
    if (from === undefined) return { kind: 'refuse', reason: `refused: ${name} journal stage ${stage} has no resume from the start tile` };
    return { kind: 'resume', from, spent: resume.spent?.(stage) ?? [], held: resume.held?.(stage) ?? [] };
}

// The refusal text starts with "refused:": the supervisor ends the job on it and does not log in again
// (packages/practice/src/supervise.ts isNamedRefusal). An unknown quest point total does not refuse.
export function questEntry(slug: string, name: string, state: QuestJournalState, questPoints?: number): QuestEntry {
    const qpNeed = QUEST_POINTS_REQUIRED[slug];
    if (qpNeed !== undefined && state === 'not started' && questPoints !== undefined && questPoints < qpNeed) {
        return { kind: 'refuse', reason: `refused: ${name} needs ${qpNeed} quest points, the account has ${questPoints}` };
    }
    if (SELF_RESUME.has(slug) || state === 'not started' || state === 'unknown') return { kind: 'run' };
    if (state === 'complete') return { kind: 'refuse', reason: `refused: ${name} is complete` };
    const resume = QUEST_RESUME[slug];
    if (resume) return { kind: 'resume', resume };
    return { kind: 'refuse', reason: `refused: ${name} journal is started and quest-${slug}.ts has no resume stage` };
}
