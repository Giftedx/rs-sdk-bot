// The harm check of a goTo route (danger/exposure.ts): price the planned route against the hunters along it, take a
// safe route inside its bound, and take food from a bank before a walk that the pack food cannot cover.
import type { Outcome } from '../act';
import { accountForSdk } from '../door-policy';
import { waitTicks } from '../ticks';
import type { BankStock, TripPlan } from '../trip';
import type { WalkOptions, Walker } from '../walk-leg';
import type { Account, Tile, World } from '../world';

// `eatAbove`: the Hitpoints line to eat above from the pack before the first step (0: none; exposure.ts walkVerdict).
// A refusal with needHeal 0 cannot be fixed with food (the maximum Hitpoints are at or under the floor line).
export type RouteHarm =
    | { action: 'clear'; plan: TripPlan }
    | { action: 'eat'; plan: TripPlan; eatAbove: number }
    | { action: 'detour'; plan: TripPlan }
    | { action: 'refuse'; plan: TripPlan; zone: string; damage: number; needHeal: number };

// The head of a harm refusal: brain/src/no-route.ts parseNoRoute reads its start and target, and the planner turns
// it into a route-danger fact (food staged first, or another job).
export const routeDangerText = (from: Tile, to: Tile) => `walk danger from ${from.x},${from.z},${from.level}: route danger to ${to.x},${to.z},${to.level}`;

// Eats pack food until the Hitpoints are above `line`: one piece, then the eat delay (3 ticks), at most 28 pieces.
// False when the Hitpoints do not get there (no food left, or the eats do not land).
export async function eatBeforeWalk(s: Walker, line: number, stop: () => boolean = () => false): Promise<boolean> {
    const bot = s.bot as Walker['bot'] & { eatFood?(target?: unknown): Promise<{ success?: boolean } | unknown> };
    const hp = () => s.sdk.getState()?.player?.hp ?? 0;
    for (let i = 0; i < 28 && hp() <= line && !stop(); i++) {
        if (typeof bot.eatFood !== 'function') return false;
        const r = await bot.eatFood() as { success?: boolean } | undefined;
        if (r && r.success === false) return hp() > line;
        await waitTicks(s, 3);
    }
    return hp() > line;
}

const legsOf = (t: TripPlan) => [...t.legs, ...(t.bank?.then ?? [])];

// `replan` plans the trip for an account (goTo's plan: off thread, with the bank stock). The safe route is the plan for
// the account with avoidHarm set (danger/guard.ts guardRoute closes the harm ground).
export async function routeHarm(s: Walker, from: Tile, to: Tile, acct: Account, r: TripPlan, replan: (a: Account) => Promise<TripPlan | null>): Promise<RouteHarm> {
    const { dangerSummary, huntersNear, npcReach, planAroundHarm, routeDanger, routeExposure, stateWalkProfile } = await import('../danger');
    const p = stateWalkProfile(acct, s.sdk.getState()?.player);
    // No hunter of this account near any walk leg: nothing to price, and no path search.
    let at = from, near = false;
    for (const leg of legsOf(r)) {
        if (leg.kind === 'walk' && leg.to.level === at.level && huntersNear(p.combat, at.level, { minX: Math.min(at.x, leg.to.x) - 32, maxX: Math.max(at.x, leg.to.x) + 32, minZ: Math.min(at.z, leg.to.z) - 32, maxZ: Math.max(at.z, leg.to.z) + 32 })) { near = true; break; }
        at = leg.to;
    }
    if (!near) return { action: 'clear', plan: r };
    const { offThreadRouteWanted } = await import('../route-query');
    let localEnv: { pf: any; grid: any; reach: ReturnType<typeof npcReach> } | null = null;
    const measureExposure = async (legs: ReturnType<typeof legsOf>) => {
        if (offThreadRouteWanted()) {
            const { queryRouteOffThread } = await import('../route-plan');
            return queryRouteOffThread<import('../danger').WalkExposure>({ kind: 'route-exposure', from, legs, profile: p });
        }
        if (!localEnv) {
            const [pf, grid] = await Promise.all([
                import('../../../../vendor/rs-sdk/sdk/pathfinding') as Promise<any>,
                import('../../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder'),
            ]);
            pf.initPathfinding();
            localEnv = { pf, grid, reach: npcReach(grid as any, pf.getDoorAt) };
        }
        // Price the detoured walk path that walkRoute actually takes (session.ts planAroundHarm), not the bare straight
        // line through a hunter that a 32-tile detour avoids cleanly.
        const path = (level: number, a: { x: number; z: number }, b: { x: number; z: number }) =>
            planAroundHarm(localEnv!.grid, p, level, a, b, 32, () => localEnv!.pf.findLongPath(level, a.x, a.z, b.x, b.z, 500), { reach: localEnv!.reach });
        return routeExposure(p, from, legs, path, { reach: localEnv.reach });
    };
    const open = { cost: r.cost, exposure: await measureExposure(legsOf(r)) };
    let d = routeDanger(p, open);
    if (d.action === 'clear') return { action: 'clear', plan: r };
    const safePlan = await replan({ ...acct, avoidHarm: true });
    const safe = safePlan ? { cost: safePlan.cost, exposure: await measureExposure(legsOf(safePlan)) } : null;
    d = routeDanger(p, open, safe);
    const summary = dangerSummary(d.exposure, d.verdict);
    console.log(`WALK_DANGER ${JSON.stringify({ action: d.action, from, to, cost: r.cost, safeCost: safePlan?.cost ?? null, safeDamage: safe ? Math.round(safe.exposure.damage * 10) / 10 : null, hp: p.hp, foodHeal: p.foodHeal, runTiles: p.runTiles, ...summary })}`);
    if (d.action === 'detour') return { action: 'detour', plan: safePlan! };
    if (d.action === 'refuse') return { action: 'refuse', plan: r, zone: summary.zone, damage: summary.damage, needHeal: summary.needHeal };
    if (d.action === 'eat') return { action: 'eat', plan: r, eatAbove: d.verdict.eatFirst > 0 ? summary.floorLine : 0 };
    return { action: 'clear', plan: r };
}

// Food to take from the bank stock for `needHeal` Hitpoints: the highest heal first, within the free pack slots and
// 20 pieces (combat-admission.ts DEFAULT_CARRY_MAX). Null when the stock cannot cover it.
export function foodToTake(stock: BankStock, needHeal: number, freeSlots: number, healOf: (name: string) => number | undefined, carryMax = 20): Record<string, number> | null {
    const rows = Object.entries(stock.items ?? {}).flatMap(([name, n]) => { const heal = healOf(name); return heal && n > 0 ? [{ name, n, heal }] : []; }).sort((a, b) => b.heal - a.heal);
    const want: Record<string, number> = {};
    let left = needHeal, room = Math.min(freeSlots, carryMax);
    for (const row of rows) {
        if (left <= 0 || room <= 0) break;
        const take = Math.min(row.n, room, Math.ceil(left / row.heal));
        want[row.name] = take; left -= take * row.heal; room -= take;
    }
    return left <= 0 ? want : null;
}

// Takes food at the nearest bank that a walk reaches, then walks to `to`. `go` is goTo (walk/goto.ts); both walks run
// with noFoodStage, so a walk to the bank that is itself refused ends the stage.
export async function stageFood(s: Walker, world: World, to: Tile, acct: Account, stock: BankStock, needHeal: number, opts: WalkOptions, go: (s: Walker, world: World, to: Tile, acct: Account, opts: WalkOptions) => Promise<Outcome>): Promise<Outcome | null> {
    const [{ foodHealOf }, { knownBanks, takeItems }] = await Promise.all([import('../danger'), import('../trip')]);
    const inv = s.sdk.getState()?.inventory, p = s.sdk.getState()?.player;
    if (!Array.isArray(inv) || !p) return null;
    const want = foodToTake(stock, needHeal, 28 - inv.filter((i: { count?: number }) => (i.count ?? 0) > 0).length, foodHealOf);
    if (!want) { console.log(`WALK_DANGER ${JSON.stringify({ action: 'stage-short', needHeal, bankFood: Object.keys(stock.items ?? {}).filter(n => foodHealOf(n)).length })}`); return null; }
    const here = { x: p.worldX, z: p.worldZ, level: p.level };
    const banks = knownBanks().filter(b => b.level === here.level).sort((a, b) => Math.max(Math.abs(a.x - here.x), Math.abs(a.z - here.z)) - Math.max(Math.abs(b.x - here.x), Math.abs(b.z - here.z))).slice(0, 3);
    const inner = { ...opts, noFoodStage: true };
    for (const bank of banks) {
        console.log(`WALK_DANGER ${JSON.stringify({ action: 'stage', bank, food: want, needHeal })}`);
        const there = await go(s, world, bank, acct, inner);
        if (!there.ok) { if (there.reason === 'aborted') return there; continue; }
        const banker = s as unknown as Parameters<typeof takeItems>[0];
        const took = await takeItems(banker, 0, want, n => waitTicks(s, n), { stop: () => opts.signal?.aborted === true, deadline: performance.now() + 30_000 });
        if (!took.ok) return { ok: false, reason: 'precondition', detail: `walk danger: food stage at ${bank.x},${bank.z}: ${took.detail}`, ticks: 0 };
        return go(s, world, to, accountForSdk(s.sdk), inner);
    }
    return null;
}
