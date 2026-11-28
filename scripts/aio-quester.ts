// AIO Quester ("Quest Helper & Clue Solver"): unified CLI dispatcher & shim over packages/workers/src/quest/.
// Usage:
//   bun scripts/aio-quester.ts <account> <mode|quest-slug> [arg ...] [KEY=value ...]
//   bun scripts/aio-quester.ts --list
import { createRequire } from 'node:module';
import {
    QUESTER_MODES,
    QUEST_PREREQUISITES,
    QUEST_SCRIPT_ALIAS,
    assessQuestReadiness,
    dispatchQuesterCli,
    listGeneratedQuestScripts,
    prioritizeQuestsForAccount,
    resolveQuestScript,
    resolveQuesterStep,
    runAioQuester,
    type QuesterModeSpec,
} from '../packages/workers/src/quest/modes';

const require = createRequire(import.meta.url);
type QuestOrderMod = typeof import('../packages/workers/src/quest/order');
type QuestChainMod = typeof import('../packages/workers/src/quest/chain');
let orderMod: QuestOrderMod | undefined;
let chainMod: QuestChainMod | undefined;
const getOrderMod = () => (orderMod ??= require('../packages/workers/src/quest/order') as QuestOrderMod);
const getChainMod = () => (chainMod ??= require('../packages/workers/src/quest/chain') as QuestChainMod);
export const QUEST_ORDERS: QuestOrderMod['QUEST_ORDERS'] = new Proxy({} as QuestOrderMod['QUEST_ORDERS'], {
    get: (_t, p) => Reflect.get(getOrderMod().QUEST_ORDERS, p),
    has: (_t, p) => Reflect.has(getOrderMod().QUEST_ORDERS, p),
    ownKeys: () => Reflect.ownKeys(getOrderMod().QUEST_ORDERS),
    getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(getOrderMod().QUEST_ORDERS, p),
});
export const QUEST_NAMES: QuestChainMod['QUEST_NAMES'] = new Proxy({} as QuestChainMod['QUEST_NAMES'], {
    get: (_t, p) => Reflect.get(getChainMod().QUEST_NAMES, p),
    has: (_t, p) => Reflect.has(getChainMod().QUEST_NAMES, p),
    ownKeys: () => Reflect.ownKeys(getChainMod().QUEST_NAMES),
    getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(getChainMod().QUEST_NAMES, p),
});

export {
    QUESTER_MODES,
    QUEST_PREREQUISITES,
    QUEST_SCRIPT_ALIAS,
    assessQuestReadiness,
    dispatchQuesterCli,
    listGeneratedQuestScripts,
    prioritizeQuestsForAccount,
    resolveQuestScript,
    resolveQuesterStep,
    runAioQuester,
    type QuesterModeSpec,
};

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
