// AIO Fighter ("Auto Fighter"): unified CLI dispatcher & compatibility shim over packages/workers/src/combat/.
// Usage:
//   bun scripts/aio-fighter.ts <account> <target> [arg ...] [KEY=value ...]
import { createRequire } from 'node:module';
import type { Step } from '../packages/core/src/chain-step';
import { resolveRouteStep } from '../packages/core/src/route-step';
import { runDirectChild } from '../packages/core/src/run-child';
import { defaultEatAt, totalAvailableHeal } from '../packages/core/src/sustain';
import type { CombatLevels, FighterProfileSpec } from '../packages/workers/src/combat/types';
import type { QolDropOrder } from '../packages/workers/src/bank-artisan/foraging-qol';
import type { PotionCareOrder, PotionCarePolicy } from './microbot-potion-care';

const require = createRequire(import.meta.url);
type MeleeGatherMod = typeof import('../packages/workers/src/combat/melee-gather');
type ChickensMod = typeof import('../packages/workers/src/combat/chickens');
type SurvMod = typeof import('../packages/workers/src/combat/survivability');
type QolMod = typeof import('../packages/workers/src/bank-artisan/foraging-qol');
type PotionCareMod = typeof import('./microbot-potion-care');
let meleeMod: MeleeGatherMod | undefined;
let chickensMod: ChickensMod | undefined;
let survMod: SurvMod | undefined;
let qolMod: QolMod | undefined;
let potionMod: PotionCareMod | undefined;
const getMelee = () => (meleeMod ??= require('../packages/workers/src/combat/melee-gather') as MeleeGatherMod);
const getChickens = () => (chickensMod ??= require('../packages/workers/src/combat/chickens') as ChickensMod);
const getSurv = () => (survMod ??= require('../packages/workers/src/combat/survivability') as SurvMod);
const getQol = () => (qolMod ??= require('../packages/workers/src/bank-artisan/foraging-qol') as QolMod);
const getPotion = () => (potionMod ??= require('./microbot-potion-care') as PotionCareMod);

export const bankCombatLoot: MeleeGatherMod['bankCombatLoot'] = (...a) => getMelee().bankCombatLoot(...a);
export const cowProfile: MeleeGatherMod['cowProfile'] = (...a) => getMelee().cowProfile(...a);
export const cowRoutePoints: MeleeGatherMod['cowRoutePoints'] = (...a) => getMelee().cowRoutePoints(...a);
export const genericCombatNpc: MeleeGatherMod['genericCombatNpc'] = (...a) => getMelee().genericCombatNpc(...a);
export const guardCowWalker: MeleeGatherMod['guardCowWalker'] = (...a) => getMelee().guardCowWalker(...a);
export const chickenCombatUnlockPlan: ChickensMod['chickenCombatUnlockPlan'] = (...a) => getChickens().chickenCombatUnlockPlan(...a);
export const chickenTrainingKit: ChickensMod['chickenTrainingKit'] = (...a) => getChickens().chickenTrainingKit(...a);
export const chickenTrainingProfile: ChickensMod['chickenTrainingProfile'] = (...a) => getChickens().chickenTrainingProfile(...a);
export const chickenTrainingStyle: ChickensMod['chickenTrainingStyle'] = (...a) => getChickens().chickenTrainingStyle(...a);
export const combatAlchPolicy: SurvMod['combatAlchPolicy'] = (...a) => getSurv().combatAlchPolicy(...a);
export const combatPotionPolicy: SurvMod['combatPotionPolicy'] = (...a) => getSurv().combatPotionPolicy(...a);
export const combatPotionRecovery: SurvMod['combatPotionRecovery'] = (...a) => getSurv().combatPotionRecovery(...a);
export const combatPotionSession: SurvMod['combatPotionSession'] = (...a) => getSurv().combatPotionSession(...a);
export const createCombatLoot: SurvMod['createCombatLoot'] = (...a) => getSurv().createCombatLoot(...a);
export const createCombatPotions: SurvMod['createCombatPotions'] = (...a) => getSurv().createCombatPotions(...a);
export const telegrabPolicy: SurvMod['telegrabPolicy'] = (...a) => getSurv().telegrabPolicy(...a);
export const enableSpecial: QolMod['enableSpecial'] = (...a) => getQol().enableSpecial(...a);
export const holdPrayer: QolMod['holdPrayer'] = (...a) => getQol().holdPrayer(...a);
export const qolDropSelection: QolMod['qolDropSelection'] = (...a) => getQol().qolDropSelection(...a);
export const refillCannon: QolMod['refillCannon'] = (...a) => getQol().refillCannon(...a);
export const createPotionCareSession: PotionCareMod['createPotionCareSession'] = (...a) => getPotion().createPotionCareSession(...a);
export const potionCareRecipe: PotionCareMod['potionCareRecipe'] = (...a) => getPotion().potionCareRecipe(...a);
export const runPotionCare: PotionCareMod['runPotionCare'] = (...a) => getPotion().runPotionCare(...a);
export const validatePotionCare: PotionCareMod['validatePotionCare'] = (...a) => getPotion().validatePotionCare(...a);

export const FIGHTER_PROFILES: readonly FighterProfileSpec[] = [
    {
        target: 'chicken',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TRAIN_BANK: 'draynor', TRAIN_SKILL: 'Strength', TARGET_LEVEL: '30', CAP: '3000' },
        description: 'Train melee or CombatUnlock on Lumbridge/Ardougne chickens and return kit to bank',
    },
    {
        target: 'cow',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'cow', CAP: '3000', TRAIN_SKILL: 'Defence', TARGET_LEVEL: '40' },
        description: 'Fight Ardougne cows (north/south profile) for melee levels and cowhides/beef',
    },
    {
        target: 'druid',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'druid', CAP: '6000' },
        description: 'Fight Chaos Druids and bank herbs, law/nature/air runes, and vials',
    },
    {
        target: 'unicorn',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'unicorn', CAP: '1500', MAX_KILLS: '10' },
        description: 'Kill the unicorns south of Edgeville and bank each unicorn horn, the second input of an antipoison',
    },
    {
        target: 'wizard',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'wizard', CAP: '10000', MAX_KILLS: '200', UNTIL_ITEM: 'water talisman' },
        description: 'Kill the wizards at the Wizards\' Tower until a water talisman drops, then bank it at Draynor',
    },
    {
        target: 'giant',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'giant', CAP: '6000' },
        description: 'Fight Hill Giants in Edgeville dungeon for melee XP, big bones, and limpwurt roots',
    },
    {
        target: 'trooper',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { TARGET: 'trooper', CAP: '1500', TRAIN_SKILL: 'Strength', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' },
        description: 'Train melee, Ranged or Hitpoints on Khazard troopers with bank staging, food and bone burial',
    },
    {
        target: 'fire-giant',
        script: 'scripts/aio-fighter.ts',
        description: 'Fight Fire Giants (Baxtorian Falls / Waterfall) with food/potion sustain and loot banking',
    },
    {
        target: 'fire-combat',
        script: 'scripts/aio-fighter.ts',
        description: 'Fire Giant combat training trip with safespot/melee options',
    },
    {
        target: 'imp',
        script: 'scripts/aio-fighter.ts',
        description: 'Hunt imps and bank beads (red/yellow/black/white) for Imp Catcher',
    },
    {
        target: 'shade',
        script: 'scripts/aio-fighter.ts',
        description: 'Fight Loar/Phrin/Riyl shades in Mort\'ton and bank shade remains',
    },
    {
        target: 'chompy',
        script: 'scripts/aio-fighter.ts',
        description: 'Full Chompy bird hunting trip with bellows, frogs, ogre bow, and protection prayer',
    },
    {
        target: 'chompy-at-site',
        script: 'scripts/aio-fighter.ts',
        description: 'At-site Chompy bird hunting',
    },
    {
        target: 'ranged',
        script: 'scripts/aio-fighter.ts',
        description: 'Train Ranged with progressive bows/arrows to target level',
    },
    {
        target: 'ranged-starter',
        script: 'scripts/aio-fighter.ts',
        description: 'Fresh-account Ranged starter bootstrap',
    },
    {
        target: 'ranged-gather',
        script: 'scripts/aio-fighter.ts',
        description: 'Safespot Ranged monster farming with arrow recovery',
    },
    {
        target: 'ranged-camp',
        script: 'scripts/aio-fighter.ts',
        description: 'Safespot Ranged camp with optional telegrab/loot',
    },
    {
        target: 'cannon',
        script: 'scripts/aio-fighter.ts',
        defaultEnv: { SPOT: 'spiders' },
        description: 'Dwarf multicannon at a multiway spot (CANNON_SPOTS), kept loaded, while fighting beside it with the worn bow or weapon; picks up nothing',
    },
    {
        target: 'ranged-specialist',
        script: 'scripts/ranged-specialist.ts',
        description: 'Run the fresh-clock Ranged 99 specialist route from Tutorial Island through Dwarf Cannon and Poison Spiders',
    },
    {
        target: 'loot-trip',
        script: 'scripts/aio-fighter.ts',
        description: 'Dedicated ground-item loot and bank trip',
    },
    {
        target: 'attack-specialist',
        script: 'scripts/attack-specialist.ts',
        description: 'Run the fresh-clock Attack 99 specialist route from Tutorial Island through Tree Gnome Village, Grand Tree, and Fight Arena',
    },
    {
        target: 'specialist-hp',
        script: 'scripts/hp-specialist.ts',
        description: 'Fresh-clock Hitpoints 99 quest-XP specialist',
    },
    {
        target: 'specialist-strength',
        script: 'scripts/strength-specialist.ts',
        description: 'Fresh-clock Strength 99 quest-XP and Wildy PvP specialist',
    },
    {
        target: 'specialist-defence',
        script: 'scripts/defence-specialist.ts',
        description: 'Fresh-clock Defence 99 quest-XP and Wildy PvP specialist',
    },
];

export function resolveFighterStep(targetInput: string, rest: readonly string[] = []): Step {
    const target = targetInput.toLowerCase().replace(/^--target=/, '');
    const profile = FIGHTER_PROFILES.find(p => p.target === target);
    if (!profile) {
        throw Error(`aio-fighter: unknown target "${target}"; known: ${FIGHTER_PROFILES.map(p => p.target).join(', ')}`);
    }
    const step = resolveRouteStep(profile, rest);
    if (profile.script === 'scripts/aio-fighter.ts') {
        return { ...step, args: [profile.target, ...step.args] };
    }
    return step;
}

export function planAuthoredFighterBand(
    levels: CombatLevels,
    _bank: 'draynor' | 'varrock' | 'ardougne' = 'draynor',
): {
    target: string;
    trainSkill: 'Strength' | 'Attack' | 'Defence' | 'Hitpoints';
    targetLevel: number;
    eatAt: number;
    step: Step;
} {
    const { Attack, Strength, Defence, Hitpoints } = levels;
    if ([Attack, Strength, Defence, Hitpoints].some(n => !Number.isSafeInteger(n) || n < 1 || n > 99)) {
        throw Error('aio-fighter: invalid combat levels');
    }
    const pickSkill = (cap: number): { skill: 'Strength' | 'Attack' | 'Defence'; goal: number } => {
        if (Strength < cap) return { skill: 'Strength', goal: cap };
        if (Attack < cap) return { skill: 'Attack', goal: cap };
        return { skill: 'Defence', goal: cap };
    };
    const eatAt = defaultEatAt(Hitpoints);
    const melee = Math.min(Attack, Strength, Defence);
    if (melee < 60) {
        const { skill, goal } = pickSkill(melee < 40 ? 40 : 60);
        return {
            target: 'cow',
            trainSkill: skill,
            targetLevel: goal,
            eatAt,
            step: resolveFighterStep('cow', [
                `TRAIN_SKILL=${skill}`,
                `TARGET_LEVEL=${goal}`,
                'COW_BANK_PROFILE=north',
                'COW_STAGE=1',
                'MAX_KILLS=8',
                'CAP=3000',
            ]),
        };
    }
    if (melee === 99 && Hitpoints === 99) throw Error('aio-fighter: melee and Hitpoints goals complete');
    const { skill, goal } =
        melee === 99 ? { skill: 'Hitpoints' as const, goal: 99 } : pickSkill(Math.min(99, Math.floor(melee / 10) * 10 + 10));
    return {
        target: 'trooper',
        trainSkill: skill,
        targetLevel: goal,
        eatAt,
        step: resolveFighterStep('trooper', [`TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`]),
    };
}

export function planAutoFighterBand(
    levels: CombatLevels,
    bank: 'draynor' | 'varrock' | 'ardougne' = 'draynor',
    _unused?: unknown,
) {
    const authored = planAuthoredFighterBand(levels, bank);
    return {
        ...authored,
        progression: null,
        reason: 'authored combat band',
    };
}

export {
    defaultEatAt,
    totalAvailableHeal,
    type CombatLevels,
    type FighterProfileSpec,
    type PotionCareOrder,
    type PotionCarePolicy,
    type QolDropOrder,
};

function mergeCombatEnv(stepEnv: Record<string, string>, baseEnv: Record<string, string | undefined>, rawArgs: readonly string[]) {
    const cli: Record<string, string> = {};
    for (const arg of rawArgs) {
        const eq = arg.indexOf('=');
        if (eq > 0 && /^[A-Z0-9_]+$/.test(arg.slice(0, eq))) cli[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    const definedBase: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) definedBase[k] = v;
    return {
        ...stepEnv,
        ...definedBase,
        ...(stepEnv.TARGET ? { TARGET: stepEnv.TARGET } : {}),
        ...cli,
    };
}

export async function runAioFighter(
    account: string,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
    _progressionOrRun?: unknown,
    maybeRun: (args: string[], env: Record<string, string | undefined>) => Promise<string> = runDirectChild,
): Promise<string> {
    if (!account) throw Error('aio-fighter requires account');
    const [target, ...rest] = args;
    if (!target) throw Error('aio-fighter requires <target>');
    const run =
        typeof _progressionOrRun === 'function'
            ? (_progressionOrRun as (args: string[], env: Record<string, string | undefined>) => Promise<string>)
            : maybeRun;
    const step = resolveFighterStep(target, rest);
    return run([step.script, account, ...step.args], mergeCombatEnv(step.env, env, rest));
}

if (import.meta.main) {
    const [account, ...rest] = process.argv.slice(2);
    if (account === '--list') {
        console.log(JSON.stringify(FIGHTER_PROFILES, null, 2));
        process.exit(0);
    }
    if (!account || !rest.length) {
        console.log('RESULT fail usage: bun scripts/aio-fighter.ts <account> <target> [args...] [KEY=value...]');
        process.exit(2);
    }
    const [target, ...args] = rest;
    const step = resolveFighterStep(target!, args);
    const mergedEnv = mergeCombatEnv(step.env, process.env, args);
    if (step.script === 'scripts/aio-fighter.ts') {
        const mode = step.args[0] ?? target!;
        const { runCombatModeCli } = await import('../packages/workers/src/combat/module');
        const rangedDeps = mode.startsWith('ranged') ? (await import('./ranged-train')).RANGED_ADAPTIVE_DEPS : {};
        await runCombatModeCli(account, mode, step.args.slice(1), mergedEnv, {
            stageTrooperFood: async (...a) => (await import('./trooper-food')).stageTrooperFood(...a),
            stageCows: async (...a) => (await import('./cow-stage')).stageCows(...a),
            leaveStarter: async (...a) => (await import('./rune-starter')).leaveRuneStarter(...a),
            ...rangedDeps,
        });
        process.exit(process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 0);
    }
    const result = await runDirectChild([step.script, account, ...step.args], mergedEnv);
    process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
