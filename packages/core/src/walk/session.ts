// Session-bound PathDeps adapter and door-policy masking for in-process bot walks.
import { blockedDoorsNear, installDoorPolicy, type Account, type Door, type DoorBlock } from '../world';
import { accountForSdk, withDoorPolicy } from '../door-policy';
import { guardWalk, liveHunters, protectedFromMelee, withDanger } from '../danger';
import { clientReach } from '../reach';
import type { PathDeps, PathTile } from './path';

export function applyKnownDoorBlocks(sdk: any, level: number, from: PathTile, to: PathTile, doors?: readonly Door[]): DoorBlock[] {
    const account = accountForSdk(sdk);
    return blockedDoorsNear({ ...from, level }, { ...to, level }, account, doors);
}

// PathDeps for an in-process session (packages/core/src/inprocess.ts). Inputs go straight to the client, not
// through the SDK action queue, so a click leaves on the tick it is decided.
export async function sessionWalker(s: {
    sdk: any;
    client?: unknown;
    onTick(cb: () => void): () => void;
    direct(a: { type: string; [k: string]: unknown }): Promise<unknown>;
    ended?: Promise<unknown>;
}): Promise<PathDeps> {
    const pf: any = await import('../../../../vendor/rs-sdk/sdk/pathfinding');
    const grid = await import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    await installDoorPolicy(s.sdk, s.client);
    const pos = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    const reach = clientReach(s.client, pos);
    // Skills do not change during one walk: the account is read once, on the first live-hunter check.
    let hunterActor: Account | undefined;
    return {
        tick: () => s.sdk.getState()?.tick,
        pos,
        ...(reach ? { reach } : {}),
        onTick: cb => s.onTick(cb),
        ended: s.ended,
        walk: (x, z) => s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' }),
        interactLoc: (l, op) => s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' }),
        runOn: () => s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' }),
        locs: () => s.sdk.getState()?.nearbyLocs ?? [],
        messages: () => s.sdk.getState()?.gameMessages ?? [],
        blockDoor: (level, loc) => s.sdk.blockDoorTemporarily?.(level, loc.x, loc.z) === true,
        doorBlocked: (level, loc) => s.sdk.isDoorTemporarilyBlocked?.(level, loc.x, loc.z) === true,
        // The session's temporary door blocks (doors walkTo found locked) stay walls for this plan too.
        plan: (level, from, to, avoid) => {
            pf.initPathfinding();
            const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
            const find = () => withDoorPolicy(grid, blocks, () => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, s.sdk.temporaryDoorBlocks?.active?.() ?? []));
            // Deadly hunters' ground stays closed too (danger.ts), and the live hunters' squares walkPath passes.
            return guardWalk(grid, accountForSdk(s.sdk), { ...from, level }, { ...to, level }, 32, () => avoid?.length ? withDanger(grid, avoid.map(t => ({ ...t, level })), [{ ...from, level }, { ...to, level }], find, 'live') : find());
        },
        // Protect from Melee is read from the live state at each call: only then a melee-only hunter has no square.
        hunters: () => { const st = s.sdk.getState(); return st?.player ? liveHunters(st.nearbyNpcs ?? [], hunterActor ??= accountForSdk(s.sdk), 2, undefined, undefined, protectedFromMelee(st)) : []; },
    };
}
