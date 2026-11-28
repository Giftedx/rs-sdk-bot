// Quest sweep entrypoints: stage bank/shop/gathered quest supplies, handle special area exits, and dispatch generated quest scripts.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accountOf, finish, finishHooks, getWorld, openBot } from '../../../core/src/bot';
import { ARROWS, BOWS, NPC_SOURCES, TINDERBOX, gatherItems, magicKit, rangedKit, arrowsFor, castsFor } from '../../../core/src/gather';
import type { Session } from '../../../core/src/inprocess';
import { productionStopRequested } from '../../../core/src/production-life';
import { readQuestJournalStage } from '../../../core/src/quest-journal';
import { questFlags } from '../../../core/src/quest-status';
import { sellersByDistance } from '../../../core/src/shop-index';
import { holdSessionEater, questFoodDefinitions, startQuestSustain } from '../../../core/src/sustain';
import { waitUntil } from '../../../core/src/ticks';
import { loadTravel } from '../../../core/src/travel';
import type { Tile, World } from '../../../core/src/world';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { QUEST_NAMES } from './chain';
import { fireRunesFor } from './fire-spells';
import { dashThroughDoor, inGhostBasement, leaveGhostBasement, retainedGhostBankSkull, retainedGhostSkull } from './helpers';
import { questEntry, resumeStart } from './resume';
import {
    NATURE_REF,
    registerQuestRuntime,
    resolveOwnedLoadoutDeps,
    resolveShiloTransit,
    scriptRelPath,
    type OwnedKitLike,
    type ShiloTransitLike,
} from './runtime';
import {
    ANTIPOISONS,
    BARE,
    BOAT_FARES,
    BUILD_MEALS,
    COINS,
    FIRE_QUESTS,
    HECKEL_DUST,
    MANOR_FOOD,
    MANOR_POISON,
    MEALS,
    PRAYER_POTIONS,
    QUEST_ARROWS,
    QUEST_CASTS,
    QUEST_FINDS,
    QUEST_KEEP,
    QUEST_PICKUPS,
    STACKS,
    STURDY,
    STURDY_MEALS,
    STURDY_OPTIONAL,
    UNDERGROUND,
    WORN_KIT,
    BANKS,
    bareDeposits,
    bareRoomDeposits,
    bareWornDeposits,
    buildPack,
    catalogItem,
    countItems,
    depositPlan,
    eatAtFor,
    eastOfPass,
    fares,
    fightMeals,
    fightMealsShort,
    fluffsKittenGiven,
    foodShort,
    groundShopNeeds,
    heckelDustNeed,
    ikovExcessMeals,
    itemIdOf,
    jailerBowKit,
    keepsItem,
    lightPlan,
    manorFoodNeed,
    manorPoisonNeed,
    mealPlan,
    leaveToManorTrip,
    nearestBanks,
    needs,
    pickInstead,
    plan,
    prayerCovers,
    presetFor,
    questGatherPlan,
    questSkillTraining,
    questTravelItems,
    reservedEdible,
    returnToAmik,
    withFightMeals,
    withExitRunes,
    QUEST_EXIT_RUNES,
    scorpionAntipoisonNeeds,
    scorpionBarcrawlNeeds,
    scorpionEntryRefusal,
    sellersByTravel,
    shopCoinTake,
    shopPlan,
    slotNeed,
    slotsFor,
    staysCount,
    toolPlan,
    travelDistance,
    wornKitPlan,
} from './sweep-plan';
import {
    amikIO,
    atTile,
    buyFromShops,
    fetchHeckelDust,
    fetchManorFishFood,
    finishBlackKnight,
    handOver,
    heckelIO,
    leaveFortress,
    leaveHazeelCave,
    leaveKeepLeFaye,
    leaveStronghold,
    lightAtBank,
    leaveWestArdougne,
    manorIO,
    planTeleportRunes,
    prayBefore,
    raiseFare,
    reachStart,
    reserveInputSlots,
    trainFishing,
    walkFar,
} from './sweep-travel';
import type { SweepApiOptions } from './types';

export * from './sweep-plan';
export * from './sweep-travel';
export type { SweepApiOptions };

type Item = { id: number; count: number };

export type ApiSweepDeps = {
    open: typeof openBot;
    world: typeof getWorld;
    go: typeof import('../../../core/src/walk').goTo;
    loadout: (s: Session, value: unknown, stop?: () => boolean) => Promise<{ ok: boolean; reason?: string; failure?: string; [k: string]: unknown }>;
    load: (path: string) => Promise<Record<string, unknown>>;
    finish: (sessions: Session[], ok: boolean, detail: string) => Promise<unknown>;
    exists: (path: string) => boolean;
    stop: () => boolean;
    transit: (s: Session, j: { protectMelee?: boolean }, alive: () => boolean) => ShiloTransitLike;
};

export function apiOptions(quest: string, value: unknown): SweepApiOptions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('quest sweep API requires explicit bounded options');
    const o = value as SweepApiOptions;
    if (
        Object.keys(o).some((k) => !['cap', 'prepareTicks', 'xpRate', 'maximumCasts'].includes(k)) ||
        ![o.cap, o.prepareTicks, o.xpRate].every(Number.isSafeInteger) ||
        o.cap < 1000 ||
        o.cap > (quest === 'tbwt' ? 15000 : 12000) ||
        o.prepareTicks < 200 ||
        o.prepareTicks > 4000 ||
        o.xpRate < 1 ||
        o.xpRate > 1000 ||
        (quest === 'tbwt' && (!Number.isSafeInteger(o.maximumCasts) || o.maximumCasts! < 1 || o.maximumCasts! > 40)) ||
        (quest === 'itwatchtower' && o.maximumCasts !== undefined)
    ) {
        throw Error('quest sweep API invalid finite options');
    }
    return { ...o };
}

async function apiSweep(
    account: string,
    quest: 'tbwt' | 'itwatchtower',
    fresh: string | undefined,
    value: unknown,
    injected: Partial<ApiSweepDeps>,
    existingSession?: Session,
) {
    const o = apiOptions(quest, value);
    const { goTo } = await import('../../../core/src/walk');
    const loadoutDeps = injected.loadout ? undefined : await resolveOwnedLoadoutDeps();
    const validateOwnedKit =
        loadoutDeps?.validateOwnedKit ??
        ((v: unknown) => {
            const k = v as OwnedKitLike;
            if (!k?.bank || !Array.isArray(k.pack) || !Array.isArray(k.wear)) throw Error('invalid owned kit');
            return k;
        });
    const d: ApiSweepDeps = {
        open: openBot,
        world: getWorld,
        go: goTo,
        loadout: injected.loadout ?? loadoutDeps!.runOwnedLoadout,
        load: (path) => import(path),
        finish,
        exists: existsSync,
        stop: () => false,
        transit: injected.transit ?? resolveShiloTransitSync,
        ...injected,
    };
    let signalled = false;
    const requested = () => productionStopRequested(account, () => signalled || d.stop(), d.exists) || d.exists('.practice/stop-quest-sweep');
    if (requested()) throw Error('quest sweep API stopped before login');
    const path = scriptRelPath('scripts', 'generated', `quest-${quest}-owned.ts`);
    const url = pathToFileURL(path).href;
    const m = await d.load(fresh ? `${url}?${fresh}` : url);
    const run = m[quest === 'tbwt' ? 'runTaiBwoWannaiTrio' : 'runWatchtower'];
    if (typeof run !== 'function') throw Error('quest sweep explicit API export missing');
    const pack =
        quest === 'tbwt'
            ? Object.entries({ 3150: 21, 3032: 1, 3171: 1, 3128: 1, 3164: 1, 401: 1, 379: 1, 558: Math.max(20, o.maximumCasts!) }).map(([id, count]) => ({
                  id: Number(id),
                  count,
              }))
            : Object.entries(m.WATCH_SUPPLIES as Record<number, number>).map(([id, count]) => ({ id: Number(id), count }));
    const wear = (quest === 'tbwt' ? [[1381, 3], [1540, 5], [577, 4], [1011, 7], [579, 0]] : [[1289, 3], [1540, 5], [1127, 4], [1079, 7], [1163, 0]]).map(
        ([id, slot]) => ({ id: id!, slot: slot!, count: 1 }),
    );
    const start: Tile = quest === 'tbwt' ? { x: 2781, z: 3086, level: 0 } : { x: 2548, z: 3118, level: 0 };
    validateOwnedKit({ bank: BANKS[0]!, pack, wear, cap: 600, maximumMoves: 160 });
    if (requested()) throw Error('quest sweep API stopped before login');
    const raw = existingSession ?? (await d.open(account, {
        onStop: async () => {
            signalled = true;
        },
    }));
    const client = raw.client as any;
    const owner = client?.executeBotAction;
    const self = client?.selfSlot;
    const initial = raw.sdk.getState()?.player;
    const life = initial?.lifeId;
    const respawns = initial?.respawnCount ?? 0;
    const began = raw.tick();
    let ended = false;
    let preparing = true;
    let ok = false;
    let detail = 'quest sweep API incomplete';
    let transit: ShiloTransitLike | undefined;
    let departed = false;
    let recoveryDeferred = false;
    const cleanupReserve = quest === 'tbwt' ? Math.min(600, Math.floor(o.prepareTicks / 2)) : 0;
    void raw.ended.then(() => {
        ended = true;
    });
    const own = () => {
        const p = raw.sdk.getState()?.player;
        return (
            !ended &&
            !!initial &&
            typeof owner === 'function' &&
            raw.client === client &&
            client.executeBotAction === owner &&
            client.selfSlot === self &&
            !!p &&
            !p.isDead &&
            p.lifeId === life &&
            (p.respawnCount ?? 0) === respawns
        );
    };
    const stop = () => !own() || requested() || (preparing && raw.tick() - began >= o.prepareTicks - cleanupReserve);
    const guard = () => {
        if (!own() || raw.sdk.getStateAge() > 5000) throw Error('quest sweep original client/life/input owner unavailable');
    };
    const sdk = new Proxy(raw.sdk, {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            return typeof v === 'function'
                ? function (...args: unknown[]) {
                      if (String(key).startsWith('send')) guard();
                      return v.apply(receiver, args);
                  }
                : v;
        },
    });
    const s = Object.create(raw) as Session;
    Object.defineProperties(s, {
        sdk: { value: sdk },
        bot: { value: new BotActions(sdk) },
        direct: {
            value: (action: Parameters<Session['direct']>[0]) => {
                guard();
                return raw.direct(action);
            },
        },
    });
    const controller = new AbortController();
    const off = raw.onTick(() => {
        if (stop()) controller.abort('quest sweep preparation stop/owner/budget');
    });
    const position = () => {
        const p = s.sdk.getState()?.player;
        return p && { x: p.worldX, z: p.worldZ, level: p.level };
    };
    const near = (to: Tile, tol = 3) => {
        const p = position();
        return !!p && p.level === to.level && Math.max(Math.abs(p.x - to.x), Math.abs(p.z - to.z)) <= tol;
    };
    const move = async (world: World, to: Tile) => {
        guard();
        if (stop()) throw Error('quest sweep preparation stopped');
        const r = await d.go(s, world, to, accountOf(s), { signal: controller.signal, legTimeoutTicks: 120, maxRetriesPerLeg: 1 });
        guard();
        if (stop() || !r.ok || !near(to)) throw Error('quest sweep preparation route unconfirmed ' + (r.ok ? 'arrival/stop' : r.detail));
    };
    try {
        guard();
        if (stop()) throw Error('quest sweep preparation stopped');
        const flags = questFlags(client);
        const journal = flags?.find((f) => f.name === (quest === 'tbwt' ? 'Tai Bwo Wannai Trio' : 'Watch Tower'));
        if (journal?.state !== 'not started' || (quest === 'tbwt' && !flags?.some((f) => f.name === 'Jungle Potion' && f.state === 'complete')) || client.membersAccount !== 1) {
            throw Error('quest sweep observed member/journal/prerequisite unavailable');
        }
        if (
            quest === 'tbwt' &&
            (!flags?.some((f) => f.name === 'Shilo Village' && f.state === 'complete') ||
                (s.sdk.getSkill('Prayer')?.baseLevel ?? 0) < 43 ||
                (s.sdk.getState()?.prayers.prayerPoints ?? 0) < 40 ||
                s.sdk.getSkill('Hitpoints')?.level !== s.sdk.getSkill('Hitpoints')?.baseLevel ||
                s.sdk.getState()?.autoRetaliateEnabled !== false ||
                s.sdk.getState()?.prayers.activePrayers.some(Boolean))
        ) {
            throw Error('Trio sweep requires observed Shilo access, full health, Prayer43/40 points and original all-off controls');
        }
        const world = await d.world();
        guard();
        if (stop()) throw Error('quest sweep preparation stopped');
        const exit = await leaveStronghold(s, async (to) => {
            await move(world, to);
            return { ok: true };
        });
        guard();
        if (!exit.ok || stop()) throw Error('quest sweep observed Stronghold exit unavailable');
        const at = position();
        if (!at) throw Error('quest sweep initial position unknown');
        let bank: Tile | undefined;
        let last = '';
        for (const candidate of quest === 'tbwt' ? [NATURE_REF.bank] : nearestBanks({ ...at, level: 0 }).slice(0, 4)) {
            try {
                await move(world, candidate);
                bank = candidate;
                break;
            } catch (e) {
                last = String(e);
                if (stop() || !own()) throw e;
            }
        }
        if (!bank) throw Error('quest sweep reachable owned bank unavailable ' + last);
        const remaining = o.prepareTicks - (s.tick() - began);
        if (remaining < 120) throw Error('quest sweep owned kit preparation budget');
        const kit: OwnedKitLike = { bank, pack, wear, cap: Math.min(600, remaining), maximumMoves: 160 };
        const staged = await d.loadout(s, kit, stop);
        guard();
        if (staged.ok !== true || stop()) throw Error('quest sweep mandatory owned kit unconfirmed ' + staged.failure);
        const totals = (rows: readonly { id: number; count: number }[]) =>
            Object.entries(
                rows.reduce(
                    (a, r) => ((a[r.id] = (a[r.id] ?? 0) + r.count), a),
                    {} as Record<number, number>,
                ),
            ).sort(([a], [b]) => Number(a) - Number(b));
        if (
            JSON.stringify(totals(s.sdk.getInventory())) !== JSON.stringify(totals(pack)) ||
            JSON.stringify(s.sdk.getEquipment().map((i) => [i.slot, i.id, i.count]).sort((a, b) => a[0]! - b[0]!)) !==
                JSON.stringify(wear.map((i) => [i.slot, i.id, i.count]).sort((a, b) => a[0]! - b[0]!))
        ) {
            throw Error('quest sweep mandatory observed pack/wear differs');
        }
        if (quest === 'tbwt') {
            transit = d.transit(s, { protectMelee: true }, () => own() && (s.sdk.getSkill('Hitpoints')?.level ?? 0) === (s.sdk.getSkill('Hitpoints')?.baseLevel ?? -1));
            departed = true;
            await transit.outbound(stop);
            guard();
            if (stop()) throw Error('Trio Shilo departure unconfirmed');
        }
        await move(world, start);
        guard();
        if (stop()) throw Error('quest sweep stopped before API dispatch');
        off();
        preparing = false;
        console.log('QUEST_SWEEP_API ' + JSON.stringify({ quest, phase: 'dispatch', start, options: o }));
        const result = quest === 'tbwt' ? await run(s, { cap: o.cap, xpRate: o.xpRate, maximumCasts: o.maximumCasts }, stop) : await run(s, { cap: o.cap, xpRate: o.xpRate, stop });
        guard();
        if (!result || typeof result.ok !== 'boolean' || result.complete !== true) throw Error('quest sweep API completion unknown');
        ok = result.ok && !requested();
        detail = JSON.stringify({ quest, scope: 'explicit API on mandatory owned bank kit', result });
    } catch (error) {
        detail = `quest-sweep ${quest} ${String(error)}`;
        if (preparing && departed && transit && own()) {
            if (transit.pending()) {
                recoveryDeferred = true;
                detail += '; Shilo crossing outcome unknown; no repeat or bank movement';
            } else {
                const cleanupStop = () =>
                    !own() ||
                    raw.tick() - began >= o.prepareTicks ||
                    (s.sdk.getSkill('Hitpoints')?.level ?? 0) !== (s.sdk.getSkill('Hitpoints')?.baseLevel ?? -1);
                try {
                    await transit.returnVillage(cleanupStop);
                    guard();
                    if (cleanupStop() || !near(NATURE_REF.bank, 0) || s.sdk.getState()?.prayers.activePrayers[14] !== false) {
                        throw Error('Shilo bank/protection restoration unconfirmed');
                    }
                } catch (cleanup) {
                    recoveryDeferred = true;
                    detail += '; Shilo cleanup ' + String(cleanup);
                }
            }
        }
    } finally {
        off();
        preparing = false;
    }
    if (recoveryDeferred || !own()) {
        console.log('QUEST_SWEEP_SETTLEMENT_DEFERRED ' + detail);
        return { ok: false, recoveryDeferred: true, detail };
    }
    if (existingSession) {
        if (!ok) throw Error(detail);
        return { ok: true, detail };
    }
    return d.finish([s], ok, detail);
}

function resolveShiloTransitSync(s: Session, j: { protectMelee?: boolean }, alive: () => boolean): ShiloTransitLike {
    let inner: Promise<ShiloTransitLike> | undefined;
    const get = () => (inner ??= resolveShiloTransit(s, j, alive));
    let pendingState = false;
    return {
        async protect(on, stop) {
            return (await get()).protect(on, stop);
        },
        async walkNative(goal, stop) {
            return (await get()).walkNative(goal, stop);
        },
        async returnVillage(stop) {
            pendingState = true;
            try {
                await (await get()).returnVillage(stop);
            } finally {
                pendingState = (await get()).pending();
            }
        },
        async outbound(stop) {
            pendingState = true;
            try {
                await (await get()).outbound(stop);
            } finally {
                pendingState = (await get()).pending();
            }
        },
        pending() {
            return pendingState;
        },
    };
}

export async function wearQuestKit(s: Session, wear: readonly { id: number; required: boolean }[]): Promise<string | null> {
    for (const i of wear) {
        if (s.sdk.getEquipment().some((e) => e.id === i.id && e.count > 0)) continue;
        const row = s.sdk.getState()?.inventory.find((e) => e.id === i.id && e.count > 0);
        if (!row) return `${i.required ? 'required' : 'selected'} worn item ${i.id} unavailable`;
        await s.bot.equipItem(row);
        const observed = await waitUntil(s, () => s.sdk.getEquipment().some((e) => e.id === i.id && e.count > 0), { timeoutTicks: 10 });
        console.log(`QUEST_SWEEP_WORN ${JSON.stringify({ id: i.id, required: i.required, observed })}`);
        if (!observed) return `${i.required ? 'required' : 'selected'} worn item ${i.id} equip unobserved`;
    }
    return null;
}

function observeQuestFlags(s: Session) {
    const seen = new Map<number, string>();
    const observe = () => {
        for (const q of questFlags(s.client) ?? []) {
            if (seen.get(q.id) !== q.state) {
                seen.set(q.id, q.state);
                console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);
            }
        }
    };
    observe();
    const off = s.onTick(observe);
    void s.ended.then(off);
}

export async function sweep(
    account: string,
    quest: string,
    fresh?: string,
    options?: SweepApiOptions,
    deps: Partial<ApiSweepDeps> = {},
    existingSession?: Session,
) {
    if (quest === 'hero' || quest === 'heroes') {
        throw Error('Heroes requires the explicit owned pair CLI quest-hero-owned.ts or runHeroesPair(original sessions, validated order); no single-actor partner login');
    }
    if (quest === 'tbwt' || quest === 'itwatchtower') return apiSweep(account, quest, fresh, options, deps, existingSession);
    return sweepPreset(account, quest, fresh, existingSession);
}

export async function sweepPreset(account: string, quest: string, fresh?: string, existingSession?: Session) {
    if (quest === 'hero' || quest === 'heroes') {
        throw Error('Heroes requires the explicit owned pair CLI quest-hero-owned.ts or runHeroesPair(original sessions, validated order); no single-actor partner login');
    }
    const scriptPath = scriptRelPath('scripts', 'generated', `quest-${quest}.ts`);
    if (!existsSync(scriptPath)) throw Error(`quest sweep: no script ${scriptPath}`);
    const script = pathToFileURL(scriptPath).href;
    const preset = presetFor(quest);
    let base = needs(preset, false, quest);
    const food = needs(preset, true, quest);
    const s: Session = existingSession ?? (await openBot(account));
    // A quest session has no eat guard (packages/core/src/eat-guard.ts): the staged items can be food. The hold has no release.
    holdSessionEater(s.sdk);
    const fail = (why: string) => {
        if (existingSession) throw Error(`quest-sweep ${quest} ${why}`);
        return finish([s], false, `quest-sweep ${quest} ${why}`);
    };
    let handed = false;
    // Quest items of a resumed stage that the script needs (packages/workers/src/quest/resume.ts QuestResume.held).
    let held: readonly number[] = [];
    try {
        const st = () => s.sdk.getState();
        if (!(await waitUntil(s, () => !!st()?.player, { timeoutTicks: 20 }))) return fail('entry state unavailable');
        if (quest === 'scorpion') {
            const flag = () => questFlags(s.client)?.find((f) => f.name === QUEST_NAMES.scorpion)?.state ?? 'unknown';
            await waitUntil(s, () => flag() !== 'unknown', { timeoutTicks: 20 });
            const journal = flag();
            const refusal = scorpionEntryRefusal(journal, (s.client as any).var?.[76]);
            if (refusal) return fail(refusal);
            const observed = (s.client as any).var?.[77];
            const state = Number.isSafeInteger(observed) ? Number(observed) : undefined;
            base = scorpionBarcrawlNeeds(base, state);
            console.log(`QUEST_SWEEP_SCORPION_ENTRY ${JSON.stringify({ journal, barcrawl: state ?? 'unknown', stagesBarcrawl: state !== 2 })}`);
        }
        const questName = QUEST_NAMES[quest];
        if (questName) {
            const journal = () => questFlags(s.client)?.find((f) => f.name === questName)?.state ?? 'unknown';
            await waitUntil(s, () => journal() !== 'unknown', { timeoutTicks: 20 });
            // %qp (varp 101) reaches the client; varServ holds only server-sent values (packages/core/src/guild-facts.ts).
            const qp = (s.client as { varServ?: Record<number, unknown> } | undefined)?.varServ?.[101];
            const questPoints = Number.isSafeInteger(qp) ? Number(qp) : undefined;
            const entry = questEntry(quest, questName, journal(), questPoints);
            console.log(`QUEST_SWEEP_ENTRY ${JSON.stringify({ quest, journal: journal(), questPoints: questPoints ?? 'unknown', entry: entry.kind })}`);
            if (entry.kind === 'refuse') return fail(entry.reason);
            if (entry.kind === 'resume') {
                const r = entry.resume;
                const stage = await readQuestJournalStage({ s, waitUntil: (f, ticks) => waitUntil(s, f, { timeoutTicks: ticks }) }, r.key, r.title, r.stage);
                const start = resumeStart(r, questName, stage);
                const logged = start.kind === 'resume'
                    ? { quest, stage, spent: start.spent, from: start.from, held: start.held, extra: start.extra }
                    : { quest, stage, kind: start.kind, reason: start.reason };
                console.log(`QUEST_SWEEP_RESUME ${JSON.stringify(logged)}`);
                if (start.kind === 'refuse') return fail(start.reason);
                for (const id of start.spent) {
                    base.delete(id);
                    food.delete(id);
                }
                for (const i of start.extra) base.set(i.id, (base.get(i.id) ?? 0) + i.count);
                held = start.held;
                (s as { questFrom?: number }).questFrom = start.from;
            }
        }
        const baseLevel = (name: string) => st()?.skills?.find((k: any) => k.name === name)?.baseLevel ?? 1;
        for (const id of STURDY_OPTIONAL[quest] ?? []) {
            if (base.has(id) && baseLevel('Hitpoints') >= STURDY && baseLevel('Defence') >= STURDY) {
                food.set(id, base.get(id)!);
                base.delete(id);
                const meal = [...food.keys()].find((f) => MEALS.includes(f));
                if (meal !== undefined) food.set(meal, Math.max(food.get(meal)!, STURDY_MEALS));
            }
        }
        // A Prayer level that covers the fights needs no potion: prayBefore restores drained points at the altar.
        if (prayerCovers(quest, baseLevel('Prayer'))) for (const id of PRAYER_POTIONS) base.delete(id);
        for (const id of [...ANTIPOISONS, ...(QUEST_FINDS[quest] ?? [])]) {
            if (base.has(id)) {
                food.set(id, (food.get(id) ?? 0) + base.get(id)!);
                base.delete(id);
            }
        }
        if (FIRE_QUESTS.has(quest)) base = fireRunesFor(base, baseLevel('Magic'));
        const build = buildPack(quest, baseLevel);
        for (const i of build) base.set(i.id, (base.get(i.id) ?? 0) + i.count);
        if (build.length) {
            const meal = [...food.keys()].find((f) => MEALS.includes(f));
            if (meal !== undefined && BUILD_MEALS[quest] !== undefined) food.set(meal, BUILD_MEALS[quest]!);
            console.log(`QUEST_SWEEP_BUILD_PACK ${JSON.stringify({ quest, pack: build, meals: BUILD_MEALS[quest] })}`);
        }
        // An account outside the gate that the preset start is behind needs the gate item (QUEST_TRAVEL_ITEMS).
        const gateItems = questTravelItems(quest, atTile(s), preset.position);
        for (const i of gateItems) base.set(i.id, Math.max(i.count, base.get(i.id) ?? 0));
        if (gateItems.length) console.log(`QUEST_SWEEP_TRAVEL_ITEMS ${JSON.stringify({ quest, at: atTile(s), items: gateItems })}`);
        // A quest script's own fight: meals for the live account's hitpoints, not the all-99 preset's (QUEST_FIGHT_DAMAGE).
        const fight = fightMeals(quest, baseLevel('Hitpoints'));
        if (fight) {
            for (const [id, n] of withFightMeals(food, quest, baseLevel('Hitpoints'))) food.set(id, n);
            console.log(`QUEST_SWEEP_FIGHT_MEALS ${JSON.stringify({ quest, hitpoints: baseLevel('Hitpoints'), meals: fight })}`);
        }
        // The teleport exit from a walled area is required, not optional (QUEST_EXIT_RUNES).
        if (QUEST_EXIT_RUNES[quest]) {
            const exit = withExitRunes(base, food, quest, baseLevel('Magic'));
            base = exit.base;
            food.clear();
            for (const [id, n] of exit.food) food.set(id, n);
        }
        if (quest === 'scorpion') base = scorpionAntipoisonNeeds(base, st()?.inventory ?? [], []);
        let wornKit = wornKitPlan(quest, base, st()?.inventory ?? [], [], s.sdk.getEquipment());
        let need = wornKit.need;
        const maxHp = () => st()?.skills?.find((k: any) => k.name === 'Hitpoints')?.baseLevel ?? 10;
        const sustain = startQuestSustain(
            {
                sdk: s.sdk,
                tick: () => s.tick(),
                onTick: (cb) => s.onTick(cb),
                ended: s.ended,
                direct: async (action) => {
                    const reply: any = await s.direct(action);
                    return { success: !!reply?.success, message: reply?.message === undefined ? undefined : String(reply.message) };
                },
            },
            { food: [...questFoodDefinitions().keys()], eatAt: eatAtFor(maxHp()), reserved: reservedEdible(need) },
        );
        void s.ended.then(() => sustain.stop());
        sustain.aborted.addEventListener('abort', () =>
            console.log(`QUEST_SWEEP_SUSTAIN_FAIL ${JSON.stringify({ failure: sustain.failure(), hp: st()?.player?.hp, at: atTile(s) })}`),
        );
        const danger = () => {
            const p = st()?.player;
            return !!p && (p.combat?.inCombat || p.hp <= eatAtFor(maxHp()));
        };
        if (danger()) {
            console.log(
                `QUEST_SWEEP_DANGER ${JSON.stringify({ hp: st()?.player?.hp, inCombat: st()?.player?.combat?.inCombat, at: { x: st()?.player?.worldX, z: st()?.player?.worldZ, level: st()?.player?.level } })}`,
            );
        }
        if (inGhostBasement(st()?.player)) {
            const locAt = (x: number, z: number) => (st()?.nearbyLocs ?? []).find((l: any) => l.x === x && l.z === z);
            const ops = (l: any) => (l?.optionsWithIndex ?? []) as { text: string; opIndex: number }[];
            const near = (x: number, z: number, tol: number) => {
                const p = st()?.player;
                return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
            };
            await leaveGhostBasement({
                pos: () => st()?.player,
                openDoor: async (_l, x, z) => {
                    const d = locAt(x, z);
                    const op = ops(d).find((o) => /^open$/i.test(o.text));
                    if (d && op) {
                        await s.bot.interactLoc(d, op.opIndex);
                        await waitUntil(s, () => !ops(locAt(x, z)).some((o) => /^open$/i.test(o.text)), { timeoutTicks: 12 });
                    }
                },
                dash: (l, x, z, tol) =>
                    dashThroughDoor(
                        {
                            pos: () => st()?.player,
                            walk: async (x, z) => {
                                await s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
                            },
                            arrived: (x, z, tol) => waitUntil(s, () => near(x, z, tol), { timeoutTicks: 30 }),
                            closedDoor: (within) =>
                                (st()?.nearbyLocs ?? [])
                                    .filter((d: any) => /door|gate/i.test(d.name) && near(d.x, d.z, within) && ops(d).some((o) => /^open$/i.test(o.text)))
                                    .sort((a: any, b: any) => a.distance - b.distance)[0],
                            open: async (d) => {
                                const l = locAt(d.x, d.z);
                                const op = ops(l).find((o) => /^open$/i.test(o.text));
                                if (l && op) {
                                    await s.bot.interactLoc(l, op.opIndex);
                                    await waitUntil(s, () => !ops(locAt(d.x, d.z)).some((o) => /^open$/i.test(o.text)), { timeoutTicks: 12 });
                                }
                            },
                        },
                        l,
                        x,
                        z,
                        tol,
                    ),
                waitForLadder: () =>
                    waitUntil(s, () => !!locAt(3104, 9576) || !!(st()?.nearbyLocs ?? []).find((l: any) => ops(l).some((o) => /climb-up|climb$/i.test(o.text)) && l.distance <= 3), {
                        timeoutTicks: 15,
                    }),
                climbLadder: async () => {
                    const l = (st()?.nearbyLocs ?? [])
                        .filter((l: any) => ops(l).some((o) => /climb-up|^climb$/i.test(o.text)))
                        .sort((a: any, b: any) => a.distance - b.distance)[0];
                    const op = ops(l).find((o) => /climb-up|^climb$/i.test(o.text));
                    if (l && op) {
                        const z0 = st()?.player?.worldZ ?? 0;
                        await s.bot.interactLoc(l, op.opIndex);
                        await waitUntil(s, () => (st()?.player?.worldZ ?? z0) < UNDERGROUND, { timeoutTicks: 30 });
                    }
                },
                waitForLanding: () => waitUntil(s, () => (st()?.player?.worldZ ?? UNDERGROUND) < UNDERGROUND, { timeoutTicks: 15 }),
            });
            console.log(`QUEST_SWEEP_LEFT_BASEMENT ${JSON.stringify({ x: st()?.player?.worldX, z: st()?.player?.worldZ, level: st()?.player?.level })}`);
        }
        const ghostState = () => questFlags(s.client)?.find((f) => f.name === 'The Restless Ghost')?.state ?? 'unknown';
        const retained = () => quest === 'priest' && retainedGhostSkull(ghostState(), st()?.inventory ?? [], s.sdk.getEquipment());
        const returnSkull = async () => {
            console.log(
                'QUEST_SWEEP_RETAINED_SKULL ' +
                    JSON.stringify({ state: ghostState(), position: st()?.player && { x: st()!.player!.worldX, z: st()!.player!.worldZ, level: st()!.player!.level } }),
            );
            observeQuestFlags(s);
            sustain.stop();
            handed = true;
            (s as { questReserved?: Record<number, number> }).questReserved = reservedEdible(need);
            await handOver(s, script, fresh);
            return;
        };
        if (quest === 'priest') {
            await waitUntil(s, () => ghostState() !== 'unknown', { timeoutTicks: 20 });
            if ((st()?.inventory ?? []).some((i) => i.id === 553)) {
                if (!retained()) return fail('retained skull requires a started journal and worn ghostspeak amulet');
                return await returnSkull();
            }
        }
        if (quest === 'fluffs') {
            const journal = () => questFlags(s.client)?.find((f) => f.name === QUEST_NAMES.fluffs)?.state ?? 'unknown';
            await waitUntil(s, () => journal() !== 'unknown', { timeoutTicks: 20 });
            if (fluffsKittenGiven(journal(), st()?.inventory ?? [], st()?.player)) {
                console.log(
                    'QUEST_SWEEP_FLUFFS_RESUME ' +
                        JSON.stringify({ state: journal(), position: { x: st()!.player!.worldX, z: st()!.player!.worldZ, level: st()!.player!.level } }),
                );
                observeQuestFlags(s);
                sustain.stop();
                handed = true;
                (s as { questReserved?: Record<number, number> }).questReserved = reservedEdible(need);
                await handOver(s, script, fresh);
                return;
            }
        }
        const here = (): Tile => {
            const p = st()?.player;
            return p ? { x: p.worldX, z: p.worldZ, level: p.level } : { x: 0, z: 0, level: -1 };
        };
        const world = await getWorld();
        const fortress = await leaveFortress(s);
        if (!fortress.ok) return fail(fortress.detail!);
        const cave = await leaveHazeelCave(s);
        if (!cave.ok) return fail(cave.detail!);
        const westArdougne = await leaveWestArdougne(s);
        if (!westArdougne.ok) return fail(westArdougne.detail!);
        const { goTo } = await import('../../../core/src/walk');
        const { wayDown: wd, downward: dn, SWEEP_PLAN_BUDGET_MS: spb } = await import('./sweep-plan');
        for (let i = 0; i < 4 && (st()?.player?.level ?? 0) > 0; i++) {
            const level = st()?.player?.level ?? 0;
            const down = wd(world.navigationGraph?.().transports ?? [], here());
            console.log(`QUEST_SWEEP_DOWN ${JSON.stringify({ from: here(), to: down })}`);
            const r = await goTo(s, world, down, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: spb });
            if (r.ok && (st()?.player?.level ?? level) < level) continue;
            const way = dn(st()?.nearbyLocs ?? []);
            if (!way) return fail(`no way down from level ${st()?.player?.level}${r.ok ? '' : `: ${r.reason} ${r.detail}`}`);
            await s.bot.interactLoc(way.loc, way.opIndex);
            await waitUntil(s, () => (st()?.player?.level ?? level) < level, { timeoutTicks: 30 });
        }
        if ((st()?.player?.level ?? 0) > 0) return fail(`no observed descent from ${JSON.stringify(here())}`);
        // After the descent: a run that ended upstairs in Keep Le Faye (Sir Mordred is on level 2) comes down inside it.
        const keep = await leaveKeepLeFaye(s);
        if (!keep.ok) return fail(keep.detail!);
        if (quest === 'blackknight') {
            const state = () => questFlags(s.client)?.find((f) => f.name === "Black Knight's Fortress")?.state ?? 'unknown';
            if (!(await waitUntil(s, () => state() !== 'unknown', { timeoutTicks: 20 }))) return fail('Black Knight journal state unavailable');
            if (returnToAmik(quest, state())) {
                observeQuestFlags(s);
                const result = await finishBlackKnight(amikIO(s, world));
                if (!result.ok) return fail(result.detail!);
                return finish([s], true, 'quest-sweep blackknight quest complete qp=3');
            }
        }
        const pack = (): Item[] => (st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count }));
        const heldMissing = (): number[] => held.filter((id) => countItems(pack(), id) === 0 && !s.sdk.getEquipment().some((e) => e.id === id));
        const seekGhostSkull = quest === 'priest' && ghostState() === 'started' && s.sdk.getEquipment().some((i) => i.id === 552);
        const skill = (name: string) => st()?.skills?.find((k: any) => k.name === name)?.baseLevel ?? 1;
        const tradeableId = (id: number) => (catalogItem(id) as { tradeable?: boolean } | undefined)?.tradeable;
        const bare =
            (BARE.has(quest) || build.length > 0) &&
            (s.sdk.getEquipment().length > 0 ||
                bareDeposits(quest, pack(), need, food, tradeableId).length > 0 ||
                (quest === 'ikov' && ikovExcessMeals(pack(), food).length > 0));
        if (
            bare ||
            seekGhostSkull ||
            WORN_KIT[quest]?.some((i) => !i.required && !s.sdk.getEquipment().some((e) => e.id === i.id)) ||
            heldMissing().length ||
            plan(need, pack(), []).missing.length ||
            foodShort(food, pack(), need) ||
            questSkillTraining(quest, skill)
        ) {
            const exit = await leaveStronghold(s);
            if (!exit.ok) return fail(exit.detail!);
            const bankTravel = world.navigationGraph?.().travel ?? loadTravel();
            const findBank = async () => {
                let result: { ok: boolean; reason?: string; detail?: string; ticks?: number } = { ok: false, reason: 'precondition', detail: 'no bank tried', ticks: 0 };
                const tried = new Set<string>();
                for (let attempt = 0; attempt < 4; attempt++) {
                    const bank = nearestBanks(here(), accountOf(s), bankTravel).find((b) => !tried.has(`${b.x},${b.z},${b.level}`));
                    if (!bank) break;
                    tried.add(`${bank.x},${bank.z},${bank.level}`);
                    console.log(`QUEST_SWEEP_BANK ${JSON.stringify({ from: here(), to: bank })}`);
                    result = await walkFar(s, world, bank, 100);
                    console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({ at: here(), to: bank, outcome: result })}`);
                    if (result.ok) break;
                }
                return result;
            };
            let walked = await findBank();
            if (!walked.ok && countItems(pack(), COINS) < 200 && (await raiseFare(s, world))) walked = await findBank();
            if (!walked.ok) return fail(`bank walk failed at ${JSON.stringify(here())}: ${walked.reason} ${walked.detail}`);
            const opened = await s.bot.openBank();
            if (!opened.success) return fail('bank did not open');
            await waitUntil(s, () => (st()?.bank?.items?.length ?? 0) > 0, { timeoutTicks: 10 });
            if (bare) {
                const depositIds = async (ids: readonly number[], label: string): Promise<string | null> => {
                    for (const id of ids) {
                        const row = (st()?.inventory ?? []).find((i: any) => i.id === id);
                        if (!row) continue;
                        await s.bot.depositItem(row, -1);
                        if (!(await waitUntil(s, () => countItems(pack(), id) === 0, { timeoutTicks: 10 }))) return `${label} unobserved ${id}`;
                    }
                    return null;
                };
                const bankRows = async (extraIds: readonly number[] = []) => {
                    const baseErr = await depositIds(bareDeposits(quest, pack(), need, food, tradeableId), 'bare deposit');
                    if (baseErr) return baseErr;
                    const extraErr = await depositIds(extraIds, 'bare worn deposit');
                    if (extraErr) return extraErr;
                    if (quest === 'ikov') {
                        for (const { id, deposit } of ikovExcessMeals(pack(), food)) {
                            let rem = deposit;
                            while (rem > 0) {
                                const row = (st()?.inventory ?? []).find((i: any) => i.id === id);
                                if (!row) break;
                                const n = Math.min(rem, row.count);
                                const before = countItems(pack(), id);
                                await s.bot.depositItem(row, n);
                                if (!(await waitUntil(s, () => countItems(pack(), id) <= before - n, { timeoutTicks: 10 }))) {
                                    return `bare meal trim unobserved ${id}`;
                                }
                                rem -= n;
                            }
                        }
                    }
                    return null;
                };
                const first = await bankRows();
                if (first) return fail(first);
                // A required worn-kit item stays on: banked, it came back into the pack to be worn again, and a resumed
                // Temple of Ikov with the pendant of Lucien needed one slot more than the pack has.
                const keepOn = new Set((WORN_KIT[quest] ?? []).filter((k) => k.required).map((k) => k.id));
                const removedIds: number[] = [];
                for (let round = 0; round < 3; round++) {
                    const worn = [...s.sdk.getEquipment()].filter((item) => !keepOn.has(item.id));
                    if (!worn.length) break;
                    // Free pack slots before unequipping so a full PvP pack (sharks + runes) never rejects unequipItem.
                    const roomIds = bareRoomDeposits(pack(), worn.length);
                    if (roomIds.length) {
                        const roomErr = await depositIds(roomIds, 'bare room deposit');
                        if (roomErr) return fail(roomErr);
                    }
                    const freeSlots = 28 - pack().length;
                    if (freeSlots < 1) return fail(`bare unequip has no free pack slot for worn item ${worn[0]!.id}`);
                    const batch = worn.slice(0, freeSlots);
                    for (const item of batch) {
                        await s.bot.unequipItem(item);
                        if (!(await waitUntil(s, () => !s.sdk.getEquipment().some((e) => e.slot === item.slot), { timeoutTicks: 8 }))) {
                            return fail(`worn item ${item.id} did not come off`);
                        }
                        removedIds.push(item.id);
                    }
                    if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 10 }))) {
                        return fail('bank did not reopen for the worn items');
                    }
                    const second = await bankRows(bareWornDeposits(quest, removedIds, need));
                    if (second) return fail(second);
                }
                console.log(`QUEST_SWEEP_BARE ${JSON.stringify({ worn: removedIds, left: s.sdk.getEquipment().length, pack: pack().map((i) => i.id) })}`);
            }
            const rows = (): Item[] => (st()?.bank?.items ?? []).map((i: any) => ({ id: i.id, count: i.count }));
            // A lit light source that the quest pack needs and that the account can light from an unlit one: before the
            // plan, so that the plan finds it in the pack and sends no gather to a candle spawn.
            const lights = lightPlan(need, pack(), rows());
            if (lights.length) {
                const unlit = await lightAtBank(s, lights, need.has(TINDERBOX));
                if (unlit) return fail(unlit);
            }
            if (quest === 'scorpion') base = scorpionAntipoisonNeeds(base, pack(), rows());
            // The bank can be outside the gate when the account started inside it.
            for (const i of questTravelItems(quest, here(), preset.position)) base.set(i.id, Math.max(i.count, base.get(i.id) ?? 0));
            wornKit = wornKitPlan(quest, base, pack(), rows(), s.sdk.getEquipment());
            need = wornKit.need;
            const p = plan(need, pack(), rows());
            const meal = mealPlan(food, pack(), rows(), p.withdraw, need);
            p.withdraw.push(...meal);
            const fightShort = fightMealsShort(fight, pack(), p.withdraw, need);
            if (fightShort) {
                console.log(`QUEST_SWEEP_FOOD_SHORT ${JSON.stringify({ quest, meals: fight, short: fightShort })}`);
                await s.bot.closeBank();
                return fail(`food short: ${fight} meals for the fight, ${fightShort} short`);
            }
            for (const id of QUEST_KEEP[quest] ?? []) if (countItems(pack(), id) === 0 && countItems(rows(), id) > 0) p.withdraw.push({ id, count: 1 });
            for (const id of heldMissing()) {
                if (countItems(rows(), id) > 0 && !p.withdraw.some((w) => w.id === id)) p.withdraw.push({ id, count: 1 });
            }
            if (held.length) console.log(`QUEST_SWEEP_HELD ${JSON.stringify({ held, missing: heldMissing(), banked: heldMissing().filter((id) => countItems(rows(), id) > 0) })}`);
            if (seekGhostSkull && retainedGhostBankSkull(ghostState(), pack(), s.sdk.getEquipment(), rows())) p.withdraw.push({ id: 553, count: 1 });
            const ranked = (d: string, at: Tile) =>
                sellersByTravel(sellersByDistance(d, at), at, preset.position, accountOf(s)).map((n) => ({ npc: n.npc, npcId: n.npcId, tile: n.tile }));
            const shops = (items: readonly Item[]) => shopPlan(items, here(), catalogItem, (d, at) => ranked(d, at)[0] ?? null, ranked);
            const sellerAt = (id: number) => {
                const it = catalogItem(id);
                const n = it && id !== COINS ? ranked(it.debugname, here())[0] : null;
                return n ? travelDistance(here(), n.tile) : Infinity;
            };
            const worn = (): Item[] => s.sdk.getEquipment().map((i: any) => ({ id: i.id, count: i.count }));
            const owned = [...pack(), ...rows(), ...worn()];
            const kit = rangedKit(owned);
            const mkit = magicKit(owned, skill('Magic'), undefined, (id) => sellerAt(id) < Infinity);
            const seen = (ids: readonly number[]) => Object.fromEntries(ids.filter((id) => owned.some((i) => i.id === id)).map((id) => [id, countItems(owned, id)]));
            console.log(
                `QUEST_SWEEP_KIT ${JSON.stringify({ kit, mkit, bows: seen(BOWS), arrows: seen(ARROWS), bank: rows().length, pack: pack().length, worn: worn().length, ranged: skill('Ranged'), magic: skill('Magic'), attack: skill('Attack'), strength: skill('Strength') })}`,
            );
            const gather = questGatherPlan(quest, p.missing, here(), sellerAt, undefined, skill('Attack'), kit ? skill('Ranged') : 1, undefined, mkit ? skill('Magic') : 1, skill('Strength'));
            const questArrows = kit && skill('Ranged') > skill('Attack') ? QUEST_ARROWS[quest] ?? 0 : 0;
            if (kit && (gather.gathers.some((g) => g.kit === 'ranged') || questArrows)) {
                gather.tools.push(
                    { id: kit.bow, count: 1 },
                    { id: kit.arrows, count: gather.gathers.filter((g) => g.kit === 'ranged').reduce((n, g) => n + arrowsFor(g.id, g.count), 0) + questArrows },
                );
            }
            const jailerBow = jailerBowKit(quest, owned, skill('Ranged'), skill('Attack'), !!kit);
            if (jailerBow) {
                gather.tools.push({ id: jailerBow.bow, count: 1 }, { id: jailerBow.arrows, count: QUEST_ARROWS[quest]! });
                console.log(`QUEST_SWEEP_JAILER_BOW ${JSON.stringify(jailerBow)}`);
            }
            const questCasts = mkit && !questArrows && skill('Magic') > skill('Attack') ? QUEST_CASTS[quest] ?? 0 : 0;
            if (mkit && (gather.gathers.some((g) => g.kit === 'magic') || questCasts)) {
                const casts = gather.gathers.filter((g) => g.kit === 'magic').reduce((n, g) => n + castsFor(g.id, g.count, mkit.maxhit), 0) + questCasts;
                if (mkit.staff !== undefined) gather.tools.push({ id: mkit.staff, count: 1 });
                for (const [id, n] of Object.entries(mkit.runes)) gather.tools.push({ id: Number(id), count: n * casts });
            }
            const training = questSkillTraining(quest, skill);
            if (training) gather.tools.push(...training.tools);
            const tools = toolPlan(gather.tools, need, pack(), worn(), rows(), p.withdraw);
            p.withdraw.push(...tools.withdraw);
            const manorFood = manorFoodNeed(quest, p.missing);
            const manorPoison = manorPoisonNeed(quest, p.missing);
            const heckelDust = heckelDustNeed(quest, p.missing);
            const shopNeeds = groundShopNeeds(quest, gather.still).filter((m) => !(manorFood && m.id === MANOR_FOOD.id) && !(manorPoison && m.id === MANOR_POISON.id));
            gather.gathers = leaveToManorTrip(gather.gathers, manorFood, manorPoison);
            const toolIds = new Set(gather.tools.map((t) => t.id));
            let shop = shops([...shopNeeds, ...tools.missing]);
            const instead = pickInstead(shop.buys, here(), preset.position);
            if (instead.picks.length) {
                console.log(`QUEST_SWEEP_PICK_INSTEAD ${JSON.stringify(instead.picks)}`);
                gather.gathers.unshift(...instead.picks.map((i) => ({ id: i.id, count: i.count, how: 'pick' as const })));
                shop = shops([...shopNeeds, ...tools.missing].filter((i) => !instead.picks.some((p) => p.id === i.id)));
            }
            const consumable = new Set(tools.missing.filter((t) => STACKS.has(t.id)).map((t) => t.id));
            for (const b of shop.buys) if (consumable.has(b.id)) b.atLeast = Math.ceil(b.count * 0.9);
            if (gather.gathers.length) console.log(`QUEST_SWEEP_GATHER_PLAN ${JSON.stringify(gather)}`);
            if (shop.unsold.length) {
                await s.bot.closeBank();
                return fail('missing ' + shop.unsold.map((i) => `${i.id}:${i.count}`).join(',') + (shop.buys.length ? ' (unsold; others in shops)' : ''));
            }
            const sweepAcct = accountOf(s);
            shop.coins +=
                gather.coins +
                (heckelDust ? HECKEL_DUST.coins : 0) +
                fares(
                    here(),
                    [...shop.buys.map((b) => b.tile), preset.position, ...gather.gathers.flatMap((g) => (g.how === 'npc' && NPC_SOURCES[g.id] ? [NPC_SOURCES[g.id]!.tile] : []))],
                    sweepAcct,
                    quest === 'scorpion' ? shop.buys : [],
                ) +
                (quest === 'itgronigen' && eastOfPass(here(), sweepAcct) ? BOAT_FARES : 0);
            if (shop.coins) {
                const plannedCoins = p.withdraw.find((w) => w.id === COINS)?.count ?? 0;
                const take = shopCoinTake(shop.coins, countItems(pack(), COINS), plannedCoins, need.get(COINS) ?? 0);
                if (countItems(rows(), COINS) < take + plannedCoins) {
                    await s.bot.closeBank();
                    return fail(
                        `missing ${COINS}:${take} to buy ${[...shop.buys.map((b) => b.id), ...(heckelDust ? [1975] : [])].join(',')}` +
                            (shop.buys.some((b) => wornKit.wear.some((i) => i.required && i.id === b.id)) ? ' (required worn kit unavailable)' : ''),
                    );
                }
                if (take > 0) {
                    const c = p.withdraw.find((w) => w.id === COINS);
                    if (c) c.count += take;
                    else p.withdraw.push({ id: COINS, count: take });
                }
                console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({ buys: shop.buys, coins: shop.coins })}`);
            }
            const tele = await planTeleportRunes(world, here(), preset.position as Tile, sweepAcct, rows(), (id) => catalogItem(id)?.debugname, itemIdOf);
            for (const r of tele) {
                const have = countItems(pack(), r.id) + (p.withdraw.find((w) => w.id === r.id)?.count ?? 0);
                const want = r.count - have;
                if (want <= 0 || countItems(rows(), r.id) < want) continue;
                const w = p.withdraw.find((x) => x.id === r.id);
                if (w) w.count += want;
                else p.withdraw.push({ id: r.id, count: want });
            }
            if (tele.length) console.log(`QUEST_SWEEP_TELE_RUNES ${JSON.stringify({ to: preset.position, runes: tele })}`);
            const tradeable = (id: number) => (catalogItem(id) as { tradeable?: boolean } | undefined)?.tradeable;
            const keep = (id: number) => need.has(id) || toolIds.has(id) || keepsItem(quest, id, tradeable);
            const journal = questFlags(s.client)?.find((f) => f.name === QUEST_NAMES[quest])?.state;
            const leftover = (id: number) => journal === 'not started' && !need.has(id) && !toolIds.has(id) && !(QUEST_KEEP[quest] ?? []).includes(id) && tradeable(id) === false;
            const slots = slotNeed(
                slotsFor(
                    [
                        ...p.withdraw,
                        ...shop.buys.map((b) => ({ id: b.id, count: b.count })),
                        ...gather.gathers.map((g) => ({ id: g.id, count: g.count })),
                        ...(manorFood ? [{ id: MANOR_FOOD.id, count: 1 }] : []),
                        ...(manorPoison ? [{ id: MANOR_POISON.id, count: 1 }] : []),
                        ...(heckelDust ? [{ id: 1975, count: 1 }] : []),
                        ...(QUEST_PICKUPS[quest] ?? []),
                        ...(training?.pickups ?? []),
                    ],
                    pack(),
                ),
                staysCount(pack(), (id) => keep(id) && !leftover(id)),
            );
            for (const d of depositPlan(pack(), slots, keep, leftover)) {
                const item = (st()?.inventory ?? []).find((i: any) => i.id === d.id);
                if (!item) continue;
                const r: any = await s.bot.depositItem(item, d.count);
                console.log(`QUEST_SWEEP_DEPOSIT ${JSON.stringify({ id: d.id, count: d.count, success: r?.success, message: r?.message, free: 28 - (st()?.inventory?.length ?? 0) })}`);
            }
            console.log(`QUEST_SWEEP_BANK_PASS ${JSON.stringify({ withdraw: p.withdraw, slots, free: 28 - pack().length })}`);
            const inputs = [
                ...p.withdraw,
                ...shop.buys,
                ...gather.gathers.filter((g) => g.how !== 'milk'),
                ...(manorFood ? [{ id: MANOR_FOOD.id, count: 1 }] : []),
                ...(manorPoison ? [{ id: MANOR_POISON.id, count: 1 }] : []),
                ...(heckelDust ? [{ id: 1975, count: 1 }] : []),
            ];
            const capacity = await reserveInputSlots(
                s,
                inputs,
                new Set([...need.keys(), ...toolIds, ...inputs.map((i) => i.id), ...pack().map((i) => i.id).filter((id) => keep(id) || STACKS.has(id))]),
            );
            if (capacity) {
                await s.bot.closeBank();
                return fail(capacity);
            }
            for (const w of p.withdraw) {
                const row = (st()?.bank?.items ?? []).find((i: any) => i.id === w.id);
                const before = countItems(pack(), w.id);
                const bankBefore = countItems(rows(), w.id);
                if (!row) return fail(`bank row ${w.id} vanished`);
                await s.bot.withdrawItem(row, w.count);
                const observed = await waitUntil(s, () => countItems(pack(), w.id) === before + w.count && countItems(rows(), w.id) === bankBefore - w.count, {
                    timeoutTicks: 10,
                });
                console.log(`QUEST_SWEEP_WITHDRAW ${JSON.stringify({ id: w.id, count: w.count, before, after: countItems(pack(), w.id), bankBefore, bankAfter: countItems(rows(), w.id), observed })}`);
                if (!observed) return fail(`withdraw debit unobserved ${w.id}:${w.count}`);
            }
            await s.bot.closeBank();
            console.log(`QUEST_SWEEP_BANK_DONE ${JSON.stringify({ at: here(), buys: shop.buys.map((b) => b.id), gathers: gather.gathers.map((g) => g.id) })}`);
            if (shop.buys.length) {
                const why = await buyFromShops(s, world, shop.buys, quest === 'scorpion');
                if (why) return fail(why);
            }
            if (heckelDust) {
                const dust = await fetchHeckelDust(heckelIO(s, world));
                if (!dust.ok) return fail(dust.detail!);
            }
            if (manorFood || manorPoison) {
                const food = await fetchManorFishFood(manorIO(s, world), preset.position, { food: manorFood, poison: manorPoison });
                if (!food.ok) return fail(food.detail!);
            }
            if (gather.gathers.length) {
                const why = await gatherItems(s, world, gather.gathers, (to) => walkFar(s, world, to, 100));
                if (why) return fail(why);
            }
            if (training) {
                const why = await trainFishing(s, world, training.level);
                if (why) return fail(why);
            }
            const left = plan(need, pack(), []).missing;
            if (left.length) return fail('withdraw short ' + left.map((i) => `${i.id}:${i.count}`).join(','));
        }
        const worn = await wearQuestKit(s, wornKit.wear);
        if (worn) return fail(worn);
        if (retained()) return await returnSkull();
        const start = preset.position;
        const exit = await leaveStronghold(s);
        if (!exit.ok) return fail(exit.detail!);
        const unprayed = await prayBefore(s, world, quest);
        if (unprayed) return fail(unprayed);
        const travelCoins = countItems(pack(), COINS);
        const travelFrom = here();
        await reachStart(s, world, start, quest);
        if (quest === 'scorpion') {
            console.log(`QUEST_SWEEP_TRAVEL_COST ${JSON.stringify({ phase: 'start', coinsBefore: travelCoins, coins: countItems(pack(), COINS), from: travelFrom, at: here(), observed: true })}`);
        }
        if (wornKit.wear.some((i) => !s.sdk.getEquipment().some((e) => e.id === i.id && e.count > 0))) {
            return fail('worn kit missing before handover');
        }
        console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
        observeQuestFlags(s);
        sustain.stop();
        handed = true;
        (s as { questReserved?: Record<number, number> }).questReserved = reservedEdible(need);
        await handOver(s, script, fresh);
    } catch (error) {
        if (handed) throw error;
        return fail(String(error));
    }
}

export function registerQuestSweepExecutor() {
    registerQuestRuntime({ sweep });
}
registerQuestSweepExecutor();
export { finishHooks };
