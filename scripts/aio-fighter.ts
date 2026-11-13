// AIO Fighter ("Auto Fighter"): unified entry for general monster combat, melee/ranged training, and drop farming.
// Usage:
//   bun scripts/aio-fighter.ts <account> <target> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import {parseStep,type Step} from '../packages/core/src/chain-step';
import {cowProfile,cowRoutePoints,guardCowWalker,bankCombatLoot,genericCombatNpc} from './gather-combat';
import {chickenTrainingKit,chickenTrainingStyle,chickenTrainingProfile,chickenCombatUnlockPlan} from './train-chickens';
import {combatPotionPolicy,createCombatPotions,combatPotionSession,combatPotionRecovery} from './microbot-combat-potions';
import {createPotionCareSession,potionCareRecipe,validatePotionCare,runPotionCare,type PotionCareOrder,type PotionCarePolicy} from './microbot-potion-care';
import {combatAlchPolicy} from './microbot-combat-alch';
import {createCombatLoot,telegrabPolicy} from './microbot-telegrab';
import {totalAvailableHeal,defaultEatAt} from '../packages/core/src/sustain';
import {refillCannon,holdPrayer,enableSpecial,qolDropSelection,type QolDropOrder} from './microbot-c-qol';

export {
 cowProfile,cowRoutePoints,guardCowWalker,bankCombatLoot,genericCombatNpc,
 chickenTrainingKit,chickenTrainingStyle,chickenTrainingProfile,chickenCombatUnlockPlan,
 combatPotionPolicy,createCombatPotions,combatPotionSession,combatPotionRecovery,
 createPotionCareSession,potionCareRecipe,validatePotionCare,runPotionCare,type PotionCareOrder,type PotionCarePolicy,
 combatAlchPolicy,createCombatLoot,telegrabPolicy,
 refillCannon,holdPrayer,enableSpecial,qolDropSelection,type QolDropOrder,
 totalAvailableHeal,defaultEatAt,
};

export interface CombatLevels {
 Attack: number;
 Strength: number;
 Defence: number;
 Hitpoints: number;
 Ranged?: number;
 Magic?: number;
 Prayer?: number;
}

// Auto-select the next melee training band (target NPC, skill to train, target level, and step) for an account.
// Follows the PK-army progression rule: chickens to Hitpoints 15 / melee 20, Ardougne cows to 40/40/40 (Strength -> Attack -> Defence), then hill/fire giants.
export function planAutoFighterBand(levels: CombatLevels, bank: 'draynor' | 'varrock' | 'ardougne' = 'draynor'): {
 target: string;
 trainSkill: 'Strength' | 'Attack' | 'Defence';
 targetLevel: number;
 eatAt: number;
 step: Step;
} {
 const { Attack, Strength, Defence, Hitpoints } = levels;
 if ([Attack, Strength, Defence, Hitpoints].some(n => !Number.isSafeInteger(n) || n < 1 || n > 99)) {
  throw Error('aio-fighter: invalid combat levels');
 }
 // Keep Strength ahead for max-hit breakpoints, then Attack, then Defence.
 const pickSkill = (cap: number): { skill: 'Strength' | 'Attack' | 'Defence'; goal: number } => {
  if (Strength < cap) return { skill: 'Strength', goal: cap };
  if (Attack < cap) return { skill: 'Attack', goal: cap };
  return { skill: 'Defence', goal: cap };
 };
 const eatAt = defaultEatAt(Hitpoints);
 if (Hitpoints < 15 || Math.min(Attack, Strength, Defence) < 15) {
  const { skill, goal } = pickSkill(20);
  return {
   target: 'chicken',
   trainSkill: skill,
   targetLevel: goal,
   eatAt,
   step: resolveFighterStep('chicken', [`TRAIN_BANK=${bank}`, `TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`, 'CAP=3000']),
  };
 }
 if (Math.min(Attack, Strength, Defence) < 40) {
  const { skill, goal } = pickSkill(40);
  return {
   target: 'cow',
   trainSkill: skill,
   targetLevel: goal,
   eatAt,
   step: resolveFighterStep('cow', [`TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`, 'CAP=3000']),
  };
 }
 const nextCap = Math.min(99, Math.floor(Math.min(Attack, Strength, Defence) / 10) * 10 + 10);
 const { skill, goal } = pickSkill(nextCap);
 return {
  target: 'giant',
  trainSkill: skill,
  targetLevel: goal,
  eatAt,
  step: resolveFighterStep('giant', ['6000', 'giant', `TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`]),
 };
}

export interface FighterProfileSpec {
 target: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const FIGHTER_PROFILES: readonly FighterProfileSpec[] = [
 {target:'chicken',script:'scripts/train-chickens.ts',defaultEnv:{TRAIN_BANK:'draynor',TRAIN_SKILL:'Strength',TARGET_LEVEL:'30',CAP:'3000'},description:'Train melee or CombatUnlock on Lumbridge/Ardougne chickens and return kit to bank'},
 {target:'cow',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'cow',CAP:'3000',TRAIN_SKILL:'Defence',TARGET_LEVEL:'40'},description:'Fight Ardougne cows (north/south profile) for melee levels and cowhides/beef'},
 {target:'druid',script:'scripts/gather-combat.ts',defaultArgs:['6000','druid'],defaultEnv:{TARGET:'druid'},description:'Fight Chaos Druids and bank herbs, law/nature/air runes, and vials'},
 {target:'giant',script:'scripts/gather-combat.ts',defaultArgs:['6000','giant'],defaultEnv:{TARGET:'giant'},description:'Fight Hill Giants in Edgeville dungeon for melee XP, big bones, and limpwurt roots'},
 {target:'fire-giant',script:'scripts/gather-fire-giants.ts',description:'Fight Fire Giants (Baxtorian Falls / Waterfall) with food/potion sustain and loot banking'},
 {target:'fire-combat',script:'scripts/gather-fire-combat.ts',description:'Fire Giant combat training trip with safespot/melee options'},
 {target:'imp',script:'scripts/gather-imps.ts',description:'Hunt imps and bank beads (red/yellow/black/white) for Imp Catcher'},
 {target:'shade',script:'scripts/microbot-shade-trip.ts',description:'Fight Loar/Phrin/Riyl shades in Mort\'ton and bank shade remains'},
 {target:'chompy',script:'scripts/microbot-chompy-trip.ts',description:'Full Chompy bird hunting trip with bellows, frogs, ogre bow, and protection prayer'},
 {target:'chompy-at-site',script:'scripts/microbot-a-chompy.ts',description:'At-site Chompy bird hunting'},
 {target:'ranged',script:'scripts/ranged-train.ts',description:'Train Ranged with progressive bows/arrows to target level'},
 {target:'ranged-starter',script:'scripts/ranged-starter.ts',description:'Fresh-account Ranged starter bootstrap'},
 {target:'ranged-gather',script:'scripts/gather-ranged.ts',description:'Safespot Ranged monster farming with arrow recovery'},
 {target:'ranged-camp',script:'scripts/microbot-a-ranged-camp.ts',description:'Safespot Ranged camp with optional telegrab/loot'},
 {target:'cannon',script:'scripts/cannon-fight.ts',defaultEnv:{SPOT:'spiders'},description:'Dwarf multicannon at a multiway spot (CANNON_SPOTS), kept loaded, while fighting beside it with the worn bow or weapon; picks up nothing'},
 {target:'loot-trip',script:'scripts/microbot-loot-trip.ts',description:'Dedicated ground-item loot and bank trip'},
];

export function resolveFighterStep(targetInput: string, rest: readonly string[] = []): Step {
 const target = targetInput.toLowerCase().replace(/^--target=/, '');
 const profile = FIGHTER_PROFILES.find(p => p.target === target);
 if (!profile) {
  throw Error(`aio-fighter: unknown target "${target}"; known: ${FIGHTER_PROFILES.map(p => p.target).join(', ')}`);
 }
 const tokens = rest.length ? rest : [...(profile.defaultArgs ?? [])];
 const step = parseStep([profile.script, ...tokens].join(' '));
 return { script: step.script, args: step.args, env: { ...(profile.defaultEnv ?? {}), ...step.env } };
}

export async function runAioFighter(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-fighter requires account');
 const [target, ...rest] = args;
 if (!target) throw Error('aio-fighter requires <target>');
 const step = resolveFighterStep(target, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
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
 const result = await runAioFighter(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
