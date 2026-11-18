// Work that a run must finish before its accounts log out and its process ends (for example, a kill receipt that waits for the
// world feed, and the feed socket that keeps a process alive). packages/core/src/bot.ts settleOnce awaits each task, so every
// main that ends through finish() or settle() runs them, also a main that ends with process.exit.
export const shutdownTasks = new Set<() => Promise<unknown>>();
export async function runShutdownTasks(): Promise<void> {
    await Promise.all([...shutdownTasks].map(task => task().catch(error => console.error('[shutdown] task failed', String(error)))));
}
