// Gang squad controller foundation (implementation in packages/workers/src/pvp/squad.ts).
import '../packages/workers/src/pvp/pk-squad-stall-boot';
export * from '../packages/workers/src/pvp/squad';

if (import.meta.main) {
    const { runPkSquadCli } = await import('../packages/workers/src/pvp/squad');
    process.exitCode = await runPkSquadCli(process.argv.slice(2));
}
