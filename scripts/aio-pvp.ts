// AIO PvP ("PK Fighter"): unified Wilderness PvP, tribrid switching, hunting, roaming, kit staging, and escort suite.
// Usage:
//   bun scripts/aio-pvp.ts <account> <mode> [arg ...] [KEY=value ...]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type MiningMod = typeof import('../packages/workers/src/gather/mining');
let miningMod: MiningMod | undefined;
const getMining = () => (miningMod ??= require('../packages/workers/src/gather/mining') as MiningMod);

export * from '../packages/workers/src/pvp/modes';
export const escortInterceptDecision: MiningMod['escortInterceptDecision'] = (...a) => getMining().escortInterceptDecision(...a);
export const retreatOrTeleportPlan: MiningMod['retreatOrTeleportPlan'] = (...a) => getMining().retreatOrTeleportPlan(...a);
export const selectInboundRecovery: MiningMod['selectInboundRecovery'] = (...a) => getMining().selectInboundRecovery(...a);

if (import.meta.main) {
    const [account, mode, ...rest] = process.argv.slice(2);
    if (process.argv.includes('squad')) {
        await import('../packages/workers/src/pvp/pk-squad-stall-boot');
    }
    const { PVP_MODES, dispatchPvpCli } = await import('../packages/workers/src/pvp/modes');
    if (account === '--list') {
        console.log(JSON.stringify(PVP_MODES, null, 2));
        process.exit(0);
    }
    if (!account || !mode) {
        console.log('RESULT fail usage: bun scripts/aio-pvp.ts <account> <fight|spar|gang|hunt|roam|pilot|standby|stage-kit|escort-ore|microbot-pvp|special-swap|monitor> [args...]');
        process.exit(2);
    }
    process.exitCode = await dispatchPvpCli(account, mode, rest);
}
