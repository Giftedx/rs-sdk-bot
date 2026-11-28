// High-level goTo orchestration: guild preflight, ship-deck exit, trip planning, spell-fallback replan, and bank stops.
import type { Outcome } from '../act';
import { accountForSdk } from '../door-policy';
import { waitTicks } from '../ticks';
import type { TripPlan } from '../trip';
import { topUpFareFloat, unpaidFaresNear } from './fare-float';
import type { WalkOptions, Walker } from '../walk-leg';
import { installDoorPolicy, ROUTE_BUDGET_MS, type Account, type Tile, type World } from '../world';
import { eatBeforeWalk, routeDangerText, routeHarm, stageFood } from './harm';
import { walkRoute } from './legs';
import { leaveMineJail } from './mine-jail';
import { leaveDeck } from './travel';

// The account with no law rune: no teleport spell is castable, so a route planned for it keeps to the ground.
export const withoutSpells = (a: Account): Account => ({ ...a, items: a.items.filter(i => i !== 'lawrune'), counts: { ...a.counts, lawrune: 0 } });
export const TELEPORT_JEWELRY_RE = /^(?:amulet_of_glory|ring_of_dueling|games_necklace)_[1-8]$/;
export const withoutJewelry = (a: Account): Account => {
    const items = a.items.filter(i => !TELEPORT_JEWELRY_RE.test(i));
    const counts: Record<string, number> = { ...a.counts };
    for (const k of Object.keys(counts)) if (TELEPORT_JEWELRY_RE.test(k)) counts[k] = 0;
    return { ...a, items, counts };
};
export const withoutTeleports = (a: Account): Account => withoutJewelry(withoutSpells(a));

// A route that goes round an unpaid fare in its box (fare-float.ts unpaidFaresNear) is worth a second search with the
// fare: when that is much cheaper, the walk logs WALK_DETOUR with both costs, and tools/tick-waste.ts counts the
// lost ticks.
export const DETOUR_MARGIN = 40;
// A route plan this slow is logged as WALK_PLAN_SLOW.
export const SLOW_PLAN_MS = 2000;
export function fareDetour(plan: { cost: number }, paid: { cost: number } | null): boolean {
    return !!paid && paid.cost + DETOUR_MARGIN < plan.cost;
}

async function preflightGuildEvidence(
    s: Walker,
    to: Tile,
    acct: Account,
): Promise<{ acct: Account; legendsEntry: 'crossed' | 'refused' | 'unknown' | undefined }> {
    let legendsEntry: 'crossed' | 'refused' | 'unknown' | undefined;
    await installDoorPolicy(s.sdk, s.client);
    if (s.client) {
        const before = s.sdk.getState()?.player;
        const requests: string[] = [];
        const legendsTarget = to.x >= 2725 && to.x <= 2748 && to.z >= 3350 && to.z <= 3385;
        if (before && Math.abs(before.worldX - 2570) <= 8 && Math.abs(before.worldZ - 3441) <= 8 && to.level > before.level && Math.abs(to.x - 2570) <= 8 && Math.abs(to.z - 3441) <= 8) requests.push('dwarf-tower');
        if (before && before.level === 0 && before.worldX >= 3041 && before.worldX <= 3062 && Math.abs(before.worldZ - 3483) <= 5 && to.level === 1 && to.x >= 3040 && to.x <= 3063 && to.z >= 3465 && to.z <= 3488) requests.push('prayer-guild');
        if (before && legendsTarget && Math.abs(before.worldX - 2728) <= 30 && Math.abs(before.worldZ - 3373) <= 30) requests.push('legendsquest');
        if (before && legendsTarget && before.level === 0 && before.worldX >= 2725 && before.worldX <= 2732 && before.worldZ >= 3344 && before.worldZ <= 3349) requests.push('legends-entry');
        if (requests.length) {
            const { refreshGuildEvidence } = await import('../guild-observation');
            const fresh = await refreshGuildEvidence(s as any, requests as any);
            if (requests.includes('legends-entry')) legendsEntry = fresh.admission?.legendsEntry ?? 'unknown';
        }
        acct = accountForSdk(s.sdk);
    }
    return { acct, legendsEntry };
}

function walkerServer(s: Walker): string | undefined {
    const w = s as { lifecycle?: { server?: string }; sdk?: { config?: { browserLaunchUrl?: string } } };
    if (typeof w.lifecycle?.server === 'string' && w.lifecycle.server) return w.lifecycle.server;
    const url = w.sdk?.config?.browserLaunchUrl;
    if (typeof url === 'string') {
        try { return new URL(url).host || undefined; } catch { /* ignore malformed URL */ }
    }
    return undefined;
}

export async function goTo(s: Walker, world: World, to: Tile, acct: Account, opts: WalkOptions = {}): Promise<Outcome> {
    const started = s.tick();
    const preflight = await preflightGuildEvidence(s, to, acct);
    acct = preflight.acct;
    const legendsEntry = preflight.legendsEntry;
    // A ferry lands on its ship's deck, level 1, and the walk crosses the gangplank next (travelLeg). A session cut
    // between the two starts its next walk on the deck, and no route leaves a deck (live: an account stood on the
    // Brimhaven deck at 2775,3234,1 until it was moved by hand; practice: "no route" at tick 0 from that tile). So a
    // walk that starts on level 1 beside a gangplank crosses it first.
    if (await leaveDeck(s, () => opts.signal?.aborted === true) === 'stuck') return { ok: false, reason: 'precondition', detail: 'on a ship deck and the gangplank did not take the account off', ticks: s.tick() - started };
    // The desert mining camp guards jail a caught player in a cell that no route leaves (live: Woodpecker and
    // BowBeforeMe at 3287,3032, "no route" to every target). The cell window and the cliff rocks take it out first.
    if (await leaveMineJail(s, to, () => opts.signal?.aborted === true) === 'stuck') return { ok: false, reason: 'precondition', detail: 'in the desert mining camp jail and the window and rocks did not take the account out', ticks: s.tick() - started };
    // The prayer probe may itself climb. Capture start and actor after it returns.
    const p = s.sdk.getState()?.player;
    if (!p) return { ok: false, reason: 'precondition', detail: 'no player state', ticks: 0 };
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    // A guarded first entry has already asked the server. A refusal cannot
    // become a global portal search, and missing publication is still unknown.
    const observedInside = from.level === 0 && from.x >= 2728 && from.x <= 2729 && from.z >= 3350 && from.z <= 3351;
    if (!observedInside && legendsEntry === 'refused') return { ok: false, reason: 'precondition', detail: 'Legends Guild guard refused first entry', ticks: s.tick() - started };
    if (!observedInside && legendsEntry === 'unknown' && (acct.questStages?.legendsquest ?? 0) < 1) return { ok: false, reason: 'precondition', detail: 'Legends Guild first entry was not observed', ticks: s.tick() - started };
    // A session with a bank snapshot may stop at a bank for fares first (trip.ts).
    const name = (s as { name?: string }).name, banker = s as unknown as Parameters<typeof import('../trip').takeItems>[0];
    if (opts.noJewelry) acct = withoutJewelry(acct);
    const hasBank = Boolean(name && typeof (banker.bot as { openBank?: unknown }).openBank === 'function');
    const [{ bankStock, planTrip, takeItems }, routePlanMod] = await Promise.all([
        import('../trip'),
        world.offThread ? import('../route-plan') : Promise.resolve(null),
    ]);
    let rawStock = hasBank ? bankStock(name!, { server: walkerServer(s) }) : undefined;
    // A walk from beside a bank through an unpaid fare takes the fare float there first (fare-float.ts).
    if (hasBank && !opts.noFareFloat && await topUpFareFloat(s as Parameters<typeof topUpFareFloat>[0], to, { stop: () => opts.signal?.aborted === true, ...(rawStock ? { stock: rawStock } : {}), ...(walkerServer(s) ? { server: walkerServer(s)! } : {}) })) {
        const coins = accountForSdk(s.sdk).coins ?? 0;
        acct = { ...acct, coins, counts: { ...acct.counts, coins }, items: acct.items.includes('coins') ? acct.items : [...acct.items, 'coins'] };
        rawStock = bankStock(name!, { server: walkerServer(s) });
    }
    const stock = opts.noJewelry && rawStock ? { coins: rawStock.coins, items: Object.fromEntries(Object.entries(rawStock.items ?? {}).filter(([k]) => !TELEPORT_JEWELRY_RE.test(k))) } : rawStock;
    const budgetMs = opts.planBudgetMs ?? ROUTE_BUDGET_MS, planStart = performance.now();
    let why = '';
    const plan = async (a: Account): Promise<TripPlan | null> => {
        const deadline = performance.now() + budgetMs;
        why = '';
        return routePlanMod ? await routePlanMod.planTripOffThread(from, to, a, stock, budgetMs)
            : stock ? planTrip(world, from, to, a, stock, undefined, undefined, { deadline })
            : (() => { const d = world.route(from, to, a, { deadline }); if (!d.ok) why = d.reason; return d.ok ? { cost: d.cost, legs: d.legs } as TripPlan : null; })();
    };
    let r = await plan(acct);
    // Quest varps never reach the client, so a gate that opens from a quest stage stays shut while the stage is unknown.
    // With no route, the journals that name such a stage (guild-facts.ts JOURNAL_STAGES) are read and the trip planned once more.
    if (!r && s.client) {
        const { refreshGuildEvidence, startedJournalQuests } = await import('../guild-observation');
        const quests = startedJournalQuests(s.client);
        if (quests.length) {
            await refreshGuildEvidence(s as any, quests);
            acct = accountForSdk(s.sdk);
            if (opts.noJewelry) acct = withoutJewelry(acct);
            r = await plan(acct);
            const seen = acct.questStages ?? {};
            console.log(`WALK_JOURNAL_REPLAN ${JSON.stringify({ quests, stages: Object.fromEntries(quests.map(q => [q, seen[q] ?? null])), ok: !!r })}`);
        }
    }
    // A slow plan that found a route: the live logs show how often a walk waits on a cold search (tools/route-prewarm.ts
    // reads these lines and WALK_NO_ROUTE).
    const planMs = Math.round(performance.now() - planStart);
    if (r && planMs >= SLOW_PLAN_MS) console.log(`WALK_PLAN_SLOW ${JSON.stringify({ from, to, ms: planMs, budgetMs, cost: r.cost, bank: !!r.bank })}`);
    if (!r) {
        // What the failed search started from: a live "no route" names only its target otherwise.
        console.log(`WALK_NO_ROUTE ${JSON.stringify({ from, to, ms: Math.round(performance.now() - planStart), budgetMs, bank: !!stock, coins: acct.coins ?? 0 })}`);
        return { ok: false, reason: 'precondition', detail: `no route${why === 'budget' ? ` (search over ${budgetMs} ms)` : ''} to ${to.x},${to.z},${to.level}`, ticks: 0 };
    }
    // Harm along the route (danger/exposure.ts): a route whose hunters would take the Hitpoints under the retreat line
    // goes by a safe route inside its bound, or walks and eats the pack food, or takes food from a bank first, or is
    // refused before it starts.
    if (!opts.noHarmCheck) {
        const harm = await routeHarm(s, from, to, acct, r, a => plan(a));
        if (harm.action === 'detour') r = harm.plan;
        else if (harm.action === 'eat' && harm.eatAbove > 0 && !await eatBeforeWalk(s, harm.eatAbove, () => opts.signal?.aborted === true)) {
            return { ok: false, reason: 'precondition', detail: `${routeDangerText(from, to)}: the Hitpoints stay at or under ${harm.eatAbove} after eating`, ticks: s.tick() - started };
        } else if (harm.action === 'refuse') {
            if (harm.needHeal > 0 && hasBank && !opts.noFoodStage && rawStock) {
                const staged = await stageFood(s, world, to, acct, rawStock, harm.needHeal, opts, goTo);
                if (staged) return { ...staged, ticks: s.tick() - started };
            }
            return { ok: false, reason: 'precondition', detail: `${routeDangerText(from, to)}: ${harm.zone} needs ${harm.needHeal} heal of food (expected damage ${harm.damage})`, ticks: s.tick() - started };
        }
    }
    // A route that walks round a fare the pack cannot pay (the Al Kharid toll gate with no coins: 307 path tiles
    // against 111) is logged with the cost of the paid route. The second search runs only for a route much longer
    // than its straight line with an unpaid fare in its box.
    const held = acct.coins ?? 0, straight = Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z));
    if (from.level === to.level && r.cost > 1.5 * straight + DETOUR_MARGIN) {
        const { loadTravel } = await import('../travel');
        const unpaid = unpaidFaresNear(from, to, held, loadTravel());
        if (unpaid.length) {
            const fare = Math.max(...unpaid.map(t => t.coins)), rich: Account = { ...acct, coins: held + fare, counts: { ...acct.counts, coins: held + fare } };
            const logDetour = (paid: TripPlan | null) => {
                if (fareDetour(r!, paid)) {
                    const fares = paid!.legs.flatMap(l => l.kind === 'travel' && l.travel.coins > held ? [{ edge: l.travel.id, coins: l.travel.coins }] : []);
                    console.log(`WALK_DETOUR ${JSON.stringify({ from, to, cost: r!.cost, paidCost: paid!.cost, extra: r!.cost - paid!.cost, coins: held, bankCoins: stock?.coins ?? null, fares })}`);
                }
            };
            if (routePlanMod) {
                // Diagnostic only: never stall the bot before walkRoute starts while comparing against a paid route.
                void routePlanMod.planTripOffThread(from, to, rich, undefined, budgetMs).then(logDetour, () => {});
            } else {
                const d = world.route(from, to, rich, { deadline: performance.now() + budgetMs });
                logDetour(d.ok ? { cost: d.cost, legs: d.legs } as TripPlan : null);
            }
        }
    }
    // Actor prerequisites are synchronous query masks, not long-lived refusal
    // walls: gear/stat changes and allowed exits must be re-evaluated.
    let first = await walkRoute(s, r.legs, opts);
    // A pocket exit that landed on another of its landings (the essence mine sends the player back to its wizard):
    // the walk is planned again from there, once.
    if (!first.ok && first.offPlan && (opts.offPlanReplans ?? 0) < 1) {
        const q = s.sdk.getState()?.player;
        console.log(`WALK_REPLAN_OFF_PLAN ${JSON.stringify({ from, to, at: q ? { x: q.worldX, z: q.worldZ, level: q.level } : null, failed: first.detail })}`);
        const again = await goTo(s, world, to, acct, { ...opts, offPlanReplans: (opts.offPlanReplans ?? 0) + 1 });
        return { ...again, ticks: s.tick() - started };
    }
    // A spell leg that failed (the runes gone, a cast the server did not take) is not tried again: the route is planned
    // once more for the account without its law runes, so the walk goes by foot and boat from where it stands.
    if (!first.ok && first.reason !== 'aborted' && r.legs.some(l => l.kind === 'travel' && l.travel.kind === 'spell')) {
        // A trip with a bank stop ends its first legs at the bank, so the replan heads there and the stop still follows.
        const q = s.sdk.getState()?.player, at = q ? { x: q.worldX, z: q.worldZ, level: q.level } : from, goal = r.bank?.at ?? to, grounded = withoutSpells(acct);
        const d: TripPlan | null = routePlanMod ? await routePlanMod.planTripOffThread(at, goal, grounded, undefined, budgetMs)
            : (() => { const x = world.route(at, goal, grounded, { deadline: performance.now() + budgetMs }); return x.ok ? { cost: x.cost, legs: x.legs } as TripPlan : null; })();
        console.log(`WALK_REPLAN_NO_SPELLS ${JSON.stringify({ from: at, to: goal, failed: first.detail, ok: !!d })}`);
        if (d) first = await walkRoute(s, d.legs, opts);
    }
    if (!first.ok || !r.bank) return first;
    const took = await takeItems(banker, r.bank.coins, r.bank.items, n => waitTicks(s, n),
        { stop: () => opts.signal?.aborted === true, deadline: performance.now() + 30_000 });
    if (!took.ok) return { ok: false, reason: 'precondition', detail: `bank stop at ${r.bank.at.x},${r.bank.at.z}: ${took.detail}`, ticks: s.tick() - started };
    const rest = await walkRoute(s, r.bank.then, opts);
    return rest.ok ? { ok: true, ticks: s.tick() - started } : rest;
}
