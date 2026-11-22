import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import { isFleetPlan, isFleetState } from '../src/contracts';
import { formatShadowSummary, runShadowVerification } from '../src/shadow-cli';

const NOW = 1_700_000_000_000;

function writeJson(file: string, data: unknown): void {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
}

test('shadow CLI runs offline read-only across full fleet fixture, verifying protected clocks, veterans, campaigns, missions, recovery, and anti-ping-pong', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'brain-shadow-'));
    try {
        const owners: Record<string, { side: string; server: string }> = {
            Haggis: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            FreshBoy: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            QuestPro: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            ChefPro: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            TribridPro: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            PausedHelper: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            CloudGuy: { side: 'cloud', server: 'rs-sdk-demo.fly.dev' },
        };
        for (const spec of Object.keys(SPECIALIST_BOARDS)) {
            owners[spec] = { side: 'local', server: 'rs-sdk-demo.fly.dev' };
        }
        writeJson(join(tempRoot, 'fleet', 'owners.json'), { accounts: owners });
        writeJson(join(tempRoot, 'swarm.json'), { maxBots: 12, minFreeGB: 4, jobs: [] });
        mkdirSync(join(tempRoot, '.practice', 'live'), { recursive: true });
        writeFileSync(join(tempRoot, '.practice', 'live', 'stop-PausedHelper'), 'owner pause test\n');

        const OFFLINE_AT = NOW - 20 * 60_000;
        const statusDir = join(tempRoot, '.practice', 'live', 'status');
        writeJson(join(statusDir, 'Haggis.json'), {
            name: 'Haggis',
            server: 'rs-sdk-demo.fly.dev',
            at: OFFLINE_AT,
            result: 'done',
            pos: { x: 3222, z: 3218, level: 0 },
            skills: [{ name: 'Attack', level: 1, xp: 0 }],
            bankAt: OFFLINE_AT,
            bank: [{ id: 995, name: 'Coins', count: 10_000 }],
        });
        writeJson(join(statusDir, 'FreshBoy.json'), {
            name: 'FreshBoy',
            server: 'rs-sdk-demo.fly.dev',
            at: OFFLINE_AT,
            result: 'done',
            pos: { x: 3222, z: 3218, level: 0 },
            skills: [{ name: 'Attack', level: 1, xp: 0 }, { name: 'Strength', level: 1, xp: 0 }],
            inventory: [{ id: 995, name: 'Coins', count: 1500 }],
            bankAt: OFFLINE_AT,
            bank: [],
        });
        writeJson(join(statusDir, 'ChefPro.json'), {
            name: 'ChefPro',
            server: 'rs-sdk-demo.fly.dev',
            at: OFFLINE_AT,
            result: 'done',
            pos: { x: 2817, z: 3443, level: 0 },
            skills: [{ name: 'Cooking', level: 92, xp: 6_600_000 }],
            bankAt: OFFLINE_AT,
            bank: [{ id: 383, name: 'Raw shark', count: 500 }, { id: 995, name: 'Coins', count: 25_000 }],
        });
        writeJson(join(statusDir, 'TribridPro.json'), {
            name: 'TribridPro',
            server: 'rs-sdk-demo.fly.dev',
            at: OFFLINE_AT,
            result: 'done',
            pos: { x: 3094, z: 3494, level: 0 },
            skills: [
                { name: 'Attack', level: 99, xp: 13_034_431 },
                { name: 'Strength', level: 99, xp: 13_034_431 },
                { name: 'Defence', level: 99, xp: 13_034_431 },
                { name: 'Hitpoints', level: 99, xp: 13_034_431 },
                { name: 'Ranged', level: 99, xp: 13_034_431 },
                { name: 'Magic', level: 99, xp: 13_034_431 },
                { name: 'Prayer', level: 70, xp: 737_627 },
            ],
            bankAt: OFFLINE_AT,
            bank: [{ id: 385, name: 'Shark', count: 200 }, { id: 995, name: 'Coins', count: 100_000 }],
        });
        writeJson(join(statusDir, 'QuestPro.json'), {
            name: 'QuestPro',
            server: 'rs-sdk-demo.fly.dev',
            at: OFFLINE_AT,
            result: 'done',
            pos: { x: 2728, z: 3348, level: 0 },
            skills: [
                { name: 'Agility', level: 60, xp: 280_000 },
                { name: 'Crafting', level: 55, xp: 170_000 },
                { name: 'Herblore', level: 50, xp: 105_000 },
                { name: 'Mining', level: 55, xp: 170_000 },
                { name: 'Prayer', level: 45, xp: 65_000 },
                { name: 'Smithing', level: 55, xp: 170_000 },
                { name: 'Strength', level: 55, xp: 170_000 },
                { name: 'Thieving', level: 55, xp: 170_000 },
                { name: 'Woodcutting', level: 55, xp: 170_000 },
            ],
            quests: [
                { id: 1, name: "Hero's Quest", state: 'complete' },
                { id: 2, name: 'Underground Pass', state: 'complete' },
                { id: 3, name: 'Waterfall Quest', state: 'complete' },
                ...Array.from({ length: 12 }, (_, idx) => ({ id: 10 + idx, name: `Quest ${idx}`, state: 'complete' })),
            ],
            bankAt: OFFLINE_AT,
            bank: [{ id: 995, name: 'Coins', count: 50_000 }],
        });

        const report = runShadowVerification({ root: tempRoot, now: NOW, side: 'local' });
        expect(report.liveLoginsPerformed).toBe(0);
        expect(isFleetPlan(report.fleetPlan)).toBe(true);
        expect(isFleetState(report.fleetState)).toBe(true);
        expect(report.summary.protectedAccountsCount).toBeGreaterThanOrEqual(20);
        expect(report.summary.protectedAccountsIdle).toBe(report.summary.protectedAccountsCount);
        expect(report.summary.checksPassed).toBe(report.summary.checksTotal);
        expect(report.checks.some((c) => c.name === 'worker_engine_coverage' && c.ok)).toBe(true);
        for (const chk of report.checks) {
            expect(chk.ok).toBe(true);
        }

        // Haggis and every specialist remain completely offline with zero steps.
        expect(report.fleetPlan.accountPlans.Haggis?.steps).toEqual([]);
        for (const spec of Object.keys(SPECIALIST_BOARDS)) {
            expect(report.fleetPlan.accountPlans[spec]?.steps).toEqual([]);
        }
        expect(report.fleetPlan.accountPlans.PausedHelper?.idleReason).toBe('paused_owner');
        expect(report.fleetPlan.accountPlans.CloudGuy?.idleReason).toBe('owned_by_other_side:cloud');

        const summary = formatShadowSummary(report);
        expect(summary).toContain('Shadow Verification');
        expect(summary).toContain('liveLogins=0');
        expect(summary).toContain('[PASS]');
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('shadow CLI works read-only on main repo root when present', () => {
    const mainRoot = 'F:/dev-on-f/osrs-rs-research/rs-sdk-bot';
    if (!existsSync(join(mainRoot, 'fleet', 'owners.json'))) return;
    const report = runShadowVerification({ root: mainRoot, now: Date.now() });
    expect(report.liveLoginsPerformed).toBe(0);
    expect(report.summary.totalOwnedAccounts).toBeGreaterThan(0);
    expect(report.summary.checksPassed).toBe(report.summary.checksTotal);
}, 20_000);
