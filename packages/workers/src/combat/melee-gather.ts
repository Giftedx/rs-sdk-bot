import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOARD_PLANK_IDS, DISEMBARK_PLANK_IDS, disembark, type BoatSession } from '../../../core/src/boat';
import { accountOf, countItems, finish, getWorld, openBot, sessionDied } from '../../../core/src/bot';
import { finishCombat, RETALIATE_OFF, RETALIATE_ON } from '../../../core/src/combat-end';
import { npcId, objId } from '../../../core/src/content-facts';
import { depositObserved, depositPack } from '../../../core/src/deposit';
import { PLAIN_FOOD } from '../../../core/src/eat-guard';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { defaultEatAt, startQuestSustain } from '../../../core/src/sustain';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath, type PathDeps, type PathPoint, type PathTile } from '../../../core/src/walk';
import { COW_BEAR_BOXES, guardCowWalker } from '../logistics/walk-helpers';
import {
    ELEMENTAL_STAFF_RUNES,
    gearLevelWatch,
    GIANT_AMMO_RUN,
    GIANT_ARROWS,
    reconcileCombatLoadout,
    selectedGiantRangedKit,
    type GearSkillLevels,
    type QuestInput,
} from './gear';
import {
    combatApproach,
    combatAlchPolicy,
    combatPotionPolicy,
    combatPotionRecovery,
    combatPotionSession,
    COW_FOOD_BITES,
    COW_FOOD_HP,
    cowFoodBites,
    cowFoodHeal,
    cowFoodPick,
    createCombatLoot,
    createCombatPotions,
    createEdgevilleTravel,
    combatFerryWalk,
    questFoodDefinitions,
    telegrabPolicy,
    combatWalkTargetPersist,
    type CombatPotionPolicy,
} from './survivability';
import { createCombatAdmissionGuard } from './admission';
import type { CombatSession } from './types';

const COW_BITE_HEAL: Readonly<Record<number, number>> = Object.fromEntries(
    Object.keys(COW_FOOD_BITES).map(id => [Number(id), questFoodDefinitions().get(Number(id))!.heal]),
);

export { COW_BEAR_BOXES, guardCowWalker };

const cowBearTile = (p: PathTile) =>
    COW_BEAR_BOXES.some(([x1, z1, x2, z2]) => Math.max(Math.max(x1 - p.x, 0, p.x - x2), Math.max(z1 - p.z, 0, p.z - z2)) <= 7);

export function cowProfile(bankProfile = 'south', foodMode = 'held', maximum = 5) {
    if (!['south', 'north'].includes(bankProfile) || !['held', 'banked'].includes(foodMode) || (foodMode === 'banked' && bankProfile !== 'north')) {
        throw Error('cow prerequisite: unsupported bank/food profile');
    }
    const limit = bankProfile === 'north' ? (foodMode === 'banked' ? 9 : 8) : 5;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > limit) {
        throw Error(bankProfile === 'south' ? 'cow needs positive CAP and MAX_KILLS1..5' : `cow prerequisite: north profile MAX_KILLS1..${limit}`);
    }
    return {
        north: bankProfile === 'north',
        foodBanked: foodMode === 'banked',
        limit,
        bank: { x: bankProfile === 'north' ? 2619 : 2654, z: bankProfile === 'north' ? 3332 : 3283 },
    };
}

export function cowRoutePoints(from: PathTile, x: number, z: number, tol: number, north = false): PathPoint[] {
    const final = { x, z, tol };
    if (north) {
        const corridor = [
            { x: 2635, z: 3360, tol: 0 },
            { x: 2647, z: 3391, tol: 0 },
            { x: 2676, z: 3350, tol: 0 },
        ];
        if (x === 2619 && z === 3332) {
            return Math.max(Math.abs(from.x - x), Math.abs(from.z - z)) <= 3 ? [final] : [...corridor].reverse().concat(final);
        }
        if (from.x >= 2654 && from.x <= 2676 && from.z >= 3338 && from.z <= 3357) return [final];
        return [...corridor, final];
    }
    const nw = { x: 2648, z: 3358, tol: 1 };
    const ne = { x: 2677, z: 3358, tol: 1 };
    const bank = z < 3300;
    if (bank) return from.z < 3300 || from.x <= 2653 ? [final] : [ne, nw, final];
    return from.x >= 2654 && from.x <= 2674 && from.z >= 3338 && from.z <= 3357 ? [final] : [nw, ne, final];
}

export function cowStopControl(target: string, stopFile: () => boolean, ownedRecovery = false) {
    let reason: string | undefined;
    const options =
        target === 'cow' || ownedRecovery
            ? {
                  onStop: async (_s: unknown, why: string) => {
                      if (reason === undefined) {
                          reason = why;
                          console.log(`${target === 'cow' ? 'COW' : 'COMBAT'}_STOP_OWNER ${why}`);
                      }
                  },
              }
            : {};
    return { options, stop: () => reason !== undefined || stopFile(), reason: () => reason };
}

// The session stop reasons that end a generic combat run without its owned bank return. After a death the potion
// session refuses every input of the new life. After a flee-guard stop the guard holds every walk ("random event in
// progress"). A bank walk in either case cannot arrive.
export function combatStopEnd(reason: string | undefined): 'died' | 'fled' | undefined {
    if (reason === 'died') return 'died';
    if (reason?.startsWith('fled')) return 'fled';
    return undefined;
}

// True from the first tick of a death of the account in a generic combat run. The loop ends there: the session stop
// for the death comes only after the death recovery, and until then the loop would walk the new life back to the spot.
// The potion session has its own life check (lifeEnded); without it the life fields of the first state are the baseline.
export function combatLifeWatch(s: Pick<CombatSession, 'sdk'>, scope?: { lifeEnded(): boolean }): () => boolean {
    // A copy: the state can keep one player object and change its fields.
    const p = s.sdk.getState()?.player;
    const born = p ? { lifeId: p.lifeId, respawnCount: p.respawnCount } : undefined;
    return () => {
        if (scope?.lifeEnded()) return true;
        const now = s.sdk.getState()?.player;
        return born ? sessionDied(born, now) : now?.isDead === true;
    };
}

// The words that a failed generic combat run adds for the openBot stall stop (`no progress: <n> ticks without ...`).
// The supervisor blocks a RESULT fail line with these words (packages/practice/src/supervise.ts isNoProgressFailure),
// so a stalled job does not log in again to stall the same way.
export function combatStallWords(reason: string | undefined): string {
    return reason?.startsWith('no progress') ? ` stalled=true ${reason}` : '';
}

// The walk to the bank of a generic combat run. When the tick cap stops it (`capped`), the loot stays in the pack and
// the run ends as capped. Any other failed walk is a fault. A travel that throws on its stop (createEdgevilleTravel)
// counts as capped too when the cap is the cause.
export async function combatBankWalk(walk: () => Promise<boolean>, capped: () => boolean): Promise<boolean> {
    const arrived = await walk().catch(error => {
        if (capped()) return false;
        throw error;
    });
    if (arrived) return true;
    if (capped()) return false;
    throw Error('combat bank return unavailable');
}

// The refusal of a generic combat run when a bank trip leaves at most one free slot. The bank trip deposits only the
// target's loot and the run's own outputs (bankCombatLoot). Items from an earlier job (a runecrafter's essence) stay,
// so without this end the run banks again each tick until the stall stop. The run keeps items that it does not own,
// as the prayer and cow jobs keep their kit, and names them for the planner. Undefined when a slot is free.
export function combatPackFull(inventory: readonly { name: string; count: number }[]): string | undefined {
    if (28 - inventory.length > 1) return undefined;
    const counts = new Map<string, number>();
    for (const i of inventory) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    const items = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`);
    return `no combat progress: pack full of non-loot items after a bank trip: ${items.join(', ')}`;
}

// The pack items that a generic combat run keeps on a BANK_PACK=1 bank trip: what the loop, its guards and its
// walker read. Food the loop and the eat guard eat (PLAIN_FOOD), coins for the walker's fares and tolls
// (door-policy.ts accountFromState), the Dusty key of the Taverley gate, the Anti-dragon shield before the loop wears
// it, the law and air runes of Telekinetic Grab, the nature and fire runes of high alchemy, and the air and fire
// staves that pay those runes (ELEMENTAL_STAFF_RUNES).
const COMBAT_KIT_IDS: ReadonlySet<number> = new Set([
    ...PLAIN_FOOD,
    995,
    1590, // TAVERLEY_ROUTE.DUSTY_KEY_ID
    1540, // TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID
    563,
    556,
    561,
    554,
    ...Object.entries(ELEMENTAL_STAFF_RUNES).filter(([, runes]) => runes.some(r => r === 556 || r === 554)).map(([id]) => Number(id)),
]);

export const combatKit = (item: { id: number }): boolean => COMBAT_KIT_IDS.has(item.id);

// The food of a generic combat run is PLAIN_FOOD, because the eat guard (eat-guard.ts) eats only those items. The guard
// eats in the fight at its eat level (sustain.ts defaultEatAt) and sends the attack again. The run sends no eat of its
// own: after one script eat the guard sends nothing more in that session. The run carries `food` pieces (default
// COMBAT_FOOD) from the bank. A Telekinetic Grab run stays out of melee range and carries no food.
export const COMBAT_FOOD = 5;

export function combatFoodWanted(conf: { requireTelegrab?: boolean; food?: number }): number {
    return conf.requireTelegrab ? 0 : (conf.food ?? COMBAT_FOOD);
}

export const combatFoodHeld = (inventory: readonly { id: number; count: number }[]): number =>
    inventory.reduce((n, i) => n + (PLAIN_FOOD.includes(i.id) ? i.count : 0), 0);

// PLAIN_FOOD ids, the highest heal first: the order in which a bank trip withdraws them.
let combatFoodOrder: number[] | undefined;
export function combatFoodByHeal(): readonly number[] {
    const defs = questFoodDefinitions();
    return (combatFoodOrder ??= [...PLAIN_FOOD].sort((a, b) => (defs.get(b)?.heal ?? 0) - (defs.get(a)?.heal ?? 0)));
}

// True when the account holds no food and its Hitpoints are at the eat level or below. The run then leaves the fight
// for the bank: one more fight can kill it.
export function combatOutOfFood(hp: number, maxHp: number, held: number): boolean {
    return held === 0 && hp > 0 && hp <= defaultEatAt(maxHp);
}

// The refusal when a bank trip leaves the pack with no food. The supervisor ends the job on `RESULT fail no food`
// (packages/practice/src/supervise.ts), so a restart does not walk the account back into the fight with no food.
export const combatNoFood = (target: string, want: number): string => `no food: ${target} needs ${want} pieces of PLAIN_FOOD and the bank and pack hold none`;

// The refusal at the start of a fight run, before any walk, bank trip or attack, when the account is at its eat level
// or below and holds no food. The `no food` words make the supervisor end the job, so a later planner pass does not
// send a low-Hitpoints account with no food back to the same fight. A run that carries no food (Telekinetic Grab) has
// no such refusal. An account at full Hitpoints (a 10-Hitpoints account, whose eat level is its maximum) goes on to the
// bank for food: waiting does not raise its Hitpoints.
export function combatEntryNoFood(target: string, hp: number, maxHp: number, held: number, want: number): string | undefined {
    if (want === 0 || hp >= maxHp || !combatOutOfFood(hp, maxHp, held)) return undefined;
    return `no food: ${target} start at ${hp}/${maxHp} Hitpoints (eat level ${defaultEatAt(maxHp)}) with no PLAIN_FOOD in the pack ticks=0`;
}

// The RESULT detail of a thrown error. A `no food` refusal keeps its words at the start of the detail.
export const combatFailDetail = (e: unknown): string => (e instanceof Error && e.message.startsWith('no food:') ? e.message : String(e));

// A run whose survival depends on Protect from Melee (prayer-guard.ts) enters the fight only with `enter` Prayer
// points, and leaves the fight for the bank below `leave` points. The worker cannot restore Prayer points, so the next
// walk to the spot refuses with a named no-progress failure: the supervisor blocks the job.
export type CombatPrayerFloor = { enter: number; leave: number };

export function combatPrayerShort(target: string, points: number, floor: CombatPrayerFloor | undefined, at: 'enter' | 'leave'): string | undefined {
    if (!floor) return undefined;
    const need = at === 'enter' ? floor.enter : floor.leave;
    return points < need ? `no combat progress: ${target} Prayer points ${points} below ${need} for Protect from Melee` : undefined;
}

// A bank trip withdraws PLAIN_FOOD, the highest heal first, until the pack holds `want` pieces. It keeps two slots free
// for loot. It returns the food that the pack then holds.
export async function withdrawCombatFood(s: CombatSession, want: number): Promise<number> {
    const held = () => combatFoodHeld(s.sdk.getInventory());
    // The SDK bank rows carry the slot. An observation row has no slot: the SDK then finds the row by its id.
    const rows = (): readonly { id: number; name: string; count: number; slot: number }[] => {
        const state: { id: number; name: string; count: number; slot: number }[] = s.sdk.getState()?.bank?.items ?? [];
        return state.length ? state : (s.bankObservation?.()?.items ?? []).map(i => ({ ...i, slot: -1 }));
    };
    for (const id of combatFoodByHeal()) {
        const before = held();
        const need = Math.min(want - before, 28 - s.sdk.getInventory().length - 2);
        if (need <= 0) break;
        const row = rows().find(i => i.id === id && i.count > 0);
        if (!row) continue;
        if (!(await s.bot.withdrawItem(row, Math.min(need, row.count), { asNote: false })).success) continue;
        await waitUntil(s, () => held() > before, { timeoutTicks: 6 });
    }
    return held();
}

export async function bankCombatLoot(s: CombatSession, drops: RegExp, extraIds: readonly number[] = []) {
    // openBank on an open interface answers "Bank already open" with no new observation
    // (vendor/rs-sdk/sdk/actions.ts _openBankOnce), so the generation never advances. Close a bank that an earlier
    // step left open, then open it again (the same step as trip-kit.ts open()).
    const open = () => !!s.sdk.getState()?.bank.isOpen || !!s.sdk.getState()?.interface?.isOpen;
    if (open()) {
        console.log('COMBAT_BANK stale-close');
        await s.sdk.sendCloseModal();
        if (!(await waitUntil(s, () => !open(), { timeoutTicks: 8 }))) throw Error('combat stale bank close unobserved');
    }
    const generation = s.bankObservation?.()?.generation ?? -1;
    if (
        !(await s.bot.openBank()).success
        || !(await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, {
            timeoutTicks: 12,
        }))
    ) {
        throw Error('combat fresh bank unavailable');
    }
    const matches = new RegExp(drops.source, drops.flags.replace(/[gy]/g, ''));
    const ids = new Set([...s.sdk.getInventory().filter(i => matches.test(i.name)).map(i => i.id), ...extraIds]);
    for (const id of ids) {
        const row = s.sdk.getInventory().find(i => i.id === id);
        if (row) await depositObserved(s as Session, row);
    }
    if (s.sdk.getInventory().some(i => matches.test(i.name) || extraIds.includes(i.id))) throw Error('combat outputs not banked');
}

export function untilItemPattern(name: string): RegExp {
    return new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

export function conf0Drops(target: string): RegExp {
    return CONFIGS[target]?.drops ?? /$^/;
}

// The NPC ids of a generic combat target.
export function genericCombatNpcIds(target: string): ReadonlySet<number> {
    const baseId=target==='giant'?GIANT.npc:target==='druid'?npcId('chaos druid'):target==='unicorn'?npcId('unicorn'):target==='wizard'?npcId('wizard'):undefined;
    return target === 'taverley_black_knight'
        ? new Set([178, 179])
        : new Set(
              [
                  baseId
                      ?? (target === 'taverley_druid'
                          ? npcId('chaos druid')
                          : target === 'taverley_giant'
                              ? GIANT.npc
                              : target === 'taverley_black_dragon'
                                  ? npcId('black dragon')
                                  : target === 'taverley_blue_dragon'
                                      ? npcId('blue dragon')
                                      : undefined),
              ].filter((id): id is number => id !== undefined),
          );
}

export function genericCombatNpc<T extends { id: number; distance: number; reachable?: boolean; inCombat?: boolean; targetIndex?: number }>(
    target: string,
    npcs: readonly T[],
    selfSlot?: number,
): T | undefined {
    const ids = genericCombatNpcIds(target);
    const owned = (n: T) =>
        selfSlot !== undefined && Number.isSafeInteger(selfSlot) && selfSlot >= 0 && n.inCombat === true && n.targetIndex === 32768 + selfSlot;
    return npcs
        .filter(n => ids.has(n.id) && n.reachable === true && (owned(n) || (n.inCombat === false && n.targetIndex === -1)) && Number.isFinite(n.distance) && n.distance >= 0 && n.distance <= 15)
        .sort((a, b) => Number(owned(b)) - Number(owned(a)) || a.distance - b.distance)[0];
}

export const cowCredit = (gone: boolean, selectedXp: number, newDrops: readonly number[]) =>
    gone && selectedXp > 0 && newDrops.length === 3 && newDrops.every(n => n >= 1);

export function cowGroundCounts(items: readonly { id: number; x: number; z: number; count: number }[]) {
    const counts = new Map<string, number>();
    for (const i of items) {
        const key = `${i.id}:${i.x}:${i.z}`;
        counts.set(key, (counts.get(key) ?? 0) + i.count);
    }
    return counts;
}

export function cowTraining(skill = 'Attack', targetLevel?: number) {
    const styles: Record<string, number> = { Attack: 0, Strength: 1, Defence: 3 };
    if (!Object.hasOwn(styles, skill)) throw Error('TRAIN_SKILL must be Attack, Strength or Defence');
    if (targetLevel !== undefined && (!Number.isSafeInteger(targetLevel) || targetLevel < 1 || targetLevel > 99)) {
        throw Error('TARGET_LEVEL must be1..99');
    }
    return { skill, style: styles[skill]!, targetLevel };
}

type StyleTab = { known: boolean; weaponName: string; currentStyle: number; styles: readonly { index: number; name?: string; trainsSkills: readonly string[] }[] };
function matchCombatStyle(tab: StyleTab | undefined, skill: string) {
    if (!tab?.known) return undefined;
    const only = tab.styles.filter(s => s.trainsSkills.length === 1 && s.trainsSkills[0] === skill);
    const style = skill === 'Hitpoints' ? (tab.styles.find(s => s.index === tab.currentStyle) ?? tab.styles[0]) : only.find(s => s.name && /rapid/i.test(s.name)) ?? only[0];
    if (!style) return undefined;
    return { index: style.index, name: style.name ?? skill, weapon: tab.weaponName };
}

export async function equipCowKit(
    s: CombatSession,
    stop: () => boolean = () => false,
    options: { kit?: readonly number[]; trainSkill?: string; levels?: GearSkillLevels; quests?: QuestInput } = {},
) {
    if (options.kit) {
        for (const id of options.kit) {
            const equipped = () => s.sdk.getEquipment().some(item => item.id === id);
            if (equipped()) continue;
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (!item) throw Error(`cow kit equip failed ${id}: no held item and not equipped`);
            const result = await s.bot.equipItem(item);
            if (!(await waitUntil(s, () => equipped() || stop(), { timeoutTicks: 10 })) || !equipped()) {
                throw Error(`cow kit equip failed ${id}: ${result.message ?? 'no SDK message'}; equipped item not observed`);
            }
        }
        return [...options.kit];
    }
    const r = await reconcileCombatLoadout(s, {
        style: 'melee',
        trainSkill: options.trainSkill ?? 'all-melee',
        levels: options.levels,
        quests: options.quests,
        stop,
        strict: true,
        label: 'cow kit',
    });
    if (!r.loadout.worn.weapon) throw Error('cow prerequisite: missing owned wearable melee weapon');
    return r.targets.map(t => t.id);
}

export const COW_RELEASE = 12;
export const COW_IDLE_RELEASE = 40;
export const cowReleased = (ticksTakenOver: number, ticksIdle = 0) => ticksTakenOver >= COW_RELEASE || ticksIdle >= COW_IDLE_RELEASE;

export async function runCows(
    s: CombatSession,
    o: {
        cap: number;
        maximum: number;
        trainSkill?: string;
        targetLevel?: number;
        bankProfile?: string;
        foodMode?: string;
        diagnostics?: boolean;
        noProgress?: number;
        potions?: CombatPotionPolicy;
        stop?: () => boolean;
        walk?: (x: number, z: number, tol: number) => Promise<boolean>;
    },
) {
    const potionScope = o.potions ? combatPotionSession(s, () => !!o.stop?.(), o.cap) : undefined;
    if (potionScope) s = potionScope;
    const profile = cowProfile(o.bankProfile, o.foodMode, o.maximum);
    if (!Number.isSafeInteger(o.cap) || o.cap < 1) throw Error('cow needs positive CAP and MAX_KILLS1..5');
    const training = cowTraining(o.trainSkill, o.targetLevel);
    const ids = [1739, 526, 2132];
    const inv = () => s.sdk.getInventory();
    const state = () => s.sdk.getState();
    const count = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => count(inv(), id);
    const bites = () => cowFoodBites(inv());
    const heal = () => cowFoodHeal(inv());
    const xp = () => s.sdk.getSkillXp('Attack') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const selectedXp = () => s.sdk.getSkillXp(training.skill) ?? 0;
    const level = () => s.sdk.getSkill(training.skill)?.baseLevel ?? 0;
    if (!(await waitUntil(s, () => hp() > 0 && (profile.foodBanked || heal() >= COW_FOOD_HP) && level() > 0, { timeoutTicks: 15 }))) {
        throw Error('cow prerequisite: stage2unnoted Trout (or 14HP of cake) and syncedHP/skill');
    }
    const start = s.tick();
    const initialXp = xp();
    const initialSelectedXp = selectedXp();
    const startLevel = level();
    const p0 = state()?.player;
    const goalReached = () => training.targetLevel !== undefined && level() >= training.targetLevel;
    if (!p0 || p0.level !== 0 || Math.max(Math.abs(p0.worldX - profile.bank.x), Math.abs(p0.worldZ - profile.bank.z)) > (profile.north ? 3 : 10)) {
        throw Error(profile.north ? 'cow prerequisite: stage at Ardougne north bank' : 'cow prerequisite: stage at Ardougne south bank');
    }
    if (profile.foodBanked && (hp() < 60 || (s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) < 60 || (s.sdk.getSkill('Defence')?.level ?? 0) < 70)) {
        throw Error('cow prerequisite: banked-food profile requires HPbase/current60 and Defence70');
    }
    if (ids.some(id => held(id) > 0)) throw Error('cow prerequisite: empty carried cow outputs');
    const allKit = () => [...inv(), ...(state()?.equipment ?? [])];
    const kit = new Map<number, number>();
    for (const i of allKit()) if (!ids.includes(i.id) && !COW_FOOD_BITES[i.id]) kit.set(i.id, (kit.get(i.id) ?? 0) + i.count);
    let lastKnownBank: { id: number; count: number }[] = [];
    let lastBankKnown = false;
    const gearWatch = gearLevelWatch(s, 'melee');
    let ended = false;
    let died = false;
    let healthCutoff = false;
    let retreating = false;
    let hpMin = hp();
    let creditedKills = 0;
    let damageXp = 0;
    let eaten = 0;
    let bankTrips = 0;
    let failure = '';
    let stop = 'cap';
    let lastProgress = start;
    let crowded = false;
    const diagnostics: Record<string, unknown>[] = [];
    let diagnosticKey = '';
    let diagnosticTick = -Infinity;
    let activeIndex: number | undefined;
    let attackStarted: number | undefined;
    const capture = (phase: string, x?: number, z?: number, gone = false) => {
        const st = state();
        const n = st?.nearbyNpcs.find(row => row.index === activeIndex);
        const evidence = {
            phase,
            index: activeIndex,
            gone,
            anchor: x === undefined ? null : [x, z],
            selectedXp: selectedXp() - initialSelectedXp,
            npc: n ? { id: n.id, x: n.x, z: n.z, tileX: n.tileX, tileZ: n.tileZ, hp: n.hp, maxHp: n.maxHp, anim: n.animId, inCombat: n.inCombat, target: n.targetIndex } : null,
            player: st?.player ? { x: st.player.worldX, z: st.player.worldZ, hp: hp(), life: st.player.lifeId, combat: st.player.combat } : null,
            others: (st?.nearbyPlayers ?? []).slice(0, 8).map(p => ({ index: p.index, x: p.x, z: p.z, inCombat: p.inCombat, targetType: p.combatTargetType, target: p.combatTargetIndex })),
            ground: (st?.groundItems ?? []).filter(i => ids.includes(i.id)).slice(0, 24).map(i => ({ id: i.id, count: i.count, x: i.x, z: i.z })),
        };
        const key = JSON.stringify(evidence);
        if (key === diagnosticKey && s.tick() - diagnosticTick < 20) return;
        diagnosticKey = key;
        diagnosticTick = s.tick();
        if (diagnostics.length >= 16) diagnostics.splice(2, 1);
        diagnostics.push({
            tick: s.tick(),
            elapsed: s.tick() - start,
            sinceProgress: s.tick() - lastProgress,
            sinceAttack: attackStarted === undefined ? null : s.tick() - attackStarted,
            ...evidence,
        });
    };
    void s.ended.then(() => {
        ended = true;
    });
    let walkTicks = 0;
    let walkedTiles = 0;
    let doorInteractions = 0;
    let houseInteractions = 0;
    let maxPackSlots = inv().length;
    let detourTiles = 0;
    let prevX = p0.worldX;
    let prevZ = p0.worldZ;
    const observeLife = () => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, hp());
        if (profile.foodBanked && p && hp() <= 40) healthCutoff = true;
        if (sessionDied(p0, p)) died = true;
        return p;
    };
    const off = s.onTick(() => {
        const p = observeLife();
        const curInv = inv();
        if (curInv.length > maxPackSlots) maxPackSlots = curInv.length;
        if (p) {
            const distance = Math.max(Math.abs(p.worldX - prevX), Math.abs(p.worldZ - prevZ));
            if (distance) {
                walkTicks++;
                walkedTiles += distance;
                prevX = p.worldX;
                prevZ = p.worldZ;
            }
        }
    });
    const offMetrics = () => {};
    const bankDistances: number[] = [];
    const walkLegs: Record<string, unknown>[] = [];
    const over = () => {
        observeLife();
        return ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
    };
    const potions = o.potions ? createCombatPotions(s, o.potions, [training.skill, 'Hitpoints'], over) : undefined;
    const eat = async () => {
        const food = cowFoodPick(inv());
        if (!food) {
            stop = 'low-hp';
            throw Error('no cow progress: low HP retreat, no working food');
        }
        const before = bites();
        const beforeHp = hp();
        await s.bot.eatFood(food);
        const healed = await waitUntil(s, () => (bites() < before && hp() > beforeHp) || over(), { timeoutTicks: 6 });
        eaten += Math.max(0, before - bites());
        if (!healed || bites() >= before || hp() <= 6 || over()) {
            stop = 'low-hp';
            throw Error('no cow progress: food did not heal before retreat');
        }
    };
    const walk =
        o.walk
        ?? (async (x, z, tol) => {
            const p = state()?.player;
            if (!p) return false;
            const threat = () => {
                observeLife();
                if (ended || died) return 'cow route session ended/dead';
                if (healthCutoff && !retreating) return 'cow route banked-food HP40 cutoff';
                if (!retreating && o.stop?.()) return 'cow route stop requested';
                if (hp() <= 6) return 'cow route low HP';
                const current = state()?.player;
                if (current && (current.level !== 0 || cowBearTile({ x: current.worldX, z: current.worldZ }))) {
                    return 'cow route entered bear bounds or unexpected floor';
                }
                if (
                    current
                    && (state()?.nearbyNpcs ?? []).some(
                        n => /bear/i.test(n.name) && Math.max(Math.abs((n.tileX ?? n.x) - current.worldX), Math.abs((n.tileZ ?? n.z) - current.worldZ)) <= 6,
                    )
                ) {
                    return 'cow route observed bear within6';
                }
                return null;
            };
            const base = await sessionWalker(s as Session);
            const beforeTiles = walkedTiles;
            const beforeTicks = walkTicks;
            const beforeDoors = doorInteractions;
            const measured = {
                ...base,
                interactLoc: (loc: any, op: number) => {
                    if (op === 1) {
                        doorInteractions++;
                        if (
                            [
                                [2640, 3362],
                                [2643, 3360],
                                [2632, 3381],
                            ].some(([hx, hz]) => loc.x === hx && loc.z === hz)
                        ) {
                            houseInteractions++;
                        }
                    }
                    return base.interactLoc(loc, op);
                },
            };
            const guarded = guardCowWalker(measured, threat);
            const points = cowRoutePoints({ x: p.worldX, z: p.worldZ }, x, z, tol, profile.north);
            const r = await walkPath(guarded.deps, points, { look: 6, stop: () => !!guarded.reason() });
            const end = state()?.player;
            const straight = end ? Math.max(Math.abs(end.worldX - p.worldX), Math.abs(end.worldZ - p.worldZ)) : 0;
            const observed = walkedTiles - beforeTiles;
            detourTiles += Math.max(0, observed - straight);
            if (walkLegs.length < 20) {
                walkLegs.push({
                    from: [p.worldX, p.worldZ],
                    to: [x, z],
                    points,
                    observedTiles: observed,
                    walkTicks: walkTicks - beforeTicks,
                    doorInteractions: doorInteractions - beforeDoors,
                    ok: r.ok,
                });
            }
            const reason = guarded.reason();
            if (reason) {
                const current = state()?.player;
                if (current && !died && !ended) await s.direct({ type: 'walkTo', x: current.worldX, z: current.worldZ, running: false, reason: 'cow route halt' });
                if (hp() <= 6 && !died && !ended) await eat();
                throw Error(`no cow progress: ${reason}; movement halted`);
            }
            return r.ok;
        });
    const syncBankObs = () => {
        const obs = s.bankObservation?.()?.items;
        if (obs) {
            lastKnownBank = obs.map(i => ({ id: i.id, count: i.count }));
            lastBankKnown = true;
        }
    };
    const open = async () => {
        if (!(state()?.bank?.isOpen && s.bankObservation?.())) {
            const gen = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 20 }))) {
                throw Error('no cow progress: bank readiness unknown');
            }
            bankTrips++;
        }
        syncBankObs();
    };
    const bankCount = (id: number) => count(s.bankObservation?.()?.items ?? [], id);
    const baseline: Record<number, number> = {};
    const assetTotals = () => {
        const m = new Map<number, number>();
        for (const i of [...(s.bankObservation?.()?.items ?? []), ...allKit()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    let initialAssets: Map<number, number> | undefined;
    let initialFood: number | undefined;
    const ownedFood = () => (s.bankObservation?.() ? bites() + cowFoodBites(s.bankObservation?.()?.items ?? []) : undefined);
    const cowGear = (bankOpen: boolean) =>
        reconcileCombatLoadout(s, {
            style: 'melee',
            trainSkill: training.skill,
            bankOpen,
            stop: over,
            strict: true,
            label: 'cow kit',
            openBank: () => open(),
            closeBank: () => s.bot.closeBank(),
            ...(!bankOpen && lastBankKnown ? { bankItems: lastKnownBank } : {}),
        });
    const selectCowStyle = async () => {
        const wornName = () => state()?.equipment?.find(i => i.slot === 3)?.name;
        const ready = await waitUntil(
            s,
            () => {
                const c = state()?.combatStyle;
                const name = wornName();
                return !!c?.known && (!name || c.weaponName === name);
            },
            { timeoutTicks: 10 },
        );
        const tab = state()?.combatStyle;
        const matched = ready ? matchCombatStyle(tab, training.skill) : undefined;
        if (!matched) {
            throw Error(tab?.known ? `no cow progress: selected combat style unobserved (${tab.weaponName || 'weapon'} lacks ${training.skill})` : 'no cow progress: selected combat style unobserved');
        }
        if (
            !(await s.sdk.sendSetCombatStyle(matched.index)).success
            || !(await waitUntil(
                s,
                () => {
                    const c = state()?.combatStyle;
                    const name = wornName();
                    return (
                        !!c?.known
                        && c.currentStyle === matched.index
                        && (!name || c.weaponName === name)
                        && c.styles.some(st => st.index === matched.index && st.trainsSkills.length === 1 && st.trainsSkills[0] === training.skill)
                    );
                },
                { timeoutTicks: 10 },
            ))
        ) {
            throw Error('no cow progress: selected combat style unobserved');
        }
    };
    const prepareCowKitFromOpenBank = async () => {
        const r = await cowGear(true);
        if (over()) return;
        if (!r.loadout.worn.weapon) throw Error('cow prerequisite: missing owned wearable melee weapon');
        if (profile.foodBanked) {
            const food = inv().find(i => i.id === 333);
            if (food) {
                await open();
                const before = bankCount(333);
                const amount = held(333);
                if (!(await s.bot.depositItem(food, -1)).success || !(await waitUntil(s, () => held(333) === 0 && bankCount(333) === before + amount, { timeoutTicks: 10 }))) {
                    throw Error('no cow progress: working food secure bank failed');
                }
                await s.bot.closeBank();
            }
        }
    };
    const bank = async (reEquip = false) => {
        retreating = true;
        const p = state()?.player;
        if (p) bankDistances.push(Math.max(Math.abs(p.worldX - profile.bank.x), Math.abs(p.worldZ - profile.bank.z)));
        if (!(await walk(profile.bank.x, profile.bank.z, profile.north ? 1 : 2))) throw Error('no cow progress: bank retreat failed');
        await open();
        for (const id of [...ids, ...(potions?.depositIds ?? [])]) {
            const item = inv().find(i => i.id === id);
            if (item) {
                const before = bankCount(id);
                const amount = held(id);
                if (!(await s.bot.depositItem(item, -1)).success || held(id) > 0 || !(await waitUntil(s, () => bankCount(id) === before + amount, { timeoutTicks: 20 }))) {
                    throw Error('no cow progress: deposit failed');
                }
            }
        }
        if (!profile.foodBanked) {
            for (let tries = 0; heal() < COW_FOOD_HP && tries < 6; tries++) {
                const items = state()?.bank.items ?? [];
                const trout = items.find(i => i.id === 333);
                const item = trout ?? cowFoodPick(items);
                const want = heal() + (trout ? COW_BITE_HEAL[333]! : 0);
                if (!item || !(await s.bot.withdrawItem(item, trout ? Math.min(trout.count, Math.ceil((COW_FOOD_HP - heal()) / COW_BITE_HEAL[333]!)) : 1, { asNote: false })).success) {
                    break;
                }
                await waitUntil(s, () => heal() >= Math.min(COW_FOOD_HP, want), { timeoutTicks: 5 });
            }
        }
        if (!profile.foodBanked && heal() < COW_FOOD_HP) throw Error('no cow progress: working food restock failed');
        syncBankObs();
        if (reEquip && !goalReached() && creditedKills < o.maximum && !over()) {
            await prepareCowKitFromOpenBank();
            if (!over()) await selectCowStyle();
        }
    };
    try {
        await open();
        for (const id of ids) baseline[id] = bankCount(id);
        initialAssets = assetTotals();
        initialFood = ownedFood();
        if (!goalReached() && !over()) {
            await prepareCowKitFromOpenBank();
            if (profile.foodBanked && inv().some(i => !potions?.depositIds.includes(i.id))) {
                throw Error('cow prerequisite: banked-food fullpack requires empty inventory after worn kit prep');
            }
            if (!over()) {
                await selectCowStyle();
                if (!(await walk(2664, 3344, 4))) throw Error('no cow progress: pen route failed');
            }
        } else {
            await s.bot.closeBank();
        }
        lastProgress = s.tick();
        while (creditedKills < o.maximum && !goalReached() && !over()) {
            if (healthCutoff) throw Error('no cow progress: banked-food HP40 cutoff; retreat');
            if (profile.north && 28 - inv().length < 3) throw Error('no cow progress: insufficient slots for three cow drops');
            if (hp() <= 6) await eat();
            if (potions) await potions.poll();
            const players = state()?.nearbyPlayers ?? [];
            const pen = (state()?.nearbyNpcs ?? []).filter(n => n.id === 81 && n.x >= 2655 && n.x <= 2676 && n.z >= 3338 && n.z <= 3357);
            const beside = (n: { x: number; z: number }) => players.some(p => Math.max(Math.abs(p.x - n.x), Math.abs(p.z - n.z)) <= 2);
            const target = pen
                .filter(n => !n.inCombat && (n.hp == null || n.maxHp == null || n.hp >= n.maxHp) && !beside(n))
                .sort((a, b) => a.distance - b.distance)[0];
            if (s.tick() - lastProgress >= (o.noProgress ?? 200)) {
                if (creditedKills > 0) {
                    crowded = true;
                    break;
                }
                throw Error(
                    `no cow progress: target/loot timeout cows=${pen.length} inCombat=${pen.filter(n => n.inCombat).length} besidePlayer=${pen.filter(n => !n.inCombat && beside(n)).length} players=${players.length}`,
                );
            }
            if (!target) {
                await waitTicks(s, 1);
                continue;
            }
            const beforeXp = selectedXp();
            const groundBefore = cowGroundCounts(state()?.groundItems ?? []);
            let x = target.tileX ?? target.x;
            let z = target.tileZ ?? target.z;
            if (target.distance > 2 && !(await walk(x, z, 2))) throw Error('no cow progress: guarded cow approach failed');
            const attackTarget = state()?.nearbyNpcs.find(n => n.index === target.index && n.id === 81);
            if (!attackTarget || attackTarget.distance > 2 || attackTarget.inCombat) {
                await waitTicks(s, 1);
                continue;
            }
            activeIndex = target.index;
            attackStarted = s.tick();
            capture('before-attack', x, z);
            if (!(await s.bot.attack(attackTarget)).success) {
                await waitTicks(s, 1);
                continue;
            }
            let observedXp = beforeXp;
            lastProgress = s.tick();
            let gone = false;
            let goneAt = 0;
            let released = false;
            let lastEngaged = s.tick();
            let lastActive = s.tick();
            while (!over()) {
                if (healthCutoff) throw Error('no cow progress: banked-food HP40 cutoff; retreat');
                if (hp() <= 6) await eat();
                if (potions && state()?.player?.combat.targetType === 'npc' && state()?.player?.combat.targetIndex === target.index) await potions.poll(target);
                const current = gone ? undefined : state()?.nearbyNpcs.find(n => n.index === target.index);
                if (current) {
                    x = current.tileX ?? current.x;
                    z = current.tileZ ?? current.z;
                } else if (!gone) {
                    gone = true;
                    goneAt = s.tick();
                }
                if (selectedXp() > observedXp) {
                    observedXp = selectedXp();
                    lastProgress = s.tick();
                    lastActive = s.tick();
                }
                const combat = state()?.player?.combat;
                const ours = combat?.targetType === 'npc' && combat.targetIndex === target.index;
                if (!current?.inCombat || ours) lastEngaged = s.tick();
                if (ours) lastActive = s.tick();
                capture('await-credit', x, z, gone);
                const drops = ids.map(id => count((state()?.groundItems ?? []).filter(i => i.x === x && i.z === z), id) - (groundBefore.get(`${id}:${x}:${z}`) ?? 0));
                if (cowCredit(gone, selectedXp() - beforeXp, drops)) break;
                if (!gone && cowReleased(s.tick() - lastEngaged, s.tick() - lastActive)) {
                    released = true;
                    break;
                }
                if (gone && (selectedXp() === beforeXp || s.tick() - goneAt >= 10)) {
                    released = true;
                    break;
                }
                if (s.tick() - lastProgress >= (o.noProgress ?? 200)) throw Error('no cow progress: target/loot timeout');
                await waitTicks(s, 1);
            }
            if (over()) break;
            if (released) {
                capture('released', x, z);
                continue;
            }
            for (const id of ids) {
                const item = state()?.groundItems.find(i => i.id === id && i.x === x && i.z === z);
                const before = held(id);
                if (!item || !(await s.bot.pickupItem(item)).success || held(id) !== before + 1) throw Error('no cow progress: credited loot pickup mismatch');
            }
            creditedKills++;
            damageXp += selectedXp() - beforeXp;
            lastProgress = s.tick();
            console.log(
                `MILESTONE cow credited=${creditedKills} trainSkill=${training.skill} selectedXp=${selectedXp() - initialSelectedXp} level=${level()} attackXp=${xp() - initialXp} HP=${hp()} heldHide=${held(1739)}`,
            );
            if (gearWatch.crossed() && creditedKills < o.maximum && !goalReached() && !over()) {
                const r = await cowGear(false);
                if (!over() && r.weaponChanged) await selectCowStyle();
                if (r.bankBetter && !over() && !healthCutoff) {
                    await bank(true);
                    retreating = false;
                    if (!over() && !(await walk(2664, 3344, 4))) throw Error('no cow progress: pen route failed');
                    lastProgress = s.tick();
                }
            }
        }
        stop = goalReached() ? 'target-level' : creditedKills === o.maximum ? 'max-kills' : died ? 'died' : o.stop?.() ? 'stop-file' : crowded ? 'crowded' : 'cap';
    } catch (e) {
        failure = String(e);
        if (stop === 'cap' && o.stop?.()) stop = 'stop-file';
        capture('failure');
        console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    } finally {
        if (!died && !ended) {
            try {
                if (potionScope) await potionScope.withCombatPotionCleanup(() => bank(false));
                else await bank(false);
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
        offMetrics();
    }
    const banked = {
        hide: bankCount(1739) - (baseline[1739] ?? bankCount(1739)),
        bones: bankCount(526) - (baseline[526] ?? bankCount(526)),
        beef: bankCount(2132) - (baseline[2132] ?? bankCount(2132)),
    };
    const finalAssets = profile.foodBanked || potions || (initialAssets && s.bankObservation?.()) ? assetTotals() : undefined;
    const preserved = potions
        ? !!initialAssets
          && !!finalAssets
          && [...new Set([...initialAssets.keys(), ...finalAssets.keys()])].every(
              id => ids.includes(id) || (finalAssets.get(id) ?? 0) === (initialAssets!.get(id) ?? 0) + (potions.delta[id] ?? 0) - (id === 333 ? eaten : 0),
          )
        : profile.foodBanked
            ? !!initialAssets
              && !!finalAssets
              && [...new Set([...initialAssets.keys(), ...finalAssets.keys()])].every(
                  id => ids.includes(id) || (finalAssets.get(id) ?? 0) === (initialAssets!.get(id) ?? 0),
              )
            : (initialAssets && finalAssets
                  ? [...new Set([...initialAssets.keys(), ...finalAssets.keys()])].every(
                        id => ids.includes(id) || COW_FOOD_BITES[id] !== undefined || (finalAssets.get(id) ?? 0) === (initialAssets!.get(id) ?? 0),
                    )
                  : [...kit].every(([id, n]) => count(allKit(), id) === n)) && heal() >= COW_FOOD_HP;
    const finalFood = ownedFood();
    const foodAccounted = initialFood !== undefined && finalFood === initialFood - eaten;
    const targetMet = (training.targetLevel !== undefined ? goalReached() : creditedKills === o.maximum) && Object.values(banked).every(n => n === creditedKills);
    const partial =
        ((training.targetLevel !== undefined && ['max-kills', 'cap'].includes(stop)) || stop === 'crowded')
        && !targetMet
        && creditedKills > 0
        && Object.values(banked).every(n => n === creditedKills)
        && !failure
        && !died
        && !ended
        && preserved
        && foodAccounted;
    if (o.diagnostics && !failure) console.log(`COW_DIAGNOSTIC ${JSON.stringify(diagnostics)}`);
    return {
        ...(potions ? { potions: { doses: potions.doses, delta: potions.delta, receipts: potions.receipts, blocked: potions.blocked, resumes: potions.resumes } } : {}),
        ok: !failure && !died && !ended && (targetMet || partial) && preserved && foodAccounted,
        creditedKills,
        banked,
        trainSkill: training.skill,
        targetLevel: training.targetLevel ?? null,
        startLevel,
        finalLevel: level(),
        selectedXp: selectedXp() - initialSelectedXp,
        attackXp: xp() - initialXp,
        damageXp,
        eaten,
        initialFood: initialFood ?? null,
        finalFood: finalFood ?? null,
        foodAccounted,
        bankTrips,
        hpMin,
        died,
        lifeId: state()?.player?.lifeId,
        respawns: state()?.player?.respawnCount,
        ticks: s.tick() - start,
        preserved,
        targetMet,
        partial,
        stop,
        failure: failure || (!targetMet && !partial ? 'no cow progress: bounded target unmet' : '-'),
        diagnostics: failure || o.diagnostics ? diagnostics : [],
        bankProfile: profile.north ? 'north' : 'south',
        foodMode: profile.foodBanked ? 'banked' : 'held',
        healthCutoff,
        walkTicks,
        walkedTiles,
        detourTiles,
        doorInteractions,
        houseInteractions,
        maxPackSlots,
        bankDistances,
        walkLegs,
    };
}

export const GIANT = {
    npc: npcId('giant'),
    food: objId('shark'),
    bigBones: objId('big bones'),
    limpwurt: objId('limpwurt root'),
    bank: { x: 2655, z: 3283 },
    spot: { x: 2545, z: 3144 },
    room: [2537, 3136, 2556, 3155],
} as const;
export const GIANT_HERBS: readonly number[] = ['guam', 'marentill', 'tarromin', 'harralander', 'ranarr', 'irit', 'avantoe', 'kwuarm', 'cadantine', 'dwarf weed', 'torstol'].map(
    herb => objId(`unidentified ${herb}`),
);
const GIANT_DROPS: readonly number[] = [GIANT.bigBones, GIANT.limpwurt, ...GIANT_HERBS];

export type CombatSite = {
    label: string;
    npcs: readonly number[];
    foods: readonly number[];
    bank: { x: number; z: number };
    spot: { x: number; z: number };
    room: readonly number[];
    drops: readonly number[];
    creditDrop?: number;
};
export const GIANT_SITE: CombatSite = { label: 'giant', npcs: [GIANT.npc], foods: [GIANT.food], bank: GIANT.bank, spot: GIANT.spot, room: GIANT.room, drops: GIANT_DROPS, creditDrop: GIANT.bigBones };
export const TROOPER_FOODS: readonly number[] = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'cake slice', 'partial cake', 'cake'].map(objId);
export const TROOPER_SITE: CombatSite = {
    label: 'trooper',
    npcs: [npcId('khazard troop'), npcId('khazard troop spearmen')],
    foods: TROOPER_FOODS,
    bank: { x: 2619, z: 3332 },
    spot: { x: 2525, z: 3242 },
    room: [2493, 3223, 2553, 3264],
    drops: [],
};

export const EAT_DELAY = 2;
export const AMMO_REACH = 3;
export const AMMO_PICKS = 2;
export const AMMO_WORTH = 3;
export const AMMO_LOW = 50;

export function ammoPiles<T extends { id: number; x: number; z: number; count: number }>(
    ground: readonly T[],
    id: number,
    at: { x: number; z: number },
    least = 1,
    missed: ReadonlySet<string> = new Set(),
): T[] {
    const far = (i: { x: number; z: number }) => Math.max(Math.abs(i.x - at.x), Math.abs(i.z - at.z));
    return ground
        .filter(i => i.id === id && i.count >= least && far(i) <= AMMO_REACH && !missed.has(`${i.x},${i.z}`))
        .sort((a, b) => b.count - a.count || far(a) - far(b));
}

const inBox = (b: readonly number[], x: number, z: number) => x >= b[0]! && x <= b[2]! && z >= b[1]! && z <= b[3]!;

export function giantTraining(skill?: string, targetLevel?: number) {
    if (!skill || !['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged'].includes(skill)) {
        throw Error('giant TRAIN_SKILL must be Attack, Strength, Defence, Hitpoints or Ranged');
    }
    if (targetLevel === undefined || !Number.isSafeInteger(targetLevel) || targetLevel < 2 || targetLevel > 99) {
        throw Error('giant TARGET_LEVEL must be2..99');
    }
    return { skill, targetLevel };
}

export function giantStyle(tab: StyleTab | undefined, skill: string) {
    if (!tab?.known) throw Error('giant prerequisite: wielded weapon combat styles unknown');
    const style = matchCombatStyle(tab, skill);
    if (!style) throw Error(`giant prerequisite: ${tab.weaponName} has no style that trains only ${skill}`);
    return style;
}

export const giantCredit = (gone: boolean, selectedXp: number, newBigBones: number) => gone && selectedXp > 0 && newBigBones >= 1;

export function giantKillLimit(value?: string | number) {
    if (value === undefined) return undefined;
    const maximum = Number(value);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw Error('giant GIANT_KILLS must be a positive safe integer');
    return maximum;
}

const COINS = 995;
const BONES = 526;

export function roamTarget<T extends { index: number; distance: number }>(account: string, free: readonly T[], company: boolean): T | undefined {
    if (!company) return free[0];
    const offset = (index: number) => {
        let h = 2166136261;
        for (const c of `${account}:${index}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
        return (h >>> 0) % 8;
    };
    return [...free].sort((a, b) => a.distance + offset(a.index) - (b.distance + offset(b.index)))[0];
}

export const retreatBudget = (distance: number) => (Number.isFinite(distance) ? Math.max(0, distance) * 3 + 120 : 600);
export const TRAIL_STEP = 12;
const cheb = (a: PathTile, b: PathTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function retreatWaypoints(trail: readonly PathTile[], at: PathTile, bank: PathTile): PathPoint[] {
    const back = [...trail].reverse().filter(p => cheb(p, bank) > 3);
    if (!back.length) return [];
    let i = 0;
    for (let k = 1; k < back.length; k++) if (cheb(back[k]!, at) < cheb(back[i]!, at)) i = k;
    if (cheb(back[i]!, at) <= 3) i++;
    return back.slice(i).map(p => ({ x: p.x, z: p.z, tol: 2 }));
}

export const anothersFight = (npc: { inCombat?: boolean; targetIndex?: number } | undefined, selfSlot: number | undefined) =>
    !!npc?.inCombat && selfSlot !== undefined && (npc.targetIndex ?? -1) >= 32768 && npc.targetIndex !== 32768 + selfSlot;

export function needsLongSurfaceWalk(from: { x: number; z: number; level: number }, to: { x: number; z: number }, maxLocal = 40): boolean {
    return from.level === 0 && from.z < 6400 && to.z < 6400 && Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z)) > maxLocal;
}

export type CombatWaitState =
    | {
          player?: { combat?: { inCombat?: boolean; targetType?: string; targetIndex?: number } } | null;
          nearbyNpcs?: readonly { index: number; distance?: number; inCombat?: boolean; targetIndex?: number }[];
      }
    | null
    | undefined;

export function combatTargetFinished(
    state: CombatWaitState,
    monsterIndex: number,
    selfSlot: number | undefined,
    idleTicks: number,
    idleLimit = 4,
): { done: boolean; dead: boolean } {
    const npc = state?.nearbyNpcs?.find(n => n.index === monsterIndex);
    if (!npc) return { done: true, dead: true };
    if (anothersFight(npc, selfSlot)) return { done: true, dead: false };
    if (!state?.player?.combat?.inCombat && !npc.inCombat && idleTicks >= idleLimit) return { done: true, dead: false };
    return { done: false, dead: false };
}

export async function runGiants(
    s: CombatSession,
    o: {
        cap: number;
        trainSkill?: string;
        targetLevel?: number;
        maximum?: number;
        food?: number;
        ammo?: number;
        ammoPickup?: boolean;
        rangedKit?: { bow: number; arrow: number };
        bury?: boolean;
        eatAt?: number;
        noProgress?: number;
        stop?: () => boolean;
        walk?: (x: number, z: number, tol: number, signal?: AbortSignal) => Promise<boolean>;
        site?: CombatSite;
    },
) {
    const site = o.site ?? GIANT_SITE;
    const label = site.label;
    const maximum = giantKillLimit(o.maximum);
    const training = giantTraining(o.trainSkill, o.targetLevel);
    if (!Number.isSafeInteger(o.cap) || o.cap < 1) throw Error('giant needs positive CAP');
    const carry = o.food ?? 5;
    if (!Number.isSafeInteger(carry) || carry < 1 || carry > 20) throw Error('giant GIANT_FOOD must be1..20');
    const ranged = training.skill === 'Ranged';
    const ammoCarry = o.ammo ?? 500;
    const roam = site.creditDrop === undefined;
    const bury = roam && !!o.bury && (s.sdk.getSkill('Prayer')?.baseLevel ?? 1) < 99;
    const prayerXp = () => s.sdk.getSkillXp('Prayer') ?? 0;
    const prayerStart = prayerXp();
    let buried = 0;
    if (ranged && (!Number.isSafeInteger(ammoCarry) || ammoCarry < 1 || ammoCarry > 100000)) throw Error('giant GIANT_AMMO must be1..100000');
    const inv = () => s.sdk.getInventory();
    const state = () => s.sdk.getState();
    const count = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => count(inv(), id);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const bitesOf = (id: number) => COW_FOOD_BITES[id] ?? 1;
    const heldFood = () => site.foods.reduce((n, id) => n + held(id) * bitesOf(id), 0);
    const heldPieces = () => site.foods.reduce((n, id) => n + held(id), 0);
    const selectedXp = () => s.sdk.getSkillXp(training.skill) ?? 0;
    const level = () => s.sdk.getSkill(training.skill)?.baseLevel ?? 0;
    if (!(await waitUntil(s, () => hp() > 0 && level() > 0 && !!state()?.player && !!state()?.combatStyle?.known, { timeoutTicks: 15 }))) {
        throw Error('giant prerequisite: synced HP, skill and combat styles');
    }
    const eatAt = o.eatAt ?? Math.max(10, Math.ceil((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) / 2));
    const start = s.tick();
    const p0 = state()!.player!;
    const initialSelectedXp = selectedXp();
    const startLevel = level();
    const goalReached = () => (maximum === undefined ? level() >= training.targetLevel : creditedKills >= maximum);
    const near = (x: number, z: number, tol: number) => {
        const p = state()?.player;
        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    let style: ReturnType<typeof giantStyle> | undefined;
    const allKit = () => [...inv(), ...(state()?.equipment ?? [])];
    let ammoId: number | undefined;
    let ammoSlot = 13;
    let ammoBank = 0;
    const ammoIds = new Set<number>();
    const quiver = () => count((state()?.equipment ?? []).filter(i => i.slot === ammoSlot), ammoId ?? -1);
    let ended = false;
    let died = false;
    let hpMin = hp();
    let creditedKills = 0;
    let limpwurt = 0;
    let eaten = 0;
    let bankTrips = 0;
    let failure = '';
    let stop = 'cap';
    let lastProgress = start;
    let bankFood = 0;
    void s.ended.then(() => {
        ended = true;
    });
    const observeLife = () => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(p0, p)) died = true;
    };
    const off = s.onTick(observeLife);
    const over = () => {
        observeLife();
        return ended || died || !!o.stop?.() || s.tick() - start >= o.cap;
    };
    let lastEat = -Infinity;
    const eatGap = async () => {
        const wait = EAT_DELAY + 1 - (s.tick() - lastEat);
        if (wait > 0) await waitTicks(s, wait);
    };
    const eat = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const food = site.foods.map(id => inv().find(i => i.id === id)).find(i => !!i);
            if (!food) return false;
            await eatGap();
            const before = heldFood();
            const beforeHp = hp();
            await s.bot.eatFood(food);
            await waitUntil(s, () => heldFood() < before || over(), { timeoutTicks: 6 });
            eaten += Math.max(0, before - heldFood());
            if (heldFood() < before) {
                lastEat = s.tick();
                await waitUntil(s, () => hp() > beforeHp || over(), { timeoutTicks: 3 });
                return true;
            }
            if (over()) return true;
        }
        throw Error(`no ${label} progress: shark did not heal`);
    };
    const walk = async (x: number, z: number, tol: number, outbound = false, deadline = Infinity, via?: readonly PathPoint[]) => {
        await eatGap();
        const sustain = startQuestSustain(
            { ...s, direct: async a => (await s.direct(a)) as { success: boolean; message?: string } },
            {
                food: [...site.foods],
                eatAt,
                onConsumed: () => {
                    eaten++;
                    lastEat = s.tick();
                },
            },
        );
        const cancel = new AbortController();
        const offTick = s.onTick(() => {
            if (outbound && over()) cancel.abort('stop requested');
            else if (s.tick() >= deadline) cancel.abort('retreat deadline');
        });
        const signal = AbortSignal.any([sustain.aborted, cancel.signal]);
        try {
            let why = '-';
            const ok = via
                ? await (async () => {
                      if (o.walk) {
                          for (const p of via) {
                              if (signal.aborted || !(await o.walk(p.x, p.z, p.tol ?? 2, signal))) {
                                  why = `via ${p.x},${p.z} not reached`;
                                  return false;
                              }
                          }
                          return await o.walk(x, z, tol, signal);
                      }
                      const left = deadline - s.tick();
                      const r = await walkPath(await sessionWalker(s as Session), [...via, { x, z, tol }], {
                          signal,
                          ...(Number.isFinite(left) ? { maxTicks: Math.max(1, left) } : {}),
                      });
                      if (!r.ok) why = `walkPath: ${r.detail ?? 'not arrived'} next=${r.next} still=${r.still}`;
                      return r.ok;
                  })()
                : o.walk
                    ? await o.walk(x, z, tol, signal)
                    : await (async () => {
                          const r = await combatFerryWalk(s, { x, z, level: 0 }, async (tile, planBudgetMs) =>
                              goTo(s as Session, await getWorld(), tile, accountOf(s as Session), {
                                  maxRetriesPerLeg: 2,
                                  legTimeoutTicks: 150,
                                  signal,
                                  planBudgetMs,
                              }),
                          );
                          if (!r.ok) why = `${r.reason}: ${r.detail}`;
                          return r.ok;
                      })();
            await sustain.settle();
            if (sustain.failure()) throw Error(sustain.failure()!);
            const arrived = ok && near(x, z, tol);
            if (!arrived) {
                const p = state()?.player;
                console.log(
                    `WALK_FAIL ${label} to=${x},${z} at=${p ? `${p.worldX},${p.worldZ},${p.level}` : '-'} ok=${ok} aborted=${signal.aborted ? String(signal.reason) : '-'} ${why}`,
                );
            }
            return arrived;
        } finally {
            offTick();
            await sustain.settle();
        }
    };
    let trail: PathTile[] = [];
    const enter = async () => {
        const rec: PathTile[] = [];
        const mark = () => {
            const p = state()?.player;
            if (!p || p.level !== 0) return;
            const at = { x: p.worldX, z: p.worldZ };
            const last = rec[rec.length - 1];
            if (!last || cheb(last, at) >= TRAIL_STEP) rec.push(at);
        };
        const giant = site === GIANT_SITE;
        if (giant) mark();
        const offTrail = giant ? s.onTick(mark) : () => {};
        let arrived: boolean;
        try {
            arrived = await walk(site.spot.x, site.spot.z, 3, true);
        } finally {
            offTrail();
        }
        if (giant && arrived && near(site.spot.x, site.spot.z, 3)) {
            const p = state()!.player!;
            const at = { x: p.worldX, z: p.worldZ };
            const last = rec[rec.length - 1];
            if (!last || cheb(last, at) > 0) rec.push(at);
            trail = rec;
        }
        if (over()) return;
        if (!arrived || !near(site.spot.x, site.spot.z, 3)) throw Error(`no ${label} progress: surface camp arrival unobserved`);
    };
    const retaliate = async (on: boolean) => {
        if (state()?.autoRetaliateEnabled === on || state()?.autoRetaliateEnabled === undefined) return false;
        await s.direct({ type: 'clickComponent', componentId: on ? RETALIATE_ON : RETALIATE_OFF, reason: `${label} retreat auto-retaliate ${on ? 'ON' : 'OFF'}` });
        return await waitUntil(s, () => state()?.autoRetaliateEnabled === on, { timeoutTicks: 5 });
    };
    const bankDistance = () => {
        const p = state()?.player;
        return p ? Math.max(Math.abs(p.worldX - site.bank.x), Math.abs(p.worldZ - site.bank.z)) : Infinity;
    };
    const giantRetreat = (): PathPoint[] | undefined => {
        const p = state()?.player;
        if (site !== GIANT_SITE || !p || p.level !== 0) return undefined;
        const at = { x: p.worldX, z: p.worldZ };
        const r = site.room;
        const close = trail.some(t => cheb(t, at) <= 20) || inBox([r[0]! - 10, r[1]! - 10, r[2]! + 10, r[3]! + 10], at.x, at.z);
        return close ? retreatWaypoints(trail, at, site.bank) : undefined;
    };
    const leave = async () => {
        const offRetal = await retaliate(false);
        const budget = retreatBudget(bankDistance());
        const begin = s.tick();
        const deadline = begin + budget;
        console.log(`RETREAT ${label} autoRetaliateOff=${offRetal} distance=${bankDistance()} budget=${budget}`);
        try {
            let best = Infinity;
            for (let n = 0; n < 3 && s.tick() < deadline; n++) {
                const via = giantRetreat();
                if (via) console.log(`RETREAT ${label} via=${JSON.stringify(via.map(p => [p.x, p.z]))} trail=${trail.length}`);
                if ((await walk(site.bank.x, site.bank.z, 3, false, deadline, via)) && near(site.bank.x, site.bank.z, 3)) return;
                const d = bankDistance();
                console.log(`WALK_RETRY ${label} retreat try=${n + 1} distance=${d} ticks=${s.tick() - begin}`);
                if (d >= best) break;
                best = d;
            }
            throw Error(`no ${label} progress: bank retreat failed at distance=${bankDistance()} after ${s.tick() - begin} of ${budget} ticks`);
        } finally {
            if (offRetal) console.log(`RETREAT ${label} autoRetaliateRestored=${await retaliate(true)}`);
        }
    };
    const open = async () => {
        if (state()?.bank?.isOpen && s.bankObservation?.()) return;
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !(await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 20 }))) {
            throw Error(`no ${label} progress: bank readiness unknown`);
        }
        bankTrips++;
    };
    const bankCount = (id: number) => count(s.bankObservation?.()?.items ?? [], id);
    const deposit = async () => {
        for (const id of [...site.drops, COINS, ...(bury ? [BONES] : [])]) {
            const item = inv().find(i => i.id === id);
            if (!item) continue;
            const before = bankCount(id);
            const amount = held(id);
            if (!(await s.bot.depositItem(item, -1)).success || !(await waitUntil(s, () => held(id) === 0 && bankCount(id) === before + amount, { timeoutTicks: 20 }))) {
                throw Error(`no ${label} progress: deposit failed`);
            }
        }
    };
    const restock = async () => {
        for (const id of site.foods) {
            const take = Math.min(carry - heldPieces(), bankCount(id), 28 - inv().length);
            if (take < 1) continue;
            const row = state()?.bank?.items.find(i => i.id === id);
            const before = held(id);
            if (!row || !(await s.bot.withdrawItem(row, take, { asNote: false })).success || !(await waitUntil(s, () => held(id) === before + take, { timeoutTicks: 20 }))) {
                throw Error(`no ${label} progress: shark withdraw failed`);
            }
        }
        bankFood = site.foods.reduce((n, id) => n + bankCount(id) * bitesOf(id), 0);
    };
    const ownedFood = () => (s.bankObservation?.() ? heldFood() + site.foods.reduce((n, id) => n + bankCount(id) * bitesOf(id), 0) : undefined);
    const baseline: Record<number, number> = {};
    const picked: Record<number, number> = {};
    let initialFood: number | undefined;
    let initialAssets: Map<number, number> | undefined;
    const assetTotals = () => {
        const m = new Map<number, number>();
        for (const i of [...(s.bankObservation?.()?.items ?? []), ...allKit()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    let ammoPicked = 0;
    const gatherAmmo = async (leaving = false) => {
        if (ammoId === undefined || o.ammoPickup === false) return;
        const id = ammoId;
        const missed = new Set<string>();
        const empty = quiver() < 1;
        for (let n = 0; n < AMMO_PICKS && (leaving || !over()) && hp() > eatAt; n++) {
            const p = state()?.player;
            if (!p || (inv().length >= 28 && held(id) < 1)) break;
            const pile = ammoPiles(state()?.groundItems ?? [], id, { x: p.worldX, z: p.worldZ }, empty ? 1 : AMMO_WORTH, missed)[0];
            if (!pile) break;
            const before = held(id);
            if (!(await s.bot.pickupItem(pile)).success || !(await waitUntil(s, () => held(id) > before, { timeoutTicks: 6 }))) {
                missed.add(`${pile.x},${pile.z}`);
                continue;
            }
            ammoPicked += held(id) - before;
        }
        const item = quiver() < AMMO_LOW ? inv().find(i => i.id === id) : undefined;
        const before = quiver();
        if (item && (await s.bot.equipItem(item)).success) await waitUntil(s, () => quiver() > before, { timeoutTicks: 5 });
    };
    const gearStyle = ranged ? ('ranged' as const) : ('melee' as const);
    const gearWatch = gearLevelWatch(s, gearStyle);
    let bankKnown: { id: number; count: number }[] | undefined;
    const gear = async (bankOpen: boolean) => {
        const before = bankOpen ? (s.bankObservation?.()?.items ?? []).map(i => ({ id: i.id, count: i.count })) : undefined;
        const ownedBefore = new Map<number, number>();
        if (before) for (const i of [...before, ...allKit()]) ownedBefore.set(i.id, (ownedBefore.get(i.id) ?? 0) + i.count);
        let pin: { weapon: number; ammo: number } | undefined;
        if (ranged && o.rangedKit) {
            if (before) selectedGiantRangedKit([...before, ...allKit()], s.sdk.getSkill('Ranged')?.baseLevel ?? 1, o.rangedKit);
            pin = { weapon: o.rangedKit.bow, ammo: o.rangedKit.arrow };
        }
        const r = await reconcileCombatLoadout(s, {
            style: gearStyle,
            trainSkill: training.skill,
            bankOpen,
            stop: () => ended || died,
            label,
            pin,
            ...(ranged ? { ammo: ammoCarry, ammoMin: GIANT_AMMO_RUN } : {}),
            openBank: () => open(),
            closeBank: () => s.bot.closeBank(),
            ...(!bankOpen && bankKnown ? { bankItems: bankKnown } : {}),
        });
        if (before) bankKnown = before;
        if (ranged && r.ammo) {
            ammoId = r.ammo.id;
            ammoSlot = r.ammo.wearpos;
            ammoIds.add(ammoId);
            if (before) ammoBank = Math.max(0, (ownedBefore.get(ammoId) ?? 0) - count(allKit(), ammoId));
        }
        return r;
    };
    const spareAmmo = () => !o.rangedKit && GIANT_ARROWS.some(a => a.id !== ammoId && a.level <= (s.sdk.getSkill('Ranged')?.baseLevel ?? 1) && count(bankKnown ?? [], a.id) > 0);
    const restyle = async () => {
        const weaponName = state()?.equipment?.find(i => i.slot === 3)?.name;
        await waitUntil(s, () => !!state()?.combatStyle?.known && (!weaponName || state()?.combatStyle?.weaponName === weaponName), { timeoutTicks: 8 });
        if (state()?.combatStyle?.known) {
            const nextStyle = giantStyle(state()?.combatStyle, training.skill);
            style = nextStyle;
            if (state()?.combatStyle?.currentStyle !== nextStyle.index) await s.sdk.sendSetCombatStyle(nextStyle.index);
        }
    };
    const trip = async () => {
        if (ranged) await gatherAmmo(true);
        await leave();
        await open();
        await deposit();
        await restock();
        const r = await gear(true);
        if (r.weaponChanged) await restyle();
        if (over()) return;
        await enter();
        lastProgress = s.tick();
    };
    try {
        if (!near(site.bank.x, site.bank.z, 6)) await leave();
        await open();
        initialAssets = assetTotals();
        for (const id of site.drops) {
            baseline[id] = bankCount(id) + held(id);
            picked[id] = 0;
        }
        initialFood = ownedFood();
        if (initialFood !== undefined) initialFood += eaten;
        await deposit();
        if (!goalReached() && !over()) {
            await restock();
            const kitted = await gear(true);
            const weapon = kitted.targets.find(t => t.slot === 'weapon')?.id;
            if (!weapon) throw Error(ranged ? 'giant prerequisite: no owned bow for the Ranged level' : 'giant prerequisite: no owned equippable melee weapon');
            if (ranged && ammoId === undefined) throw Error('giant prerequisite: no owned arrows the bow fires');
            if (!state()?.equipment?.some(i => i.slot === 3 && i.id === weapon)) throw Error('giant prerequisite: melee weapon equip unobserved');
            if (ranged && quiver() < 1) throw Error('giant prerequisite: no arrows in the quiver');
            if (
                !(await waitUntil(s, () => !!state()?.combatStyle?.known && state()?.combatStyle?.weaponName === state()?.equipment?.find(i => i.slot === 3)?.name, {
                    timeoutTicks: 10,
                }))
            ) {
                throw Error('giant prerequisite: equipped combat styles unknown');
            }
            const selectedStyle = giantStyle(state()?.combatStyle, training.skill);
            style = selectedStyle;
            if (heldFood() < 1) throw Error(`${label} prerequisite: no owned shark`);
            if (
                !(await s.sdk.sendSetCombatStyle(selectedStyle.index)).success
                || !(await waitUntil(
                    s,
                    () => {
                        const c = state()?.combatStyle;
                        return !!c?.known && c.currentStyle === selectedStyle.index && c.weaponName === selectedStyle.weapon;
                    },
                    { timeoutTicks: 10 },
                ))
            ) {
                throw Error(`no ${label} progress: selected combat style unobserved`);
            }
            while (hp() <= eatAt && !over()) if (!(await eat())) throw Error('giant prerequisite: no carried shark before transit');
            await enter();
        }
        lastProgress = s.tick();
        const retry = new Map<number, number>();
        const selfSlot = (s as { client?: { selfSlot?: number } }).client?.selfSlot;
        const buryOwn = async (x: number, z: number, freshCount: number) => {
            const item = freshCount > 0 ? state()?.groundItems.find(i => i.id === BONES && i.x === x && i.z === z) : undefined;
            if (!item || inv().length >= 28) return;
            const before = held(BONES);
            if (!(await s.bot.pickupItem(item)).success || !(await waitUntil(s, () => held(BONES) > before, { timeoutTicks: 8 }))) return;
            const bone = inv().find(i => i.id === BONES);
            const option = bone?.optionsWithIndex?.find(op => /^bury$/i.test(op.text));
            if (!bone || !option) return;
            const xp = prayerXp();
            if ((await s.sdk.sendUseItem(bone.slot, option.opIndex)).success && (await waitUntil(s, () => prayerXp() > xp, { timeoutTicks: 6 }))) buried++;
            if (state()?.dialog?.isOpen) await s.bot.dismissBlockingUI();
        };
        while (!goalReached() && !over()) {
            if (hp() <= eatAt && !(await eat())) {
                if (bankFood < 1) {
                    if (roam) {
                        stop = 'food';
                        break;
                    }
                    stop = 'low-hp';
                    throw Error(`no ${label} progress: low HP and no owned shark`);
                }
                await trip();
                continue;
            }
            if (ranged && quiver() < 1) await gatherAmmo();
            if (ranged && quiver() < 1) {
                if (ammoBank < 1 && !spareAmmo()) {
                    stop = 'ammo';
                    break;
                }
                await trip();
                if (quiver() < 1 && !over()) {
                    stop = 'ammo';
                    break;
                }
                continue;
            }
            if (28 - inv().length < 2) {
                await trip();
                continue;
            }
            if (s.tick() - lastProgress >= (o.noProgress ?? 200)) throw Error(`no ${label} progress: target/loot timeout`);
            const free = (state()?.nearbyNpcs ?? []).filter(
                n =>
                    site.npcs.includes(n.id)
                    && inBox(site.room, n.tileX ?? n.x, n.tileZ ?? n.z)
                    && !n.inCombat
                    && n.reachable !== false
                    && (n.hp == null || n.maxHp == null || n.hp >= n.maxHp)
                    && (retry.get(n.index) ?? 0) <= s.tick(),
            );
            const target = roamTarget(s.name, free, roam && (state()?.nearbyPlayers ?? []).some(p => p.distance <= 20));
            if (!target) {
                if (roam && s.tick() - lastProgress >= 10 && !near(site.spot.x, site.spot.z, 3)) await walk(site.spot.x, site.spot.z, 3, true);
                else await waitTicks(s, 1);
                continue;
            }
            const beforeXp = selectedXp();
            const groundBefore = cowGroundCounts(state()?.groundItems ?? []);
            if (!(await s.bot.attack(target)).success) {
                retry.set(target.index, s.tick() + 20);
                await waitTicks(s, 1);
                continue;
            }
            let x = target.tileX ?? target.x;
            let z = target.tileZ ?? target.z;
            let observedXp = beforeXp;
            let gone = false;
            let dry = false;
            let released = false;
            let hungry = false;
            let lastXp = s.tick();
            lastProgress = s.tick();
            const fresh = (id: number) => count((state()?.groundItems ?? []).filter(i => i.x === x && i.z === z), id) - (groundBefore.get(`${id}:${x}:${z}`) ?? 0);
            while (!over()) {
                if (hp() <= eatAt && !(await eat())) {
                    if (roam) {
                        hungry = true;
                        break;
                    }
                    stop = 'low-hp';
                    throw Error(`no ${label} progress: low HP in combat and no carried shark`);
                }
                const current = state()?.nearbyNpcs.find(n => n.index === target.index);
                if (current) {
                    x = current.tileX ?? current.x;
                    z = current.tileZ ?? current.z;
                } else gone = true;
                if (selectedXp() > observedXp) {
                    observedXp = selectedXp();
                    lastProgress = s.tick();
                    lastXp = s.tick();
                }
                if (site.creditDrop === undefined ? gone && selectedXp() > beforeXp : giantCredit(gone, selectedXp() - beforeXp, fresh(site.creditDrop))) break;
                if (ranged && quiver() < 1) {
                    dry = true;
                    break;
                }
                if (roam && !gone && s.tick() - lastXp >= 40) {
                    retry.set(target.index, s.tick() + 50);
                    released = true;
                    break;
                }
                if (roam && selectedXp() === beforeXp && anothersFight(current, selfSlot)) {
                    retry.set(target.index, s.tick() + 20);
                    released = true;
                    break;
                }
                if (roam && gone) {
                    released = true;
                    break;
                }
                if (state()?.dialog?.isOpen) {
                    await s.bot.dismissBlockingUI();
                    const again = state()?.nearbyNpcs.find(n => n.index === target.index);
                    if (again) await s.bot.attack(again);
                }
                if (s.tick() - lastProgress >= (o.noProgress ?? 200)) throw Error(`no ${label} progress: target/loot timeout`);
                await waitTicks(s, 1);
            }
            if (over()) break;
            if (dry || released || hungry) continue;
            if (bury) await buryOwn(x, z, fresh(BONES));
            const roots = fresh(GIANT.limpwurt) > 0;
            for (const id of site.drops.filter(dropId => fresh(dropId) > 0)) {
                const amount = fresh(id);
                const item = state()?.groundItems.find(i => i.id === id && i.x === x && i.z === z);
                const before = held(id);
                if (!item || !(await s.bot.pickupItem(item)).success || !(await waitUntil(s, () => held(id) === before + amount, { timeoutTicks: 10 }))) {
                    throw Error(`no ${label} progress: credited loot pickup mismatch`);
                }
                picked[id] = (picked[id] ?? 0) + amount;
            }
            if (ranged) await gatherAmmo();
            creditedKills++;
            if (roots) limpwurt++;
            lastProgress = s.tick();
            console.log(
                `MILESTONE ${label} credited=${creditedKills} trainSkill=${training.skill} selectedXp=${selectedXp() - initialSelectedXp} level=${level()} HP=${hp()} sharks=${heldFood()} limpwurt=${limpwurt}`,
            );
            if (gearWatch.crossed() && !goalReached() && !over()) {
                const r = await gear(false);
                if (r.weaponChanged) await restyle();
                if (r.bankBetter && !over()) await trip();
            }
        }
        if (ranged && !died && !ended && !o.stop?.()) await gatherAmmo(true);
        stop = goalReached() ? (maximum === undefined ? 'target-level' : 'max-kills') : died ? 'died' : o.stop?.() ? 'stop-file' : stop === 'ammo' || stop === 'food' ? stop : 'cap';
    } catch (e) {
        failure = String(e);
        if (stop === 'cap' && o.stop?.()) stop = 'stop-file';
    } finally {
        if (!died && !ended) {
            try {
                if (!near(site.bank.x, site.bank.z, 6)) await leave();
                await open();
                await deposit();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    const banked = {
        bigBones: bankCount(GIANT.bigBones) - (baseline[GIANT.bigBones] ?? bankCount(GIANT.bigBones)),
        limpwurt: bankCount(GIANT.limpwurt) - (baseline[GIANT.limpwurt] ?? bankCount(GIANT.limpwurt)),
    };
    const bankedHerbs = Object.fromEntries(GIANT_HERBS.map(id => [id, bankCount(id) - (baseline[id] ?? bankCount(id))]));
    const bankedOf = (id: number) => bankCount(id) - (baseline[id] ?? bankCount(id));
    const bankedAll =
        (site.creditDrop === undefined || bankedOf(site.creditDrop) === creditedKills)
        && (site !== GIANT_SITE || banked.limpwurt === limpwurt)
        && site.drops.every(id => bankedOf(id) === (picked[id] ?? 0));
    const finalAssets = assetTotals();
    const preserved =
        initialAssets !== undefined
        && [...new Set([...initialAssets.keys(), ...finalAssets.keys()])].every(
            id =>
                site.drops.includes(id)
                || site.foods.includes(id)
                || ammoIds.has(id)
                || (bury && id === BONES)
                || (finalAssets.get(id) ?? 0) === (initialAssets!.get(id) ?? 0),
        )
        && site.drops.every(id => held(id) === 0);
    const finalFood = ownedFood();
    const foodAccounted = initialFood !== undefined && finalFood === initialFood - eaten;
    const targetMet = goalReached() && bankedAll;
    const partial =
        !targetMet
        && creditedKills > 0
        && (stop === 'cap' || stop === 'ammo' || stop === 'food')
        && bankedAll
        && !failure
        && !died
        && !ended
        && preserved
        && foodAccounted;
    return {
        ok: !failure && !died && !ended && (targetMet || partial) && preserved && foodAccounted,
        creditedKills,
        banked,
        bankedHerbs,
        limpwurt,
        trainSkill: training.skill,
        targetLevel: training.targetLevel,
        ...(ammoId === undefined
            ? {}
            : {
                  ammoId,
                  ammoIds: [...ammoIds],
                  ammoUsed: [...ammoIds].reduce((n, id) => n + (initialAssets?.get(id) ?? 0) - bankCount(id) - count(allKit(), id), 0),
                  ammoPicked,
              }),
        ...(bury ? { buried, prayerXp: prayerXp() - prayerStart } : {}),
        worn: (state()?.equipment ?? []).map(i => i.id),
        style,
        startLevel,
        finalLevel: level(),
        selectedXp: selectedXp() - initialSelectedXp,
        eatAt,
        eaten,
        initialFood: initialFood ?? null,
        finalFood: finalFood ?? null,
        foodAccounted,
        bankTrips,
        hpMin,
        died,
        lifeId: state()?.player?.lifeId,
        respawns: state()?.player?.respawnCount,
        ticks: s.tick() - start,
        preserved,
        targetMet,
        partial,
        stop,
        failure: failure || (!targetMet && !partial ? `no ${label} progress: bounded target unmet` : '-'),
    };
}

export const TAVERLEY_ROUTE = {
    SURFACE_BANK: { x: 2946, z: 3368 },
    LADDER_DOWN: { x: 2884, z: 3397, id: 1759 },
    LADDER_UP: { x: 2884, z: 9797, id: 1755 },
    DUSTY_GATE: { x: 2924, z: 9803, id: 2623 },
    DUSTY_KEY_ID: 1590,
    ANTI_DRAGON_SHIELD_ID: 1540,
    GATE_CORRIDOR: [
        { x: 2886, z: 9817 },
        { x: 2889, z: 9831 },
        { x: 2910, z: 9830 },
    ],
    BLACK_CORRIDOR: [
        { x: 2895, z: 9792 },
        { x: 2893, z: 9777 },
        { x: 2885, z: 9769 },
        { x: 2877, z: 9788 },
        { x: 2860, z: 9799 },
        { x: 2839, z: 9814 },
    ],
} as const;

export function isNonWildernessGatherGoal(x: number, z: number): boolean {
    if (x >= 2944 && x <= 3391 && z >= 3520 && z < 6400) return false;
    if (x >= 2944 && x <= 3391 && z >= 9920) return false;
    return true;
}

export function createTaverleyTravel() {
    const inDungeon = (x: number, z: number) => x >= 2816 && x <= 2960 && z >= 9664 && z <= 9860;
    const behindDustyGate = (x: number, z: number) =>
        (x >= 2895 && x < TAVERLEY_ROUTE.DUSTY_GATE.x && z >= 9792 && z <= 9818) || (x < 2880 && z >= 9792 && z <= 9850);
    const findNearLoc = (s: CombatSession, id: number, pattern: RegExp, x: number, z: number) =>
        (s.sdk.getState()?.nearbyLocs ?? [])
            .filter(l => l.id === id || (pattern.test(l.name) && Math.max(Math.abs(l.x - x), Math.abs(l.z - z)) <= 6))
            .sort((a, b) => Math.abs(a.x - x) + Math.abs(a.z - z) - (Math.abs(b.x - x) + Math.abs(b.z - z)))[0];
    return {
        async walk(
            s: CombatSession,
            _targetKey: string,
            goal: { x: number; z: number; level?: number },
            ground: (x: number, z: number, tol?: number) => Promise<boolean>,
            stop: () => boolean,
            tol = 2,
        ): Promise<boolean> {
            if (!isNonWildernessGatherGoal(goal.x, goal.z)) throw Error(`Wilderness goal forbidden in Taverley travel: ${goal.x},${goal.z}`);
            const pos = () => s.sdk.getState()?.player;
            let cur = pos();
            if (!cur) return false;
            if (cur.worldZ >= 6400 && !inDungeon(cur.worldX, cur.worldZ)) {
                if (typeof s.sdk.findNearbyLoc !== 'function') return false;
                const routed = await combatWalkTargetPersist(s, { x: TAVERLEY_ROUTE.LADDER_DOWN.x, z: TAVERLEY_ROUTE.LADDER_DOWN.z, level: 0 });
                cur = pos();
                if (!routed.ok || !cur || (cur.worldZ >= 6400 && !inDungeon(cur.worldX, cur.worldZ))) return false;
            }
            if (inDungeon(goal.x, goal.z)) {
                if (!inDungeon(cur.worldX, cur.worldZ)) {
                    if (!(await ground(TAVERLEY_ROUTE.LADDER_DOWN.x, TAVERLEY_ROUTE.LADDER_DOWN.z, 2))) return false;
                    for (let i = 0; i < 3 && !stop() && !inDungeon(pos()?.worldX ?? 0, pos()?.worldZ ?? 0); i++) {
                        const ladder = findNearLoc(s, TAVERLEY_ROUTE.LADDER_DOWN.id, /ladder/i, TAVERLEY_ROUTE.LADDER_DOWN.x, TAVERLEY_ROUTE.LADDER_DOWN.z);
                        if (!ladder) {
                            await waitTicks(s, 1);
                            continue;
                        }
                        await s.bot.interactLoc(ladder, /climb-down/i);
                        await waitUntil(s, () => stop() || inDungeon(pos()?.worldX ?? 0, pos()?.worldZ ?? 0), { timeoutTicks: 10 });
                    }
                    cur = pos();
                    if (!cur || !inDungeon(cur.worldX, cur.worldZ)) return false;
                }
                if (behindDustyGate(goal.x, goal.z) && !behindDustyGate(cur.worldX, cur.worldZ)) {
                    if (cur.worldX < TAVERLEY_ROUTE.DUSTY_GATE.x) {
                        for (const wp of TAVERLEY_ROUTE.GATE_CORRIDOR) {
                            if (!(await ground(wp.x, wp.z, 4))) return false;
                        }
                    }
                    if (!(await ground(TAVERLEY_ROUTE.DUSTY_GATE.x, TAVERLEY_ROUTE.DUSTY_GATE.z, 1))) return false;
                    const key = s.sdk.getInventory().find(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID);
                    if (!key) throw Error('Dusty key (1590) required to unlock Taverley dragon gate');
                    for (let i = 0; i < 3 && !stop() && !behindDustyGate(pos()?.worldX ?? 9999, pos()?.worldZ ?? 0); i++) {
                        const gate = findNearLoc(s, TAVERLEY_ROUTE.DUSTY_GATE.id, /gate/i, TAVERLEY_ROUTE.DUSTY_GATE.x, TAVERLEY_ROUTE.DUSTY_GATE.z);
                        if (!gate) {
                            await waitTicks(s, 1);
                            continue;
                        }
                        await s.bot.useItemOnLoc(key, gate);
                        await waitUntil(s, () => stop() || behindDustyGate(pos()?.worldX ?? 9999, pos()?.worldZ ?? 0), { timeoutTicks: 12 });
                    }
                    cur = pos();
                    if (!cur || !behindDustyGate(cur.worldX, cur.worldZ)) return false;
                    if (goal.x < 2880) {
                        for (const wp of TAVERLEY_ROUTE.BLACK_CORRIDOR) {
                            if (!(await ground(wp.x, wp.z, 4))) return false;
                        }
                    }
                }
                return ground(goal.x, goal.z, tol);
            }
            if (inDungeon(cur.worldX, cur.worldZ)) {
                if (behindDustyGate(cur.worldX, cur.worldZ)) {
                    if (cur.worldX < 2880) {
                        for (const wp of [...TAVERLEY_ROUTE.BLACK_CORRIDOR].reverse()) {
                            if (!(await ground(wp.x, wp.z, 4))) return false;
                        }
                    }
                    if (!(await ground(TAVERLEY_ROUTE.DUSTY_GATE.x - 1, TAVERLEY_ROUTE.DUSTY_GATE.z, 2))) return false;
                    for (let i = 0; i < 3 && !stop() && behindDustyGate(pos()?.worldX ?? 0, pos()?.worldZ ?? 0); i++) {
                        const gate = findNearLoc(s, TAVERLEY_ROUTE.DUSTY_GATE.id, /gate/i, TAVERLEY_ROUTE.DUSTY_GATE.x, TAVERLEY_ROUTE.DUSTY_GATE.z);
                        if (!gate) {
                            await waitTicks(s, 1);
                            continue;
                        }
                        await s.bot.interactLoc(gate, /open/i);
                        await waitUntil(s, () => stop() || !behindDustyGate(pos()?.worldX ?? 0, pos()?.worldZ ?? 0), { timeoutTicks: 12 });
                    }
                    cur = pos();
                    if (!cur || behindDustyGate(cur.worldX, cur.worldZ)) return false;
                }
                if (cur.worldX >= 2905) {
                    for (const wp of [...TAVERLEY_ROUTE.GATE_CORRIDOR].reverse()) {
                        if (!(await ground(wp.x, wp.z, 4))) return false;
                    }
                }
                if (!(await ground(TAVERLEY_ROUTE.LADDER_UP.x, TAVERLEY_ROUTE.LADDER_UP.z, 2))) return false;
                for (let i = 0; i < 3 && !stop() && inDungeon(pos()?.worldX ?? 0, pos()?.worldZ ?? 9999); i++) {
                    const ladder = findNearLoc(s, TAVERLEY_ROUTE.LADDER_UP.id, /ladder/i, TAVERLEY_ROUTE.LADDER_UP.x, TAVERLEY_ROUTE.LADDER_UP.z);
                    if (!ladder) {
                        await waitTicks(s, 1);
                        continue;
                    }
                    await s.bot.interactLoc(ladder, /climb-up/i);
                    await waitUntil(s, () => stop() || !inDungeon(pos()?.worldX ?? 0, pos()?.worldZ ?? 9999), { timeoutTicks: 10 });
                }
                cur = pos();
                if (!cur || inDungeon(cur.worldX, cur.worldZ)) return false;
            }
            return ground(goal.x, goal.z, tol);
        },
    };
}

export const CONFIGS: Record<
    string,
    {
        npc: RegExp;
        spot: { x: number; z: number };
        bankSpot: { x: number; z: number };
        drops: RegExp;
        gatherOnly?: boolean;
        requireTelegrab?: boolean;
        taverley?: boolean;
        dustyKey?: boolean;
        dragonShield?: boolean;
        // PLAIN_FOOD pieces that the run carries from the bank (combatFoodWanted).
        food?: number;
        prayer?: CombatPrayerFloor;
    }
> = {
    druid: {
        npc: /^chaos druid$/i,
        spot: { x: 3115, z: 9928 },
        bankSpot: { x: 3092, z: 3496 },
        drops: /(herb|nature rune|law rune|vial of water)/i,
    },
    trooper: {
        npc: /^khazard trooper$/i,
        spot: { x: 2525, z: 3242 },
        bankSpot: { x: 2619, z: 3332 },
        drops: /$^/,
    },
    unicorn: {
        npc: /^unicorn$/i,
        spot: { x: 3087, z: 3452 },
        bankSpot: { x: 3092, z: 3496 },
        drops: /^unicorn horn$/i,
    },
    wizard: {
        npc: /^wizard$/i,
        spot: { x: 3110, z: 3162 },
        bankSpot: { x: 3092, z: 3243 },
        drops: /^water talisman$/i,
    },
    giant: {
        npc: /^(?:hill )?giant$/i,
        spot: { x: 2545, z: 3144 },
        bankSpot: { x: 2655, z: 3283 },
        drops: /(big bones|limpwurt root|iron arrow|nature rune|cosmic rune|law rune|death rune|chaos rune|uncut |herb|half of a key)/i,
        // The brain's giant row asks for 8 food (packages/brain/src/catalog.ts combatSurvivability).
        food: 8,
    },
    taverley_druid: {
        npc: /^chaos druid$/i,
        spot: { x: 2933, z: 9849 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /(herb|snape grass|nature rune|law rune|air rune|vial of water|uncut |half of a key)/i,
        taverley: true,
    },
    taverley_black_knight: {
        npc: /^black knight$/i,
        spot: { x: 2939, z: 9812 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /(cosmic rune|death rune|chaos rune|law rune|steel bar|mithril arrow|herb|half of a key)/i,
        taverley: true,
        // preflight.ts taverley_black_knight minFood.
        food: 10,
        // Black Knights kill an account of 74-84 Hitpoints when Protect from Melee is off. The prayer guard spends about
        // 40 points in 3000 ticks of fighting here.
        prayer: { enter: 25, leave: 10 },
    },
    taverley_scales: {
        npc: /$^/,
        spot: { x: 2906, z: 9802 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /^blue dragon scale$/i,
        gatherOnly: true,
        taverley: true,
        dustyKey: true,
        dragonShield: true,
    },
    taverley_blue_dragon: {
        npc: /^blue dragon$/i,
        spot: { x: 2908, z: 9803 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /(blue dragon scale|blue dragonhide|dragonhide|dragon bones|nature rune|water rune|rune dagger|adamant full helm|herb|half of a key|shield left half)/i,
        taverley: true,
        dustyKey: true,
        dragonShield: true,
    },
    taverley_black_dragon: {
        npc: /^black dragon$/i,
        spot: { x: 2832, z: 9825 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /(black dragonhide|dragonhide|dragon bones|rune knife|blood rune|law rune|adamant platebody|rune longsword|adamant javelin|fire rune|half of a key|shield left half)/i,
        taverley: true,
        dustyKey: true,
        dragonShield: true,
    },
    taverley_giant: {
        npc: /^(?:hill |moss |ice )?giant$/i,
        spot: { x: 2906, z: 9792 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /(big bones|limpwurt root|herb|nature rune|law rune|cosmic rune|uncut |half of a key)/i,
        taverley: true,
    },
    chaos_wine: {
        npc: /$^/,
        spot: { x: 2932, z: 3515 },
        bankSpot: { x: 2946, z: 3368 },
        drops: /^wine of zamorak$/i,
        gatherOnly: true,
        requireTelegrab: true,
    },
};

export async function ensureSurfaceGroundEntry(
    s: Pick<Session, 'sdk' | 'bot' | 'onTick' | 'tick'>,
    stop: () => boolean = () => false,
    timeoutTicks = 20,
): Promise<void> {
    const level = () => s.sdk.getState()?.player?.level ?? 0;
    if (level() === 0) return;
    const isShipHoldLadder = (l: any) => l.id === 273 || l.id === 287 || /ship'?s?\s*ladder/i.test(l.name ?? '');
    const locs = s.sdk.getState()?.nearbyLocs ?? [];
    const bs = s as unknown as BoatSession;
    const hasDeckPlank = locs.some((l: any) => /(gang)?plank/i.test(l.name ?? '') && (l.distance ?? 0) <= 20 && !BOARD_PLANK_IDS.has(l.id ?? -1));
    if (level() === 1 && hasDeckPlank && typeof bs.sdk.findNearbyLoc === 'function' && typeof bs.sdk.getDialog === 'function') {
        await disembark(bs, { stop, crossTicks: timeoutTicks });
    } else {
        const entry = (rank: number, l: any, opt: any) => ({ loc: l, opt, rank, distance: l.distance ?? 0 });
        const descent = locs
            .map((l: any) => {
                const opts = l.optionsWithIndex ?? [];
                if (/(gang)?plank/i.test(l.name ?? '') && !BOARD_PLANK_IDS.has(l.id ?? -1)) {
                    const cross = opts.find((o: any) => /^cross$/i.test(o.text));
                    if (cross) return entry(DISEMBARK_PLANK_IDS.has(l.id ?? -1) ? 0 : 1, l, cross);
                }
                if (isShipHoldLadder(l)) return null;
                const down = opts.find((o: any) => /^climb-?down$/i.test(o.text));
                return down ? entry(2, l, down) : null;
            })
            .filter((cand): cand is NonNullable<typeof cand> => !!cand && cand.distance <= 20)
            .sort((a, b) => a.rank - b.rank || a.distance - b.distance)[0];
        if (descent) {
            await s.bot.interactLoc(descent.loc, descent.opt.opIndex);
            await waitUntil(s as Session, () => stop() || level() === 0, { timeoutTicks });
        }
    }
    const remaining = level();
    if (remaining !== 0) {
        throw Error(`combat prerequisite: surface entry requires level 0 (level !== 0: at level ${remaining})`);
    }
}

export async function runGenericCombatSession(
    ownedSession: CombatSession,
    opts: {
        target: string;
        cap: number;
        maximum?: number;
        untilItemName?: string;
        env?: Record<string, string | undefined>;
        stop?: () => boolean;
        // The reason of the session stop (openBot onStop): `died`, or `fled at low hitpoints: ...` from the flee guard.
        stopReason?: () => string | undefined;
        // Replaces the travel to a tile (tests).
        walk?: (x: number, z: number, tol: number, stop: () => boolean) => Promise<boolean>;
    },
): Promise<{ ok: boolean; kills: number; itemsLooted: number; bankTrips: number; walkTicks: number; detail: string; untilHeld?: boolean }> {
    const TARGET_KEY = opts.target.toLowerCase();
    const CAP = opts.cap;
    const maximum = opts.maximum;
    const env = opts.env ?? {};
    const untilItem = opts.untilItemName ? untilItemPattern(opts.untilItemName) : undefined;
    if (untilItem && !conf0Drops(TARGET_KEY).test(opts.untilItemName!)) {
        return { ok: false, kills: 0, itemsLooted: 0, bankTrips: 0, walkTicks: 0, detail: `no combat progress: UNTIL_ITEM ${opts.untilItemName} is no drop that target ${TARGET_KEY} picks up` };
    }
    const potionPolicy = combatPotionPolicy(env);
    if ((potionPolicy || maximum !== undefined) && CAP <= 200) throw Error('finite combat job reserves200ticks for owned bank return');
    const alch = combatAlchPolicy(env);
    const telegrab = telegrabPolicy(env);
    const bankPack = env.BANK_PACK === '1';
    const dungeonGiant = TARGET_KEY === 'giant' && (maximum !== undefined || !!potionPolicy || !!alch || !!telegrab);
    const targetConf = CONFIGS[TARGET_KEY] ?? CONFIGS.druid!;
    const effectiveTelegrab = telegrab ?? (targetConf.requireTelegrab ? { maximum: maximum ?? 50, cap: CAP } : undefined);
    const baseConf = dungeonGiant
        ? { ...targetConf, spot: { x: 3117, z: 9850 }, bankSpot: { x: 3092, z: 3496 }, drops: /(big bones|limpwurt root|iron arrow|nature rune)/i }
        : targetConf;
    const conf = alch?.route ? { ...baseConf, spot: alch.route.site, bankSpot: alch.route.bank } : baseConf;
    if (untilItem && !conf.drops.test(opts.untilItemName!)) {
        return { ok: false, kills: 0, itemsLooted: 0, bankTrips: 0, walkTicks: 0, detail: `no combat progress: UNTIL_ITEM ${opts.untilItemName} is no drop that target ${TARGET_KEY} picks up` };
    }
    const untilId = untilItem ? objId(opts.untilItemName!.trim().toLowerCase()) : undefined;
    if (TARGET_KEY !== 'druid' && !dungeonGiant && !isNonWildernessGatherGoal(conf.spot.x, conf.spot.z)) {
        throw Error(`Wilderness destination forbidden for ${TARGET_KEY}`);
    }
    const stopCheck = () => !!opts.stop?.();
    const dungeonTravel =
        (TARGET_KEY === 'druid' || dungeonGiant) && !alch?.route
            ? createEdgevilleTravel(ownedSession)
            : targetConf.taverley && !alch?.route
                ? createTaverleyTravel()
                : undefined;
    const cleanupScope = potionPolicy || maximum !== undefined ? combatPotionSession(ownedSession, stopCheck, CAP) : undefined;
    const s = cleanupScope ?? ownedSession;
    const stopEnd = () => combatStopEnd(opts.stopReason?.());
    const stallWords = () => combatStallWords(opts.stopReason?.());
    const lifeDied = combatLifeWatch(ownedSession, cleanupScope);
    const runEnd = () => (lifeDied() ? 'died' : undefined) ?? stopEnd();
    const foodWant = combatFoodWanted(targetConf);
    // The survival check of each fight (admission.ts). A run that only picks up items, or takes them by Telekinetic
    // Grab, does not fight.
    const admissionGuard = targetConf.gatherOnly || effectiveTelegrab ? undefined : createCombatAdmissionGuard(s, TARGET_KEY, genericCombatNpcIds(TARGET_KEY));
    let justBanked = false;
    let combatRecovery: (() => Promise<string | undefined>) | undefined;
    let kills = 0;
    let itemsLooted = 0;
    let bankTrips = 0;
    let walkTicks = 0;
    let capped = false;
    try {
        const pos = () => s.sdk.getState()?.player;
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
        const prayer = () => s.sdk.getSkill('Prayer')?.level ?? 0;
        const t0 = s.tick();
        const used = () => s.tick() - t0;
        let recoveringPotions = false;
        const over = () => used() >= (cleanupScope && !recoveringPotions ? CAP - 200 : CAP);
        const potions = potionPolicy ? createCombatPotions(s, potionPolicy, ['Attack', 'Strength', 'Defence', 'Hitpoints'], () => over() || stopCheck()) : undefined;
        const loot = createCombatLoot(
            s,
            effectiveTelegrab ? { ...effectiveTelegrab, stop: () => over() || stopCheck() } : undefined,
            alch ? { ...alch, stop: () => over() || stopCheck() } : undefined,
        );
        const counters = () => `kills=${kills} looted=${itemsLooted} bankTrips=${bankTrips} walkTicks=${walkTicks} hp=${hp()}`;
        const travelStop = () => over() || (!recoveringPotions && stopCheck());
        const ground = async (x: number, z: number, tol = 2): Promise<boolean> => {
            const a = s.tick();
            for (let i = 0; i < 3 && !travelStop(); i++) {
                const p = pos();
                if (p && p.level !== 0) throw Error(`combat travel aborted: level !== 0 (${p.level})`);
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                if (p && needsLongSurfaceWalk({ x: p.worldX, z: p.worldZ, level: p.level }, { x, z })) {
                    const longWalk = await combatWalkTargetPersist(s, { x, z, level: 0 }, 3, to => combatApproach(s, to, travelStop));
                    if (travelStop()) break;
                    const after = pos();
                    if (after && Math.max(Math.abs(after.worldX - x), Math.abs(after.worldZ - z)) <= tol) break;
                    if (!longWalk.ok) console.log(`LONG_WALK fail ${longWalk.detail ?? longWalk.reason ?? 'unknown'}`);
                }
                const r = await walkPath(await sessionWalker(s as Session), [{ x, z, tol }], { stop: travelStop, maxTicks: 500 });
                if (!r.ok) await waitTicks(s, 1);
            }
            walkTicks += s.tick() - a;
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };
        const walk = async (x: number, z: number, tol = 2) =>
            opts.walk
                ? opts.walk(x, z, tol, travelStop)
                : dungeonTravel
                  ? dungeonTravel.walk(s, TARGET_KEY as 'druid' | 'giant', { x, z, level: 0 }, ground, travelStop, tol)
                  : ground(x, z, tol);
        const needsBankPrep = () => {
            const inv = s.sdk.getInventory();
            const worn = s.sdk.getState()?.equipment ?? [];
            if (targetConf.dragonShield && !worn.some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) return true;
            if (targetConf.dustyKey && !inv.some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) return true;
            if (targetConf.requireTelegrab) {
                const hasLaw = inv.some(i => i.id === 563);
                const hasAir = inv.some(i => i.id === 556) || worn.some(i => i.id === 1381 || i.id === 1397 || i.id === 1405);
                if (!hasLaw || !hasAir) return true;
            }
            return false;
        };
        // False when the tick cap stopped the walk to the bank (combatBankWalk): the loot stays in the pack.
        const bank = async (): Promise<boolean> => {
            if (!(await combatBankWalk(() => walk(conf.bankSpot.x, conf.bankSpot.z, 4), () => !recoveringPotions && over()))) {
                capped = true;
                return false;
            }
            await bankCombatLoot(s, conf.drops, [...(alch ? [995] : []), ...(potions?.depositIds ?? [])]);
            // An earlier job's items (a runecrafter's essence) otherwise fill the pack: combatPackFull.
            if (bankPack) await depositPack(s as Session, combatKit);
            if (targetConf.dragonShield && !(s.sdk.getState()?.equipment ?? []).some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) {
                if (!s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) {
                    await s.bot.withdrawItem(TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID, 1);
                    await waitTicks(s, 1);
                }
                const shield = s.sdk.getInventory().find(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID);
                if (!shield) throw Error('Anti-dragon shield (1540) required');
                await s.bot.closeInterface();
                await s.bot.equipItem(shield);
                await waitTicks(s, 1);
                await s.bot.openBank();
                await waitTicks(s, 1);
            }
            if (targetConf.dustyKey && !s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) {
                await s.bot.withdrawItem(TAVERLEY_ROUTE.DUSTY_KEY_ID, 1);
                await waitTicks(s, 1);
                if (!s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) throw Error('Dusty key (1590) required');
            }
            if (targetConf.requireTelegrab) {
                if (countItems(s as Session, /^law rune$/i) < 10) await s.bot.withdrawItem(563, 25);
                const hasAirStaff = (s.sdk.getState()?.equipment ?? []).some(i => i.id === 1381 || i.id === 1397 || i.id === 1405);
                if (!hasAirStaff && countItems(s as Session, /^air rune$/i) < 10) await s.bot.withdrawItem(556, 25);
                await waitTicks(s, 1);
                const hasLaw = s.sdk.getInventory().some(i => i.id === 563);
                const hasAir = hasAirStaff || s.sdk.getInventory().some(i => i.id === 556);
                if (!hasLaw || !hasAir) throw Error('Law and Air runes required for Telekinetic Grab');
            }
            // A trip that leaves no food in the pack ends the run: the run does not fight with no food. The final bank
            // return of the potion cleanup takes no food, because the run ends there.
            const fed = foodWant === 0 || recoveringPotions || (await withdrawCombatFood(s, admissionGuard ? admissionGuard.foodWant(foodWant) : foodWant)) > 0;
            bankTrips++;
            justBanked = true;
            await s.bot.closeInterface();
            await waitTicks(s, 1);
            if (!fed) throw Error(combatPackFull(s.sdk.getInventory()) ?? combatNoFood(TARGET_KEY, foodWant));
            if (recoveringPotions && !(await walk(conf.bankSpot.x, conf.bankSpot.z, 2))) throw Error('combat final bank position unavailable');
            return true;
        };
        // A run at its eat level with no food, or one that cannot enter for its Prayer points, refuses before the
        // potion cleanup owns a bank return.
        const noFood0 = combatEntryNoFood(TARGET_KEY, hp(), maxHp(), combatFoodHeld(s.sdk.getInventory()), foodWant);
        if (noFood0) throw Error(noFood0);
        // A target that the account cannot survive at any food: refuse before the first walk.
        const unsafe0 = admissionGuard?.entry();
        if (unsafe0) throw Error(`${unsafe0} ticks=0`);
        const far0 = pos() && Math.max(Math.abs(pos()!.worldX - conf.spot.x), Math.abs(pos()!.worldZ - conf.spot.z)) > 15;
        const noPrayer0 = far0 ? combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'enter') : undefined;
        if (noPrayer0) throw Error(noPrayer0);
        if (cleanupScope) {
            combatRecovery = combatPotionRecovery(
                cleanupScope,
                () => !!potions?.blocked || loot.blocked,
                bank,
                active => {
                    recoveringPotions = active;
                },
                stopEnd,
            );
        }
        if (needsBankPrep()) await bank();
        else if (foodWant > 0 && combatFoodHeld(s.sdk.getInventory()) < foodWant && !stopCheck() && !lifeDied()) await bank();
        const untilInPack = () => untilId !== undefined && s.sdk.getInventory().some(i => i.id === untilId);
        const untilBanked = () => untilId !== undefined && (s.bankObservation?.()?.items ?? []).some((i: { id: number; count: number }) => i.id === untilId && i.count > 0);
        let untilDeposited = false;
        const bankUntil = async () => {
            const had = untilInPack();
            if ((await bank()) && had) untilDeposited = true;
        };
        let stuckWalks = 0;
        while (!over() && !lifeDied() && (!cleanupScope || !stopCheck())) {
            if (untilDeposited || untilInPack() || untilBanked()) break;
            if (potions) await potions.poll();
            const invSpace = 28 - s.sdk.getInventory().length;
            if (invSpace <= 1) {
                await bankUntil();
                const full = capped || untilDeposited ? undefined : combatPackFull(s.sdk.getInventory());
                if (full) throw Error(full);
                continue;
            }
            if (targetConf.requireTelegrab && needsBankPrep()) {
                const hadLoot = s.sdk.getInventory().some(i => conf.drops.test(i.name));
                try {
                    await bankUntil();
                } catch (e) {
                    if (hadLoot || itemsLooted > 0) break;
                    throw e;
                }
                continue;
            }
            // No food left: the bank trip takes more food, or ends the run with `no food`.
            if (foodWant > 0 && combatFoodHeld(s.sdk.getInventory()) === 0) {
                await bankUntil();
                continue;
            }
            const p = pos();
            if (!p) {
                await waitTicks(s, 1);
                continue;
            }
            if (Math.max(Math.abs(p.worldX - conf.spot.x), Math.abs(p.worldZ - conf.spot.z)) > 15) {
                const noPrayer = combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'enter');
                if (noPrayer) throw Error(noPrayer);
                if (await walk(conf.spot.x, conf.spot.z, 4)) stuckWalks = 0;
                else {
                    stuckWalks++;
                    if (stuckWalks >= 3) throw Error(`combat travel blocked at ${p.worldX},${p.worldZ},${p.level}`);
                }
                continue;
            }
            stuckWalks = 0;
            if (combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'leave')) {
                await bankUntil();
                continue;
            }
            if (invSpace > 0) {
                const candidate = effectiveTelegrab || alch ? s.sdk.getState()?.groundItems.filter(i => conf.drops.test(i.name)).sort((a, b) => a.distance - b.distance)[0] : undefined;
                const r = effectiveTelegrab || alch ? (candidate ? await loot.pickup(candidate) : { success: false }) : await s.bot.pickupItem(conf.drops);
                if (r.success) {
                    itemsLooted++;
                    if (alch && itemsLooted >= alch.maximum) break;
                    if (targetConf.gatherOnly && maximum !== undefined && itemsLooted >= maximum) {
                        await bankUntil();
                        break;
                    }
                    await waitTicks(s, 1);
                    if (untilInPack()) break;
                    continue;
                }
            }
            if (targetConf.gatherOnly) {
                if (maximum !== undefined && itemsLooted >= maximum) {
                    if (s.sdk.getInventory().some(i => conf.drops.test(i.name))) await bankUntil();
                    break;
                }
                await waitTicks(s, 2);
                continue;
            }
            if (maximum !== undefined && kills >= maximum) break;
            const selfSlot = (s.client as { selfSlot?: number }).selfSlot;
            const monster = genericCombatNpc(TARGET_KEY, s.sdk.getState()?.nearbyNpcs ?? [], selfSlot);
            if (!monster) {
                await waitTicks(s, 2);
                continue;
            }
            const admit = admissionGuard?.beforeAttack(justBanked, monster);
            if (admit?.kind === 'refuse') throw Error(admit.detail);
            if (admit?.kind === 'bank') {
                await bankUntil();
                continue;
            }
            justBanked = false;
            let leaveFight = false;
            const a = await s.bot.attack(monster);
            if (a.success) {
                const began = s.tick();
                let engaged = false;
                let idleTicks = 0;
                let dead = false;
                while (!over() && !stopCheck() && !lifeDied() && s.tick() - began < 100) {
                    const st = s.sdk.getState();
                    const npc = st?.nearbyNpcs.find(n => n.index === monster.index);
                    if (npc && ((st?.player?.combat?.targetType === 'npc' && st.player.combat.targetIndex === monster.index) || npc.inCombat)) engaged = true;
                    const outcome = combatTargetFinished(st, monster.index, selfSlot, idleTicks);
                    if (outcome.done) {
                        dead = outcome.dead;
                        break;
                    }
                    // Out of food at the eat level, or out of Prayer points: the run leaves the fight for the bank.
                    if (
                        (foodWant > 0 && combatOutOfFood(hp(), maxHp(), combatFoodHeld(s.sdk.getInventory())))
                        || combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'leave')
                    ) {
                        break;
                    }
                    const active = !!st?.player?.combat?.inCombat || !!npc?.inCombat;
                    if (active) idleTicks = 0;
                    else if (engaged || (npc?.distance ?? 99) <= 2 || s.tick() - began >= 15) idleTicks++;
                    if (potions && st?.player?.combat.targetType === 'npc' && st.player.combat.targetIndex === monster.index) await potions.poll(monster);
                    // The retreat line and the crowd rule (admission.ts): leave the fight for the bank.
                    const danger = admissionGuard?.tick(s.tick());
                    if (danger) {
                        const end = admissionGuard!.left(danger);
                        if (end) throw Error(end);
                        leaveFight = true;
                        break;
                    }
                    await waitTicks(s, 1);
                }
                if (dead) {
                    kills++;
                    await waitTicks(s, 1);
                }
                if (leaveFight) await bankUntil();
            } else {
                await waitTicks(s, 2);
            }
        }
        if (untilInPack()) untilDeposited = true;
        if (combatRecovery && (!targetConf.gatherOnly || potions || alch || s.sdk.getInventory().some(i => conf.drops.test(i.name)))) await combatRecovery();
        const end = runEnd();
        if (end) {
            return { ok: false, kills, itemsLooted, bankTrips, walkTicks, detail: `ticks=${used()} ${counters()} maximum=${maximum ?? '-'} ${end}=true${stallWords()}` };
        }
        let untilHeld: boolean | undefined;
        if (untilItem) {
            if (untilInPack()) await bankUntil();
            if (untilInPack()) throw Error('UNTIL_ITEM bank return unconfirmed');
            untilHeld = untilDeposited || untilBanked();
        }
        const total = kills + itemsLooted;
        const perK = ((total * 1000) / Math.max(1, used())).toFixed(2);
        const targetMet = untilItem ? !!untilHeld : maximum === undefined || ((targetConf.gatherOnly ? itemsLooted === maximum : kills === maximum) && !stopCheck());
        const ok = total > 0 && targetMet;
        return {
            ok,
            kills,
            itemsLooted,
            bankTrips,
            walkTicks,
            untilHeld,
            detail: `ticks=${used()} ${counters()} actionsPer1kTicks=${perK} targetMet=${targetMet} maximum=${maximum ?? '-'}${untilItem ? ` until=${opts.untilItemName} held=${untilHeld}` : ''}${capped ? ' capped=true' : ''}${ok ? '' : stallWords()}`,
        };
    } catch (e) {
        let detail = combatFailDetail(e);
        if (combatRecovery) {
            try {
                await combatRecovery();
            } catch (recovery) {
                detail += '; cleanup ' + String(recovery);
            }
        }
        const end = runEnd();
        return { ok: false, kills, itemsLooted, bankTrips, walkTicks, detail: `${end ? `${detail} ${end}=true` : detail}${stallWords()}` };
    }
}

export type MeleeGatherStageHooks = {
    stageTrooperFood?: (s: CombatSession, opts: { stop: () => boolean; walk: (x: number, z: number) => Promise<boolean> }) => Promise<unknown>;
    stageCows?: (s: CombatSession, opts: { stop: () => boolean; walk: (x: number, z: number) => Promise<boolean> }) => Promise<unknown>;
};

export async function runMeleeGatherCli(
    botName: string,
    args: readonly string[] = [],
    envInput: Record<string, string | undefined> = process.env,
    hooks?: MeleeGatherStageHooks,
) {
    const env: Record<string, string | undefined> = { ...envInput };
    for (const raw of args.slice(2)) {
        const eq = raw.indexOf('=');
        if (eq > 0 && /^[A-Z0-9_]+$/.test(raw.slice(0, eq))) env[raw.slice(0, eq)] ??= raw.slice(eq + 1);
    }
    const TARGET_KEY = (args[1] ?? env.TARGET ?? 'druid').toLowerCase();
    const CAP = Number(args[0] ?? env.CAP ?? 15000);
    if (TARGET_KEY !== 'cow' && !Object.prototype.hasOwnProperty.call(CONFIGS, TARGET_KEY)) {
        await finish([], false, `no combat progress: unsupported target ${TARGET_KEY}`);
        return;
    }
    if (!Number.isSafeInteger(CAP) || CAP < 1) {
        await finish([], false, 'no combat progress: finite positive CAP required');
        return;
    }
    const maximum = TARGET_KEY !== 'cow' && env.MAX_KILLS !== undefined ? Number(env.MAX_KILLS) : undefined;
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) {
        await finish([], false, 'no combat progress: finite positive MAX_KILLS required');
        return;
    }
    const untilItem = TARGET_KEY !== 'cow' && env.UNTIL_ITEM ? untilItemPattern(env.UNTIL_ITEM) : undefined;
    if (untilItem && !conf0Drops(TARGET_KEY).test(env.UNTIL_ITEM!)) {
        await finish([], false, `no combat progress: UNTIL_ITEM ${env.UNTIL_ITEM} is no drop that target ${TARGET_KEY} picks up`);
        return;
    }
    const untilId = untilItem ? objId(env.UNTIL_ITEM!.trim().toLowerCase()) : undefined;
    const potionPolicy = combatPotionPolicy(env);
    if ((potionPolicy || maximum !== undefined) && CAP <= 200) throw Error('finite combat job reserves200ticks for owned bank return');
    const alch = combatAlchPolicy(env);
    if (alch && TARGET_KEY === 'cow') throw Error('owned alchemy hook requires generic combat loot path');
    const telegrab = telegrabPolicy(env);
    if (telegrab && TARGET_KEY === 'cow') throw Error('Telegrab loot option applies to generic druid/giant or Ranged; cow ownership receipt remains unchanged');
    const bankPack = env.BANK_PACK === '1';
    const dungeonGiant = TARGET_KEY === 'giant' && (maximum !== undefined || !!potionPolicy || !!alch || !!telegrab);
    const targetConf = CONFIGS[TARGET_KEY] ?? CONFIGS.druid!;
    const effectiveTelegrab = telegrab ?? (TARGET_KEY !== 'cow' && targetConf.requireTelegrab ? { maximum: maximum ?? 50, cap: CAP } : undefined);
    const baseConf = dungeonGiant
        ? { ...targetConf, spot: { x: 3117, z: 9850 }, bankSpot: { x: 3092, z: 3496 }, drops: /(big bones|limpwurt root|iron arrow|nature rune)/i }
        : targetConf;
    const conf = alch?.route ? { ...baseConf, spot: alch.route.site, bankSpot: alch.route.bank } : baseConf;
    if (untilItem && !conf.drops.test(env.UNTIL_ITEM!)) {
        await finish([], false, `no combat progress: UNTIL_ITEM ${env.UNTIL_ITEM} is no drop that target ${TARGET_KEY} picks up`);
        return;
    }
    if (TARGET_KEY !== 'cow' && TARGET_KEY !== 'druid' && !dungeonGiant && !isNonWildernessGatherGoal(conf.spot.x, conf.spot.z)) {
        throw Error(`Wilderness destination forbidden for ${TARGET_KEY}`);
    }
    if (!botName) throw Error('Usage: aio-fighter <account> <target> [CAP] [KEY=value...]');

    const giantTrained =
        (TARGET_KEY === 'giant' || TARGET_KEY === 'trooper')
        && (env.TRAIN_SKILL !== undefined || env.TARGET_LEVEL !== undefined || env.GIANT_KILLS !== undefined);
    if (TARGET_KEY === 'trooper' && !giantTrained) {
        await finish([], false, 'no combat progress: TARGET=trooper trains only, with TRAIN_SKILL and TARGET_LEVEL');
        return;
    }
    let giantMaximum: number | undefined;
    if (giantTrained) {
        try {
            giantMaximum = giantKillLimit(env.GIANT_KILLS);
        } catch (e) {
            await finish([], false, String(e));
            return;
        }
    }
    const giantSkill = env.TRAIN_SKILL ?? (giantMaximum === undefined ? undefined : 'Hitpoints');
    const giantLevel = env.TARGET_LEVEL === undefined ? (giantMaximum === undefined ? undefined : 99) : Number(env.TARGET_LEVEL);
    if (giantTrained) {
        try {
            giantTraining(giantSkill, giantLevel);
        } catch (e) {
            await finish([], false, String(e));
            return;
        }
    }
    if (giantTrained && (potionPolicy || maximum !== undefined || alch || telegrab)) {
        await finish([], false, 'surface giant training cannot use the generic combat loot options');
        return;
    }
    const cowStop = cowStopControl(
        TARGET_KEY,
        () => existsSync(resolve(import.meta.dir, '../../../../.practice', `stop-${botName}`)),
        giantTrained || !!potionPolicy || maximum !== undefined,
    );
    const ownedSession = await openBot(botName, cowStop.options).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        await ensureSurfaceGroundEntry(ownedSession, cowStop.stop);
    } catch (e) {
        await finishCombat(ownedSession, false, String(e));
        return;
    }
    if (giantTrained) {
        if (TARGET_KEY === 'trooper' && env.TROOPER_COOK === '1' && hooks?.stageTrooperFood) {
            try {
                const r = await hooks.stageTrooperFood(ownedSession, {
                    stop: cowStop.stop,
                    walk: async (x, z) => (await combatWalkTargetPersist(ownedSession, { x, z, level: 0 })).ok,
                });
                console.log(`TROOPER_FOOD ${JSON.stringify(r)}`);
            } catch (e) {
                await finishCombat(ownedSession, false, String(e));
                return;
            }
        }
        try {
            const r = await runGiants(ownedSession, {
                cap: CAP,
                site: TARGET_KEY === 'trooper' ? TROOPER_SITE : undefined,
                trainSkill: giantSkill,
                targetLevel: giantLevel,
                maximum: giantMaximum,
                food: env.GIANT_FOOD === undefined ? undefined : Number(env.GIANT_FOOD),
                ammo: env.GIANT_AMMO === undefined ? undefined : Number(env.GIANT_AMMO),
                ammoPickup: env.GIANT_AMMO_PICKUP !== '0',
                bury: env.GIANT_BURY === '1',
                stop: cowStop.stop,
            });
            console.log(`GIANT_RESULT ${JSON.stringify(r)}`);
            await finishCombat(
                ownedSession,
                r.ok && cowStop.reason() !== 'died',
                `mode=giant ${Object.entries(r)
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join(' ')}`,
            );
            return;
        } catch (e) {
            await finishCombat(ownedSession, false, String(e));
            return;
        }
    }
    const dungeonTravel = (TARGET_KEY === 'druid' || dungeonGiant) && !alch?.route ? createEdgevilleTravel(ownedSession) : targetConf.taverley && !alch?.route ? createTaverleyTravel() : undefined;
    const cleanupScope = (potionPolicy || maximum !== undefined) && TARGET_KEY !== 'cow' ? combatPotionSession(ownedSession, cowStop.stop, CAP) : undefined;
    const s = cleanupScope ?? ownedSession;
    if (TARGET_KEY === 'cow') {
        if (env.COW_STAGE === '1' && hooks?.stageCows) {
            try {
                const r = await hooks.stageCows(s, {
                    stop: cowStop.stop,
                    walk: async (x, z) => (await combatWalkTargetPersist(s, { x, z, level: 0 })).ok,
                });
                console.log(`COW_STAGE ${JSON.stringify(r)}`);
            } catch (e) {
                await finishCombat(s as Session, false, String(e));
                return;
            }
        }
        try {
            const r = await runCows(s, {
                cap: CAP,
                maximum: Number(env.MAX_KILLS ?? 5),
                trainSkill: env.TRAIN_SKILL,
                targetLevel: env.TARGET_LEVEL === undefined ? undefined : Number(env.TARGET_LEVEL),
                bankProfile: env.COW_BANK_PROFILE,
                foodMode: env.COW_FOOD_MODE,
                potions: potionPolicy,
                diagnostics: env.COW_DIAGNOSTICS === '1',
                stop: cowStop.stop,
            });
            console.log(`COW_RESULT ${JSON.stringify(r)}`);
            await finishCombat(
                s as Session,
                r.ok && cowStop.reason() !== 'died',
                `mode=cow ${Object.entries(r)
                    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join(' ')}`,
            );
            return;
        } catch (e) {
            await finishCombat(s as Session, false, String(e));
            return;
        }
    }

    const stopEnd = () => combatStopEnd(cowStop.reason());
    const stallWords = () => combatStallWords(cowStop.reason());
    const lifeDied = combatLifeWatch(ownedSession, cleanupScope);
    const runEnd = () => (lifeDied() ? 'died' : undefined) ?? stopEnd();
    const foodWant = combatFoodWanted(targetConf);
    // The survival check of each fight (admission.ts). A run that only picks up items, or takes them by Telekinetic
    // Grab, does not fight.
    const admissionGuard = targetConf.gatherOnly || effectiveTelegrab ? undefined : createCombatAdmissionGuard(s, TARGET_KEY, genericCombatNpcIds(TARGET_KEY));
    let justBanked = false;
    let combatRecovery: (() => Promise<string | undefined>) | undefined;
    try {
        const pos = () => s.sdk.getState()?.player;
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const maxHp = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
        const prayer = () => s.sdk.getSkill('Prayer')?.level ?? 0;
        const t0 = s.tick();
        const used = () => s.tick() - t0;
        let recoveringPotions = false;
        const over = () => used() >= (cleanupScope && !recoveringPotions ? CAP - 200 : CAP);
        const potions = potionPolicy ? createCombatPotions(s, potionPolicy, ['Attack', 'Strength', 'Defence', 'Hitpoints'], () => over() || cowStop.stop()) : undefined;
        const loot = createCombatLoot(
            s,
            effectiveTelegrab ? { ...effectiveTelegrab, stop: () => over() || cowStop.stop() } : undefined,
            alch ? { ...alch, stop: () => over() || cowStop.stop() } : undefined,
        );

        let kills = 0;
        let itemsLooted = 0;
        let bankTrips = 0;
        let walkTicks = 0;
        let capped = false;

        const counters = () => `kills=${kills} looted=${itemsLooted} bankTrips=${bankTrips} walkTicks=${walkTicks} hp=${hp()}`;
        const travelStop = () => over() || (!recoveringPotions && cowStop.stop());
        const ground = async (x: number, z: number, tol = 2): Promise<boolean> => {
            const a = s.tick();
            for (let i = 0; i < 3 && !travelStop(); i++) {
                const p = pos();
                if (p && p.level !== 0) throw Error(`combat travel aborted: level !== 0 (${p.level})`);
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                if (p && needsLongSurfaceWalk({ x: p.worldX, z: p.worldZ, level: p.level }, { x, z })) {
                    const longWalk = await combatWalkTargetPersist(s, { x, z, level: 0 }, 3, to => combatApproach(s, to, travelStop));
                    if (travelStop()) break;
                    const after = pos();
                    if (after && Math.max(Math.abs(after.worldX - x), Math.abs(after.worldZ - z)) <= tol) break;
                    if (!longWalk.ok) console.log(`LONG_WALK fail ${longWalk.detail ?? longWalk.reason ?? 'unknown'}`);
                }
                const r = await walkPath(await sessionWalker(s as Session), [{ x, z, tol }], { stop: travelStop, maxTicks: 500 });
                if (!r.ok) {
                    console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                    await waitTicks(s, 1);
                }
            }
            walkTicks += s.tick() - a;
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };

        const walk = async (x: number, z: number, tol = 2) =>
            dungeonTravel ? dungeonTravel.walk(s, TARGET_KEY as 'druid' | 'giant', { x, z, level: 0 }, ground, travelStop, tol) : ground(x, z, tol);

        const needsBankPrep = () => {
            const inv = s.sdk.getInventory();
            const worn = s.sdk.getState()?.equipment ?? [];
            if (targetConf.dragonShield && !worn.some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) return true;
            if (targetConf.dustyKey && !inv.some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) return true;
            if (targetConf.requireTelegrab) {
                const hasLaw = inv.some(i => i.id === 563);
                const hasAir = inv.some(i => i.id === 556) || worn.some(i => i.id === 1381 || i.id === 1397 || i.id === 1405);
                if (!hasLaw || !hasAir) return true;
            }
            return false;
        };

        // False when the tick cap stopped the walk to the bank (combatBankWalk): the loot stays in the pack.
        const bank = async (): Promise<boolean> => {
            if (!(await combatBankWalk(() => walk(conf.bankSpot.x, conf.bankSpot.z, 4), () => !recoveringPotions && over()))) {
                capped = true;
                return false;
            }
            await bankCombatLoot(s, conf.drops, [...(alch ? [995] : []), ...(potions?.depositIds ?? [])]);
            // An earlier job's items (a runecrafter's essence) otherwise fill the pack: combatPackFull.
            if (bankPack) await depositPack(s as Session, combatKit);

            if (targetConf.dragonShield && !(s.sdk.getState()?.equipment ?? []).some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) {
                if (!s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID)) {
                    await s.bot.withdrawItem(TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID, 1);
                    await waitTicks(s, 1);
                }
                const shield = s.sdk.getInventory().find(i => i.id === TAVERLEY_ROUTE.ANTI_DRAGON_SHIELD_ID);
                if (!shield) throw Error('Anti-dragon shield (1540) required');
                await s.bot.closeInterface();
                await s.bot.equipItem(shield);
                await waitTicks(s, 1);
                await s.bot.openBank();
                await waitTicks(s, 1);
            }
            if (targetConf.dustyKey && !s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) {
                await s.bot.withdrawItem(TAVERLEY_ROUTE.DUSTY_KEY_ID, 1);
                await waitTicks(s, 1);
                if (!s.sdk.getInventory().some(i => i.id === TAVERLEY_ROUTE.DUSTY_KEY_ID)) throw Error('Dusty key (1590) required');
            }
            if (targetConf.requireTelegrab) {
                if (countItems(s as Session, /^law rune$/i) < 10) await s.bot.withdrawItem(563, 25);
                const hasAirStaff = (s.sdk.getState()?.equipment ?? []).some(i => i.id === 1381 || i.id === 1397 || i.id === 1405);
                if (!hasAirStaff && countItems(s as Session, /^air rune$/i) < 10) await s.bot.withdrawItem(556, 25);
                await waitTicks(s, 1);
                const hasLaw = s.sdk.getInventory().some(i => i.id === 563);
                const hasAir = hasAirStaff || s.sdk.getInventory().some(i => i.id === 556);
                if (!hasLaw || !hasAir) throw Error('Law and Air runes required for Telekinetic Grab');
            }

            // A trip that leaves no food in the pack ends the run: the run does not fight with no food. The final bank
            // return of the potion cleanup takes no food, because the run ends there.
            const fed = foodWant === 0 || recoveringPotions || (await withdrawCombatFood(s, admissionGuard ? admissionGuard.foodWant(foodWant) : foodWant)) > 0;

            bankTrips++;
            justBanked = true;
            await s.bot.closeInterface();
            await waitTicks(s, 1);
            if (!fed) throw Error(combatPackFull(s.sdk.getInventory()) ?? combatNoFood(TARGET_KEY, foodWant));
            if (recoveringPotions && !(await walk(conf.bankSpot.x, conf.bankSpot.z, 2))) throw Error('combat final bank position unavailable');
            return true;
        };

        // A run at its eat level with no food, or one that cannot enter for its Prayer points, refuses before the
        // potion cleanup owns a bank return.
        const noFood0 = combatEntryNoFood(TARGET_KEY, hp(), maxHp(), combatFoodHeld(s.sdk.getInventory()), foodWant);
        if (noFood0) throw Error(noFood0);
        // A target that the account cannot survive at any food: refuse before the first walk.
        const unsafe0 = admissionGuard?.entry();
        if (unsafe0) throw Error(`${unsafe0} ticks=0`);
        const far0 = pos() && Math.max(Math.abs(pos()!.worldX - conf.spot.x), Math.abs(pos()!.worldZ - conf.spot.z)) > 15;
        const noPrayer0 = far0 ? combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'enter') : undefined;
        if (noPrayer0) throw Error(noPrayer0);
        if (cleanupScope) {
            combatRecovery = combatPotionRecovery(
                cleanupScope,
                () => !!potions?.blocked || loot.blocked,
                bank,
                active => {
                    recoveringPotions = active;
                },
                stopEnd,
            );
        }

        console.log(`START combat gatherer ${botName} target=${TARGET_KEY} at=${pos()?.worldX},${pos()?.worldZ}`);
        if (needsBankPrep()) await bank();
        else if (foodWant > 0 && combatFoodHeld(s.sdk.getInventory()) < foodWant && !cowStop.stop() && !lifeDied()) await bank();
        const untilInPack = () => untilId !== undefined && s.sdk.getInventory().some(i => i.id === untilId);
        const untilBanked = () => untilId !== undefined && (s.bankObservation?.()?.items ?? []).some((i: { id: number; count: number }) => i.id === untilId && i.count > 0);
        let untilDeposited = false;
        const bankUntil = async () => {
            const had = untilInPack();
            if ((await bank()) && had) untilDeposited = true;
        };

        let stuckWalks = 0;
        while (!over() && !lifeDied() && (!cleanupScope || !cowStop.stop())) {
            if (untilDeposited || untilInPack() || untilBanked()) break;
            if (potions) await potions.poll();
            const invSpace = 28 - s.sdk.getInventory().length;
            if (invSpace <= 1) {
                await bankUntil();
                const full = capped || untilDeposited ? undefined : combatPackFull(s.sdk.getInventory());
                if (full) throw Error(full);
                continue;
            }
            if (targetConf.requireTelegrab && needsBankPrep()) {
                const hadLoot = s.sdk.getInventory().some(i => conf.drops.test(i.name));
                try {
                    await bankUntil();
                } catch (e) {
                    if (hadLoot || itemsLooted > 0) break;
                    throw e;
                }
                continue;
            }
            // No food left: the bank trip takes more food, or ends the run with `no food`.
            if (foodWant > 0 && combatFoodHeld(s.sdk.getInventory()) === 0) {
                await bankUntil();
                continue;
            }
            const p = pos();
            if (!p) {
                await waitTicks(s, 1);
                continue;
            }
            if (Math.max(Math.abs(p.worldX - conf.spot.x), Math.abs(p.worldZ - conf.spot.z)) > 15) {
                const noPrayer = combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'enter');
                if (noPrayer) throw Error(noPrayer);
                if (await walk(conf.spot.x, conf.spot.z, 4)) stuckWalks = 0;
                else {
                    stuckWalks++;
                    if (stuckWalks >= 3) throw Error(`combat travel blocked at ${p.worldX},${p.worldZ},${p.level}`);
                }
                continue;
            }
            stuckWalks = 0;
            if (combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'leave')) {
                await bankUntil();
                continue;
            }
            if (invSpace > 0) {
                const candidate =
                    effectiveTelegrab || alch ? s.sdk.getState()?.groundItems.filter(i => conf.drops.test(i.name)).sort((a, b) => a.distance - b.distance)[0] : undefined;
                const r = effectiveTelegrab || alch ? (candidate ? await loot.pickup(candidate) : { success: false }) : await s.bot.pickupItem(conf.drops);
                if (r.success) {
                    itemsLooted++;
                    if (alch && itemsLooted >= alch.maximum) break;
                    if (targetConf.gatherOnly && maximum !== undefined && itemsLooted >= maximum) {
                        await bankUntil();
                        break;
                    }
                    await waitTicks(s, 1);
                    if (untilInPack()) break;
                    continue;
                }
            }
            if (targetConf.gatherOnly) {
                if (maximum !== undefined && itemsLooted >= maximum) {
                    if (s.sdk.getInventory().some(i => conf.drops.test(i.name))) await bankUntil();
                    break;
                }
                await waitTicks(s, 2);
                continue;
            }
            if (maximum !== undefined && kills >= maximum) break;

            const selfSlot = (s.client as { selfSlot?: number }).selfSlot;
            const monster = genericCombatNpc(TARGET_KEY, s.sdk.getState()?.nearbyNpcs ?? [], selfSlot);
            if (!monster) {
                await waitTicks(s, 2);
                continue;
            }
            const admit = admissionGuard?.beforeAttack(justBanked, monster);
            if (admit?.kind === 'refuse') throw Error(admit.detail);
            if (admit?.kind === 'bank') {
                await bankUntil();
                continue;
            }
            justBanked = false;
            let leaveFight = false;
            const a = await s.bot.attack(monster);
            if (a.success) {
                const began = s.tick();
                let engaged = false;
                let idleTicks = 0;
                let dead = false;
                while (!over() && !cowStop.stop() && !lifeDied() && s.tick() - began < 100) {
                    const st = s.sdk.getState();
                    const npc = st?.nearbyNpcs.find(n => n.index === monster.index);
                    if (npc && ((st?.player?.combat?.targetType === 'npc' && st.player.combat.targetIndex === monster.index) || npc.inCombat)) engaged = true;
                    const outcome = combatTargetFinished(st, monster.index, selfSlot, idleTicks);
                    if (outcome.done) {
                        dead = outcome.dead;
                        break;
                    }
                    // Out of food at the eat level, or out of Prayer points: the run leaves the fight for the bank.
                    if (
                        (foodWant > 0 && combatOutOfFood(hp(), maxHp(), combatFoodHeld(s.sdk.getInventory())))
                        || combatPrayerShort(TARGET_KEY, prayer(), targetConf.prayer, 'leave')
                    ) {
                        break;
                    }
                    const active = !!st?.player?.combat?.inCombat || !!npc?.inCombat;
                    if (active) idleTicks = 0;
                    else if (engaged || (npc?.distance ?? 99) <= 2 || s.tick() - began >= 15) idleTicks++;
                    if (potions && st?.player?.combat.targetType === 'npc' && st.player.combat.targetIndex === monster.index) await potions.poll(monster);
                    // The retreat line and the crowd rule (admission.ts): leave the fight for the bank.
                    const danger = admissionGuard?.tick(s.tick());
                    if (danger) {
                        const end = admissionGuard!.left(danger);
                        if (end) throw Error(end);
                        leaveFight = true;
                        break;
                    }
                    await waitTicks(s, 1);
                }
                if (dead) {
                    kills++;
                    await waitTicks(s, 1);
                }
                if (leaveFight) await bankUntil();
            } else {
                await waitTicks(s, 2);
            }
        }

        if (untilInPack()) untilDeposited = true;
        if (combatRecovery && (!targetConf.gatherOnly || potions || alch || s.sdk.getInventory().some(i => conf.drops.test(i.name)))) await combatRecovery();
        if (potions) {
            console.log('COMBAT_POTIONS_RESULT ' + JSON.stringify({ doses: potions.doses, delta: potions.delta, receipts: potions.receipts, blocked: potions.blocked, resumes: potions.resumes }));
        }
        const end = runEnd();
        if (end) {
            await finishCombat(ownedSession, false, `ticks=${used()} ${counters()} maximum=${maximum ?? '-'} ${end}=true${stallWords()}`);
            return;
        }
        if (alch) {
            if (!cleanupScope) await bank();
            if (s.sdk.getInventory().some(i => i.id === 995 || conf.drops.test(i.name))) throw Error('owned alchemy bank return unconfirmed');
            console.log(
                'COMBAT_ALCH_RESULT '
                    + JSON.stringify({
                        casts: loot.alch!.casts,
                        coins: loot.alch!.coins,
                        consumed: loot.alch!.consumed,
                        runes: loot.alch!.runes,
                        receipts: loot.alch!.receipts,
                        blocked: loot.alch!.blocked,
                        itemsLooted,
                        bankTrips,
                        scope: 'exact owned pickup and native alchemy; generic loot does not assert kill attribution',
                    }),
            );
        }
        let untilHeld: boolean | undefined;
        if (untilItem) {
            if (untilInPack()) await bankUntil();
            if (untilInPack()) throw Error('UNTIL_ITEM bank return unconfirmed');
            untilHeld = untilDeposited || untilBanked();
        }
        const total = kills + itemsLooted;
        const perK = ((total * 1000) / Math.max(1, used())).toFixed(2);
        const targetMet = untilItem
            ? !!untilHeld
            : maximum === undefined || ((targetConf.gatherOnly ? itemsLooted === maximum : kills === maximum) && !cowStop.stop());
        const ok = total > 0 && targetMet;
        await finishCombat(
            ownedSession,
            ok,
            `ticks=${used()} ${counters()} actionsPer1kTicks=${perK} targetMet=${targetMet} maximum=${maximum ?? '-'}${untilItem ? ` until=${env.UNTIL_ITEM} held=${untilHeld}` : ''}${capped ? ' capped=true' : ''}${ok ? '' : stallWords()}`,
        );
    } catch (e) {
        let detail = combatFailDetail(e);
        if (combatRecovery) {
            try {
                await combatRecovery();
            } catch (recovery) {
                detail += '; cleanup ' + String(recovery);
            }
        }
        const end = runEnd();
        await finishCombat(ownedSession, false, `${end ? `${detail} ${end}=true` : detail}${stallWords()}`);
    }
}
