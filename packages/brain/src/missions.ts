// Declarative Mission manifests (PK Squad and multi-account operations).
// Paused missions (or owner stop-pk-squad) emit zero demand; active staging/ready/running missions
// emit proportional shortfall GoalDemands weighted by mission.weight.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findStopFile, liveRoot, practiceRoot, repoRoot } from '../../core/src/practice-paths';
import { accountOwnedItemCount } from '../../workers/src/contracts';
import {
    missionEffectiveWeight,
    validateGoalDemand,
    validateMission,
    type AccountState,
    type GoalDemand,
    type Mission,
    type MissionConsumableTarget,
    type MissionKitTarget,
    type MissionState,
    type WorldSnapshot,
} from './contracts';
import { readJsonStatCached } from './json-cache';
import { effectiveItemReserve } from './preflight';

export interface LoadMissionsOptions {
    readonly root?: string;
    readonly now?: number;
    readonly overridePath?: string;
}

export interface MissionEvaluation {
    readonly mission: Mission;
    readonly effectiveWeight: number;
    readonly shortfalls: readonly GoalDemand[];
    readonly totalRequiredUnits: number;
    readonly totalFulfilledUnits: number;
}

export interface MissionShortfallsOptions {
    readonly includePaused?: boolean;
    readonly itemValuesGp?: Readonly<Record<number, number>>;
}

export const DEFAULT_PK_KIT_TARGETS: readonly MissionKitTarget[] = [
    { itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1, slot: 'weapon' },
    { itemId: 1231, itemName: 'Dragon dagger(p)', countPerParticipant: 1, slot: 'special_weapon' },
    { itemId: 861, itemName: 'Magic shortbow', countPerParticipant: 1, slot: 'ranged_weapon' },
    { itemId: 2503, itemName: "Black d'hide body", countPerParticipant: 1, slot: 'body' },
    { itemId: 2497, itemName: "Black d'hide chaps", countPerParticipant: 1, slot: 'legs' },
    { itemId: 2491, itemName: "Black d'hide vambraces", countPerParticipant: 1, slot: 'hands' },
    { itemId: 1163, itemName: 'Rune full helm', countPerParticipant: 1, slot: 'head' },
    { itemId: 1079, itemName: 'Rune platelegs', countPerParticipant: 1, slot: 'melee_legs' },
    { itemId: 1201, itemName: 'Rune kiteshield', countPerParticipant: 1, slot: 'shield' },
    { itemId: 1712, itemName: 'Amulet of glory(4)', countPerParticipant: 1, slot: 'neck' },
    { itemId: 1731, itemName: 'Amulet of power', countPerParticipant: 1, slot: 'neck_backup' },
    { itemId: 1725, itemName: 'Amulet of strength', countPerParticipant: 1, slot: 'neck_melee' },
    { itemId: 2550, itemName: 'Ring of recoil', countPerParticipant: 2, slot: 'ring_combat' },
    { itemId: 2552, itemName: 'Ring of dueling(8)', countPerParticipant: 1, slot: 'ring' },
    { itemId: 1387, itemName: 'Staff of fire', countPerParticipant: 1, slot: 'magic_weapon' },
    { itemId: 3105, itemName: 'Climbing boots', countPerParticipant: 1, slot: 'feet' },
];

export const DEFAULT_PK_CONSUMABLES: readonly MissionConsumableTarget[] = [
    { itemId: 385, itemName: 'Shark', countPerParticipant: 40, minReservePerParticipant: 20 },
    { itemId: 3144, itemName: 'Cooked karambwan', countPerParticipant: 20, minReservePerParticipant: 8 },
    { itemId: 2434, itemName: 'Prayer potion(4)', countPerParticipant: 6, minReservePerParticipant: 2 },
    { itemId: 2436, itemName: 'Super attack(4)', countPerParticipant: 2, minReservePerParticipant: 1 },
    { itemId: 2440, itemName: 'Super strength(4)', countPerParticipant: 2, minReservePerParticipant: 1 },
    { itemId: 2442, itemName: 'Super defence(4)', countPerParticipant: 2, minReservePerParticipant: 1 },
    { itemId: 2444, itemName: 'Ranging potion(4)', countPerParticipant: 2, minReservePerParticipant: 1 },
    { itemId: 2448, itemName: 'Superantipoison(4)', countPerParticipant: 2, minReservePerParticipant: 1 },
    { itemId: 892, itemName: 'Rune arrow', countPerParticipant: 150, minReservePerParticipant: 50 },
    { itemId: 556, itemName: 'Air rune', countPerParticipant: 300, minReservePerParticipant: 100 },
    { itemId: 555, itemName: 'Water rune', countPerParticipant: 150, minReservePerParticipant: 50 },
    { itemId: 557, itemName: 'Earth rune', countPerParticipant: 150, minReservePerParticipant: 50 },
    { itemId: 561, itemName: 'Nature rune', countPerParticipant: 50, minReservePerParticipant: 20 },
    { itemId: 563, itemName: 'Law rune', countPerParticipant: 30, minReservePerParticipant: 10 },
    { itemId: 564, itemName: 'Cosmic rune', countPerParticipant: 30, minReservePerParticipant: 10 },
];

const ACCOUNT_NAME_RE = /^[A-Za-z0-9_ -]{1,12}$/;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJsonSafe(filePath: string): unknown {
    if (!existsSync(filePath)) return undefined;
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function loadPkSquadParticipants(root: string): string[] {
    const swarmPath = join(root, 'swarm.json');
    const swarm = readJsonStatCached<unknown>(swarmPath);
    if (!isPlainRecord(swarm)) return [];

    const seen = new Set<string>();
    const participants: string[] = [];
    const add = (name: unknown) => {
        if (typeof name !== 'string') return;
        const trimmed = name.trim();
        if (!ACCOUNT_NAME_RE.test(trimmed)) return;
        const lower = trimmed.toLowerCase();
        if (seen.has(lower)) return;
        seen.add(lower);
        participants.push(trimmed);
    };

    if (Array.isArray(swarm.army)) {
        for (const name of swarm.army) add(name);
    }
    const isPvpRole = (role: unknown): boolean =>
        role === 'pvp' || role === 'pk-trainee' || role === 'pk' || role === 'army';
    if (Array.isArray(swarm.bots)) {
        for (const bot of swarm.bots) {
            if (!isPlainRecord(bot)) continue;
            if (isPvpRole(bot.role)) add(bot.name);
        }
    }
    if (Array.isArray(swarm.jobs)) {
        for (const job of swarm.jobs) {
            if (!isPlainRecord(job)) continue;
            if (isPvpRole(job.role)) add(job.name);
        }
    }
    return participants;
}

function readMissionOverrides(root: string, overridePath?: string): Map<string, Mission> {
    const out = new Map<string, Mission>();
    const paths = overridePath
        ? [overridePath]
        : [join(practiceRoot(root), 'missions.json'), join(liveRoot(root), 'missions.json')];
    for (const filePath of paths) {
        const parsed = readJsonSafe(filePath);
        const list = Array.isArray(parsed)
            ? parsed
            : isPlainRecord(parsed) && Array.isArray(parsed.missions)
              ? parsed.missions
              : [];
        for (const item of list) {
            if (validateMission(item).length === 0) {
                out.set(item.id, item);
            }
        }
    }
    return out;
}

export function loadMissionManifests(opts: LoadMissionsOptions = {}): Mission[] {
    const root = opts.root ?? repoRoot;
    const byId = new Map<string, Mission>();

    const participants = loadPkSquadParticipants(root);
    const hasPkStop = Boolean(findStopFile('pk-squad', root) ?? findStopFile('pvp', root));
    const state: MissionState = hasPkStop || participants.length === 0 ? 'paused' : 'staging';

    const pkSquad: Mission = {
        id: 'mission:pk-squad',
        participants,
        state,
        kitTargets: [...DEFAULT_PK_KIT_TARGETS],
        consumables: [...DEFAULT_PK_CONSUMABLES],
        weight: 1.0,
    };
    const pkErrors = validateMission(pkSquad);
    if (pkErrors.length > 0) {
        throw new Error(`Invalid default PK squad mission: ${pkErrors.join('; ')}`);
    }
    byId.set(pkSquad.id, pkSquad);

    const overrides = readMissionOverrides(root, opts.overridePath);
    for (const [id, m] of overrides.entries()) {
        byId.set(id, m);
    }

    return [...byId.values()];
}

interface MergedMissionItemRequirement {
    readonly itemId: number;
    readonly itemName?: string;
    readonly countPerParticipant: number;
}

function mergeMissionItemRequirements(mission: Mission): MergedMissionItemRequirement[] {
    const byItem = new Map<number, { countPerParticipant: number; itemName?: string }>();
    const add = (itemId: number, countPerParticipant: number, itemName?: string) => {
        const prev = byItem.get(itemId);
        if (!prev) {
            byItem.set(itemId, {
                countPerParticipant,
                ...(itemName ? { itemName } : {}),
            });
        } else {
            byItem.set(itemId, {
                countPerParticipant: prev.countPerParticipant + countPerParticipant,
                ...(prev.itemName ?? itemName ? { itemName: prev.itemName ?? itemName } : {}),
            });
        }
    };
    for (const kit of mission.kitTargets) add(kit.itemId, kit.countPerParticipant, kit.itemName);
    for (const con of mission.consumables) add(con.itemId, con.countPerParticipant, con.itemName);

    return [...byItem.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([itemId, info]) => ({
            itemId,
            countPerParticipant: info.countPerParticipant,
            ...(info.itemName ? { itemName: info.itemName } : {}),
        }));
}

function resolveMissionParticipants(mission: Mission, snapshot: WorldSnapshot): AccountState[] {
    let byLower: Map<string, AccountState> | undefined;
    const active: AccountState[] = [];
    for (const participant of mission.participants) {
        let acct: AccountState | undefined = snapshot.accounts[participant] ?? snapshot.accounts[participant.toLowerCase()];
        if (!acct) {
            if (!byLower) {
                byLower = new Map<string, AccountState>();
                for (const a of Object.values(snapshot.accounts)) {
                    byLower.set(a.name.toLowerCase(), a);
                }
            }
            acct = byLower.get(participant.toLowerCase());
        }
        if (!acct) continue;
        if (acct.lifecycle === 'dead' || acct.lifecycle === 'paused_owner') continue;
        active.push(acct);
    }
    return active;
}

function ownedByMissionParticipants(
    activeParticipants: readonly AccountState[],
    itemId: number,
    snapshot: WorldSnapshot,
): number {
    let total = 0;
    for (const acct of activeParticipants) {
        const owned = accountOwnedItemCount(acct, itemId);
        const reserved = effectiveItemReserve(acct, snapshot, itemId);
        total += Math.max(0, owned - reserved);
    }
    return total;
}

function selectMissionStagingHolder(
    activeParticipants: readonly AccountState[],
    itemId: number,
    snapshot: WorldSnapshot,
): string | undefined {
    let bestName: string | undefined;
    let bestAvailable = Infinity;
    for (const acct of activeParticipants) {
        const owned = accountOwnedItemCount(acct, itemId);
        const reserved = effectiveItemReserve(acct, snapshot, itemId);
        const avail = Math.max(0, owned - reserved);
        if (bestName === undefined || avail < bestAvailable) {
            bestName = acct.name;
            bestAvailable = avail;
        }
    }
    return bestName;
}

export function missionShortfalls(
    mission: Mission,
    snapshot: WorldSnapshot,
    opts: MissionShortfallsOptions = {},
): MissionEvaluation {
    const mErrors = validateMission(mission);
    if (mErrors.length > 0) {
        throw new Error(`Invalid Mission "${String((mission as Mission)?.id)}": ${mErrors.join('; ')}`);
    }

    const effectiveWeight = missionEffectiveWeight(mission);
    const participantCount = mission.participants.length;
    const requirements = mergeMissionItemRequirements(mission);

    let totalRequiredUnits = 0;
    let totalFulfilledUnits = 0;
    const shortfalls: GoalDemand[] = [];

    if (participantCount === 0) {
        return {
            mission,
            effectiveWeight,
            shortfalls,
            totalRequiredUnits: 0,
            totalFulfilledUnits: 0,
        };
    }

    const activeParticipants = resolveMissionParticipants(mission, snapshot);
    for (const req of requirements) {
        const totalNeeded = req.countPerParticipant * participantCount;
        totalRequiredUnits += totalNeeded;
        const owned = ownedByMissionParticipants(activeParticipants, req.itemId, snapshot);
        const fulfilled = Math.min(totalNeeded, owned);
        const remaining = totalNeeded - fulfilled;
        totalFulfilledUnits += fulfilled;

        if (mission.state === 'paused' && !opts.includePaused) {
            continue;
        }
        if (remaining <= 0) {
            continue;
        }

        const stagingHolder = selectMissionStagingHolder(activeParticipants, req.itemId, snapshot);
        const unitGp = opts.itemValuesGp?.[req.itemId] ?? 500;
        const valueScore = Math.max(40, Math.min(4000, Math.sqrt(Math.max(1, remaining * unitGp)) * 4)) * effectiveWeight;
        const demand: GoalDemand = {
            id: `mission:${mission.id}:item:${req.itemId}`,
            goalKind: 'squad_supply',
            sourceId: mission.id,
            valueScore,
            target: {
                kind: 'item',
                itemId: req.itemId,
                ...(req.itemName ? { itemName: req.itemName } : {}),
                count: totalNeeded,
                ...(stagingHolder ? { holder: stagingHolder } : {}),
            },
            fulfilled,
            remaining,
            priorityWeight: effectiveWeight,
            active: mission.state !== 'paused',
        };
        const dErrors = validateGoalDemand(demand);
        if (dErrors.length > 0) {
            throw new Error(`Invalid mission GoalDemand: ${dErrors.join('; ')}`);
        }
        shortfalls.push(demand);
    }

    return {
        mission,
        effectiveWeight,
        shortfalls,
        totalRequiredUnits,
        totalFulfilledUnits,
    };
}

export function evaluateMissions(
    missions: readonly Mission[],
    snapshot: WorldSnapshot,
    opts: MissionShortfallsOptions = {},
): MissionEvaluation[] {
    return missions.map((mission) => missionShortfalls(mission, snapshot, opts));
}
