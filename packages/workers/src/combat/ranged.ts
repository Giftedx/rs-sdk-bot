import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BotWorldState, GroundItem, NearbyNpc } from '../../../../vendor/rs-sdk/sdk/types';
import { accountOf, finish, getWorld, openBot, serverFromEnv, sessionDied, settle } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { isLocalServer } from '../../../core/src/localserver';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { questFlags } from '../../../core/src/quest-status';
import { planTripOffThread } from '../../../core/src/route-plan';
import { holdSessionEater, startQuestSustain } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { expandPath, goTo, sessionWalker, walkPath, walkRoute, type PathPoint } from '../../../core/src/walk';
import { routeFares, type Account } from '../../../core/src/world';
import { buyWithBudget } from '../market/shop-buy';
import { orderPaths } from '../market/ge-common';
import { runOwnedItem } from '../market/ge-buy';
import type { ItemRequest } from '../market/types';
import { ARROWS, BOWS, LOWE_ARROWS, MIN_TRIP_ARROWS, bestBow, chooseArrow, gearById, usableArrows } from './gear';
import { TROOPER_SITE, runGiants } from './melee-gather';
import {
    combatAlchPolicy,
    combatPotionPolicy,
    combatPotionSession,
    createCombatLoot,
    createCombatPotions,
    combatFerryWalk,
    makeRangedHealer,
    runVisibleGroundLoot,
    type CombatPotionPolicy,
    type LootQuoteSnapshot,
    type PreparedCombatAlch,
    type TelegrabPolicy,
    telegrabPolicy,
} from './survivability';
import { combatTrip } from './trip-kit';
import type { CombatSession } from './types';
import { countPackItems } from './xp';

export {
    ARROWS,
    BOWS,
    LOWE_ARROWS,
    MIN_TRIP_ARROWS,
    bestBow,
    chooseArrow,
    makeRangedHealer,
    usableArrows,
};

type Item = { id: number; count: number };

const BOW = 841;
const AMMO = 884;
const COINS = 995;
const BONES = 526;
const CHICKEN = 2138;
const FEATHER = 314;
const BANK = { x: 3253, z: 3421 };
const LOWE = { x: 3232, z: 3423 };
const WYDIN = { x: 3015, z: 3206 };
const PEN = { x: 3233, z: 3297 };
const LOOT_WINDOW = 12;

const ARROW_IDS: number[] = ARROWS.map(a => a.id);
const BOW_IDS: number[] = BOWS.map(b => b.id);

const OUT: PathPoint[] = [
    { x: 3280, z: 3429, tol: 2 },
    { x: 3275, z: 3380, tol: 2 },
    { x: 3260, z: 3335, tol: 2 },
    { x: 3233, z: 3297, tol: 0 },
];
const BACK: PathPoint[] = [
    { x: 3260, z: 3335, tol: 2 },
    { x: 3275, z: 3380, tol: 2 },
    { x: 3280, z: 3429, tol: 2 },
    { ...BANK, tol: 1 },
];
const FOOD_OUT: PathPoint[] = [
    { x: 3280, z: 3429, tol: 2 },
    { x: 3275, z: 3380, tol: 2 },
    { x: 3260, z: 3335, tol: 2 },
    { x: 3239, z: 3306, tol: 2 },
    { x: 3232, z: 3285, tol: 2 },
    { x: 3226, z: 3262, tol: 2 },
    { x: 3089, z: 3266, tol: 2 },
    { x: 3060, z: 3265, tol: 3 },
    { x: 3047, z: 3237, tol: 3 },
    { x: 3029, z: 3217, tol: 3 },
    { ...WYDIN, tol: 1 },
];
const FOOD_BACK: PathPoint[] = [...FOOD_OUT.slice(0, -1).reverse(), { ...BANK, tol: 1 }];

const STARTER_ROUTE = [
    [3226, 3250],
    [3226, 3262],
    [3232, 3285],
    [3239, 3306],
    [3260, 3335],
    [3275, 3380],
    [3280, 3429],
]
    .map(([x, z]) => ({ x: x!, z: z!, tol: 2 }))
    .concat({ ...BANK, tol: 2 });

const sumCounts = (items: readonly Item[], ids: readonly number[]) => ids.reduce((n, id) => n + countPackItems(items, id), 0);

// Self-contained gather-ranged primitives (`BOW=841`)
export function rangedAmmo(pack: readonly Item[] | undefined, equipment: readonly Item[] | undefined): number | null {
    if (!pack || !equipment || [...pack, ...equipment].some(i => !Number.isSafeInteger(i.id) || !Number.isSafeInteger(i.count) || i.count < 0)) {
        return null;
    }
    return countPackItems(pack, AMMO) + countPackItems(equipment, AMMO);
}

export const rangedCredit = (gone: boolean, xp: number, bones: number, chicken: number, elapsed = 0) =>
    gone && Number.isFinite(xp) && xp >= 300 && xp <= 500 && xp % 100 === 0 && elapsed >= 0 && elapsed <= 180 && bones >= 1 && chicken >= 1;

export function selectRangedTarget(npcs: readonly NearbyNpc[], plane: number | undefined) {
    if (plane !== 0) return;
    return npcs
        .filter(
            n =>
                [41, 1017].includes(n.id)
                && n.x >= 3220
                && n.x <= 3248
                && n.z >= 3280
                && n.z <= 3310
                && n.reachable !== false
                && !n.inCombat
                && (n.hp == null || n.maxHp == null || n.hp >= n.maxHp),
        )
        .sort((a, b) => a.distance - b.distance)[0];
}

export async function pickupRangedLoot(s: CombatSession, loot: Pick<ReturnType<typeof createCombatLoot>, 'pickup'>, item: GroundItem) {
    const held = () => countPackItems(s.sdk.getInventory(), item.id);
    const before = held();
    const reply = await loot.pickup(item);
    if (reply.acquired !== undefined) return reply.acquired;
    if (reply.telegrab && !reply.success) throw Error('ranged loot unavailable ' + item.id);
    if (!(await waitUntil(s, () => held() > before, { timeoutTicks: 8 }))) throw Error('ranged pickup effect missing ' + item.id);
    return held() - before;
}

export async function runRanged(
    s: CombatSession,
    o: {
        cap: number;
        maximum: number;
        ammo: number;
        food: number;
        foodId?: number;
        telegrab?: TelegrabPolicy;
        alch?: PreparedCombatAlch;
        potions?: CombatPotionPolicy;
        stop?: () => boolean;
    },
) {
    const potionScope = o.potions ? combatPotionSession(s, () => !!o.stop?.(), o.cap) : undefined;
    if (potionScope) s = potionScope;
    if (
        !Number.isSafeInteger(o.cap)
        || o.cap < 800
        || !Number.isSafeInteger(o.maximum)
        || o.maximum < 1
        || o.maximum > 5
        || !Number.isSafeInteger(o.ammo)
        || o.ammo < 15
        || o.ammo > 200
        || !Number.isSafeInteger(o.food)
        || o.food < 2
        || o.food > 8
    ) {
        throw Error('ranged prerequisite: bounded cap>=800,kills1..5,ammo15..200,food2..8');
    }
    if (o.alch?.ids.some(id => [BOW, AMMO, o.foodId ?? 333].includes(id))) {
        throw Error('ranged alchemy cannot consume declared combat supplies');
    }
    const FOOD = o.foodId ?? 333;
    if (![329, 333].includes(FOOD)) throw Error('ranged prerequisite: unsupported food ID');
    const sess = s as Session;
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const held = (id: number) => countPackItems(inv(), id);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = () => s.sdk.getSkillXp('Ranged') ?? 0;
    if (!(await waitUntil(s, () => hp() > 0 && (s.sdk.getSkill('Ranged')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 }))) {
        throw Error('ranged prerequisite: skill observation unknown');
    }
    const originalRetaliate = st()?.autoRetaliateEnabled;
    if (typeof originalRetaliate !== 'boolean') throw Error('ranged prerequisite: auto-retaliate telemetry unknown');
    const p0 = st()?.player;
    const start = s.tick();
    const initialXp = xp();
    const initialHp = hp();
    const originalEquipment = eq().map(i => i.id);
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - BANK.x), Math.abs(p0.worldZ - BANK.z)) > 4) {
        throw Error('ranged prerequisite: Varrock Eastbank start required');
    }
    if (held(BOW) || held(AMMO) || countPackItems(eq(), BOW) || countPackItems(eq(), AMMO)) {
        throw Error('ranged prerequisite: bow/ammo must start banked');
    }
    let cleanup = false;
    let armed = false;
    let lastObservedAmmo = 0;
    let ammoUnknown = false;
    let ended = false;
    let died = false;
    let hpMin = hp();
    let kills = 0;
    let eaten = 0;
    let pickedAmmo = 0;
    let shotsObserved = 0;
    let bankTrips = 0;
    let failure = '';
    let stop = 'cap';
    void s.ended.then(() => {
        ended = true;
    });
    const off = s.onTick(() => {
        const p = st()?.player;
        hpMin = Math.min(hpMin, hp());
        if (armed) {
            const amount = rangedAmmo(inv(), eq());
            if (amount === null) ammoUnknown = true;
            else {
                shotsObserved += Math.max(0, lastObservedAmmo - amount);
                lastObservedAmmo = amount;
            }
        }
        if (sessionDied(p0, p)) died = true;
    });
    const over = () => ended || died || (!cleanup && !!o.stop?.()) || s.tick() - start >= o.cap;
    let snapshot: Item[] | undefined;
    let initial: Map<number, number> | undefined;
    const capture = () => {
        const b = s.bankObservation?.();
        if (!b) throw Error('ranged bank observation unknown');
        snapshot = b.items.map(i => ({ id: i.id, count: i.count }));
    };
    const stored = (id: number) => countPackItems(snapshot ?? [], id);
    const totals = () => {
        const m = new Map<number, number>();
        for (const i of [...(snapshot ?? []), ...inv(), ...eq()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const open = async () => {
        const generation = s.bankObservation?.()?.generation ?? 0;
        if (!st()?.bank?.isOpen) {
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 }))) {
                throw Error('ranged fresh bank unavailable');
            }
            bankTrips++;
        }
        capture();
    };
    const withdraw = async (id: number, amount: number) => {
        if (amount <= 0) return;
        const item = st()?.bank?.items.find(i => i.id === id);
        if (!item || item.count < amount) throw Error('ranged prerequisite: owned stock short ' + id);
        const before = held(id);
        const bankBefore = stored(id);
        const generation = s.bankObservation!()!.generation;
        await s.bot.withdrawItem(item, amount, { asNote: false });
        if (
            !(await waitUntil(
                s,
                () => held(id) === before + amount && (s.bankObservation?.()?.generation ?? 0) > generation && countPackItems(s.bankObservation!()!.items, id) === bankBefore - amount,
                { timeoutTicks: 10 },
            ))
        ) {
            throw Error('ranged withdrawal effect unknown ' + id);
        }
        capture();
    };
    const equip = async (id: number) => {
        const item = inv().find(i => i.id === id);
        if (!item) throw Error('ranged equip input absent ' + id);
        const before = rangedAmmo(inv(), eq());
        await s.bot.equipItem(item);
        if (!(await waitUntil(s, () => countPackItems(eq(), id) > 0, { timeoutTicks: 10 })) || (id === AMMO && rangedAmmo(inv(), eq()) !== before)) {
            throw Error('ranged equip effect unknown ' + id);
        }
    };
    const heal = makeRangedHealer(s, () => {
        eaten++;
    }, FOOD);
    const base = await sessionWalker(sess);
    const guarded = {
        ...base,
        walk: async (x: number, z: number) => {
            await heal();
            const p = base.pos();
            if (!p || p.level !== 0) throw Error('ranged walk plane unknown');
            const path = base.plan(0, p, { x, z });
            const last = path.at(-1);
            if (Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) > 1 && (!last || Math.max(Math.abs(last.x - x), Math.abs(last.z - z)) > 1)) {
                throw Error('ranged incomplete route refused');
            }
            if (expandPath(p, path).some(t => t.x < 3250 && t.z >= 3350 && t.z <= 3390)) throw Error('ranged dark-wizard corridor refused');
            return base.walk(x, z);
        },
    };
    const walk = async (points: PathPoint[]) => {
        const r = await walkPath(guarded, points, { look: 4, maxTicks: 500, stop: over });
        if (!r.ok) throw Error('ranged route failed ' + r.detail);
    };
    const close = async () => {
        await s.bot.closeBank();
        if (!(await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 5 }))) throw Error('ranged bank close unobserved');
    };
    const ground = () => st()?.groundItems ?? [];
    const potions = o.potions ? createCombatPotions(s, o.potions, ['Ranged', 'Hitpoints'], over, AMMO) : undefined;
    const loot = createCombatLoot(
        s,
        o.telegrab ? { ...o.telegrab, stop: () => over() || !!o.telegrab?.stop?.() } : undefined,
        o.alch ? { ...o.alch, stop: () => over() || !!o.alch?.stop?.() } : undefined,
    );
    const pickup = async (id: number, x: number, z: number) => {
        const item = ground().find(i => i.id === id && i.x === x && i.z === z);
        if (!item) throw Error('ranged fresh loot missing ' + id);
        return pickupRangedLoot(s, loot, item);
    };
    try {
        await open();
        initial = totals();
        if ((initial.get(BOW) ?? 0) < 1 || (initial.get(AMMO) ?? 0) < o.ammo || (initial.get(FOOD) ?? 0) < o.food) {
            throw Error('ranged prerequisite: stage owned bow,ammo and selected unnoted food');
        }
        if (inv().length + 2 + Math.max(0, o.food - held(FOOD)) > 25) throw Error('ranged prerequisite: pack needs loot and unequipped-kit slots');
        await withdraw(BOW, 1);
        await withdraw(AMMO, o.ammo);
        await withdraw(FOOD, Math.max(0, o.food - held(FOOD)));
        await close();
        if (st()?.autoRetaliateEnabled) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Ranged exact target XP: auto-retaliate OFF' });
        if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw Error('Ranged auto-retaliate OFF unobserved');
        await equip(BOW);
        await equip(AMMO);
        await s.sdk.sendSetCombatStyle(1);
        if (
            !(await waitUntil(
                s,
                () => {
                    const c = st()?.combatStyle;
                    return !!c?.known && c.currentStyle === 1 && c.weaponName === 'Shortbow' && c.styles.some(i => i.index === 1 && i.trainsSkills.length === 1 && i.trainsSkills[0] === 'Ranged');
                },
                { timeoutTicks: 10 },
            ))
        ) {
            throw Error('ranged rapid style unobserved');
        }
        armed = true;
        lastObservedAmmo = rangedAmmo(inv(), eq()) ?? 0;
        await walk(OUT);
        if (st()?.player?.worldX !== 3233 || st()?.player?.worldZ !== 3297) throw Error('ranged coop entry unobserved');
        console.log(
            'RANGED_ENTRY '
                + JSON.stringify({
                    x: st()?.player?.worldX,
                    z: st()?.player?.worldZ,
                    reachable: (st()?.nearbyNpcs ?? []).filter(n => [41, 1017].includes(n.id) && n.reachable).length,
                    tick: s.tick(),
                }),
        );
        let lastProgress = s.tick();
        while (kills < o.maximum && !over() && s.tick() - start < o.cap - 500) {
            await heal();
            if (potions) await potions.poll();
            if ((rangedAmmo(inv(), eq()) ?? 0) < 3) {
                stop = 'ammo-low';
                break;
            }
            if (held(AMMO) > 0) await equip(AMMO);
            const target = selectRangedTarget(st()?.nearbyNpcs ?? [], st()?.player?.level);
            if (!target) {
                if (s.tick() - lastProgress > 120) throw Error('ranged no target progress');
                await waitTicks(s, 1);
                continue;
            }
            if (target.distance > 5) await walk([{ x: target.tileX ?? target.x, z: target.tileZ ?? target.z, tol: 3 }]);
            const fresh = st()?.nearbyNpcs.find(n => n.index === target.index && n.id === target.id);
            if (!fresh || fresh.inCombat) continue;
            const beforeXp = xp();
            const beforeGround = new Map<string, number>();
            for (const i of ground()) beforeGround.set(`${i.id}:${i.x}:${i.z}`, (beforeGround.get(`${i.id}:${i.x}:${i.z}`) ?? 0) + i.count);
            const attackStarted = s.tick();
            let x = fresh.tileX ?? fresh.x;
            let z = fresh.tileZ ?? fresh.z;
            let seenXp = xp();
            let gone = false;
            let goneAt: number | undefined;
            await s.bot.attack(fresh);
            lastProgress = s.tick();
            while (!over() && s.tick() - start < o.cap - 500) {
                await heal();
                if (potions && st()?.player?.combat.targetType === 'npc' && st()?.player?.combat.targetIndex === target.index) await potions.poll(target);
                const current = st()?.nearbyNpcs.find(n => n.index === target.index && n.id === target.id);
                if (current) {
                    x = current.tileX ?? current.x;
                    z = current.tileZ ?? current.z;
                } else {
                    gone = true;
                    goneAt ??= s.tick();
                }
                if (xp() > seenXp) {
                    seenXp = xp();
                    lastProgress = s.tick();
                }
                const delta = (id: number) => countPackItems(ground().filter(i => i.x === x && i.z === z), id) - (beforeGround.get(`${id}:${x}:${z}`) ?? 0);
                if (gone && (xp() - beforeXp < 300 || xp() - beforeXp > 500 || (xp() - beforeXp) % 100 !== 0) && s.tick() - (goneAt ?? s.tick()) > 8) {
                    throw Error('Ranged target ownership XP outside admitted range; no kill credit');
                }
                if (s.tick() - attackStarted > 180) throw Error('Ranged engagement exceeds admitted regen budget');
                if (rangedCredit(gone, xp() - beforeXp, delta(BONES), delta(CHICKEN), s.tick() - attackStarted)) break;
                if (s.tick() - lastProgress > 120) throw Error('ranged combat/credit stalled');
                await waitTicks(s, 1);
            }
            if (over() || s.tick() - start >= o.cap - 500) break;
            await pickup(BONES, x, z);
            await pickup(CHICKEN, x, z);
            kills++;
            lastProgress = s.tick();
            if (ground().some(i => i.id === FEATHER && i.x === x && i.z === z)) await pickup(FEATHER, x, z);
            for (const item of ground().filter(i => i.id === AMMO && i.distance <= 7 && i.x >= 3220 && i.x <= 3248 && i.z >= 3280 && i.z <= 3310).slice(0, 4)) {
                pickedAmmo += await pickup(AMMO, item.x, item.z);
            }
            console.log('RANGED_KILL ' + JSON.stringify({ kills, xp: xp() - initialXp, ammo: rangedAmmo(inv(), eq()), pickedAmmo, hp: hp(), tick: s.tick() }));
        }
        if (kills === o.maximum) stop = 'max-kills';
        else if (o.stop?.()) stop = 'stop-file';
    } catch (e) {
        failure = String(e);
    } finally {
        cleanup = true;
        const restore = async () => {
            if (!ended && !died) {
                try {
                    if (st()?.bank?.isOpen) await close();
                    if ((st()?.player?.worldZ ?? 0) < 3380) await walk([{ x: 3260, z: 3335, tol: 2 }, { x: 3275, z: 3380, tol: 2 }, { x: 3280, z: 3429, tol: 2 }, BANK]);
                    else await walk([BANK]);
                    armed = false;
                    for (const id of [AMMO, BOW]) {
                        const item = eq().find(i => i.id === id);
                        if (item) {
                            await s.bot.unequipItem(item);
                            if (!(await waitUntil(s, () => !eq().some(i => i.id === id), { timeoutTicks: 10 }))) throw Error('ranged unequip unobserved ' + id);
                        }
                    }
                    for (const id of originalEquipment) if (!eq().some(i => i.id === id)) await equip(id);
                    await open();
                    for (const id of new Set(
                        inv()
                            .filter(i => [BOW, AMMO, FOOD, BONES, CHICKEN, FEATHER, ...(potions?.depositIds ?? []), ...(o.alch ? [995, ...o.alch.ids] : [])].includes(i.id) && i.count > 0)
                            .map(i => i.id),
                    )) {
                        await depositObserved(sess, inv().find(i => i.id === id)!);
                    }
                    capture();
                    await close();
                    if (st()?.autoRetaliateEnabled !== originalRetaliate) {
                        await s.direct({ type: 'clickComponent', componentId: originalRetaliate ? 150 : 151, reason: 'restore original auto-retaliate' });
                        if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === originalRetaliate, { timeoutTicks: 8 }))) throw Error('Ranged auto-retaliate restore unobserved');
                    }
                } catch (e) {
                    failure = [failure, 'cleanup ' + String(e)].filter(Boolean).join('; ');
                }
            }
        };
        if (potionScope) await potionScope.withCombatPotionCleanup(restore);
        else await restore();
        off();
    }
    const final = totals();
    const consumedAmmo = (initial?.get(AMMO) ?? 0) - (final.get(AMMO) ?? 0);
    const gained = (id: number) => (final.get(id) ?? 0) - (initial?.get(id) ?? 0);
    const preserved =
        !!initial
        && [...new Set([...initial.keys(), ...final.keys()])].every(
            id =>
                [AMMO, FOOD, BONES, CHICKEN, FEATHER].includes(id)
                || (final.get(id) ?? 0)
                    === (initial!.get(id) ?? 0) - (loot.runesUsed[id] ?? 0) - (loot.alch?.runes[id] ?? 0) - (loot.alch?.consumed[id] ?? 0) + (id === 995 ? loot.alch?.coins ?? 0 : 0) + (potions?.delta[id] ?? 0),
        );
    const targetMet = kills === o.maximum && xp() > initialXp && gained(BONES) + (loot.alch?.consumed[BONES] ?? 0) === kills && gained(CHICKEN) + (loot.alch?.consumed[CHICKEN] ?? 0) === kills;
    const accounting = !!initial && !ammoUnknown && gained(FOOD) === -eaten && consumedAmmo >= 0 && consumedAmmo <= shotsObserved && stored(AMMO) === (final.get(AMMO) ?? 0);
    return {
        ...(potions ? { potions: { doses: potions.doses, delta: potions.delta, receipts: potions.receipts, blocked: potions.blocked, resumes: potions.resumes } } : {}),
        ...(o.alch
            ? {
                  alchemy: {
                      casts: loot.alch!.casts,
                      coins: loot.alch!.coins,
                      consumed: loot.alch!.consumed,
                      runes: loot.alch!.runes,
                      receipts: loot.alch!.receipts,
                      blocked: loot.alch!.blocked,
                  },
              }
            : {}),
        telegrabCasts: loot.casts,
        telegrabRunes: loot.runesUsed,
        ok: !failure && !died && !ended && targetMet && preserved && accounting,
        ticks: s.tick() - start,
        kills,
        xpGain: xp() - initialXp,
        startHp: initialHp,
        hpMin,
        hp: hp(),
        eaten,
        pickedAmmo,
        shotsObserved,
        unrecoveredAmmo: consumedAmmo,
        ammoBank: stored(AMMO),
        bowBank: stored(BOW),
        foodBank: stored(FOOD),
        boneGain: gained(BONES),
        chickenGain: gained(CHICKEN),
        featherGain: gained(FEATHER),
        bankTrips,
        preserved,
        accounting,
        targetMet,
        died,
        stop,
        failure: failure || '-',
    };
}

// Progressive ranged trainer

export function rangedEntry(p: { worldX: number; worldZ: number; level: number } | null | undefined) {
    if (!p || p.level !== 0) return null;
    if (p.worldX === 3113 && p.worldZ === 9555) return BANK;
    for (const bank of [BANK, { x: 2809, z: 3441 }, { x: 2619, z: 3332 }]) {
        if (Math.max(Math.abs(p.worldX - bank.x), Math.abs(p.worldZ - bank.z)) <= 6) return bank;
    }
    return null;
}

export function preparationFunds(total: number, spent: number, maxSpend: number, reserve: number): number {
    return Math.max(0, Math.min(maxSpend - spent, total - reserve));
}

export async function openShopWithDoor(
    bot: { openShop(t: RegExp): Promise<{ success: boolean }>; openDoor(t?: RegExp): Promise<{ success: boolean }> },
    keeper: RegExp,
    opened: () => Promise<boolean>,
) {
    if ((await bot.openShop(keeper)).success && (await opened())) return true;
    if (!(await bot.openDoor(/door/i)).success) return false;
    return (await bot.openShop(keeper)).success && (await opened());
}

export function buyChunk(want: number, stock: number, unitPrice: number, budget: number, wallet: number, reserve: number) {
    if (![want, stock, unitPrice, budget, wallet, reserve].every(Number.isFinite) || unitPrice <= 0) return 0;
    const margin = Math.ceil(unitPrice * 1.5);
    return Math.max(0, Math.min(10, want, stock, Math.floor(Math.min(budget, wallet - reserve) / margin)));
}

export function arrowAccount(initial: number, bought: number, final: number, shots: number) {
    const spent = initial + bought - final;
    return { spent, ok: Number.isSafeInteger(spent) && spent >= 0 && spent <= shots };
}

export type RangedTrainOptions = {
    target: number;
    cap: number;
    minArrows: number;
    buyArrows: number;
    buyArrowId: number;
    maxSpend: number;
    coinReserve: number;
    ammo: number;
    food: number;
    foodId: number;
    killsPerTrip: number;
    maxTrips: number;
    kit?: { bow: number; arrow: number };
    stop?: () => boolean;
};

export function rangedTrainOptions(env: Record<string, string | undefined>, argv: string[]): RangedTrainOptions {
    const n = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
    const o = {
        target: n(argv[3] ?? env.TARGET_LEVEL, 10),
        cap: n(argv[4] ?? env.CAP, 3000),
        minArrows: n(env.MIN_ARROWS, 30),
        buyArrows: n(env.BUY_ARROWS, 60),
        buyArrowId: n(env.BUY_ARROW_ID, 882),
        maxSpend: n(env.MAX_SPEND, 500),
        coinReserve: n(env.COIN_RESERVE, 0),
        ammo: n(env.AMMO, 60),
        food: n(env.FOOD, 3),
        foodId: n(env.FOOD_ID, 329),
        killsPerTrip: n(env.KILLS_PER_TRIP, 5),
        maxTrips: n(env.MAX_TRIPS, 10),
    };
    const bad = Object.entries(o)
        .filter(([, v]) => !Number.isSafeInteger(v) || v < 0)
        .map(([k]) => k);
    if (
        bad.length
        || o.target < 2
        || o.target > 99
        || o.cap < 800
        || o.ammo < 15
        || o.ammo > 500
        || o.food < 2
        || o.food > 8
        || o.killsPerTrip < 1
        || o.killsPerTrip > 8
        || o.maxTrips < 1
        || o.maxTrips > 50
        || !LOWE_ARROWS.includes(o.buyArrowId)
        || ![329, 333].includes(o.foodId)
    ) {
        throw Error(
            'ranged-train prerequisite: bounded options '
                + (bad.join(',') || 'target2..99,cap>=800,ammo15..500,food2..8,kills1..8,trips1..50,Lowe arrow,food329/333'),
        );
    }
    return o;
}

export async function runRangedTrain(s: CombatSession, o: RangedTrainOptions) {
    const sess = s as Session;
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const held = (id: number) => countPackItems(inv(), id);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const level = () => s.sdk.getSkill('Ranged')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Ranged') ?? 0;
    const coins = () => held(COINS);
    if (!(await waitUntil(s, () => hp() > 0 && level() > 0, { timeoutTicks: 15 }))) throw Error('ranged-train prerequisite: skill observation unknown');
    if (!(await waitUntil(s, () => !!rangedEntry(st()?.player), { timeoutTicks: 15 }))) {
        throw Error('ranged-train prerequisite: Varrock East, Catherby, Ardougne north bank or observed Wizards Tower cellar entry required');
    }
    const originalRetaliate = st()?.autoRetaliateEnabled;
    if (typeof originalRetaliate !== 'boolean') throw Error('ranged-train prerequisite: auto-retaliate telemetry unknown');
    const p0 = st()?.player;
    const start = s.tick();
    const startLevel = level();
    const startXp = xp();
    const originalEquipment = eq().map(i => i.id);
    const entry = rangedEntry(p0);
    if (!p0 || !entry) throw Error('ranged-train prerequisite: supported entry observation lost');
    const entryItems = [...inv(), ...eq()].map(i => ({ id: i.id, count: i.count }));
    if (originalEquipment.some(id => BOW_IDS.includes(id) || ARROW_IDS.includes(id))) {
        throw Error('ranged-train prerequisite: bow and arrows must start unequipped');
    }
    let ended = false;
    let died = false;
    let cleanup = false;
    let hpMin = hp();
    let kills = 0;
    let trips = 0;
    let eaten = 0;
    let picked = 0;
    let shots = 0;
    let bought = 0;
    let coinsSpent = 0;
    let coinsWithdrawn = 0;
    let shopVisits = 0;
    let failure = '';
    let stop = 'cap';
    let bowUsed = 0;
    let arrowUsed = 0;
    let foodId = o.foodId;
    let foodBought = 0;
    let foodSpent = 0;
    let travelSpent = 0;
    let bankReady = false;
    let bonesPicked = 0;
    let chickenPicked = 0;
    const foodConsumed: Record<number, number> = {};
    const foodPurchases: Record<number, number> = {};
    void s.ended.then(() => {
        ended = true;
    });
    let stopAmmo = () => {};
    const off = s.onTick(() => {
        const p = st()?.player;
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(p0, p)) died = true;
    });
    const over = () => ended || died || (!cleanup && !!o.stop?.()) || s.tick() - start >= o.cap;
    let snapshot: Item[] = [];
    let initial: Item[] | undefined;
    const capture = () => {
        const b = s.bankObservation?.();
        if (!b) throw Error('ranged-train bank observation unknown');
        snapshot = b.items.map(i => ({ id: i.id, count: i.count }));
    };
    const owned = (): Item[] => [...snapshot, ...inv(), ...eq()].map(i => ({ id: i.id, count: i.count }));
    const stored = (id: number) => countPackItems(snapshot, id);
    const open = async () => {
        if (!st()?.bank?.isOpen) {
            const g = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > g, { timeoutTicks: 15 }))) {
                throw Error('ranged-train fresh bank unavailable');
            }
        }
        capture();
    };
    const close = async () => {
        await s.bot.closeBank();
        if (!(await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 5 }))) throw Error('ranged-train bank close unobserved');
    };
    const withdraw = async (id: number, amount: number) => {
        if (amount <= 0) return;
        const item = st()?.bank?.items.find(i => i.id === id);
        if (!item || item.count < amount) throw Error('ranged-train prerequisite: owned stock short ' + id);
        const before = held(id);
        const bankBefore = stored(id);
        const g = s.bankObservation!()!.generation;
        await s.bot.withdrawItem(item, amount, { asNote: false });
        if (
            !(await waitUntil(
                s,
                () => held(id) === before + amount && (s.bankObservation?.()?.generation ?? 0) > g && countPackItems(s.bankObservation!()!.items, id) === bankBefore - amount,
                { timeoutTicks: 10 },
            ))
        ) {
            throw Error('ranged-train withdrawal effect unknown ' + id);
        }
        capture();
    };
    const deposit = async (ids: readonly number[]) => {
        for (const id of new Set(inv().filter(i => ids.includes(i.id) && i.count > 0).map(i => i.id))) {
            await depositObserved(sess, inv().find(i => i.id === id)!);
        }
        capture();
    };
    const equip = async (id: number) => {
        const item = inv().find(i => i.id === id);
        if (!item) throw Error('ranged-train equip input absent ' + id);
        const before = sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS);
        await s.bot.equipItem(item);
        if (!(await waitUntil(s, () => countPackItems(eq(), id) > 0, { timeoutTicks: 10 })) || (ARROW_IDS.includes(id) && sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS) !== before)) {
            throw Error('ranged-train equip effect unknown ' + id);
        }
    };
    const unequip = async (ids: readonly number[]) => {
        for (const item of eq().filter(i => ids.includes(i.id))) {
            await s.bot.unequipItem(item);
            if (!(await waitUntil(s, () => !eq().some(i => i.id === item.id), { timeoutTicks: 10 }))) throw Error('ranged-train unequip unobserved ' + item.id);
        }
    };
    const sustain = startQuestSustain(
        {
            sdk: s.sdk,
            tick: () => s.tick(),
            onTick: cb => s.onTick(cb),
            ended: s.ended,
            direct: async action => {
                const reply = await s.direct(action);
                return { success: !!reply && typeof reply === 'object' && 'success' in reply && reply.success === true };
            },
        },
        {
            food: [329, 333, 1985],
            eatAt: 12,
            onConsumed: effect => {
                eaten++;
                foodConsumed[effect.id] = (foodConsumed[effect.id] ?? 0) + 1;
            },
        },
    );
    const heal = async () => {
        if (sustain.failure()) throw Error(sustain.failure()!);
        if (hp() <= 6 && !held(foodId)) throw Error('ranged-train food exhausted below retreat floor');
    };
    const base = await sessionWalker(sess);
    const guarded = {
        ...base,
        walk: async (x: number, z: number) => {
            await heal();
            const p = base.pos();
            if (!p || p.level !== 0) throw Error('ranged-train walk plane unknown');
            const path = base.plan(0, p, { x, z });
            const last = path.at(-1);
            if (Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) > 1 && (!last || Math.max(Math.abs(last.x - x), Math.abs(last.z - z)) > 1)) {
                throw Error('ranged-train incomplete route refused');
            }
            if (expandPath(p, path).some(t => t.x < 3250 && t.z >= 3350 && t.z <= 3390)) throw Error('ranged-train dark-wizard corridor refused');
            return base.walk(x, z);
        },
    };
    const walk = async (points: PathPoint[]) => {
        const r = await walkPath(guarded, points, { look: 4, maxTicks: 500, stop: over });
        if (!r.ok) throw Error('ranged-train route failed ' + r.detail);
    };
    const near = (t: { x: number; z: number }, tol: number) => {
        const p = st()?.player;
        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - t.x), Math.abs(p.worldZ - t.z)) <= tol;
    };
    const ground = () => st()?.groundItems ?? [];
    const pickup = async (id: number, x: number, z: number, required = true) => {
        const item = ground().find(i => i.id === id && i.x === x && i.z === z);
        const before = held(id);
        if (!item) {
            if (required) throw Error('ranged-train fresh loot missing ' + id);
            return 0;
        }
        await s.bot.pickupItem(item);
        const observed = await waitUntil(s, () => held(id) > before || over(), { timeoutTicks: 8 });
        if (over()) throw Error('ranged-train pickup stopped');
        if (!observed && required) throw Error('ranged-train pickup effect missing ' + id);
        return Math.max(0, held(id) - before);
    };
    type Stop = { x: number; z: number };
    const same = (a: Stop, b: Stop) => a.x === b.x && a.z === b.z;
    const mainlandFood = entry.x === BANK.x && entry.z === BANK.z;
    const foodRoute = (from: Stop, to: Stop) => mainlandFood && ((same(from, BANK) && same(to, WYDIN)) || (same(from, WYDIN) && same(to, BANK)));
    const tripAccount = () => {
        const actor = accountOf(sess);
        return { ...actor, skills: { ...actor.skills, magic: 0 }, items: [], counts: {}, worn: [], coins: coins() };
    };
    const queued: { from: Stop; to: Stop; plan: ReturnType<typeof planTripOffThread> }[] = [];
    const queue = (from: Stop, to: Stop) => {
        if (foodRoute(from, to) || queued.some(q => same(q.from, from) && same(q.to, to))) return;
        const plan = planTripOffThread({ ...from, level: 0 }, { ...to, level: 0 }, tripAccount());
        plan.catch(() => {});
        queued.push({ from, to, plan });
    };
    const travel = async (to: Stop, next: readonly (readonly [Stop, Stop])[] = []) => {
        const p = st()?.player;
        if (!p) throw Error('ranged-train travel state unknown');
        const corridor = p.level === 0 ? (near(BANK, 6) && foodRoute(BANK, to) ? FOOD_OUT : near(WYDIN, 2) && foodRoute(WYDIN, to) ? FOOD_BACK : null) : null;
        if (corridor) {
            if (over() || sustain.failure() || hp() <= 6) throw Error('ranged-train travel deadline/health/stop');
            const wallet = coins();
            await walk(corridor);
            const paid = wallet - coins();
            travelSpent += paid;
            coinsSpent += paid;
            if (over() || !near(to, 2) || paid !== 0) throw Error('ranged-train mainland food walk effect/stop/fare unobserved');
            return;
        }
        const i = queued.findIndex(q => same(q.to, to) && p.level === 0 && Math.max(Math.abs(p.worldX - q.from.x), Math.abs(p.worldZ - q.from.z)) <= 2);
        const ready = i < 0 ? undefined : queued.splice(i, 1)[0]!.plan.catch(() => null);
        const fresh = () => planTripOffThread({ x: p.worldX, z: p.worldZ, level: p.level }, { ...to, level: 0 }, tripAccount());
        const first = ready ?? fresh();
        for (const [a, b] of next) queue(a, b);
        const plan = (await first) ?? (ready ? await fresh() : null);
        if (over() || sustain.failure() || hp() <= 6) throw Error('ranged-train travel deadline/health/stop');
        if (!plan || plan.bank || plan.legs.some(l => l.kind === 'travel' && (l.travel.runes.length || l.travel.needs.some(n => 'held' in n)))) {
            throw Error('ranged-train funded travel unavailable');
        }
        const fare = routeFares(plan.legs);
        const wallet = coins();
        if (fare > preparationFunds(sumCounts(owned(), [COINS]), coinsSpent, o.maxSpend, o.coinReserve) || fare > wallet) {
            throw Error('ranged-train travel budget refused');
        }
        const ac = new AbortController();
        const offTravel = s.onTick(() => {
            if (over() || sustain.failure() || hp() <= 6) ac.abort('ranged-train travel deadline/health/stop');
        });
        try {
            const r = await walkRoute(sess, plan.legs, { signal: ac.signal, legTimeoutTicks: 100, maxRetriesPerLeg: 1 });
            const paid = wallet - coins();
            travelSpent += paid;
            coinsSpent += paid;
            if (!r.ok || !near(to, 2) || paid !== fare) throw Error('ranged-train travel effect/fare unobserved ' + JSON.stringify(r));
        } finally {
            offTravel();
        }
    };
    const fund = async () => {
        const amount = preparationFunds(sumCounts(owned(), [COINS]), coinsSpent, o.maxSpend, o.coinReserve);
        await withdraw(COINS, Math.min(stored(COINS), Math.max(0, amount - coins())));
        coinsWithdrawn++;
    };
    const stageFood = async () => {
        const available = [o.foodId, 333, 329, 1985].find(id => countPackItems(owned(), id) >= o.food);
        if (available) {
            foodId = available;
            return;
        }
        foodId = 1985;
        const need = Math.max(0, o.food - countPackItems(owned(), foodId));
        await fund();
        await close();
        await travel(WYDIN, [[WYDIN, BANK]]);
        if (!(await s.bot.openShop(/^wydin$/i)).success || !(await waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 }))) {
            throw Error('ranged-train food shop unavailable');
        }
        const shelf = st()?.shop?.shopItems.find(i => i.id === foodId);
        console.log('RANGED_TRAIN_FOOD_STOCK ' + JSON.stringify(shelf ?? null));
        if (!shelf || shelf.count < need) throw Error('ranged-train prerequisite: food stock short');
        const r = await buyWithBudget(s.bot, s.sdk, shelf.name, need, 0, preparationFunds(sumCounts(owned(), [COINS]), coinsSpent, o.maxSpend, o.coinReserve));
        foodBought += r.bought;
        foodPurchases[foodId] = (foodPurchases[foodId] ?? 0) + r.bought;
        foodSpent += r.spent;
        coinsSpent += r.spent;
        if (r.bought !== need || r.spent <= 0) throw Error('ranged-train food purchase unobserved');
        await s.bot.closeShop();
        if (!(await waitUntil(s, () => !st()?.shop?.isOpen, { timeoutTicks: 5 }))) throw Error('ranged-train food shop close unobserved');
        await travel(BANK);
        await open();
        await deposit([foodId, COINS]);
        bankReady = true;
    };
    const restock = async (bowReq: number) => {
        if (o.buyArrows <= 0 || o.maxSpend <= coinsSpent) return;
        const wanted = Math.min(o.buyArrows, Math.max(0, o.minArrows - sumCounts(owned(), usableArrows(bowReq, level()))));
        if (!wanted) return;
        const arrow = ARROWS.find(a => a.id === o.buyArrowId)!;
        if (arrow.req > bowReq || arrow.req > level()) throw Error('ranged-train prerequisite: bought arrow unusable with chosen bow');
        const funds = Math.min(stored(COINS), preparationFunds(sumCounts(owned(), [COINS]), coinsSpent, o.maxSpend, o.coinReserve));
        if (funds <= 0) return;
        const before = coins();
        await withdraw(COINS, funds);
        coinsWithdrawn += coins() - before;
        await close();
        shopVisits++;
        await walk([{ ...LOWE, tol: 2 }]);
        if (!(await openShopWithDoor(s.bot, /^lowe$/i, () => waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 })))) {
            throw Error('ranged-train Lowe shop unavailable');
        }
        let got = 0;
        for (let round = 0; round < 30 && got < wanted && !over(); round++) {
            const shelf = st()?.shop?.shopItems.find(i => i.id === arrow.id);
            if (!shelf) throw Error('ranged-train Lowe stock line missing ' + arrow.id);
            const amount = Math.min(10, wanted - got, shelf.count);
            if (amount <= 0) break;
            const wallet = coins();
            const pack = held(arrow.id);
            await buyWithBudget(s.bot, s.sdk, shelf.name, amount, 0, preparationFunds(sumCounts(owned(), [COINS]), coinsSpent, o.maxSpend, o.coinReserve));
            if (!(await waitUntil(s, () => held(arrow.id) > pack, { timeoutTicks: 10 }))) break;
            const n = held(arrow.id) - pack;
            const paid = wallet - coins();
            if (paid <= 0 || n <= 0) throw Error('ranged-train purchase effect unobserved');
            got += n;
            bought += n;
            coinsSpent += paid;
            if (coinsSpent > o.maxSpend || sumCounts(owned(), [COINS]) < o.coinReserve) throw Error('ranged-train shop budget violated');
        }
        await s.bot.closeShop();
        if (!(await waitUntil(s, () => !st()?.shop?.isOpen, { timeoutTicks: 5 }))) throw Error('ranged-train shop close unobserved');
        console.log('RANGED_TRAIN_BUY ' + JSON.stringify({ id: arrow.id, bought: got, coinsSpent, coins: coins(), tick: s.tick() }));
        await walk([{ ...BANK, tol: 1 }]);
        await open();
        await deposit([arrow.id, ...(coinsWithdrawn > 0 ? [COINS] : [])]);
    };
    try {
        if (!near(entry, 6)) await travel(entry, [[entry, WYDIN], [WYDIN, BANK]]);
        await open();
        initial = [...snapshot, ...entryItems];
        await deposit(inv().map(i => i.id));
        if (sumCounts(owned(), [COINS]) < o.coinReserve) throw Error('ranged-train prerequisite: coin reserve short');
        await stageFood();
        if (!near(BANK, 4)) {
            await fund();
            await close();
            await travel(BANK);
            await open();
            await deposit([COINS]);
        }
        bankReady = true;
        for (trips = 0; trips < o.maxTrips && level() < o.target && !over(); ) {
            await deposit([BONES, CHICKEN, FEATHER, ...ARROW_IDS]);
            const bow = o.kit ? BOWS.find(b => b.id === o.kit!.bow && b.req <= level() && countPackItems(owned(), b.id) > 0) : bestBow(owned(), level());
            if (!bow) throw Error('ranged-train prerequisite: no owned bow usable at Ranged ' + level());
            if (sumCounts(owned(), usableArrows(bow.req, level())) < o.minArrows) await restock(bow.req);
            const arrow = o.kit
                ? usableArrows(bow.req, level()).includes(o.kit.arrow) && countPackItems(owned(), o.kit.arrow) >= MIN_TRIP_ARROWS
                    ? { id: o.kit.arrow, count: countPackItems(owned(), o.kit.arrow) }
                    : undefined
                : chooseArrow(owned(), bow.req, level());
            if (!arrow) {
                stop = 'ammo-short';
                break;
            }
            if (countPackItems(owned(), foodId) < o.food) await stageFood();
            const food = Math.max(0, o.food - held(foodId));
            if (stored(foodId) < food) throw Error('ranged-train prerequisite: stage unnoted food ' + foodId);
            if (28 - inv().length < 2 * o.killsPerTrip + 5 + food) throw Error('ranged-train prerequisite: pack needs loot and unequipped-kit slots');
            if (!countPackItems(eq(), bow.id) && !held(bow.id)) await withdraw(bow.id, 1);
            await withdraw(arrow.id, Math.min(o.ammo, stored(arrow.id)));
            await withdraw(foodId, food);
            await close();
            if (st()?.autoRetaliateEnabled) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'Ranged exact target XP: auto-retaliate OFF' });
            if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw Error('ranged-train auto-retaliate OFF unobserved');
            if (!countPackItems(eq(), bow.id)) await equip(bow.id);
            if (held(arrow.id) > 0) await equip(arrow.id);
            await s.sdk.sendSetCombatStyle(1);
            if (
                !(await waitUntil(
                    s,
                    () => {
                        const c = st()?.combatStyle;
                        return !!c?.known && c.currentStyle === 1 && c.styles.some(i => i.index === 1 && i.trainsSkills.length === 1 && i.trainsSkills[0] === 'Ranged');
                    },
                    { timeoutTicks: 10 },
                ))
            ) {
                throw Error('ranged-train rapid style unobserved');
            }
            bowUsed = bow.id;
            arrowUsed = arrow.id;
            trips++;
            stopAmmo();
            let lastAmmo = sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS);
            stopAmmo = s.onTick(() => {
                const a = sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS);
                shots += Math.max(0, lastAmmo - a);
                lastAmmo = a;
            });
            console.log('RANGED_TRAIN_TRIP ' + JSON.stringify({ trip: trips, bow: bow.id, arrow: arrow.id, ammo: lastAmmo, level: level(), tick: s.tick() }));
            await walk(OUT);
            if (!near(PEN, 0)) throw Error('ranged-train coop entry unobserved');
            let tripKills = 0;
            let lostTargets = 0;
            let lastProgress = s.tick();
            let penReturn = false;
            while (tripKills < o.killsPerTrip && lostTargets < 5 && level() < o.target && !over() && s.tick() - start < o.cap - 500) {
                await heal();
                if (sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS) < 3) break;
                if (held(arrow.id) > 0) await equip(arrow.id);
                const target = selectRangedTarget(st()?.nearbyNpcs ?? [], st()?.player?.level);
                if (!target) {
                    if (s.tick() - lastProgress > 120) throw Error('ranged-train no target progress');
                    if (!penReturn && !near(PEN, 0)) {
                        penReturn = true;
                        await walk([{ ...PEN, tol: 0 }]);
                        continue;
                    }
                    await waitTicks(s, 1);
                    continue;
                }
                if (target.distance > 5) await walk([{ x: target.tileX ?? target.x, z: target.tileZ ?? target.z, tol: 3 }]);
                const fresh = st()?.nearbyNpcs.find(n => n.index === target.index && n.id === target.id);
                if (!fresh || fresh.inCombat) continue;
                const stacks = () => {
                    const m = new Map<string, number>();
                    for (const i of ground()) m.set(`${i.id}:${i.x}:${i.z}`, (m.get(`${i.id}:${i.x}:${i.z}`) ?? 0) + i.count);
                    return m;
                };
                const beforeXp = xp();
                const beforeGround = stacks();
                const attackStarted = s.tick();
                let x = fresh.tileX ?? fresh.x;
                let z = fresh.tileZ ?? fresh.z;
                let seenXp = xp();
                let gone = false;
                let goneAt = 0;
                let credited = false;
                let retries = 0;
                let lastAttack = attackStarted;
                await s.bot.attack(fresh);
                lastProgress = s.tick();
                while (!over() && s.tick() - start < o.cap - 500) {
                    await heal();
                    const current = gone ? undefined : st()?.nearbyNpcs.find(n => n.index === target.index && n.id === target.id);
                    if (current) {
                        x = current.tileX ?? current.x;
                        z = current.tileZ ?? current.z;
                    } else if (!gone) {
                        gone = true;
                        goneAt = s.tick();
                    }
                    if (xp() > seenXp) {
                        seenXp = xp();
                        lastProgress = s.tick();
                    }
                    const delta = (id: number) => countPackItems(ground().filter(i => i.x === x && i.z === z), id) - (beforeGround.get(`${id}:${x}:${z}`) ?? 0);
                    if (s.tick() - attackStarted > 180) throw Error('ranged-train engagement exceeds admitted regen budget');
                    if (rangedCredit(gone, xp() - beforeXp, delta(BONES), delta(CHICKEN), s.tick() - attackStarted)) {
                        credited = true;
                        break;
                    }
                    if (gone && s.tick() - goneAt >= LOOT_WINDOW) {
                        const appeared = [...stacks()]
                            .filter(([k, n]) => [BONES, CHICKEN].some(id => k.startsWith(id + ':')) && n > (beforeGround.get(k) ?? 0))
                            .map(([k, n]) => `${k}+${n - (beforeGround.get(k) ?? 0)}`);
                        console.log(
                            'RANGED_TRAIN_LOST ' +
                                JSON.stringify({
                                    index: target.index,
                                    id: target.id,
                                    attackTick: attackStarted,
                                    goneAt,
                                    tick: s.tick(),
                                    tile: { x, z },
                                    xp: xp() - beforeXp,
                                    bones: delta(BONES),
                                    chicken: delta(CHICKEN),
                                    appeared,
                                }),
                        );
                        break;
                    }
                    if (current && !gone && s.tick() - lastProgress >= 8 && s.tick() - lastAttack >= 8 && retries < 3) {
                        retries++;
                        lastAttack = s.tick();
                        await s.bot.attack(current);
                    }
                    if (s.tick() - lastProgress > 120) throw Error('ranged-train combat/credit stalled');
                    await waitTicks(s, 1);
                }
                if (!credited) {
                    lostTargets++;
                    continue;
                }
                bonesPicked += await pickup(BONES, x, z, false);
                chickenPicked += await pickup(CHICKEN, x, z, false);
                kills++;
                tripKills++;
                lastProgress = s.tick();
                penReturn = false;
                if (ground().some(i => i.id === FEATHER && i.x === x && i.z === z)) await pickup(FEATHER, x, z, false);
                for (const item of ground().filter(i => i.id === arrow.id && i.distance <= 7 && i.x >= 3220 && i.x <= 3248 && i.z >= 3280 && i.z <= 3310).slice(0, 4)) {
                    picked += await pickup(item.id, item.x, item.z, false);
                }
                console.log('RANGED_TRAIN_KILL ' + JSON.stringify({ kills, level: level(), xp: xp() - startXp, ammo: sumCounts(inv(), ARROW_IDS) + sumCounts(eq(), ARROW_IDS), picked, hp: hp(), tick: s.tick() }));
                if (o.kit ? countPackItems(owned(), o.kit.arrow) < MIN_TRIP_ARROWS : bestBow(owned(), level())?.id !== bow.id || chooseArrow(owned(), bow.req, level())?.id !== arrow.id) {
                    break;
                }
            }
            stopAmmo();
            if (over()) break;
            await walk(BACK);
            if (!near(BANK, 4)) throw Error('ranged-train bank return unobserved');
            await open();
        }
        if (level() >= o.target) stop = 'target-level';
        else if (o.stop?.()) stop = 'stop-file';
        else if (trips >= o.maxTrips && stop === 'cap') stop = 'max-trips';
    } catch (e) {
        failure = String(e);
    } finally {
        stopAmmo();
        cleanup = true;
        await sustain.settle();
        if (sustain.failure()) failure = [failure, sustain.failure()].filter(Boolean).join('; ');
        if (!ended && !died && initial) {
            try {
                if (st()?.shop?.isOpen) await s.bot.closeShop();
                if (st()?.bank?.isOpen) await close();
                if (!near(BANK, 4)) {
                    if (!bankReady) await travel(entry);
                    else if ((st()?.player?.worldZ ?? 0) < 3380) await walk(BACK);
                    else await walk([{ ...BANK, tol: 1 }]);
                }
                await unequip([...ARROW_IDS, ...BOW_IDS]);
                for (const id of originalEquipment) if (!eq().some(i => i.id === id)) await equip(id);
                await open();
                await deposit([...BOW_IDS, ...ARROW_IDS, foodId, BONES, CHICKEN, FEATHER, ...(coinsWithdrawn > 0 ? [COINS] : [])]);
                await close();
                if (st()?.autoRetaliateEnabled !== originalRetaliate) {
                    await s.direct({ type: 'clickComponent', componentId: originalRetaliate ? 150 : 151, reason: 'restore original auto-retaliate' });
                    if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === originalRetaliate, { timeoutTicks: 8 }))) {
                        throw Error('ranged-train auto-retaliate restore unobserved');
                    }
                }
            } catch (e) {
                failure = [failure, 'cleanup ' + String(e)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    const final = owned();
    const total = (items: readonly Item[] | undefined, id: number) => countPackItems(items ?? [], id);
    const arrows = arrowAccount(sumCounts(initial ?? [], ARROW_IDS), bought, sumCounts(final, ARROW_IDS), shots);
    const coinDebit = total(initial, COINS) - total(final, COINS);
    const loot = new Set([BONES, CHICKEN, FEATHER, 329, 333, 1985, COINS, ...ARROW_IDS]);
    const preserved = !!initial && [...new Set([...initial.map(i => i.id), ...final.map(i => i.id)])].every(id => loot.has(id) || total(initial, id) === total(final, id));
    const equipmentRestored = JSON.stringify(eq().map(i => i.id).sort()) === JSON.stringify([...originalEquipment].sort());
    const accounting =
        !!initial
        && arrows.ok
        && coinDebit === coinsSpent
        && coinsSpent <= o.maxSpend
        && total(final, COINS) >= o.coinReserve
        && [329, 333, 1985].every(id => total(final, id) === total(initial, id) + (foodPurchases[id] ?? 0) - (foodConsumed[id] ?? 0))
        && total(final, BONES) - total(initial, BONES) === bonesPicked
        && total(final, CHICKEN) - total(initial, CHICKEN) === chickenPicked;
    const targetMet = level() >= o.target;
    return {
        ok: !failure && !died && !ended && targetMet && preserved && accounting && equipmentRestored,
        targetMet,
        stop,
        targetLevel: o.target,
        startLevel,
        finalLevel: level(),
        xpGain: xp() - startXp,
        bow: bowUsed,
        arrow: arrowUsed,
        trips,
        kills,
        bonesPicked,
        chickenPicked,
        shots,
        picked,
        arrowsSpent: arrows.spent,
        arrowsBought: bought,
        coinsSpent,
        coinDebit,
        foodId,
        foodBought,
        foodSpent,
        foodPurchases,
        foodConsumed,
        travelSpent,
        shopVisits,
        eaten,
        hpMin,
        hp: hp(),
        died,
        ticks: s.tick() - start,
        preserved,
        accounting,
        equipmentRestored,
        failure: failure || '-',
    };
}

export function recoveryBank(p: { worldX: number; worldZ: number; level: number }) {
    return p.worldX < 2850 ? { x: 2619, z: 3332 } : BANK;
}

export function needsRangedRecovery(p: { worldX: number; worldZ: number; level: number }, worn: readonly number[]) {
    return !rangedEntry(p) || worn.some(id => BOW_IDS.includes(id) || ARROW_IDS.includes(id));
}

export function recoveryWalker(actor: Account): Account {
    return { ...actor, skills: { ...actor.skills, magic: 0 }, items: [], counts: {}, worn: [], coins: 0 };
}

export async function recoverRangedStart(s: CombatSession, stop: () => boolean = () => false) {
    const sess = s as Session;
    const st = () => s.sdk.getState();
    const eq = () => s.sdk.getEquipment();
    if (!(await waitUntil(s, () => !!st()?.player && !!s.client && equipmentObserved(s.client), { timeoutTicks: 20 }))) {
        throw Error('ranged-train prerequisite: position/equipment unobserved');
    }
    const p = st()!.player!;
    if (!needsRangedRecovery(p, eq().map(i => i.id))) return null;
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    if (stop()) return { from, stopped: true };
    if (!rangedEntry(p)) {
        const abort = new AbortController();
        const off = s.onTick(() => {
            if (stop() && !abort.signal.aborted) abort.abort('stop requested');
        });
        let r: Awaited<ReturnType<typeof goTo>>;
        try {
            r = await goTo(sess, await getWorld(), { ...recoveryBank(p), level: 0 }, recoveryWalker(accountOf(sess)), {
                legTimeoutTicks: 100,
                signal: abort.signal,
            });
        } finally {
            off();
        }
        if (stop()) return { from, stopped: true };
        if (!r.ok) throw Error('ranged-train recovery walk failed ' + JSON.stringify(r));
    }
    for (const item of eq().filter(i => BOW_IDS.includes(i.id) || ARROW_IDS.includes(i.id))) {
        await s.bot.unequipItem(item);
        if (!(await waitUntil(s, () => !eq().some(i => i.id === item.id), { timeoutTicks: 10 }))) {
            throw Error('ranged-train recovery unequip unobserved ' + item.id);
        }
    }
    console.log('RANGED_TRAIN_RECOVERY ' + JSON.stringify({ from, to: st()?.player ? { x: st()!.player!.worldX, z: st()!.player!.worldZ } : null, tick: s.tick() }));
    return { from, stopped: false };
}

export function rangedComparisonMethod(value: string | undefined, server: string): 'chickens' | 'troopers' | undefined {
    if (!value) return;
    if (!isLocalServer(server)) throw Error('Ranged comparison override requires the local practice server');
    if (value !== 'chickens' && value !== 'troopers') throw Error('Unknown Ranged comparison method');
    return value;
}

export type RangedObservedAccount = {
    account: string;
    at: number;
    skills: Record<string, { level: number; xp: number }>;
    inventory: { at: number; value: Record<number, number> };
    equipment: { at: number; value: Record<number, number> } | null;
    bank: { at: number; value: Record<number, number>; generation: number } | null;
    quests: { at: number; value: Record<string, boolean | null> } | null;
    position: { at: number; value: { x: number; z: number; level: number } } | null;
    currentHP: number | undefined;
    reservations: Record<number, number>;
};

export type RangedProgressionDecision = {
    state: string;
    selected: string | null;
    step?: { script: string; args: string[]; env: Record<string, string> } | null;
    path: { method: string; step?: { script: string; args: string[]; env: Record<string, string> } | null }[];
};

export type RangedAdaptiveDeps = {
    decision?: RangedProgressionDecision;
    comparison?: 'chickens' | 'troopers';
    progressionMethods?: (account: RangedObservedAccount, targetLevel: number) => unknown[];
    chooseProgression?: (order: { kind: 'train'; skill: 'Ranged'; targetLevel: number }, account: RangedObservedAccount, methods: unknown[], opts: { now: number }) => RangedProgressionDecision;
    rangedKit?: (account: RangedObservedAccount) => { bow: number; arrow: number } | null;
    rangedBandTarget?: (account: RangedObservedAccount, target: number) => number;
};

export function rangedAccountObservation(s: CombatSession, reserve = 0, now = Date.now()): RangedObservedAccount {
    const counts = (rows: readonly { id: number; count: number }[]) => rows.reduce<Record<number, number>>((all, i) => ((all[i.id] = (all[i.id] ?? 0) + i.count), all), {});
    const bank = s.bankObservation?.();
    const p = s.sdk.getState()?.player;
    const quests = questFlags(s.client);
    return {
        account: s.name,
        at: now,
        skills: Object.fromEntries(s.sdk.getSkills().map(skill => [skill.name, { level: skill.baseLevel, xp: s.sdk.getSkillXp(skill.name) ?? 0 }])),
        inventory: { at: now, value: counts(s.sdk.getInventory()) },
        equipment: s.client && equipmentObserved(s.client) ? { at: now, value: counts(s.sdk.getEquipment()) } : null,
        bank: bank ? { at: bank.at, value: counts(bank.items), generation: bank.generation } : null,
        quests: quests ? { at: now, value: Object.fromEntries(quests.map(q => [q.name, q.state === 'unknown' ? null : q.state === 'complete'])) } : null,
        position: p ? { at: now, value: { x: p.worldX, z: p.worldZ, level: p.level } } : null,
        currentHP: s.sdk.getSkill('Hitpoints')?.level,
        reservations: reserve ? { 995: reserve } : {},
    };
}

const RANGED_SHOP_ACQUIRE: Record<string, { itemId: number; name: string; count: number; maxUnitCost: number; minRanged: number }> = {
    'ranged/lowe-buy-shortbow': { itemId: 841, name: 'Shortbow', count: 1, maxUnitCost: 100, minRanged: 1 },
    'ranged/lowe-buy-oak': { itemId: 843, name: 'Oak shortbow', count: 1, maxUnitCost: 200, minRanged: 5 },
    'ranged/lowe-buy-bronze': { itemId: 882, name: 'Bronze arrow', count: 100, maxUnitCost: 3, minRanged: 1 },
    'ranged/lowe-buy-iron': { itemId: 884, name: 'Iron arrow', count: 100, maxUnitCost: 8, minRanged: 1 },
    'ranged/lowe-buy-steel': { itemId: 886, name: 'Steel arrow', count: 100, maxUnitCost: 24, minRanged: 5 },
    'ranged/guild-buy-willow': { itemId: 849, name: 'Willow shortbow', count: 1, maxUnitCost: 1000, minRanged: 40 },
    'ranged/guild-buy-mithril': { itemId: 888, name: 'Mithril arrow', count: 250, maxUnitCost: 192, minRanged: 40 },
};
const RANGED_GE_ACQUIRE = new Set(['ranged/ge-buy-willow', 'ranged/ge-buy-mithril', 'ranged/ge-buy-maple']);
const RANGED_TRAIN_METHODS = new Set([
    'ranged/chickens',
    'ranged/chickens-oak',
    'ranged/troopers',
    'ranged/troopers-oak',
    'ranged/troopers-willow',
    'ranged/troopers-maple',
    'ranged/guild-willow-mithril',
]);
export const isRangedAcquireMethod = (method: string | null | undefined): method is string =>
    !!method && (method in RANGED_SHOP_ACQUIRE || RANGED_GE_ACQUIRE.has(method));

async function walkRangedAcquirePoint(s: CombatSession, to: { x: number; z: number }, stop?: () => boolean) {
    const sess = s as Session;
    const p = s.sdk.getState()?.player;
    if (p && p.level === 0 && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 4) return true;
    const world = await getWorld();
    const out = await combatFerryWalk(s, { x: to.x, z: to.z, level: 0 }, (tile, budgetMs) =>
        goTo(sess, world, tile, recoveryWalker(accountOf(sess)), { maxRetriesPerLeg: 2, legTimeoutTicks: 150, planBudgetMs: budgetMs }),
    );
    if (stop?.()) return false;
    const cur = s.sdk.getState()?.player;
    return out.ok && !!cur && cur.level === 0 && Math.max(Math.abs(cur.worldX - to.x), Math.abs(cur.worldZ - to.z)) <= 8;
}

async function executeRangedAcquireStep(
    s: CombatSession,
    o: RangedTrainOptions,
    method: string,
    step: RangedProgressionDecision['step'] | undefined,
    decision: RangedProgressionDecision,
    start: number,
    deps: RangedAdaptiveDeps,
) {
    const level = () => s.sdk.getSkill('Ranged')?.baseLevel ?? 0;
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const bankItems = () => s.bankObservation?.()?.items ?? [];
    const total = (id: number) => countPackItems(inv(), id) + countPackItems(bankItems(), id) + countPackItems(s.sdk.getEquipment(), id);
    if (!st()?.bank?.isOpen) {
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 15 }))) {
            return {
                ok: false,
                acquired: false,
                targetMet: false,
                stop: 'preparation',
                targetLevel: o.target,
                finalLevel: level(),
                xpGain: 0,
                ticks: s.tick() - start,
                method,
                decision,
                coinsSpent: 0,
                coinDebit: 0,
                arrowsSpent: 0,
                failure: 'ranged acquire bank unavailable',
            };
        }
    }
    const totalCoins = total(COINS);
    const spendEnv = Number(step?.env?.MAX_SPEND ?? o.maxSpend);
    const spendCap = Number.isFinite(spendEnv) && spendEnv >= 0 ? Math.min(o.maxSpend, spendEnv) : o.maxSpend;
    const budget = preparationFunds(totalCoins, 0, spendCap, o.coinReserve);
    if (method in RANGED_SHOP_ACQUIRE) {
        const spec = RANGED_SHOP_ACQUIRE[method]!;
        if (level() < spec.minRanged) {
            return {
                ok: false,
                acquired: false,
                targetMet: false,
                stop: 'preparation',
                targetLevel: o.target,
                finalLevel: level(),
                xpGain: 0,
                ticks: s.tick() - start,
                method,
                decision,
                coinsSpent: 0,
                coinDebit: 0,
                arrowsSpent: 0,
                failure: `progression requires Ranged ${spec.minRanged} for ${method}`,
            };
        }
        const maxEnv = Number(step?.env?.MAX_ITEMS);
        const wanted = Number.isSafeInteger(maxEnv) && maxEnv > 0 ? Math.min(spec.count, maxEnv) : spec.count;
        const minNeed = Math.min(spec.maxUnitCost, totalCoins);
        if (budget < spec.maxUnitCost && budget < 1) {
            await s.bot.closeBank();
            return {
                ok: false,
                acquired: false,
                targetMet: false,
                stop: 'preparation',
                targetLevel: o.target,
                finalLevel: level(),
                xpGain: 0,
                ticks: s.tick() - start,
                method,
                decision,
                coinsSpent: 0,
                coinDebit: 0,
                arrowsSpent: 0,
                failure: `ranged acquire budget short for ${spec.name}: budget=${budget} min=${minNeed}`,
            };
        }
        const p = st()?.player;
        const hicktonItems = [841, 843, 882, 884];
        const useDargaud = method.startsWith('ranged/guild-');
        const useHickton = !useDargaud && !!p && p.worldX < 2850 && hicktonItems.includes(spec.itemId);
        const shop = useDargaud
            ? { npc: /^bow and arrow salesman$/i, spot: { x: 2673, z: 3434 }, bank: { x: 2727, z: 3492 } }
            : useHickton
                ? { npc: /^hickton$/i, spot: { x: 2821, z: 3444 }, bank: { x: 2809, z: 3441 } }
                : { npc: /^lowe$/i, spot: LOWE, bank: BANK };
        const packCoins = countPackItems(inv(), COINS);
        const needWithdraw = Math.max(0, budget - packCoins);
        let withdrawn = 0;
        if (needWithdraw > 0 && countPackItems(bankItems(), COINS) > 0) {
            const amt = Math.min(needWithdraw, countPackItems(bankItems(), COINS));
            if (amt > 0) {
                const beforeW = countPackItems(inv(), COINS);
                await s.bot.withdrawItem({ id: COINS, name: 'Coins', count: amt, slot: 0 } as any, amt);
                await waitUntil(s, () => countPackItems(inv(), COINS) > beforeW, { timeoutTicks: 8 });
                withdrawn = Math.max(0, countPackItems(inv(), COINS) - beforeW);
            }
        }
        await s.bot.closeBank();
        await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 5 });
        if (o.stop?.()) {
            return {
                ok: false,
                acquired: false,
                targetMet: false,
                stop: 'stop-file',
                targetLevel: o.target,
                finalLevel: level(),
                xpGain: 0,
                ticks: s.tick() - start,
                method,
                decision,
                coinsSpent: 0,
                coinDebit: 0,
                arrowsSpent: 0,
            };
        }
        const beforeWalkOut = total(COINS);
        const walked = await walkRangedAcquirePoint(s, shop.spot, o.stop);
        const fareOut = Math.max(0, beforeWalkOut - total(COINS));
        let bought = 0;
        let spent = 0;
        if (walked && !o.stop?.()) {
            if (await openShopWithDoor(s.bot, shop.npc, () => waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 }))) {
                const wallet = countPackItems(inv(), COINS);
                const allowed = Math.min(Math.max(0, budget - fareOut), wallet);
                if (allowed > 0) {
                    const res = await buyWithBudget(s.bot, s.sdk, spec.name, wanted, Math.max(0, wallet - allowed), allowed);
                    bought = res.bought;
                    spent = res.spent;
                }
                await s.bot.closeShop();
                await waitUntil(s, () => !st()?.shop?.isOpen, { timeoutTicks: 5 });
            }
        }
        const beforeWalkBack = total(COINS);
        await walkRangedAcquirePoint(s, shop.bank, o.stop);
        const fareBack = Math.max(0, beforeWalkBack - total(COINS));
        const travelSpent = fareOut + fareBack;
        if ((await s.bot.openBank()).success && (await waitUntil(s, () => !!st()?.bank?.isOpen, { timeoutTicks: 12 }))) {
            for (const id of [spec.itemId, ...(withdrawn > 0 || spent > 0 || travelSpent > 0 ? [COINS] : [])]) {
                for (const slot of inv().filter(i => i.id === id)) await s.bot.depositItem(slot as any, slot.count);
            }
            await waitTicks(s, 1);
            await s.bot.closeBank();
            await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 5 });
        }
        const coinsAfter = total(COINS);
        const debit = Math.max(0, totalCoins - coinsAfter);
        const reconciled = coinsAfter >= o.coinReserve && debit <= o.maxSpend && debit === spent + travelSpent;
        const ok = bought > 0 && reconciled && !o.stop?.();
        return {
            ok,
            acquired: ok,
            targetMet: false,
            stop: ok ? 'acquire' : 'preparation',
            targetLevel: o.target,
            finalLevel: level(),
            xpGain: 0,
            ticks: s.tick() - start,
            method,
            decision,
            coinsSpent: debit,
            coinDebit: debit,
            travelSpent,
            arrowsSpent: 0,
            bow: BOW_IDS.includes(spec.itemId) ? spec.itemId : 0,
            arrow: ARROW_IDS.includes(spec.itemId) ? spec.itemId : 0,
            ...(ok ? {} : { failure: bought === 0 ? `ranged acquire unavailable or empty stock for ${spec.name}` : 'ranged acquire coin reconciliation mismatch' }),
        };
    }

    const itemId = Number(step?.env?.ITEM_ID ?? (method === 'ranged/ge-buy-willow' ? 849 : method === 'ranged/ge-buy-maple' ? 853 : 888));
    const limitPrice = Number(step?.env?.LIMIT_PRICE ?? (itemId === 849 ? 2500 : itemId === 853 ? 4000 : 120));
    const reqQty = Number(step?.env?.QUANTITY ?? 1);
    const maxQty = limitPrice > 0 ? Math.min(reqQty, Math.floor(budget / limitPrice)) : 0;
    await s.bot.closeBank();
    await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 5 });
    if (!Number.isSafeInteger(itemId) || !Number.isSafeInteger(limitPrice) || limitPrice <= 0 || maxQty <= 0) {
        return {
            ok: false,
            acquired: false,
            targetMet: false,
            stop: 'preparation',
            targetLevel: o.target,
            finalLevel: level(),
            xpGain: 0,
            ticks: s.tick() - start,
            method,
            decision,
            coinsSpent: 0,
            coinDebit: 0,
            arrowsSpent: 0,
            failure: `ranged GE acquire budget short for ${method}`,
        };
    }
    const server = s.lifecycle?.server ?? 'local';
    const now = Date.now();
    const expectedOwned = step?.env?.EXPECTED_OWNED !== undefined ? Number(step.env.EXPECTED_OWNED) : undefined;
    let goal = `ranged-acquire-${itemId}`;
    let journalPath = orderPaths(server, s.name, goal).journal;
    let reused: ItemRequest | undefined;
    for (let seq = 0; seq < 50 && existsSync(journalPath); seq++) {
        try {
            const prev = JSON.parse(readFileSync(journalPath, 'utf8'));
            if (
                prev?.version === 1 &&
                ['placing', 'open', 'cancelling', 'collecting'].includes(prev.phase) &&
                prev.request?.item === itemId &&
                prev.request?.actor?.toLowerCase() === s.name.toLowerCase()
            ) {
                reused = prev.request as ItemRequest;
                break;
            }
        } catch {}
        goal = `ranged-acquire-${itemId}-${seq + 1}`;
        journalPath = orderPaths(server, s.name, goal).journal;
    }
    const req: ItemRequest =
        reused ?? {
            actor: s.name,
            server,
            goal,
            item: itemId,
            quantity: maxQty,
            ...(expectedOwned !== undefined ? { expectedOwned } : {}),
            limit: limitPrice,
            reserve: o.coinReserve,
            createdAt: now,
            reviewAt: now + 60_000,
            deadline: now + 300_000,
        };
    const res = await runOwnedItem(s as Session, req, journalPath, () => !!o.stop?.(), false, 100);
    const coinsAfter = total(COINS);
    const debit = Math.max(0, totalCoins - coinsAfter);
    const ok = res.acquired > 0 && coinsAfter >= o.coinReserve && debit <= o.maxSpend && !o.stop?.();
    return {
        ok,
        acquired: ok,
        targetMet: false,
        stop: ok ? 'acquire' : 'preparation',
        targetLevel: o.target,
        finalLevel: level(),
        xpGain: 0,
        ticks: s.tick() - start,
        method,
        decision,
        coinsSpent: debit,
        coinDebit: debit,
        arrowsSpent: 0,
        bow: BOW_IDS.includes(itemId) ? itemId : 0,
        arrow: ARROW_IDS.includes(itemId) ? itemId : 0,
        ...(ok ? {} : { failure: res.failure && res.failure !== '-' ? res.failure : `ranged GE acquire unfilled for ${method}` }),
    };
}

function ownedStockList(account: RangedObservedAccount): Item[] {
    const counts = new Map<number, number>();
    for (const container of [account.bank?.value, account.inventory.value, account.equipment?.value]) {
        if (!container) continue;
        for (const [idStr, count] of Object.entries(container)) {
            if (count > 0) counts.set(Number(idStr), (counts.get(Number(idStr)) ?? 0) + count);
        }
    }
    return [...counts].map(([id, count]) => ({ id, count }));
}

const RANGED_FOODS = [385, 373, 379, 333, 2142, 2309, 1901, 1895, 1893, 1891] as const;
const TIER_UPGRADES: Record<number, { bow: number; arrow: number; minCoins: number }> = {
    5: { bow: 843, arrow: 886, minCoins: 100 },
    20: { bow: 849, arrow: 888, minCoins: 2500 },
    30: { bow: 853, arrow: 888, minCoins: 5000 },
    40: { bow: 857, arrow: 892, minCoins: 3000 },
};

function rangedStock(a: RangedObservedAccount): Record<number, number> {
    const out: Record<number, number> = {};
    for (const obs of [a.inventory, a.equipment, a.bank]) {
        for (const [id, n] of Object.entries(obs?.value ?? {})) {
            out[Number(id)] = (out[Number(id)] ?? 0) + n;
        }
    }
    for (const [id, n] of Object.entries(a.reservations ?? {})) {
        out[Number(id)] = Math.max(0, (out[Number(id)] ?? 0) - n);
    }
    return out;
}

const rangedLevel = (a: RangedObservedAccount) =>
    Object.entries(a.skills).find(([k]) => k.toLowerCase() === 'ranged')?.[1].level ?? 0;

function rangedModelRate(
    level: number,
    kit: { bow: number; arrow: number; attack: number; strength: number; interval: number },
    hp: number,
    defence: number,
    extraTicks = 8,
) {
    const max = Math.max(1, Math.floor(0.5 + ((level + 8) * (kit.strength + 64)) / 640));
    const attack = (level + 8) * (kit.attack + 64);
    const def = (defence + 9) * 64;
    const chance = attack > def ? 1 - (def + 2) / (2 * (attack + 1)) : attack / (2 * (def + 1));
    const hit = chance / (max + 1);
    const zero = 1 - chance + hit;
    const shots = [0];
    for (let h = 1; h <= hp; h++) {
        shots[h] = (1 + Array.from({ length: max }, (_, i) => hit * shots[Math.max(0, h - i - 1)]!).reduce((n, v) => n + v, 0)) / (1 - zero);
    }
    return (hp * 100) / (shots[hp]! * kit.interval + extraTicks);
}

export function rangedKit(a: RangedObservedAccount) {
    if (!a.bank || !a.inventory || !a.equipment) return null;
    const owned = rangedStock(a);
    const level = rangedLevel(a);
    const armour = Object.keys(a.equipment.value)
        .map(Number)
        .map(id => gearById(id))
        .filter((g): g is NonNullable<ReturnType<typeof gearById>> => !!g && !['righthand', 'lefthand', 'quiver'].includes(g.slot));
    const atk = armour.reduce((n, g) => n + g.bonuses.rangeAttack, 0);
    const str = armour.reduce((n, g) => n + g.bonuses.rangeStrength, 0);
    const options = BOWS.filter(b => b.req <= level && (owned[b.id] ?? 0) > 0).flatMap(b =>
        ARROWS.filter(q => q.req <= b.req && q.req <= level && (owned[q.id] ?? 0) >= 3).map(q => ({
            bow: b.id,
            arrow: q.id,
            bowLevel: b.req,
            arrows: owned[q.id]!,
            attack: atk + (gearById(b.id)?.bonuses.rangeAttack ?? 0),
            strength: str + (gearById(q.id)?.bonuses.rangeStrength ?? 0),
            interval: Math.max(1, (gearById(b.id)?.attackRate ?? 4) - 1),
        })),
    );
    return (
        options.sort(
            (x, y) =>
                rangedModelRate(level, y, 22, 12) - rangedModelRate(level, x, 22, 12)
                || y.strength - x.strength
                || x.bow - y.bow
                || x.arrow - y.arrow,
        )[0] ?? null
    );
}

export function rangedBandTarget(a: RangedObservedAccount, target: number) {
    const current = rangedKit(a);
    const level = rangedLevel(a);
    const skill = Object.keys(a.skills).find(k => k.toLowerCase() === 'ranged')!;
    const heldCoins = Math.max(
        0,
        [a.inventory, a.bank, a.equipment].reduce((n, b) => n + (b?.value[COINS] ?? 0), 0) - (a.reservations?.[COINS] ?? 0),
    );
    const owned = rangedStock(a);
    const hasSourced = (id: number, need: number, boundary: number) =>
        (owned[id] ?? 0) >= need
        || (boundary <= 40 && id in TIER_UPGRADES)
        || (id === 843 || id === 886
            ? boundary >= 5
            : id === 849 || id === 888
                ? boundary >= 20
                : id === 853
                    ? boundary >= 30
                    : id === 857 || id === 892
                        ? boundary >= 40
                        : false);
    for (const boundary of [...new Set(BOWS.map(b => b.req))].filter(n => n > level && n < target).sort((x, y) => x - y)) {
        if (current) {
            const next = rangedKit({
                ...a,
                skills: { ...a.skills, [skill]: { ...a.skills[skill]!, level: boundary } },
            });
            if (next && (next.bow !== current.bow || next.arrow !== current.arrow)) return boundary;
        }
        const up = TIER_UPGRADES[boundary];
        if (
            up
            && heldCoins >= up.minCoins
            && hasSourced(up.bow, 1, boundary)
            && hasSourced(up.arrow, 3, boundary)
            && (!current || current.bowLevel < boundary || (boundary === 5 && current.arrow === 882))
        ) {
            return boundary;
        }
    }
    return target;
}

export function chooseRangedDecision(account: RangedObservedAccount, target: number): RangedProgressionDecision {
    const level = rangedLevel(account);
    if (level >= target) {
        return { state: 'complete', selected: null, step: null, path: [] };
    }
    const step = { script: 'scripts/ranged-train.ts', args: [String(target)], env: { TARGET_LEVEL: String(target) } };
    const owned = rangedStock(account);
    const hp = Object.entries(account.skills).find(([k]) => k.toLowerCase() === 'hitpoints')?.[1].level ?? 10;
    const kit = rangedKit(account);
    if (!kit) {
        const hasBow = BOWS.some(b => b.req <= level && (owned[b.id] ?? 0) > 0);
        const hasArrow = ARROWS.some(q => q.req <= level && (owned[q.id] ?? 0) >= 3);
        const method = !hasArrow ? 'ranged/lowe-buy-bronze' : !hasBow ? 'ranged/lowe-buy-shortbow' : null;
        if (method) {
            const acqStep = { script: 'scripts/ranged-train.ts', args: [String(Math.min(target, 5)), '1500'], env: { TARGET_LEVEL: String(Math.min(target, 5)) } };
            return {
                state: 'acquire',
                selected: method,
                step: acqStep,
                path: [{ method, step: acqStep }],
            };
        }
        return { state: 'acquire', selected: null, step: null, path: [] };
    }
    const hasFood = RANGED_FOODS.some(id => (owned[id] ?? 0) >= 3);
    const method = hp >= 40 && hasFood ? 'ranged/troopers' : 'ranged/chickens';
    return {
        state: 'execute',
        selected: method,
        step,
        path: [{ method, step }],
    };
}

async function runAdaptiveRangedBand(
    s: CombatSession,
    o: RangedTrainOptions,
    options: RangedAdaptiveDeps = {},
) {
    const sess = s as Session;
    const start = s.tick();
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (s.sdk.getState()?.bank?.isOpen) await s.bot.closeBank();
    if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 }))) {
        throw Error('adaptive Ranged needs a fresh bank observation');
    }
    const account = rangedAccountObservation(s, o.coinReserve);
    const coins = Object.values([account.bank, account.inventory, account.equipment]).reduce((n, b) => n + (b?.value[COINS] ?? 0), 0);
    if (coins < o.coinReserve) throw Error('ranged-train prerequisite: coin reserve short');
    const decision =
        options.decision
        ?? (options.chooseProgression && options.progressionMethods
            ? options.chooseProgression({ kind: 'train', skill: 'Ranged', targetLevel: o.target }, account, options.progressionMethods(account, o.target), { now: Date.now() })
            : chooseRangedDecision(account, o.target));
    console.log('RANGED_PROGRESSION ' + JSON.stringify(decision));
    const method = options.comparison ? 'ranged/' + options.comparison : (decision.path[0]?.method ?? decision.selected);
    const step = decision.path[0]?.step ?? decision.step;
    const pickKit = (acct: RangedObservedAccount) => (options.rangedKit ? options.rangedKit(acct) : rangedKit(acct));
    if (!options.comparison && isRangedAcquireMethod(method) && (decision.state === 'acquire' || decision.state === 'execute')) {
        return executeRangedAcquireStep(s, o, method, step, decision, start, options);
    }
    await s.bot.closeBank();
    if (!(await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 5 }))) throw Error('adaptive Ranged bank close unobserved');
    if (decision.state === 'complete') {
        return {
            ok: true,
            targetMet: true,
            stop: 'target-level',
            targetLevel: o.target,
            finalLevel: account.skills.Ranged!.level,
            xpGain: 0,
            ticks: s.tick() - start,
            method: null,
            decision,
        };
    }
    if (!options.comparison && (decision.state !== 'execute' || !method || !RANGED_TRAIN_METHODS.has(method))) {
        return {
            ok: false,
            targetMet: false,
            stop: 'preparation',
            targetLevel: o.target,
            finalLevel: account.skills.Ranged?.level ?? 0,
            xpGain: 0,
            ticks: s.tick() - start,
            method,
            decision,
            failure: 'progression requires ' + decision.state,
        };
    }
    const remaining = o.cap - (s.tick() - start);
    if (remaining < 800) throw Error('adaptive Ranged preparation exhausted the finite cap');
    const kit = pickKit(account);
    if (!kit) throw Error('adaptive Ranged selected kit unavailable');
    const policyStep = decision.path[0]?.step ?? decision.step;
    const declaredTarget = Number(policyStep?.env.TARGET_LEVEL ?? policyStep?.args[0] ?? o.target);
    if (!Number.isSafeInteger(declaredTarget) || declaredTarget < 1 || declaredTarget > 99) throw Error('adaptive Ranged policy target unknown');
    const bandTarget = Math.min(options.rangedBandTarget ? options.rangedBandTarget(account, o.target) : rangedBandTarget(account, o.target), declaredTarget);
    if (method === 'ranged/chickens' || method === 'ranged/chickens-oak') {
        const r = await runRangedTrain(s, { ...o, target: bandTarget, cap: remaining, kit });
        return { ...r, ticks: s.tick() - start, method, decision, bandTarget };
    }
    let bankSnapshot = Object.entries(account.bank!.value).map(([id, count]) => ({ id: Number(id), count }));
    const observeBank = () => {
        const observed = s.bankObservation?.();
        if (observed) bankSnapshot = observed.items.map(i => ({ id: i.id, count: i.count }));
    };
    const totals = () => {
        observeBank();
        const all = new Map<number, number>();
        for (const i of [...bankSnapshot, ...s.sdk.getInventory(), ...s.sdk.getEquipment()]) all.set(i.id, (all.get(i.id) ?? 0) + i.count);
        return all;
    };
    const offBank = s.onTick(observeBank);
    try {
        const before = totals();
        const coinsBefore = before.get(COINS) ?? 0;
        const entryCoins = s.sdk.getInventory().find(i => i.id === COINS);
        if (entryCoins) {
            const g = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > g, { timeoutTicks: 20 }))) {
                throw Error('adaptive Ranged entry-coin bank unobserved');
            }
            await depositObserved(sess, entryCoins);
            await s.bot.closeBank();
            if (!(await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 5 }))) throw Error('adaptive Ranged entry-coin bank close unobserved');
        }
        const guarded = {
            ...s,
            bot: new Proxy(s.bot, {
                get(bot, key) {
                    if (key === 'closeBank') {
                        return async () => {
                            observeBank();
                            return bot.closeBank();
                        };
                    }
                    if (key === 'withdrawItem') {
                        return async (item: Parameters<Session['bot']['withdrawItem']>[0], amount: number, ...rest: unknown[]) => {
                            if (typeof item === 'object' && 'id' in item && item.id === COINS) {
                                const held = countPackItems(s.sdk.getInventory(), COINS);
                                const spent = coinsBefore - (totals().get(COINS) ?? 0);
                                const available = preparationFunds(coinsBefore, spent, o.maxSpend, o.coinReserve);
                                if (!Number.isSafeInteger(amount) || amount < 0 || held + amount > available) {
                                    throw Error('adaptive Ranged fare budget refused');
                                }
                            }
                            return Reflect.apply(bot.withdrawItem, bot, [item, amount, ...rest]);
                        };
                    }
                    const value = Reflect.get(bot, key);
                    return typeof value === 'function' ? value.bind(bot) : value;
                },
            }),
        } as CombatSession;
        const delegatedCap = o.cap - (s.tick() - start);
        if (delegatedCap < 800) throw Error('adaptive Ranged preparation exhausted the finite cap');
        const r = await runGiants(guarded, {
            cap: delegatedCap,
            trainSkill: 'Ranged',
            targetLevel: bandTarget,
            site: TROOPER_SITE,
            food: o.food,
            ammo: o.ammo,
            ammoPickup: true,
            rangedKit: kit,
            bury: false,
            stop: o.stop,
            walk: async (x, z, tol = 2, signal) => {
                if (o.stop?.()) return false;
                const out = await combatFerryWalk(guarded, { x, z, level: 0 }, async (tile, planBudgetMs) =>
                    goTo(guarded as Session, await getWorld(), tile, recoveryWalker(accountOf(sess)), {
                        maxRetriesPerLeg: 2,
                        legTimeoutTicks: 150,
                        signal,
                        planBudgetMs,
                    }),
                );
                const p = s.sdk.getState()?.player;
                return out.ok && !!p && p.level === 0 && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
            },
        });
        const after = totals();
        const coinDebit = coinsBefore - (after.get(COINS) ?? 0);
        const coinAccounted =
            Number.isSafeInteger(coinDebit) && coinDebit >= 0 && coinDebit <= o.maxSpend && (after.get(COINS) ?? 0) >= o.coinReserve;
        const variable = new Set([COINS, ...TROOPER_SITE.foods, ...(r.ammoId === undefined ? [] : [r.ammoId])]);
        const preserved = r.preserved && [...new Set([...before.keys(), ...after.keys()])].every(id => variable.has(id) || before.get(id) === after.get(id));
        return {
            ...r,
            ok: r.ok && r.targetMet && preserved && coinAccounted,
            preserved,
            targetMet: r.targetMet,
            targetLevel: bandTarget,
            xpGain: r.selectedXp,
            ticks: s.tick() - start,
            method,
            decision,
            bandTarget,
            bow: s.sdk.getEquipment().find(i => BOW_IDS.includes(i.id))?.id ?? 0,
            arrow: r.ammoId ?? 0,
            arrowsSpent: r.ammoUsed ?? 0,
            accounting: r.foodAccounted && preserved && coinAccounted,
            coinsSpent: coinDebit,
            coinDebit,
            travelSpent: coinDebit,
        };
    } finally {
        offBank();
    }
}

export async function runAdaptiveRanged(s: CombatSession, o: RangedTrainOptions, options: RangedAdaptiveDeps = {}) {
    const start = s.tick();
    const startXp = s.sdk.getSkillXp('Ranged');
    const startLevel = s.sdk.getSkill('Ranged')?.baseLevel;
    if (startXp === null || startXp === undefined || !startLevel) throw Error('adaptive Ranged skill observation unknown');
    const recovery = await recoverRangedStart(s, o.stop);
    if (recovery?.stopped) throw Error('stop file during Ranged entry recovery');
    const segments: Awaited<ReturnType<typeof runAdaptiveRangedBand>>[] = [];
    const spent = () => segments.reduce((n, r) => n + ('coinsSpent' in r ? r.coinsSpent : 0), 0);
    for (let band = 0; band < 12; band++) {
        const before = s.sdk.getSkill('Ranged')!.baseLevel;
        const remaining = o.cap - (s.tick() - start);
        if (remaining < 800 || o.stop?.()) break;
        if (band) {
            if (s.sdk.getState()?.bank?.isOpen) await s.bot.closeBank();
            const rec = await recoverRangedStart(s, o.stop);
            if (rec?.stopped) break;
        }
        const r = await runAdaptiveRangedBand(s, { ...o, cap: remaining, maxSpend: Math.max(0, o.maxSpend - spent()) }, options);
        segments.push(r);
        if (!r.ok || s.sdk.getSkill('Ranged')!.baseLevel >= o.target || (!('acquired' in r && r.acquired) && s.sdk.getSkill('Ranged')!.baseLevel <= before)) {
            break;
        }
    }
    const last = segments.at(-1);
    if (!last) throw Error('adaptive Ranged stopped before a finite band could start');
    const finalLevel = s.sdk.getSkill('Ranged')!.baseLevel;
    const targetMet = finalLevel >= o.target;
    const ammoDebits: Record<number, number> = {};
    for (const r of segments) if ('arrow' in r && 'arrowsSpent' in r) ammoDebits[r.arrow] = (ammoDebits[r.arrow] ?? 0) + r.arrowsSpent;
    return {
        ...last,
        ok: segments.every(r => r.ok) && targetMet,
        targetMet,
        targetLevel: o.target,
        startLevel,
        finalLevel,
        xpGain: s.sdk.getSkillXp('Ranged')! - startXp,
        ticks: s.tick() - start,
        coinsSpent: spent(),
        coinDebit: spent(),
        arrowsSpent: Object.values(ammoDebits).reduce((n, v) => n + v, 0),
        ammoDebits,
        segments: segments.map(r => ({
            method: r.method,
            target: 'bandTarget' in r ? r.bandTarget : o.target,
            ok: r.ok,
            xpGain: r.xpGain,
            ticks: r.ticks,
        })),
    };
}

// Fresh Ranged starter route
export function freshRangedStart(
    player: { worldX: number; worldZ: number; level: number } | null | undefined,
    ranged: number,
    xp: number,
): boolean {
    return !!player && player.level === 0 && player.worldX >= 3070 && player.worldX < 3160 && player.worldZ >= 3050 && player.worldZ < 3130 && ranged === 1 && xp === 0;
}

export async function runRangedStarter(
    session: CombatSession,
    stopRequested: () => boolean,
    leaveStarter?: (s: CombatSession, stop: () => boolean) => Promise<void>,
): Promise<boolean> {
    const sess = session as Session;
    const check: (value: unknown, message: string) => asserts value = (value, message) => {
        if (!value) throw Error(message);
    };
    const player = () => session.sdk.getState()?.player;
    const hp = () => session.sdk.getSkill('Hitpoints')?.level ?? 0;
    const ranged = () => session.sdk.getSkill('Ranged')?.baseLevel ?? 0;
    const xp = () => session.sdk.getSkillXp('Ranged') ?? -1;
    const start = session.tick();
    const life = player()?.lifeId;
    const stopped = () => stopRequested() || hp() < 6 || player()?.isDead === true || player()?.lifeId !== life;
    let ok = false;
    try {
        const tutorial = player();
        check(freshRangedStart(tutorial, ranged(), xp()), 'fresh tutorial start required');
        if (!leaveStarter) throw Error('ranged-starter requires leaveStarter callback for Tutorial Island');
        await leaveStarter(session, stopped);
        const p = player();
        const mainland = !!p && p.level === 0 && Math.abs(p.worldX - 3222) <= 3 && Math.abs(p.worldZ - 3222) <= 6;
        const starter = session.sdk.getInventory().map(({ id, count }) => ({ id, count }));
        check(
            mainland && p && ranged() === 1 && xp() === 0 && hp() === 10 && starter.some(i => i.id === 841 && i.count === 1) && starter.some(i => i.id === 882 && i.count === 25),
            'fresh Lumbridge and tutorial bow/ammunition required',
        );
        console.log('LUMBRIDGE ' + JSON.stringify({ x: p!.worldX, z: p!.worldZ, hp: hp(), ranged: ranged(), xp: xp(), starter }));
        const coins = () => countPackItems(session.sdk.getInventory(), 995);
        const thieving = () => session.sdk.getSkillXp('Thieving') ?? -1;
        const beforeXp = thieving();
        const earnStart = session.tick();
        while (coins() < 27 && session.tick() - earnStart < 900) {
            check(!stopped(), 'stopped during starter coin earning');
            if (hp() <= 7) {
                check(await waitUntil(session, () => hp() >= 9 || stopped(), { timeoutTicks: 320 }), 'starter HP recovery timed out');
                continue;
            }
            const man = session.sdk
                .getState()
                ?.nearbyNpcs.filter(n => /^man$/i.test(n.name) && n.x >= 3210 && n.x <= 3234 && n.z >= 3205 && n.z <= 3235 && n.reachable !== false)
                .sort((a, b) => a.distance - b.distance)[0];
            check(man, 'Lumbridge man unavailable');
            const hpBefore = hp();
            await session.bot.pickpocketNpc(man!);
            await waitTicks(session, hp() < hpBefore ? 8 : 2);
        }
        const here = player();
        check(here, 'starter coin earning position unavailable');
        await session.sdk.sendWalk(here!.worldX, here!.worldZ);
        await waitTicks(session, 4);
        check(coins() >= 27 && coins() * 200 === (thieving() - beforeXp) * 3 && !stopped(), 'starter coins failed reconciliation');
        console.log('STARTER_COINS ' + JSON.stringify({ coins: coins(), xp: thieving() - beforeXp, ticks: session.tick() - earnStart }));
        const walker = await sessionWalker(sess);
        const guard = {
            ...walker,
            walk: async (x: number, z: number) => {
                const from = walker.pos();
                check(from && from.level === 0, 'ground route required');
                const path = walker.plan(0, from!, { x, z });
                check(path.length > 0 && !expandPath(from!, path).some(t => t.x < 3250 && t.z >= 3350 && t.z <= 3390), 'walk path absent or crosses Varrock dark-wizard corridor');
                return walker.walk(x, z);
            },
        };
        const walked = await walkPath(guard, STARTER_ROUTE, { maxTicks: 430, stop: stopped });
        check(walked.ok && rangedEntry(player()) && !stopped(), 'Varrock East walk: ' + walked.detail);
        console.log('RANGED_ENTRY ' + JSON.stringify({ tick: session.tick() - start, hp: hp(), x: player()?.worldX, z: player()?.worldZ }));
        const result = await runRangedTrain(session, {
            target: 5,
            cap: 1800,
            minArrows: 3,
            buyArrows: 0,
            buyArrowId: 882,
            maxSpend: 52,
            coinReserve: 0,
            ammo: 25,
            food: 2,
            foodId: 329,
            killsPerTrip: 3,
            maxTrips: 3,
            stop: stopped,
        });
        console.log('TRAINING ' + JSON.stringify(result));
        check(
            result.ok && result.kills > 0 && result.xpGain > 0 && result.startLevel === 1 && result.bow === 841 && result.arrow === 882 && !stopped(),
            'starter Ranged job failed: ' + result.failure,
        );
        ok = true;
    } catch (error) {
        console.error(String(error));
    }
    const closed = await settle([sess], ok, 'fresh Ranged starter route');
    return ok && closed;
}

// Safespot Blue Dragon ranged camp
export const BLUE_DRAGON = {
    name: 'blue-dragon',
    npc: 55,
    deathAnim: 92,
    hp: 105,
    safe: { x: 2895, z: 9792 },
    loot: [536, 1751],
    weapon: 837,
    ammo: 877,
    shield: 1540,
    rangeLevel: 40,
} as const;

export type CampProfile = {
    name: string;
    npc: number;
    deathAnim: number;
    hp: number;
    safe: { x: number; z: number };
    loot: readonly number[];
    weapon: number;
    ammo: number;
    shield: number;
    rangeLevel: number;
};

export function selectCampTarget(npcs: readonly NearbyNpc[], p: CampProfile, selfSlot?: number) {
    return npcs
        .filter(
            n =>
                n.id === p.npc
                && n.reachable !== false
                && (!n.inCombat || (Number.isInteger(selfSlot) && n.targetIndex === 32768 + selfSlot!))
                && ((n.hp === null && n.maxHp === null) || (n.hp === p.hp && n.maxHp === p.hp))
                && Math.max(Math.abs(n.x - p.safe.x), Math.abs(n.z - p.safe.z)) <= 10
                && n.optionsWithIndex.some(o => /^attack$/i.test(o.text)),
        )
        .sort(
            (a, b) =>
                Number(b.inCombat && b.targetIndex === 32768 + selfSlot!) - Number(a.inCombat && a.targetIndex === 32768 + selfSlot!)
                || a.distance - b.distance,
        )[0];
}

export function campCombatRefusal(messages: BotWorldState['gameMessages'], revision: number, tick: number) {
    return messages.some(
        m =>
            m.type === 0
            && !m.sender
            && !m.fromSelf
            && (m.observationId !== undefined ? m.observationId > revision : m.tick > tick)
            && /^I.m already under attack[!.]?$/i.test(m.text),
    );
}

export function campOwnershipConflict(n: Pick<NearbyNpc, 'hp' | 'inCombat' | 'targetIndex'>, selfSlot: number) {
    return n.hp !== 0 && n.inCombat && n.targetIndex !== 32768 + selfSlot;
}

export function campDeathCredit(o: { witness: boolean; foreign: boolean; xp: number; loot: readonly number[] }, p: CampProfile) {
    return o.witness && !o.foreign && o.xp >= p.hp * 4 && o.loot.length === p.loot.length && o.loot.every(n => n === 1);
}

export async function runRangedCamp(s: CombatSession, p: CampProfile, o: { cap: number; stop?: () => boolean; returnSafe?: boolean }) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 10000) throw Error('invalid camp cap');
    holdSessionEater(s.sdk);
    const st = () => s.sdk.getState();
    const player = () => st()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = () => s.sdk.getSkillXp('Ranged') ?? 0;
    const held = (id: number) => countPackItems(inv(), id);
    const p0 = player();
    const hp0 = hp();
    const near = () => {
        const q = player();
        return !!q && q.level === 0 && Math.max(Math.abs(q.worldX - p.safe.x), Math.abs(q.worldZ - p.safe.z)) <= 1;
    };
    const own = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
    if (
        !p0
        || !near()
        || hp0 < 30
        || (s.sdk.getSkill('Ranged')?.level ?? 0) < p.rangeLevel
        || !Number.isInteger(own)
        || !eq().some(i => i.slot === 3 && i.id === p.weapon)
        || !eq().some(i => i.slot === 5 && i.id === p.shield)
        || countPackItems(eq(), p.ammo) < 100
        || inv().length > 26
    ) {
        throw Error('stage ranged camp position, HP30, level, crossbow/shield/100 bolts and two free slots');
    }
    if (typeof st()?.autoRetaliateEnabled !== 'boolean') throw Error('auto-retaliate state unknown');
    let drops: Record<number, number> = {};
    const ground0 = new Map<string, number>();
    for (const i of st()!.groundItems) {
        const key = `${i.id}:${i.x}:${i.z}`;
        ground0.set(key, (ground0.get(key) ?? 0) + i.count);
    }
    let ended = false;
    let foreign = false;
    let witness = false;
    let injured = false;
    let failure = '';
    let targetIndex: number | undefined;
    let death: { x: number; z: number } | undefined;
    void s.ended.then(() => {
        ended = true;
    });
    const initialRetaliate = st()!.autoRetaliateEnabled;
    const start = s.tick();
    const xp0 = xp();
    const loot0 = p.loot.map(held);
    const ammo0 = countPackItems(eq(), p.ammo) + held(p.ammo);
    const otherPlayers = () => st()?.nearbyPlayers.some(n => n.name.toLowerCase() !== p0.name.toLowerCase()) ?? true;
    const unsafe = () => {
        const q = player();
        return !q || q.isDead || q.lifeId !== p0.lifeId || q.level !== 0 || hp() < hp0;
    };
    const over = () => ended || unsafe() || foreign || !!o.stop?.() || s.tick() - start >= o.cap;
    const off = s.onTick(() => {
        injured ||= !witness && unsafe();
        foreign ||= otherPlayers();
        if (targetIndex !== undefined) {
            const n = st()?.nearbyNpcs.find(npc => npc.index === targetIndex && npc.id === p.npc);
            if (n) {
                if (campOwnershipConflict(n, own!)) foreign = true;
                if (n.hp === 0 || n.animId === p.deathAnim) {
                    witness = true;
                    death = { x: n.tileX ?? n.x, z: n.tileZ ?? n.z };
                }
            }
        }
    });
    try {
        if (otherPlayers()) throw Error('isolated camp required for exclusive kill credit');
        if (initialRetaliate) {
            await s.direct({ type: 'clickComponent', componentId: 151, reason: 'finite camp target ownership' });
            if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 }))) throw Error('auto-retaliate off unobserved');
        }
        if (over()) throw Error('camp stopped before attack');
        for (let i = 0; i < 8 && !over(); i++) await waitTicks(s, 1);
        let acknowledged = false;
        for (let attempt = 0; attempt < 2 && !over(); attempt++) {
            const before = st()!;
            const revision = Math.max(0, ...before.gameMessages.map(m => m.observationId ?? 0));
            const tick = s.tick();
            const target = selectCampTarget(before.nearbyNpcs, p, own);
            if (!target) throw Error('fresh or undamaged native camp target missing');
            targetIndex = target.index;
            const option = target.optionsWithIndex.find(v => /^attack$/i.test(v.text))!;
            if (!(await s.sdk.sendInteractNpc(target.index, option.opIndex)).success) throw Error('camp attack refused');
            await waitUntil(
                s,
                () => over() || xp() > xp0 || countPackItems(eq(), p.ammo) + held(p.ammo) < ammo0 || campCombatRefusal(st()?.gameMessages ?? [], revision, tick),
                { timeoutTicks: 12 },
            );
            if (xp() > xp0 || countPackItems(eq(), p.ammo) + held(p.ammo) < ammo0) {
                acknowledged = true;
                break;
            }
            if (!campCombatRefusal(st()?.gameMessages ?? [], revision, tick)) throw Error('camp attack had no observed ammo or damage effect');
            for (let i = 0; i < 8 && !over(); i++) await waitTicks(s, 1);
        }
        if (!acknowledged) throw Error('camp single-combat admission did not settle');
        let lastProgress = s.tick();
        let lastXp = xp();
        while (!over() && !witness) {
            await waitTicks(s, 1);
            if (xp() > lastXp) {
                lastXp = xp();
                lastProgress = s.tick();
            }
            if (s.tick() - lastProgress > 180) throw Error('camp no ranged damage for180 ticks');
            if (!near()) throw Error('camp attack moved off safespot');
            if (countPackItems(eq(), p.ammo) + held(p.ammo) < 1) throw Error('camp ammo depleted');
        }
        if (over() || !witness || !death) throw Error('camp death not observed inside budget');
        if (!(await waitUntil(s, () => p.loot.every(id => s.sdk.getGroundItems().some(i => i.id === id && i.x === death!.x && i.z === death!.z)), { timeoutTicks: 12 }))) {
            throw Error('camp guaranteed loot missing');
        }
        const fresh = s.sdk.getGroundItems().filter(i => i.x === death!.x && i.z === death!.z && i.id !== p.ammo);
        if (fresh.some(i => (ground0.get(`${i.id}:${i.x}:${i.z}`) ?? 0) > 0)) throw Error('camp drop attribution ambiguous');
        const ids = [...new Set(fresh.map(i => i.id))];
        const client = s.client as { objType: (id: number) => { cost: number; stackable: boolean } };
        const picked = await runVisibleGroundLoot(
            {
                state: () => {
                    const v = st();
                    return v && { ...v, groundItems: v.groundItems.filter(i => i.x === death!.x && i.z === death!.z && ids.includes(i.id)) };
                },
                tick: () => s.tick(),
                stop: over,
                definition: id => client.objType(id),
                pickup: async i => (await s.sdk.sendPickup(i.x, i.z, i.id)).success,
                wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
                step: () => waitTicks(s, 1),
                clearModal: async () => {
                    await s.sdk.sendCloseModal();
                },
            },
            { mode: 'list', ids, names: [], minimumValue: 0, maximumValue: 2147483647, radius: 12, maximumUnits: fresh.reduce((n, i) => n + i.count, 0), cap: 40, idleTicks: 12 },
        );
        drops = Object.fromEntries(Object.entries(picked.acquired).filter(([id]) => Number(id) !== p.ammo));
    } catch (e) {
        failure = String(e);
    } finally {
        off();
        if (!ended && player()?.lifeId === p0.lifeId && !player()?.isDead) {
            try {
                if (o.returnSafe !== false) {
                    const result = await walkPath(await sessionWalker(s as Session), [{ ...p.safe, tol: 0 }], { maxTicks: 60, stop: () => ended || !!player()?.isDead });
                    if (!result.ok || !near()) throw Error('safespot return failed');
                }
                if (st()?.autoRetaliateEnabled !== initialRetaliate) {
                    await s.direct({ type: 'clickComponent', componentId: initialRetaliate ? 150 : 151, reason: 'restore camp auto-retaliate' });
                    if (!(await waitUntil(s, () => st()?.autoRetaliateEnabled === initialRetaliate, { timeoutTicks: 8 }))) throw Error('retaliate restore missing');
                }
            } catch (e) {
                failure += '; cleanup ' + String(e);
            }
        }
    }
    const loot = p.loot.map((id, n) => held(id) - loot0[n]!);
    const gain = xp() - xp0;
    const credited = campDeathCredit({ witness, foreign, xp: gain, loot }, p);
    return {
        ok: !failure && !ended && !injured && !o.stop?.() && (o.returnSafe === false || near()) && player()?.lifeId === p0.lifeId && !player()?.isDead && hp() > 0 && credited,
        profile: p.name,
        failure,
        witness,
        foreign,
        injured,
        loot,
        drops,
        credited,
        rangedXp: gain,
        ammoUsed: ammo0 - countPackItems(eq(), p.ammo) - held(p.ammo),
        ticks: s.tick() - start,
    };
}

// CLI dispatchers
export async function runRangedGatherCli(account: string, env: Record<string, string | undefined> = process.env) {
    const alch = combatAlchPolicy(env);
    const potions = combatPotionPolicy(env);
    let stopped = false;
    const s = await openBot(account, {
        onStop: async () => {
            stopped = true;
        },
    });
    try {
        const r = await runRanged(s, {
            cap: Number(env.CAP ?? 1800),
            maximum: Number(env.MAX_KILLS ?? 2),
            ammo: Number(env.AMMO ?? 90),
            food: Number(env.FOOD ?? 3),
            foodId: Number(env.FOOD_ID ?? 333),
            telegrab: telegrabPolicy(env),
            alch,
            potions,
            stop: () => stopped,
        });
        console.log('RANGED_BANK ' + JSON.stringify(r));
        await finish([s], r.ok, (r.ok ? '' : r.stop === 'stop-file' ? 'stop file ' : 'no Ranged progress: ') + JSON.stringify(r));
        return r;
    } catch (e) {
        await finish([s], false, 'no Ranged progress: ' + String(e));
        throw e;
    }
}

export async function runRangedStarterCli(
    account: string,
    leaveStarter?: (s: CombatSession, stop: () => boolean) => Promise<void>,
) {
    if (!account || !/^[a-z0-9]{1,12}$/i.test(account)) throw Error('starter requires one account name');
    const root = resolve(import.meta.dir, '../../../..');
    const envPath = resolveBotEnvPath(account, root);
    const server = existsSync(envPath) ? serverFromEnv(readFileSync(envPath, 'utf8')) : 'localhost:8888';
    const holds = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(server) ? [account] : ['all', account];
    const stopped = () => holds.some(key => existsSync(resolve(root, '.practice', 'stop-' + key)));
    if (stopped()) throw Error('starter launch held by stop file');
    const session = await openBot(account);
    const ok = await runRangedStarter(session, stopped, leaveStarter);
    process.exitCode = ok ? 0 : 1;
    return ok;
}

export async function runRangedCampCli(account: string, args: readonly string[] = [], env: Record<string, string | undefined> = process.env) {
    let s: Session | undefined;
    let stopped = false;
    try {
        const cap = Number(args[0] ?? env.CAP ?? 5000);
        s = await openBot(account, {
            onStop: async () => {
                stopped = true;
            },
        });
        const stop = () => stopped || existsSync('.practice/stop-microbot-camp') || existsSync('.practice/stop-all');
        const r =
            env.STAGED === '1'
                ? await runRangedCamp(s, BLUE_DRAGON, { cap: Number(args[0] ?? env.CAP ?? 3000), stop })
                : await combatTrip(s, 'blue', tripStop => runRangedCamp(s!, BLUE_DRAGON, { cap: 2500, stop: tripStop, returnSafe: false }), { cap, stop });
        console.log('RANGED_CAMP_RESULT ' + JSON.stringify(r));
        await finish([s], r.ok, JSON.stringify(r));
        return r;
    } catch (e) {
        await finish(s ? [s] : [], false, String(e));
        throw e;
    }
}
