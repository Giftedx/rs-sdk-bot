import { runFleetSyncCli } from '../packages/fleet/src/fleet-sync';
export * from '../packages/fleet/src/fleet-sync';

if (import.meta.main) {
    await runFleetSyncCli(process.argv.slice(2));
}
