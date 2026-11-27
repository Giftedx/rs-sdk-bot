// Session-bound PathDeps adapter and door-policy masking for in-process bot walks.
import { blockedDoorsNear, installDoorPolicy, type Account, type Door, type DoorBlock } from '../world';
import { accountForSdk, withDoorPolicy } from '../door-policy';
import { fareCrossingAt, fareCrossings, type FareCrossing } from '../travel';
import { topUpFareFloat } from './fare-float';
import type { PathDeps, PathTile } from './path';

// The door blocks of a plan. A paid crossing (travel.ts fareCrossings) stays open when the account holds its fare:
// walkPath pays it (PathDeps.fare). Kept shut, it sends every ground walk between Lumbridge and Al Kharid round the
// fence by Varrock, 307 path tiles against 111 through the toll gate.
export function applyKnownDoorBlocks(sdk: any, level: number, from: PathTile, to: PathTile, doors?: readonly Door[], fares: readonly FareCrossing[] = fareCrossings()): DoorBlock[] {
    const account = accountForSdk(sdk);
    const coins = account.coins ?? 0;
    return blockedDoorsNear({ ...from, level }, { ...to, level }, account, doors)
        .filter(b => { const f = fareCrossingAt(b.level, b, fares); return !f || f.coins > coins; });
}

// The coins in the pack, or null when the state has no inventory.
const packCoins = (sdk: any): number | null => {
    const inv = sdk.getState()?.inventory;
    return Array.isArray(inv) ? inv.filter((i: { id: number }) => i.id === 995).reduce((n: number, i: { count?: number }) => n + (i.count ?? 0), 0) : null;
};

// PathDeps for an in-process session (packages/core/src/inprocess.ts). Inputs go straight to the client, not
// through the SDK action queue, so a click leaves on the tick it is decided.
export async function sessionWalker(s: {
    sdk: any;
    client?: unknown;
    onTick(cb: () => void): () => void;
    direct(a: { type: string; [k: string]: unknown }): Promise<unknown>;
    ended?: Promise<unknown>;
    bot?: { eatFood?(target?: unknown): Promise<unknown> };
}, walkOpts: { noFareFloat?: boolean } = {}): Promise<PathDeps> {
    const [pf, grid, { dangerSummary, guardWalk, liveHunters, npcReach, planAroundHarm, protectedFromMelee, stateWalkProfile, walkExposure, walkVerdict, withDanger }, { clientReach }] = await Promise.all([
        import('../../../../vendor/rs-sdk/sdk/pathfinding') as Promise<any>,
        import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder'),
        import('../danger'),
        import('../reach'),
    ]);
    await installDoorPolicy(s.sdk, s.client);
    const pos = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    const reach = clientReach(s.client, pos);
    // Skills do not change during one walk: the account is read once, on the first live-hunter check.
    let hunterActor: Account | undefined;
    // Harm ground (danger/exposure.ts) is priced with the Hitpoints, food and run energy of each plan's moment.
    const harmReach = npcReach(grid as any, pf.getDoorAt);
    const profile = () => stateWalkProfile(accountForSdk(s.sdk), s.sdk.getState()?.player);
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
        fare: (level, loc) => fareCrossingAt(level, loc) ?? null,
        coins: () => packCoins(s.sdk),
        dialog: () => s.sdk.getDialog?.() ?? null,
        answer: index => s.direct({ type: 'clickDialogOption', optionIndex: index, reason: 'SDK' }),
        // A session with a bank (a name and bot.openBank) takes the fare float before a walk through an unpaid fare.
        ...(walkOpts.noFareFloat ? {} : { prepare: (goal: { x: number; z: number; level: number }) => topUpFareFloat(s as unknown as Parameters<typeof topUpFareFloat>[0], goal) }),
        blockDoor: (level, loc) => s.sdk.blockDoorTemporarily?.(level, loc.x, loc.z) === true,
        doorBlocked: (level, loc) => s.sdk.isDoorTemporarilyBlocked?.(level, loc.x, loc.z) === true,
        // The session's temporary door blocks (doors walkTo found locked) stay walls for this plan too.
        plan: (level, from, to, avoid) => {
            pf.initPathfinding();
            const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map(b => b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b);
            const find = () => withDoorPolicy(grid, blocks, () => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, s.sdk.temporaryDoorBlocks?.active?.() ?? []));
            // Deadly hunters' ground stays closed too (danger.ts), and the live hunters' squares walkPath passes. Harm
            // ground is the outer scope: the plan goes round it inside its bound (planAroundHarm).
            const guarded = () => guardWalk(grid, accountForSdk(s.sdk), { ...from, level }, { ...to, level }, 32, () => avoid?.length ? withDanger(grid, avoid.map(t => ({ ...t, level })), [{ ...from, level }, { ...to, level }], find, 'live') : find());
            return planAroundHarm(grid, profile(), level, from, to, 32, guarded, { reach: harmReach });
        },
        ...(typeof s.bot?.eatFood === 'function' ? { eat: () => s.bot!.eatFood!() } : {}),
        danger: (level, tiles) => {
            const p = profile(), exposure = walkExposure(p, level, tiles, { reach: harmReach }), verdict = walkVerdict(p, exposure);
            return { verdict: verdict.verdict, start: walkExposure(p, level, tiles.slice(0, 1), { reach: harmReach }).tiles > 0, summary: dangerSummary(exposure, verdict) };
        },
        // Protect from Melee is read from the live state at each call: only then a melee-only hunter has no square.
        hunters: () => { const st = s.sdk.getState(); return st?.player ? liveHunters(st.nearbyNpcs ?? [], hunterActor ??= accountForSdk(s.sdk), 2, undefined, undefined, protectedFromMelee(st)) : []; },
    };
}
