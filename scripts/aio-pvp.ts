// AIO PvP ("PK Fighter"): unified Wilderness PvP, tribrid switching, hunting, roaming, kit staging, and escort suite.
// Usage:
//   bun scripts/aio-pvp.ts <account> <mode> [arg ...] [KEY=value ...]
import {
    escortInterceptDecision,
    retreatOrTeleportPlan,
    selectInboundRecovery,
} from '../packages/workers/src/gather/mining';

export * from '../packages/workers/src/pvp/modes';
export {
    escortInterceptDecision,
    retreatOrTeleportPlan,
    selectInboundRecovery,
};

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
