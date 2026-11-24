import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { finish, openBot } from '../../../core/src/bot';
import { objId } from '../../../core/src/content-facts';
import { waitTicks } from '../../../core/src/ticks';
import { watchWorkerStop } from '../stop';
import type {
    PreflightResult,
    RateEstimate,
    RunOutcome,
    WorkerAccountView,
    WorkerModule,
    WorkerWorldView,
} from '../contracts';
import type {
    BLACK_DRAGON,
    runBlackDragonCamp,
    runBlackDragonCli,
    runKbdCli,
    runKbdOne,
    runTrawlerSupportCli,
    runTrawlerTrip,
    runTrawlerTripCli,
    runWildDragons,
    runWildDragonsCli,
} from './boss-minigame';
import type {
    buyCannon,
    CANNON_SPOTS,
    parseLevels,
    parsePhases,
    reclaimCannon,
    runCannonCli,
    runCannonFight,
    CannonSpot,
} from './cannon';
import type { runChickenCli, trainChickens } from './chickens';
import { combatEstimate } from './estimate';
import type {
    magicOptions,
    nativeCombatTeleport,
    nativeNpcSpell,
    runCombatTeleport,
    runMagicOrder,
    runMagicOrderCli,
    runNpcMagic,
    runNpcMagicCli,
    runSplash,
    runSplashCli,
    splashSite,
    NpcMagicOptions,
} from './magic';
import type {
    CONFIGS,
    cowProfile,
    giantKillLimit,
    giantTraining,
    runCows,
    runGenericCombatSession,
    runGiants,
    runMeleeGatherCli,
    TROOPER_SITE,
    MeleeGatherStageHooks,
} from './melee-gather';
import type { runPrayerFlickCli, withCombatPrayer, withIncomingProtection } from './prayer-flick';
import { COMBAT_SITES, combatPreflight } from './preflight';
import type {
    BLUE_DRAGON,
    rangedComparisonMethod,
    rangedTrainOptions,
    runAdaptiveRanged,
    runRanged,
    runRangedCamp,
    runRangedCampCli,
    runRangedGatherCli,
    runRangedStarter,
    runRangedStarterCli,
    RangedAdaptiveDeps,
} from './ranged';
import type {
    chompyEnergyOption,
    runChompy,
    runChompyCli,
    runChompyTrip,
    runChompyTripCli,
    runFireCombat,
    runFireCombatCli,
    runFireReclaim,
    runFireReclaimCli,
    runImps,
    runImpsCli,
    runLootTrip,
    runLootTripCli,
    runShadeTripCli,
    runShadeTrips,
    validateShadeJob,
    LootTripJob,
    ShadeJob,
} from './special-mobs';
import {
    combatAlchPolicy,
    combatMagicRecipe,
    combatPotionPolicy,
    telegrabPolicy,
    type MagicRecipe,
} from './survivability';
import {
    BLACK_KIT,
    blackKit,
    BLUE_KIT,
    combatKitTotals,
    combatTrip,
    KBD_KIT,
    validateCombatKit,
} from './trip-kit';
import {
    COMBAT_MODE_SET,
    type CombatConfig,
    type CombatMode,
    type CombatSession,
} from './types';

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
        const rope = accountState.ownedItems[954] ?? 0;
        const paste = accountState.ownedItems[1941] ?? 0;
        const bailing = accountState.ownedItems[583] ?? 0;
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
        const id = Number(rawId);
        const have = accountState.ownedItems[id] ?? 0;
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

export type CombatRunnerHooks = MeleeGatherStageHooks &
    RangedAdaptiveDeps & {
        walk?: (x: number, z: number, tol: number) => Promise<boolean>;
        leaveStarter?: (s: CombatSession, stop: () => boolean) => Promise<void>;
        comboRecipe?: (mode: string, item?: string) => MagicRecipe;
        runComboItem?: NpcMagicOptions['runComboItem'];
        runComboTeleport?: NpcMagicOptions['runComboTeleport'];
    };

function splitArgsAndEnv(rawArgs: readonly string[], baseEnv: Record<string, string | undefined>) {
    const positional: string[] = [];
    const env: Record<string, string | undefined> = { ...baseEnv };
    for (const arg of rawArgs) {
        const eq = arg.indexOf('=');
        if (eq > 0 && /^[A-Z0-9_]+$/.test(arg.slice(0, eq))) {
            env[arg.slice(0, eq)] = arg.slice(eq + 1);
        } else {
            positional.push(arg);
        }
    }
    return { positional, env };
}

const ALL_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'] as const;

function snapshotSkillXp(s: CombatSession): Record<string, number> {
    const out: Record<string, number> = {};
    for (const skill of ALL_SKILLS) out[skill] = s.sdk.getSkillXp(skill) ?? 0;
    return out;
}

function snapshotOwnedItems(s: CombatSession): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of [...s.sdk.getInventory(), ...s.sdk.getEquipment()]) {
        out.set(row.id, (out.get(row.id) ?? 0) + row.count);
    }
    return out;
}

function computeXpDelta(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>) {
    const out: Record<string, number> = {};
    for (const skill of ALL_SKILLS) {
        const delta = Math.max(0, (after[skill] ?? 0) - (before[skill] ?? 0));
        if (delta > 0) out[skill] = delta;
    }
    return out;
}

function computeItemsDelta(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>) {
    const out: Record<number, number> = {};
    for (const id of new Set([...before.keys(), ...after.keys()])) {
        const delta = (after.get(id) ?? 0) - (before.get(id) ?? 0);
        if (delta !== 0) out[id] = delta;
    }
    return out;
}

function normalizePos(s: CombatSession) {
    const p = s.sdk.getState()?.player;
    return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
}

function parseModeResult(
    mode: CombatMode,
    account: string,
    ticksElapsed: number,
    durationMs: number,
    xpGained: Readonly<Record<string, number>>,
    itemsDelta: Readonly<Record<number, number>>,
    rawResult: unknown,
    opts: { sessionDied?: boolean; stopped?: boolean } = {},
): RunOutcome {
    const site = COMBAT_SITES[mode];
    const r = (rawResult && typeof rawResult === 'object' ? rawResult : {}) as Record<string, unknown>;
    const ok = typeof rawResult === 'boolean' ? rawResult : Boolean(r.ok);
    const died = Boolean(r.died) || Boolean(opts.sessionDied);
    const failure =
        typeof r.failure === 'string' && r.failure !== '-'
            ? r.failure
            : typeof r.reason === 'string'
                ? r.reason
                : typeof r.stop === 'string' && r.stop !== 'target'
                    ? r.stop
                    : '';
    const units = Number(
        r.kills ??
            r.creditedKills ??
            r.completed ??
            r.made ??
            r.units ??
            r.casts ??
            r.attacksProtected ??
            (typeof rawResult === 'boolean' && rawResult ? 1 : 0),
    );
    const unitsCompleted = Number.isFinite(units) && units >= 0 ? units : 0;

    if (died) {
        return {
            kind: 'death',
            activityId: site.activityId,
            account,
            ticksElapsed,
            durationMs,
            unitsCompleted,
            xpGained,
            itemsDelta,
            faultSignature: `combat:${mode}:death`,
            detail: failure || 'player died during combat run',
        };
    }
    if (ok) {
        return {
            kind: 'target_met',
            activityId: site.activityId,
            account,
            ticksElapsed,
            durationMs,
            unitsCompleted,
            xpGained,
            itemsDelta,
            summary: failure || `${mode} completed`,
        };
    }
    if (opts.stopped || /stop|interrupt|disconnect|ended|timeout|budget|\bcap\b/i.test(failure)) {
        return {
            kind: 'session_unsettled',
            activityId: site.activityId,
            account,
            ticksElapsed,
            durationMs,
            unitsCompleted,
            xpGained,
            itemsDelta,
            reason: opts.stopped ? (failure || 'stopped') : failure,
            detail: failure || `${mode} stopped or unsettled`,
        };
    }
    if (/missing|absent|short|need|exhaust|suppl|require/i.test(failure)) {
        return {
            kind: 'missing_supply',
            activityId: site.activityId,
            account,
            ticksElapsed,
            durationMs,
            unitsCompleted,
            xpGained,
            itemsDelta,
            missing: [{ itemId: 0, required: 1, available: 0, itemName: `${mode}-supply` }],
            summary: failure || `${mode} missing supplies`,
        };
    }
    if (/walk|route|stranded|lair|dungeon|position/i.test(failure)) {
        return {
            kind: 'location_stranded',
            activityId: site.activityId,
            account,
            ticksElapsed,
            durationMs,
            unitsCompleted,
            xpGained,
            itemsDelta,
            detail: failure || `${mode} stranded`,
        };
    }
    return {
        kind: 'worker_defect',
        activityId: site.activityId,
        account,
        ticksElapsed,
        durationMs,
        unitsCompleted,
        xpGained,
        itemsDelta,
        faultSignature: `combat:${mode}:failed`,
        detail: failure || `${mode} failed`,
    };
}

export async function runCombatModuleSession(
    session: CombatSession,
    cfg: CombatConfig,
    hooks: CombatRunnerHooks = {},
): Promise<RunOutcome> {
    if (!cfg || !COMBAT_MODE_SET.has(cfg.mode)) {
        return {
            kind: 'worker_defect',
            activityId: 'combat:unknown',
            account: session.name,
            ticksElapsed: 0,
            faultSignature: 'combat:invalid_mode',
            detail: `unsupported combat mode: ${String((cfg as { mode?: unknown })?.mode)}`,
        };
    }

    const mode = cfg.mode;
    const site = COMBAT_SITES[mode];
    const startTick = session.tick();
    const startMs = Date.now();
    const xpBefore = snapshotSkillXp(session);
    const itemsBefore = snapshotOwnedItems(session);
    const env: Record<string, string | undefined> = { ...(cfg.env ?? {}) };
    if (cfg.targetSkill) env.TRAIN_SKILL = cfg.targetSkill;
    if (cfg.targetLevel !== undefined) env.TARGET_LEVEL = String(cfg.targetLevel);
    if (cfg.capTicks !== undefined) env.CAP = String(cfg.capTicks);
    if (cfg.maxKills !== undefined) env.MAX_KILLS = String(cfg.maxKills);
    if (cfg.spot) env.SPOT = cfg.spot;
    if (cfg.bank) env.TRAIN_BANK = cfg.bank;
    const cap = cfg.capTicks ?? Number(env.CAP ?? site.defaultCapTicks);
    const { isStopped } = watchWorkerStop(session, cfg.stop);
    await Promise.resolve();
    const initialPlayer = session.sdk.getState()?.player;
    const initialLifeId = initialPlayer?.lifeId;
    const initialRespawns = initialPlayer?.respawnCount ?? 0;
    const sessionDied = (): boolean => {
        const st = session.sdk.getState();
        const p = st?.player;
        if (!p) return false;
        const hp = st?.skills?.find(k => k.name === 'Hitpoints')?.level;
        return Boolean(
            p.isDead
            || (hp !== undefined && hp <= 0)
            || (p.respawnCount ?? 0) > initialRespawns
            || (initialLifeId !== undefined && p.lifeId !== undefined && p.lifeId !== initialLifeId),
        );
    };

    try {
        let result: unknown;
        switch (mode) {
            case 'chicken': {
                const { trainChickens } = await import('./chickens');
                result = await trainChickens(
                    session,
                    cap,
                    cfg.bank ?? env.TRAIN_BANK ?? 'draynor',
                    Number(env.TRAIN_COMBAT ?? 13) as 13 | 29,
                    { trainSkill: cfg.targetSkill ?? env.TRAIN_SKILL, targetLevel: cfg.targetLevel, stop: isStopped },
                );
                break;
            }
            case 'cow': {
                const { cowProfile, runCows } = await import('./melee-gather');
                const bankProfile = env.COW_BANK_PROFILE ?? 'south';
                const foodMode = env.COW_FOOD_MODE ?? (bankProfile === 'north' ? 'banked' : 'held');
                const defaultMaxKills = bankProfile === 'north' ? (foodMode === 'banked' ? 9 : 8) : 5;
                const maxKills = cfg.maxKills ?? Number(env.MAX_KILLS ?? defaultMaxKills);
                cowProfile(bankProfile, foodMode, maxKills);
                result = await runCows(session, {
                    cap,
                    maximum: maxKills,
                    trainSkill: cfg.targetSkill ?? env.TRAIN_SKILL ?? 'Defence',
                    targetLevel: cfg.targetLevel ?? Number(env.TARGET_LEVEL ?? 40),
                    foodMode,
                    bankProfile,
                    stop: isStopped,
                    ...(hooks.walk ? { walk: hooks.walk } : {}),
                });
                break;
            }
            case 'druid':
            case 'unicorn':
            case 'wizard':
            case 'giant':
            case 'trooper':
            case 'taverley_druid':
            case 'taverley_black_knight':
            case 'taverley_scales':
            case 'taverley_blue_dragon':
            case 'taverley_black_dragon':
            case 'taverley_giant':
            case 'chaos_wine': {
                const { TROOPER_SITE, giantKillLimit, runGenericCombatSession, runGiants } = await import('./melee-gather');
                const isGiantTrained =
                    mode === 'trooper'
                    || (mode === 'giant'
                        && (cfg.targetSkill !== undefined
                            || cfg.targetLevel !== undefined
                            || env.TRAIN_SKILL !== undefined
                            || env.TARGET_LEVEL !== undefined
                            || env.GIANT_KILLS !== undefined));
                if (isGiantTrained) {
                    result = await runGiants(session, {
                        cap,
                        trainSkill: cfg.targetSkill ?? env.TRAIN_SKILL ?? 'Strength',
                        targetLevel: cfg.targetLevel ?? Number(env.TARGET_LEVEL ?? 99),
                        site: mode === 'trooper' ? TROOPER_SITE : undefined,
                        food: env.GIANT_FOOD === undefined ? undefined : Number(env.GIANT_FOOD),
                        maximum: cfg.maxKills ?? giantKillLimit(env.MAX_KILLS ?? env.GIANT_KILLS),
                        bury: env.GIANT_BURY === '1',
                        stop: isStopped,
                        ...(hooks.walk ? { walk: hooks.walk } : {}),
                    });
                } else {
                    result = await runGenericCombatSession(session, {
                        target: mode,
                        cap,
                        maximum: cfg.maxKills ?? (env.MAX_KILLS !== undefined ? Number(env.MAX_KILLS) : undefined),
                        untilItemName: env.UNTIL_ITEM,
                        env,
                        stop: isStopped,
                    });
                }
                break;
            }
            case 'fire-giant':
                result = await (await import('./special-mobs')).runFireReclaim(session, { cap, stop: isStopped });
                break;
            case 'fire-combat':
                result = await (await import('./special-mobs')).runFireCombat(session, { cap, stop: isStopped });
                break;
            case 'imp':
                result = await (await import('./special-mobs')).runImps(session, { cap, maximum: cfg.maxKills ?? Number(env.MAX_KILLS ?? 1), stop: isStopped });
                break;
            case 'shade': {
                const { runShadeTrips, validateShadeJob } = await import('./special-mobs');
                const jobPath = cfg.args?.[0];
                if (!jobPath) throw Error('shade mode requires explicit job file path');
                const job = validateShadeJob(JSON.parse(readFileSync(jobPath, 'utf8')) as ShadeJob);
                result = await runShadeTrips(session, job, isStopped);
                break;
            }
            case 'chompy': {
                const { chompyEnergyOption, runChompyTrip } = await import('./special-mobs');
                result = await runChompyTrip(session, {
                    kills: cfg.maxKills ?? Number(cfg.args?.[0] ?? 1),
                    perTrip: Number(cfg.args?.[1] ?? 1),
                    cap: Number(cfg.args?.[2] ?? cap),
                    returnTicks: 300,
                    protectMelee: true,
                    prayerPotions: cfg.maxKills ?? Number(cfg.args?.[0] ?? 1),
                    energy: chompyEnergyOption(env),
                }, isStopped);
                break;
            }
            case 'chompy-at-site':
                result = await (await import('./special-mobs')).runChompy(session, {
                    kills: cfg.maxKills ?? Number(cfg.args?.[0] ?? 1),
                    cap: Number(cfg.args?.[1] ?? cap),
                    maxBaits: Number(cfg.args?.[2] ?? 5),
                    stop: isStopped,
                });
                break;
            case 'ranged': {
                const { rangedTrainOptions, runAdaptiveRanged } = await import('./ranged');
                const o = rangedTrainOptions(env, ['bun', 'aio-fighter.ts', session.name, ...(cfg.args ?? [])]);
                result = await runAdaptiveRanged(session, { ...o, cap, stop: isStopped }, hooks);
                break;
            }
            case 'ranged-starter':
                result = await (await import('./ranged')).runRangedStarter(session, isStopped, hooks.leaveStarter);
                break;
            case 'ranged-gather':
                result = await (await import('./ranged')).runRanged(session, {
                    cap,
                    maximum: cfg.maxKills ?? Number(env.MAX_KILLS ?? 2),
                    ammo: Number(env.AMMO ?? 90),
                    food: Number(env.FOOD ?? 3),
                    foodId: Number(env.FOOD_ID ?? 333),
                    telegrab: telegrabPolicy(env),
                    alch: combatAlchPolicy(env),
                    potions: combatPotionPolicy(env),
                    stop: isStopped,
                });
                break;
            case 'ranged-camp': {
                const { BLUE_DRAGON, runRangedCamp } = await import('./ranged');
                result =
                    env.STAGED === '1'
                        ? await runRangedCamp(session, BLUE_DRAGON, { cap, stop: isStopped })
                        : await combatTrip(session, 'blue', tripStop => runRangedCamp(session, BLUE_DRAGON, { cap: 2500, stop: () => tripStop() || isStopped(), returnSafe: false }), { cap, stop: isStopped });
                break;
            }
            case 'cannon': {
                const { CANNON_SPOTS, buyCannon, parseLevels, parsePhases, reclaimCannon, runCannonFight } = await import('./cannon');
                const spotName = cfg.spot ?? env.SPOT ?? 'spiders';
                const spot = Object.prototype.hasOwnProperty.call(CANNON_SPOTS, spotName) ? CANNON_SPOTS[spotName] : undefined;
                if (!spot) throw Error(`unknown cannon spot: ${spotName} (known: ${Object.keys(CANNON_SPOTS).join(', ')})`);
                if (env.MODE === 'buy') result = await buyCannon(session, { walk: cannonWalkerProxy(session, spot) });
                else if (env.MODE === 'reclaim') result = await reclaimCannon(session, { walk: cannonWalkerProxy(session, spot) });
                else {
                    result = await runCannonFight(session, {
                        spot,
                        cap,
                        stop: env.STOP ? parseLevels(env.STOP) : { [cfg.targetSkill ?? env.STOP_SKILL ?? 'Ranged']: cfg.targetLevel ?? Number(env.STOP_LEVEL ?? 99) },
                        phases: env.PHASES ? parsePhases(env.PHASES) : [{ ...(env.STYLE === undefined ? {} : { style: Number(env.STYLE) }) }],
                        reload: Number(env.RELOAD ?? 20),
                        prayer: (env.PRAYER ?? spot.prayer) as any,
                        special: env.SPECIAL !== '0',
                    });
                }
                break;
            }
            case 'loot-trip': {
                const { runLootTrip } = await import('./special-mobs');
                const jobPath = cfg.args?.[0];
                if (!jobPath) throw Error('loot-trip mode requires explicit job file path');
                const job = JSON.parse(readFileSync(jobPath, 'utf8')) as LootTripJob;
                result = await runLootTrip(session, job, isStopped);
                break;
            }
            case 'kbd': {
                const { runKbdOne } = await import('./boss-minigame');
                result =
                    env.STAGED === '1'
                        ? await runKbdOne(session, { cap, stop: isStopped })
                        : await combatTrip(session, 'kbd', tripStop => runKbdOne(session, { cap, stop: () => tripStop() || isStopped() }), {
                              cap: Number(env.TRIP_CAP ?? 5000),
                              stop: isStopped,
                          });
                break;
            }
            case 'black-dragon': {
                const { runBlackDragonCamp } = await import('./boss-minigame');
                const kills = cfg.maxKills ?? Number(env.KILLS ?? 9);
                result =
                    env.STAGED === '1'
                        ? await runBlackDragonCamp(session, { cap, kills, stop: isStopped })
                        : await combatTrip(
                              session,
                              'black',
                              tripStop => runBlackDragonCamp(session, { cap: 5000, kills, stop: () => tripStop() || isStopped() }),
                              { cap, stop: isStopped, kit: blackKit(env.ARROW ?? 'mithril_arrow', Number(env.ARROWS ?? 700)) },
                          );
                break;
            }
            case 'blue-dragon': {
                const { BLUE_DRAGON, runRangedCamp } = await import('./ranged');
                result = await combatTrip(session, 'blue', tripStop => runRangedCamp(session, BLUE_DRAGON, { cap: 2500, stop: () => tripStop() || isStopped(), returnSafe: false }), { cap, stop: isStopped });
                break;
            }
            case 'green-dragon': {
                const { runWildDragons } = await import('./boss-minigame');
                result = await runWildDragons(session, {
                    cap,
                    foodCount: Number(env.FOOD_COUNT ?? 10),
                    eatAt: Number(env.EAT_AT ?? 45),
                    escapeAt: Number(env.ESCAPE_AT ?? 30),
                    maxTrips: Number(env.MAX_TRIPS ?? 10),
                    staged: env.STAGED === '1',
                    stop: isStopped,
                });
                break;
            }
            case 'trawler':
                result = await (await import('./boss-minigame')).runTrawlerTrip(session, { cap, collectOnly: cfg.args?.includes('--collect-only'), stop: isStopped });
                break;
            case 'trawler-at-site':
                if (cfg.args?.[0] === 'trip') result = await (await import('./boss-minigame')).runTrawlerTrip(session, { cap: Number(cfg.args?.[1] ?? cap), stop: isStopped });
                else throw Error('trawler-at-site WorkerModule supports trip subcommand; use CLI for support driver');
                break;
            case 'magic-order': {
                const { magicOptions, runMagicOrder } = await import('./magic');
                const opts = magicOptions({
                    ...env,
                    ...(cfg.targetLevel !== undefined ? { TARGET_LEVEL: String(cfg.targetLevel) } : {}),
                    ...(cfg.capTicks !== undefined ? { MAGIC_CAP: String(cfg.capTicks) } : {}),
                });
                result = await runMagicOrder(session, opts, isStopped);
                break;
            }
            case 'magic-npc': {
                const { nativeNpcSpell, runNpcMagic } = await import('./magic');
                const [spellName = 'wind_strike', npcArg = '1', castsArg = '1', capArg] = cfg.args ?? [];
                const spell = nativeNpcSpell(spellName);
                const combo = env.COMBO_ALCH
                    ? hooks.comboRecipe
                        ? hooks.comboRecipe(env.COMBO_ALCH, env.ALCH_ITEM)
                        : combatMagicRecipe(env.COMBO_ALCH as 'low-alch' | 'high-alch', env.ALCH_ITEM!)
                    : undefined;
                result = await runNpcMagic(session, spell, {
                    npc: Number(npcArg),
                    casts: Number(castsArg),
                    cap: Number(capArg ?? cap),
                    splashOnly: env.SPLASH_ONLY === '1',
                    combo,
                    teleport: env.COMBO_TELEPORT,
                    members: cfg.members ?? env.MEMBERS === '1',
                    stop: isStopped,
                    runComboItem: hooks.runComboItem,
                    runComboTeleport: hooks.runComboTeleport,
                });
                break;
            }
            case 'magic-splash':
            case 'magic-splash-coop': {
                const { runSplash, splashSite } = await import('./magic');
                const target = cfg.targetLevel ?? Number(cfg.args?.[0] ?? 13);
                const splashCap = Number(cfg.args?.[1] ?? cap);
                const defaultSite = mode === 'magic-splash-coop' ? 'coop' : undefined;
                result = await runSplash(session, {
                    target,
                    cap: splashCap,
                    site: splashSite(env.SPLASH_SITE || defaultSite || undefined),
                    stop: isStopped,
                    leaveStarter: hooks.leaveStarter,
                });
                break;
            }
            case 'prayer-flick': {
                const { withCombatPrayer, withIncomingProtection } = await import('./prayer-flick');
                if (env.INCOMING_PROTECTION === '1') {
                    const { nativeCombatTeleport, nativeNpcSpell, runCombatTeleport, runNpcMagic } = await import('./magic');
                    const [castsArg = '3', capArg = '500'] = cfg.args ?? [];
                    const raw = await withIncomingProtection(
                        session,
                        { cap: Number(capArg), hpFloor: 70, spell: 'wind_strike', stop: isStopped },
                        async (owned, stopped, finishCombat) => {
                            const magic = await runNpcMagic(owned, nativeNpcSpell('wind_strike'), {
                                npc: 7,
                                casts: Number(castsArg),
                                cap: Number(capArg) - 30,
                                members: true,
                                stop: stopped,
                            });
                            finishCombat();
                            if (magic.casts === 0) return { ok: false, magic, escape: { ok: false, stop: 'no owned paid combat; no escape input' } };
                            const escape = await runCombatTeleport(owned, nativeCombatTeleport('varrock'), {
                                casts: 1,
                                cap: 30,
                                members: true,
                                stop: stopped,
                            });
                            return { ok: magic.ok && escape.ok, magic, escape };
                        },
                    );
                    result = { ok: raw.ok && !!raw.result?.ok, units: raw.attacksProtected, failure: raw.failure };
                } else {
                    const { runCows } = await import('./melee-gather');
                    const [prayerArg = '10', maximumArg = '1', capArg] = cfg.args ?? [];
                    const prayerCap = Number(capArg ?? cap);
                    const raw = await withCombatPrayer(
                        session,
                        { prayer: Number(prayerArg), cap: prayerCap, hpFloor: 40, stop: isStopped },
                        stopFn => runCows(session, { cap: prayerCap, maximum: Number(maximumArg), stop: () => stopFn() || isStopped() }),
                    );
                    result = { ok: raw.ok && !!raw.result?.ok, kills: raw.result?.creditedKills ?? 0, failure: raw.failure };
                }
                break;
            }
            default: {
                const _exhaustive: never = mode;
                throw Error(`unhandled combat mode: ${String(_exhaustive)}`);
            }
        }
        const xpGained = computeXpDelta(xpBefore, snapshotSkillXp(session));
        const itemsDelta = computeItemsDelta(itemsBefore, snapshotOwnedItems(session));
        return parseModeResult(mode, session.name, Math.max(0, session.tick() - startTick), Date.now() - startMs, xpGained, itemsDelta, result, {
            sessionDied: sessionDied(),
            stopped: isStopped(),
        });
    } catch (e) {
        await Promise.resolve();
        const msg = String(e);
        const xpGained = computeXpDelta(xpBefore, snapshotSkillXp(session));
        const itemsDelta = computeItemsDelta(itemsBefore, snapshotOwnedItems(session));
        const ticksElapsed = Math.max(0, session.tick() - startTick);
        const durationMs = Date.now() - startMs;
        if (sessionDied() || /died|dead|hitpoints.*0/i.test(msg)) {
            return {
                kind: 'death',
                activityId: site.activityId,
                account: session.name,
                ticksElapsed,
                durationMs,
                xpGained,
                itemsDelta,
                pos: normalizePos(session),
                faultSignature: `combat:${mode}:death`,
                detail: msg,
            };
        }
        if (isStopped() || /stop|interrupt|disconnect|ended|timeout|budget/i.test(msg)) {
            return {
                kind: 'session_unsettled',
                activityId: site.activityId,
                account: session.name,
                ticksElapsed,
                durationMs,
                xpGained,
                itemsDelta,
                reason: isStopped() ? 'stopped' : msg,
                detail: msg,
            };
        }
        if (/missing|absent|short|require.*item|food.*exhaust|stock/i.test(msg)) {
            return {
                kind: 'missing_supply',
                activityId: site.activityId,
                account: session.name,
                ticksElapsed,
                durationMs,
                xpGained,
                itemsDelta,
                missing: [{ itemId: 0, required: 1, available: 0, itemName: `${mode}-supply` }],
                summary: msg,
            };
        }
        if (/walk|route|stranded|lair|dungeon|position/i.test(msg)) {
            return {
                kind: 'location_stranded',
                activityId: site.activityId,
                account: session.name,
                ticksElapsed,
                durationMs,
                xpGained,
                itemsDelta,
                pos: normalizePos(session),
                detail: msg,
            };
        }
        return {
            kind: 'worker_defect',
            activityId: site.activityId,
            account: session.name,
            ticksElapsed,
            durationMs,
            xpGained,
            itemsDelta,
            faultSignature: `combat:${mode}:exception`,
            detail: msg,
        };
    }
}

function cannonWalkerProxy(s: CombatSession, spot: CannonSpot) {
    // Reclaim/buy paths use default cannonWalker when called via runCombatModuleSession.
    return async (to: { x: number; z: number; level: number }) => {
        const { walkPath, sessionWalker } = await import('../../../core/src/walk');
        const r = await walkPath(await sessionWalker(s as any), [{ ...to, tol: 1 }], { maxTicks: 180 });
        return r.ok;
    };
}

export const combatWorkerModule: WorkerModule<CombatConfig, WorkerAccountView, WorkerWorldView, CombatSession> = {
    id: 'combat:aio',
    family: 'combat',
    kind: 'train',
    trust: 'practice_passed',
    preflight(acct: WorkerAccountView, cfg: CombatConfig, world: WorkerWorldView): PreflightResult {
        return combatPreflight(acct, cfg, world);
    },
    estimate(acct: WorkerAccountView, cfg: CombatConfig, world: WorkerWorldView): RateEstimate {
        return combatEstimate(acct, cfg, world);
    },
    async run(session: CombatSession, cfg: CombatConfig): Promise<RunOutcome> {
        return runCombatModuleSession(session, cfg);
    },
};

export async function runCombatModeCli(
    account: string,
    targetInput: string,
    rest: readonly string[] = [],
    envInput: Record<string, string | undefined> = process.env,
    hooks: CombatRunnerHooks = {},
): Promise<void> {
    const mode = targetInput.toLowerCase().replace(/^--(?:target|boss)=/, '') as CombatMode;
    const { positional, env } = splitArgsAndEnv(rest, envInput);
    switch (mode) {
        case 'chicken':
            await (await import('./chickens')).runChickenCli(account, env);
            return;
        case 'cow':
        case 'druid':
        case 'unicorn':
        case 'wizard':
        case 'giant':
        case 'trooper':
        case 'taverley_druid':
        case 'taverley_black_knight':
        case 'taverley_scales':
        case 'taverley_blue_dragon':
        case 'taverley_black_dragon':
        case 'taverley_giant':
        case 'chaos_wine': {
            const { CONFIGS, runMeleeGatherCli } = await import('./melee-gather');
            const firstPos = positional[0];
            const firstIsTarget = !!firstPos && (firstPos.toLowerCase() === 'cow' || Object.prototype.hasOwnProperty.call(CONFIGS, firstPos.toLowerCase()));
            const meleeArgs = !firstPos
                ? [env.CAP ?? (mode === 'cow' ? '3000' : '1500'), mode]
                : firstIsTarget
                    ? [env.CAP ?? (mode === 'cow' ? '3000' : '1500'), firstPos, ...positional.slice(1)]
                    : [firstPos, positional[1] ?? mode, ...positional.slice(2)];
            await runMeleeGatherCli(account, meleeArgs, env, hooks);
            return;
        }
        case 'fire-giant':
            await (await import('./special-mobs')).runFireReclaimCli([account, ...positional], env);
            return;
        case 'fire-combat':
            await (await import('./special-mobs')).runFireCombatCli([account, ...positional], env);
            return;
        case 'imp':
            await (await import('./special-mobs')).runImpsCli([account, ...positional], env);
            return;
        case 'shade':
            await (await import('./special-mobs')).runShadeTripCli([account, ...positional]);
            return;
        case 'chompy':
            await (await import('./special-mobs')).runChompyTripCli([account, ...positional], env);
            return;
        case 'chompy-at-site':
            await (await import('./special-mobs')).runChompyCli([account, ...positional]);
            return;
        case 'ranged': {
            const { rangedComparisonMethod, rangedTrainOptions, runAdaptiveRanged } = await import('./ranged');
            let stopped = false;
            const s = await openBot(account, {
                onStop: async () => {
                    stopped = true;
                },
            });
            try {
                const comparison = rangedComparisonMethod(
                    env.RANGED_COMPARE_METHOD,
                    s.lifecycle?.server ?? new URL(s.sdk.config.browserLaunchUrl).host,
                );
                const argv = ['bun', 'aio-fighter.ts', account, ...positional];
                const r = await runAdaptiveRanged(s, { ...rangedTrainOptions(env, argv), stop: () => stopped }, { ...hooks, comparison });
                console.log('RANGED_TRAIN_RESULT ' + JSON.stringify(r));
                await finish(
                    [s],
                    r.ok,
                    (r.ok ? 'mode=ranged-train ' : r.stop === 'stop-file' ? 'stop file ' : 'no Ranged progress: ') + JSON.stringify(r),
                );
            } catch (e) {
                await finish([s], false, 'no Ranged progress: ' + String(e));
            }
            return;
        }
        case 'ranged-starter':
            await (await import('./ranged')).runRangedStarterCli(account, hooks.leaveStarter);
            return;
        case 'ranged-gather':
            await (await import('./ranged')).runRangedGatherCli(account, env);
            return;
        case 'ranged-camp':
            await (await import('./ranged')).runRangedCampCli(account, positional, env);
            return;
        case 'cannon':
            await (await import('./cannon')).runCannonCli(account, env);
            return;
        case 'loot-trip':
            await (await import('./special-mobs')).runLootTripCli([account, ...positional], env);
            return;
        case 'kbd':
            await (await import('./boss-minigame')).runKbdCli([account, ...positional], env);
            return;
        case 'black-dragon':
            await (await import('./boss-minigame')).runBlackDragonCli([account, ...positional], env);
            return;
        case 'blue-dragon':
            await (await import('./ranged')).runRangedCampCli(account, positional, env);
            return;
        case 'green-dragon':
            await (await import('./boss-minigame')).runWildDragonsCli([account, ...positional], env);
            return;
        case 'trawler':
            await (await import('./boss-minigame')).runTrawlerTripCli([account, ...positional]);
            return;
        case 'trawler-at-site':
            await (await import('./boss-minigame')).runTrawlerSupportCli([account, ...positional], env);
            return;
        case 'magic-order':
            await (await import('./magic')).runMagicOrderCli(account, env);
            return;
        case 'magic-npc':
            await (await import('./magic')).runNpcMagicCli([account, ...positional], env, hooks);
            return;
        case 'magic-splash':
            await (await import('./magic')).runSplashCli([account, ...positional], env, undefined, hooks.leaveStarter);
            return;
        case 'magic-splash-coop':
            await (await import('./magic')).runSplashCli([account, ...positional], env, 'coop', hooks.leaveStarter);
            return;
        case 'prayer-flick':
            await (await import('./prayer-flick')).runPrayerFlickCli([account, ...positional], env);
            return;
        default:
            throw Error(`combat: unsupported mode "${targetInput}"`);
    }
}
