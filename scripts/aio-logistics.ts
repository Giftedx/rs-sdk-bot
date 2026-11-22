// Unified AIO logistics entrypoint, compatibility shim, and runtime hook registration.
// Usage:
//   bun scripts/aio-logistics.ts <account> <role> [arg ...] [KEY=value ...]
//   bun scripts/aio-logistics.ts loadout-import <donor-setup.json> <native-bindings.json>
//   bun scripts/aio-logistics.ts --list
import './elemental-exit';
import './transfer-admission';
import {
    LOGISTICS_ROLES,
    findLogisticsRole,
    importAioLoadout,
    planFleetDistribution,
    registerBootstrapRuntime,
    registerSpecialistSupplyRuntime,
    resolveLogisticsStep,
    runLogisticsRole,
    type LogisticsRoleSpec,
} from '../packages/workers/src/logistics';
import { restockAtBank } from './fast-skills-lib';
import { FIREMAKING_SPECIALIST_SUPPLIES, serveFiremakingSupplier } from './firemaking-specialist';
import { startHelperTradeArm } from './gathering-specialist-lib';
import { trainChickens } from '../packages/workers/src/combat/chickens';

export * from '../packages/workers/src/logistics';

registerBootstrapRuntime({ trainChickens });
registerSpecialistSupplyRuntime({
    restockAtBank,
    serveFiremakingSupplier,
    startHelperTradeArm,
    firemakingSupplies: FIREMAKING_SPECIALIST_SUPPLIES,
});

export async function runAioLogistics(
    account: string,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<string> {
    if (!account) throw Error('aio-logistics requires account');
    const [role, ...rest] = args;
    if (!role) throw Error('aio-logistics requires <role>');
    const res = await runLogisticsRole(account, role, rest, env);
    return res.resultLine;
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    if (argv.includes('--list')) {
        console.log(JSON.stringify(LOGISTICS_ROLES, null, 2));
        process.exit(0);
    }
    if (argv[0] === 'loadout-import') {
        console.log(JSON.stringify(importAioLoadout(argv.slice(1)), null, 2));
        process.exit(0);
    }
    if (argv[0] === 'specialist-supplier' && argv.includes('--stage')) {
        const res = await runLogisticsRole('--stage', 'specialist-supplier', argv.slice(1).filter(a => a !== '--stage'), process.env);
        if (!res.ok) process.exitCode = 1;
        process.exit(res.ok ? 0 : 1);
    }
    if (argv[0] === 'gathering-supplier' && argv.includes('--stage')) {
        const res = await runLogisticsRole('--stage', 'gathering-supplier', argv.slice(1).filter(a => a !== '--stage'), process.env);
        if (!res.ok) process.exitCode = 1;
        process.exit(res.ok ? 0 : 1);
    }
    const [first, second, ...tail] = argv;
    if (!first || (!second && !findLogisticsRole(first))) {
        console.log('RESULT fail usage: bun scripts/aio-logistics.ts <account> <role> [args...] [KEY=value...]');
        process.exit(1);
    }
    const known = (v: string | undefined) => !!v && !!findLogisticsRole(v);
    const [account, role, rest] = known(first) && !known(second)
        ? [second ?? '', first, tail]
        : [first, second!, tail];
    const res = await runLogisticsRole(account, role, rest, process.env);
    if (!res.ok) process.exitCode = 1;
    if (!(globalThis as { __rsBotHost?: unknown }).__rsBotHost) {
        process.exit(res.ok ? 0 : 1);
    }
}

export type { LogisticsRoleSpec };
export { LOGISTICS_ROLES, importAioLoadout, planFleetDistribution, resolveLogisticsStep };
