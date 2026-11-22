// AIO Quester ("Quest Helper & Clue Solver"): unified CLI dispatcher & shim over packages/workers/src/quest/.
// Usage:
//   bun scripts/aio-quester.ts <account> <mode|quest-slug> [arg ...] [KEY=value ...]
//   bun scripts/aio-quester.ts --list
import {
    dispatchQuesterCli,
    listGeneratedQuestScripts,
    QUESTER_MODES,
} from '../packages/workers/src/quest';

export * from '../packages/workers/src/quest';

if (import.meta.main) {
    const [account, ...rest] = process.argv.slice(2);
    if (account === '--list') {
        console.log(JSON.stringify({ modes: QUESTER_MODES, quests: listGeneratedQuestScripts() }, null, 2));
        process.exit(0);
    }
    if (!account || !rest.length) {
        console.log('RESULT fail usage: bun scripts/aio-quester.ts <account> <sweep|order|chain|items|cook-job|clue|clue-puzzle|clue-guardian|quest-slug> [args...]');
        process.exit(2);
    }
    const code = await dispatchQuesterCli(account, rest);
    process.exit(code);
}
