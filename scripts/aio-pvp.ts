// AIO PvP ("PK Fighter"): unified Wilderness PvP, tribrid switching, hunting, roaming, kit staging, and escort suite.
// Usage:
//   bun scripts/aio-pvp.ts <account> <mode> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import {parseStep,type Step} from '../packages/core/src/chain-step';
import {
 ITEMS as PVP_ITEMS,SPELLS as PVP_SPELLS,PRAYER as PVP_PRAYER,
 attackable,bestFood,castableFreeze,defaultSpec,fightPlayer,nextTick,wildernessLevel,
 type FightOptions,type FightResult,type Kit,type SpecConfig,type Style,
} from './pk';
import {
 EDGEVILLE_BANK,HUNT_SPOTS,KIT_IDS,TRIBRID_KIT,TRIP as TRIBRID_TRIP,
 fleetNames,verdict,pickTarget,hitByPlayer,type Spot,
} from './pk-hunt';
import {itemCost} from './pk-roam';

export {
 PVP_ITEMS,PVP_SPELLS,PVP_PRAYER,
 attackable,bestFood,castableFreeze,defaultSpec,fightPlayer,nextTick,wildernessLevel,
 type FightOptions,type FightResult,type Kit,type SpecConfig,type Style,
 EDGEVILLE_BANK,HUNT_SPOTS,KIT_IDS,TRIBRID_KIT,TRIBRID_TRIP,
 fleetNames,verdict,pickTarget,hitByPlayer,type Spot,
 itemCost,
};

export interface PvpModeSpec {
 mode: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const PVP_MODES: readonly PvpModeSpec[] = [
 {mode:'fight',script:'scripts/pk.ts',description:'1v1 tribrid PK fight loop (overhead prayer reading, 1-tick gear switch, MSB/DDS spec, entangle, glory escape)'},
 {mode:'spar',script:'scripts/pk-spar.ts',description:'Practice spar: two own accounts fight each other, each with a named fight profile; prints a score for side A'},
 {mode:'gang',script:'scripts/pk-gang.ts',description:'Practice meeting: one own account against a gang of own accounts that all attack it; prints the kills and the end'},
 {mode:'hunt',script:'scripts/pk-hunt.ts',description:'Wilderness hunter trip: bank restock, hotspot patrol, target engagement, loot banking, and escape'},
 {mode:'roam',script:'scripts/pk-roam.ts',description:'Wilderness multi-zone roam and target scout'},
 {mode:'pilot',script:'scripts/pk-live/live-pilot.ts',defaultArgs:['10','20'],description:'Bounded live Wilderness PK pilot with GE/shop rune restock'},
 {mode:'standby',script:'scripts/pvp-standby.ts',description:'Staged Wilderness standby readiness'},
 {mode:'stage-kit',script:'scripts/pvp-kit-stage.ts',description:'Stage tribrid PvP equipment, food, potions, and runes at Edgeville/bank'},
 {mode:'escort-ore',script:'scripts/lava-maze-escorted-ore.ts',description:'Escorted Wilderness Lava Maze runite mining trip'},
 {mode:'microbot-pvp',script:'scripts/microbot-pvp.ts',description:'Microbot-adapted PvP combat helper'},
 {mode:'special-swap',script:'scripts/microbot-special-swap.ts',description:'1-tick special-attack weapon swap and restore'},
 {mode:'monitor',script:'scripts/microbot-c-player-monitor.ts',description:'Wilderness nearby-player threat & combat-range monitor'},
];

// Calculate exact RS2 combat level and attackable bracket at a given Wilderness Z coordinate or Wilderness level.
export function pvpCombatBracket(skills: {
 Attack: number;
 Strength: number;
 Defence: number;
 Hitpoints: number;
 Prayer: number;
 Ranged: number;
 Magic: number;
}, wildernessOrZ: number) {
 const base = 0.25 * (skills.Defence + skills.Hitpoints + Math.floor(skills.Prayer / 2));
 const melee = 0.325 * (skills.Attack + skills.Strength);
 const range = 0.325 * (Math.floor(skills.Ranged / 2) + skills.Ranged);
 const mage = 0.325 * (Math.floor(skills.Magic / 2) + skills.Magic);
 const combatLevel = Math.floor(base + Math.max(melee, range, mage));
 const wild = wildernessOrZ >= 3520 ? wildernessLevel(wildernessOrZ) : Math.max(0, Math.floor(wildernessOrZ));
 return {
  combatLevel,
  wildernessLevel: wild,
  minTargetCombat: Math.max(3, combatLevel - wild),
  maxTargetCombat: Math.min(126, combatLevel + wild),
  dominantStyle: (mage >= melee && mage >= range ? 'magic' : range >= melee ? 'ranged' : 'melee') as Style,
 };
}

// Check whether an account holds a complete tribrid trip loadout (weapons, Fire Wave runes, prayer potions, glory, and sharks).
export function assessTribridReadiness(ownedItems: Readonly<Record<number, number>>, huntFood = 18) {
 const required: Record<number, number> = { [PVP_ITEMS.shark]: huntFood };
 for (const item of TRIBRID_TRIP) required[item.id] = (required[item.id] ?? 0) + item.count;
 const missing: Record<number, number> = {};
 for (const [rawId, need] of Object.entries(required)) {
  const id = Number(rawId);
  const have = id === PVP_ITEMS.glory[0]
   ? PVP_ITEMS.glory.reduce((sum, gid) => sum + (ownedItems[gid] ?? 0), 0)
   : ownedItems[id] ?? 0;
  if (have < need) missing[id] = need - have;
 }
 return { ready: Object.keys(missing).length === 0, required, missing };
}

export function resolvePvpStep(modeInput: string, rest: readonly string[] = []): Step {
 const mode = modeInput.toLowerCase().replace(/^--mode=/, '');
 const spec = PVP_MODES.find(m => m.mode === mode);
 if (!spec) {
  throw Error(`aio-pvp: unknown mode "${mode}"; known: ${PVP_MODES.map(m => m.mode).join(', ')}`);
 }
 const tokens = rest.length ? rest : [...(spec.defaultArgs ?? [])];
 // pk-roam.ts reads its KEY=value settings from argv, so they stay arguments.
 if (spec.mode === 'roam') return { script: spec.script, args: [...tokens], env: { ...(spec.defaultEnv ?? {}) } };
 const step = parseStep([spec.script, ...tokens].join(' '));
 return { script: step.script, args: step.args, env: { ...(spec.defaultEnv ?? {}), ...step.env } };
}

export async function runAioPvp(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-pvp requires account');
 const [mode, ...rest] = args;
 if (!mode) throw Error('aio-pvp requires <mode>');
 const step = resolvePvpStep(mode, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
}

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify(PVP_MODES, null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-pvp.ts <account> <fight|spar|gang|hunt|roam|pilot|standby|stage-kit|escort-ore|special-swap|monitor> [args...]');
  process.exit(2);
 }
 const result = await runAioPvp(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
