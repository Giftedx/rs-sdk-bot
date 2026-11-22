import { runSwarmCli } from '../packages/fleet/src/swarm';
export * from '../packages/fleet/src/swarm';

if (import.meta.main) {
    await runSwarmCli(process.argv.slice(2));
}
