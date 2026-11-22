import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Step } from '../../../core/src/chain-step';
import { GOD_LOADOUTS, buildGodSpellKit, compareDragonSpecs, godCapeStaffConflict, type DragonSpecComparison, type GodLoadoutSpec, type GodName } from '../../../core/src/pk-kits/god-specs';
import { resolveRouteStep } from '../../../core/src/route-step';
import {
    ITEMS as PVP_ITEMS,
    SPELLS as PVP_SPELLS,
    PRAYER as PVP_PRAYER,
    attackable,
    battleaxeWarcryMath,
    bestFood,
    canCastChargeNow,
    castableFreeze,
    defaultSpec,
    fightPlayer,
    nextTick,
    runPkFightCli,
    weaponStyle,
    wildernessLevel,
    type FightOptions,
    type FightResult,
    type Kit,
    type SpecConfig,
    type Style,
} from './fight';
import {
    EDGEVILLE_BANK,
    HUNT_PRESETS,
    HUNT_SPOTS,
    KIT_IDS,
    TRIBRID_KIT,
    TRIP as TRIBRID_TRIP,
    fleetNames,
    hitByPlayer,
    pickTarget,
    resolveHuntSpots,
    verdict,
    type Spot,
} from './hunt-kits';
import { runPkHuntCli } from './hunt';
import { runMicrobotPvpCli } from './microbot-pvp';
import { runMonitorCli } from './monitor';
import { runPkArmyCli } from './pk-army';
import { runPkGangCli } from './pk-gang';
import { runPkSparCli } from './pk-spar';
import { runPkTeamCli } from './pk-team';
import { runPkRoamCli, kitFrom } from './roam';
import { runDirectChildBridge, pvpRuntime } from './runtime';
import { runSpecialSwapCli } from './special-swap';
import { runPkSquadCli } from './squad';
import { runStageKitCli } from './stage-kit';
import { runStandbyCli } from './standby';
import { PVP_MODES_LIST, REPO_ROOT, type PvpMode, type PvpModeSpec } from './types';
import {
    WILDERNESS_ESCAPES,
    assessWildernessThreat,
    escapeStep,
    hasVarrockTeleport,
    itemCost,
    multiPileThreat,
    pickScoutTargetForSquad,
    planWildernessEscape,
    publishScoutIntel,
    readScoutIntel,
    restockPlan,
    restockPlanFromStock,
    slashWebThrough,
    wildernessCombatMargin,
    wildernessDepth,
    type ScoutIntel,
} from './wild-rules';

export {
    PVP_ITEMS,
    PVP_SPELLS,
    PVP_PRAYER,
    attackable,
    bestFood,
    castableFreeze,
    defaultSpec,
    fightPlayer,
    nextTick,
    wildernessLevel,
    weaponStyle,
    battleaxeWarcryMath,
    canCastChargeNow,
    type FightOptions,
    type FightResult,
    type Kit,
    type SpecConfig,
    type Style,
    EDGEVILLE_BANK,
    HUNT_PRESETS,
    HUNT_SPOTS,
    KIT_IDS,
    TRIBRID_KIT,
    TRIBRID_TRIP,
    fleetNames,
    verdict,
    pickTarget,
    hitByPlayer,
    resolveHuntSpots,
    type Spot,
    WILDERNESS_ESCAPES,
    assessWildernessThreat,
    escapeStep,
    itemCost,
    multiPileThreat,
    planWildernessEscape,
    restockPlan,
    restockPlanFromStock,
    slashWebThrough,
    wildernessCombatMargin,
    wildernessDepth,
    readScoutIntel,
    publishScoutIntel,
    pickScoutTargetForSquad,
    hasVarrockTeleport,
    type ScoutIntel,
    GOD_LOADOUTS,
    buildGodSpellKit,
    compareDragonSpecs,
    godCapeStaffConflict,
    type GodName,
    type GodLoadoutSpec,
    type DragonSpecComparison,
};

/** Route registry exposed by `scripts/aio-pvp.ts` (`--list`). */
export const PVP_MODES: readonly PvpModeSpec[] = [
    { mode: 'fight', script: 'scripts/pk.ts', description: '1v1 tribrid PK fight loop (overhead prayer reading, 1-tick gear switch, MSB/DDS spec, entangle, glory escape)' },
    { mode: 'spar', script: 'scripts/aio-pvp.ts', defaultArgs: ['spar'], description: 'Practice spar: two own accounts fight each other, each with a named fight profile; prints a score for side A' },
    { mode: 'gang', script: 'scripts/aio-pvp.ts', defaultArgs: ['gang'], description: 'Practice meeting: one own account against a gang of own accounts that all attack it; prints the kills and the end' },
    { mode: 'army', script: 'scripts/aio-pvp.ts', defaultArgs: ['army'], description: 'PK army: a roaming leader and followers that keep with it and fight its target together, then leave together' },
    { mode: 'squad', script: 'scripts/pk-squad.ts', description: 'Gang squad: own accounts hold a multi-way post, focus the named targets (default the dagger gang), pick up, bank and return' },
    { mode: 'team', script: 'scripts/aio-pvp.ts', defaultArgs: ['team'], description: 'Practice meeting: two teams of own accounts (SPAR_TEAM a side) fight in one place; prints the wins of side A' },
    { mode: 'hunt', script: 'scripts/aio-pvp.ts', defaultArgs: ['hunt'], description: 'Wilderness hunter trip: bank restock, hotspot patrol, target engagement, loot banking, and escape' },
    { mode: 'roam', script: 'scripts/aio-pvp.ts', defaultArgs: ['roam'], description: 'Wilderness multi-zone roam and target scout' },
    { mode: 'pilot', script: 'scripts/pk-live/live-pilot.ts', defaultArgs: ['10', '20'], description: 'Bounded live Wilderness PK pilot with GE/shop rune restock' },
    { mode: 'standby', script: 'scripts/aio-pvp.ts', defaultArgs: ['standby'], description: 'Staged Wilderness standby readiness' },
    { mode: 'stage-kit', script: 'scripts/aio-pvp.ts', defaultArgs: ['stage-kit'], description: 'Stage an owned starter PvP kit and two paid cheese at Varrock East bank' },
    { mode: 'escort-ore', script: 'scripts/aio-pvp.ts', defaultArgs: ['__escort-ore'], description: 'Escorted Wilderness Lava Maze runite mining trip' },
    { mode: 'microbot-pvp', script: 'scripts/aio-pvp.ts', defaultArgs: ['microbot-pvp'], description: 'Microbot-adapted PvP combat helper' },
    { mode: 'special-swap', script: 'scripts/aio-pvp.ts', defaultArgs: ['special-swap'], description: '1-tick special-attack weapon swap and restore' },
    { mode: 'monitor', script: 'scripts/aio-pvp.ts', defaultArgs: ['monitor'], description: 'Wilderness nearby-player threat & combat-range monitor' },
];

export function isPvpMode(mode: string): mode is PvpMode {
    return (PVP_MODES_LIST as readonly string[]).includes(mode);
}

/** Computes RS2 combat level and attackable Wilderness combat bracket at a Z coordinate or depth. */
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

/** Verifies whether an owned account holds a complete tribrid PK trip loadout. */
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

/** Checks god spell + Charge PvP readiness for Saradomin, Guthix, or Zamorak. */
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

/** Resolves the Mage Arena quest step for Saradomin, Guthix, or Zamorak. */
export function resolveMageArenaWorkflow(god: GodName = 'zamorak', opts: { mode?: 'pray' | 'leash'; charge?: boolean } = {}): Step {
    return {
        script: 'scripts/generated/quest-magearena.ts',
        args: [],
        env: { MA_GOD: god, MA_MODE: opts.mode ?? 'pray', ...(opts.charge ? { MA_CHARGE: '1' } : {}) },
    };
}

/** Evaluates anti-PK guard/escape state for Wilderness Agility course runs. */
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

/** Resolves an AIO PvP mode into its canonical executable `Step`. */
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
    // roam and army parse KEY=value settings straight from argv alongside env.
    if (spec.mode === 'roam' || spec.mode === 'army') {
        const extra = rest.length ? [...rest] : [];
        return { script: spec.script, args: [spec.mode, ...extra], env: { ...(spec.defaultEnv ?? {}) } };
    }
    return resolveRouteStep(spec, rest);
}

async function runEscortOreCli(
    account: string,
    rest: readonly string[],
    env: Record<string, string | undefined>,
): Promise<number> {
    const cleanArgs: string[] = [];
    const mergedEnv: Record<string, string | undefined> = { ...env };
    for (const token of rest) {
        const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (m) mergedEnv[m[1]!] = m[2]!;
        else cleanArgs.push(token);
    }
    const { runGatherCli } = await import('../gather');
    return runGatherCli(account, {
        skill: 'mining',
        method: 'lava-maze',
        args: cleanArgs,
        env: mergedEnv,
        deps: {
            workScript: 'scripts/aio-pvp.ts',
            attackable,
            defaultSpec,
            fightPlayer: (s, targetName, opts) => fightPlayer(s, targetName, (opts ?? {}) as FightOptions),
            escapeStep,
            hasVarrockTeleport,
            kitFrom,
        },
    });
}

/** Executes an in-process PvP CLI mode when consolidated under `scripts/aio-pvp.ts`. */
export async function dispatchPvpCli(
    account: string,
    modeInput: string,
    rest: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<number> {
    if (!account) throw Error('aio-pvp requires account');
    const normalized = modeInput.toLowerCase().replace(/^--mode=/, '');
    if (normalized === '__escort-ore') {
        return runEscortOreCli(account, rest, env);
    }
    const mode = normalized;
    const spec = PVP_MODES.find(m => m.mode === mode);
    if (!spec) {
        throw Error(`aio-pvp: unknown mode "${mode}"; known: ${PVP_MODES.map(m => m.mode).join(', ')}`);
    }

    // Parse inline KEY=value tokens into temporary process.env while preserving KV argv for modes that read both.
    const parsedEnv: Record<string, string> = { ...(spec.defaultEnv ?? {}) };
    const positional: string[] = [];
    for (const token of rest) {
        const eq = token.indexOf('=');
        if (eq > 0 && /^[A-Z_][A-Z0-9_]*$/.test(token.slice(0, eq))) {
            parsedEnv[token.slice(0, eq)] = token.slice(eq + 1);
        } else {
            positional.push(token);
        }
    }

    const mergedEnv: Record<string, string | undefined> = { ...env, ...parsedEnv };
    const prevEnv: Array<[string, string | undefined]> = [];
    for (const [k, v] of Object.entries(parsedEnv)) {
        prevEnv.push([k, process.env[k]]);
        process.env[k] = v;
    }

    try {
        switch (mode) {
            case 'fight':
                return await (pvpRuntime.runPkFightCli ?? ((args) => runPkFightCli(args)))([account, ...positional], mergedEnv);
            case 'spar':
                return await runPkSparCli([account, ...positional], mergedEnv);
            case 'gang':
                return await runPkGangCli([account, ...positional], mergedEnv);
            case 'team':
                return await runPkTeamCli([account, ...positional], mergedEnv);
            case 'hunt':
                return await runPkHuntCli([account, ...positional], mergedEnv);
            case 'roam':
                return await runPkRoamCli([account, ...rest]);
            case 'army':
                return await runPkArmyCli([account, ...rest]);
            case 'squad':
                return await (pvpRuntime.runPkSquadCli ?? runPkSquadCli)([account, ...rest], mergedEnv);
            case 'standby':
                return await runStandbyCli([account, ...positional]);
            case 'stage-kit':
                return await runStageKitCli([account, ...positional]);
            case 'microbot-pvp':
                return await runMicrobotPvpCli([account, ...positional]);
            case 'special-swap':
                return await runSpecialSwapCli([account, ...positional], mergedEnv);
            case 'monitor':
                return await runMonitorCli([account, ...positional]);
            case 'escort-ore':
                if (pvpRuntime.runDirectChild) {
                    const step = resolvePvpStep(mode, rest);
                    const result = await runDirectChildBridge([step.script, account, ...step.args], { ...mergedEnv, ...step.env });
                    return /^RESULT ok(?: |$)/.test(result) ? 0 : 1;
                }
                return await runEscortOreCli(account, rest, mergedEnv);
            case 'pilot': {
                const target = join(REPO_ROOT, spec.script);
                if (!existsSync(target)) throw Error(`aio-pvp: missing script ${spec.script}`);
                const step = resolvePvpStep(mode, rest);
                const result = await runDirectChildBridge([step.script, account, ...step.args], { ...mergedEnv, ...step.env });
                return /^RESULT ok(?: |$)/.test(result) ? 0 : 1;
            }
            default:
                throw Error(`aio-pvp: unhandled mode "${mode}"`);
        }
    } finally {
        for (const [k, v] of prevEnv) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** Spawns or dispatches a resolved PvP mode child via `runDirectChild`. */
export async function runAioPvp(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    if (!account) throw Error('aio-pvp requires account');
    const [mode, ...rest] = args;
    if (!mode) throw Error('aio-pvp requires <mode>');
    const step = resolvePvpStep(mode, rest);
    return runDirectChildBridge([step.script, account, ...step.args], { ...env, ...step.env });
}
