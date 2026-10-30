// Walk one account to a tile with the shared walker (packages/core/src/walk.ts goTo): the route search, travel,
// danger avoidance and bank stops it plans for this account. Prints WALK_PLAN when the plan starts walking and
// RESULT with the ticks used and the final tile, then logs out.
// Usage: bun scripts/walk-to.ts <account> <x> <z> [level]      e.g. bun scripts/walk-to.ts Pocketpython 3165 3487
import { openBot, finish, getWorld, accountOf } from '../packages/core/src/bot';
import { goTo } from '../packages/core/src/walk';

export function parseTarget(args: string[]): { account: string; to: { x: number; z: number; level: number } } {
    const [account, x, z, level] = args;
    const to = { x: Number(x), z: Number(z), level: Number(level ?? 0) };
    if (!account || ![to.x, to.z, to.level].every(Number.isInteger)) throw Error('usage: walk-to.ts <account> <x> <z> [level]');
    return { account, to };
}

if (import.meta.main) {
    const { account, to } = parseTarget(process.argv.slice(2));
    const s = await openBot(account);
    const here = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'; };
    const t0 = s.tick();
    console.log(`WALK_START from=${here()} to=${to.x},${to.z},${to.level}`);
    const r = await goTo(s, await getWorld(), to, accountOf(s), { legTimeoutTicks: 100 });
    const ticks = s.tick() - t0;
    await finish([s], r.ok, `walk-to ${JSON.stringify(r)} at=${here()} ticks=${ticks}`);
}
