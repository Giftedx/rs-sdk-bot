// Shilo Village Nature altar runecrafting trips and gate/cart transit.
import { validateBankRouteJob, type BankProfile, type BankRouteJob } from '../../../core/src/bank-trip';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { expandPath, sessionWalker, walkPath } from '../../../core/src/walk';
import { NATURE, insideNature } from './altars';
import { dispatchRuneEntry, runeBankBalanced, settleRuneEntryModal } from './bank-craft';
import type { NatureJob } from './types';

export type { NatureJob } from './types';

export function naturePlanComplete(from: { x: number; z: number }, to: { x: number; z: number }, corners: readonly { x: number; z: number }[]): boolean {
    const last = corners.at(-1) ?? from;
    return last.x === to.x && last.z === to.z;
}

export function natureRouteJob(j: NatureJob): BankRouteJob {
    const job: BankRouteJob = { ...j, family: 'nature-runecraft', recipe: 'nature', bank: NATURE.bank, site: NATURE.site };
    validateBankRouteJob(job);
    if (j.protectMelee !== undefined && typeof j.protectMelee !== 'boolean') throw Error('invalid Nature protection scope');
    if (!j.members || j.batch > 27 || j.target > 100000) throw Error('Nature requires member scope and batch1..27');
    return job;
}

export const NATURE_XP_CAP = 200_000_000;
export const NATURE_XP_RATE = 25;

export function natureXpReceipt(essence: number, xp: number, xpRate = NATURE_XP_RATE, initialXp = 0): boolean {
    return Number.isSafeInteger(essence)
        && essence >= 0
        && Number.isSafeInteger(xpRate)
        && xpRate >= 1
        && xpRate <= 1000
        && Number.isFinite(initialXp)
        && initialXp >= 0
        && initialXp <= NATURE_XP_CAP
        && Number.isFinite(xp)
        && xp >= 0
        && Math.abs(xp - Math.min(essence * 9 * xpRate, NATURE_XP_CAP - initialXp)) < 0.001;
}

export function natureReceipt(essence: number, runes: number, xp: number, level: number, xpRate = NATURE_XP_RATE, initialXp = 0): boolean {
    const multiplier = Math.floor(level / 91) + 1;
    return essence > 0 && Number.isSafeInteger(level) && level >= 44 && runes === essence * multiplier && natureXpReceipt(essence, xp, xpRate, initialXp);
}

const RUNE_MYSTERIES_RE = /^Rune Mysteries(?: Quest)?$/i;
const SHILO_VILLAGE_RE = /^Shilo Village$/i;

export function requireNatureEligibility(s: Session, j: NatureJob): void {
    natureRouteJob(j);
    const flags = questFlags(s.client);
    if (!flags?.some(q => RUNE_MYSTERIES_RE.test(q.name) && q.state === 'complete')
        || !flags.some(q => SHILO_VILLAGE_RE.test(q.name) && q.state === 'complete')) {
        throw Error('Nature requires observed completed Rune Mysteries and Shilo Village');
    }
    if ((s.sdk.getSkill('Runecraft')?.level ?? 0) < 44) throw Error('Nature requires Runecraft44');
    if ((s.client as { membersAccount?: number }).membersAccount !== 1) throw Error('Nature member connection unobserved');
    if (j.protectMelee && ((s.sdk.getSkill('Prayer')?.baseLevel ?? 0) < 43 || (s.sdk.getState()?.prayers.prayerPoints ?? 0) < 40)) {
        throw Error('Nature stockade protection level/point budget short');
    }
}

export function createShiloTransit(
    s: Session,
    j: { protectMelee?: boolean },
    alive: () => boolean,
    walkerFactory: typeof sessionWalker = sessionWalker,
) {
    const state = () => s.sdk.getState(), pos = () => state()?.player;
    let pending = false;

    const protect = async (on: boolean, stop: () => boolean) => {
        if (!j.protectMelee) return;
        if (stop() || (on && (state()?.prayers.prayerPoints ?? 0) < 10)) throw Error('Nature stockade protection budget lost');
        if (state()?.prayers.activePrayers[14] !== on) {
            if (!(await s.sdk.sendTogglePrayer(14)).success || !await waitUntil(s, () => stop() || state()?.prayers.activePrayers[14] === on, { timeoutTicks: 8 }) || stop() || state()?.prayers.activePrayers[14] !== on) {
                throw Error('Nature stockade protection unobserved');
            }
        }
    };

    const walkNative = async (goal: { x: number; z: number }, stop: () => boolean) => {
        if (stop() || !alive()) throw Error('Nature native walk stopped');
        const p = pos()!, from = { x: p.worldX, z: p.worldZ };
        if (from.x === goal.x && from.z === goal.z) return;
        const deps = await walkerFactory(s), plan = deps.plan, diagnostics = process.env.NATURE_WALK_DIAGNOSTICS === '1';
        const protectedNow = () => j.protectMelee === true && state()?.prayers?.activePrayers[14] === true && (state()?.prayers?.prayerPoints ?? 0) >= 10;
        const protectedWalk = protectedNow(), hunters = deps.hunters;
        if (protectedWalk && hunters) {
            deps.hunters = () => {
                const all = hunters();
                if (!protectedNow()) return all;
                return all.filter(h => {
                    const npcs = state()?.nearbyNpcs.filter(n => (n.tileX ?? n.x) === h.x && (n.tileZ ?? n.z) === h.z) ?? [];
                    return !npcs.length || !npcs.every(n => (n.id === 504 || n.id === 505) && h.x >= 2868 && h.x <= 2879 && h.z >= 2945 && h.z <= 2960);
                });
            };
        }
        const probes: { to: { x: number; z: number; level: number }; reachable: boolean | null }[] = [];
        if (diagnostics && deps.reach) {
            const reach = deps.reach;
            deps.reach = (to, opts) => {
                const reachable = reach(to, opts);
                probes.push({ to, reachable });
                if (probes.length > 32) probes.shift();
                return reachable;
            };
        }
        deps.plan = (level, at, to, avoid) => {
            const corners = plan(level, at, to, avoid);
            if (diagnostics && avoid?.length) console.log('NATURE_WALK ' + JSON.stringify({ tick: s.tick(), event: 'avoid-plan', from: at, to, avoid: avoid.length, corners }));
            if (!naturePlanComplete(at, to, corners)) throw Error('Nature native route stops short ' + JSON.stringify({ from: at, to, end: corners.at(-1) ?? at }));
            return corners;
        };
        const corners = deps.plan(0, from, goal), tiles = expandPath(from, corners);
        console.log('NATURE_ROUTE ' + JSON.stringify({ from, goal, corners, steps: tiles.length }));
        let lastMove = s.tick(), last = from, reported = false;
        const guarded = () => {
            const at = pos();
            if (at && (at.worldX !== last.x || at.worldZ !== last.z)) { last = { x: at.worldX, z: at.worldZ }; lastMove = s.tick(); reported = false; }
            if (diagnostics && !reported && s.tick() - lastMove >= 6) {
                reported = true;
                console.log('NATURE_WALK ' + JSON.stringify({ tick: s.tick(), event: 'still', at: last, goal, hunters: deps.hunters?.(), probes }));
            }
            return stop() || !alive() || (protectedWalk && !protectedNow()) || s.tick() - lastMove >= 12;
        };
        const result = await walkPath(deps, [{ ...goal, tol: 0 }], {
            maxTicks: Math.min(600, Math.max(30, tiles.length * 2 + 20)),
            immediateHunterDetours: true,
            stop: guarded,
            ...(diagnostics ? { log: (event: string) => console.log('NATURE_WALK ' + JSON.stringify({ tick: s.tick(), event })) } : {}),
        });
        if (!result.ok || stop() || !alive() || (protectedWalk && !protectedNow())) {
            throw Error('Nature native route ' + (s.tick() - lastMove >= 12 ? 'no observed movement for12ticks' : result.detail ?? 'protection/life guard changed'));
        }
        await waitTicks(s, 2);
    };

    const cross = async (loc: { id: number; x: number; z: number }, stand: { x: number; z: number }, land: { x: number; z: number }, stop: () => boolean) => {
        await walkNative(stand, stop);
        if (!await settleRuneEntryModal(s, stop)) throw Error('Nature gate modal closure failed');
        const target = state()?.nearbyLocs.find(l => l.id === loc.id && l.x === loc.x && l.z === loc.z && l.level === 0);
        const op = target?.optionsWithIndex.find(v => new RegExp(loc.id === 2216 ? '^Search$' : '^Open$', 'i').test(v.text));
        if (!target || !op || stop()) throw Error('Nature native Shilo transition unavailable ' + loc.id);
        pending = true;
        if (!(await s.sdk.sendInteractLoc(loc.x, loc.z, loc.id, op.opIndex)).success) throw Error('Nature native Shilo transition unavailable ' + loc.id);
        const landed = () => pos()?.worldX === land.x && pos()?.worldZ === land.z && pos()?.level === 0;
        for (let page = 0; page < 8 && !landed() && !stop(); page++) {
            await waitUntil(s, () => stop() || landed() || (!!state()?.dialog.isOpen && !state()?.dialog.isWaiting), { timeoutTicks: 12 });
            if (landed() || stop()) break;
            const dialog = state()?.dialog;
            if (dialog?.isOpen && !dialog.isWaiting) {
                const choice = dialog.options.find(v => /^Yes, I am very nimble and agile!$/i.test(v.text))
                    ?? (dialog.options.length === 1 && /continue/i.test(dialog.options[0]!.text) ? dialog.options[0] : undefined);
                if (loc.id !== 2216 || !choice) throw Error('Nature unmapped Shilo transit dialogue');
                const reply = await s.sdk.clickDialogByText(/^Yes, I am very nimble and agile!$/i.test(choice.text) ? /^Yes, I am very nimble and agile!$/i : /continue/i);
                if (!reply.success) throw Error('Nature cart dialogue refused ' + JSON.stringify(reply));
            }
            await waitTicks(s, 1);
        }
        if (stop() || !landed()) throw Error('Nature Shilo landing unobserved ' + loc.id);
        await waitTicks(s, 2);
        pending = false;
        console.log('NATURE_SHILO ' + JSON.stringify({ id: loc.id, land }));
    };

    const wood = { id: 2261, x: 2867, z: 2953 }, metal = { id: 2260, x: 2875, z: 2953 }, cart = { id: 2216, x: 2877, z: 2951 }, clear = { x: 2883, z: 2952 };

    const returnVillage = async (stop: () => boolean) => {
        const p = pos();
        if (!p || stop()) throw Error('Nature village return stopped');
        if (p.worldX >= 2880 || p.worldZ > 2960) { await walkNative(clear, stop); await protect(true, stop); await cross(cart, { x: 2880, z: 2952 }, { x: 2876, z: 2952 }, stop); }
        if (pos()!.worldX >= 2875) { await protect(true, stop); await cross(metal, { x: 2876, z: 2953 }, { x: 2874, z: 2953 }, stop); }
        if (pos()!.worldX >= 2868) await cross(wood, { x: 2868, z: 2953 }, { x: 2867, z: 2953 }, stop);
        await walkNative(NATURE.bank, stop);
        await protect(false, stop);
    };

    const outbound = async (stop: () => boolean) => {
        if (state()?.autoRetaliateEnabled !== false) {
            if (stop()) throw Error('Nature stopped before retaliation guard');
            await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Nature trip owned combat control' });
            if (!await waitUntil(s, () => stop() || state()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }) || stop() || state()?.autoRetaliateEnabled !== false) {
                throw Error('Nature retaliation guard unobserved');
            }
        }
        await protect(true, stop);
        await cross(wood, { x: 2866, z: 2953 }, { x: 2868, z: 2953 }, stop);
        await cross(metal, { x: 2874, z: 2953 }, { x: 2875, z: 2953 }, stop);
        await cross(cart, { x: 2876, z: 2952 }, { x: 2880, z: 2952 }, stop);
        await walkNative(clear, stop);
        await protect(false, stop);
    };

    return { protect, walkNative, cross, returnVillage, outbound, pending: () => pending };
}

export function natureProfile(s: Session, j: NatureJob): BankProfile {
    requireNatureEligibility(s, j);
    const state = () => s.sdk.getState(), pos = () => state()?.player, first = pos();
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const initialLife = first?.lifeId, initialRespawns = first?.respawnCount ?? 0;
    const alive = () => !ended && !!first && !!pos() && !pos()!.isDead && pos()!.lifeId === initialLife && (pos()!.respawnCount ?? 0) === initialRespawns && hp0 > 0 && (s.sdk.getSkill('Hitpoints')?.level ?? 0) >= hp0;
    const wholeStart = s.tick();
    let recoveryDeferred = false;
    const { walkNative, returnVillage, outbound } = createShiloTransit(s, j, alive);
    const cleanupStop = () => !alive() || s.tick() - wholeStart >= j.cap - 50;

    const prepare = async (stop: () => boolean) => {
        try {
            await outbound(stop);
            await walkNative(NATURE.site, stop);
        } catch (error) {
            if (alive()) {
                try {
                    await returnVillage(cleanupStop);
                } catch (recovery) {
                    recoveryDeferred = true;
                    throw Error(String(error) + '; Shilo recovery ' + String(recovery));
                }
            }
            throw error;
        }
    };

    const approach = async (loc: { id: number; x: number; z: number; angle: number }, stop: () => boolean) => {
        if (stop()) throw Error('Nature stopped before approach');
        const observed = state()?.nearbyLocs.find(l => l.id === loc.id && l.x === loc.x && l.z === loc.z && l.level === 0);
        const c = s.client as any, scene = c.toSceneTile(loc.x, loc.z), info = scene && c.locSceneInfo(scene.x, scene.z, loc.id);
        if (!observed || !scene || info?.shape !== 10 || info.angle !== loc.angle) throw Error('Nature exact native footprint unobserved');
        c.ensureCollision();
        const map = c.collision[c.minusedlevel], size = loc.id === 2473 ? 1 : 3;
        const reached = (p: { x: number; z: number }) => map.testLoc(p.x - c.mapBuildBaseX, p.z - c.mapBuildBaseZ, scene.x, scene.z, size, size, 0);
        const p = pos()!;
        if (reached({ x: p.worldX, z: p.worldZ })) return observed;
        const faces: { x: number; z: number }[] = [];
        for (let i = 0; i < size; i++) {
            faces.push({ x: loc.x - 1, z: loc.z + i }, { x: loc.x + size, z: loc.z + i }, { x: loc.x + i, z: loc.z - 1 }, { x: loc.x + i, z: loc.z + size });
        }
        faces.sort((a, b) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ)) - Math.max(Math.abs(b.x - p.worldX), Math.abs(b.z - p.worldZ)));
        for (const face of faces) {
            if (stop()) throw Error('Nature stopped during approach');
            if (!reached(face)) continue;
            const deps = await sessionWalker(s), corners = deps.plan(0, { x: p.worldX, z: p.worldZ }, face);
            if (!naturePlanComplete({ x: p.worldX, z: p.worldZ }, face, corners)) continue;
            await walkNative(face, stop);
            if (stop() || !reached({ x: pos()!.worldX, z: pos()!.worldZ })) throw Error('Nature native footprint reach changed');
            return observed;
        }
        throw Error('Nature loaded footprint has no reachable face');
    };

    return {
        bank: NATURE.bank,
        site: NATURE.site,
        inputs: { 1436: 1 },
        tools: [1462],
        outputs: [561],
        capacityOutputs: { 561: 2 },
        prepare,
        deferBankRecovery: () => recoveryDeferred,
        run: async (n, cap, halt) => {
            const start = s.tick();
            const over = () => !alive() || halt() || s.tick() - start >= cap - 60 || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0;
            let failure = '', entryDispatched = false;
            const before = { essence: count(1436), runes: count(561), xp: s.sdk.getSkillXp('Runecraft') ?? NaN, level: s.sdk.getSkill('Runecraft')?.level ?? 0 };
            try {
                if (cap <= 60 || before.essence !== n || count(1462) !== 1) throw Error('Nature finite supplies/budget mismatch');
                if (!natureXpReceipt(0, 0, j.xpRate ?? NATURE_XP_RATE, before.xp)) throw Error('Nature pre-craft XP unavailable');
                if (!await settleRuneEntryModal(s, over)) throw Error('Nature entry modal closure failed');
                await approach(NATURE.ruins, over);
                const entry = await dispatchRuneEntry(s, {
                    stop: over,
                    entered: () => insideNature(pos()),
                    attempts: 1,
                    timeoutTicks: 20,
                    dispatch: async () => {
                        if (over()) return { success: false };
                        const talisman = s.sdk.getInventory().find(i => i.id === 1462);
                        if (!talisman) return { success: false };
                        entryDispatched = true;
                        return s.sdk.sendUseItemOnLoc(talisman.slot, NATURE.ruins.x, NATURE.ruins.z, NATURE.ruins.id);
                    },
                });
                if (!entry.entered) throw Error('Nature entry ' + entry.failure);
                await waitTicks(s, 2);
                await approach(NATURE.altar, over);
                if (over()) throw Error('Nature stopped before craft');
                const loc = state()!.nearbyLocs.find(l => l.id === 2486 && l.x === 2399 && l.z === 4840)!;
                const option = loc.optionsWithIndex.find(v => /^Craft-rune$/i.test(v.text));
                if (!option || (await s.sdk.sendInteractLoc(loc.x, loc.z, loc.id, option.opIndex)).success !== true) throw Error('Nature craft refused');
                if (!await waitUntil(s, () => !alive() || (count(1436) === 0 && count(561) > before.runes), { timeoutTicks: 15 }) || !alive()) {
                    throw Error('Nature craft unpublished');
                }
                const made = count(561) - before.runes;
                if (!natureReceipt(before.essence - count(1436), made, (s.sdk.getSkillXp('Runecraft') ?? NaN) - before.xp, before.level, j.xpRate ?? NATURE_XP_RATE, before.xp)) {
                    throw Error('Nature exact essence/rune/XP receipt failed');
                }
            } catch (error) {
                failure = String(error);
            } finally {
                if (entryDispatched && alive() && !insideNature(pos())) await waitUntil(s, () => !alive() || insideNature(pos()), { timeoutTicks: 8 });
                if (insideNature(pos()) && alive()) {
                    try {
                        const deadline = s.tick() + 60, exitStop = () => !alive() || s.tick() >= deadline;
                        if (!await settleRuneEntryModal(s, exitStop)) throw Error('Nature exit modal closure failed');
                        await approach(NATURE.portal, exitStop);
                        const loc = state()?.nearbyLocs.find(l => l.id === 2473 && l.x === 2400 && l.z === 4834);
                        const op = loc?.optionsWithIndex.find(v => /^Use$/i.test(v.text));
                        if (!loc || !op || exitStop() || !(await s.sdk.sendInteractLoc(loc.x, loc.z, loc.id, op.opIndex)).success || !await waitUntil(s, () => !alive() || !insideNature(pos()), { timeoutTicks: 15 }) || !alive() || Math.max(Math.abs(pos()!.worldX - 2865), Math.abs(pos()!.worldZ - 3022)) > 2) {
                            throw Error('Nature portal landing unobserved');
                        }
                    } catch (error) {
                        recoveryDeferred = true;
                        failure += '; exit ' + String(error);
                    }
                }
                if (!insideNature(pos()) && alive()) {
                    try {
                        await returnVillage(cleanupStop);
                    } catch (error) {
                        recoveryDeferred = true;
                        failure += '; Shilo return ' + String(error);
                    }
                }
            }
            if (failure) throw Error(failure);
            if (insideNature(pos()) || !alive()) throw Error('Nature finite exit absent');
            return n;
        },
    };
}

export type NatureBankRunner = (
    s: Session,
    j: BankRouteJob,
    p: BankProfile,
    stop?: () => boolean,
) => Promise<{ ok: boolean; completed: number; banked: Record<number, number>; atBank: boolean; [key: string]: unknown }>;

export async function runNatureTrips(
    s: Session,
    j: NatureJob,
    stop: () => boolean = () => false,
    bankRunner?: NatureBankRunner,
) {
    if (!bankRunner) throw Error('Nature trips require a bankRunner implementation');
    const p = natureProfile(s, j), first = s.sdk.getState()?.player, start = s.tick();
    const life = first?.lifeId, respawns = first?.respawnCount ?? 0, hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const retaliate = s.sdk.getState()?.autoRetaliateEnabled, prayer = j.protectMelee ? s.sdk.getState()?.prayers.activePrayers[14] : undefined;
    if (typeof retaliate !== 'boolean') throw Error('Nature initial retaliation unknown');
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const original = () => {
        const v = s.sdk.getState()?.player;
        return !ended && !!v && !v.isDead && v.lifeId === life && (v.respawnCount ?? 0) === respawns && (s.sdk.getSkill('Hitpoints')?.level ?? 0) >= hp && hp > 0;
    };
    const atBank = () => {
        const v = s.sdk.getState()?.player;
        return original() && !!v && v.level === 0 && Math.max(Math.abs(v.worldX - NATURE.bank.x), Math.abs(v.worldZ - NATURE.bank.z)) <= 3;
    };
    if (!atBank()) throw Error('Nature starts at owned Shilo bank');
    if (stop()) throw Error('Nature stopped before bank observation');
    if (j.cap - j.returnTicks <= 40) throw Error('Nature needs forty audit ticks beyond return reserve');
    const open = async () => {
        if (!atBank() || s.tick() - start >= j.cap - 20) throw Error('Nature bank audit life/location/budget unavailable');
        const generation = s.bankObservation?.()?.generation ?? -1;
        await s.sdk.sendCloseModal();
        if (!atBank() || !(await s.bot.openBank()).success || !await waitUntil(s, () => !original() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 12 }) || !atBank() || !s.sdk.getState()?.bank.isOpen || !s.bankObservation?.()) {
            throw Error('Nature fresh bank unavailable');
        }
    };
    const snapshot = () => {
        const bank = s.bankObservation?.();
        if (!bank || !s.sdk.getState()?.bank.isOpen || !atBank()) throw Error('Nature current bank receipt unavailable');
        const m = new Map<number, number>();
        for (const i of [...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...bank.items]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
function sameEquipmentSnapshot(
    a: readonly { id: number; count: number; slot?: number }[],
    b: readonly { id: number; count: number; slot?: number }[],
): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!, y = b[i]!;
        if (x.id !== y.id || x.count !== y.count || x.slot !== y.slot) return false;
    }
    return true;
}

function sameNonRuneAssets(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>): boolean {
    for (const [id, n] of before) {
        if (id !== 1436 && id !== 561 && (after.get(id) ?? 0) !== n) return false;
    }
    for (const [id, n] of after) {
        if (id !== 1436 && id !== 561 && (before.get(id) ?? 0) !== n) return false;
    }
    return true;
}

    await open();
    const before = snapshot(), gear = s.sdk.getEquipment().map(e => ({ id: e.id, count: e.count, slot: e.slot })), xp = s.sdk.getSkillXp('Runecraft') ?? NaN, remaining = j.cap - (s.tick() - start) - 40;
    if (remaining <= j.returnTicks) throw Error('Nature production budget exhausted before withdrawals');
    if (!natureXpReceipt(0, 0, j.xpRate ?? NATURE_XP_RATE, xp)) throw Error('Nature initial Runecraft XP unavailable');
    const result = await bankRunner(s, { ...natureRouteJob(j), cap: remaining }, p, stop);
    let after: Map<number, number> | undefined, auditFailure = '';
    let retaliateRestored = s.sdk.getState()?.autoRetaliateEnabled === retaliate;
    let prayerRestored = !j.protectMelee || s.sdk.getState()?.prayers.activePrayers[14] === prayer;
    try {
        if (!result.atBank || !atBank()) throw Error('Nature final bank/original life unobserved');
        await open();
        after = snapshot();
        if (j.protectMelee && s.sdk.getState()?.prayers.activePrayers[14] !== prayer) {
            await s.sdk.sendTogglePrayer(14);
            prayerRestored = (await waitUntil(s, () => !original() || s.sdk.getState()?.prayers.activePrayers[14] === prayer, { timeoutTicks: 8 })) && original() && s.sdk.getState()?.prayers.activePrayers[14] === prayer;
        } else {
            prayerRestored = true;
        }
        if (s.sdk.getState()?.autoRetaliateEnabled !== retaliate) {
            await s.direct({ type: 'clickComponent', componentId: retaliate ? 150 : 151, reason: 'restore Nature trip combat control at final bank' });
            retaliateRestored = (await waitUntil(s, () => !original() || s.sdk.getState()?.autoRetaliateEnabled === retaliate, { timeoutTicks: 8 })) && original() && s.sdk.getState()?.autoRetaliateEnabled === retaliate;
        } else {
            retaliateRestored = true;
        }
    } catch (error) {
        auditFailure = String(error);
    } finally {
        if (atBank() && s.sdk.getState()?.bank.isOpen) {
            try {
                await s.bot.closeBank();
                if (!await waitUntil(s, () => !original() || !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 }) || !original()) throw Error('Nature audit bank close unobserved');
            } catch (error) {
                auditFailure += '; ' + String(error);
            }
        }
    }
    const balanced = !!after && runeBankBalanced({
        essence0: before.get(1436) ?? 0,
        essence: after.get(1436) ?? 0,
        air0: before.get(561) ?? 0,
        air: after.get(561) ?? 0,
        consumed: result.completed,
        crafted: result.banked[561] ?? 0,
    });
    const preserved = !!after && original() && sameEquipmentSnapshot(gear, s.sdk.getEquipment())
        && sameNonRuneAssets(before, after);
    const runecraftXp = (s.sdk.getSkillXp('Runecraft') ?? NaN) - xp;
    const xpBalanced = natureXpReceipt(result.completed, runecraftXp, j.xpRate ?? NATURE_XP_RATE, xp);
    if (!xpBalanced) auditFailure += (auditFailure ? '; ' : '') + 'Nature whole-trip XP receipt failed';
    return {
        ...result,
        ok: result.ok && !auditFailure && balanced && preserved && xpBalanced && retaliateRestored && prayerRestored,
        balanced,
        preserved,
        xpBalanced,
        retaliateRestored,
        prayerRestored,
        auditFailure: auditFailure || '-',
        runecraftXp,
        ticks: s.tick() - start,
    };
}
