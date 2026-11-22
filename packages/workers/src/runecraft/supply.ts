// Fresh-account Runecraft supply chain (starter exit, chicken food, Rune Mysteries, essence mining, air crafting).
import { existsSync } from 'node:fs';
import { accountOf as defaultAccountOf, getWorld as defaultGetWorld, sessionDied } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { questFlags, type QuestFlag } from '../../../core/src/quest-status';
import { startQuestSustain } from '../../../core/src/sustain';
import { waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath, type PathPoint } from '../../../core/src/walk';
import { StarterCookingUnresolved, cookStarterChickens, starterCookingStock } from '../gather/fishing';
import { runEssenceGatherer } from '../gather/mining';
import { LUMBRIDGE_TO_DRAYNOR, leaveRuneStarter as defaultLeaveRuneStarter, runeSupplyAssets } from '../logistics';
import { insideAirAltar } from './altars';
import { craftAirRunes, enterAirAltar, exitAirAltar } from './air';
import type { RunecraftExternalDeps } from './types';

export { runeSupplyAssets };
export const leaveRuneStarter = defaultLeaveRuneStarter;

const DRAYNOR_CHICKEN_ROUTE: readonly PathPoint[] = [
    { x: 3092, z: 3243, tol: 2 },
    { x: 3092, z: 3250, tol: 0 },
    { x: 3089, z: 3266, tol: 0 },
    { x: 3088, z: 3285, tol: 0 },
    { x: 3089, z: 3320, tol: 1 },
    { x: 3180, z: 3320, tol: 0 },
    { x: 3200, z: 3310, tol: 0 },
    { x: 3230, z: 3298, tol: 0 },
];

const VARROCK_CHICKEN_ROUTE: readonly PathPoint[] = [
    { x: 3253, z: 3420, tol: 2 },
    { x: 3207, z: 3429, tol: 0 },
    { x: 3171, z: 3427, tol: 0 },
    { x: 3200, z: 3384, tol: 0 },
    { x: 3198, z: 3370, tol: 0 },
    { x: 3200, z: 3348, tol: 0 },
    { x: 3200, z: 3310, tol: 0 },
    { x: 3230, z: 3298, tol: 0 },
];

export function runeMysteriesDecision(state: QuestFlag['state'], items: readonly number[]) {
    if (state === 'complete') return 'complete';
    if (state === 'unknown') return 'observe';
    if (state === 'not started') return 'duke';
    if (items.includes(291)) return 'notes';
    if (items.includes(290)) return 'package';
    if (items.includes(1438)) return 'talisman';
    return 'sedridor';
}

export type SedridorOutcome = 'package' | 'duke' | 'aubury' | 'bank' | 'unknown';

export function sedridorOutcome(hasPackage: boolean, sawText: (re: RegExp) => boolean): SedridorOutcome {
    if (hasPackage) return 'package';
    if (sawText(/speak to him again|speak to aubury once more/i)) return 'aubury';
    if (sawText(/come back again when you have found it/i)) return 'duke';
    if (sawText(/get them from the bank/i)) return 'bank';
    return 'unknown';
}

export const RUNE_MYSTERIES_ITEMS = [1438, 290, 291];

export function nearestBankTile<B extends { x: number; z: number; level: number }>(at: { x: number; z: number }, banks: readonly B[]): B {
    const ground = banks.filter(b => b.level === 0);
    if (!ground.length) throw Error('no ground-floor bank known');
    return ground.reduce((best, b) =>
        Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)) < Math.max(Math.abs(best.x - at.x), Math.abs(best.z - at.z)) ? b : best,
    );
}

export function runeMysteriesStartProblem(_combat: number | undefined): string | null {
    return null;
}

export function runeMysteriesWalk(from: { worldX: number; worldZ: number; level: number } | null | undefined, to: PathPoint): PathPoint[] {
    if (!from) throw Error('Rune Mysteries prerequisite: position unknown');
    if (from.level !== 0 || from.worldZ > 4000) throw Error('Rune Mysteries prerequisite: known surface start required');
    const draynor = DRAYNOR_CHICKEN_ROUTE;
    const varrock = VARROCK_CHICKEN_ROUTE;
    if (to.x === 3109 && to.z === 3167) {
        const approach = from.worldX >= 3200 ? LUMBRIDGE_TO_DRAYNOR.map(([x, z]) => ({ x, z, tol: 0 })) : [];
        const north = approach.length || from.worldZ >= 3230 ? [{ x: 3096, z: 3230, tol: 0 }] : [];
        return [...approach, ...north, { x: 3097, z: 3212, tol: 0 }, to];
    }
    const lumbridge = to.x >= 3200 && to.z < 3300;
    if (lumbridge && from.worldZ >= 3330) return [...varrock, { x: 3226, z: 3250, tol: 0 }, to];
    if (lumbridge && from.worldX < 3150 && from.worldZ >= 3200) return [...draynor.slice(1), { x: 3226, z: 3250, tol: 0 }, to];
    if (to.z >= 3380 && from.worldZ < 3330) {
        const tower = from.worldX < 3150 && from.worldZ < 3212
            ? [{ x: 3097, z: 3212, tol: 0 }, { x: 3096, z: 3230, tol: 0 }, { x: 3092, z: 3243, tol: 0 }]
            : [];
        return [...tower, ...(from.worldX < 3150 ? draynor.slice(1) : varrock.slice(-1)), ...varrock.slice(1, -1).reverse(), to];
    }
    return [to];
}

export async function walkRuneMysteries(
    from: Parameters<typeof runeMysteriesWalk>[0] & { combatLevel?: number },
    to: PathPoint,
    step: (point: PathPoint) => Promise<unknown>,
): Promise<void> {
    if ((from?.combatLevel ?? 0) < 13) { await step(to); return; }
    for (const point of runeMysteriesWalk(from, to)) await step(point);
}

export function runeSupplyTarget(value = 20): number {
    if (!Number.isSafeInteger(value) || value < 2 || value > 99) throw Error('Runecraft target must be2..99');
    return value;
}

const FOOD = [315, 2309, 2140];
const DRAYNOR: PathPoint = { x: 3092, z: 3243, tol: 2 };
const BANK: PathPoint = { x: 3253, z: 3420, tol: 2 };
const WEST: PathPoint[] = [
    { x: 3092, z: 3250, tol: 1 },
    { x: 3089, z: 3266, tol: 1 },
    { x: 3070, z: 3290, tol: 1 },
    { x: 3020, z: 3300, tol: 1 },
    { x: 2986, z: 3294, tol: 1 },
];
const VARROCK_TO_DRAYNOR: PathPoint[] = [...VARROCK_CHICKEN_ROUTE, ...DRAYNOR_CHICKEN_ROUTE.slice(0, -1).reverse()];
const DRAYNOR_TO_VARROCK: PathPoint[] = [...DRAYNOR_CHICKEN_ROUTE, ...VARROCK_CHICKEN_ROUTE.slice(0, -1).reverse()];

export function runeSupplyPreserved(before: Record<number, number>, after: Record<number, number>): boolean {
    const converted = new Set([...FOOD, 2138, 2144, 290, 291, 1436]);
    return Object.entries(before).every(([id, n]) => converted.has(Number(id)) || (after[Number(id)] ?? 0) >= n);
}

export async function runRuneSupply(
    s: Session,
    target = 20,
    options: { cap?: number; stop?: () => boolean; deps?: RunecraftExternalDeps } = {},
) {
    runeSupplyTarget(target);
    const cap = options.cap ?? 30000;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid rune supply tick cap');
    const deps = options.deps ?? {};
    const leaveStarterFn = deps.leaveRuneStarter ?? defaultLeaveRuneStarter;
    const getWorldFn = deps.getWorld ?? defaultGetWorld;
    const accountOfFn = deps.accountOf ?? defaultAccountOf;
    const start = s.tick(), state = () => s.sdk.getState(), pos = () => state()?.player, initialLife = pos();
    let ended = false, stage = 'entry';
    void s.ended.then(() => { ended = true; });
    let stoppedFor: string | undefined;
    const stopReason = () => stoppedFor ??= sessionDied(initialLife, pos())
        ? 'died'
        : ended
            ? 'session-ended'
            : options.stop?.()
                ? 'operator'
                : existsSync(`.practice/stop-${s.name}`)
                    ? 'stop-file'
                    : s.tick() - start >= cap
                        ? 'tick-cap'
                        : undefined;
    const stop = () => stopReason() !== undefined;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = (name: string) => s.sdk.getSkillXp(name) ?? 0;
    const level = () => s.sdk.getSkill('Runecraft')?.baseLevel ?? 0;
    const quest = () => questFlags(s.client)?.find(f => f.name === 'Rune Mysteries Quest')?.state ?? 'unknown';
    const stages: Record<string, unknown> = {}, xp0 = { mining: xp('Mining'), runecraft: xp('Runecraft') };
    let before: Record<number, number> | undefined;
    let mined = 0, consumed = 0, crafted = 0, banked = 0, inheritedBanked = 0, newBanked = 0, travelFoodEaten = 0;
    let inheritedRemaining = count(556), unbankedCrafted = 0;
    const snapshot = () => ({ position: pos(), skills: state()?.skills, inventory: inv(), equipment: s.sdk.getEquipment(), bank: s.bankObservation?.()?.items, quest: quest() });
    const action = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const began = s.tick();
        const record = (phase: string) => console.log('RUNE_SUPPLY_ACTION ' + JSON.stringify({
            at: Date.now(),
            tick: s.tick(),
            stage,
            action: name,
            phase,
            elapsedTicks: s.tick() - began,
            position: pos() ? { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } : null,
            hp: s.sdk.getSkill('Hitpoints')?.level,
            lifeId: pos()?.lifeId,
            respawnCount: pos()?.respawnCount,
            quest: quest(),
            essence: count(1436),
            air: count(556),
            bankEssence: bankCount(1436),
            bankAir: bankCount(556),
            generation: s.bankObservation?.()?.generation,
            runecraftXp: xp('Runecraft'),
            miningXp: xp('Mining'),
        }));
        record('start');
        let last = began;
        const off = s.onTick(() => { if (s.tick() - last >= 25) { last = s.tick(); record('pending'); } });
        try {
            const result = await work();
            record('end');
            return result;
        } catch (error) {
            record('error');
            throw error;
        } finally {
            off();
        }
    };
    const check = () => {
        if (stop()) throw Error(`rune supply stopped at ${stage}; preserve observed state and resume after the stop cause changes`);
        if ((s.sdk.getSkill('Hitpoints')?.level ?? 0) < 1) throw Error('rune supply life unavailable');
    };
    const walk = async (points: PathPoint[]) => {
        check();
        const sustain = startQuestSustain(
            {
                sdk: s.sdk,
                tick: () => s.tick(),
                onTick: cb => s.onTick(cb),
                ended: s.ended,
                direct: async act => (await s.direct(act)) as { success: boolean; message?: string },
            },
            { food: FOOD, eatAt: 8, onConsumed: () => { travelFoodEaten++; } },
        );
        let r;
        try {
            r = await action(
                'walk:' + points.map(p => p.x + ',' + p.z).join('>'),
                async () => walkPath(await sessionWalker(s), points, {
                    maxTicks: Math.min(1000, cap - (s.tick() - start)),
                    stop: () => stop() || !!sustain.failure() || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < 5,
                }),
            );
        } finally {
            await sustain.settle();
        }
        if (!r.ok || sustain.failure()) throw Error(`route refusal ${stage}: ${r.detail}`);
        check();
    };
    const open = async () => {
        check();
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!(await action('open-bank', () => s.bot.openBank())).success
            || !await action('bank-observation', () => waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 }))) {
            throw Error(`bank observation unavailable at ${stage}`);
        }
    };
    const withdraw = async (id: number, n: number) => {
        const need = n - count(id);
        if (need <= 0) return;
        const item = state()?.bank.items.find(i => i.id === id), stored = bankCount(id), held = count(id), generation = s.bankObservation?.()?.generation ?? 0;
        if (!item || stored < need) throw Error(`next acquisition: owned item${id} needs${need}, bank has${stored}`);
        await action('withdraw:' + id + ':' + need, () => s.bot.withdrawItem(item, need));
        if (!await action('withdraw-observation:' + id, () => waitUntil(s, () => count(id) === held + need && bankCount(id) === stored - need && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 10 }))) {
            throw Error(`withdraw debit/credit unobserved item${id}`);
        }
    };
    const deposit = async (item: ReturnType<typeof inv>[number]) => {
        const n = await action('deposit:' + item.id, () => depositObserved(s, item));
        if (item.id === 556) {
            const inherited = Math.min(inheritedRemaining, n), produced = Math.min(unbankedCrafted, n - inherited);
            inheritedRemaining -= inherited;
            unbankedCrafted -= produced;
            inheritedBanked += inherited;
            newBanked += produced;
            banked += inherited + produced;
        }
        return n;
    };
    const secure = async (keep: readonly number[] = []) => {
        for (const item of [...inv()]) if (!keep.includes(item.id) && count(item.id)) await deposit(item);
    };
    const total = () => runeSupplyAssets([...inv(), ...s.sdk.getEquipment(), ...(s.bankObservation?.()?.items ?? [])]);
    const draynor = async () => {
        const p = pos();
        if (!p || p.level !== 0) throw Error('next acquisition: observed surface route to Draynor required');
        if (p.worldZ >= 3330) await walk(VARROCK_TO_DRAYNOR);
        else if (p.worldX >= 3110) await walk(LUMBRIDGE_TO_DRAYNOR.map(([x, z, tol]) => ({ x, z, tol })));
        else await walk([DRAYNOR]);
    };
    try {
        await leaveStarterFn(s, stop);
        check();
        if (!await waitUntil(s, () => quest() !== 'unknown' && level() > 0 && Array.isArray(state()?.inventory), { timeoutTicks: 30 })) {
            throw Error('entry inventory, skills or Rune Mysteries journal unobserved');
        }
        console.log('RUNE_SUPPLY_ENTRY ' + JSON.stringify(snapshot()));
        if (quest() !== 'complete') {
            if ((pos()?.combatLevel ?? 0) < 13 || (quest() === 'not started' && FOOD.reduce((n, id) => n + count(id), 0) < 3)) {
                stage = 'starter-training';
                await draynor();
                await open();
                before = total();
                await secure([1277, 1171]);
                for (const id of [1277, 1171]) if (![...inv(), ...s.sdk.getEquipment()].some(i => i.id === id && i.count > 0)) await withdraw(id, 1);
                if (bankCount(2138) > 0) await withdraw(2138, Math.min(10, bankCount(2138)));
                for (const id of FOOD) if (bankCount(id) > 0) await withdraw(id, Math.min(4, bankCount(id)));
                await action('close-bank', () => s.bot.closeBank());
                let r: { ok: boolean; [key: string]: unknown };
                if ((pos()?.combatLevel ?? 0) >= 13 && (count(2138) >= 10 || FOOD.reduce((n, id) => n + count(id), 0) >= 3)) {
                    r = { ok: true, resumed: true };
                } else {
                    if (!deps.trainChickens) throw Error('runecraft supply requires trainChickens dep for fresh starter combat training');
                    r = await deps.trainChickens(s, Math.min(6000, cap - (s.tick() - start)), 'draynor', 13, { rawChicken: 10, stop });
                }
                stages.training = r;
                if (!r.ok) throw Error('starter training failed ' + JSON.stringify(r));
                await open();
                await withdraw(2138, Math.min(10, count(2138) + bankCount(2138)));
                await action('close-bank', () => s.bot.closeBank());
                stage = 'bootstrap-food';
                if (count(2138) > 0) {
                    const initial = starterCookingStock(s);
                    let cooked = false, cookingFailure: unknown;
                    try {
                        stages.food = await cookStarterChickens(s, stop, { requiredFood: Math.max(0, 3 - count(315) - count(2309)) });
                        cooked = true;
                    } catch (error) {
                        cookingFailure = error;
                        throw error;
                    } finally {
                        if (!cooked) {
                            const after = starterCookingStock(s);
                            stages.food = {
                                ok: false,
                                raw: initial.raw,
                                consumed: initial.raw - after.raw,
                                cooked: after.cooked - initial.cooked,
                                burnt: after.burnt - initial.burnt,
                                xp: after.xp - initial.xp,
                                remainingRaw: after.raw,
                                ...(cookingFailure instanceof StarterCookingUnresolved ? { settlement: 'unresolved' } : {}),
                                acquisition: { itemId: 2138, minimum: Math.max(0, 3 - FOOD.reduce((n, id) => n + count(id), 0)) },
                            };
                        }
                    }
                }
                if (FOOD.reduce((n, id) => n + count(id), 0) < 3) throw Error('next acquisition: at least3 cooked starter foods for Rune Mysteries route');
            }
            if (!deps.runRuneMysteries) throw Error('runecraft supply requires runRuneMysteries dep when Rune Mysteries is incomplete');
            stage = 'quest';
            const child = await deps.runRuneMysteries(s, { cap: Math.min(6000, cap - (s.tick() - start)), stop, food: FOOD, eatAt: 8 });
            stages.quest = child;
            if (!child.ok || quest() !== 'complete') throw Error('quest stage incomplete ' + JSON.stringify(child));
        }
        if (quest() === 'complete' && (pos()?.worldZ ?? 0) > 9500 && (pos()?.worldX ?? 0) >= 3090 && (pos()?.worldX ?? 0) <= 3120) {
            if (!deps.runRuneMysteries) throw Error('runecraft supply requires runRuneMysteries dep to exit basement');
            stage = 'quest-exit-resume';
            const child = await deps.runRuneMysteries(s, { cap: 1000, stop, food: FOOD, eatAt: 8 });
            stages.questExit = child;
            if (!child.ok) throw Error('completed quest exit failed ' + JSON.stringify(child));
        }
        if (insideAirAltar(pos())) {
            stage = 'altar-resume';
            if (count(1436) > 0) {
                const r = await action('craft-air', () => craftAirRunes(s, stop));
                stages.resumedCraft = r;
                consumed += r.consumed;
                crafted += r.runes;
                unbankedCrafted += r.runes;
            }
            await action('exit-air', () => exitAirAltar(s, stop));
            await walk([...WEST].reverse());
            await walk(DRAYNOR_TO_VARROCK);
        } else if ((pos()?.worldZ ?? 0) < 4000) {
            if (pos()?.level !== 0) throw Error('next acquisition: leave current floor for Varrock East bank');
            if ((pos()?.worldZ ?? 0) < 3330) {
                await draynor();
                await walk(DRAYNOR_TO_VARROCK);
            } else {
                await walk([BANK]);
            }
        }
        stage = 'bank-entry';
        if ((pos()?.worldZ ?? 0) > 4000) {
            const r = await action('gather-resume', () => runEssenceGatherer(s, {
                cap: 1000,
                bankAt: 28,
                maxTrips: 1,
                stop,
                deps: {
                    leaveRuneStarter: leaveStarterFn,
                    walkFar: async (sess, world, to, legTimeoutTicks, opts) =>
                        goTo(sess, world as Parameters<typeof goTo>[1], to, accountOfFn(sess), { legTimeoutTicks, ...opts }),
                },
            }));
            stages.mineResume = r;
            mined += r.totalMined;
            if (!r.ok) throw Error(r.failure);
        }
        await open();
        before ??= total();
        const startBankAir = bankCount(556);
        await secure();
        await action('close-bank', () => s.bot.closeBank());
        let batches = 0;
        while (level() < target) {
            check();
            stage = 'mine';
            await open();
            const storedEssence = bankCount(1436);
            await action('close-bank', () => s.bot.closeBank());
            if (storedEssence === 0) {
                const r = await action('gather-one-trip', () => runEssenceGatherer(s, {
                    cap: Math.min(1800, cap - (s.tick() - start)),
                    bankAt: 28,
                    maxTrips: 1,
                    stop,
                    deps: {
                        leaveRuneStarter: leaveStarterFn,
                        walkFar: async (sess, world, to, legTimeoutTicks, opts) =>
                            goTo(sess, world as Parameters<typeof goTo>[1], to, accountOfFn(sess), { legTimeoutTicks, ...opts }),
                    },
                }));
                stages.mine = r;
                mined += r.totalMined;
                if (!r.ok || r.totalMined <= 0 || r.totalBanked <= 0) throw Error('next acquisition: Aubury essence batch failed ' + JSON.stringify(r));
            }
            stage = 'load';
            await open();
            await secure();
            await withdraw(1438, 1);
            const food = FOOD.find(id => bankCount(id) > 0);
            if (food !== undefined) await withdraw(food, Math.min(2, bankCount(food)));
            const available = Math.min(bankCount(1436), 28 - inv().length);
            if (available < 1) throw Error('next acquisition: free pack slots and mined rune essence1436');
            await withdraw(1436, available);
            await action('close-bank', () => s.bot.closeBank());
            stage = 'altar-outbound';
            await walk(VARROCK_TO_DRAYNOR);
            await walk(WEST);
            await action('enter-air', () => enterAirAltar(s));
            stage = 'craft';
            const r = await action('craft-air', () => craftAirRunes(s, stop));
            stages.craft = r;
            consumed += r.consumed;
            crafted += r.runes;
            unbankedCrafted += r.runes;
            stage = 'bank-output';
            await action('exit-air', () => exitAirAltar(s, stop));
            await walk([...WEST].reverse());
            await walk(DRAYNOR_TO_VARROCK);
            await open();
            const air = inv().find(i => i.id === 556);
            if (!air) throw Error('crafted air runes missing before deposit');
            await action('deposit-air', () => deposit(air));
            await secure();
            batches++;
            stages.batches = batches;
            console.log('RUNE_SUPPLY_PROGRESS ' + JSON.stringify({ at: new Date().toISOString(), target, level: level(), mined, consumed, crafted, banked, assets: total() }));
            await action('close-bank', () => s.bot.closeBank());
        }
        stage = 'final';
        await open();
        await secure();
        const after = total(), preserved = runeSupplyPreserved(before, after);
        const productive = consumed > 0 && crafted >= consumed && newBanked === crafted && bankCount(556) > startBankAir;
        const ok = level() >= target && quest() === 'complete' && preserved && !stop() && (productive || xp('Runecraft') === xp0.runecraft);
        const final = snapshot();
        await action('close-bank', () => s.bot.closeBank());
        return {
            ok,
            target,
            stage,
            stages,
            mined,
            consumed,
            crafted,
            banked,
            inheritedBanked,
            newBanked,
            preserved,
            before,
            after,
            travelFoodEaten,
            xp: { mining: xp('Mining') - xp0.mining, runecraft: xp('Runecraft') - xp0.runecraft },
            ticks: s.tick() - start,
            final,
        };
    } catch (error) {
        return {
            ok: false,
            target,
            stage,
            stages,
            mined,
            consumed,
            crafted,
            banked,
            inheritedBanked,
            newBanked,
            before,
            travelFoodEaten,
            stopReason: stopReason(),
            failure: String(error),
            ticks: s.tick() - start,
            final: snapshot(),
        };
    }
}
