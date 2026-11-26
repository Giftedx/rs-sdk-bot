// Bench worker for a quest sweep that refuses at entry by design (packages/workers/src/quest/resume.ts questEntry): a
// started journal with no resume stage, a complete quest, too few quest points. It runs scripts/aio-quester.ts sweep as
// a child and passes when the child's RESULT line is the named refusal, the line on which the supervisor ends the job
// (packages/practice/src/supervise.ts isNamedRefusal).
// Usage: bun scripts/measure/quest-refusal-probe.ts <bot> <quest> <text the refusal names>
import { runDirectChild } from '../../packages/core/src/run-child';
import { isNamedRefusal } from '../../packages/practice/src/supervise';
// The bench keeps a result under a hash of the worker and the files it imports (aio-practice-bench.ts importClosure).
// This import puts the quester and the quest sweep into that hash.
import type {} from '../aio-quester';

export const questRefusalMet = (quest: string, text: string, result: string) =>
    isNamedRefusal(result) && result.startsWith(`RESULT fail quest-sweep ${quest} refused: `) && result.includes(text);

if (import.meta.main) {
    const [bot, quest, ...words] = process.argv.slice(2);
    const text = words.join(' ');
    if (!bot || !quest || !text) {
        console.log('RESULT fail usage: bun scripts/measure/quest-refusal-probe.ts <bot> <quest> <text the refusal names>');
        process.exit(2);
    }
    const result = await runDirectChild(['scripts/aio-quester.ts', bot, 'sweep', quest]);
    const met = questRefusalMet(quest, text, result);
    console.log(`RESULT ${met ? 'ok' : 'fail'} quest-refusal quest=${quest} child=${JSON.stringify(result.slice(0, 300))}`);
    process.exit(met ? 0 : 1);
}
