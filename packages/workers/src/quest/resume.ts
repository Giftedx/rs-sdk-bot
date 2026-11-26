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

const SQUIRE_PIE = 2325;

export const QUEST_RESUME: Readonly<Record<string, QuestResume>> = {
    // Thurgo eats the redberry pie at stage 2 -> 3 (quest_squire.rs2:125-151).
    squire: { key: 'squire', title: /Knight's Sword/i, stage: squireJournalStage, complete: 7, spent: (stage) => (stage >= 3 ? [SQUIRE_PIE] : []) },
    // The pack has no item that the quest takes: the barman's 5 coins come from the staged 20.
    arena: { key: 'arena', title: /Fight Arena/i, stage: arenaJournalStage, complete: 14, from: arenaFrom },
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
