// Walk one account to a tile with the shared walker (packages/core/src/walk.ts goTo): the route search, travel,
// danger avoidance and bank stops it plans for this account. Prints WALK_PLAN when the plan starts walking and
// RESULT with the ticks used and the final tile, then logs out.
// Usage: bun scripts/walk-to.ts <account> <x> <z> [level] [--ground]
// --ground uses the local walker for an inspected same-plane corridor, without transport or bank planning.
import { openBot, finish, getWorld, accountOf } from '../packages/core/src/bot';
import { goTo, walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import type { Tile } from '../packages/core/src/world';

export function parseTarget(args: string[]): { account: string; to: { x: number; z: number; level: number } } {
    const [account, x, z, level] = args;
    const to = { x: Number(x), z: Number(z), level: Number(level ?? 0) };
    if (!account || ![to.x, to.z, to.level].every(Number.isInteger)) throw Error('usage: walk-to.ts <account> <x> <z> [level]');
    return { account, to };
}

type WalkOperations = { planned(s: Session, to: Tile): Promise<{ ok: boolean }>; ground(s: Session, to: Tile): Promise<{ ok: boolean }> };
export async function walkTarget(s: Session, to: Tile, ground: boolean, operations: WalkOperations = {
    planned: async (s, to) => goTo(s, await getWorld(), to, accountOf(s), { legTimeoutTicks: 100 }),
    ground: async (s, to) => walkPath(await sessionWalker(s), [{ ...to, tol: 1 }], { maxTicks: 600 }),
}) {
    if (ground && s.sdk.getState()?.player?.level !== to.level) throw Error('ground walk requires a known start on the same plane');
    return ground ? operations.ground(s, to) : operations.planned(s, to);
}

if (import.meta.main) {
    const args = process.argv.slice(2), { account, to } = parseTarget(args);
    const ground = args[4] === '--ground';
    if (args.length > 5 || args[4] && !ground) throw Error('unknown walk option');
    const s = await openBot(account);
    const here = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'; };
    const t0 = s.tick();
    console.log(`WALK_START from=${here()} to=${to.x},${to.z},${to.level} mode=${ground ? 'ground' : 'planned'}`);
    try {
        const r = await walkTarget(s, to, ground);
        await finish([s], r.ok, `walk-to ${JSON.stringify(r)} at=${here()} ticks=${s.tick() - t0}`);
    } catch (error) { await finish([s], false, String(error)); }
}
