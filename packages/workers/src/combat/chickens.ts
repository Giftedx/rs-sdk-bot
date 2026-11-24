// One-time qualification for the mixed ore mine. Rat6 ignores players above combat12 outside the Wilderness
// (engine/entity/Npc.ts checkNotTooStrong). Train on Lumbridge chickens, then return the owned kit to its bank.
import { existsSync } from 'node:fs';
import { finish, openBot, randomEventsOf } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { expandPath, sessionWalker, walkPath, type PathDeps, type PathTile } from '../../../core/src/walk';
import type { GearSkillLevels, QuestInput } from './gear';
import type { CombatSession } from './types';
import { levelForXp, xpForLevel } from './xp';

let cachedGearMod: typeof import('./gear') | undefined;
const loadGearMod = (): typeof import('./gear') => (cachedGearMod ??= require('./gear'));

const DARK_WIZARD_RE = /^dark wizard$/i;
const BEAR_RE = /^bear$/i;
const ARDOUGNE_THREAT_RE = /^(giant bat|wolf|white wolf|scorpion)$/i;
const DEFAULT_THREAT_RE = /^(giant rat|dark wizard|mugger|barbarian|highwayman|jail guard)$/i;
const CHICKEN_RE = /^chicken$/i;
const ATTACK_RE = /^attack$/i;

const LOWER_HEALTH_MIN_WEAPON_SCORE = 1173;

export type ChickenEntry = 'standard' | 'lower-health';

export function chickenTrainingKit(
    items: readonly { id: number; count?: number }[],
    options: { levels?: GearSkillLevels; quests?: QuestInput; entry?: ChickenEntry; trainSkill?: string } = {},
): number[] {
    const { scoreGearForStyle, selectCombatLoadout } = loadGearMod();
    const stock = items.map(i => ({ id: i.id, count: i.count ?? 1 }));
    const entry = options.entry ?? 'standard';
    const loadout = selectCombatLoadout('melee', stock, options.levels, options.quests, {
        trainSkill: options.trainSkill ?? 'all-melee',
        requireWeapon: true,
        ...(entry === 'lower-health' ? { requireShield: true, minWeaponStrength: 5, minShieldDefence: 4 } : {}),
    });
    const weapon = loadout.worn.weapon;
    if (!weapon) {
        if (entry === 'lower-health') throw Error('lower-health training requires owned melee weapon (>= bronze sword strength) and shield');
        throw Error('missing owned training weapon');
    }
    if (entry === 'lower-health' && (!loadout.worn.shield || scoreGearForStyle(weapon, 'melee') < LOWER_HEALTH_MIN_WEAPON_SCORE)) {
        throw Error('lower-health training requires owned bronze sword/wooden shield equivalent or better');
    }
    return loadout.items.map(entryItem => entryItem.item.id);
}

export function chickenDesiredSkill(levels: { Attack: number; Strength: number; Defence: number }): 'Attack' | 'Strength' | 'Defence' {
    const { Attack, Strength, Defence } = levels;
    if (
        !Number.isSafeInteger(Attack) || Attack < 1
        || !Number.isSafeInteger(Strength) || Strength < 1
        || !Number.isSafeInteger(Defence) || Defence < 1
    ) {
        throw Error('training skills unavailable');
    }
    if (Strength <= Attack && Strength <= Defence) return 'Strength';
    if (Attack <= Defence) return 'Attack';
    return 'Defence';
}

export function chickenTrainingStyle(levels: { Attack: number; Strength: number; Defence: number }): number {
    const map = { Strength: 1, Attack: 0, Defence: 3 } as const;
    return map[chickenDesiredSkill(levels)];
}

type ChickenStyleTab = {
    known: boolean;
    weaponName?: string;
    currentStyle: number;
    styles?: readonly { index: number; name?: string; trainsSkills: readonly string[] }[];
};

export function chickenStyleForWeapon(tab: ChickenStyleTab | undefined, skill: 'Attack' | 'Strength' | 'Defence'): number {
    if (!tab?.known) throw Error('training weapon combat styles unknown');
    const matched = tab.styles?.find(s => s.trainsSkills.length === 1 && s.trainsSkills[0] === skill);
    if (!matched) throw Error(`${tab.weaponName || 'training weapon'} has no style that trains only ${skill}`);
    return matched.index;
}

const ROUTE = [
    { x: 3253, z: 3420, tol: 2 },
    { x: 3207, z: 3429, tol: 0 },
    { x: 3171, z: 3427, tol: 0 },
    { x: 3200, z: 3384, tol: 0 },
    { x: 3198, z: 3370, tol: 0 },
    { x: 3200, z: 3348, tol: 0 },
    { x: 3200, z: 3310, tol: 0 },
    { x: 3230, z: 3298, tol: 0 },
];
const DRAYNOR_ROUTE = [
    { x: 3092, z: 3243, tol: 2 },
    ...[
        [3092, 3250],
        [3089, 3266],
        [3088, 3285],
        [3088, 3320],
        [3180, 3320],
        [3200, 3310],
        [3230, 3298],
    ].map(([x, z]) => ({ x: x!, z: z!, tol: 0 })),
];
const ARDOUGNE_ROUTE = [
    { x: 2654, z: 3283, tol: 2 },
    { x: 2664, z: 3283, tol: 0 },
    { x: 2678, z: 3282, tol: 0 },
    { x: 2691, z: 3277, tol: 0 },
];

export function chickenTrainingProfile(bank = 'varrock') {
    if (!['varrock', 'draynor', 'ardougne'].includes(bank)) throw Error('unsupported training bank: ' + bank);
    return {
        bank,
        route: bank === 'ardougne' ? ARDOUGNE_ROUTE : bank === 'draynor' ? DRAYNOR_ROUTE : ROUTE,
        pen: bank === 'ardougne' ? { x0: 2686, x1: 2700, z0: 3268, z1: 3283 } : { x0: 3223, x1: 3236, z0: 3293, z1: 3303 },
    };
}

export const ardougneTrainingTile = (p: PathTile) => p.x >= 2644 && p.x <= 2703 && p.z >= 3264 && p.z <= 3290;

export function guardArdougneTrainingWalker(base: PathDeps) {
    let reason: string | null = null;
    const validate = (level: number, from: PathTile, to: PathTile, corners: PathTile[]) => {
        const end = corners.at(-1);
        if (
            level !== 0
            || !ardougneTrainingTile(from)
            || !ardougneTrainingTile(to)
            || (!end && (from.x !== to.x || from.z !== to.z))
            || (end && Math.max(Math.abs(end.x - to.x), Math.abs(end.z - to.z)) > 1)
            || expandPath(from, corners).some(p => !ardougneTrainingTile(p))
        ) {
            reason =
                'Ardougne training route outside admitted corridor or incomplete '
                + JSON.stringify({ level, from, to, end, unsafe: expandPath(from, corners).find(p => !ardougneTrainingTile(p)) });
            return false;
        }
        return true;
    };
    const refuse = () => ({ success: false, phase: 'dispatch', reason: 'training_route_guard', message: reason ?? 'training route unknown' });
    const deps: PathDeps = {
        ...base,
        plan: (level, from, to) => {
            const path = base.plan(level, from, to);
            return validate(level, from, to, path) ? path : [];
        },
        walk: (x, z) => {
            const p = base.pos();
            return !p || reason || !validate(p.level, p, { x, z }, base.plan(p.level, p, { x, z })) ? refuse() : base.walk(x, z);
        },
        interactLoc: (loc, op) => (reason ? refuse() : base.interactLoc(loc, op)),
    };
    return { deps, reason: () => reason };
}

export function chickenTrainingEntry(entry = 'standard'): ChickenEntry {
    if (entry !== 'standard' && entry !== 'lower-health') throw Error('unsupported training entry mode');
    return entry;
}

export function chickenCombatUnlockPlan(
    levels: { Attack: number; Defence: number; Hitpoints: number; Prayer: number; Ranged: number; Magic: number },
    xp: { Strength: number; Defence: number; Hitpoints: number },
    target = 29,
) {
    if (
        !Number.isSafeInteger(levels.Attack) || levels.Attack < 1 || levels.Attack > 99
        || !Number.isSafeInteger(levels.Defence) || levels.Defence < 1 || levels.Defence > 99
        || !Number.isSafeInteger(levels.Hitpoints) || levels.Hitpoints < 1 || levels.Hitpoints > 99
        || !Number.isSafeInteger(levels.Prayer) || levels.Prayer < 1 || levels.Prayer > 99
        || !Number.isSafeInteger(levels.Ranged) || levels.Ranged < 1 || levels.Ranged > 99
        || !Number.isSafeInteger(levels.Magic) || levels.Magic < 1 || levels.Magic > 99
        || !Number.isFinite(xp.Strength) || xp.Strength < 0
        || !Number.isFinite(xp.Defence) || xp.Defence < 0
        || !Number.isFinite(xp.Hitpoints) || xp.Hitpoints < 0
    ) {
        throw Error('combat unlock observations unavailable');
    }
    const startDef = levelForXp(xp.Defence);
    if (startDef !== levels.Defence || levelForXp(xp.Hitpoints) !== levels.Hitpoints) {
        throw Error('combat unlock XP and levels disagree');
    }
    const startStr = levelForXp(xp.Strength);
    const otherTerm = Math.max(
        0.325 * (Math.floor(levels.Ranged / 2) + levels.Ranged),
        0.325 * (Math.floor(levels.Magic / 2) + levels.Magic),
    );
    const prayHalf = Math.floor(levels.Prayer / 2);
    const defCosts = new Array<number>(100);
    for (let d = startDef; d <= 99; d++) {
        defCosts[d] = Math.max(0, xpForLevel(d) - xp.Defence);
    }
    let best: { strength: number; defence: number; hitpoints: number; combat: number; requiredXp: number } | undefined;
    for (let strength = startStr; strength <= 99; strength++) {
        const strCost = Math.max(0, xpForLevel(strength) - xp.Strength);
        if (best && strCost > best.requiredXp) break;
        const maxTerm = Math.max(0.325 * (levels.Attack + strength), otherTerm);
        for (let defence = startDef; defence <= 99; defence++) {
            const requiredXp = strCost + defCosts[defence]!;
            if (best && requiredXp > best.requiredXp) break;
            const hitpoints = levelForXp(xp.Hitpoints + Math.floor((requiredXp * 13) / 40));
            const combat = Math.floor(0.25 * (defence + hitpoints + prayHalf) + maxTerm);
            if (combat >= target) {
                if (!best || requiredXp < best.requiredXp || (requiredXp === best.requiredXp && strength > best.strength)) {
                    best = { strength, defence, hitpoints, combat, requiredXp };
                }
                break;
            }
        }
    }
    if (!best) throw Error('melee cannot establish requested combat unlock');
    return best;
}

export function chickenCombatUnlockSkill(
    levels: { Strength: number; Defence: number },
    plan: { strength: number; defence: number },
): 'Strength' | 'Defence' {
    if (levels.Strength < Math.min(6, plan.strength)) return 'Strength';
    if (levels.Defence < plan.defence) return 'Defence';
    if (levels.Strength < plan.strength) return 'Strength';
    throw Error('planned melee levels exhausted before observed combat unlock');
}

export function chickenCombatUnlockStyle(levels: { Strength: number; Defence: number }, plan: { strength: number; defence: number }): number {
    return chickenCombatUnlockSkill(levels, plan) === 'Defence' ? 3 : 1;
}

export function chickenCombatUnlockMode(
    bank: string,
    skill: string | undefined,
    level: number | undefined,
    entry: ChickenEntry,
    target: number,
): boolean {
    if (skill !== 'CombatUnlock') return false;
    if (bank !== 'ardougne' || entry !== 'lower-health' || level !== undefined || target !== 29) {
        throw Error('CombatUnlock requires lower-health Ardougne combat29 without a fixed skill target');
    }
    return true;
}

export function chickenTrainingHealth(bank: string, current: number, maximum: number, entry: ChickenEntry = 'standard') {
    chickenTrainingEntry(entry);
    if (entry === 'lower-health') {
        if (bank !== 'ardougne' || !Number.isSafeInteger(current) || !Number.isSafeInteger(maximum) || current < 10 || maximum < 19 || current > maximum) {
            throw Error('lower-health Ardougne entry requires10 current HP and19 maximum HP; damage budget is zero');
        }
        return;
    }
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(maximum) || current > maximum || (bank === 'ardougne' ? current < 27 : current !== maximum || current < 10)) {
        throw Error(bank === 'ardougne' ? 'Ardougne training requires at least27 current HP; damage budget is zero' : 'training requires full HP');
    }
}

export function chickenStrengthGoal(bank: string, skill: string | undefined, level: number | undefined) {
    if (skill === undefined && level === undefined) {
        if (bank === 'ardougne') throw Error('Ardougne training needs explicit Strength target');
        return undefined;
    }
    if (skill !== 'Strength' || !Number.isSafeInteger(level) || level! < 1 || level! > 99) {
        throw Error('training accepts an explicit Strength target1..99');
    }
    return level;
}

export function chickenTrainingThreat(n: { name: string; distance: number }, bank: string): boolean {
    if (bank === 'draynor' && DARK_WIZARD_RE.test(n.name)) return n.distance <= 4;
    if (bank === 'ardougne' && BEAR_RE.test(n.name)) return n.distance <= 4;
    if (bank === 'ardougne' && ARDOUGNE_THREAT_RE.test(n.name)) return n.distance <= 8;
    return DEFAULT_THREAT_RE.test(n.name) && n.distance <= 8;
}

export function chickenTrainingTarget(target = 13): number {
    if (target !== 13 && target !== 29) throw Error('training target must be13 or29');
    return target;
}

export async function trainChickens(
    s: CombatSession,
    cap = 1800,
    bank = 'varrock',
    target = 13,
    options: {
        rawChicken?: number;
        stop?: () => boolean;
        trainSkill?: string;
        targetLevel?: number;
        entry?: ChickenEntry;
        walk?: (points: typeof ROUTE, homeward?: boolean) => Promise<void>;
    } = {},
) {
    chickenTrainingTarget(target);
    const entry = chickenTrainingEntry(options.entry);
    const profile = chickenTrainingProfile(bank);
    const route = profile.route;
    const home = route[0]!;
    const balanced = chickenCombatUnlockMode(bank, options.trainSkill, options.targetLevel, entry, target);
    const strengthTarget = balanced ? undefined : chickenStrengthGoal(bank, options.trainSkill, options.targetLevel);
    if (entry === 'lower-health' && !balanced) throw Error('lower-health entry requires explicit CombatUnlock goal');
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid training cap');
    const rawTarget = options.rawChicken ?? 0;
    if (!Number.isSafeInteger(rawTarget) || rawTarget < 0 || rawTarget > 12) throw Error('raw chicken target must be0..12');
    await waitTicks(s, 3);
    const state = () => s.sdk.getState();
    const pos = () => state()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const combat = () => pos()?.combatLevel ?? 0;
    const first = pos();
    const start = s.tick();
    if (!first || first.level !== 0 || Math.max(Math.abs(first.worldX - home.x), Math.abs(first.worldZ - home.z)) > 6) {
        throw Error(`training requires ${bank} bank start`);
    }
    chickenTrainingHealth(bank, hp(), s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0, entry);
    if (strengthTarget !== undefined) {
        const lvl = (name: string) => s.sdk.getSkill(name)?.baseLevel ?? 0;
        const projected = Math.floor(0.25 * (lvl('Defence') + lvl('Hitpoints') + Math.floor(lvl('Prayer') / 2)) + 0.325 * (lvl('Attack') + strengthTarget));
        if (projected < target) throw Error('Strength target cannot establish the requested combat unlock');
    }
    const unlockPlan = balanced
        ? chickenCombatUnlockPlan(
              Object.fromEntries(['Attack', 'Defence', 'Hitpoints', 'Prayer', 'Ranged', 'Magic'].map(name => [name, s.sdk.getSkill(name)?.baseLevel ?? 0])) as any,
              { Strength: s.sdk.getSkillXp('Strength') ?? NaN, Defence: s.sdk.getSkillXp('Defence') ?? NaN, Hitpoints: s.sdk.getSkillXp('Hitpoints') ?? NaN },
              target,
          )
        : undefined;
    if (unlockPlan) console.log('COMBAT_UNLOCK_PLAN ' + JSON.stringify(unlockPlan));
    const goal = () => combat() >= target && (strengthTarget === undefined || (s.sdk.getSkill('Strength')?.baseLevel ?? 0) >= strengthTarget);
    let hpMin = hp();
    let previousHP = hp();
    let hurt = false;
    let ended = false;
    let kills = 0;
    void s.ended.then(() => {
        ended = true;
    });
    const off = s.onTick(() => {
        const n = hp();
        hpMin = Math.min(hpMin, n);
        if (n < previousHP) hurt = true;
        previousHP = n;
    });
    const threat = () => state()?.nearbyNpcs.find(n => chickenTrainingThreat(n, bank));
    const over = () => ended || hurt || !!options.stop?.() || !!threat() || s.tick() - start >= cap || existsSync(`.practice/stop-${s.name}`);
    const raw = () => s.sdk.getInventory().filter(i => i.id === 2138).reduce((n, i) => n + i.count, 0);
    const assets = () => {
        const totals = new Map<number, number>();
        for (const i of [...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...(state()?.bank.items ?? [])]) totals.set(i.id, (totals.get(i.id) ?? 0) + i.count);
        return totals;
    };
    const xp = () => ['Attack', 'Strength', 'Defence'].reduce((n, name) => n + (s.sdk.getSkillXp(name) ?? 0), 0);
    const halted = () => ended || hurt || !!options.stop?.() || !!threat() || existsSync(`.practice/stop-${s.name}`);
    const walk =
        options.walk
        ?? (async (points: typeof ROUTE, homeward = false) => {
            const base = await sessionWalker(s as Session);
            const guarded = bank === 'ardougne' ? guardArdougneTrainingWalker(base) : null;
            const r = await walkPath(
                guarded?.deps ?? base,
                points,
                homeward ? { maxTicks: 650, stop: halted } : { maxTicks: Math.max(1, Math.min(650, cap - (s.tick() - start))), stop: over },
            );
            if (!r.ok) throw Error(`no training progress: route ${r.detail}; hurt=${hurt} threat=${threat()?.name ?? '-'}`);
        });
    try {
        if (goal() && rawTarget === 0) return { ok: true, combat: combat(), ticks: 0, kills: 0, hpMin, preserved: true };
        if (!(await s.bot.openBank()).success) throw Error('training bank unavailable');
        await waitTicks(s, 2);
        const before = assets();
        const { gearLevelWatch, readSkillLevels, reconcileCombatLoadout } = loadGearMod();
        const levels = readSkillLevels(n => s.sdk.getSkill(n));
        const quests = s.client ? questFlags(s.client) : null;
        const kit = chickenTrainingKit([...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...(state()?.bank.items ?? [])], {
            levels,
            quests,
            entry,
            trainSkill: unlockPlan ? 'all-melee' : strengthTarget !== undefined ? 'Strength' : 'all-melee',
        });
        const pick = s.sdk.getInventory().find(i => i.id === 1265);
        if (pick && !kit.includes(1265) && !(await s.bot.depositItem(pick, -1)).success) throw Error('cannot secure owned pickaxe');
        for (const id of kit) {
            if ([...s.sdk.getInventory(), ...s.sdk.getEquipment()].some(i => i.id === id)) continue;
            const required = id === kit[0] || (entry === 'lower-health' && id === kit[1]);
            if (!required && s.sdk.getInventory().length >= 28) break;
            const item = state()?.bank.items.find(i => i.id === id);
            if (!item || !(await s.bot.withdrawItem(item, 1)).success) throw Error(`missing owned training kit ${id}`);
        }
        await s.bot.closeBank();
        for (const id of kit) {
            if (!s.sdk.getEquipment().some(i => i.id === id)) {
                const item = s.sdk.getInventory().find(i => i.id === id);
                if (!item || !(await s.bot.equipItem(item)).success || !(await waitUntil(s, () => s.sdk.getEquipment().some(i => i.id === id), { timeoutTicks: 6 }))) {
                    throw Error('training kit not worn');
                }
            }
        }
        console.log(`MILESTONE training-outbound combat=${combat()} kit=${kit.join(',')}`);
        const gearWatch = gearLevelWatch(s, 'melee');
        const gearTrain = unlockPlan ? 'all-melee' : strengthTarget !== undefined ? 'Strength' : 'all-melee';
        await walk(route.slice(1));
        let progress = s.tick();
        let lastXp = xp();
        const startXp = lastXp;
        while ((!goal() || raw() < rawTarget) && !over()) {
            if (xp() > lastXp) {
                lastXp = xp();
                progress = s.tick();
            }
            if (s.tick() - progress > 120) throw Error('no training progress: no melee XP for120ticks');
            if (randomEventsOf(s as Session)?.busy()) {
                await waitTicks(s, 1);
                continue;
            }
            if (!state()?.combatStyle?.known && !(await waitUntil(s, () => state()?.combatStyle?.known === true || over(), { timeoutTicks: 6 }))) {
                throw Error('training weapon combat styles unknown');
            }
            const desiredSkill = unlockPlan
                ? chickenCombatUnlockSkill(
                      { Strength: s.sdk.getSkill('Strength')?.baseLevel ?? 0, Defence: s.sdk.getSkill('Defence')?.baseLevel ?? 0 },
                      unlockPlan,
                  )
                : strengthTarget === undefined
                    ? chickenDesiredSkill({
                          Attack: s.sdk.getSkill('Attack')?.baseLevel ?? 0,
                          Strength: s.sdk.getSkill('Strength')?.baseLevel ?? 0,
                          Defence: s.sdk.getSkill('Defence')?.baseLevel ?? 0,
                      })
                    : 'Strength';
            const style = chickenStyleForWeapon(state()?.combatStyle, desiredSkill);
            if (state()?.combatStyle?.currentStyle !== style) {
                if (
                    !(await s.sdk.sendSetCombatStyle(style)).success
                    || !(await waitUntil(s, () => state()?.combatStyle?.known === true && state()?.combatStyle?.currentStyle === style, { timeoutTicks: 6 }))
                ) {
                    throw Error('training style not confirmed');
                }
                console.log(
                    'MILESTONE training-style '
                        + JSON.stringify({ style, skill: desiredSkill, strength: s.sdk.getSkill('Strength')?.baseLevel, defence: s.sdk.getSkill('Defence')?.baseLevel }),
                );
            }
            const npcs = state()?.nearbyNpcs;
            let chicken: NonNullable<typeof npcs>[number] | undefined;
            if (npcs) {
                for (let i = 0; i < npcs.length; i++) {
                    const n = npcs[i]!;
                    if (
                        !n.inCombat
                        && (n.hp ?? 1) > 0
                        && n.reachable !== false
                        && n.x >= profile.pen.x0
                        && n.x <= profile.pen.x1
                        && n.z >= profile.pen.z0
                        && n.z <= profile.pen.z1
                        && CHICKEN_RE.test(n.name)
                        && (!chicken || n.distance < chicken.distance)
                    ) {
                        chicken = n;
                    }
                }
            }
            if (!chicken) {
                await waitTicks(s, 1);
                continue;
            }
            const op = chicken.optionsWithIndex.find(o => ATTACK_RE.test(o.text))?.opIndex;
            if (op === undefined) {
                await waitTicks(s, 1);
                continue;
            }
            const beforeXp = xp();
            await s.sdk.sendInteractNpc(chicken.index, op);
            await waitUntil(s, () => over() || !state()?.nearbyNpcs.some(n => n.index === chicken.index && (n.hp ?? 1) > 0), { timeoutTicks: 30 });
            if (xp() > beforeXp && !state()?.nearbyNpcs.some(n => n.index === chicken.index && (n.hp ?? 1) > 0)) {
                kills++;
                if (gearWatch.crossed()) {
                    await reconcileCombatLoadout(s, {
                        style: 'melee',
                        trainSkill: gearTrain,
                        stop: over,
                        label: 'training kit',
                        loadout: {
                            requireWeapon: true,
                            ...(entry === 'lower-health' ? { requireShield: true, minWeaponStrength: 5, minShieldDefence: 4 } : {}),
                        },
                    });
                }
                if (raw() < rawTarget && s.sdk.getInventory().length < 28) {
                    const loot = () => state()?.groundItems.find(i => i.id === 2138 && Math.max(Math.abs(i.x - chicken.x), Math.abs(i.z - chicken.z)) <= 1);
                    await waitUntil(s, () => over() || !!loot(), { timeoutTicks: 6 });
                    const item = loot();
                    const beforeRaw = raw();
                    if (item) {
                        await s.bot.pickupItem(item);
                        if (!(await waitUntil(s, () => over() || raw() > beforeRaw, { timeoutTicks: 10 }))) {
                            throw Error('raw chicken pickup unobserved');
                        }
                    }
                }
            }
            console.log(`MILESTONE training combat=${combat()} kills=${kills} xp=${xp()} hp=${hp()}`);
        }
        const partial = !goal() && raw() >= rawTarget && s.tick() - start >= cap && !halted() && xp() > startXp;
        if (!partial && (!goal() || raw() < rawTarget || over())) {
            throw Error(`training incomplete combat=${combat()} target=${target} raw=${raw()}/${rawTarget} hurt=${hurt} threat=${threat()?.name ?? '-'}`);
        }
        console.log(`MILESTONE training-return combat=${combat()}`);
        await walk([...route.slice(0, -1)].reverse(), true);
        const wornPick = s.sdk.getEquipment().find(i => i.id === 1265);
        if (wornPick && (!(await s.bot.unequipItem(wornPick)).success || !(await waitUntil(s, () => s.sdk.getInventory().some(i => i.id === 1265), { timeoutTicks: 6 })))) {
            throw Error('training pickaxe not returned to inventory');
        }
        if (!(await s.bot.openBank()).success) throw Error('training return bank unavailable');
        await waitTicks(s, 2);
        const tool = state()?.bank.items.find(i => i.id === 1265);
        if (tool && !s.sdk.getInventory().some(i => i.id === 1265)) await s.bot.withdrawItem(tool, 1);
        await waitTicks(s, 2);
        const after = assets();
        const preserved = [...before].every(([id, n]) => (after.get(id) ?? 0) >= n);
        await s.bot.closeBank();
        const p = pos();
        const atBank = !!p && p.level === 0 && Math.max(Math.abs(p.worldX - home.x), Math.abs(p.worldZ - home.z)) <= 3;
        return {
            ok: (goal() || partial) && atBank && !hurt && preserved,
            partial,
            combat: combat(),
            strength: s.sdk.getSkill('Strength')?.baseLevel,
            defence: s.sdk.getSkill('Defence')?.baseLevel,
            unlockPlan,
            ticks: s.tick() - start,
            kills,
            hpMin,
            preserved,
            atBank,
            position: p && { x: p.worldX, z: p.worldZ, level: p.level },
        };
    } finally {
        off();
    }
}

export async function runChickenCli(account: string, env: Record<string, string | undefined> = process.env) {
    const bank = env.TRAIN_BANK ?? 'varrock';
    chickenTrainingProfile(bank);
    const target = chickenTrainingTarget(Number(env.TRAIN_COMBAT ?? 13));
    const entry = chickenTrainingEntry(env.TRAIN_ENTRY);
    const trainSkill = env.TRAIN_SKILL;
    const targetLevel = env.TARGET_LEVEL === undefined ? undefined : Number(env.TARGET_LEVEL);
    if (!chickenCombatUnlockMode(bank, trainSkill, targetLevel, entry, target)) chickenStrengthGoal(bank, trainSkill, targetLevel);
    const s = await openBot(account);
    try {
        const r = await trainChickens(s, Number(env.CAP ?? 1800), bank, target, { trainSkill, targetLevel, entry });
        console.log('TRAINING ' + JSON.stringify(r));
        await finish([s], r.ok, `${r.ok ? '' : 'no training progress: '}chicken-qualification ${JSON.stringify(r)}`);
        return r;
    } catch (e) {
        await finish([s], false, 'no training progress: ' + String(e));
        throw e;
    }
}
