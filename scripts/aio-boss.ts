// AIO Boss ("PvM Helper"): unified entry for boss encounters and minigame trips.
// Usage:
//   bun scripts/aio-boss.ts <account> <boss> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {resolveRouteStep} from './aio-route-step';
import {
 BLUE_KIT,BLACK_KIT,KBD_KIT,validateCombatKit,combatKitTotals,combatAssetIssues,
 inKbdEntrancePit,inNativeKbdLair,combatTeleportAllowed,leaveKbdEntrancePit,
 blueDungeonEntry,combatTrip,type CombatKit,
} from './microbot-combat-trip';

export {
 BLUE_KIT,BLACK_KIT,KBD_KIT,validateCombatKit,combatKitTotals,combatAssetIssues,
 inKbdEntrancePit,inNativeKbdLair,combatTeleportAllowed,leaveKbdEntrancePit,
 blueDungeonEntry,combatTrip,type CombatKit,
};

export interface BossEncounterSpec {
 boss: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const BOSS_ENCOUNTERS: readonly BossEncounterSpec[] = [
 {boss:'kbd',script:'scripts/microbot-b-kbd.ts',description:'King Black Dragon full trip: KBD_KIT withdraw, Lava Maze lever entry, antifire/prayer/melee fight, loot, and escape'},
 {boss:'black-dragon',script:'scripts/black-dragon-camp.ts',description:'Taverley black dragons from the corridor south of their cave: BLACK_KIT withdraw, dusty key gate, ranged camp that takes no melee, hides and bones banked'},
 {boss:'trawler',script:'scripts/microbot-trawler-trip.ts',description:'Port Khazard Fishing Trawler minigame trip (paste/bailing/net inspection)'},
 {boss:'trawler-at-site',script:'scripts/microbot-b-trawler.ts',description:'At-dock Fishing Trawler minigame loop'},
];

export function assessBossReadiness(
 bossInput: 'kbd' | 'blue-dragon' | 'black-dragon' | 'trawler',
 accountState: {
  skills: Readonly<Record<string, number>>;
  ownedItems: Readonly<Record<number, number>>;
  members?: boolean;
 },
) {
 if (bossInput === 'trawler') {
  const fishing = accountState.skills.Fishing ?? 1;
  const rope = accountState.ownedItems[954] ?? 0, paste = accountState.ownedItems[1941] ?? 0, bailing = accountState.ownedItems[583] ?? 0;
  const missingItems: Record<number, number> = {};
  if (rope < 1) missingItems[954] = 1 - rope;
  if (paste < 20) missingItems[1941] = 20 - paste;
  if (bailing < 1) missingItems[583] = 1 - bailing;
  const missingSkills = fishing < 15 ? [{ skill: 'Fishing', current: fishing, required: 15 }] : [];
  return {
   boss: bossInput,
   ready: accountState.members !== false && missingSkills.length === 0 && Object.keys(missingItems).length === 0,
   missingSkills,
   missingItems,
   requiredKit: {},
  };
 }
 const kit = bossInput === 'kbd' ? KBD_KIT : bossInput === 'black-dragon' ? BLACK_KIT : BLUE_KIT;
 const requiredSkills = validateCombatKit(kit);
 const requiredTotals = combatKitTotals(kit);
 const missingSkills = requiredSkills
  .filter(r => (accountState.skills[r.skill] ?? 1) < r.level)
  .map(r => ({ skill: r.skill, current: accountState.skills[r.skill] ?? 1, required: r.level }));
 const missingItems: Record<number, number> = {};
 for (const [rawId, count] of Object.entries(requiredTotals)) {
  const id = Number(rawId), have = accountState.ownedItems[id] ?? 0;
  if (have < count) missingItems[id] = count - have;
 }
 return {
  boss: bossInput,
  ready: accountState.members !== false && missingSkills.length === 0 && Object.keys(missingItems).length === 0,
  missingSkills,
  missingItems,
  requiredKit: requiredTotals,
 };
}

export function resolveBossStep(bossInput: string, rest: readonly string[] = []): Step {
 const boss = bossInput.toLowerCase().replace(/^--boss=/, '');
 const spec = BOSS_ENCOUNTERS.find(b => b.boss === boss);
 if (!spec) {
  throw Error(`aio-boss: unknown encounter "${boss}"; known: ${BOSS_ENCOUNTERS.map(b => b.boss).join(', ')}`);
 }
 const step = resolveRouteStep(spec, rest);
 // The KBD worker reads its fight limit from CAP, while the dragon/trawler workers read a positional cap.
 if (boss === 'kbd' && step.args.length) {
  if (step.args.length !== 1 || !/^\d+$/.test(step.args[0]!) || Number(step.args[0]) < 1 || Number(step.args[0]) > 1000) {
   throw Error('aio-boss kbd positional CAP must be 1..1000 ticks; use TRIP_CAP for the full trip');
  }
  if (step.env.CAP === undefined) step.env.CAP = step.args[0]!;
  step.args = [];
 }
 return { script: step.script, args: step.args, env: { ...(spec.defaultEnv ?? {}), ...step.env } };
}

export async function runAioBoss(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-boss requires account');
 const [boss, ...rest] = args;
 if (!boss) throw Error('aio-boss requires <boss>');
 const step = resolveBossStep(boss, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
}

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify(BOSS_ENCOUNTERS, null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-boss.ts <account> <kbd|combat-trip|trawler|trawler-at-site> [args...]');
  process.exit(2);
 }
 const result = await runAioBoss(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
