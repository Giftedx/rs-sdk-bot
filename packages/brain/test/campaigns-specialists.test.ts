import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RESERVED_ACCOUNTS, SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import {
    ALL_SPECIALIST_CAMPAIGN_SPECS,
    RETIRED_SPECIALIST_CAMPAIGN_SPECS,
    SPECIALIST_CAMPAIGN_BY_ACCOUNT,
    SPECIALIST_CAMPAIGN_SPECS,
    campaignShortfalls,
    getSpecialistCampaignSpec,
    isReservedSpecialistAccount,
    loadCampaignManifests,
    toDefaultSpecialistCampaign,
    validateCampaign,
    type AccountState,
    type WorldSnapshot,
} from '../src/index';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const NOW = 1_800_000_000_000;
let tempRoot = '';

function writeJson(filePath: string, data: unknown): void {
    mkdirSync(resolve(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function makeAccount(name: string, items: Readonly<Record<number, number>> = {}): AccountState {
    return {
        name,
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: { level: 50, xp: 101_333 } },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        equipment: {},
        bank: { items, observedAt: NOW - 1000, trusted: true },
    };
}

function makeWorld(
    accounts: Readonly<Record<string, AccountState>>,
    reserves: WorldSnapshot['reserves'] = {},
): WorldSnapshot {
    return {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts,
        reserves,
    };
}

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'brain-specialists-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('Declarative specialist Campaign specs & manifest loading', () => {
    test('covers every reserved account in SPECIALIST_BOARDS and all 4 retired launch accounts with protectedClock=true', () => {
        const boardKeys = Object.keys(SPECIALIST_BOARDS).sort();
        const specKeys = SPECIALIST_CAMPAIGN_SPECS.map((s) => s.account).sort();
        expect(specKeys).toEqual(boardKeys);
        expect(SPECIALIST_CAMPAIGN_SPECS).toHaveLength(19);
        expect(RETIRED_SPECIALIST_CAMPAIGN_SPECS).toHaveLength(4);
        expect(ALL_SPECIALIST_CAMPAIGN_SPECS).toHaveLength(23);

        for (const name of RESERVED_ACCOUNTS) {
            expect(isReservedSpecialistAccount(name)).toBe(true);
            if (name !== 'haggis') {
                expect(getSpecialistCampaignSpec(name)).toBeDefined();
            }
        }

        for (const spec of ALL_SPECIALIST_CAMPAIGN_SPECS) {
            expect(spec.protectedClock).toBe(true);
            expect(existsSync(join(REPO_ROOT, spec.script))).toBe(true);
            expect(spec.requiredSupplies.length).toBeGreaterThan(0);

            const seenIds = new Set<number>();
            for (const req of spec.requiredSupplies) {
                expect(Number.isSafeInteger(req.itemId)).toBe(true);
                expect(req.itemId).toBeGreaterThan(0);
                expect(Number.isSafeInteger(req.count)).toBe(true);
                expect(req.count).toBeGreaterThan(0);
                expect(seenIds.has(req.itemId)).toBe(false);
                seenIds.add(req.itemId);
            }

            const defaultCampaign = toDefaultSpecialistCampaign(spec);
            expect(validateCampaign(defaultCampaign)).toEqual([]);
            expect(defaultCampaign.protectedClock).toBe(true);
            expect(defaultCampaign.board).toBe(spec.board);
            expect(defaultCampaign.stagingHolder).toBe(spec.defaultStagingHolder);
            expect(defaultCampaign.rehearsalProof).toBeNull();
        }
    });

    test('matches exact authoritative supply bills & staging holders converted from .practice/specialist-launch/', () => {
        const hiltsdeep = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('hiltsdeep')!;
        expect(hiltsdeep.planTicks).toBe(3815);
        expect(hiltsdeep.defaultStagingHolder).toBe('Quickhandjob');
        expect(hiltsdeep.requiredSupplies.find((s) => s.itemId === 536)?.count).toBe(11);
        expect(hiltsdeep.requiredSupplies.find((s) => s.itemId === 556)?.count).toBe(1300);

        const shaftshooter = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('shaftshooter')!;
        expect(shaftshooter.planTicks).toBe(4660);
        expect(shaftshooter.defaultStagingHolder).toBe('Shaftsinker');
        expect(shaftshooter.requiredSupplies.find((s) => s.itemId === 2)?.count).toBe(1500);
        expect(shaftshooter.requiredSupplies.find((s) => s.itemId === 892)?.count).toBe(1000);

        const fullblooded = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('fullblooded')!;
        expect(fullblooded.planTicks).toBe(8900);
        expect(fullblooded.defaultStagingHolder).toBe('Woodenstaff');
        expect(fullblooded.requiredSupplies.find((s) => s.itemId === 2435)?.count).toBe(18);

        const lochnessrod = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('lochnessrod')!;
        expect(lochnessrod.planTicks).toBe(2915);
        expect(lochnessrod.defaultStagingHolder).toBe('Moneyshot');
        expect(lochnessrod.requiredSupplies.find((s) => s.itemId === 314)?.count).toBe(1500);

        const mineshafted = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('mineshafted')!;
        expect(mineshafted.planTicks).toBe(3830);
        expect(mineshafted.defaultStagingHolder).toBe('Moneyshot');
        expect(mineshafted.requiredSupplies.find((s) => s.itemId === 1275)?.count).toBe(1);

        const bigboner = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('bigboner')!;
        expect(bigboner.requiredSupplies).toEqual([{ itemId: 536, itemName: 'Dragon bones', count: 555, stage: 'Prayer' }]);

        const pouchstuffed = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('pouchstuffed')!;
        expect(pouchstuffed.requiredSupplies.find((s) => s.itemId === 1436)?.count).toBe(5355);

        const lightmylog = SPECIALIST_CAMPAIGN_BY_ACCOUNT.get('lightmylog')!;
        const fmCounts = new Map(lightmylog.requiredSupplies.map((r) => [r.itemId, r.count]));
        expect(fmCounts.get(1511)).toBe(2);
        expect(fmCounts.get(1521)).toBe(4);
        expect(fmCounts.get(1519)).toBe(7);
        expect(fmCounts.get(1517)).toBe(13);
        expect(fmCounts.get(1515)).toBe(24);
        expect(fmCounts.get(1513)).toBeGreaterThanOrEqual(107);

        const retiredFletch = getSpecialistCampaignSpec('justthetip')!;
        expect(retiredFletch.status).toBe('retired');
        expect(retiredFletch.requiredSupplies.find((s) => s.itemId === 53)?.count).toBe(3720);
    });

    test('loads all campaigns with declarative supplies even on a clean checkout without .practice files', () => {
        const manifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        expect(manifests).toHaveLength(20);

        const hilts = manifests.find((c) => c.account === 'hiltsdeep')!;
        expect(hilts.protectedClock).toBe(true);
        expect(hilts.stagingHolder).toBe('Quickhandjob');
        expect(hilts.requiredSupplies.length).toBeGreaterThanOrEqual(10);
        expect(hilts.rehearsalProof).toBeNull();
        expect(hilts.state).toBe('staging');

        const withRetired = loadCampaignManifests({ root: tempRoot, now: NOW, includeRetiredSpecialists: true });
        expect(withRetired).toHaveLength(24);
        expect(withRetired.some((c) => c.account === 'justthetip' && c.protectedClock)).toBe(true);
        expect(withRetired.some((c) => c.account === 'nockandload' && c.stagingHolder === 'NabTheKnob')).toBe(true);
    });

    test('evaluates practice overlay manifests, staging holders, rehearsal proofs, hiscore 2% margin, stops, and rank-1 completion', () => {
        const launchDir = join(tempRoot, '.practice', 'specialist-launch');
        writeJson(join(launchDir, 'hiscores.json'), {
            takenAt: new Date(NOW - 60_000).toISOString(),
            boards: [
                {
                    board: 'Attack',
                    category: 1,
                    rows: [{ rank: 1, name: 'RivalAtk', level: 99, ticks: 4000 }],
                },
                {
                    board: 'Fishing',
                    category: 11,
                    rows: [{ rank: 1, name: 'RivalFish', level: 99, ticks: 2950 }],
                },
                {
                    board: 'Mining',
                    category: 15,
                    rows: [{ rank: 1, name: 'mineshafted', level: 99, ticks: 3800 }],
                },
            ],
        });

        writeJson(join(launchDir, 'rehearsal-live-3', 'hiltsdeep-attack-99.receipt.json'), {
            ok: true,
            died: false,
            logout: 'logged-out',
            at: NOW - 30_000,
            context: 'abc123',
            boardTicks: { Attack: 3815 },
        });
        writeJson(join(launchDir, 'staging.json'), {
            allocations: [{ recipient: 'hiltsdeep', holder: 'StageAlt', itemId: 536, count: 11 }],
        });
        writeJson(join(launchDir, 'hiltsdeep.json'), {
            version: 1,
            account: 'hiltsdeep',
            board: 'Attack',
            planTicks: 3815,
            requirements: [{ itemId: 536, item: 'Dragon bones', count: 11 }],
            rehearsal: { path: '.practice/specialist-launch/rehearsal-live-3/hiltsdeep-attack-99.receipt.json' },
            staging: { path: '.practice/specialist-launch/staging.json' },
        });
        writeJson(join(launchDir, 'hiltsdeep.go.json'), { version: 2, account: 'hiltsdeep' });

        // lochnessrod planTicks=2915 vs rival=2950 fails 2% margin (ceil(2950*0.02)=59, diff=35 < 59)
        writeJson(join(launchDir, 'rehearsal-fishing', 'lochnessrod-fishing-99.receipt.json'), {
            ok: true,
            died: false,
            logout: 'logged-out',
            at: NOW - 20_000,
            boardTicks: { Fishing: 2915 },
        });

        // rocksolid paused via owner stop file
        mkdirSync(join(tempRoot, '.practice'), { recursive: true });
        writeFileSync(join(tempRoot, '.practice', 'stop-rocksolid'), 'manual owner hold', 'utf8');

        const manifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        const hilts = manifests.find((c) => c.account === 'hiltsdeep')!;
        expect(hilts.state).toBe('running');
        expect(hilts.stagingHolder).toBe('StageAlt');
        expect(hilts.rehearsalProof).toMatchObject({ verified: true, ticks: 3815 });
        expect(hilts.hiscoreMargin).toMatchObject({
            board: 'Attack',
            rivalTicks: 4000,
            ourTicks: 3815,
            marginTicks: 185,
            meetsMargin: true,
        });

        const evalHilts = campaignShortfalls(hilts, makeWorld({ StageAlt: makeAccount('StageAlt', { 536: 7 }) }, { StageAlt: { 536: 2 } }));
        expect(evalHilts.launchReady).toBe(false);
        expect(evalHilts.missingGates).toContain('supplies');
        expect(evalHilts.shortfalls).toHaveLength(1);
        expect(evalHilts.shortfalls[0]).toMatchObject({
            id: 'campaign:hiltsdeep:item:536',
            remaining: 6,
            fulfilled: 5,
            target: { kind: 'item', itemId: 536, holder: 'StageAlt' },
        });
        expect(evalHilts.shortfalls[0]?.assignedAccount).toBeUndefined();

        const evalHiltsReady = campaignShortfalls(hilts, makeWorld({ StageAlt: makeAccount('StageAlt', { 536: 13 }) }, { StageAlt: { 536: 2 } }));
        expect(evalHiltsReady.launchReady).toBe(true);
        expect(evalHiltsReady.shortfalls).toHaveLength(0);

        const loch = manifests.find((c) => c.account === 'lochnessrod')!;
        expect(loch.hiscoreMargin?.meetsMargin).toBe(false);
        expect(loch.state).toBe('staging');

        const rock = manifests.find((c) => c.account === 'rocksolid')!;
        expect(rock.state).toBe('paused');

        const mine = manifests.find((c) => c.account === 'mineshafted')!;
        expect(mine.state).toBe('completed');
    });

    test('expired specialist .go.json tokens fall back to ready instead of running', () => {
        const launchDir = join(tempRoot, '.practice', 'specialist-launch');
        writeJson(join(launchDir, 'hiscores.json'), {
            takenAt: new Date(NOW).toISOString(),
            boards: [{ board: 'Fishing', category: 11, rows: [{ rank: 1, name: 'Rival', level: 99, ticks: 3200 }] }],
        });
        writeJson(join(launchDir, 'rehearsal-fishing', 'lochnessrod-fishing-99.receipt.json'), {
            ok: true,
            died: false,
            logout: 'logged-out',
            at: NOW - 30_000,
            boardTicks: { Fishing: 2778 },
        });
        writeJson(join(launchDir, 'lochnessrod.json'), {
            version: 1,
            account: 'lochnessrod',
            board: 'Fishing',
            planTicks: 2778,
            requirements: [],
            rehearsal: { path: '.practice/specialist-launch/rehearsal-fishing/lochnessrod-fishing-99.receipt.json' },
        });
        writeJson(join(launchDir, 'lochnessrod.go.json'), {
            version: 2,
            account: 'lochnessrod',
            runUntil: NOW - 10_000,
        });

        const expiredManifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        expect(expiredManifests.find((c) => c.account === 'lochnessrod')?.state).toBe('ready');

        writeJson(join(launchDir, 'lochnessrod.go.json'), {
            version: 2,
            account: 'lochnessrod',
            runUntil: NOW + 60_000,
        });
        const activeManifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        expect(activeManifests.find((c) => c.account === 'lochnessrod')?.state).toBe('running');
    });

    test('prefers newest hiscore snapshot by takenAt over older specialist-launch snapshot', () => {
        const launchDir = join(tempRoot, '.practice', 'specialist-launch');
        writeJson(join(launchDir, 'hiscores.json'), {
            takenAt: new Date(NOW - 3_600_000).toISOString(),
            boards: [
                {
                    board: 'Attack',
                    category: 1,
                    rows: [{ rank: 1, name: 'hiltsdeep', level: 99, ticks: 3815 }],
                },
            ],
        });
        writeJson(join(tempRoot, 'research', 'hiscores-live.json'), {
            takenAt: new Date(NOW - 60_000).toISOString(),
            boards: [
                {
                    board: 'Attack',
                    category: 1,
                    rows: [{ rank: 1, name: 'nickatkquest', level: 99, ticks: 2607 }],
                },
            ],
        });

        const manifests = loadCampaignManifests({ root: tempRoot, now: NOW });
        const hilts = manifests.find((c) => c.account === 'hiltsdeep')!;
        expect(hilts.state).toBe('staging');
        expect(hilts.hiscoreMargin?.rivalTicks).toBe(2607);
        expect(hilts.hiscoreMargin?.meetsMargin).toBe(false);
    });

    test('uses active Haggis route (28,386 ticks, no boards-sum inflation) and computes specialist margins from repo hiscores', () => {
        const snapshotNow = Date.parse('2026-11-21T19:44:18.486Z');
        const manifests = loadCampaignManifests({ root: REPO_ROOT, now: snapshotNow });
        const haggis = manifests.find((c) => c.account === 'haggis')!;
        expect(haggis.hiscoreMargin?.ourTicks).toBe(28386);
        expect(haggis.hiscoreMargin?.meetsMargin).toBe(true);
        // Cannonballs from unchosen branches must not pollute Haggis's active route supplies,
        // and iron ore / blood runes match supply-bill.ts exact active-route quantities (2 and 2100).
        expect(haggis.requiredSupplies.some((s) => s.itemId === 2)).toBe(false);
        expect(haggis.requiredSupplies.find((s) => s.itemId === 440)?.count).toBe(2);
        expect(haggis.requiredSupplies.find((s) => s.itemId === 565)?.count).toBe(2100);

        const hilts = manifests.find((c) => c.account === 'hiltsdeep')!;
        expect(hilts.state).toBe('staging');
        expect(hilts.hiscoreMargin?.rivalTicks).toBe(2607);

        for (const positive of ['polevaulter', 'stickyfinger', 'castmyload', 'steelrod']) {
            const c = manifests.find((m) => m.account === positive)!;
            expect(c.hiscoreMargin?.meetsMargin).toBe(true);
        }
        for (const behind of ['bigboner', 'pouchstuffed']) {
            const c = manifests.find((m) => m.account === behind)!;
            expect(c.hiscoreMargin?.meetsMargin).toBe(false);
        }
    });

    test('uses verified rehearsal ticks over optimistic planTicks, ignores dead/paused stagingHolders, and enforces ready/running state in isCampaignLaunchReady', async () => {
        const { isCampaignLaunchReady } = await import('../src/contracts');
        const { campaignShortfalls } = await import('../src/campaigns');
        const tempRoot = mkdtempSync(join(tmpdir(), 'spec-launch-gates-'));
        try {
            writeJson(join(tempRoot, 'knowledge', 'items.json'), [{ id: 385, name: 'Shark', tradeable: true, cost: 600 }]);
            writeJson(join(tempRoot, '.practice', 'live', 'specialist-launch', 'hiltsdeep.json'), {
                planTicks: 2400,
                requirements: [{ itemId: 385, item: 'Shark', count: 50 }],
                rehearsal: { path: '.practice/specialist-hiltsdeep-rehearsal.json' },
                staging: { path: '.practice/specialist-hiltsdeep-staging.json' },
            });
            writeJson(join(tempRoot, '.practice', 'specialist-hiltsdeep-staging.json'), {
                allocations: [{ recipient: 'hiltsdeep', holder: 'PausedMule' }],
            });
            // Practice rehearsal came in slower (3100 ticks) than rival (2607 ticks) despite optimistic 2400 planTicks.
            writeJson(join(tempRoot, '.practice', 'specialist-hiltsdeep-rehearsal.json'), {
                ok: true,
                died: false,
                logout: 'logged-out',
                boardTicks: { Attack: 3100 },
                at: NOW - 10_000,
            });
            writeJson(join(tempRoot, 'research', 'hiscores-live.json'), {
                takenAt: new Date(NOW - 10_000).toISOString(),
                boards: [{ board: 'Attack', category: 1, rows: [{ rank: 1, name: 'rival', level: 99, ticks: 2607 }] }],
            });

            const manifests = loadCampaignManifests({ root: tempRoot, now: NOW });
            const hilts = manifests.find((c) => c.account === 'hiltsdeep')!;
            expect(hilts.hiscoreMargin?.ourTicks).toBe(3100);
            expect(hilts.hiscoreMargin?.meetsMargin).toBe(false);
            expect(hilts.state).toBe('staging');
            expect(isCampaignLaunchReady(hilts, { now: NOW })).toBe(false);

            // Even with verified rehearsal and positive margin, protectedClock campaigns in 'staging' must NOT launch.
            const stagingButMarginOk = {
                ...hilts,
                state: 'staging' as const,
                hiscoreMargin: { ...hilts.hiscoreMargin!, ourTicks: 2200, meetsMargin: true },
            };
            expect(isCampaignLaunchReady(stagingButMarginOk, { now: NOW })).toBe(false);
            expect(isCampaignLaunchReady({ ...stagingButMarginOk, state: 'ready' }, { now: NOW })).toBe(true);

            // Dead or owner-paused stagingHolder must count as 0 staged stock in campaignShortfalls.
            const snapPaused = {
                schemaVersion: 1 as const,
                at: NOW,
                side: 'local',
                server: 'rs-sdk-demo.fly.dev',
                accounts: {
                    PausedMule: {
                        name: 'PausedMule',
                        side: 'local',
                        server: 'rs-sdk-demo.fly.dev',
                        role: 'helper' as const,
                        lifecycle: 'paused_owner' as const,
                        protectedClock: false,
                        pos: null,
                        skills: {},
                        quests: {},
                        inventory: {},
                        equipment: {},
                        bank: { items: { 385: 500 }, observedAt: NOW - 1000, trusted: true },
                    },
                },
            };
            const evalRes = campaignShortfalls(hilts, snapPaused);
            expect(evalRes.totalFulfilledUnits).toBe(0);
            expect(evalRes.shortfalls[0]?.remaining).toBe(50);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('caches Haggis schedule across repeated loads while reflecting stop-file and hiscore changes', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'campaigns-haggis-cache-'));
        try {
            mkdirSync(join(tempRoot, 'packages', 'planner', 'src'), { recursive: true });
            copyFileSync(
                join(process.cwd(), 'packages', 'planner', 'src', 'haggis-boards.json'),
                join(tempRoot, 'packages', 'planner', 'src', 'haggis-boards.json'),
            );
            writeJson(join(tempRoot, 'research', 'hiscores-live.json'), {
                takenAt: new Date(NOW - 30_000).toISOString(),
                boards: [{ board: 'Overall', category: 0, rows: [{ rank: 1, name: 'rival', level: 1881, ticks: 29_972 }] }],
            });

            const first = loadCampaignManifests({ root: tempRoot, now: NOW, includeSpecialists: false });
            const second = loadCampaignManifests({ root: tempRoot, now: NOW + 1_000, includeSpecialists: false });
            expect(first).toHaveLength(1);
            expect(second[0]!.hiscoreMargin?.ourTicks).toBe(first[0]!.hiscoreMargin?.ourTicks);
            expect(second[0]!.requiredSupplies).toEqual(first[0]!.requiredSupplies);
            expect(second[0]!.state).toBe('staging');

            mkdirSync(join(tempRoot, '.practice'), { recursive: true });
            writeFileSync(join(tempRoot, '.practice', 'stop-haggis'), 'owner pause\n', 'utf8');
            const paused = loadCampaignManifests({ root: tempRoot, now: NOW + 2_000, includeSpecialists: false });
            expect(paused[0]!.state).toBe('paused');

            writeJson(join(tempRoot, 'research', 'hiscores-live.json'), {
                takenAt: new Date(NOW + 3_000).toISOString(),
                boards: [{ board: 'Overall', category: 0, rows: [{ rank: 1, name: 'rival', level: 1881, ticks: 25_000 }] }],
            });
            const updatedRival = loadCampaignManifests({ root: tempRoot, now: NOW + 4_000, includeSpecialists: false });
            expect(updatedRival[0]!.hiscoreMargin?.rivalTicks).toBe(25_000);
            expect(updatedRival[0]!.hiscoreMargin?.meetsMargin).toBe(false);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    }, 20_000);
});
