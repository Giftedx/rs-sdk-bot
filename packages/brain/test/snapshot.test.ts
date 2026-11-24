import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSessionAttempt } from '../../core/src/session-lifecycle';
import {
    classifyAccountLifecycle,
    createExpiringHold,
    DEFAULT_LIVE_SERVER,
    isStrandedPosition,
    lifecycleAutoExpires,
    loadWorldSnapshot,
    validateWorldSnapshot,
} from '../src/index';

let tempRoot = '';
const NOW = 1_800_000_000_000;

function writeJson(filePath: string, data: unknown): void {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeText(filePath: string, text: string): void {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, text, 'utf8');
}

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'brain-snapshot-'));
});

afterEach(() => {
    if (tempRoot) {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('WorldSnapshot loader & AccountLifecycle', () => {
    test('classifyAccountLifecycle enforces exact precedence and non-expiring flags', () => {
        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                ownerPaused: true,
                dead: true,
                protectedClock: true,
                running: true,
                inTrade: true,
                logoutProofState: 'held',
                strandedHold: true,
            }),
        ).toBe('paused_owner');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                ownerPaused: false,
                dead: true,
                protectedClock: true,
                running: true,
            }),
        ).toBe('dead');

        expect(
            classifyAccountLifecycle({
                name: 'hiltsdeep',
                protectedClock: true,
                running: false,
            }),
        ).toBe('reserved');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                inTrade: true,
                running: false,
                logoutProofState: 'confirmed',
                strandedHold: true,
            }),
        ).toBe('in_trade');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                running: true,
                logoutProofState: 'held',
                strandedHold: true,
            }),
        ).toBe('running');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                logoutProofState: 'held',
                strandedHold: true,
            }),
        ).toBe('needs_logout_recovery');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                logoutProofState: 'confirmed',
                pos: { x: 3208, z: 3214, level: 1 }, // Castle middle floor -> stranded
            }),
        ).toBe('needs_location_recovery');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                logoutProofState: 'confirmed',
                pos: { x: 3208, z: 3218, level: 2 }, // Lumbridge Castle Bank top floor -> safe hub
            }),
        ).toBe('idle');

        expect(
            classifyAccountLifecycle({
                name: 'Bot1',
                protectedClock: false,
                logoutProofState: 'confirmed',
                pos: { x: 3185, z: 3436, level: 0 },
            }),
        ).toBe('idle');

        expect(lifecycleAutoExpires('paused_owner')).toBe(false);
        expect(lifecycleAutoExpires('dead')).toBe(false);
        expect(lifecycleAutoExpires('needs_location_recovery')).toBe(true);
        expect(lifecycleAutoExpires('needs_logout_recovery')).toBe(true);
    });

    test('isStrandedPosition recognizes mainland hubs vs upstairs/remote/wilderness spots', () => {
        expect(isStrandedPosition(null)).toBe(false);
        expect(isStrandedPosition({ x: 3185, z: 3436, level: 0 })).toBe(false); // Varrock west bank
        expect(isStrandedPosition({ x: 2809, z: 3441, level: 0 })).toBe(false); // Catherby
        expect(isStrandedPosition({ x: 3208, z: 3218, level: 2 })).toBe(false); // Lumbridge Castle bank top floor
        expect(isStrandedPosition({ x: 3222, z: 3218, level: 1 })).toBe(true); // upstairs trap
        expect(isStrandedPosition({ x: 3100, z: 3700, level: 0 })).toBe(true); // Wilderness
        expect(isStrandedPosition({ x: 2050, z: 4500, level: 0 })).toBe(true); // isolated instance
    });

    test('loads .practice/live and legacy .practice paths, honors stop-swarm without pausing accounts, and validates bank trust', () => {
        // Fleet owners under .practice/live/fleet-data/fleet/owners.json
        writeJson(join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet', 'owners.json'), {
            accounts: {
                HelperOne: { side: 'local', server: DEFAULT_LIVE_SERVER },
                HelperTwo: { side: 'local', server: DEFAULT_LIVE_SERVER },
                HelperThree: { side: 'local', server: DEFAULT_LIVE_SERVER },
                DeadGuy: { side: 'local', server: DEFAULT_LIVE_SERVER },
                PausedGuy: { side: 'local', server: DEFAULT_LIVE_SERVER },
                hiltsdeep: { side: 'local', server: DEFAULT_LIVE_SERVER },
            },
        });

        // Side-wide stop-swarm sets fleetSides.local.stopped=true, NOT per-account paused_owner
        writeText(join(tempRoot, '.practice', 'stop-swarm'), 'owner pause requested\n');

        // Explicit owner pause on PausedGuy (in .practice/live) vs stale controller auto-stop on HelperOne (in legacy .practice)
        writeText(join(tempRoot, '.practice', 'live', 'stop-PausedGuy'), 'owner stop: manual audit\n');
        writeText(join(tempRoot, '.practice', 'stop-HelperOne'), 'fleet-health auto-paused: stale test\n');

        // Legacy swarm-deaths.json with a non-death "done" row for HelperOne and real "died" row for DeadGuy
        writeJson(join(tempRoot, '.practice', 'swarm-deaths.json'), {
            HelperOne: { reason: 'done after 1 runs', at: NOW - 10_000 },
            DeadGuy: { reason: 'died to moss giant', at: NOW - 5_000 },
        });

        // HelperOne: confirmed logout + fresh bank after latest attempt start -> idle & bank trusted=true
        const attempt1 = beginSessionAttempt(
            { account: 'HelperOne', server: DEFAULT_LIVE_SERVER },
            { root: join(tempRoot, '.practice', 'live', 'session-lifecycle'), now: () => NOW - 600_000 },
        );
        attempt1.record('ready');
        attempt1.record('ended', 'logged-out');

        writeJson(join(tempRoot, '.practice', 'live', 'status', 'HelperOne.json'), {
            name: 'HelperOne',
            server: DEFAULT_LIVE_SERVER,
            at: NOW - 120_000,
            started: NOW - 600_000,
            result: 'done',
            pos: { x: 3185, z: 3436, level: 0 },
            skills: [{ name: 'Attack', level: 50, xp: 101_333 }],
            quests: [{ name: 'cooks_assistant', state: 'complete' }],
            bank: [{ id: 995, count: 250_000 }],
            bankAt: NOW - 300_000,
        });

        // HelperTwo: legacy .practice/status/, bank observed BEFORE latest login attempt (without logout proof -> held)
        const attempt2 = beginSessionAttempt(
            { account: 'HelperTwo', server: DEFAULT_LIVE_SERVER },
            { root: join(tempRoot, '.practice', 'session-lifecycle'), now: () => NOW - 90_000 },
        );
        attempt2.record('ready');
        writeJson(join(tempRoot, '.practice', 'status', 'HelperTwo.json'), {
            name: 'HelperTwo',
            server: DEFAULT_LIVE_SERVER,
            at: NOW - 90_000,
            started: NOW - 90_000,
            result: 'fail disconnected',
            pos: { x: 3185, z: 3436, level: 0 },
            bank: [{ id: 385, count: 100 }],
            bankAt: NOW - 500_000, // older than lastLoginAttemptAt
        });

        // HelperThree: confirmed logout, but stranded upstairs on floor 1 -> needs_location_recovery
        const attempt3 = beginSessionAttempt(
            { account: 'HelperThree', server: DEFAULT_LIVE_SERVER },
            { root: join(tempRoot, '.practice', 'live', 'session-lifecycle'), now: () => NOW - 400_000 },
        );
        attempt3.record('ended', 'logged-out');
        writeJson(join(tempRoot, '.practice', 'live', 'status', 'HelperThree.json'), {
            name: 'HelperThree',
            server: DEFAULT_LIVE_SERVER,
            at: NOW - 350_000,
            result: 'fail stuck',
            pos: { x: 3208, z: 3214, level: 1 },
            bank: [],
            bankAt: NOW - 360_000,
        });

        // Hired expiring + active holds check
        const expiredHold = createExpiringHold({
            kind: 'retry_backoff',
            key: 'old-backoff',
            reason: 'old transient fault',
            now: NOW - 120_000,
            ttlMs: 60_000,
        });
        const activeHold = createExpiringHold({
            kind: 'maintenance',
            key: 'check-me',
            reason: 'still active',
            now: NOW - 10_000,
            ttlMs: 60_000,
        });

        const snapshot = loadWorldSnapshot({
            root: tempRoot,
            now: NOW,
            holdsByAccount: new Map([['helperone', [expiredHold, activeHold]]]),
            cooldownsByAccount: new Map([
                ['helperone', { '385:ge': NOW - 1, '1333:ge': NOW + 60_000 }],
            ]),
        });

        expect(validateWorldSnapshot(snapshot)).toEqual([]);
        expect(snapshot.fleetSides?.local?.stopped).toBe(true);

        const h1 = snapshot.accounts.helperone!;
        expect(h1.name).toBe('HelperOne');
        expect(h1.lifecycle).toBe('idle');
        expect(h1.bank.trusted).toBe(true);
        expect(h1.bank.items[995]).toBe(250_000);
        expect(h1.systemHolds?.map((h) => h.key)).toEqual(['check-me']);
        expect(h1.cooldowns).toEqual({ '1333:ge': NOW + 60_000 });

        const h2 = snapshot.accounts.helpertwo!;
        expect(h2.lifecycle).toBe('needs_logout_recovery');
        expect(h2.bank.trusted).toBe(false);

        const h3 = snapshot.accounts.helperthree!;
        expect(h3.lifecycle).toBe('needs_location_recovery');

        expect(snapshot.accounts.deadguy!.lifecycle).toBe('dead');
        expect(snapshot.accounts.pausedguy!.lifecycle).toBe('paused_owner');
        expect(snapshot.accounts.hiltsdeep!.lifecycle).toBe('reserved');
        expect(snapshot.accounts.hiltsdeep!.protectedClock).toBe(true);
    });

    test('settled fleet transfer newer than bank observation invalidates offline bank trust unless re-observed in same session', () => {
        writeJson(join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet', 'owners.json'), {
            accounts: {
                TraderA: { side: 'local', server: DEFAULT_LIVE_SERVER },
            },
        });
        const attempt = beginSessionAttempt(
            { account: 'TraderA', server: DEFAULT_LIVE_SERVER },
            { root: join(tempRoot, '.practice', 'live', 'session-lifecycle'), now: () => NOW - 500_000 },
        );
        attempt.record('ready');
        attempt.record('ended', 'logged-out');

        writeJson(join(tempRoot, '.practice', 'live', 'status', 'TraderA.json'), {
            name: 'TraderA',
            server: DEFAULT_LIVE_SERVER,
            at: NOW - 400_000,
            started: NOW - 500_000,
            result: 'done',
            pos: { x: 3185, z: 3436, level: 0 },
            bank: [{ id: 995, count: 1000 }],
            bankAt: NOW - 450_000,
        });

        // Transfer receipt occurred AFTER bankAt (-450_000) -> untrusted!
        writeJson(join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet', 'receipts', 't1.json'), {
            version: 2,
            id: 't1',
            account: 'TraderA',
            server: DEFAULT_LIVE_SERVER,
            state: 'settled',
            at: NOW - 200_000,
        });

        const snapshot = loadWorldSnapshot({ root: tempRoot, now: NOW });
        expect(validateWorldSnapshot(snapshot)).toEqual([]);
        expect(snapshot.accounts.tradera!.bank.trusted).toBe(false);
    });

    test('orders/receipts cache invalidates immediately when a new order or receipt file is written (>100 files)', () => {
        const fleetDir = join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet');
        writeJson(join(fleetDir, 'owners.json'), {
            accounts: {
                TraderA: { side: 'local', server: DEFAULT_LIVE_SERVER },
                TraderB: { side: 'local', server: DEFAULT_LIVE_SERVER },
            },
        });
        for (let i = 0; i < 105; i++) {
            writeJson(join(fleetDir, 'orders', `expired-${i}.json`), {
                id: `expired-${i}`,
                server: DEFAULT_LIVE_SERVER,
                from: 'TraderA',
                to: 'TraderB',
                item: 'Shark',
                itemId: 385,
                count: 10,
                start: NOW - 20_000,
                end: NOW - 10_000,
            });
        }

        const before = loadWorldSnapshot({ root: tempRoot, now: NOW });
        expect(before.accounts.tradera!.lifecycle).toBe('idle');
        expect(before.accounts.traderb!.lifecycle).toBe('idle');

        // Add a fresh active order + prepared receipt after caching has populated.
        writeJson(join(fleetDir, 'orders', 'active-1.json'), {
            id: 'active-1',
            server: DEFAULT_LIVE_SERVER,
            from: 'TraderA',
            to: 'TraderB',
            item: 'Shark',
            itemId: 385,
            count: 10,
            start: NOW - 1_000,
            end: NOW + 60_000,
        });
        writeJson(join(fleetDir, 'receipts', 'active-1.from.json'), {
            version: 2,
            id: 'active-1',
            account: 'TraderA',
            role: 'from',
            server: DEFAULT_LIVE_SERVER,
            state: 'prepared',
            at: NOW,
        });

        const during = loadWorldSnapshot({ root: tempRoot, now: NOW });
        expect(during.accounts.tradera!.lifecycle).toBe('in_trade');
        expect(during.accounts.traderb!.lifecycle).toBe('in_trade');
        expect(during.activeTransfers?.map((t) => t.id)).toEqual(['active-1']);

        // Settle the order with valid terminal v2 receipts and confirm cache invalidates.
        writeJson(join(fleetDir, 'receipts', 'active-1.from.json'), {
            version: 2,
            id: 'active-1',
            account: 'TraderA',
            partner: 'TraderB',
            role: 'from',
            server: DEFAULT_LIVE_SERVER,
            claim: '00000000-0000-4000-8000-000000000001',
            state: 'settled',
            ok: true,
            item: 'Shark',
            requested: 10,
            count: 10,
            inventory: { before: 10, after: 0 },
            logout: { attemptId: '1790000000000-1-1', sha256: 'a'.repeat(64), at: NOW },
            at: NOW,
        });
        writeJson(join(fleetDir, 'receipts', 'active-1.to.json'), {
            version: 2,
            id: 'active-1',
            account: 'TraderB',
            partner: 'TraderA',
            role: 'to',
            server: DEFAULT_LIVE_SERVER,
            claim: '00000000-0000-4000-8000-000000000002',
            state: 'settled',
            ok: true,
            item: 'Shark',
            requested: 10,
            count: 10,
            inventory: { before: 0, after: 10 },
            bank: { count: 10, at: NOW },
            logout: { attemptId: '1790000000000-2-1', sha256: 'b'.repeat(64), at: NOW },
            at: NOW,
        });

        const after = loadWorldSnapshot({ root: tempRoot, now: NOW + 1_000 });
        expect(after.accounts.tradera!.lifecycle).toBe('idle');
        expect(after.accounts.traderb!.lifecycle).toBe('idle');
    });
});
