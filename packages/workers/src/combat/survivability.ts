import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { ClientProt } from '../../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import type { BotWorldState, GroundItem, NearbyNpc, NearbyPlayer } from '../../../../vendor/rs-sdk/sdk/types';
import type { Outcome } from '../../../core/src/act';
import {
    accountOf,
    getWorld,
    sessionDied,
    settle,
} from '../../../core/src/bot';
import {
    bankTravelTolerance,
    fittingBankBatch,
    planBankTripSchedule,
    validateBankRouteJob,
    type BankProfile,
    type BankRouteJob,
} from '../../../core/src/bank-trip';
import { combatEndText, finishCombat, leaveCombat, startEndEater, confirmedLogout } from '../../../core/src/combat-end';
import { equipmentObserved } from '../../../core/src/container-observation';
import { objId } from '../../../core/src/content-facts';
import { depositObserved, depositPack } from '../../../core/src/deposit';
import { loadOwners } from '../../../core/src/fleet';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { elementalRuneCost } from '../../../core/src/magic-data';
import {
    lootCapacity,
    lootListed,
    lootMatches,
    lootNameMatches,
    validLootFilters,
    type LootDefinition,
    type LootPolicy,
} from '../../../core/src/loot-policy';
import { potionCareRecipe } from '../../../core/src/native-potion';
import {
    COW_FOOD_ROOTS,
    cowFoodIds,
    defaultEatAt,
    foodStages,
    holdSessionEater,
    questFoodDefinitions,
    selectQuestFood,
    totalAvailableHeal,
} from '../../../core/src/sustain';
import { waitTicks, waitUntil, type TickSource } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { interactionApproach } from '../../../core/src/world';
import {
    approach as marketApproach,
    ferryWalk as marketFerryWalk,
    productionStopRequested,
    walkTargetPersist as marketWalkTargetPersist,
    watchProductionLife as marketWatchProductionLife,
} from '../market/walk';
import type { CombatSession, CombatTile } from './types';
import { bestElementalStaffForRunes, readSkillLevels } from './gear';
import { countPackItems } from './xp';

export {
    COW_FOOD_ROOTS,
    combatEndText,
    confirmedLogout,
    cowFoodIds,
    defaultEatAt,
    finishCombat,
    foodStages,
    holdSessionEater,
    leaveCombat,
    lootCapacity,
    potionCareRecipe,
    questFoodDefinitions,
    selectQuestFood,
    startEndEater,
    totalAvailableHeal,
    type LootDefinition,
    type LootPolicy,
};

const ROOT = resolve(import.meta.dir, '../../../..');
const CONTENT_SCRIPTS = resolve(ROOT, 'vendor/rs-sdk/server/content/scripts');

// Life and stop monitoring
function watchProductionLife(s: CombatSession, stop: () => boolean = () => false, options: { allowDamage?: boolean } = {}) {
    return marketWatchProductionLife(s as Session, stop, options);
}

// Cow food bite rules (Ardougne bakery / trout sustain)
export const COW_FOOD_BITES: Readonly<Record<number, number>> = Object.fromEntries(cowFoodIds().map(id => [id, foodStages(id).length]));
const COW_BITE_HEAL: Readonly<Record<number, number>> = Object.fromEntries(
    cowFoodIds().map(id => [id, questFoodDefinitions().get(id)!.heal]),
);
export const COW_FOOD_HP = 14;
export const cowFoodBites = (items: readonly { id: number; count: number }[]) =>
    items.reduce((n, i) => n + (COW_FOOD_BITES[i.id] ?? 0) * i.count, 0);
export const cowFoodHeal = (items: readonly { id: number; count: number }[]) =>
    items.reduce((n, i) => n + (COW_FOOD_BITES[i.id] ?? 0) * (COW_BITE_HEAL[i.id] ?? 0) * i.count, 0);
export const cowFoodPick = <T extends { id: number }>(items: readonly T[]): T | undefined => {
    let best: T | undefined;
    let bestBites = Infinity;
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const bites = COW_FOOD_BITES[item.id];
        if (bites && bites < bestBites) {
            best = item;
            bestBites = bites;
        }
    }
    return best;
};

// Food healing between casts / combat swings
export interface EatEffect {
    id: number;
    before: number;
    after: number;
    hpBefore: number;
    hpAfter: number;
    attempts: number;
}

export async function eatBetweenCasts(
    s: TickSource & { direct(action: { type: string; [k: string]: unknown }): Promise<unknown> },
    o: { food: readonly number[]; eatAt: number; timeoutTicks: number; attempts: number },
): Promise<EatEffect | null> {
    const count = (id: number) =>
        (s.sdk.getState()?.inventory ?? [])
            .filter((i: { id: number }) => i.id === id)
            .reduce((n: number, i: { count: number }) => n + i.count, 0);
    const hp = () => s.sdk.getState()?.skills?.find((k: { name: string }) => k.name === 'Hitpoints')?.level ?? 0;
    const modal = (st: any) => !!st?.dialog?.isOpen || !!st?.modalOpen;
    if (!selectQuestFood(s.sdk.getState(), { food: o.food, eatAt: o.eatAt })) return null;
    let last: { id: number; before: number } | undefined;
    for (let attempt = 1; attempt <= o.attempts; attempt++) {
        if (modal(s.sdk.getState())) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (!(await waitUntil(s, st => !modal(st), { timeoutTicks: o.timeoutTicks }))) continue;
        }
        const choice = selectQuestFood(s.sdk.getState(), { food: o.food, eatAt: o.eatAt });
        if (!choice) return null;
        const id = choice.item.id;
        const before = count(id);
        const hpBefore = hp();
        last = { id, before };
        const reply = (await s.direct({
            type: 'useInventoryItem',
            slot: choice.item.slot,
            optionIndex: choice.opIndex,
            reason: 'SDK',
        })) as { success?: boolean; message?: string } | undefined;
        if (reply && reply.success === false) throw Error(`eat refused: ${reply.message ?? 'unknown'}`);
        if (await waitUntil(s, () => count(id) !== before, { timeoutTicks: o.timeoutTicks })) {
            if (count(id) !== before - 1) throw Error(`food debit invalid: item${id} ${before}->${count(id)}`);
            return { id, before, after: count(id), hpBefore, hpAfter: hp(), attempts: attempt };
        }
    }
    throw Error(`food debit unobserved before the next cast: ${o.attempts} eats, item${last?.id ?? '?'} ${last?.before ?? '?'}->${last ? count(last.id) : '?'}`);
}

export function makeRangedHealer(s: CombatSession, consumed: () => void, foodId = 333) {
    if (![329, 333].includes(foodId)) throw Error('ranged prerequisite: unsupported food ID');
    const FOOD = foodId;
    let inFlight: Promise<void> | undefined;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const held = () => countPackItems(s.sdk.getInventory(), FOOD);
    return (): Promise<void> => {
        if (inFlight) return inFlight;
        if (hp() > 6) return Promise.resolve();
        inFlight = Promise.resolve()
            .then(async () => {
                const item = s.sdk.getInventory().find(i => i.id === FOOD);
                if (!item) {
                    if (hp() <= 3) throw Error('ranged food exhausted below retreat floor');
                    return;
                }
                const before = held();
                const beforeHp = hp();
                await s.bot.eatFood(item);
                if (!(await waitUntil(s, () => held() === before - 1 && hp() > beforeHp, { timeoutTicks: 8 }))) {
                    throw Error('ranged food debit/health unobserved');
                }
                consumed();
                console.log('RANGED_FOOD ' + JSON.stringify({ before, after: held(), beforeHp, afterHp: hp(), tick: s.tick() }));
            })
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };
}

// Potion care and combat potion scheduling
export type PotionCarePolicy = { id: number; below?: number; prayerPercent?: number; monitorStat?: string; prevent?: boolean; poisonMessage?: boolean };
export type PotionCareOrder = {
    policies: PotionCarePolicy[];
    maximumDoses: number;
    maximumVials: number;
    cap: number;
    monitor?: boolean;
    enabled?: boolean;
    vialsAfterDoseOnly?: boolean;
    inventoryFirst?: boolean;
};

export function validatePotionCare(o: PotionCareOrder) {
    if (
        !o
        || (o.monitor !== undefined && typeof o.monitor !== 'boolean')
        || (o.enabled !== undefined && typeof o.enabled !== 'boolean')
        || (o.vialsAfterDoseOnly !== undefined && typeof o.vialsAfterDoseOnly !== 'boolean')
        || (o.inventoryFirst !== undefined && typeof o.inventoryFirst !== 'boolean')
        || !Array.isArray(o.policies)
        || !o.policies.length
        || o.policies.length > 8
        || !Number.isSafeInteger(o.maximumDoses)
        || o.maximumDoses < 1
        || o.maximumDoses > 40
        || !Number.isSafeInteger(o.maximumVials)
        || o.maximumVials < 0
        || o.maximumVials > 28
        || !Number.isSafeInteger(o.cap)
        || o.cap < 1
        || o.cap > 1000
    ) {
        throw Error('invalid finite potion care order');
    }
    const recipes = o.policies.map(p => potionCareRecipe(p.id));
    if (new Set(recipes.map(r => r.kind)).size !== recipes.length) throw Error('duplicate potion policy family');
    o.policies.forEach((p, i) => {
        const r = recipes[i]!;
        if (r.effects.length) {
            if (p.prevent || p.poisonMessage) throw Error('stat potion needs explicit public threshold');
            if (p.prayerPercent !== undefined) {
                if (
                    p.below !== undefined
                    || !Number.isSafeInteger(p.prayerPercent)
                    || p.prayerPercent < 25
                    || p.prayerPercent > 30
                    || (p.monitorStat !== undefined && p.monitorStat !== 'Prayer')
                    || !r.effects.some(e => e.skill === 'Prayer')
                ) {
                    throw Error('Prayer percentage threshold requires native Prayer effect');
                }
            } else if (!Number.isSafeInteger(p.below) || p.below! < 1 || p.below! > 255) {
                throw Error('stat potion needs explicit public threshold');
            }
            if (
                (!r.skill && p.prayerPercent === undefined && (!p.monitorStat || !r.effects.some(e => e.skill === p.monitorStat)))
                || (r.skill && p.monitorStat !== undefined && p.monitorStat !== r.skill)
            ) {
                throw Error('restorative vector needs explicit affected monitorStat');
            }
        } else if (
            p.below !== undefined
            || p.prayerPercent !== undefined
            || p.monitorStat !== undefined
            || (!p.prevent && !p.poisonMessage)
            || (p.poisonMessage && r.kind !== 'antipoison')
            || (p.prevent && p.poisonMessage)
        ) {
            throw Error('anti potion needs declared prevention or fresh poison message');
        }
    });
    return recipes;
}

export function prayerPercentageNeeded(current: number, base: number, threshold: number): boolean {
    if (
        !Number.isSafeInteger(current)
        || current < 0
        || current > 255
        || !Number.isSafeInteger(base)
        || base < 1
        || base > 99
        || !Number.isSafeInteger(threshold)
        || threshold < 25
        || threshold > 30
    ) {
        throw Error('public Prayer percentage values unavailable');
    }
    return Math.floor((current * 100) / base) <= threshold;
}

const packCounts = (s: CombatSession) => {
    const n: Record<number, number> = {};
    for (const i of s.sdk.getInventory()) n[i.id] = (n[i.id] ?? 0) + i.count;
    return n;
};
const packDeltaMatches = (a: Record<number, number>, b: Record<number, number>, delta: Record<number, number>) => {
    for (const k in a) {
        const id = Number(k);
        if ((b[id] ?? 0) - (a[id] ?? 0) !== (delta[id] ?? 0)) return false;
    }
    for (const k in b) {
        if (k in a) continue;
        const id = Number(k);
        if ((b[id] ?? 0) !== (delta[id] ?? 0)) return false;
    }
    for (const k in delta) {
        if (k in a || k in b) continue;
        if ((delta[Number(k)] ?? 0) !== 0) return false;
    }
    return true;
};
const msgCursor = (s: CombatSession) => Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
const hasGameMsg = (s: CombatSession, after: number, text: string) =>
    (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > after && m.text === text);

type CareContinuation = {
    last: Map<string, number>;
    poisonCursor: number;
    observation: () => boolean;
    eligible?: (kind: string) => boolean;
    statLoss?: (skill: string, elapsed: number) => number;
};

export async function runPotionCare(
    s: CombatSession,
    o: PotionCareOrder,
    requestStop: () => boolean = () => false,
    continuation?: CareContinuation,
) {
    const recipes = validatePotionCare(o);
    const client = s.client;
    const executor = (client as any)?.executeBotAction;
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const began = s.tick();
    const gear = JSON.stringify(s.sdk.getEquipment());
    const xp = JSON.stringify(s.sdk.getState()?.skills.map(i => i.experience));
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    if (!client || typeof executor !== 'function' || !first || !Number.isSafeInteger(life) || hp < 10) {
        throw Error('potion care original life/HP unknown');
    }
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return (
            s.client !== client
            || (client as any).executeBotAction !== executor
            || ended
            || !p
            || p.isDead
            || p.lifeId !== life
            || (p.respawnCount ?? 0) !== respawns
            || s.sdk.getStateAge() > 5000
            || (continuation
                ? !continuation.observation()
                : (s.sdk.getSkill('Hitpoints')?.level ?? 0) !== hp
                    || JSON.stringify(s.sdk.getEquipment()) !== gear
                    || JSON.stringify(s.sdk.getState()?.skills.map(i => i.experience)) !== xp)
        );
    };
    const stop = () =>
        fatal()
        || requestStop()
        || existsSync('.practice/stop-all')
        || existsSync(`.practice/stop-${s.name}`)
        || (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE));
    const level = (skill: string) => (skill === 'Prayer' ? s.sdk.getState()?.prayers.prayerPoints : s.sdk.getSkill(skill)?.level);
    const base = (skill: string) => (skill === 'Prayer' ? s.sdk.getState()?.prayers.prayerLevel : s.sdk.getSkill(skill)?.baseLevel);
    const cleanupReserve = 8 * Math.min(o.maximumVials, (packCounts(s)[229] ?? 0) + o.maximumDoses);
    const actionDeadline = began + o.cap - cleanupReserve;
    let uncertain = false;
    let failure = '';
    let vials = 0;
    let poisonCursor = continuation?.poisonCursor ?? msgCursor(s);
    const last = continuation?.last ?? new Map<string, number>();
    const receipts: any[] = [];
    try {
        while (o.enabled !== false && s.tick() - began < o.cap && receipts.length < o.maximumDoses) {
            if (stop()) throw Error('potion care stop/life/HP/assets');
            let used = false;
            const ownedRow = (index: number) =>
                s.sdk
                    .getInventory()
                    .filter(i => {
                        try {
                            const r = potionCareRecipe(i.id);
                            return r.kind === recipes[index]!.kind && r.family === recipes[index]!.family;
                        } catch {
                            return false;
                        }
                    })
                    .sort((a, b) => a.slot - b.slot)[0];
            const candidates = o.policies.map((_, index) => ({
                index,
                slot: o.inventoryFirst ? ownedRow(index)?.slot : undefined,
            }));
            if (o.inventoryFirst) candidates.sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.index - b.index);
            for (const candidate of candidates) {
                const index = candidate.index;
                if (o.inventoryFirst && candidate.slot === undefined) continue;
                const policy = o.policies[index]!;
                const recipe = recipes[index]!;
                if (continuation?.eligible && !continuation.eligible(recipe.kind)) continue;
                const monitored = policy.prayerPercent !== undefined ? 'Prayer' : (policy.monitorStat ?? recipe.skill);
                const needed = recipe.effects.length
                    ? policy.prayerPercent !== undefined
                        ? prayerPercentageNeeded(level('Prayer')!, base('Prayer')!, policy.prayerPercent)
                        : (level(monitored!) ?? 255) < policy.below!
                    : policy.poisonMessage
                        ? hasGameMsg(s, poisonCursor, 'You have been poisoned!')
                        : s.tick() - (last.get(recipe.kind) ?? -10000) >= recipe.cooldown;
                if (!needed) continue;
                if (stop() || s.tick() - began >= o.cap) throw Error('potion care stopped before input');
                if (actionDeadline - s.tick() < 12) throw Error('potion care needs dose/settle and vial cleanup budget');
                const row = o.inventoryFirst
                    ? ownedRow(index)
                    : s.sdk.getInventory().find(i => {
                          try {
                              const pr = potionCareRecipe(i.id);
                              return pr.kind === recipe.kind && pr.family === recipe.family;
                          } catch {
                              return false;
                          }
                      });
                if (!row) {
                    if (o.inventoryFirst) continue;
                    throw Error('declared owned potion stock exhausted');
                }
                const r = potionCareRecipe(row.id);
                const before = packCounts(s);
                const mark = msgCursor(s);
                const at = s.tick();
                const l = r.skill ? level(r.skill) : undefined;
                const statEffects = r.effects.map(e => {
                    const beforeStat = level(e.skill);
                    const b = base(e.skill);
                    if (!Number.isSafeInteger(beforeStat) || !Number.isSafeInteger(b) || b! < 1 || b! > 99) {
                        throw Error('public current/base potion stat unavailable');
                    }
                    const boost = Math.floor(e.constant + (b! * e.percent) / 100);
                    return {
                        skill: e.skill,
                        before: beforeStat!,
                        base: b!,
                        expected: Math.max(beforeStat!, Math.min(beforeStat! + boost, b! + (e.heal ? 0 : boost))),
                    };
                });
                const expected = r.skill ? statEffects[0]?.expected : undefined;
                const delta: Record<number, number> = { [r.id]: -1, [r.next]: 1 };
                const text =
                    r.doses === 1 ? 'You have finished your potion.' : `You have ${r.doses - 1} dose${r.doses === 2 ? '' : 's'} of potion left.`;
                uncertain = true;
                try {
                    if (stop()) throw Error('potion care executor changed before dose');
                    await s.direct({ type: 'useInventoryItem', slot: row.slot, optionIndex: 1, reason: 'owned finite native potion care' });
                } catch {}
                const paid = () =>
                    packDeltaMatches(before, packCounts(s), delta)
                    && hasGameMsg(s, mark, text)
                    && statEffects.every(
                        e =>
                            (level(e.skill) ?? -999) >= e.expected - (continuation?.statLoss?.(e.skill, s.tick() - at) ?? Math.ceil((s.tick() - at + 1) / 100))
                            && (level(e.skill) ?? 999) <= e.expected + Math.ceil((s.tick() - at + 1) / 100),
                    );
                if (
                    !(await waitUntil(s, () => stop() || paid(), { timeoutTicks: Math.min(8, Math.max(1, o.cap - (s.tick() - began))) }))
                    || stop()
                    || !paid()
                ) {
                    throw Error('native potion dose/stat/fresh completion unconfirmed');
                }
                receipts.push({
                    id: r.id,
                    next: r.next,
                    kind: r.kind,
                    levelBefore: l ?? null,
                    levelAfter: r.skill ? level(r.skill) : null,
                    expected: expected ?? null,
                    statEffects: statEffects.map(e => ({ ...e, after: level(e.skill) })),
                    delta,
                    receiptTicks: s.tick() - at,
                });
                last.set(r.kind, at);
                if (r.kind === 'antipoison') {
                    poisonCursor = msgCursor(s);
                    if (continuation) continuation.poisonCursor = poisonCursor;
                }
                uncertain = false;
                used = true;
                for (let i = 0; i < 3; i++) {
                    if (stop() || s.tick() - began >= o.cap || (continuation && !packDeltaMatches(before, packCounts(s), delta))) {
                        throw Error('potion care stopped during native consume settle');
                    }
                    await waitTicks(s, 1);
                }
                if (r.effects.length > 1 && !paid()) throw Error('native restorative vector settlement differs');
                if (continuation && (stop() || !packDeltaMatches(before, packCounts(s), delta))) {
                    throw Error('potion care final consume settlement differs');
                }
                break;
            }
            if (!used) {
                if (!o.monitor || s.tick() >= actionDeadline) break;
                await waitTicks(s, 1);
            }
        }
        while (o.enabled !== false && (!o.vialsAfterDoseOnly || receipts.length > 0) && vials < o.maximumVials) {
            const row = s.sdk.getInventory().find(i => i.id === 229);
            if (!row) break;
            if (stop() || s.tick() - began >= o.cap) throw Error('potion care vial drop stopped');
            const before = packCounts(s);
            uncertain = true;
            try {
                if (stop()) throw Error('potion care executor changed before vial drop');
                await s.direct({ type: 'dropItem', slot: row.slot, reason: 'declared finite empty vial drop' });
            } catch {}
            if (
                !(await waitUntil(s, () => stop() || packDeltaMatches(before, packCounts(s), { 229: -1 }), {
                    timeoutTicks: Math.min(8, Math.max(1, o.cap - (s.tick() - began))),
                }))
                || stop()
                || !packDeltaMatches(before, packCounts(s), { 229: -1 })
            ) {
                throw Error('native empty vial drop unconfirmed');
            }
            uncertain = false;
            vials++;
        }
    } catch (error) {
        failure = String(error);
    }
    return {
        ok: !failure && !uncertain,
        doses: receipts.length,
        receipts,
        vials,
        uncertain,
        failure,
        ticks: s.tick() - began,
        monitor: o.monitor ?? false,
        privateProtection: 'Cure/prevention follows exact native consumed-dose contract; private poison/resistance values are not read.',
    };
}

export function createPotionCareSession(
    s: CombatSession,
    order: PotionCareOrder,
    observation: () => boolean,
    stop: () => boolean = () => false,
    eligible?: (kind: string) => boolean,
    statLoss?: (skill: string, elapsed: number) => number,
) {
    validatePotionCare(order);
    const o = { ...order, monitor: false, policies: order.policies.map(p => ({ ...p })) };
    const client = s.client;
    const owner = (client as any).executeBotAction;
    const p = s.sdk.getState()?.player;
    const life = p?.lifeId;
    const respawns = p?.respawnCount ?? 0;
    const continuation: CareContinuation = { last: new Map(), poisonCursor: msgCursor(s), observation, eligible, statLoss };
    let busy = false;
    let blocked = false;
    let doses = 0;
    let vials = 0;
    let start: number | undefined;
    const receipts: any[] = [];
    const original = () =>
        s.client === client
        && (client as any).executeBotAction === owner
        && s.sdk.getState()?.player?.lifeId === life
        && (s.sdk.getState()?.player?.respawnCount ?? 0) === respawns;
    return {
        get doses() {
            return doses;
        },
        get vials() {
            return vials;
        },
        get blocked() {
            return blocked;
        },
        receipts,
        async poll() {
            if (busy || blocked) throw Error('potion continuation prior outcome unresolved');
            if (!original() || stop() || !observation()) {
                blocked = true;
                throw Error('potion continuation original owner/life/observation');
            }
            start ??= s.tick();
            if (doses >= o.maximumDoses || s.tick() - start >= o.cap) return;
            busy = true;
            try {
                const r = await runPotionCare(
                    s,
                    { ...o, maximumDoses: o.maximumDoses - doses, maximumVials: o.maximumVials - vials, cap: o.cap - (s.tick() - start) },
                    () => !original() || stop(),
                    continuation,
                );
                doses += r.doses;
                vials += r.vials;
                receipts.push(...r.receipts);
                if (!r.ok) {
                    blocked = true;
                    throw Error(r.failure || 'potion continuation uncertain');
                }
                return r;
            } catch (error) {
                blocked = true;
                throw error;
            } finally {
                busy = false;
            }
        },
    };
}

let cachedPrayerRates: number[] | undefined;
function getPrayerRates(): number[] {
    if (cachedPrayerRates) return cachedPrayerRates;
    const prayerScript = readFileSync(resolve(CONTENT_SCRIPTS, 'skill_prayer/scripts/prayer.rs2'), 'utf8');
    const prayerEnum = readFileSync(resolve(CONTENT_SCRIPTS, 'skill_prayer/configs/prayers.enum'), 'utf8').split('[prayer_headicons]')[0]!;
    cachedPrayerRates = Array.from({ length: 15 }, (_, index) => {
        const name = [...prayerScript.matchAll(/case \^(\w+) :\s*if \(%prayer(\d+) =/g)].find(m => Number(m[2]) === index)?.[1];
        const rate = Number(prayerEnum.match(new RegExp('val=\\^' + name + ',([0-9]+)'))?.[1]);
        if (!Number.isSafeInteger(rate) || rate < 1) throw Error('native prayer drain mapping absent');
        return rate;
    });
    return cachedPrayerRates;
}

export function combatPrayerLoss(active: readonly boolean[], elapsed: number): number {
    if (active.length !== 15 || !Number.isSafeInteger(elapsed) || elapsed < 0) throw Error('native prayer observation absent');
    const rates = getPrayerRates();
    const rate = active.reduce((sum, on, i) => sum + (on ? rates[i]! : 0), 0);
    return Math.ceil((rate * 5 * Math.ceil((elapsed + 1) / 5)) / 60);
}

export type CombatPotionPolicy = { actor: string; server: string; hpFloor: number; order: PotionCareOrder };

export function prepareCombatPotions(p: CombatPotionPolicy) {
    if (!p || !p.actor || !p.server || !Number.isSafeInteger(p.hpFloor) || p.hpFloor < 10 || p.hpFloor > 99 || p.order?.monitor) {
        throw Error('finite actor/server/HP combat potion policy required');
    }
    validatePotionCare(p.order);
    return Object.freeze({
        ...p,
        order: Object.freeze({ ...p.order, monitor: false, policies: p.order.policies.map(r => Object.freeze({ ...r })) }),
    });
}

export function combatPotionPolicy(env: Record<string, string | undefined> = process.env) {
    if (!env.COMBAT_POTIONS_FILE) return;
    const bytes = readFileSync(env.COMBAT_POTIONS_FILE);
    if (bytes.length > 16384) throw Error('combat potion policy too large');
    return prepareCombatPotions(JSON.parse(bytes.toString('utf8')));
}

const canonicalRows = (rows: readonly { id: number; count: number; slot: number }[]) =>
    JSON.stringify(rows.map(r => ({ id: r.id, count: r.count, slot: r.slot })).sort((a, b) => a.slot - b.slot));

export function combatPotionSession(s: CombatSession, stop: () => boolean, cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('finite combat cleanup cap required');
    let cleanup = false;
    const deadline = s.tick() + cap;
    const client = s.client as any;
    const owner = client.executeBotAction;
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const check = () => {
        const p = s.sdk.getState()?.player;
        if (
            ended
            || s.client !== client
            || client.executeBotAction !== owner
            || !Number.isSafeInteger(life)
            || !p
            || p.isDead
            || p.lifeId !== life
            || (p.respawnCount ?? 0) !== respawns
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0
            || s.sdk.getStateAge() > 5000
            || s.tick() >= deadline
            || (!cleanup && productionStopRequested(s.name, stop))
        ) {
            throw Error('combat potion consumer original owner/life/stop');
        }
    };
    const isPotion = (slot: number) => {
        const row = s.sdk.getInventory().find(i => i.slot === slot);
        if (!row) return false;
        try {
            potionCareRecipe(row.id);
            return true;
        } catch {
            return false;
        }
    };
    const bankAction = (a: any) =>
        a?.type === 'interactNpc'
        && a.optionIndex === 3
        && s.sdk.getState()?.nearbyNpcs.some(
            n =>
                n.index === a.npcIndex
                && [494, 495, 496, 497, 498, 499, 953, 1036, 1360].includes(n.id)
                && Number.isFinite(n.distance)
                && n.distance >= 0
                && n.distance <= 2
                && client.npc?.[n.index]?.type?.id === n.id
                && n.optionsWithIndex.some(o => o.opIndex === 3 && /^bank$/i.test(o.text)),
        ) === true;
    const checkAction = (a: any) => {
        check();
        if (cleanup && ((/Npc|Player|[Ss]pell/.test(a?.type ?? '') && !bankAction(a)) || (a?.type === 'useInventoryItem' && isPotion(a.slot)))) {
            throw Error('combat cleanup refuses new paid combat/potion');
        }
    };
    const sdk = new Proxy(s.sdk, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function'
                ? function (...args: unknown[]) {
                      if (typeof key === 'string' && key.startsWith('send')) {
                          check();
                          if (key === 'sendAction') checkAction(args[0]);
                          if (cleanup && key === 'sendUseItem' && isPotion(args[0] as number)) {
                              throw Error('combat cleanup refuses potion');
                          }
                      }
                      return value.apply(receiver, args);
                  }
                : value;
        },
    });
    const view = Object.create(s) as CombatSession & { withCombatPotionCleanup: (task: () => Promise<void>) => Promise<void> };
    Object.defineProperties(view, {
        sdk: { value: sdk },
        bot: { value: new BotActions(sdk) },
        direct: {
            value: (...args: unknown[]) => {
                checkAction(args[0]);
                return (s.direct as any)(...args);
            },
        },
        withCombatPotionCleanup: {
            value: async (task: () => Promise<void>) => {
                if (cleanup) throw Error('combat cleanup already active');
                cleanup = true;
                try {
                    await task();
                } finally {
                    cleanup = false;
                }
            },
        },
    });
    return view;
}

export function combatPotionRecovery(
    scope: { withCombatPotionCleanup: (task: () => Promise<void>) => Promise<void> },
    blocked: () => boolean,
    bank: () => Promise<void>,
    setRecovering: (active: boolean) => void,
) {
    let attempted = false;
    return async () => {
        if (attempted) return;
        if (blocked()) throw Error('combat potion unresolved input parks bank recovery');
        attempted = true;
        setRecovering(true);
        try {
            await scope.withCombatPotionCleanup(bank);
        } finally {
            setRecovering(false);
        }
    };
}

export function createCombatPotions(
    s: CombatSession,
    p: CombatPotionPolicy,
    skills: readonly string[],
    stop: () => boolean,
    ammoId?: number,
) {
    if (
        s.name.toLowerCase() !== p.actor.toLowerCase()
        || s.lifecycle?.account.toLowerCase() !== p.actor.toLowerCase()
        || s.lifecycle.server !== p.server
        || skills.some(k => !['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'].includes(k))
        || (ammoId !== undefined && ammoId !== 884)
    ) {
        throw Error('combat potion owned actor/server/style differs');
    }
    const client = s.client as any;
    const owner = client.executeBotAction;
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const plane = first?.level;
    let ended = false;
    let busy = false;
    let blocked = false;
    let resumes = 0;
    void s.ended.then(() => {
        ended = true;
    });
    const delta: Record<number, number> = {};
    const ids = new Set<number>([229]);
    for (const policy of p.order.policies) {
        let id = policy.id;
        while (id !== 229) {
            ids.add(id);
            id = potionCareRecipe(id).next;
        }
    }
    const base = () => {
        const st = s.sdk.getState();
        const me = st?.player;
        return (
            !ended
            && s.client === client
            && client.executeBotAction === owner
            && Number.isSafeInteger(life)
            && !!me
            && !me.isDead
            && me.lifeId === life
            && (me.respawnCount ?? 0) === respawns
            && me.level === plane
            && (s.sdk.getSkill('Hitpoints')?.level ?? 0) >= p.hpFloor
            && s.sdk.getStateAge() <= 5000
            && st!.nearbyPlayers.length === 0
            && !productionStopRequested(s.name, stop)
        );
    };
    let observation = base;
    let inCombat = false;
    let activePrayers: boolean[] = Array(15).fill(false);
    const care = createPotionCareSession(
        s,
        p.order,
        () => observation(),
        () => !base(),
        kind => inCombat || ['prayer', 'antipoison', 'antifire'].includes(kind),
        (skill, elapsed) => (skill === 'Prayer' ? combatPrayerLoss(activePrayers, elapsed) : Math.ceil((elapsed + 1) / 100)),
    );
    const sync = () => {
        for (const key of Object.keys(delta)) delete delta[+key];
        for (const receipt of care.receipts) {
            for (const [id, n] of Object.entries(receipt.delta as Record<number, number>)) {
                delta[+id] = (delta[+id] ?? 0) + n;
            }
        }
        delta[229] = (delta[229] ?? 0) - care.vials;
    };
    return {
        delta,
        depositIds: [...ids],
        get doses() {
            return care.doses;
        },
        get resumes() {
            return resumes;
        },
        get blocked() {
            return blocked || care.blocked;
        },
        receipts: care.receipts,
        async poll(target?: { index: number; id: number }) {
            if (busy || blocked) throw Error('combat potion outcome unresolved');
            if (!base()) throw Error('combat potion original owner/life/HP/stop');
            const st = s.sdk.getState()!;
            const me = st.player!;
            const at = s.tick();
            const style = JSON.stringify(st.combatStyle);
            const retaliate = st.autoRetaliateEnabled;
            const hp = s.sdk.getSkill('Hitpoints')!.level;
            const xp = st.skills.map(k => ({ name: k.name, xp: k.experience }));
            const gear = s.sdk.getEquipment().map(r => ({ ...r }));
            const quiver = gear.find(r => r.slot === 13);
            const uid = 32768 + client.selfSlot;
            const npc = target ? st.nearbyNpcs.find(n => n.index === target.index && n.id === target.id) : undefined;
            const native = target ? client.npc?.[target.index] : undefined;
            if (target && npc?.targetIndex === -1) return;
            if (target && (!native || native.type?.id !== target.id || !npc || me.combat.targetType !== 'npc' || me.combat.targetIndex !== target.index || npc.targetIndex !== uid)) {
                throw Error('combat potion selected owned NPC absent');
            }
            activePrayers = [...(st.prayers?.activePrayers ?? [])];
            if (activePrayers.length !== 15) throw Error('combat potion prayer state absent');
            inCombat = !!target;
            observation = () => {
                if (!base()) return false;
                const current = s.sdk.getState()!;
                const player = current.player!;
                if (
                    JSON.stringify(current.prayers.activePrayers) !== JSON.stringify(activePrayers)
                    || JSON.stringify(current.combatStyle) !== style
                    || current.autoRetaliateEnabled !== retaliate
                ) {
                    return false;
                }
                if (current.nearbyNpcs.some(n => n.targetIndex === uid && (!target || n.index !== target.index || n.id !== target.id))) return false;
                if (target) {
                    if (client.npc?.[target.index] && client.npc[target.index] !== native) return false;
                    if (player.combat.targetType !== 'none' && (player.combat.targetType !== 'npc' || player.combat.targetIndex !== target.index)) return false;
                    const n = current.nearbyNpcs.find(n => n.index === target.index);
                    if (n && (n.id !== target.id || (n.targetIndex !== uid && n.targetIndex !== -1))) return false;
                } else if (player.combat.targetType !== 'none' || s.sdk.getSkill('Hitpoints')?.level !== hp) {
                    return false;
                }
                if (
                    xp.some(k => {
                        const now = current.skills.find(v => v.name === k.name)?.experience;
                        return now === undefined || !Number.isFinite(now) || now < k.xp || ((!target || !skills.includes(k.name)) && now !== k.xp);
                    })
                ) {
                    return false;
                }
                const eq = s.sdk.getEquipment();
                if (!target || ammoId === undefined) return canonicalRows(eq) === canonicalRows(gear);
                const q = eq.find(r => r.slot === 13);
                return (
                    canonicalRows(eq.filter(r => r.slot !== 13)) === canonicalRows(gear.filter(r => r.slot !== 13))
                    && !!quiver
                    && quiver.id === ammoId
                    && (!q || q.id === ammoId)
                    && quiver.count - (q?.count ?? 0) >= 0
                    && quiver.count - (q?.count ?? 0) <= s.tick() - at + 1
                );
            };
            busy = true;
            try {
                const result = await care.poll();
                if (!observation()) throw Error('combat potion final observation differs');
                if (target && result && (result.doses > 0 || result.vials > 0)) {
                    const state = s.sdk.getState()!;
                    const n = state.nearbyNpcs.find(n => n.index === target.index && n.id === target.id);
                    if (n && n.hp !== 0 && state.player?.combat.targetType === 'none') {
                        if (!observation() || client.npc?.[target.index] !== native || n.targetIndex !== uid) {
                            throw Error('combat potion resume target changed');
                        }
                        await s.direct({
                            type: 'interactNpc',
                            npcIndex: target.index,
                            optionIndex: 2,
                            reason: 'resume exact owned NPC after confirmed potion care',
                        });
                        resumes++;
                        if (
                            !(await waitUntil(
                                s,
                                () =>
                                    !observation()
                                    || (s.sdk.getState()?.player?.combat.targetType === 'npc' && s.sdk.getState()?.player?.combat.targetIndex === target.index)
                                    || !s.sdk.getState()?.nearbyNpcs.some(n => n.index === target.index),
                                { timeoutTicks: 8 },
                            ))
                            || !observation()
                        ) {
                            throw Error('combat potion resume unconfirmed');
                        }
                    }
                }
                return result;
            } catch (error) {
                blocked = true;
                throw error;
            } finally {
                sync();
                observation = base;
                busy = false;
            }
        },
    };
}

// Item magic / alchemy / telegrab helpers
export interface MagicRecipe {
    name: string;
    spell: string;
    level: number;
    smithing: number;
    target: number;
    product: number;
    inputs: Record<number, number>;
    output: number;
    members: boolean;
}

type SurvivabilityItemMeta = { id: number; debugname: string; cost?: number; tradeable?: boolean };
let cachedItemsByDebug: Map<string, SurvivabilityItemMeta> | undefined;
let cachedItemsById: Map<number, SurvivabilityItemMeta> | undefined;
function ensureSurvivabilityItems() {
    if (!cachedItemsByDebug || !cachedItemsById) {
        const rows = JSON.parse(readFileSync(resolve(ROOT, 'knowledge/items.json'), 'utf8')) as SurvivabilityItemMeta[];
        cachedItemsByDebug = new Map();
        cachedItemsById = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            if (!cachedItemsByDebug.has(row.debugname)) cachedItemsByDebug.set(row.debugname, row);
            if (!cachedItemsById.has(row.id)) cachedItemsById.set(row.id, row);
        }
    }
}

const magicTexts = new Map<string, string>();
const magicParsed = new Map<string, { name: string; body: string }[]>();
const readContentText = (file: string) => {
    let t = magicTexts.get(file);
    if (t === undefined) {
        t = readFileSync(file, 'utf8');
        magicTexts.set(file, t);
    }
    return t;
};
const magicBlocksOf = (file: string) => {
    let b = magicParsed.get(file);
    if (!b) {
        b = [...readContentText(file).matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m => ({ name: m[1]!, body: m[2]! }));
        magicParsed.set(file, b);
    }
    return b;
};

export { elementalRuneCost };

export function combatMagicRecipe(mode: 'low-alch' | 'high-alch', targetName: string): MagicRecipe {
    if (!targetName || !/^\w+$/.test(targetName) || ['coins', 'naturerune', 'firerune'].includes(targetName)) {
        throw Error('explicit non-rune alchemy target required');
    }
    const spells = magicBlocksOf(resolve(CONTENT_SCRIPTS, 'skill_magic/configs/magic_spells.dbrow'));
    const field = (body: string, key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
    const row = spells.find(r => r.name === (mode === 'low-alch' ? 'magic_spell_low_alch' : 'magic_spell_high_alch'));
    if (!row) throw Error('no native item conversion');
    const inputs: Record<number, number> = { [objId(targetName)]: 1 };
    const runes = field(row.body, 'runesrequired')!.split(',');
    for (let n = 0; n < runes.length; n += 2) {
        if (runes[n] !== 'null') inputs[objId(runes[n]!)] = (inputs[objId(runes[n]!)] ?? 0) + Number(runes[n + 1]);
    }
    ensureSurvivabilityItems();
    const item = cachedItemsByDebug!.get(targetName);
    if (item?.cost === undefined) throw Error('unknown native alchemy value');
    const output = Math.max(1, Math.floor((item.cost * (mode === 'high-alch' ? 6 : 4)) / 10));
    return {
        name: mode,
        spell: 'magic:' + field(row.body, 'spell')!.replace('^', ''),
        level: Number(field(row.body, 'levelrequired')),
        smithing: 0,
        target: objId(targetName),
        product: objId('coins'),
        inputs,
        output,
        members: field(row.body, 'members') === 'true',
    };
}

export function combatSpellCosts(recipe: MagicRecipe, worn: readonly { id: number; slot: number }[], members = false): Record<number, number> {
    return Object.fromEntries(
        Object.entries(recipe.inputs)
            .map(([id, n]) => {
                const target = Number(id) === recipe.target ? 1 : 0;
                return [id, target + elementalRuneCost(Number(id), n - target, worn, members)];
            })
            .filter(([, n]) => Number(n) > 0),
    ) as Record<number, number>;
}

function itemSpellEffect(
    recipe: MagicRecipe,
    costs: Record<number, number>,
    before: Record<number, number>,
    after: Record<number, number>,
    xpBefore: number,
    xpAfter: number,
) {
    const ids = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(costs), String(recipe.product)]);
    if (xpAfter === xpBefore && [...ids].every(key => (after[Number(key)] ?? 0) === (before[Number(key)] ?? 0))) return 'none';
    for (const key of ids) {
        const id = Number(key);
        const delta = (after[id] ?? 0) - (before[id] ?? 0);
        const expected = (id === recipe.product ? recipe.output : 0) - (costs[id] ?? 0);
        if (delta !== expected) return 'invalid';
    }
    return xpAfter > xpBefore ? 'cast' : 'invalid';
}

function combatAlchSpellDelay(): number {
    const lines = readContentText(resolve(CONTENT_SCRIPTS, 'skill_magic/scripts/spells/alchemy.rs2')).split(/\r?\n/);
    const from = lines.findIndex(l => l.startsWith('[label,magic_spell_high_alch]'));
    for (let i = from + 1; from >= 0 && i < lines.length && !lines[i]!.startsWith('['); i++) {
        const m = lines[i]!.match(/^p_delay\((\d+)\);/);
        if (m) return Number(m[1]);
    }
    return 3;
}

export async function runHighAlch(s: CombatSession, recipe: MagicRecipe, o: { count: number; cap: number; members?: boolean; stop?: () => boolean }) {
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of inv()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return r;
    };
    const xp = () => s.sdk.getSkillXp('Magic') ?? 0;
    const start = s.tick();
    const xp0 = xp();
    let casts = 0;
    let ended = false;
    let stop = 'target';
    void s.ended.then(() => {
        ended = true;
    });
    if (recipe.members && !o.members) throw Error('member spell requires explicit member batch scope');
    const p0 = state()?.player;
    if (!p0) throw Error('player state unknown');
    if ((s.sdk.getSkill('Magic')?.level ?? 0) < recipe.level) throw Error('spell skill requirement');
    const life = watchProductionLife(s, o.stop);
    const over = () => ended || life.stopped() || s.tick() - start >= o.cap;
    if (typeof s.bot?.equipItem === 'function') {
        const spellRunes: number[] = [];
        for (const [idStr, rawCount] of Object.entries(recipe.inputs)) {
            const id = Number(idStr);
            const used = rawCount - (id === recipe.target ? 1 : 0);
            for (let k = 0; k < used; k++) spellRunes.push(id);
        }
        const eq = (state()?.equipment ?? []) as readonly { id: number; slot: number }[];
        const staff = bestElementalStaffForRunes(
            [...inv(), ...eq.filter(e => e.slot === 3).map(e => ({ id: e.id, count: 1 }))],
            readSkillLevels(n => s.sdk.getSkill(n)),
            [],
            spellRunes,
        );
        if (staff && !eq.some(e => e.slot === 3 && e.id === staff.id)) {
            const held = inv().find(i => i.id === staff.id);
            if (held) {
                await s.bot.equipItem(held);
                await waitUntil(s, () => over() || (state()?.equipment ?? []).some(e => e.slot === 3 && e.id === staff.id), { timeoutTicks: 4 });
            }
        }
    }
    while (casts < o.count) {
        if (over()) {
            stop = ended ? 'session ended' : life.stopped() ? 'stopped' : 'cap';
            break;
        }
        const p = state()?.player;
        if (!p || p.worldX !== p0.worldX || p.worldZ !== p0.worldZ || p.lifeId !== p0.lifeId || p.isDead) {
            throw Error('unsafe player change');
        }
        const ui = state();
        const onlyContinue = !!ui?.dialog?.isOpen && (ui.dialog.options?.length ?? 0) <= 1 && !ui.interface?.isOpen;
        if (process.env.ITEM_MAGIC_DISMISS === '1' || (!onlyContinue && (ui?.dialog?.isOpen || ui?.interface?.isOpen))) {
            await s.bot.dismissBlockingUI();
        }
        if (over()) {
            stop = 'stopped';
            break;
        }
        const before = counts();
        const x0 = xp();
        const costs = combatSpellCosts(recipe, state()?.equipment ?? [], o.members ?? false);
        if (Object.entries(costs).some(([id, n]) => (before[Number(id)] ?? 0) < n)) {
            stop = 'supplies';
            break;
        }
        const item = inv().find(i => i.id === recipe.target);
        if (!item) throw Error('target missing');
        const result = (await s.direct({ type: 'spellOnItem', slot: item.slot, spellComponent: componentId(recipe.spell), reason: 'SDK' })) as {
            success?: boolean;
        };
        if (result?.success === false) throw Error('item spell dispatch refused');
        await waitUntil(s, () => over() || xp() !== x0 || Object.keys(counts()).some(id => counts()[Number(id)] !== before[Number(id)]), {
            timeoutTicks: Math.min(12, Math.max(1, o.cap - (s.tick() - start))),
        });
        await waitTicks(s, 1);
        const eff = itemSpellEffect(recipe, costs, before, counts(), x0, xp());
        if (eff !== 'cast') throw Error('item spell effect ' + eff);
        casts++;
        const gap = Number(process.env.ITEM_MAGIC_GAP ?? combatAlchSpellDelay());
        if (gap > 0 && casts < o.count && !over()) await waitTicks(s, Math.min(gap, Math.max(1, o.cap - (s.tick() - start))));
    }
    return { ok: casts === o.count, stop, casts, ticks: s.tick() - start, magicXp: xp() - xp0, product: recipe.product, produced: casts * recipe.output };
}

export type LootQuoteSnapshot = {
    origin: string;
    observedAt: number;
    prices: Readonly<Record<number, Readonly<{ price: number; lastTradeAt: number }>>>;
};

export type CombatAlchPolicy = {
    actor: string;
    server: string;
    quotes: LootQuoteSnapshot;
    ids: number[];
    blacklist: number[];
    maximum: number;
    cap: number;
    hpFloor: number;
    minimumProfit: number;
    reserves: Record<number, number>;
    xpMultiplier: number;
    route?: { site: CombatTile; bank: CombatTile };
    stop?: () => boolean;
};

export type PreparedCombatAlch = Readonly<CombatAlchPolicy & { recipes: Readonly<Record<number, MagicRecipe>> }>;

const integerIn = (n: unknown, min: number, max = 2147483647) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;

export function prepareCombatAlch(p: CombatAlchPolicy): PreparedCombatAlch {
    if (
        !p
        || typeof p.actor !== 'string'
        || !p.actor
        || typeof p.server !== 'string'
        || !p.server
        || !Array.isArray(p.ids)
        || !p.ids.length
        || p.ids.length > 14
        || !Array.isArray(p.blacklist)
        || new Set(p.ids).size !== p.ids.length
        || [...p.ids, ...p.blacklist].some(id => !integerIn(id, 1))
        || !integerIn(p.maximum, 1, 100)
        || !integerIn(p.cap, 18, 10000)
        || !integerIn(p.hpFloor, 1, 99)
        || !integerIn(p.minimumProfit, 0)
        || !p.reserves
        || Object.entries(p.reserves).some(([id, n]) => !integerIn(Number(id), 1) || !integerIn(n, 0))
        || !Number.isFinite(p.xpMultiplier)
        || p.xpMultiplier <= 0
    ) {
        throw Error('invalid finite owned combat alchemy policy');
    }
    if (p.route) {
        for (const t of [p.route.site, p.route.bank]) {
            if (!t || !integerIn(t.x, 0, 16383) || !integerIn(t.z, 0, 16383) || !integerIn(t.level, 0, 3) || t.level !== 0) {
                throw Error('explicit native same-plane alchemy route required');
            }
        }
    }
    const q = p.quotes;
    if (!q || new URL(q.origin).origin !== q.origin || !integerIn(q.observedAt, 0, Number.MAX_SAFE_INTEGER) || !q.prices) {
        throw Error('explicit server-bound unit quote snapshot required');
    }
    const prices: Record<number, { price: number; lastTradeAt: number }> = {};
    for (const id of [...p.ids, 561, 554]) {
        const v = q.prices[id];
        if (!v || !integerIn(v.price, 1) || !integerIn(v.lastTradeAt, 0, Number.MAX_SAFE_INTEGER) || v.lastTradeAt > q.observedAt) {
            throw Error('declared item/Nature/Fire unit quote missing');
        }
        prices[id] = Object.freeze({ ...v });
    }
    ensureSurvivabilityItems();
    const recipes: Record<number, MagicRecipe> = {};
    for (const id of p.ids) {
        const item = cachedItemsById!.get(id);
        if (!item?.tradeable || [995, 561, 554].includes(id)) throw Error('explicit tradeable non-supply alchemy target required');
        const r = combatMagicRecipe('high-alch', item.debugname);
        if (r.target !== id) throw Error('native alchemy target differs');
        combatSpellCosts(r, [], true);
        recipes[id] = Object.freeze({ ...r, inputs: Object.freeze({ ...r.inputs }) });
    }
    return Object.freeze({
        ...p,
        route: p.route ? Object.freeze({ site: Object.freeze({ ...p.route.site }), bank: Object.freeze({ ...p.route.bank }) }) : undefined,
        ids: Object.freeze([...p.ids]) as unknown as number[],
        blacklist: Object.freeze([...p.blacklist]) as unknown as number[],
        reserves: Object.freeze({ ...p.reserves }),
        quotes: Object.freeze({ ...q, prices: Object.freeze(prices) }),
        recipes: Object.freeze(recipes),
    });
}

export function combatAlchPolicy(env: Record<string, string | undefined> = process.env) {
    if (!env.COMBAT_ALCH_FILE) return;
    const text = readFileSync(env.COMBAT_ALCH_FILE);
    if (text.length > 32768) throw Error('combat alchemy policy too large');
    return prepareCombatAlch(JSON.parse(text.toString('utf8')));
}

export function combatAlchMargin(p: PreparedCombatAlch, id: number, costs: Record<number, number>) {
    const r = p.recipes[id];
    if (!r || p.blacklist.includes(id)) return;
    return (
        r.output
        - p.quotes.prices[id]!.price
        - Object.entries(costs)
            .filter(([key]) => Number(key) !== id)
            .reduce((sum, [key, n]) => sum + n * p.quotes.prices[Number(key)]!.price, 0)
    );
}

export const combatAlchCounts = (rows: readonly { id: number; count: number }[]) => {
    const a: Record<number, number> = {};
    for (const r of rows) a[r.id] = (a[r.id] ?? 0) + r.count;
    return a;
};

export function combatAlchCapacity(rows: readonly { id: number; count: number }[], costs: Record<number, number>, output: number): boolean {
    if (rows.length > 28 || !integerIn(output, 1) || rows.some(r => !integerIn(r.count, 1))) return false;
    const remaining = { ...costs };
    const after = rows
        .map(r => {
            const debit = Math.min(r.count, remaining[r.id] ?? 0);
            remaining[r.id] = (remaining[r.id] ?? 0) - debit;
            return { id: r.id, count: r.count - debit };
        })
        .filter(r => r.count > 0);
    if (Object.values(remaining).some(n => n !== 0)) return false;
    const coins = after.filter(r => r.id === 995).reduce((n, r) => n + r.count, 0);
    return coins + output <= 2147483647 && (coins > 0 || after.length < 28);
}

export function combatLootReceipt(
    before: Record<number, number>,
    after: Record<number, number>,
    item: { id: number; count: number },
    runes: Record<number, number> = {},
): boolean {
    return [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(runes), String(item.id)])].every(
        key => (after[+key] ?? 0) - (before[+key] ?? 0) === (+key === item.id ? item.count : 0) - (runes[+key] ?? 0),
    );
}

export function createCombatAlch(s: CombatSession, p: PreparedCombatAlch) {
    if (
        s.name.toLowerCase() !== p.actor.toLowerCase()
        || s.lifecycle?.account.toLowerCase() !== p.actor.toLowerCase()
        || s.lifecycle.server !== p.server
        || new URL(s.sdk.config.browserLaunchUrl).origin !== p.quotes.origin
        || Date.now() < p.quotes.observedAt
        || Date.now() - p.quotes.observedAt > 60000
    ) {
        throw Error('combat alchemy actor/server/quote admission differs');
    }
    const client = s.client as any;
    const owner = client.executeBotAction;
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const plane = first?.level;
    const start = s.tick();
    let ended = false;
    let busy = false;
    let blocked = false;
    let casts = 0;
    let coins = 0;
    void s.ended.then(() => {
        ended = true;
    });
    const consumed: Record<number, number> = {};
    const runes: Record<number, number> = {};
    const receipts: any[] = [];
    const unsafe = () => {
        const st = s.sdk.getState();
        const me = st?.player;
        return (
            ended
            || s.client !== client
            || client.executeBotAction !== owner
            || !Number.isSafeInteger(life)
            || !me
            || me.isDead
            || me.lifeId !== life
            || (me.respawnCount ?? 0) !== respawns
            || me.level !== plane
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < p.hpFloor
            || s.sdk.getStateAge() > 5000
            || !equipmentObserved(client)
            || st!.nearbyPlayers.length > 0
            || p.stop?.()
            || existsSync('.practice/stop-all')
            || existsSync(`.practice/stop-${s.name}`)
            || (!!process.env.STOP_FILE && existsSync(process.env.STOP_FILE))
        );
    };
    const afterPickup = async (item: { id: number; count: number }) => {
        if (busy || blocked) throw Error('combat alchemy prior outcome unresolved');
        const recipe = p.recipes[item.id];
        if (!recipe || p.blacklist.includes(item.id) || casts >= p.maximum) return 0;
        if (!integerIn(item.count, 1)) throw Error('owned loot quantity unknown');
        let made = 0;
        for (let n = 0; n < item.count && casts < p.maximum; n++) {
            if (unsafe()) throw Error('combat alchemy original owner/life/HP/stop');
            if (Date.now() - p.quotes.observedAt > 60000) break;
            if (s.tick() - start + 18 > p.cap) break;
            const st = s.sdk.getState();
            const player = st?.player;
            if (!st || !player) throw Error('combat alchemy player absent');
            if (player.combat.targetType !== 'none' || st.nearbyNpcs.some(npc => npc.targetIndex === 32768 + client.selfSlot)) {
                throw Error('finish owned combat before profitable alchemy');
            }
            const costs = combatSpellCosts(recipe, s.sdk.getEquipment(), client.membersAccount === 1);
            const margin = combatAlchMargin(p, item.id, costs);
            if (margin === undefined || margin <= p.minimumProfit) break;
            const before = combatAlchCounts(s.sdk.getInventory());
            if (Object.entries({ ...p.reserves, ...costs }).some(([id]) => (before[+id] ?? 0) - (costs[+id] ?? 0) < (p.reserves[+id] ?? 0))) break;
            if (!combatAlchCapacity(s.sdk.getInventory(), costs, recipe.output)) break;
            const position = { x: player.worldX, z: player.worldZ };
            const hp = s.sdk.getSkill('Hitpoints')!.level;
            const gear = JSON.stringify(s.sdk.getEquipment());
            const xp = s.sdk.getSkillXp('Magic') ?? 0;
            const other = JSON.stringify(st.skills.filter(k => k.name !== 'Magic').map(k => [k.name, k.experience]));
            busy = true;
            blocked = true;
            try {
                const result = await runHighAlch(s, recipe, {
                    count: 1,
                    cap: Math.min(12, p.cap - (s.tick() - start)),
                    members: client.membersAccount === 1,
                    stop: () =>
                        !!unsafe()
                        || s.tick() - start >= p.cap
                        || s.sdk.getSkill('Hitpoints')?.level !== hp
                        || s.sdk.getState()?.player?.worldX !== position.x
                        || s.sdk.getState()?.player?.worldZ !== position.z,
                });
                if (
                    !result.ok
                    || unsafe()
                    || s.sdk.getSkill('Hitpoints')?.level !== hp
                    || gear !== JSON.stringify(s.sdk.getEquipment())
                    || other !== JSON.stringify(s.sdk.getState()!.skills.filter(k => k.name !== 'Magic').map(k => [k.name, k.experience]))
                    || (s.sdk.getSkillXp('Magic') ?? 0) - xp !== 65 * p.xpMultiplier
                ) {
                    throw Error('combat alchemy exact owned spell receipt unconfirmed');
                }
                casts++;
                made++;
                coins += recipe.output;
                consumed[item.id] = (consumed[item.id] ?? 0) + 1;
                for (const [id, count] of Object.entries(costs)) {
                    if (+id !== item.id) runes[+id] = (runes[+id] ?? 0) + count;
                }
                receipts.push({
                    id: item.id,
                    costs,
                    coins: recipe.output,
                    margin,
                    magicXp: 65 * p.xpMultiplier,
                    tick: s.tick(),
                    quoteObservedAt: p.quotes.observedAt,
                });
                const settledPack = JSON.stringify(combatAlchCounts(s.sdk.getInventory()));
                for (let k = 0; k < 4; k++) {
                    if (
                        unsafe()
                        || s.tick() - start >= p.cap
                        || gear !== JSON.stringify(s.sdk.getEquipment())
                        || s.sdk.getSkill('Hitpoints')?.level !== hp
                        || JSON.stringify(combatAlchCounts(s.sdk.getInventory())) !== settledPack
                    ) {
                        throw Error('combat alchemy cooldown stopped');
                    }
                    await waitTicks(s, 1);
                }
                blocked = false;
            } finally {
                busy = false;
            }
        }
        return made;
    };
    return {
        afterPickup,
        stopped: () => blocked || !!unsafe(),
        consumed,
        runes,
        receipts,
        get casts() {
            return casts;
        },
        get coins() {
            return coins;
        },
        get blocked() {
            return blocked;
        },
    };
}

export type TelegrabPolicy = { maximum: number; cap: number; xpMultiplier?: number; stop?: () => boolean };

function validateTelegrab(p: TelegrabPolicy) {
    if (
        !Number.isSafeInteger(p.maximum)
        || p.maximum < 1
        || p.maximum > 1000
        || !Number.isSafeInteger(p.cap)
        || p.cap < 1
        || p.cap > 100000
        || !Number.isFinite(p.xpMultiplier ?? 1)
        || (p.xpMultiplier ?? 1) <= 0
    ) {
        throw Error('finite Telegrab maximum1..1000,cap1..100000 and positive XP multiplier required');
    }
}

export function telegrabPolicy(env: Record<string, string | undefined> = process.env): TelegrabPolicy | undefined {
    if (env.TELEGRAB_MAX === undefined) return;
    const p = {
        maximum: Number(env.TELEGRAB_MAX),
        cap: Number(env.TELEGRAB_CAP ?? env.CAP ?? 10000),
        xpMultiplier: Number(env.TELEGRAB_XP_MULTIPLIER ?? 1),
    };
    validateTelegrab(p);
    return p;
}

const telegrabCounts = (items: readonly { id: number; count: number }[]) => {
    const out: Record<number, number> = {};
    for (const i of items) out[i.id] = (out[i.id] ?? 0) + i.count;
    return out;
};

export function telegrabReceipt(
    item: { id: number; count: number },
    costs: Record<number, number>,
    before: Record<number, number>,
    after: Record<number, number>,
    xp: number,
    expectedXp: number,
): boolean {
    return (
        xp === expectedXp
        && [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(costs), String(item.id)])].every(key => {
            const id = Number(key);
            return (after[id] ?? 0) - (before[id] ?? 0) === (id === item.id ? item.count : 0) - (costs[id] ?? 0);
        })
    );
}

export function telegrabCapacity(item: { id: number; count: number }, pack: readonly { id: number; count: number }[], stackable: boolean): boolean {
    if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > 2147483647 || pack.length > 28) return false;
    const held = pack.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
    return stackable ? held + item.count <= 2147483647 && (held > 0 || pack.length < 28) : item.count <= 28 - pack.length;
}

export function createCombatLoot(s: CombatSession, policy?: TelegrabPolicy, alchPolicy?: PreparedCombatAlch) {
    if (policy) validateTelegrab(policy);
    const start = s.tick();
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const plane = first?.level;
    let casts = 0;
    let blocked = false;
    let busy = false;
    const runesUsed: Record<number, number> = { 556: 0, 563: 0 };
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return (
            life === undefined
            || !p
            || p.isDead
            || p.lifeId !== life
            || (p.respawnCount ?? 0) !== respawns
            || p.level !== plane
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < 1
        );
    };
    const basePickup = async (item: GroundItem): Promise<{ success: boolean; telegrab: boolean; skipped?: boolean }> => {
        if (!policy || item.reachable !== false) return { success: (await s.bot.pickupItem(item)).success, telegrab: false };
        if (busy || blocked) throw Error('Telegrab prior attempted outcome unresolved');
        const state = s.sdk.getState();
        const p = state?.player;
        const fresh = state?.groundItems.find(i => i.id === item.id && i.x === item.x && i.z === item.z && i.count === item.count);
        if (
            fatal()
            || policy.stop?.()
            || s.tick() - start >= policy.cap
            || casts >= policy.maximum
            || !fresh
            || fresh.reachable !== false
            || !Number.isSafeInteger(item.count)
            || item.count < 1
            || !p
            || Math.max(Math.abs(p.worldX - item.x), Math.abs(p.worldZ - item.z)) > 10
            || (s.sdk.getSkill('Magic')?.level ?? 0) < 33
        ) {
            return { success: false, telegrab: true, skipped: true };
        }
        const before = telegrabCounts(s.sdk.getInventory());
        const xp = s.sdk.getSkillXp('Magic') ?? 0;
        const costs = { 556: elementalRuneCost(556, 1, s.sdk.getEquipment(), (s.client as any).membersAccount === 1), 563: 1 };
        if (Object.entries(costs).some(([id, n]) => (before[Number(id)] ?? 0) < n)) {
            return { success: false, telegrab: true, skipped: true };
        }
        const stackable = (s.client as any).objType?.(item.id)?.stackable;
        if (typeof stackable !== 'boolean' || !telegrabCapacity(item, s.sdk.getInventory(), stackable)) {
            return { success: false, telegrab: true, skipped: true };
        }
        busy = true;
        blocked = true;
        casts++;
        try {
            try {
                await s.sdk.sendSpellOnGroundItem(item.x, item.z, item.id, componentId('magic:telekinetic_grab'));
            } catch {}
            const paid = () =>
                telegrabReceipt(
                    item,
                    costs,
                    before,
                    telegrabCounts(s.sdk.getInventory()),
                    (s.sdk.getSkillXp('Magic') ?? 0) - xp,
                    43 * (policy.xpMultiplier ?? 1),
                );
            await waitUntil(s, () => fatal() || paid(), { timeoutTicks: 40 });
            const after = telegrabCounts(s.sdk.getInventory());
            for (const id of [556, 563]) {
                runesUsed[id]! += paid() ? costs[id as 556 | 563] : Math.min(costs[id as 556 | 563], Math.max(0, (before[id] ?? 0) - (after[id] ?? 0)));
            }
            if (fatal() || !paid()) throw Error('Telegrab exact rune/XP/loot receipt unconfirmed');
            blocked = false;
            console.log(
                'COMBAT_TELEGRAB '
                    + JSON.stringify({ id: item.id, x: item.x, z: item.z, count: item.count, costs, xp: 43 * (policy.xpMultiplier ?? 1), casts, tick: s.tick() }),
            );
            return { success: true, telegrab: true };
        } finally {
            busy = false;
        }
    };
    const alch = alchPolicy ? createCombatAlch(s, alchPolicy) : undefined;
    let alchPickupBlocked = false;
    const pickup = async (item: GroundItem): Promise<{ success: boolean; telegrab: boolean; skipped?: boolean; acquired?: number; alched?: number }> => {
        if (!alch) return basePickup(item);
        if (alchPickupBlocked || alch.stopped()) throw Error('owned loot alchemy stopped before pickup');
        alchPickupBlocked = true;
        const before = combatAlchCounts(s.sdk.getInventory());
        const used = { ...runesUsed };
        const reply = await basePickup(item);
        const debit = Object.fromEntries(Object.entries(runesUsed).map(([id, n]) => [id, n - (used[+id] ?? 0)]));
        const paid = () => combatLootReceipt(before, combatAlchCounts(s.sdk.getInventory()), item, debit);
        if (reply.skipped) {
            alchPickupBlocked = false;
            return reply;
        }
        if (!(await waitUntil(s, () => alch.stopped() || paid(), { timeoutTicks: 8 })) || alch.stopped() || !paid()) {
            throw Error('owned pickup whole-pack receipt unconfirmed; no alchemy');
        }
        const alched = await alch.afterPickup(item);
        alchPickupBlocked = false;
        return { ...reply, success: true, acquired: item.count, alched };
    };
    return {
        pickup,
        get blocked() {
            return blocked || alchPickupBlocked || !!alch?.blocked;
        },
        get casts() {
            return casts;
        },
        runesUsed,
        alch,
    };
}

// QoL helpers (prayer hold, spec bar enable, cannon refill, drops, run toggle, special swap)
export async function holdPrayer(s: CombatSession, index: number, ticks: number, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 14 || !Number.isSafeInteger(ticks) || ticks < 1) throw Error('invalid prayer hold');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const initial = s.sdk.isPrayerActive(index);
    let activated = false;
    let restored = initial;
    let detail = '';
    try {
        if (life.stopped()) throw Error(life.reason());
        if (!initial) {
            const result = await s.bot.activatePrayer(index);
            if (!result.success) throw Error(result.message);
            activated = true;
        }
        if (!s.sdk.isPrayerActive(index)) throw Error('prayer activation unobserved');
        await waitUntil(s, () => life.stopped() || !s.sdk.isPrayerActive(index) || s.tick() - start >= ticks, { timeoutTicks: ticks });
        detail = life.reason() || (!s.sdk.isPrayerActive(index) ? 'prayer hold ended early' : '');
    } catch (error) {
        detail = String(error);
    } finally {
        if (activated) {
            try {
                const r = await s.bot.deactivatePrayer(index);
                restored = r.success && !s.sdk.isPrayerActive(index);
            } catch (error) {
                detail ||= String(error);
            }
        }
    }
    return { ok: !detail && restored, activated, restored, ticks: s.tick() - start, detail };
}

export async function enableSpecial(s: CombatSession, bar: string, minimumEnergy: number, cap: number, stop: () => boolean = () => false) {
    if (
        !/^combat_(blunt|axe|crossbow|bow|stabsword|hacksword|spiked|thrown|spear|claw|pickaxe|polearm|heavysword|unarmed):specbar$/.test(bar)
        || !Number.isSafeInteger(minimumEnergy)
        || minimumEnergy < 1
        || minimumEnergy > 1000
        || !Number.isSafeInteger(cap)
        || cap < 1
    ) {
        throw Error('invalid special order');
    }
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const c = s.client as any;
    if (!Number.isSafeInteger(c?.var?.[300]) || !Number.isSafeInteger(c?.var?.[301])) {
        throw Error('native transmitted special vars unavailable');
    }
    if (!s.sdk.getEquipment().some(i => i.slot === 3)) throw Error('stage a special weapon');
    const before = { energy: c.var[300] as number, enabled: c.var[301] as number };
    if (before.energy < minimumEnergy) throw Error('special energy below explicit threshold');
    if (life.stopped()) return { ok: false, changed: false, energy: before.energy, ticks: 0, detail: life.reason() };
    if (before.enabled === 1) return { ok: true, changed: false, energy: before.energy, ticks: 0, detail: 'special already enabled' };
    await s.sdk.sendClickComponent(componentId(bar));
    await waitUntil(s, () => c.var[301] === 1 || c.var[300] < before.energy || life.stopped(), { timeoutTicks: cap });
    const ok = !life.stopped() && (c.var[301] === 1 || c.var[300] < before.energy);
    return {
        ok,
        changed: ok,
        energy: c.var[300],
        ticks: s.tick() - start,
        detail: life.reason() || (ok ? 'native special state/energy effect' : 'special effect unconfirmed'),
    };
}

export async function refillCannon(s: CombatSession, x: number, z: number, cap: number, stop: () => boolean = () => false) {
    if (![x, z, cap].every(Number.isSafeInteger) || x < 0 || z < 0 || cap < 1) throw Error('invalid cannon refill');
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const count = () => s.sdk.getInventory().filter(i => i.id === 2).reduce((n, i) => n + i.count, 0);
    const loc = s.sdk.getState()?.nearbyLocs.find(l => l.id === 6 && l.x === x && l.z === z);
    const item = s.sdk.getInventory().find(i => i.id === 2);
    if (!loc || !item) throw Error('stage cannonballs beside selected assembled cannon');
    if (life.stopped()) return { ok: false, loaded: 0, ticks: 0, detail: life.reason() };
    const before = count();
    const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const messageCount = () => {
        const m = (s.sdk.getState()?.gameMessages ?? []).find(
            msg => msg.type === 0 && (msg.observationId ?? msg.tick) > cursor && /You load the cannon with (\d+) cannonballs\./.test(msg.text),
        );
        return m ? Number(m.text.match(/with (\d+) cannonballs/)![1]) : 0;
    };
    await s.sdk.sendUseItemOnLoc(item.slot, x, z, 6);
    await waitUntil(s, () => (before > count() && messageCount() === before - count()) || life.stopped(), { timeoutTicks: cap });
    const loaded = before - count();
    const ok = !life.stopped() && loaded > 0 && loaded <= 30 && messageCount() === loaded;
    return {
        ok,
        loaded,
        ticks: s.tick() - start,
        detail: life.reason() || (ok ? 'owned native cannon loaded' : 'cannon ownership/capacity/load effect unconfirmed'),
    };
}

export type QolDropOrder = { ids: number[]; names: string[]; mode: 'listed' | 'except'; order: 'slot' | 'reverse' | 'column'; maximumDrops: number; cap: number };

export function qolDropSelection(rows: readonly { id: number; name: string; slot: number; count: number }[], o: QolDropOrder) {
    if (
        !o
        || !Array.isArray(o.ids)
        || !Array.isArray(o.names)
        || !['listed', 'except'].includes(o.mode)
        || !['slot', 'reverse', 'column'].includes(o.order)
        || !Number.isSafeInteger(o.maximumDrops)
        || o.maximumDrops < 1
        || o.maximumDrops > 28
        || !Number.isSafeInteger(o.cap)
        || o.cap < 1
        || o.cap > 1000
        || o.ids.some(id => !Number.isSafeInteger(id) || id < 0)
        || o.names.some(n => typeof n !== 'string' || !n.trim())
        || o.ids.length + o.names.length < 1
    ) {
        throw Error('explicit finite native drop selection required');
    }
    if (
        new Set(rows.map(i => i.slot)).size !== rows.length
        || rows.some(i => !Number.isSafeInteger(i.slot) || i.slot < 0 || i.slot > 27 || !Number.isSafeInteger(i.count) || i.count < 1)
    ) {
        throw Error('drop inventory unknown');
    }
    const names = o.names.map(n => n.trim().toLowerCase());
    const selected = rows.filter(i => {
        const listed = o.ids.includes(i.id) || names.includes(i.name.toLowerCase());
        return o.mode === 'listed' ? listed : !listed;
    });
    return selected
        .sort((a, b) =>
            o.order === 'reverse'
                ? b.slot - a.slot
                : o.order === 'column'
                    ? (a.slot % 4) - (b.slot % 4) || Math.floor(a.slot / 4) - Math.floor(b.slot / 4)
                    : a.slot - b.slot,
        )
        .slice(0, o.maximumDrops);
}

// Energy potion support (used by chompy trips)
export const ORB_ENERGY = [
    { id: 3008, next: 3010, doses: 4, gain: 10 },
    { id: 3010, next: 3012, doses: 3, gain: 10 },
    { id: 3012, next: 3014, doses: 2, gain: 10 },
    { id: 3014, next: 229, doses: 1, gain: 10 },
    { id: 3016, next: 3018, doses: 4, gain: 20 },
    { id: 3018, next: 3020, doses: 3, gain: 20 },
    { id: 3020, next: 3022, doses: 2, gain: 20 },
    { id: 3022, next: 229, doses: 1, gain: 20 },
] as const;

export async function drinkOrbEnergy(s: CombatSession, id: number, alive: () => boolean) {
    const recipe = ORB_ENERGY.find(e => e.id === id);
    const row = s.sdk.getInventory().find(i => i.id === id);
    const before = packCounts(s);
    const cursor = msgCursor(s);
    const energy = s.sdk.getState()?.player?.runEnergy;
    if (!recipe || !row || typeof energy !== 'number' || energy >= 100 || !alive()) {
        throw Error('orb native energy input/state absent');
    }
    await s.sdk.sendUseItem(row.slot, 1);
    const delta = { [id]: -1, [recipe.next]: 1 };
    const remaining = recipe.doses - 1;
    const completion = remaining === 0 ? 'You have finished your potion.' : `You have ${remaining} dose${remaining === 1 ? '' : 's'} of potion left.`;
    const settled = () => (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text === completion);
    const paid = () =>
        packDeltaMatches(before, packCounts(s), delta) && (s.sdk.getState()?.player?.runEnergy ?? -1) >= Math.min(100, energy + recipe.gain) - 1 && settled();
    if (!(await waitUntil(s, () => !alive() || paid(), { timeoutTicks: 8 })) || !alive() || !paid()) {
        throw Error('orb energy dose/energy receipt unconfirmed');
    }
    return delta;
}

// Ground loot primitives
export function selectGroundLoot(
    s: BotWorldState,
    p: LootPolicy,
    definition: (id: number) => LootDefinition | undefined,
    left = p.maximumUnits,
) {
    const items = s.groundItems;
    const len = items.length;
    if (len === 0) return undefined;
    let conflicts: Map<number | string, number> | undefined;
    if (len > 1) {
        conflicts = new Map();
        for (let idx = 0; idx < len; idx++) {
            const g = items[idx]!;
            const key = g.id >= 0 && g.id < 1048576 && g.x >= 0 && g.x < 16384 && g.z >= 0 && g.z < 16384
                ? g.id * 268435456 + g.x * 16384 + g.z
                : `${g.id}:${g.x}:${g.z}`;
            const prev = conflicts.get(key);
            if (prev === undefined) conflicts.set(key, g.count);
            else if (prev !== g.count) conflicts.set(key, -1);
        }
    }
    const players = s.nearbyPlayers;
    const pLen = players.length;
    let bestItem: GroundItem | undefined;
    let bestValue = -1;
    for (let idx = 0; idx < len; idx++) {
        const i = items[idx]!;
        if (conflicts) {
            const key = i.id >= 0 && i.id < 1048576 && i.x >= 0 && i.x < 16384 && i.z >= 0 && i.z < 16384
                ? i.id * 268435456 + i.x * 16384 + i.z
                : `${i.id}:${i.x}:${i.z}`;
            if (conflicts.get(key) === -1) continue;
        }
        if (
            i.reachable === false
            || i.distance > p.radius
            || !Number.isSafeInteger(i.count)
            || i.count < 1
            || i.count > left
        ) {
            continue;
        }
        const d = definition(i.id);
        if (!d || !Number.isSafeInteger(d.cost) || d.cost < 0) continue;
        const value = i.count * d.cost;
        if (!Number.isSafeInteger(value) || !lootMatches(i, p, d) || !lootCapacity(s, i, d)) continue;
        let blocked = false;
        for (let pi = 0; pi < pLen; pi++) {
            const player = players[pi]!;
            if (Math.abs(player.x - i.x) <= 1 && Math.abs(player.z - i.z) <= 1) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        if (bestItem === undefined || value > bestValue || (value === bestValue && i.distance < bestItem.distance)) {
            bestItem = i;
            bestValue = value;
        }
    }
    return bestItem ? { item: bestItem, value: bestValue } : undefined;
}

export function groundLootEffect(before: BotWorldState, after: BotWorldState, item: GroundItem): boolean {
    const stockOf = (st: BotWorldState) => {
        const n: Record<number, number> = {};
        for (const i of st.inventory) n[i.id] = (n[i.id] ?? 0) + i.count;
        return n;
    };
    const b = stockOf(before);
    const a = stockOf(after);
    let changed = false;
    for (const k in b) {
        const id = Number(k);
        if ((a[id] ?? 0) !== (b[id] ?? 0)) {
            changed = true;
            break;
        }
    }
    if (!changed) {
        for (const k in a) {
            if (!(k in b) && (a[Number(k)] ?? 0) !== 0) {
                changed = true;
                break;
            }
        }
    }
    if (!changed) return false;
    for (const k in b) {
        const id = Number(k);
        if ((a[id] ?? 0) - (b[id] ?? 0) !== (id === item.id ? item.count : 0)) {
            throw Error('ground pickup inventory delta does not reconcile');
        }
    }
    for (const k in a) {
        if (k in b) continue;
        const id = Number(k);
        if ((a[id] ?? 0) !== (id === item.id ? item.count : 0)) {
            throw Error('ground pickup inventory delta does not reconcile');
        }
    }
    return true;
}

export interface LootDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stop: () => boolean;
    definition: (id: number) => LootDefinition | undefined;
    pickup: (i: GroundItem) => Promise<boolean>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
    clearModal?: () => Promise<void>;
}

export async function runVisibleGroundLoot(d: LootDriver, p: LootPolicy) {
    if (
        !validLootFilters(p)
        || ![p.maximumUnits, p.cap, p.idleTicks, p.radius].every(n => Number.isSafeInteger(n) && n > 0)
        || p.radius > 12
        || !Number.isSafeInteger(p.minimumValue)
        || p.minimumValue < 0
        || !Number.isSafeInteger(p.maximumValue)
        || p.maximumValue < p.minimumValue
    ) {
        throw Error('invalid finite ground-loot policy');
    }
    const initial = d.state();
    const hpOf = (st: BotWorldState) => st.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    const stockOf = (st: BotWorldState) => {
        const n: Record<number, number> = {};
        for (const i of st.inventory) n[i.id] = (n[i.id] ?? 0) + i.count;
        return n;
    };
    if (!initial?.player || hpOf(initial) < 1) throw Error('ground-loot state unknown');
    const start = d.tick();
    let units = 0;
    let pickups = 0;
    let staticValue = 0;
    let progress = start;
    const acquired: Record<number, number> = {};
    const initialKit = initial.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
    const kitUnchanged = (eq: readonly { id: number; slot: number; count: number }[]) => {
        if (eq.length !== initialKit.length) return false;
        for (let i = 0; i < initialKit.length; i++) {
            const want = initialKit[i]!;
            const direct = eq[i];
            if (direct && direct.slot === want.slot && direct.id === want.id && direct.count === want.count) continue;
            let matched = false;
            for (let j = 0; j < eq.length; j++) {
                const cur = eq[j]!;
                if (cur.slot === want.slot && cur.id === want.id && cur.count === want.count) {
                    matched = true;
                    break;
                }
            }
            if (!matched) return false;
        }
        return true;
    };
    const initialHp = hpOf(initial);
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('ground-loot session ended');
        if (d.stop()) throw Error('ground-loot stopped');
        if (d.tick() - start >= p.cap) throw Error('ground-loot cap');
        if (
            s.player.lifeId !== initial.player!.lifeId
            || s.player.level !== initial.player!.level
            || s.player.isDead
            || hpOf(s) !== initialHp
            || Math.max(Math.abs(s.player.worldX - initial.player!.worldX), Math.abs(s.player.worldZ - initial.player!.worldZ)) > p.radius
        ) {
            throw Error('ground-loot health, life or area changed');
        }
        if (!kitUnchanged(s.equipment)) {
            throw Error('ground-loot equipment changed');
        }
        return s;
    };
    while (units < p.maximumUnits) {
        let before = state();
        if (d.tick() - progress >= p.idleTicks) throw Error('ground-loot no eligible pickup progress');
        if (before.dialog?.isOpen || before.interface?.isOpen) {
            if (!d.clearModal) throw Error('ground-loot modal blocked');
            await d.clearModal();
            before = state();
        }
        const scoped = {
            ...before,
            groundItems: before.groundItems.filter(
                i => Math.max(Math.abs(i.x - initial.player!.worldX), Math.abs(i.z - initial.player!.worldZ)) <= p.radius,
            ),
        };
        const selected = selectGroundLoot(scoped, p, d.definition, p.maximumUnits - units);
        if (!selected) {
            await d.step();
            continue;
        }
        const target = { ...selected.item };
        if (!(await d.pickup(target))) throw Error('native ground pickup refused');
        await d.wait(
            () => {
                const s = state();
                return groundLootEffect(before, s, target) || !s.groundItems.some(i => i.id === target.id && i.x === target.x && i.z === target.z);
            },
            Math.min(12, p.cap - (d.tick() - start)),
        );
        if (!groundLootEffect(before, state(), target)) {
            await d.step();
            if (!groundLootEffect(before, state(), target)) throw Error('ground disappeared without own inventory receipt');
        }
        units += target.count;
        pickups++;
        staticValue += selected.value;
        acquired[target.id] = (acquired[target.id] ?? 0) + target.count;
        progress = d.tick();
        if (units < p.maximumUnits) await d.step();
    }
    const b = stockOf(initial);
    const a = stockOf(state());
    const all = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(acquired)].map(Number));
    if (![...all].every(id => (a[id] ?? 0) - (b[id] ?? 0) === (acquired[id] ?? 0))) {
        throw Error('ground-loot final inventory audit failed');
    }
    return {
        units,
        pickups,
        acquired,
        staticValue,
        valueSource: 'native static item cost; not GE price',
        ticks: d.tick() - start,
        banked: 0,
        attribution: 'visible native pickup and owned inventory receipt; no kill-credit claim',
    };
}

// Wilderness & Escape survivability guards
export const EDGEVILLE_BANK = { x: 3092, z: 3496 } as const;
export const DRAGONFIRE_SHIELD_ID = 1540;
export const GREEN_DRAGON_ID = 941;
export const DRAGON_BONES_ID = 536;
export const GREEN_DHIDE_ID = 1753;
export const GREEN_DRAGON_SPOT = { x: 3092, z: 3810 } as const;
export const SAFE_SOUTH_TILE = { x: 3092, z: 3518 } as const;
export const DRAGON_FOOD_IDS = [385, 373, 379, 329, 333] as const;
export const DRAGON_LOOT_IDS = new Set<number>([DRAGON_BONES_ID, GREEN_DHIDE_ID, 561, 563, 995, 1213, 449, 447]);
const WILD_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export function fleetNames(owners = loadOwners()): Set<string> {
    return new Set([...owners.keys(), 'haggis'].map(n => n.toLowerCase()));
}

export const wildernessLevel = (z: number) => (z >= 9920 ? Math.floor((z - 9920) / 8) + 1 : z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0);

export function wildLevel(x: number, z: number): number {
    if (x < 2944 || x > 3391 || z < 3520 || z > 3967) return 0;
    return Math.floor((z - 3520) / 8) + 1;
}

export function attackable(me: { z: number; combatLevel: number }, other: { z: number; combatLevel: number }): boolean {
    const level = Math.min(wildernessLevel(me.z), wildernessLevel(other.z));
    return level > 0 && Math.abs(me.combatLevel - other.combatLevel) <= level;
}

export function combatTeleportAllowed(p: { worldX: number; worldZ: number; level: number }): boolean {
    if (p.worldX < 2944 || p.worldX > 3391) return true;
    const bottom =
        p.worldZ >= 9920 && p.worldZ <= 12799 && p.level === 0
            ? 9920
            : p.worldZ >= 3520 && p.worldZ <= 6399 && p.level <= 3
                ? 3520
                : undefined;
    return bottom === undefined || Math.floor((p.worldZ - bottom) / 8) + 1 <= 20;
}

export type WildernessEscapeLoc = {
    id: number;
    kind: 'lever' | 'ladder' | 'gate' | 'web';
    name: string;
    option: string;
    x: number;
    z: number;
    wildLevel: number;
};

export const WILDERNESS_ESCAPES: readonly WildernessEscapeLoc[] = [
    { id: 1815, kind: 'lever', name: 'Deserted Keep lever', option: 'Pull', x: 3153, z: 3923, wildLevel: 51 },
    { id: 2871, kind: 'ladder', name: 'Mage Bank cellar ladder', option: 'Climb-down', x: 3091, z: 3957, wildLevel: 55 },
    { id: 733, kind: 'web', name: 'Mage Bank east web', option: 'Slash', x: 3095, z: 3957, wildLevel: 55 },
    { id: 733, kind: 'web', name: 'Mage Bank west web', option: 'Slash', x: 3093, z: 3957, wildLevel: 55 },
    { id: 1765, kind: 'ladder', name: 'Wilderness mirror ladder west', option: 'Climb-down', x: 3017, z: 3849, wildLevel: 42 },
    { id: 1767, kind: 'ladder', name: 'Wilderness mirror ladder east', option: 'Climb-down', x: 3069, z: 3856, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'Lava Maze gate', option: 'Open', x: 3071, z: 3857, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'KBD fence gate', option: 'Open', x: 3008, z: 3850, wildLevel: 42 },
    { id: 1596, kind: 'gate', name: 'West Wilderness gate', option: 'Open', x: 2948, z: 3904, wildLevel: 49 },
    { id: 1596, kind: 'gate', name: 'East Wilderness deep gate', option: 'Open', x: 3202, z: 3856, wildLevel: 43 },
    { id: 1596, kind: 'gate', name: 'East Wilderness fence gate', option: 'Open', x: 3225, z: 3904, wildLevel: 49 },
];

export type WildernessEscapePlan = {
    kind: 'out' | 'glory' | 'teleport' | 'lever' | 'ladder' | 'run';
    distance: number;
    loc?: WildernessEscapeLoc;
    web?: WildernessEscapeLoc;
    obstacle?: WildernessEscapeLoc;
    detail: string;
};

const WILDERNESS_EXITS = WILDERNESS_ESCAPES.filter(e => e.id === 1815 || e.id === 2871);
const MAGE_BANK_EAST_WEB = WILDERNESS_ESCAPES.find(w => w.id === 733 && w.x === 3095 && w.z === 3957);
const WILDERNESS_OBSTACLES = WILDERNESS_ESCAPES.filter(e => e.kind === 'gate' || e.kind === 'web');

export function planWildernessEscape(pos: { x: number; z: number }, has: { glory: boolean; teleport: boolean }): WildernessEscapePlan {
    const level = wildLevel(pos.x, pos.z);
    if (level === 0) return { kind: 'out', distance: 0, detail: 'outside Wilderness' };
    if (has.glory && level <= 30) return { kind: 'glory', distance: 0, detail: `glory at level ${level}` };
    if (has.teleport && level <= 20) return { kind: 'teleport', distance: 0, detail: `teleport at level ${level}` };
    const targetZ = has.glory ? 3755 : has.teleport ? 3675 : 3518;
    const southDist = Math.max(0, pos.z - targetZ);
    let bestLoc: WildernessEscapeLoc | undefined;
    let bestDist = Infinity;
    for (let i = 0; i < WILDERNESS_EXITS.length; i++) {
        const e = WILDERNESS_EXITS[i]!;
        const dist = Math.max(Math.abs(pos.x - e.x), Math.abs(pos.z - e.z));
        if (dist < bestDist) {
            bestDist = dist;
            bestLoc = e;
        }
    }
    if (bestLoc && bestDist <= 35 && bestDist < southDist) {
        const web = bestLoc.id === 2871 && pos.x >= 3093 ? MAGE_BANK_EAST_WEB : undefined;
        return {
            kind: bestLoc.kind as 'lever' | 'ladder',
            loc: bestLoc,
            web,
            distance: bestDist,
            detail: `${bestLoc.name} (${bestDist} tiles)`,
        };
    }
    let obstacle: WildernessEscapeLoc | undefined;
    for (let i = 0; i < WILDERNESS_OBSTACLES.length; i++) {
        const e = WILDERNESS_OBSTACLES[i]!;
        if (Math.abs(e.x - pos.x) <= 6 && e.z <= pos.z && pos.z - e.z <= 20) {
            obstacle = e;
            break;
        }
    }
    return { kind: 'run', obstacle, distance: southDist, detail: `run south to level ${has.glory ? 30 : has.teleport ? 20 : 0}` };
}

const LAW_RUNE_RE = /^law rune$/i;
const AIR_RUNE_RE = /^air rune$/i;
const FIRE_RUNE_RE = /^fire rune$/i;
const AIR_STAFF_RE = /staff of air|air battlestaff|mystic air staff/i;
const FIRE_STAFF_RE = /staff of fire|fire battlestaff|mystic fire staff/i;

export function hasVarrockTeleport(
    magic: number,
    inventory: readonly { name: string; count?: number }[],
    equipment: readonly { name: string }[],
): boolean {
    if (magic < 25) return false;
    let law = 0;
    let air = 0;
    let fire = 0;
    for (let i = 0; i < inventory.length; i++) {
        const item = inventory[i]!;
        const count = item.count ?? 1;
        if (LAW_RUNE_RE.test(item.name)) law += count;
        else if (AIR_RUNE_RE.test(item.name)) air += count;
        else if (FIRE_RUNE_RE.test(item.name)) fire += count;
    }
    if (law < 1) return false;
    let airOk = air >= 3;
    let fireOk = fire >= 1;
    if (!airOk || !fireOk) {
        for (let i = 0; i < equipment.length; i++) {
            const name = equipment[i]!.name;
            if (!airOk && AIR_STAFF_RE.test(name)) airOk = true;
            if (!fireOk && FIRE_STAFF_RE.test(name)) fireOk = true;
            if (airOk && fireOk) break;
        }
    }
    return airOk && fireOk;
}

export function wildDragonPreflight(state: BotWorldState | null, requireFood = true): string | null {
    if (!state?.player) return 'state unknown';
    if (!state.equipment.some(i => i.slot === 5 && i.id === DRAGONFIRE_SHIELD_ID)) return 'Dragonfire shield (1540) must be worn in shield slot';
    if (!state.equipment.some(i => i.slot === 3)) return 'melee weapon must be worn in weapon slot';
    if (requireFood && !state.inventory.some(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id))) return 'food required in inventory';
    return null;
}

export function wildDragonThreat(state: BotWorldState, ours: ReadonlySet<string> = fleetNames()): NearbyPlayer | null {
    const p = state.player;
    if (!p || wildernessLevel(p.worldZ) <= 0) return null;
    return state.nearbyPlayers.find(other => !ours.has(other.name.toLowerCase()) && attackable({ z: p.worldZ, combatLevel: p.combatLevel }, other)) ?? null;
}

export function selectGreenDragon(npcs: readonly NearbyNpc[], selfSlot?: number): NearbyNpc | undefined {
    const selfTarget = Number.isInteger(selfSlot) ? 32768 + selfSlot! : -1;
    let best: NearbyNpc | undefined;
    let bestMine = false;
    let bestDist = Infinity;
    for (let i = 0; i < npcs.length; i++) {
        const n = npcs[i]!;
        if (n.id !== GREEN_DRAGON_ID || n.reachable === false || (n.hp ?? 1) <= 0) continue;
        const mine = n.targetIndex === selfTarget;
        if (n.inCombat && !mine) continue;
        if (
            best === undefined
            || (mine && !bestMine)
            || (mine === bestMine && n.distance < bestDist)
        ) {
            best = n;
            bestMine = mine;
            bestDist = n.distance;
        }
    }
    return best;
}

export function wildDragonRetreatReason(
    state: BotWorldState,
    o: { eatAt: number; escapeAt: number },
    ours: ReadonlySet<string> = fleetNames(),
): string | null {
    const hp = state.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    const food = state.inventory.filter(i => (DRAGON_FOOD_IDS as readonly number[]).includes(i.id)).reduce((n, i) => n + i.count, 0);
    if (!state.equipment.some(i => i.slot === 5 && i.id === DRAGONFIRE_SHIELD_ID)) return 'shield-missing';
    if (hp <= o.escapeAt) return 'low-hp';
    if (food === 0 && hp <= o.eatAt) return 'out-of-food';
    if (state.inventory.length >= 28) return 'pack-full';
    if (wildDragonThreat(state, ours)) return 'pker-threat';
    return null;
}

export function wildDragonEscapeAction(state: BotWorldState) {
    const p = state.player;
    if (!p) return { kind: 'out' as const, distance: 0, detail: 'state unknown' };
    const magic = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
    const hasPackGlory = state.inventory.some(i => (WILD_GLORY_IDS as readonly number[]).includes(i.id));
    const hasWornGlory = state.equipment.some(i => i.slot === 2 && (WILD_GLORY_IDS as readonly number[]).includes(i.id));
    const teleport = hasVarrockTeleport(magic, state.inventory, state.equipment);
    return planWildernessEscape({ x: p.worldX, z: p.worldZ }, { glory: hasPackGlory || (hasWornGlory && state.inventory.length < 28), teleport });
}

export function wildDragonEscapeKeep(item: { id: number }, escapeLawReserve = 0): boolean {
    if ((DRAGON_FOOD_IDS as readonly number[]).includes(item.id)) return true;
    if ((WILD_GLORY_IDS as readonly number[]).includes(item.id)) return true;
    if (item.id === 556 || item.id === 554) return true;
    if (item.id === 563 && escapeLawReserve > 0) return true;
    return false;
}

// Navigation, ferry travel, and Edgeville dungeon crossing helpers
export function combatFerryWalk(
    s: CombatSession,
    to: CombatTile,
    walk: (to: CombatTile, budgetMs?: number) => Promise<Outcome>,
): Promise<Outcome> {
    return marketFerryWalk(s as Session, to, walk);
}

export function combatApproach(s: CombatSession, to: CombatTile, stop: () => boolean = () => false): Promise<Outcome> {
    return marketApproach(s as Session, to, stop);
}

export function combatWalkTargetPersist(
    s: CombatSession,
    to: CombatTile,
    tries = 4,
    walk?: (to: CombatTile) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
) {
    return marketWalkTargetPersist(s as Session, to, tries, walk);
}

// Edgeville dungeon crossing for chaos druids / hill giants
function installFloorBridge(client: unknown, pos: { x: number; z: number }) {
    const c = client as any;
    if (!c || typeof c.executeBotAction !== 'function') throw Error('orb native floor executor absent');
    const original = c.executeBotAction;
    const bridge = function (this: unknown, a: any) {
        if (a?.type !== 'orbFloorLoc') return original.call(c, a);
        if (a.x !== 3097 || a.z !== 3468 || ![1568, 1570].includes(a.locId) || !c.isInGame() || !c.localPlayer) {
            throw Error('orb native floor target invalid');
        }
        const at = c.toSceneTile(a.x, a.z);
        const from = c.toSceneTile(pos.x, pos.z);
        const info = at && c.locSceneInfo(at.x, at.z, a.locId);
        if (
            !at
            || !from
            || Math.max(Math.abs(pos.x - a.x), Math.abs(pos.z - a.z)) > 1
            || info?.shape !== 22
            || c.localPlayer.routeX[0] !== from.x
            || c.localPlayer.routeZ[0] !== from.z
        ) {
            throw Error('orb native floor needs observed exact tile');
        }
        c.writeOpcode(ClientProt.OPLOC1);
        c.out.p2(a.x);
        c.out.p2(a.z);
        c.out.p2(a.locId);
        return { success: true };
    };
    c.executeBotAction = bridge;
    return () => {
        if (c.executeBotAction === bridge) c.executeBotAction = original;
    };
}

type EdgeStep = ({ kind: 'walk'; tol: number } & CombatTile) | { kind: 'enter' | 'exit' };
const inEdgeDungeon = (p: CombatTile) => p.z >= 9000;
const inKnownEdgeDungeon = (p: CombatTile) => p.x >= 3070 && p.x <= 3145 && p.z >= 9830 && p.z <= 9950;

export function edgevilleRoute(from: CombatTile, to: CombatTile, target: 'druid' | 'giant', tol = 2): EdgeStep[] {
    if (from.level !== 0 || to.level !== 0) {
        throw Error(`combat travel needs observed native ground (level !== 0: from=${from.level} to=${to.level})`);
    }
    if (![from.x, from.z, to.x, to.z, tol].every(Number.isSafeInteger) || tol < 0) {
        throw Error('combat travel needs observed native ground');
    }
    const goal: EdgeStep = { kind: 'walk', ...to, tol };
    if (inEdgeDungeon(from) === inEdgeDungeon(to)) return [goal];
    if ((inEdgeDungeon(from) && !inKnownEdgeDungeon(from)) || (inEdgeDungeon(to) && !inKnownEdgeDungeon(to))) {
        throw Error('combat travel unknown dungeon crossing');
    }
    const point = (x: number, z: number, t = 1): EdgeStep => ({ kind: 'walk', x, z, level: 0, tol: t });
    if (!inEdgeDungeon(from)) {
        return [point(3097, 3468), { kind: 'enter' }, ...(target === 'druid' ? [point(3131, 9916), point(3131, 9921)] : []), goal];
    }
    return [...(target === 'druid' && from.z >= 9919 ? [point(3131, 9921), point(3131, 9916)] : []), point(3096, 9867), { kind: 'exit' }, goal];
}

export function createEdgevilleTravel(original: CombatSession) {
    const client = original.client as any;
    const first = original.sdk.getState()?.player;
    const bridgeAt = { x: 3097, z: 3467 };
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const restore = installFloorBridge(client, bridgeAt);
    const executor = client.executeBotAction;
    let ended = false;
    let closed = false;
    const close = () => {
        if (!closed) {
            closed = true;
            restore();
        }
    };
    void original.ended.then(() => {
        ended = true;
        close();
    });
    return {
        close,
        async walk(
            s: CombatSession,
            target: 'druid' | 'giant',
            to: CombatTile,
            ground: (x: number, z: number, tol: number) => Promise<boolean>,
            stop: () => boolean,
            tol = 2,
        ) {
            const guard = () => {
                const p = s.sdk.getState()?.player;
                if (
                    closed
                    || ended
                    || stop()
                    || s.client !== client
                    || client.executeBotAction !== executor
                    || !Number.isSafeInteger(life)
                    || !p
                    || p.isDead
                    || p.lifeId !== life
                    || (p.respawnCount ?? 0) !== respawns
                    || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0
                ) {
                    throw Error('combat travel original owner/life/stop');
                }
                if (p.level !== 0) throw Error(`combat travel aborted: level !== 0 (${p.level})`);
                return p;
            };
            const near = (at: CombatTile, r = 3) => {
                const p = guard();
                return p.level === at.level && Math.max(Math.abs(p.worldX - at.x), Math.abs(p.worldZ - at.z)) <= r;
            };
            const move = async (x: number, z: number, t: number) => {
                guard();
                if (!(await ground(x, z, t)) || !near({ x, z, level: 0 }, t)) throw Error('combat travel ground arrival missing');
                guard();
            };
            const cross = async (id: number, at: CombatTile, landed: () => boolean) => {
                guard();
                const loc = s.sdk
                    .getState()
                    ?.nearbyLocs.find(l => l.id === id && l.x === at.x && l.z === at.z && l.level === 0 && l.optionsWithIndex.some(o => o.opIndex === 1));
                if (!loc) throw Error('combat travel exact native transition absent ' + id);
                const geometry = {
                    id,
                    shape: id === 1755 ? 10 : 22,
                    angle: id === 1755 ? 0 : 2,
                    width: 1,
                    height: 1,
                    blockAccessFlags: 0,
                    src: id === 1755 ? 'maps/m48_154.jm2:7044' : 'maps/m48_54.jm2',
                    configSrc: id === 1755 ? 'scripts/_unpack/225/all.loc:9862' : 'general_use/scripts/trapdoors.rs2',
                };
                const endpoint = await interactionApproach(s.sdk, at, geometry);
                if (!endpoint) throw Error('combat travel native approach absent');
                await move(endpoint.x, endpoint.z, 0);
                guard();
                if (!s.sdk.getState()?.nearbyLocs.some(l => l.id === id && l.x === at.x && l.z === at.z && l.level === 0)) {
                    throw Error('combat travel transition changed before input');
                }
                const pack = JSON.stringify(s.sdk.getInventory());
                const gear = JSON.stringify(s.sdk.getEquipment());
                let reply = '';
                try {
                    if (id === 1755) await s.sdk.sendInteractLoc(at.x, at.z, id, 1);
                    else {
                        Object.assign(bridgeAt, endpoint);
                        await s.direct({ type: 'orbFloorLoc', x: at.x, z: at.z, locId: id, reason: 'observed combat dungeon trapdoor' });
                    }
                } catch (error) {
                    reply = String(error);
                }
                if (!(await waitUntil(s, () => {
                    guard();
                    return landed();
                }, { timeoutTicks: 20 })) || !landed()) {
                    throw Error('combat travel transition outcome unknown; no repeat ' + id + ' ' + reply);
                }
                if (JSON.stringify(s.sdk.getInventory()) !== pack || JSON.stringify(s.sdk.getEquipment()) !== gear) {
                    throw Error('combat travel transition changed owned assets');
                }
            };
            const p = guard();
            const steps = edgevilleRoute({ x: p.worldX, z: p.worldZ, level: p.level }, to, target, tol);
            for (const step of steps) {
                guard();
                if (step.kind === 'walk') {
                    await move(step.x, step.z, step.tol);
                    continue;
                }
                if (step.kind === 'enter') {
                    const at = { x: 3097, z: 3468, level: 0 };
                    if (s.sdk.getState()?.nearbyLocs.some(l => l.id === 1568 && l.x === at.x && l.z === at.z)) {
                        await cross(1568, at, () => s.sdk.getState()?.nearbyLocs.some(l => l.id === 1570 && l.x === at.x && l.z === at.z) === true);
                    }
                    await cross(1570, at, () => near({ x: 3096, z: 9867, level: 0 }));
                } else {
                    await cross(1755, { x: 3096, z: 9867, level: 0 }, () => near({ x: 3096, z: 3467, level: 0 }));
                }
                if (!(await waitUntil(s, () => {
                    guard();
                    return (s.sdk.getState()?.player?.animId ?? -1) === -1;
                }, { timeoutTicks: 12 }))) {
                    throw Error('combat travel animation did not settle');
                }
                await waitTicks(s, 3);
                guard();
            }
            return near(to, tol);
        },
    };
}

// Bank-trip runner used by shade trips and loot trips
export async function runCombatBankProfile(
    s: CombatSession,
    j: BankRouteJob,
    p: BankProfile,
    requestStop: () => boolean = () => false,
) {
    validateBankRouteJob(j);
    const sess = s as Session;
    const start = s.tick();
    const first = s.sdk.getState()?.player;
    const initialLife = first?.lifeId;
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let ended = false;
    void s.ended.then(() => {
        ended = true;
    });
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => countPackItems(inv(), id);
    const bankCount = (id: number) => countPackItems(s.bankObservation?.()?.items ?? [], id);
    const related = new Set([...Object.keys(p.inputs).map(Number), ...p.tools, ...p.outputs]);
    const protectedPack = new Map(inv().filter(i => !related.has(i.id)).map(i => [i.id, count(i.id)]));
    const dead = () => {
        const st = s.sdk.getState()?.player;
        return ended || !first || !st || st.isDead || st.lifeId !== initialLife || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0;
    };
    const stop = () =>
        dead()
        || requestStop()
        || existsSync(`.practice/stop-${s.name}`)
        || existsSync('.practice/stop-all')
        || s.tick() - start >= j.cap - j.returnTicks
        || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0;
    const returningStop = () => dead() || s.tick() - start >= j.cap;
    const observedBank = () => {
        const at = s.sdk.getState()?.player;
        return (
            !dead()
            && !!at
            && at.level === p.bank.level
            && Math.max(Math.abs(at.worldX - p.bank.x), Math.abs(at.worldZ - p.bank.z)) <= 3
        );
    };
    let completed = 0;
    let trips = 0;
    const banked: Record<number, number> = {};
    let failure = '';
    let atBank = observedBank();
    let recoveryDeferred = false;
    let preparation: Record<string, unknown> | undefined = { status: 'unknown' };

    const travel = async (to: CombatTile, returning = false) => {
        atBank = observedBank();
        const check = returning ? returningStop : stop;
        if (check()) throw Error('bank job stopped before travel');
        const atStart = s.sdk.getState()?.player;
        const tol = bankTravelTolerance(j.family, to === p.site);
        if (atStart && atStart.level === to.level && Math.max(Math.abs(atStart.worldX - to.x), Math.abs(atStart.worldZ - to.z)) <= tol) return;
        const controller = new AbortController();
        const off = s.onTick(() => {
            if (check()) controller.abort('bank job travel bound');
        });
        try {
            const from = s.sdk.getState()?.player;
            const remaining = Math.max(1, j.cap - (s.tick() - start));
            const result =
                from && from.level === to.level && Math.max(Math.abs(from.worldX - to.x), Math.abs(from.worldZ - to.z)) <= 128
                    ? await walkPath(await sessionWalker(sess), [{ ...to, tol }], { stop: check })
                    : await goTo(sess, await getWorld(), to, accountOf(sess), {
                          signal: controller.signal,
                          legTimeoutTicks: Math.min(120, remaining),
                          maxRetriesPerLeg: 1,
                      });
            if (!result.ok) throw Error('bank job route ' + result.detail);
            const at = s.sdk.getState()?.player;
            atBank = !!at && at.level === p.bank.level && Math.max(Math.abs(at.worldX - p.bank.x), Math.abs(at.worldZ - p.bank.z)) <= 3;
        } finally {
            off();
            atBank = observedBank();
        }
    };
    const open = async () => {
        if (returningStop()) throw Error('bank job bank budget exhausted');
        if (s.sdk.getState()?.bank.isOpen && s.bankObservation?.()) return;
        await s.sdk.sendCloseModal();
        await waitUntil(s, () => !s.sdk.getState()?.interface.isOpen && !s.sdk.getState()?.dialog.isOpen, { timeoutTicks: 8 });
        const g = s.bankObservation?.()?.generation ?? -1;
        const result = await s.bot.openBank();
        if (!result.success || !(await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > g, { timeoutTicks: 12 }))) {
            throw Error('bank job fresh bank unavailable');
        }
    };
    const secure = async (credit: boolean) => {
        await open();
        for (const id of related) {
            const item = inv().find(i => i.id === id);
            if (item) {
                const n = await depositObserved(sess, item);
                if (credit && p.outputs.includes(id)) banked[id] = (banked[id] ?? 0) + n;
            }
        }
    };
    try {
        if (!first || hp0 < 1) throw Error('bank job initial state missing');
        await travel(p.bank);
        await secure(false);
        while (completed < j.target) {
            if (stop()) throw Error('bank job stopped before refill');
            preparation = { status: 'unknown' };
            await open();
            const remaining = j.target - completed;
            const type = s.client as { objType: (id: number) => { stackable: boolean } };
            const observation = s.bankObservation?.();
            if (!observation) throw Error('bank job fresh bank unavailable');
            const stackable = (id: number) => {
                const value = type.objType(id)?.stackable;
                if (typeof value !== 'boolean') throw Error('native item stackability unknown ' + id);
                return value;
            };
            const freeSlots = 28 - inv().length;
            const amount = fittingBankBatch(p.inputs, p.tools, Math.min(j.batch, remaining), freeSlots, stackable, p.capacityOutputs);
            if (amount < 1) {
                preparation = { status: 'no-capacity', generation: observation.generation, amount: 0, shortfalls: {}, missingTools: [] };
                throw Error('bank job pack cannot fit a batch');
            }
            const bankStock: Record<number, number> = {};
            for (const item of observation.items) bankStock[item.id] = (bankStock[item.id] ?? 0) + item.count;
            const options = { inputs: p.inputs, tools: p.tools, outputs: p.capacityOutputs, bankStock, reserve: j.reserve, freeSlots, stackable };
            const schedule = planBankTripSchedule({ ...options, target: amount });
            const order = planBankTripSchedule({ ...options, target: remaining });
            preparation = {
                status: schedule.ready ? 'ready' : 'short',
                generation: observation.generation,
                amount,
                shortfalls: schedule.shortfalls,
                missingTools: schedule.missingTools,
                orderShortfalls: order.shortfalls,
            };
            if (!schedule.ready) throw Error('bank job stock short ' + JSON.stringify({ inputs: schedule.shortfalls, tools: schedule.missingTools }));
            const withdrawals = new Map<number, number>();
            for (const id of new Set(p.tools)) withdrawals.set(id, count(id) ? 0 : 1);
            for (const [id, n] of Object.entries(p.inputs)) withdrawals.set(Number(id), (withdrawals.get(Number(id)) ?? 0) + n * amount);
            for (const [id, n] of withdrawals) {
                if (!n) continue;
                if (stop()) throw Error('bank job stopped before withdrawal');
                const row = s.sdk.getState()?.bank.items.find(i => i.id === id);
                if (!row || bankCount(id) - n < (Object.hasOwn(p.inputs, id) ? j.reserve ?? 0 : 0)) {
                    throw Error('bank job stock short ' + id);
                }
                const before = count(id);
                const stored = bankCount(id);
                const g = s.bankObservation!()!.generation;
                await s.bot.withdrawItem(row, n, { asNote: false });
                if (
                    !(await waitUntil(
                        s,
                        () => count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? -1) > g,
                        { timeoutTicks: 10 },
                    ))
                ) {
                    throw Error('bank job withdrawal does not reconcile ' + id);
                }
            }
            await s.bot.closeBank();
            if (!(await waitUntil(s, () => !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 }))) throw Error('bank job bank remains open');
            await p.prepare?.(stop);
            await travel(p.site);
            const actual = await p.run(amount, j.cap - j.returnTicks - (s.tick() - start), stop);
            completed += actual ?? amount;
            trips++;
            await waitTicks(s, 3);
            await travel(p.bank, true);
            await secure(true);
        }
    } catch (error) {
        failure = String(error);
        try {
            recoveryDeferred = p.deferBankRecovery?.() ?? false;
        } catch (decision) {
            recoveryDeferred = true;
            failure += '; recovery decision ' + String(decision);
        }
        try {
            if (!dead() && !recoveryDeferred) {
                for (const item of inv()) if (!protectedPack.has(item.id)) related.add(item.id);
                await s.sdk.sendCloseModal();
                await travel(p.bank, true);
                await secure(true);
            }
        } catch (recovery) {
            failure += '; return ' + String(recovery);
        }
    } finally {
        if (!dead() && !recoveryDeferred) await s.bot.closeBank();
    }
    atBank = observedBank();
    if ([...protectedPack].some(([id, n]) => count(id) !== n)) failure += '; protected stock changed';
    if ((s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0) failure += '; health changed';
    const ok = !failure && completed >= j.target && atBank && !dead() && !requestStop() && s.tick() - start < j.cap;
    return {
        ok,
        family: j.family,
        recipe: j.recipe,
        completed,
        trips,
        banked,
        atBank,
        recoveryDeferred,
        ticks: s.tick() - start,
        failure: failure || '-',
        ...(preparation ? { preparation } : {}),
    };
}

export { depositObserved, depositPack, sessionDied };
