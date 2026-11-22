// Pure planning pass entry point orchestrating candidate collection, kit/goal/squad/gear/supply allocation, and vacancy reporting.
import type { Assignment, Inputs } from '../world';
import { createPlanState } from './context';
import { collectCandidates } from './candidates';
import { assignGearPass, assignGoalsAndKits, restockSquad, takeCandidate } from './acquire';
import { assignBridgeHelpers, assignSupplyTier, enforceBotSlots, formatAssignments } from './supply';

export function plan(input: Inputs): Assignment[] {
    const s = createPlanState(input);
    const ready = collectCandidates(s);
    assignGoalsAndKits(s, ready);
    restockSquad(s);
    // Then the filler bands, for an army account that no band and no kit took.
    for (const c of s.cands.filter(c => c.goal && !c.lacks && c.template.filler).sort(s.goalOrder)) takeCandidate(s, c, 0, ready);
    // The gear pass: an account that no band, kit or send took and that has a want above the gain floor (gear-want-jobs.ts)
    // buys it before any coin job, from its own coins only. A running training session is replaced only for a larger gain.
    assignGearPass(s);
    assignBridgeHelpers(s);
    assignSupplyTier(s, ready);
    enforceBotSlots(s);
    return formatAssignments(s);
}
