// Player fight loop foundation (implementation in packages/workers/src/pvp/fight.ts).
export * from '../packages/workers/src/pvp/fight';

if (import.meta.main) {
    const { runPkFightCli } = await import('../packages/workers/src/pvp/fight');
    process.exitCode = await runPkFightCli(process.argv.slice(2));
}
