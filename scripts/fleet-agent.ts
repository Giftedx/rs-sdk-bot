import { runFleetAgentCli } from '../packages/fleet/src/fleet-agent';
export * from '../packages/fleet/src/fleet-agent';

if (import.meta.main) {
    await runFleetAgentCli(process.argv.slice(2));
}
