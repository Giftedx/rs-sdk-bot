// AIO PvP ("PK Fighter"): unified Wilderness PvP, tribrid switching, hunting, roaming, kit staging, and escort suite.
// Usage:
//   bun scripts/aio-pvp.ts <account> <mode> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {resolveRouteStep} from './aio-route-step';
import {
 ITEMS as PVP_ITEMS,SPELLS as PVP_SPELLS,PRAYER as PVP_PRAYER,
 attackable,bestFood,castableFreeze,defaultSpec,fightPlayer,nextTick,wildernessLevel,weaponStyle,
 battleaxeWarcryMath,canCastChargeNow,
 type FightOptions,type FightResult,type Kit,type SpecConfig,type Style,
} from './pk';
import {
 EDGEVILLE_BANK,HUNT_PRESETS,HUNT_SPOTS,KIT_IDS,TRIBRID_KIT,TRIP as TRIBRID_TRIP,
 fleetNames,verdict,pickTarget,hitByPlayer,resolveHuntSpots,type Spot,
} from './pk-hunt';
import {
 WILDERNESS_ESCAPES,assessWildernessThreat,escapeStep,itemCost,multiPileThreat,
 planWildernessEscape,restockPlan,restockPlanFromStock,slashWebThrough,wildernessCombatMargin,wildernessDepth,
 readScoutIntel,publishScoutIntel,pickScoutTargetForSquad,hasVarrockTeleport,
 type ScoutIntel,
} from './pk-roam';
import {
 GOD_LOADOUTS,buildGodSpellKit,compareDragonSpecs,godCapeStaffConflict,
 type GodName,type GodLoadoutSpec,type DragonSpecComparison,
} from './pk-kits';
import {
 escortInterceptDecision,retreatOrTeleportPlan,selectInboundRecovery,runGatherCli,
} from '../packages/workers/src/gather';
import type {FightOptions as PvpFightOptions} from './pk';
import {kitFrom} from './pk-roam';

export {
 PVP_ITEMS,PVP_SPELLS,PVP_PRAYER,
 attackable,bestFood,castableFreeze,defaultSpec,fightPlayer,nextTick,wildernessLevel,weaponStyle,
 battleaxeWarcryMath,canCastChargeNow,
 type FightOptions,type FightResult,type Kit,type SpecConfig,type Style,
 EDGEVILLE_BANK,HUNT_PRESETS,HUNT_SPOTS,KIT_IDS,TRIBRID_KIT,TRIBRID_TRIP,
 fleetNames,verdict,pickTarget,hitByPlayer,resolveHuntSpots,type Spot,
 WILDERNESS_ESCAPES,assessWildernessThreat,escapeStep,itemCost,multiPileThreat,
 planWildernessEscape,restockPlan,restockPlanFromStock,slashWebThrough,wildernessCombatMargin,wildernessDepth,
 readScoutIntel,publishScoutIntel,pickScoutTargetForSquad,hasVarrockTeleport,
 type ScoutIntel,
 GOD_LOADOUTS,buildGodSpellKit,compareDragonSpecs,godCapeStaffConflict,
 type GodName,type GodLoadoutSpec,type DragonSpecComparison,
 escortInterceptDecision,retreatOrTeleportPlan,selectInboundRecovery,
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
 {mode:'army',script:'scripts/pk-army.ts',description:'PK army: a roaming leader and followers that keep with it and fight its target together, then leave together'},
 {mode:'squad',script:'scripts/pk-squad.ts',description:'Gang squad: own accounts hold a multi-way post, focus the named targets (default the dagger gang), pick up, bank and return'},
 {mode:'team',script:'scripts/pk-team.ts',description:'Practice meeting: two teams of own accounts (SPAR_TEAM a side) fight in one place; prints the wins of side A'},
 {mode:'hunt',script:'scripts/pk-hunt.ts',description:'Wilderness hunter trip: bank restock, hotspot patrol, target engagement, loot banking, and escape'},
 {mode:'roam',script:'scripts/pk-roam.ts',description:'Wilderness multi-zone roam and target scout'},
 {mode:'pilot',script:'scripts/pk-live/live-pilot.ts',defaultArgs:['10','20'],description:'Bounded live Wilderness PK pilot with GE/shop rune restock'},
 {mode:'standby',script:'scripts/pvp-standby.ts',description:'Staged Wilderness standby readiness'},
 {mode:'stage-kit',script:'scripts/pvp-kit-stage.ts',description:'Stage an owned starter PvP kit and two paid cheese at Varrock East bank'},
 {mode:'escort-ore',script:'scripts/aio-pvp.ts',defaultArgs:['__escort-ore'],description:'Escorted Wilderness Lava Maze runite mining trip'},
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
  gloryUsable: wild <= 30,
  spellTeleportUsable: wild <= 20,
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

// Check god spell + Charge PvP readiness (Magic level, Mage Arena varps, matching cape+staff without god conflict, and runes).
export function assessGodSpellReadiness(opts: {
 god: GodName;
 magicLevel: number;
 prayerLevel: number;
 mageArenaVarp?: number;
 godCastVarp?: number;
 chargeVarp?: number;
 wornIds: readonly number[];
 inventory: readonly { id: number; count: number }[];
}) {
 const spec = GOD_LOADOUTS[opts.god];
 const conflict = godCapeStaffConflict(opts.wornIds);
 const allIds = [...opts.wornIds, ...opts.inventory.map(i => i.id)];
 const hasCape = allIds.includes(spec.capeId);
 const hasStaff = allIds.includes(spec.staffId);
 const chargeReady = canCastChargeNow(opts.magicLevel, opts.inventory, 0);
 const count = (id: number) => opts.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
 const castRunes = count(PVP_ITEMS.fireRune) >= spec.runes.fire
  && count(PVP_ITEMS.bloodRune) >= spec.runes.blood
  && count(PVP_ITEMS.airRune) >= spec.runes.air;
 const unlocked = (opts.mageArenaVarp ?? 8) >= 8 && (opts.godCastVarp ?? 99) >= 99;
 const chargeActive = (opts.chargeVarp ?? 0) > 0;
 return {
  god: opts.god,
  spell: spec.spell,
  maxHit: opts.magicLevel >= 60 && hasCape && hasStaff && (chargeActive || chargeReady) ? 30 : 20,
  drainEffect: spec.drainEffect,
  conflict,
  hasCape,
  hasStaff,
  unlocked,
  castRunes,
  chargeReady,
  chargeActive,
  prayerReady: opts.prayerLevel >= 37,
  ready: opts.magicLevel >= 60 && !conflict && hasCape && hasStaff && unlocked && castRunes,
 };
}

// Resolve the Mage Arena quest step for Saradomin, Guthix, or Zamorak with optional Charge verification.
export function resolveMageArenaWorkflow(god: GodName = 'zamorak', opts: { mode?: 'pray' | 'leash'; charge?: boolean } = {}): Step {
 return {
  script: 'scripts/generated/quest-magearena.ts',
  args: [],
  env: { MA_GOD: god, MA_MODE: opts.mode ?? 'pray', ...(opts.charge ? { MA_CHARGE: '1' } : {}) },
 };
}

// Evaluate anti-PK guard/escape state for Wilderness Agility runs (COURSES.wilderness z 3916..3970 and underground pit 10363).
export function wildernessAgilityEscapeGuard(opts: {
 me: { x: number; z: number; level: number; hp: number; maxHp: number; combatLevel: number };
 nearby: readonly { name: string; x: number; z: number; combatLevel: number; distance: number; wornWeapon?: number }[];
 friends?: ReadonlySet<string>;
 inObstacleDelay?: boolean;
 hasGlory: boolean;
 hasVarrockTele: boolean;
 foodCount: number;
 eatAt?: number;
}) {
 const { me, nearby, friends = new Set(), inObstacleDelay = false, hasGlory, hasVarrockTele, foodCount } = opts;
 const inPit = me.z >= 9920 && me.x >= 2995 && me.x <= 3015;
 const onCourse = inPit || (me.level === 0 && me.x >= 2988 && me.x <= 3012 && me.z >= 3916 && me.z <= 3972);
 const hostiles = nearby.filter(p => !friends.has(p.name.toLowerCase())
  && p.distance <= 24
  && attackable({ z: me.z, combatLevel: me.combatLevel }, { z: p.z, combatLevel: p.combatLevel }));
 const threat = hostiles.sort((a, b) => a.distance - b.distance)[0] ?? null;
 const eatThreshold = opts.eatAt ?? Math.ceil(me.maxHp * 0.6);
 const protectStyle: Style | null = threat ? weaponStyle(threat.wornWeapon) : null;
 const protectPrayer = protectStyle ? (protectStyle === 'magic' ? PVP_PRAYER.magic : protectStyle === 'ranged' ? PVP_PRAYER.missiles : PVP_PRAYER.melee) : null;
 if (!threat && me.hp > eatThreshold) {
  return { onCourse, inPit, action: 'continue' as const, threat: null, protectPrayer: null, escapePlan: null };
 }
 // Server ignores eat/teleport packets while obstacle p_delay/p_exactmove is active (consume/teleport handlers): settle first.
 if (inObstacleDelay) {
  return { onCourse, inPit, action: 'wait-obstacle-settle' as const, threat, protectPrayer, escapePlan: null };
 }
 const escapePlan = threat ? planWildernessEscape({ x: me.x, z: me.z }, { glory: hasGlory, teleport: hasVarrockTele }) : null;
 if (threat && (threat.distance <= 15 || foodCount <= 2 || me.hp <= eatThreshold)) {
  return { onCourse, inPit, action: (inPit ? 'climb-pit-then-escape' : 'exit-course') as 'climb-pit-then-escape' | 'exit-course', threat, protectPrayer, escapePlan };
 }
 if (me.hp <= eatThreshold && foodCount > 0) {
  return { onCourse, inPit, action: 'eat' as const, threat, protectPrayer, escapePlan };
 }
 return { onCourse, inPit, action: threat ? ('exit-course' as const) : ('continue' as const), threat, protectPrayer, escapePlan };
}

export function resolvePvpStep(modeInput: string, rest: readonly string[] = []): Step {
 const mode = modeInput.toLowerCase().replace(/^--mode=/, '');
 const spec = PVP_MODES.find(m => m.mode === mode);
 if (!spec) {
  throw Error(`aio-pvp: unknown mode "${mode}"; known: ${PVP_MODES.map(m => m.mode).join(', ')}`);
 }
 if (spec.mode === 'escort-ore') {
  const resolved = resolveRouteStep({ script: spec.script, defaultEnv: spec.defaultEnv }, rest);
  return { script: 'scripts/aio-pvp.ts', args: ['__escort-ore', ...resolved.args], env: resolved.env };
 }
 // pk-roam.ts and pk-army.ts read their KEY=value settings from argv, so they stay arguments.
 if (spec.mode === 'roam' || spec.mode === 'army') return { script: spec.script, args: rest.length ? [...rest] : [...(spec.defaultArgs ?? [])], env: { ...(spec.defaultEnv ?? {}) } };
 return resolveRouteStep(spec, rest);
}

export async function runAioPvp(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-pvp requires account');
 const [mode, ...rest] = args;
 if (!mode) throw Error('aio-pvp requires <mode>');
 if (mode === '__escort-ore') {
  const cleanArgs: string[] = [];
  const mergedEnv: Record<string, string | undefined> = { ...env };
  for (const token of rest) {
   const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
   if (m) mergedEnv[m[1]!] = m[2]!;
   else cleanArgs.push(token);
  }
  const code = await runGatherCli(account, {
   skill: 'mining',
   method: 'lava-maze',
   args: cleanArgs,
   env: mergedEnv,
   deps: {
    workScript: 'scripts/aio-pvp.ts',
    attackable,
    defaultSpec,
    fightPlayer: (s, targetName, opts) => fightPlayer(s, targetName, (opts ?? {}) as PvpFightOptions),
    escapeStep,
    hasVarrockTeleport,
    kitFrom,
   },
  });
  return code === 0 ? 'RESULT ok' : 'RESULT fail';
 }
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
