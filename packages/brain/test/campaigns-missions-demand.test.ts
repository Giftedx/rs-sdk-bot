import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import {
    campaignShortfalls,
    createDemandEngine,
    defaultActivityCatalog,
    evaluateCampaigns,
    evaluateMissions,
    levelToXp,
    loadCampaignManifests,
    missionShortfalls,
    validateCampaign,
    validateGoalDemand,
    validateMission,
    type AccountState,
    type Campaign,
    type Mission,
    type WorldSnapshot,
} from '../src/index';
import { xpForLevel } from '../../core/src/xp-curve';

let tempRoot = '';
const NOW = 1_800_000_000_000;

function makeAccount(
    name: string,
    opts: Partial<AccountState> = {},
): AccountState {
    return {
        name,
        side: 'local',
        role: opts.role ?? 'helper',
        protectedClock: opts.protectedClock ?? false,
        lifecycle: opts.lifecycle ?? 'idle',
        skills: opts.skills ?? {
            Attack: { level: 50, xp: 101_333 },
            Strength: { level: 50, xp: 101_333 },
            Defence: { level: 50, xp: 101_333 },
            Hitpoints: { level: 50, xp: 101_333 },
            Ranged: { level: 40, xp: 37_224 },
            Magic: { level: 40, xp: 37_224 },
            Prayer: { level: 43, xp: 50_339 },
        },
        quests: opts.quests ?? {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: opts.inventory ?? {},
        equipment: opts.equipment ?? {},
        bank: opts.bank ?? { items: {}, observedAt: NOW - 10_000, trusted: true },
        ...(opts.maxLevels ? { maxLevels: opts.maxLevels } : {}),
    };
}

function makeSnapshot(
    accounts: Record<string, AccountState>,
    extra: Partial<WorldSnapshot> = {},
): WorldSnapshot {
    return {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts,
        ...extra,
    };
}

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'brain-demand-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('Campaigns, Missions & DemandEngine', () => {
    test('loads Haggis and all 19 reserved Specialist campaigns cleanly', () => {
        const manifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        const specialistCount = Object.keys(SPECIALIST_BOARDS).length;
        expect(specialistCount).toBe(19);
        expect(manifests).toHaveLength(1 + specialistCount);

        for (const c of manifests) {
            expect(validateCampaign(c)).toEqual([]);
            expect(c.protectedClock).toBe(true);
        }
        expect(manifests.some((c) => c.account === 'haggis' && c.board === 'Overall')).toBe(true);
        for (const name of Object.keys(SPECIALIST_BOARDS)) {
            expect(manifests.some((c) => c.account === name && c.board === SPECIALIST_BOARDS[name]!.name)).toBe(true);
        }
    });

    test('computes campaign supply shortfalls against stagingHolder minus reserves and gates on paused/completed/proof/margin', () => {
        const campaignStaging: Campaign = {
            id: 'campaign:hiltsdeep',
            account: 'hiltsdeep',
            protectedClock: true,
            board: 'Attack',
            requiredSupplies: [
                { itemId: 536, itemName: 'Dragon bones', count: 50 },
                { itemId: 556, itemName: 'Air rune', count: 1000 },
            ],
            stagingHolder: 'StagerOne',
            rehearsalProof: { verified: false },
            hiscoreMargin: {
                board: 'Attack',
                rivalTicks: 4000,
                ourTicks: 3800,
                marginTicks: 200,
                marginRatio: 0.05,
                checkedAt: NOW,
                meetsMargin: true,
            },
            state: 'staging',
            weight: 1.5,
        };

        const pausedCampaign: Campaign = { ...campaignStaging, id: 'campaign:paused', account: 'rocksolid', board: 'Defence', state: 'paused' };
        const completedCampaign: Campaign = { ...campaignStaging, id: 'campaign:done', account: 'bigswinger', board: 'Strength', state: 'completed' };

        const snapshot = makeSnapshot(
            {
                StagerOne: makeAccount('StagerOne', {
                    bank: { items: { 536: 35, 556: 1200 }, observedAt: NOW - 1000, trusted: true },
                }),
            },
            {
                reserves: { StagerOne: { 536: 10 } }, // 35 - 10 = 25 available -> shortfall 25 Dragon bones; 1200 Air runes >= 1000 -> 0 shortfall
            },
        );

        const evals = evaluateCampaigns([campaignStaging, pausedCampaign, completedCampaign], snapshot);
        expect(evals[0]!.launchReady).toBe(false);
        expect(evals[0]!.missingGates).toContain('rehearsalProof');
        expect(evals[0]!.missingGates).toContain('supplies');
        expect(evals[0]!.shortfalls).toHaveLength(1);
        expect(evals[0]!.shortfalls[0]!.goalKind).toBe('specialist_prep');
        expect(evals[0]!.shortfalls[0]!.fulfilled).toBe(25);
        expect(evals[0]!.shortfalls[0]!.remaining).toBe(25);

        expect(evals[1]!.shortfalls).toEqual([]);
        expect(evals[2]!.shortfalls).toEqual([]);

        const readyCampaign: Campaign = {
            ...campaignStaging,
            rehearsalProof: { verified: true, ticks: 3800 },
            state: 'ready',
        };
        // Supplies are still short (25/50 Dragon bones), so launchReady must be false.
        const shortEval = campaignShortfalls(readyCampaign, snapshot);
        expect(shortEval.launchReady).toBe(false);
        expect(shortEval.missingGates).toContain('supplies');

        // Stale hiscore margin (> 1 h old) blocks launch even when supplies are satisfied.
        const fullSnapshot = makeSnapshot(
            {
                StagerOne: makeAccount('StagerOne', {
                    bank: { items: { 536: 60, 556: 1200 }, observedAt: NOW - 1000, trusted: true },
                }),
            },
            { reserves: { StagerOne: { 536: 10 } } },
        );
        expect(campaignShortfalls(readyCampaign, fullSnapshot).launchReady).toBe(true);

        const staleCampaign: Campaign = {
            ...readyCampaign,
            hiscoreMargin: {
                ...readyCampaign.hiscoreMargin!,
                checkedAt: NOW - 2 * 3_600_000,
            },
        };
        const staleEval = campaignShortfalls(staleCampaign, fullSnapshot);
        expect(staleEval.launchReady).toBe(false);
        expect(staleEval.missingGates).toContain('staleHiscore');
    });

    test('Mission paused emits zero demand while active missions compete proportionally by weight', () => {
        const pausedMission: Mission = {
            id: 'mission:pk-paused',
            participants: ['Alpha', 'Beta'],
            state: 'paused',
            kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1 }],
            consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 20 }],
            weight: 3.0,
        };
        const lowWeightMission: Mission = {
            id: 'mission:pk-low',
            participants: ['Alpha', 'Beta'],
            state: 'staging',
            kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1 }],
            consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 20 }],
            weight: 1.0,
        };
        const highWeightMission: Mission = {
            id: 'mission:pk-high',
            participants: ['Alpha', 'Beta'],
            state: 'running',
            kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1 }],
            consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 20 }],
            weight: 4.0,
        };

        const snapshot = makeSnapshot({
            Alpha: makeAccount('Alpha', { role: 'army', bank: { items: { 385: 10 }, observedAt: NOW - 1000, trusted: true } }),
            Beta: makeAccount('Beta', { role: 'army', bank: { items: {}, observedAt: NOW - 1000, trusted: true } }),
        });

        const evals = evaluateMissions([pausedMission, lowWeightMission, highWeightMission], snapshot);
        expect(evals[0]!.effectiveWeight).toBe(0);
        expect(evals[0]!.shortfalls).toEqual([]);

        expect(evals[1]!.effectiveWeight).toBe(1.0);
        expect(evals[2]!.effectiveWeight).toBe(4.0);

        const lowShark = evals[1]!.shortfalls.find((d) => d.target.kind === 'item' && d.target.itemId === 385)!;
        const highShark = evals[2]!.shortfalls.find((d) => d.target.kind === 'item' && d.target.itemId === 385)!;
        expect(lowShark.remaining).toBe(30); // 2 * 20 - 10
        expect(highShark.valueScore).toBeCloseTo(lowShark.valueScore * 4, 5);
        expect(missionShortfalls(highWeightMission, snapshot).totalFulfilledUnits).toBe(10);
    });

    test('DemandEngine emits all 7 GoalKinds normalized in valuePerHour and respects army maxLevels caps', () => {
        const catalog = defaultActivityCatalog();
        const campaigns: Campaign[] = [
            {
                id: 'campaign:haggis',
                account: 'haggis',
                protectedClock: true,
                board: 'Overall',
                requiredSupplies: [{ itemId: 1519, itemName: 'Willow logs', count: 200 }],
                stagingHolder: 'HelperSupply',
                rehearsalProof: null,
                hiscoreMargin: null,
                state: 'staging',
                weight: 2.0,
            },
            {
                id: 'campaign:hiltsdeep',
                account: 'hiltsdeep',
                protectedClock: true,
                board: 'Attack',
                requiredSupplies: [{ itemId: 536, itemName: 'Dragon bones', count: 50 }],
                stagingHolder: 'HelperSupply',
                rehearsalProof: null,
                hiscoreMargin: null,
                state: 'staging',
                weight: 1.5,
            },
        ];

        const missions: Mission[] = [
            {
                id: 'mission:pk-squad',
                participants: ['PureOne'],
                state: 'staging',
                kitTargets: [{ itemId: 1333, itemName: 'Rune scimitar', countPerParticipant: 1 }],
                consumables: [{ itemId: 385, itemName: 'Shark', countPerParticipant: 20 }],
                weight: 1.0,
            },
        ];

        const engine = createDemandEngine({
            catalog,
            campaigns,
            missions,
            root: tempRoot,
            coinReserveFloor: 200_000,
            gearTargets: [{ itemId: 4587, itemName: 'Dragon scimitar', slot: 'righthand', count: 1, valueWeight: 120 }],
            questCatalog: [{ slug: 'waterfall_quest', valueScore: 300 }],
            skillTargets: [{ account: 'HelperSupply', skill: 'Woodcutting', targetLevel: 60, goalKind: 'main_supply' }],
        });

        const snapshot = makeSnapshot({
            haggis: makeAccount('haggis', { protectedClock: true, lifecycle: 'reserved', role: 'main' }),
            hiltsdeep: makeAccount('hiltsdeep', { protectedClock: true, lifecycle: 'reserved', role: 'specialist' }),
            HelperSupply: makeAccount('HelperSupply', {
                role: 'helper',
                skills: { Woodcutting: { level: 30, xp: 13_363 } },
                bank: { items: { 995: 50_000, 1519: 50 }, observedAt: NOW - 1000, trusted: true },
            }),
            PureOne: makeAccount('PureOne', {
                role: 'army',
                maxLevels: { Defence: 1 },
                skills: {
                    Attack: { level: 60, xp: 273_742 },
                    Strength: { level: 85, xp: 3_258_594 },
                    Defence: { level: 1, xp: 0 },
                    Hitpoints: { level: 80, xp: 1_986_068 },
                    Ranged: { level: 85, xp: 3_258_594 },
                    Magic: { level: 85, xp: 3_258_594 },
                    Prayer: { level: 52, xp: 123_660 },
                },
                bank: { items: { 995: 10_000 }, observedAt: NOW - 1000, trusted: true },
            }),
        });

        const report = engine.evaluate(snapshot);
        expect(report.demands.length).toBeGreaterThan(0);

        const goalKinds = new Set(report.demands.map((d) => d.goalKind));
        expect(goalKinds.has('main_supply')).toBe(true);
        expect(goalKinds.has('specialist_prep')).toBe(true);
        expect(goalKinds.has('quest_board')).toBe(true);
        expect(goalKinds.has('gear_collection')).toBe(true);
        expect(goalKinds.has('pk_army')).toBe(true);
        expect(goalKinds.has('squad_supply')).toBe(true);
        expect(goalKinds.has('coin_fund')).toBe(true);

        const targetKinds = new Set(report.demands.map((d) => d.target.kind));
        expect(targetKinds.has('item')).toBe(true);
        expect(targetKinds.has('skill')).toBe(true);
        expect(targetKinds.has('quest')).toBe(true);
        expect(targetKinds.has('coins')).toBe(true);
        expect(targetKinds.has('combat_readiness')).toBe(true);

        // Verify sorting is strictly descending by valuePerHour and all demands validate
        for (let i = 0; i < report.demands.length; i++) {
            const d = report.demands[i]!;
            expect(validateGoalDemand(d)).toEqual([]);
            expect(d.valuePerHour).toBeGreaterThan(0);
            if (i > 0) {
                expect(report.demands[i - 1]!.valuePerHour!).toBeGreaterThanOrEqual(d.valuePerHour!);
            }
        }

        // PureOne Defence cap=1 must be honored in combat_readiness target
        const pureArmyDemand = report.demands.find(
            (d) => d.goalKind === 'pk_army' && d.target.kind === 'combat_readiness' && d.target.account === 'PureOne',
        );
        expect(pureArmyDemand).toBeDefined();
        if (pureArmyDemand?.target.kind === 'combat_readiness') {
            expect(pureArmyDemand.target.targets.Defence).toBe(1);
        }

        // Operator command pausing mission removes squad_supply demands
        const pausedOk = engine.applyOperatorCommand({
            schemaVersion: 1,
            id: 'cmd-pause-pk',
            issuedAt: NOW + 1000,
            issuedBy: 'owner',
            kind: 'set_mission_state',
            missionId: 'mission:pk-squad',
            state: 'paused',
        });
        expect(pausedOk).toBe(true);
        expect(engine.activeDemands(snapshot).some((d) => d.goalKind === 'squad_supply')).toBe(false);
    });

    test('DemandEngine skips quest:mode-* and experimental quests and resolves lowercase-keyed snapshot accounts', () => {
        const catalog = defaultActivityCatalog();
        const engine = createDemandEngine({
            catalog,
            skillTargets: [
                { account: 'LowercaseBot', skill: 'Mining', targetLevel: 60, goalKind: 'specialist_prep', valueScore: 100 },
            ],
        });
        const lvl50Bot = makeAccount('LowercaseBot', {
            skills: { Mining: { level: 50, xp: 105_000 } },
        });
        const lvl1Bot = makeAccount('LowercaseBot', {
            skills: { Mining: { level: 1, xp: 0 } },
        });
        const lowerSnap = makeSnapshot({ lowercasebot: lvl50Bot });
        const lvl1Snap = makeSnapshot({ lowercasebot: lvl1Bot });

        const lowerDemands = engine.activeDemands(lowerSnap);
        expect(lowerDemands.some((d) => d.id.startsWith('goal:quest_board:mode-'))).toBe(false);
        expect(lowerDemands.some((d) => ['goal:quest_board:arrav', 'goal:quest_board:hero', 'goal:quest_board:legends'].includes(d.id))).toBe(false);

        const skillDemand50 = lowerDemands.find((d) => d.id === 'goal:specialist_prep:skill:LowercaseBot:Mining')!;
        const skillDemand1 = engine.activeDemands(lvl1Snap).find((d) => d.id === 'goal:specialist_prep:skill:LowercaseBot:Mining')!;
        expect(skillDemand50).toBeDefined();
        expect(skillDemand50.valuePerHour!).toBeGreaterThan(skillDemand1.valuePerHour!);
    });

    test('levelToXp matches server 25x xp-curve, aliases suppress completed quests, tightened specialists down-rank, and noted supplies canonicalize', () => {
        expect(levelToXp(99)).toBe(xpForLevel(99));
        expect(levelToXp(90)).toBe(xpForLevel(90));

        const catalog = defaultActivityCatalog();
        const engine = createDemandEngine({
            catalog,
            questCatalog: [
                { slug: 'dig', valueScore: 200 },
                { slug: 'itwatchtower', valueScore: 200 },
                { slug: 'barcrawl', valueScore: 200 },
            ],
        });
        const questSnap = makeSnapshot({
            QuestDoneBot: makeAccount('QuestDoneBot', {
                quests: {
                    'Digsite Quest': 'complete',
                    'Watch Tower': 'complete',
                },
            }),
        });
        const questDemands = engine.activeDemands(questSnap).filter((d) => d.goalKind === 'quest_board');
        expect(questDemands.some((d) => d.id === 'goal:quest_board:dig')).toBe(false);
        expect(questDemands.some((d) => d.id === 'goal:quest_board:itwatchtower')).toBe(false);
        expect(questDemands.some((d) => d.id === 'goal:quest_board:barcrawl')).toBe(true);

        const readyPositive: Campaign = {
            id: 'campaign:polevaulter',
            account: 'polevaulter',
            protectedClock: true,
            board: 'Agility',
            requiredSupplies: [{ itemId: 3032, itemName: 'Agility potion(4)', count: 6 }],
            stagingHolder: 'Stager',
            rehearsalProof: { verified: true, ticks: 5913 },
            hiscoreMargin: {
                board: 'Agility',
                rivalTicks: 6155,
                ourTicks: 5913,
                marginTicks: 242,
                marginRatio: 0.039,
                checkedAt: NOW,
                meetsMargin: true,
            },
            state: 'ready',
            weight: 1.0,
        };
        const tightenedBoard: Campaign = {
            id: 'campaign:hiltsdeep',
            account: 'hiltsdeep',
            protectedClock: true,
            board: 'Attack',
            requiredSupplies: [{ itemId: 536, itemName: 'Dragon bones', count: 11 }],
            stagingHolder: 'Stager',
            rehearsalProof: { verified: true, ticks: 3815 },
            hiscoreMargin: {
                board: 'Attack',
                rivalTicks: 2607,
                ourTicks: 3815,
                marginTicks: -1208,
                marginRatio: -0.46,
                checkedAt: NOW,
                meetsMargin: false,
            },
            state: 'staging',
            weight: 1.0,
        };
        const notedSpecialist: Campaign = {
            id: 'campaign:fullblooded',
            account: 'fullblooded',
            protectedClock: true,
            board: 'Hitpoints',
            requiredSupplies: [
                { itemId: 386, itemName: 'Shark', count: 20 },
                { itemId: 2435, itemName: 'Prayer potion(4)', count: 18 },
            ],
            stagingHolder: 'Stager',
            rehearsalProof: null,
            hiscoreMargin: null,
            state: 'staging',
            weight: 1.0,
        };
        const supplySnap = makeSnapshot({
            Stager: makeAccount('Stager', {
                bank: { items: { 385: 20, 2434: 8 }, observedAt: NOW - 1000, trusted: true },
            }),
        });
        const evals = evaluateCampaigns([readyPositive, tightenedBoard, notedSpecialist], supplySnap);
        expect(evals[0]!.shortfalls[0]!.priorityWeight).toBe(1.0);
        expect(evals[1]!.shortfalls[0]!.priorityWeight).toBeCloseTo(0.15, 5);
        expect(evals[2]!.shortfalls).toHaveLength(1);
        expect(evals[2]!.shortfalls[0]!.target.kind === 'item' && evals[2]!.shortfalls[0]!.target.itemId).toBe(2434);
        expect(evals[2]!.shortfalls[0]!.fulfilled).toBe(8);
        expect(evals[2]!.shortfalls[0]!.remaining).toBe(10);
    });
});
