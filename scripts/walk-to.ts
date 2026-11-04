// Walk one account to a tile with the shared walker (packages/core/src/walk.ts goTo): the route search, travel,
// danger avoidance and bank stops it plans for this account. Prints WALK_PLAN when the plan starts walking and
// RESULT with the ticks used and the final tile, then logs out.
// Usage: bun scripts/walk-to.ts <account> <x> <z> [level] [--ground|--boat=<travel-id>]
// --ground uses the local walker for an inspected same-plane corridor, without transport or bank planning.
import { openBot, finish, getWorld, accountOf } from '../packages/core/src/bot';
import { goTo, walkPath, sessionWalker, walkRoute } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import type { Tile, Account } from '../packages/core/src/world';
import { loadTravel, travelAllowed, type Travel } from '../packages/core/src/travel';

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

// Explicit boats use the same eligibility and executor as a planned trip. They never search for a route.
export function stagedBoat(boat: Travel | undefined, from: Tile, to: Tile, account: Account) {
    if (!boat?.from || boat.kind !== 'boat' || boat.run.how !== 'npc') throw Error('known NPC boat required');
    if (from.level !== boat.from.level || Math.max(Math.abs(from.x - boat.from.x), Math.abs(from.z - boat.from.z)) > 8) throw Error('boat departure not reached');
    if (to.x !== boat.to.x || to.z !== boat.to.z || to.level !== boat.to.level) throw Error('boat arrival differs from target');
    if (!travelAllowed(boat, account)) throw Error('boat unavailable for this account');
    return { kind: 'travel' as const, travel: boat, at: boat.from, to: boat.to };
}

if (import.meta.main) {
    const args = process.argv.slice(2), { account, to } = parseTarget(args);
    const ground = args[4] === '--ground';
    const boatId = args[4]?.startsWith('--boat=') ? args[4].slice(7) : undefined;
    if (args.length > 5 || args[4] && !ground && !boatId) throw Error('unknown walk option');
    const boat = boatId ? loadTravel().find(t => t.id === boatId) : undefined;
    if (boatId && !boat) throw Error('unknown boat');
    const s = await openBot(account);
    const here = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'; };
    const t0 = s.tick();
    console.log(`WALK_START from=${here()} to=${to.x},${to.z},${to.level} mode=${ground ? 'ground' : boat ? 'boat' : 'planned'}`);
    try {
        const p = s.sdk.getState()!.player!;
        const r = boat ? await walkRoute(s, [stagedBoat(boat, { x: p.worldX, z: p.worldZ, level: p.level }, to, accountOf(s))], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 })
            : await walkTarget(s, to, ground);
        await finish([s], r.ok, `walk-to ${JSON.stringify(r)} at=${here()} ticks=${s.tick() - t0}`);
    } catch (error) { await finish([s], false, String(error)); }
}
