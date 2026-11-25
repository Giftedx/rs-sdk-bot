// Facade for bot session lifecycle, login, settlement, and safety guards from ./bot/*.
export {
    assertServerAllowed,
    botWork,
    countItems,
    deathStep,
    releaseLine,
    serverFromEnv,
    sessionDied,
    stopReasonOf,
    watchUnexpectedEnd,
    type BotRecord,
    type OpenBotOptions,
    type SettlementOptions,
} from './bot/rules';
export {
    attachTickStallWatch,
    awaitBotReady,
    closeWithin,
    deathRecoveryOf,
    finishHooks,
    logoutAdapter,
    logoutSession,
    openHooks,
    randomEventsOf,
    releasePrayerGuard,
} from './bot/monitors';
export { finish, settle } from './bot/settle';
export { accountOf, getWorld, openBot } from './bot/open';
