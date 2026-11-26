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
};

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

const SQUIRE_PIE = 2325;

export const QUEST_RESUME: Readonly<Record<string, QuestResume>> = {
    // Thurgo eats the redberry pie at stage 2 -> 3 (quest_squire.rs2:125-151).
    squire: { key: 'squire', title: /Knight's Sword/i, stage: squireJournalStage, complete: 7, spent: (stage) => (stage >= 3 ? [SQUIRE_PIE] : []) },
};

// Quests whose script or sweep branch reads a started journal itself: the journal stage parsers of priestperil, zanaris,
// rj and totem, the journal-flag branches of cook, druidspirit, fluffs, hetty, hunt, priest, runemysteries, sheepherder
// and vampire, and the sweep's own Black Knight return to Amik (sweep-plan.ts returnToAmik).
export const SELF_RESUME: ReadonlySet<string> = new Set([
    'blackknight', 'cook', 'druidspirit', 'fluffs', 'hetty', 'hunt', 'priest', 'priestperil', 'rj', 'runemysteries',
    'sheepherder', 'totem', 'vampire', 'zanaris',
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
