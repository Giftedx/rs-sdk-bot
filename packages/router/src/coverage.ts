// Game coverage scoreboard: every skill band, quest and content domain of the pinned server, staged by our evidence.
// Quest stages: none -> named (a script file exists) -> practice (a run finished the quest) -> live (an owned account on
// any side has it complete). actionsFired counts actions a practice engine really ran (.practice/action-trace.log, written
// by the patched ScriptRunner.init). actionsNamed is a text match of content names against our source, not script coverage:
// actions without a display name rarely match, shared code handles others without naming them, and a word in a comment
// matches. Batch qualification is not tracked yet. Deterministic: no model calls. `bun packages/router/src/coverage.ts` writes .practice/coordinator/scoreboard.json.
import { runCoverageCli } from './coverage/scoreboard';

export {
    BANDS, QP_FALLBACK, SKILLS, VARP_FOLDER, better, questJournalNames, questScript,
} from './coverage/model';
export type { SideAccount, Stage, Status } from './coverage/model';

export {
    actionKey, corpus, domainStages, firedActions, named,
} from './coverage/actions';

export {
    SNAPSHOT_MAX_AGE_MS, fleetSkills, itemsHeld, ownedNames, practicePasses, questStages, sideSnapshots, skillBands,
} from './coverage/fleet';

export {
    buildScoreboard, freshScoreboard, improved, progressOf,
} from './coverage/scoreboard';
export type { Progress } from './coverage/scoreboard';

if (import.meta.main) runCoverageCli();
