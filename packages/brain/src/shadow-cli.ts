// Full-fleet offline shadow verification CLI (ZERO live logins, read-only over --root).
// Produces structured JSON and readable summary across all owned accounts, verifying:
// fresh accounts, high-quest/artisan veterans, maxed tribrids, Campaign supply bills,
// Mission gating (paused = 0 demand), protected-clock safety (Haggis & 19 Specialists),
// anti-ping-pong transfers, recovery ordering, and ScriptAdapter invocations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadOwners } from '../../core/src/fleet';
import {
    findStopFile,
    liveRoot,
    practiceRoot,
    resolveFleetDataDir,
    statusReadDirs,
} from '../../core/src/practice-paths';
import { readLogoutProof, type LogoutProof } from '../../core/src/session-lifecycle';
import { RESERVED_ACCOUNTS, SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import {
    DEFAULT_RETENTION_MARGIN_RATIO,
    HUB_BANKER_LOCATIONS,
    accountFrozenValue,
    canScheduleTransferOrder,
    isAccountPlan,
    isCampaign,
    isFleetPlan,
    isFleetState,
    isMission,
    isProtectedAccountName,
    isTransferOrder,
    missionEffectiveWeight,
    validateFleetPlan,
    validateFleetState,
    type AccountLifecycle,
    type AccountPlan,
    type AccountRole,
    type AccountState,
    type ActivityDefinition,
    type Campaign,
    type FleetPlan,
    type FleetState,
    type GoalDemand,
    type Mission,
    type TransferOrder,
    type WorldSnapshot,
} from './contracts';
import { loadMarketQuotesFromRoot, type MarketQuotesMap } from './acquire';
import { canProtectedAccountLaunch, planAccount } from './planner';
import { buildFleetState, scheduleFleet } from './scheduler';
import { adaptAccountPlan, type AdaptedAccountPlan } from './script-adapter';

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const ACCOUNT_KEY_RE = /^[A-Za-z0-9_ -]{1,12}$/;

export interface ShadowVerificationCheck {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface ShadowVerificationSummary {
    readonly totalOwnedAccounts: number;
    readonly sideAccounts: number;
    readonly sideStopped: boolean;
    readonly maxBots: number;
    readonly selectedSlots: number;
    readonly lifecycleCounts: Readonly<Record<AccountLifecycle, number>>;
    readonly roleCounts: Readonly<Record<AccountRole, number>>;
    readonly protectedAccountsCount: number;
    readonly protectedAccountsIdle: number;
    readonly recoveryQueueLength: number;
    readonly activeChainsCount: number;
    readonly transferOrdersCount: number;
    readonly adaptedPlansCount: number;
    readonly checksPassed: number;
    readonly checksTotal: number;
}

export interface ShadowVerificationReport {
    readonly root: string;
    readonly side: string;
    readonly server: string;
    readonly at: number;
    readonly liveLoginsPerformed: 0;
    readonly summary: ShadowVerificationSummary;
    readonly checks: readonly ShadowVerificationCheck[];
    readonly fleetPlan: FleetPlan;
    readonly fleetState: FleetState;
    readonly adaptedPlans: Readonly<Record<string, AdaptedAccountPlan>>;
    readonly sampleAssignments: readonly {
        readonly account: string;
        readonly role: AccountRole;
        readonly lifecycle: AccountLifecycle;
        readonly steps: number;
        readonly demandId?: string;
        readonly scorePerHour: number;
        readonly script?: string;
        readonly idleReason?: string;
    }[];
}

export interface ShadowProvider {
    loadSnapshot(opts: { root: string; now: number; side: string; server: string }): WorldSnapshot;
    loadActivities(opts: { root: string }): readonly ActivityDefinition[];
    loadDemands(opts: { root: string; world: WorldSnapshot; campaigns: readonly Campaign[]; missions: readonly Mission[] }): readonly GoalDemand[];
    loadCampaigns?(opts: { root: string; world: WorldSnapshot }): readonly Campaign[];
    loadMissions?(opts: { root: string; world: WorldSnapshot }): readonly Mission[];
    loadMarketQuotes?(opts: { root: string }): MarketQuotesMap;
}

export interface RunShadowOptions {
    readonly root?: string;
    readonly now?: number;
    readonly side?: string;
    readonly server?: string;
    readonly maxBots?: number;
    readonly ignoreSideStop?: boolean;
    readonly provider?: ShadowProvider;
}

function readJsonSafe<T>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function defaultActivities(): ActivityDefinition[] {
    return [
        {
            id: 'gather:fishing-shark',
            workerId: 'gather',
            family: 'gather',
            kind: 'gather',
            label: 'Catch sharks at Catherby',
            skill: 'Fishing',
            spotId: 'catherby-sharks',
            maxConcurrentAccounts: 4,
            config: { aioCategory: 'skiller', aioRoute: 'fishing:shark', skill: 'fishing', method: 'shark', requiredLevel: 76 },
            baselineRate: { xpPerTick: 110, unitsPerTick: 0.08, gpPerTick: 65, setupTicks: 40, minBatchUnits: 50, confidence: 'model', outputsPerUnit: { 383: 1 } },
            outputs: [{ itemId: 383, countPerUnit: 1 }],
            location: { x: 2835, z: 3432, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'bank-artisan:cook-shark',
            workerId: 'bank-artisan',
            family: 'bank-artisan',
            kind: 'produce',
            label: 'Cook raw sharks at Catherby range',
            skill: 'Cooking',
            config: { aioCategory: 'skiller', aioRoute: 'cooking:food', skill: 'cooking', method: 'food', defaultArgs: ['2000', 'shark'], requiredLevel: 80 },
            baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 25, minBatchUnits: 50, confidence: 'practice', outputsPerUnit: { 385: 1 } },
            inputs: [{ itemId: 383, countPerUnit: 1 }],
            outputs: [{ itemId: 385, countPerUnit: 1 }],
            location: { x: 2817, z: 3443, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'gather:fishing-lobster',
            workerId: 'gather',
            family: 'gather',
            kind: 'gather',
            label: 'Catch lobsters at Catherby',
            skill: 'Fishing',
            spotId: 'catherby-lobsters',
            maxConcurrentAccounts: 4,
            config: { aioCategory: 'skiller', aioRoute: 'fishing:cage', skill: 'fishing', method: 'cage', requiredLevel: 40, requiredTools: [301] },
            baselineRate: { xpPerTick: 90, unitsPerTick: 0.14, gpPerTick: 25, setupTicks: 35, minBatchUnits: 50, confidence: 'practice', outputsPerUnit: { 377: 1 } },
            outputs: [{ itemId: 377, countPerUnit: 1 }],
            location: { x: 2835, z: 3432, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'gather:thieving-knights',
            workerId: 'gather',
            family: 'gather',
            kind: 'gather',
            label: 'Pickpocket Knights of Ardougne',
            skill: 'Thieving',
            spotId: 'ardougne-knights',
            maxConcurrentAccounts: 6,
            config: { aioCategory: 'skiller', aioRoute: 'thieving:knights', skill: 'thieving', method: 'knights', requiredLevel: 55 },
            baselineRate: { xpPerTick: 84, unitsPerTick: 0.35, gpPerTick: 35, setupTicks: 20, minBatchUnits: 100, confidence: 'practice' },
            location: { x: 2654, z: 3294, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'gather:thieving-bootstrap55',
            workerId: 'gather',
            family: 'gather',
            kind: 'train',
            label: 'Thieving fresh bootstrap to 55',
            skill: 'Thieving',
            config: { aioCategory: 'skiller', aioRoute: 'thieving:bootstrap55', skill: 'thieving', method: 'bootstrap55' },
            baselineRate: { xpPerTick: 30, unitsPerTick: 0.25, gpPerTick: 12, setupTicks: 15, minBatchUnits: 50, confidence: 'practice' },
            location: { x: 2669, z: 3310, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'gather:mining-ore',
            workerId: 'gather',
            family: 'gather',
            kind: 'gather',
            label: 'Mine iron/copper ore at Varrock East',
            skill: 'Mining',
            config: { aioCategory: 'skiller', aioRoute: 'mining:ore', skill: 'mining', method: 'ore' },
            baselineRate: { xpPerTick: 45, unitsPerTick: 0.2, gpPerTick: 18, setupTicks: 20, minBatchUnits: 28, confidence: 'practice', outputsPerUnit: { 440: 1 } },
            outputs: [{ itemId: 440, countPerUnit: 1 }],
            location: { x: 3286, z: 3368, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'combat:chicken-starter',
            workerId: 'combat',
            family: 'combat',
            kind: 'train',
            label: 'Train starter melee on chickens',
            skill: 'Strength',
            skills: ['Attack', 'Strength', 'Defence', 'Hitpoints'],
            config: { aioCategory: 'fighter', aioRoute: 'chicken', target: 'chicken' },
            baselineRate: { xpPerTick: 28, unitsPerTick: 0.1, gpPerTick: 5, setupTicks: 15, minBatchUnits: 25, confidence: 'practice' },
            location: { x: 3180, z: 3295, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'combat:trooper-train',
            workerId: 'combat',
            family: 'combat',
            kind: 'train',
            label: 'Train combat on Khazard troopers',
            skill: 'Strength',
            skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged'],
            config: { aioCategory: 'fighter', aioRoute: 'trooper', target: 'trooper', requiredSkills: { Attack: 60, Strength: 60, Defence: 60 }, combatSurvivability: { minFoodHeal: 100 } },
            baselineRate: { xpPerTick: 180, unitsPerTick: 0.15, gpPerTick: 20, setupTicks: 25, minBatchUnits: 50, confidence: 'practice' },
            location: { x: 2608, z: 3168, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'pvp:wildy-hunt',
            workerId: 'pvp',
            family: 'pvp',
            kind: 'pk',
            label: 'Wilderness PK army hunt & control',
            skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'],
            config: { aioCategory: 'pvp', aioRoute: 'hunt', mode: 'hunt', requiredSkills: { Attack: 85, Strength: 85, Defence: 85, Hitpoints: 85, Ranged: 85, Magic: 85, Prayer: 43 }, combatSurvivability: { minDefence: 85, minHitpoints: 85, minFoodHeal: 180, requireProtectionPrayer: true } },
            baselineRate: { xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 250, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
            location: { x: 3094, z: 3494, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'quest:sweep-cook',
            workerId: 'quest',
            family: 'quest',
            kind: 'quest',
            label: "Complete Cook's Assistant",
            questSlug: 'cook',
            config: { aioCategory: 'quester', aioRoute: 'cook', questSlug: 'cook', mode: 'sweep' },
            baselineRate: { xpPerTick: 120, unitsPerTick: 0.01, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'practice' },
            location: { x: 3207, z: 3214, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'quest:sweep-legends',
            workerId: 'quest',
            family: 'quest',
            kind: 'quest',
            label: 'Complete Legends Quest',
            questSlug: 'legends',
            config: { aioCategory: 'quester', aioRoute: 'legends', questSlug: 'legends', mode: 'sweep', requiredQuests: ['hero', 'upass', 'waterfall'], requiredSkills: { Agility: 50, Crafting: 50, Herblore: 45, Mining: 52, Prayer: 42, Smithing: 50, Strength: 50, Thieving: 50, Woodcutting: 50 } },
            baselineRate: { xpPerTick: 450, unitsPerTick: 0.002, gpPerTick: 0, setupTicks: 40, minBatchUnits: 1, confidence: 'practice' },
            location: { x: 2728, z: 3348, level: 0 },
            trust: 'practice_passed',
        },
        {
            id: 'market:ge-buy',
            workerId: 'market',
            family: 'market',
            kind: 'ge_buy',
            label: 'Grand Exchange buy order',
            config: { aioCategory: 'market', aioRoute: 'ge-buy', mode: 'ge-buy' },
            baselineRate: { xpPerTick: 0, unitsPerTick: 5, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
            location: { x: 3164, z: 3487, level: 0 },
            trust: 'practice_passed',
        },
    ];
}

function loadStatusByAccount(root: string): Map<string, any> {
    const out = new Map<string, any>();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
        for (const f of files) {
            const doc = readJsonSafe<any>(join(dir, f));
            if (!doc || typeof doc.name !== 'string' || !ACCOUNT_KEY_RE.test(doc.name)) continue;
            const key = doc.name.toLowerCase();
            const prev = out.get(key);
            if (!prev || (Number(doc.at) || 0) > (Number(prev.at) || 0)) {
                out.set(key, doc);
            }
        }
    }
    return out;
}

function inferRole(name: string, skills: Record<string, { level: number; xp: number }>): AccountRole {
    const lower = name.toLowerCase();
    if (lower === 'haggis') return 'main';
    if (Object.hasOwn(SPECIALIST_BOARDS, lower) || isProtectedAccountName(name)) return 'specialist';
    const atk = skills.Attack?.level ?? 1;
    const str = skills.Strength?.level ?? 1;
    const def = skills.Defence?.level ?? 1;
    if (Math.min(atk, str, def) >= 85) return 'army';
    return 'auto';
}

function loadFallbackWorldSnapshot(opts: { root: string; now: number; side: string; server: string }): WorldSnapshot {
    const { root, now, side, server } = opts;
    const fleetDir = existsSync(join(resolveFleetDataDir(root), 'fleet', 'owners.json'))
        ? join(resolveFleetDataDir(root), 'fleet')
        : join(root, 'fleet');
    const owners = loadOwners(join(fleetDir, 'owners.json'));
    const rawOwners = readJsonSafe<{ accounts?: Record<string, unknown> }>(join(fleetDir, 'owners.json'));
    const statusByAcct = loadStatusByAccount(root);
    const fleetSnapshotsDir = join(fleetDir, 'snapshots');
    const snapshotRows = new Map<string, any>();
    if (existsSync(fleetSnapshotsDir)) {
        for (const f of readdirSync(fleetSnapshotsDir).filter((x) => x.endsWith('.json'))) {
            const snap = readJsonSafe<{ accounts?: any[] }>(join(fleetSnapshotsDir, f));
            for (const row of snap?.accounts ?? []) {
                if (typeof row?.name === 'string') {
                    snapshotRows.set(row.name.toLowerCase(), row);
                }
            }
        }
    }

    const allNames = new Map<string, string>();
    for (const [lower] of owners) allNames.set(lower, lower);
    if (rawOwners?.accounts) {
        for (const key of Object.keys(rawOwners.accounts)) {
            if (ACCOUNT_KEY_RE.test(key)) allNames.set(key.toLowerCase(), key);
        }
    }
    for (const name of RESERVED_ACCOUNTS) {
        if (!allNames.has(name.toLowerCase())) {
            allNames.set(name.toLowerCase(), name);
        }
    }
    for (const [lower, st] of statusByAcct) {
        if (typeof st.name === 'string' && (!st.server || String(st.server).toLowerCase() === server.toLowerCase())) {
            allNames.set(lower, st.name);
        }
    }

    const swarmStopped = findStopFile('swarm', root) !== null;
    const accounts: Record<string, AccountState> = {};

    for (const [lower, rawName] of [...allNames.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const owner = owners.get(lower);
        if (owner && owner.server.toLowerCase() !== server.toLowerCase()) continue;
        const st = statusByAcct.get(lower) ?? snapshotRows.get(lower);
        const name = typeof st?.name === 'string' ? st.name : rawName;
        if (!ACCOUNT_KEY_RE.test(name)) continue;

        const acctSide = owner?.side ?? side;
        const skills: Record<string, { level: number; xp: number }> = {};
        if (Array.isArray(st?.skills)) {
            for (const sk of st.skills) {
                if (typeof sk?.name === 'string' && Number.isSafeInteger(sk.level) && sk.level >= 1) {
                    skills[sk.name] = { level: sk.level, xp: Number.isFinite(sk.xp) ? Math.max(0, sk.xp) : 0 };
                }
            }
        }
        const quests: Record<string, 'not_started' | 'started' | 'complete'> = {};
        if (Array.isArray(st?.quests)) {
            for (const q of st.quests) {
                if (typeof q?.name !== 'string') continue;
                const mapped = q.state === 'complete'
                    ? 'complete'
                    : q.state === 'started'
                        ? 'started'
                        : q.state === 'not started' || q.state === 'not_started'
                            ? 'not_started'
                            : null;
                if (mapped) quests[q.name] = mapped;
            }
        }
        const inventory: Record<number, number> = {};
        if (Array.isArray(st?.inventory)) {
            for (const it of st.inventory) {
                if (Number.isSafeInteger(it?.id) && it.id >= 0 && Number.isSafeInteger(it?.count) && it.count > 0) {
                    inventory[it.id] = (inventory[it.id] ?? 0) + it.count;
                }
            }
        }
        const equipment: Record<number, number> = {};
        if (Array.isArray(st?.equipment)) {
            for (const it of st.equipment) {
                if (Number.isSafeInteger(it?.id) && it.id >= 0 && Number.isSafeInteger(it?.count) && it.count > 0) {
                    equipment[it.id] = (equipment[it.id] ?? 0) + it.count;
                }
            }
        }
        const bankItems: Record<number, number> = {};
        if (Array.isArray(st?.bank)) {
            for (const it of st.bank) {
                if (Number.isSafeInteger(it?.id) && it.id >= 0 && Number.isSafeInteger(it?.count) && it.count > 0) {
                    bankItems[it.id] = (bankItems[it.id] ?? 0) + it.count;
                }
            }
        }

        const role = inferRole(name, skills);
        const protectedClock = role === 'main' || role === 'specialist' || isProtectedAccountName(name);
        const stopFile = findStopFile(name, root);
        const proof = readLogoutProof(name, server, {
            root: existsSync(join(liveRoot(root), 'session-lifecycle'))
                ? join(liveRoot(root), 'session-lifecycle')
                : join(practiceRoot(root), 'session-lifecycle'),
        });

        let lifecycle: AccountLifecycle;
        if (stopFile !== null) {
            lifecycle = 'paused_owner';
        } else if (protectedClock) {
            lifecycle = 'reserved';
        } else if (typeof st?.result === 'string' && /\bdied\b/i.test(st.result)) {
            lifecycle = 'dead';
        } else if (proof.state === 'held' || proof.state === 'invalid') {
            lifecycle = 'needs_logout_recovery';
        } else if (st?.pos && st.pos.level > 0) {
            lifecycle = 'needs_location_recovery';
        } else {
            lifecycle = 'idle';
        }

        const pos = st?.pos && Number.isSafeInteger(st.pos.x) && Number.isSafeInteger(st.pos.z) && Number.isSafeInteger(st.pos.level)
            ? { x: st.pos.x, z: st.pos.z, level: Math.max(0, Math.min(3, st.pos.level)) }
            : null;
        const bankAt = Number.isFinite(st?.bankAt) && st.bankAt > 0 ? st.bankAt : 0;
        const bankTrusted = bankAt > 0 && proof.state !== 'held' && proof.state !== 'invalid';

        accounts[name] = {
            name,
            side: acctSide,
            role,
            protectedClock,
            lifecycle,
            skills,
            quests,
            pos,
            inventory,
            equipment,
            bank: { items: bankItems, observedAt: bankAt, trusted: bankTrusted },
        };
    }

    return {
        schemaVersion: 1,
        at: now,
        side,
        server,
        fleetSides: {
            [side]: {
                side,
                seenAt: now,
                capacity: 25,
                stopped: swarmStopped,
            },
        },
        accounts,
    };
}

function defaultCampaignsForWorld(world: WorldSnapshot): Campaign[] {
    const helper = Object.values(world.accounts).find((a) => !a.protectedClock && a.lifecycle === 'idle')?.name ?? 'Packhorse';
    return [
        {
            id: 'campaign:haggis-overall',
            account: 'haggis',
            protectedClock: true,
            board: 'Overall',
            requiredSupplies: [{ itemId: 385, itemName: 'Shark', count: 500 }],
            stagingHolder: helper,
            rehearsalProof: null,
            hiscoreMargin: null,
            state: 'staging',
        },
    ];
}

function defaultMissionsForWorld(world: WorldSnapshot): Mission[] {
    const participants = Object.values(world.accounts)
        .filter((a) => !a.protectedClock && a.role === 'army')
        .slice(0, 2)
        .map((a) => a.name);
    if (participants.length === 0) return [];
    return [
        {
            id: 'mission:pk-squad-alpha',
            participants,
            state: 'paused',
            kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1, slot: 'weapon' }],
            consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 18, minReservePerParticipant: 36 }],
            weight: 3,
        },
    ];
}

function defaultDemandsForWorld(
    world: WorldSnapshot,
    campaigns: readonly Campaign[],
    missions: readonly Mission[],
): GoalDemand[] {
    const demands: GoalDemand[] = [
        {
            id: 'demand:main-sharks',
            goalKind: 'main_supply',
            sourceId: campaigns[0]?.id,
            valueScore: 12,
            valuePerHour: 12,
            target: { kind: 'item', itemId: 385, itemName: 'Shark', count: 500 },
            fulfilled: 0,
            remaining: 500,
            priorityWeight: 2,
            active: true,
        },
        {
            id: 'demand:quest-legends',
            goalKind: 'quest_board',
            valueScore: 15,
            valuePerHour: 15,
            target: { kind: 'quest', questSlug: 'legends' },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 2,
            active: true,
        },
        {
            id: 'demand:quest-cook',
            goalKind: 'quest_board',
            valueScore: 6,
            valuePerHour: 6,
            target: { kind: 'quest', questSlug: 'cook' },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            active: true,
        },
        {
            id: 'demand:coin-fund',
            goalKind: 'coin_fund',
            valueScore: 8,
            valuePerHour: 8,
            target: { kind: 'coins', amount: 1_000_000 },
            fulfilled: 0,
            remaining: 1_000_000,
            priorityWeight: 1,
            active: true,
        },
    ];

    for (const m of missions) {
        if (missionEffectiveWeight(m) <= 0) continue;
        for (const p of m.participants) {
            demands.push({
                id: `demand:${m.id}:${p}`,
                goalKind: 'pk_army',
                sourceId: m.id,
                valueScore: 14,
                valuePerHour: 14,
                target: { kind: 'combat_readiness', account: p, targets: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99 } },
                fulfilled: 0,
                remaining: 1,
                priorityWeight: m.weight,
                assignedAccount: p,
                active: true,
            });
        }
    }

    // Add starter combat readiness for fresh accounts if present.
    for (const acct of Object.values(world.accounts)) {
        if (acct.protectedClock) continue;
        if ((acct.skills.Strength?.level ?? 1) < 30 && acct.role === 'auto') {
            demands.push({
                id: `demand:bootstrap:${acct.name}`,
                goalKind: 'pk_army',
                valueScore: 5,
                valuePerHour: 5,
                target: { kind: 'skill', account: acct.name, skill: 'Strength', targetLevel: 30 },
                fulfilled: 0,
                remaining: 1,
                priorityWeight: 1,
                assignedAccount: acct.name,
                active: true,
            });
        }
    }

    return demands;
}

function verifySyntheticScenarioProbes(
    activities: readonly ActivityDefinition[],
    now: number,
): ShadowVerificationCheck[] {
    const checks: ShadowVerificationCheck[] = [];

    // 1. Fresh account probe
    const freshAcct: AccountState = {
        name: 'ProbeFresh',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: { level: 1, xp: 0 }, Strength: { level: 1, xp: 0 }, Defence: { level: 1, xp: 0 }, Hitpoints: { level: 10, xp: 1154 } },
        quests: {},
        pos: { x: 3222, z: 3218, level: 0 },
        inventory: { 995: 1500 },
        equipment: {},
        bank: { items: {}, observedAt: now - 10_000, trusted: true },
    };
    const freshWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { ProbeFresh: freshAcct },
    };
    const freshPlan = planAccount(freshAcct, {
        world: freshWorld,
        activities,
        demands: [{
            id: 'probe:fresh-bootstrap',
            goalKind: 'pk_army',
            valueScore: 8,
            valuePerHour: 8,
            target: { kind: 'skill', account: 'ProbeFresh', skill: 'Strength', targetLevel: 30 },
            fulfilled: 0,
            remaining: 1,
            priorityWeight: 1,
            assignedAccount: 'ProbeFresh',
            active: true,
        }],
    });
    const freshAdapted = adaptAccountPlan(freshPlan, { activities });
    checks.push({
        name: 'fresh_accounts_planned',
        ok: isAccountPlan(freshPlan) && freshPlan.steps.length >= 1 && freshPlan.steps.length <= 3 && freshAdapted.combinedStep !== null,
        detail: `ProbeFresh steps=${freshPlan.steps.length} script=${freshAdapted.combinedStep?.script ?? 'none'}`,
    });

    // 2. Comparative advantage probe: high-quest veteran vs high-artisan veteran vs maxed tribrid
    const questVet: AccountState = {
        ...freshAcct,
        name: 'ProbeQuest',
        quests: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, 'complete' as const])),
        skills: {
            Attack: { level: 60, xp: 280_000 }, Strength: { level: 60, xp: 280_000 }, Defence: { level: 60, xp: 280_000 },
            Hitpoints: { level: 60, xp: 280_000 }, Agility: { level: 60, xp: 280_000 }, Crafting: { level: 55, xp: 170_000 },
            Herblore: { level: 50, xp: 105_000 }, Mining: { level: 55, xp: 170_000 }, Prayer: { level: 45, xp: 65_000 },
            Smithing: { level: 55, xp: 170_000 }, Thieving: { level: 55, xp: 170_000 }, Woodcutting: { level: 55, xp: 170_000 },
        },
        quests_extra: undefined,
    } as AccountState;
    (questVet as any).quests = {
        ...questVet.quests,
        hero: 'complete',
        upass: 'complete',
        waterfall: 'complete',
    };
    const artisanVet: AccountState = {
        ...freshAcct,
        name: 'ProbeArtisan',
        skills: { Cooking: { level: 92, xp: 6_600_000 }, Fishing: { level: 85, xp: 3_300_000 }, Hitpoints: { level: 40, xp: 38_000 } },
        bank: { items: { 383: 500, 995: 50_000 }, observedAt: now - 5000, trusted: true },
    };
    const maxedTribrid: AccountState = {
        ...freshAcct,
        name: 'ProbeTribrid',
        role: 'army',
        skills: {
            Attack: { level: 99, xp: 13_034_431 }, Strength: { level: 99, xp: 13_034_431 }, Defence: { level: 99, xp: 13_034_431 },
            Hitpoints: { level: 99, xp: 13_034_431 }, Ranged: { level: 99, xp: 13_034_431 }, Magic: { level: 99, xp: 13_034_431 },
            Prayer: { level: 70, xp: 737_627 },
        },
        bank: { items: { 385: 100, 995: 250_000 }, observedAt: now - 5000, trusted: true },
    };
    const compDemands: GoalDemand[] = [
        { id: 'd:quest', goalKind: 'quest_board', valueScore: 10, valuePerHour: 10, target: { kind: 'quest', questSlug: 'legends' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
        { id: 'd:supply', goalKind: 'main_supply', valueScore: 10, valuePerHour: 10, target: { kind: 'item', itemId: 385, count: 200 }, fulfilled: 0, remaining: 200, priorityWeight: 1, active: true },
        { id: 'd:pk', goalKind: 'pk_army', valueScore: 10, valuePerHour: 10, target: { kind: 'combat_readiness', account: 'ProbeTribrid', targets: { Attack: 99, Strength: 99, Defence: 99 } }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
    ];
    const compWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { ProbeQuest: questVet, ProbeArtisan: artisanVet, ProbeTribrid: maxedTribrid },
    };
    const qPlan = planAccount(questVet, { world: compWorld, activities, demands: compDemands });
    const aPlan = planAccount(artisanVet, { world: compWorld, activities, demands: compDemands });
    const tPlan = planAccount(maxedTribrid, { world: compWorld, activities, demands: compDemands });
    checks.push({
        name: 'veteran_comparative_advantage',
        ok: qPlan.demandId === 'd:quest' && aPlan.demandId === 'd:supply' && tPlan.demandId === 'd:pk',
        detail: `questVet->${qPlan.demandId}, artisanVet->${aPlan.demandId}, tribrid->${tPlan.demandId}`,
    });

    // 3. Campaign & Mission gating probe
    const camp: Campaign = {
        id: 'camp:haggis',
        account: 'haggis',
        protectedClock: true,
        board: 'Overall',
        requiredSupplies: [{ itemId: 385, itemName: 'Shark', count: 200 }],
        stagingHolder: 'ProbeArtisan',
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
    };
    const pausedMission: Mission = {
        id: 'mission:paused-test',
        participants: ['ProbeTribrid'],
        state: 'paused',
        kitTargets: [],
        consumables: [],
        weight: 5,
    };
    const missionDemand: GoalDemand = {
        id: 'd:paused-mission',
        goalKind: 'pk_army',
        sourceId: pausedMission.id,
        valueScore: 100,
        valuePerHour: 100,
        target: { kind: 'combat_readiness', account: 'ProbeTribrid', targets: { Attack: 99 } },
        fulfilled: 0,
        remaining: 1,
        priorityWeight: 5,
        assignedAccount: 'ProbeTribrid',
        active: true,
    };
    const gatedPlan = scheduleFleet({
        world: compWorld,
        activities,
        demands: [missionDemand],
        campaigns: [camp],
        missions: [pausedMission],
        maxBots: 5,
    });
    checks.push({
        name: 'campaign_and_mission_gating',
        ok: isCampaign(camp) && isMission(pausedMission) && missionEffectiveWeight(pausedMission) === 0
            && (gatedPlan.accountPlans.ProbeTribrid?.steps.length ?? 0) === 0,
        detail: `campaign valid=${isCampaign(camp)}, paused mission steps=${gatedPlan.accountPlans.ProbeTribrid?.steps.length ?? 0}`,
    });

    // 4. Anti-ping-pong transfer & recovery ordering probe
    const recWorld: WorldSnapshot = {
        schemaVersion: 1,
        at: now,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: {
            RecLow: { ...freshAcct, name: 'RecLow', lifecycle: 'needs_logout_recovery', inventory: { 995: 100 } },
            RecHigh: { ...freshAcct, name: 'RecHigh', lifecycle: 'needs_logout_recovery', inventory: { 995: 500_000 } },
            RecLoc: { ...freshAcct, name: 'RecLoc', lifecycle: 'needs_location_recovery', inventory: { 995: 900_000 } },
            Donor: { ...freshAcct, name: 'Donor', lifecycle: 'idle', bank: { items: { 383: 500, 995: 5000 }, observedAt: now - 5000, trusted: true } },
            NeedRaw: {
                ...artisanVet,
                name: 'NeedRaw',
                lifecycle: 'idle',
                bank: { items: { 995: 1000 }, observedAt: now - 5000, trusted: true },
            },
        },
        activeTransfers: [{
            id: 'recent-1',
            server: 'rs-sdk-demo.fly.dev',
            from: 'Other',
            to: 'Donor',
            hub: 'varrock_west',
            items: [{ itemId: 383, count: 100 }],
            demandId: 'd:prev',
            reason: 'prior delivery',
            createdAt: now - 60_000,
            expiresAt: now + 600_000,
            state: 'settled',
            bothIdleVerified: true,
            donorLogoutConfirmedAt: now - 70_000,
            recipientLogoutConfirmedAt: now - 65_000,
            antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
        }],
    };
    const logoutProofs = new Map<string, LogoutProof>([
        ['donor', { state: 'confirmed', account: 'Donor', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: '1700000000000-0000000001-0000000001', loggedOutAt: now - 10_000, ownerRun: null, receiptSha256: 'a'.repeat(64) }],
        ['needraw', { state: 'confirmed', account: 'NeedRaw', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: '1700000000000-0000000001-0000000002', loggedOutAt: now - 10_000, ownerRun: null, receiptSha256: 'b'.repeat(64) }],
    ]);
    const recPlan = scheduleFleet({
        world: recWorld,
        activities,
        demands: [{ id: 'd:cook-need', goalKind: 'main_supply', valueScore: 10, valuePerHour: 10, target: { kind: 'item', itemId: 385, count: 100 }, fulfilled: 0, remaining: 100, priorityWeight: 1, assignedAccount: 'NeedRaw', active: true }],
        logoutProofs,
        requireMarketQuote: true,
        marketQuotes: {},
        maxBots: 5,
    });
    const recOrder = recPlan.recoveryQueue.map((r) => r.account);
    const antiPingPongBlocked = recPlan.transferOrders.length === 0;
    const sampleTransfer: TransferOrder = {
        id: 'probe-xfer',
        server: 'rs-sdk-demo.fly.dev',
        from: 'Donor',
        to: 'NeedRaw',
        hub: 'varrock_west',
        items: [{ itemId: 383, count: 50 }],
        demandId: 'd:cook-need',
        reason: 'probe',
        createdAt: now,
        expiresAt: now + 600_000,
        state: 'planned',
        bothIdleVerified: true,
        donorLogoutConfirmedAt: now - 10_000,
        recipientLogoutConfirmedAt: now - 10_000,
        antiPingPong: { donorRecentReceivedAt: now - 60_000, donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
    };
    const pingPongRefused = !canScheduleTransferOrder(sampleTransfer, recWorld.accounts.Donor!, recWorld.accounts.NeedRaw!, {
        now,
        donorLogoutState: 'confirmed',
        recipientLogoutState: 'confirmed',
    }).ok;
    checks.push({
        name: 'recovery_ordering_and_anti_ping_pong',
        ok: recOrder.join(',') === 'RecHigh,RecLow,RecLoc' && antiPingPongBlocked && pingPongRefused,
        detail: `recoveryQueue=[${recOrder.join(',')}], antiPingPongBlocked=${antiPingPongBlocked}, pingPongRefused=${pingPongRefused}`,
    });

    return checks;
}

export function runShadowVerification(options: RunShadowOptions = {}): ShadowVerificationReport {
    const root = resolve(options.root ?? DEFAULT_REPO_ROOT);
    const now = options.now ?? Date.now();
    const side = options.side ?? process.env.FLEET_SIDE ?? 'local';
    const server = options.server ?? 'rs-sdk-demo.fly.dev';

    const swarmCfg = readJsonSafe<{ maxBots?: number }>(join(root, 'swarm.json'));
    const maxBots = options.maxBots ?? (Number.isSafeInteger(swarmCfg?.maxBots) && swarmCfg!.maxBots! > 0 ? swarmCfg!.maxBots! : 25);

    const provider = options.provider;
    const world = provider
        ? provider.loadSnapshot({ root, now, side, server })
        : loadFallbackWorldSnapshot({ root, now, side, server });
    const activities = provider
        ? provider.loadActivities({ root })
        : defaultActivities();
    const campaigns = provider?.loadCampaigns
        ? provider.loadCampaigns({ root, world })
        : defaultCampaignsForWorld(world);
    const missions = provider?.loadMissions
        ? provider.loadMissions({ root, world })
        : defaultMissionsForWorld(world);
    const demands = provider
        ? provider.loadDemands({ root, world, campaigns, missions })
        : defaultDemandsForWorld(world, campaigns, missions);
    const marketQuotes = provider?.loadMarketQuotes
        ? provider.loadMarketQuotes({ root })
        : loadMarketQuotesFromRoot(root);

    const fleetPlan = scheduleFleet({
        world,
        activities,
        demands,
        campaigns,
        missions,
        maxBots,
        ignoreSideStop: options.ignoreSideStop ?? true,
        retentionMarginRatio: DEFAULT_RETENTION_MARGIN_RATIO,
        marketQuotes,
    });

    const fleetState = buildFleetState(fleetPlan, {
        world,
        goals: demands,
        campaigns,
        missions,
    });

    const adaptedPlans: Record<string, AdaptedAccountPlan> = {};
    for (const [acctName, plan] of Object.entries(fleetPlan.accountPlans)) {
        if (plan.steps.length > 0) {
            adaptedPlans[acctName] = adaptAccountPlan(plan, { activities });
        }
    }

    const lifecycleCounts: Record<AccountLifecycle, number> = {
        paused_owner: 0,
        reserved: 0,
        dead: 0,
        needs_logout_recovery: 0,
        needs_location_recovery: 0,
        running: 0,
        in_trade: 0,
        idle: 0,
    };
    const roleCounts: Record<AccountRole, number> = {
        auto: 0,
        army: 0,
        helper: 0,
        specialist: 0,
        main: 0,
    };

    let sideAccounts = 0;
    let protectedAccountsCount = 0;
    let protectedAccountsIdle = 0;
    let protectedSafetyViolations = 0;

    for (const acct of Object.values(world.accounts)) {
        lifecycleCounts[acct.lifecycle] += 1;
        roleCounts[acct.role] += 1;
        if (acct.side === world.side) sideAccounts += 1;
        if (acct.protectedClock || isProtectedAccountName(acct.name)) {
            protectedAccountsCount += 1;
            const plan = fleetPlan.accountPlans[acct.name];
            const launchOk = canProtectedAccountLaunch(acct, campaigns).allowed;
            if (!launchOk) {
                if (!plan || plan.steps.length === 0) protectedAccountsIdle += 1;
                else protectedSafetyViolations += 1;
            }
        }
    }

    const checks: ShadowVerificationCheck[] = [];
    const fpErrors = validateFleetPlan(fleetPlan);
    const fsErrors = validateFleetState(fleetState);
    checks.push({
        name: 'schema_valid',
        ok: isFleetPlan(fleetPlan) && isFleetState(fleetState),
        detail: `fleetPlanErrors=${fpErrors.length}, fleetStateErrors=${fsErrors.length}`,
    });

    checks.push({
        name: 'protected_clock_safety',
        ok: protectedSafetyViolations === 0,
        detail: `protected=${protectedAccountsCount}, heldOffline=${protectedAccountsIdle}, violations=${protectedSafetyViolations}`,
    });

    const validAdapts = Object.values(adaptedPlans).every(
        (a) => a.steps.length > 0 && a.combinedStep !== null && /^scripts\/[\w./-]+\.ts$/.test(a.combinedStep.script),
    );
    checks.push({
        name: 'script_adapter_coverage',
        ok: validAdapts,
        detail: `adaptedPlans=${Object.keys(adaptedPlans).length}, allValidSteps=${validAdapts}`,
    });

    const validHubs = fleetPlan.transferOrders.every(
        (o) => isTransferOrder(o) && Object.hasOwn(HUB_BANKER_LOCATIONS, o.hub) && o.bothIdleVerified,
    );
    checks.push({
        name: 'fleet_transfer_safety',
        ok: validHubs,
        detail: `transferOrders=${fleetPlan.transferOrders.length}, allValidHubsAndIdle=${validHubs}`,
    });

    checks.push(...verifySyntheticScenarioProbes(activities, now));

    const sampleAssignments = Object.values(fleetPlan.accountPlans)
        .sort((a, b) => b.steps.length - a.steps.length || b.scorePerHour - a.scorePerHour || a.account.localeCompare(b.account))
        .map((plan) => {
            const acct = world.accounts[plan.account]!;
            const adapted = adaptedPlans[plan.account];
            return {
                account: plan.account,
                role: acct.role,
                lifecycle: acct.lifecycle,
                steps: plan.steps.length,
                ...(plan.demandId ? { demandId: plan.demandId } : {}),
                scorePerHour: Number(plan.scorePerHour.toFixed(2)),
                ...(adapted?.combinedStep ? { script: `${adapted.combinedStep.script} ${adapted.combinedStep.args.join(' ')}`.trim() } : {}),
                ...(plan.idleReason ? { idleReason: plan.idleReason } : {}),
            };
        });

    const checksPassed = checks.filter((c) => c.ok).length;
    const summary: ShadowVerificationSummary = {
        totalOwnedAccounts: Object.keys(world.accounts).length,
        sideAccounts,
        sideStopped: world.fleetSides?.[world.side]?.stopped === true,
        maxBots: fleetPlan.maxBots,
        selectedSlots: fleetPlan.selectedSlots,
        lifecycleCounts,
        roleCounts,
        protectedAccountsCount,
        protectedAccountsIdle,
        recoveryQueueLength: fleetPlan.recoveryQueue.length,
        activeChainsCount: Object.keys(fleetState.activeChains).length,
        transferOrdersCount: fleetPlan.transferOrders.length,
        adaptedPlansCount: Object.keys(adaptedPlans).length,
        checksPassed,
        checksTotal: checks.length,
    };

    return {
        root,
        side: world.side,
        server: world.server,
        at: now,
        liveLoginsPerformed: 0,
        summary,
        checks,
        fleetPlan,
        fleetState,
        adaptedPlans,
        sampleAssignments,
    };
}

export function formatShadowSummary(report: ShadowVerificationReport): string {
    const s = report.summary;
    const recoverySamples = report.sampleAssignments.filter((a) => a.lifecycle === 'needs_logout_recovery' || a.lifecycle === 'needs_location_recovery');
    const workSamples = report.sampleAssignments.filter((a) => a.steps > 0 && a.lifecycle !== 'needs_logout_recovery' && a.lifecycle !== 'needs_location_recovery');
    const lines: string[] = [
        `Shadow Verification (root=${report.root}, side=${report.side}, sideStopped=${s.sideStopped}, server=${report.server}, liveLogins=${report.liveLoginsPerformed})`,
        `Accounts: ${s.totalOwnedAccounts} total (${s.sideAccounts} on side), maxBots=${s.maxBots}, selectedSlots=${s.selectedSlots}`,
        `Lifecycles: ${Object.entries(s.lifecycleCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        `Roles: ${Object.entries(s.roleCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        `Protected clocks: ${s.protectedAccountsCount} total, ${s.protectedAccountsIdle} held offline`,
        `Plans: activeChains=${s.activeChainsCount}, recoveryQueue=${s.recoveryQueueLength}, transferOrders=${s.transferOrdersCount}`,
        `Checks (${s.checksPassed}/${s.checksTotal} passing):`,
        ...report.checks.map((c) => `  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`),
        `Recovery queue sample (${recoverySamples.length} total):`,
        ...recoverySamples.slice(0, 6).map((a) =>
            `  - ${a.account} (${a.role}/${a.lifecycle}): ${a.steps} step(s), cmd=${a.script ?? '-'}`,
        ),
        `Active work sample (${workSamples.length} total):`,
        ...workSamples.slice(0, 10).map((a) =>
            `  - ${a.account} (${a.role}/${a.lifecycle}): ${a.steps} step(s), demand=${a.demandId ?? '-'}, score/hr=${a.scorePerHour}, cmd=${a.script ?? '-'}`,
        ),
    ];
    return lines.join('\n');
}

function parseCliArgs(argv: readonly string[]): { root?: string; side?: string; server?: string; maxBots?: number; json: boolean } {
    let root: string | undefined;
    let side: string | undefined;
    let server: string | undefined;
    let maxBots: number | undefined;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') json = true;
        else if (arg === '--root' && argv[i + 1]) root = argv[++i]!;
        else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
        else if (arg === '--side' && argv[i + 1]) side = argv[++i]!;
        else if (arg.startsWith('--side=')) side = arg.slice('--side='.length);
        else if (arg === '--server' && argv[i + 1]) server = argv[++i]!;
        else if (arg.startsWith('--server=')) server = arg.slice('--server='.length);
        else if (arg === '--max-bots' && argv[i + 1]) maxBots = Number(argv[++i]!);
        else if (arg.startsWith('--max-bots=')) maxBots = Number(arg.slice('--max-bots='.length));
    }
    return { root, side, server, maxBots, json };
}

if (import.meta.main) {
    const cli = parseCliArgs(process.argv.slice(2));
    const report = runShadowVerification({
        root: cli.root,
        side: cli.side,
        server: cli.server,
        maxBots: cli.maxBots,
    });
    if (cli.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatShadowSummary(report));
    }
    const allPassed = report.summary.checksPassed === report.summary.checksTotal;
    process.exit(allPassed ? 0 : 1);
}
