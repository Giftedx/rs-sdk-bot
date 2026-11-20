// AIO Fighter ("Auto Fighter"): unified entry for general monster combat, melee/ranged training, and drop farming.
// Usage:
//   bun scripts/aio-fighter.ts <account> <target> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {resolveRouteStep} from './aio-route-step';
import {cowProfile,cowRoutePoints,guardCowWalker,bankCombatLoot,genericCombatNpc} from './gather-combat';
import {chickenTrainingKit,chickenTrainingStyle,chickenTrainingProfile,chickenCombatUnlockPlan} from './train-chickens';
import {combatPotionPolicy,createCombatPotions,combatPotionSession,combatPotionRecovery} from './microbot-combat-potions';
import {createPotionCareSession,potionCareRecipe,validatePotionCare,runPotionCare,type PotionCareOrder,type PotionCarePolicy} from './microbot-potion-care';
import {combatAlchPolicy} from './microbot-combat-alch';
import {createCombatLoot,telegrabPolicy} from './microbot-telegrab';
import {totalAvailableHeal,defaultEatAt} from '../packages/core/src/sustain';
import {refillCannon,holdPrayer,enableSpecial,qolDropSelection,type QolDropOrder} from './microbot-c-qol';
import {selectAioProgression,type AioProgressionContext} from './aio-progression';

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
// Cows stage the owned kit from any start, including fresh accounts; the army's faster
// Khazard trooper method opens at melee 60. Hitpoints can still need work after all melee skills reach 99.
function planAuthoredFighterBand(levels: CombatLevels, bank: 'draynor' | 'varrock' | 'ardougne' = 'draynor'): {
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
 // Keep Strength ahead for max-hit breakpoints, then Attack, then Defence.
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
   step: resolveFighterStep('cow', [`TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`, 'COW_BANK_PROFILE=north', 'COW_STAGE=1', 'MAX_KILLS=8', 'CAP=3000']),
  };
 }
 if (melee === 99 && Hitpoints === 99) throw Error('aio-fighter: melee and Hitpoints goals complete');
 const { skill, goal } = melee === 99 ? {skill: 'Hitpoints' as const, goal: 99} : pickSkill(Math.min(99, Math.floor(melee / 10) * 10 + 10));
 return {
  target: 'trooper',
  trainSkill: skill,
  targetLevel: goal,
  eatAt,
  step: resolveFighterStep('trooper', [`TRAIN_SKILL=${skill}`, `TARGET_LEVEL=${goal}`]),
 };
}

export function planAutoFighterBand(levels:CombatLevels,bank:'draynor'|'varrock'|'ardougne'='draynor',progression?:AioProgressionContext){
 const authored=planAuthoredFighterBand(levels,bank);
 const account=typeof progression?.status?.name==='string'?progression.status.name:'Fighter';
 const choice=selectAioProgression(account,authored.step,{},progression,false);
 if(!choice.step)throw Error('aio-fighter: '+choice.reason);
 return{...authored,step:choice.step,progression:choice.decision,reason:choice.reason};
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
 {target:'druid',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'druid',CAP:'6000'},description:'Fight Chaos Druids and bank herbs, law/nature/air runes, and vials'},
 {target:'unicorn',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'unicorn',CAP:'1500',MAX_KILLS:'10'},description:'Kill the unicorns south of Edgeville and bank each unicorn horn, the second input of an antipoison'},
 {target:'wizard',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'wizard',CAP:'10000',MAX_KILLS:'200',UNTIL_ITEM:'water talisman'},description:'Kill the wizards at the Wizards\' Tower until a water talisman drops, then bank it at Draynor'},
 {target:'giant',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'giant',CAP:'6000'},description:'Fight Hill Giants in Edgeville dungeon for melee XP, big bones, and limpwurt roots'},
 {target:'trooper',script:'scripts/gather-combat.ts',defaultEnv:{TARGET:'trooper',CAP:'1500',TRAIN_SKILL:'Strength',TARGET_LEVEL:'99',GIANT_FOOD:'20',GIANT_BURY:'1',TROOPER_COOK:'1'},description:'Train melee, Ranged or Hitpoints on Khazard troopers with bank staging, food and bone burial'},
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
 {target:'ranged-specialist',script:'scripts/ranged-specialist.ts',description:'Run the fresh-clock Ranged 99 specialist route from Tutorial Island through Dwarf Cannon and Poison Spiders'},
 {target:'loot-trip',script:'scripts/microbot-loot-trip.ts',description:'Dedicated ground-item loot and bank trip'},
 {target:'attack-specialist',script:'scripts/attack-specialist.ts',description:'Run the fresh-clock Attack 99 specialist route from Tutorial Island through Tree Gnome Village, Grand Tree, and Fight Arena'},
 {target:'specialist-hp',script:'scripts/hp-specialist.ts',description:'Fresh-clock Hitpoints 99 quest-XP specialist'},
 {target:'specialist-strength',script:'scripts/strength-specialist.ts',description:'Fresh-clock Strength 99 quest-XP and Wildy PvP specialist'},
 {target:'specialist-defence',script:'scripts/defence-specialist.ts',description:'Fresh-clock Defence 99 quest-XP and Wildy PvP specialist'},
];

export function resolveFighterStep(targetInput: string, rest: readonly string[] = []): Step {
 const target = targetInput.toLowerCase().replace(/^--target=/, '');
 const profile = FIGHTER_PROFILES.find(p => p.target === target);
 if (!profile) {
  throw Error(`aio-fighter: unknown target "${target}"; known: ${FIGHTER_PROFILES.map(p => p.target).join(', ')}`);
 }
 return resolveRouteStep(profile, rest);
}

export async function runAioFighter(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env,progression?:AioProgressionContext,
 run:(args:string[],env:Record<string,string|undefined>)=>Promise<string>=runDirectChild): Promise<string> {
 if (!account) throw Error('aio-fighter requires account');
 const [target, ...rest] = args;
 if (!target) throw Error('aio-fighter requires <target>');
 const original=resolveFighterStep(target,rest),choice=selectAioProgression(account,original,env,progression);
 if(choice.decision)console.log('AIO_PROGRESSION '+JSON.stringify({account,state:choice.decision.state,selected:choice.decision.selected,basis:choice.decision.basis,expectedTicks:choice.decision.expectedTicks}));
 if(!choice.step){const result=`RESULT ${choice.blocked?'fail':'ok'} ${choice.reason}`;console.log(result);return result;}
 const step=choice.step;
 return run([step.script, account, ...step.args], { ...env, ...step.env });
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
