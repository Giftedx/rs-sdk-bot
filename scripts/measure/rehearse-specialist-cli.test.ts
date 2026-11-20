import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SPECIALIST_BOARDS } from '../../packages/core/src/specialist-boards';
import { checkSpecialistSegment, resolveSegmentSuppliers } from '../../packages/practice/src/rehearse';
import { HP_SPECIALIST_KIT } from '../combat-quest-specialists';
import { CRAFTING_SUPPLY_BILL } from '../crafting-specialist';
import { HERBLORE_SUPPLY_BILL } from '../herblore-specialist';
import { MAGIC_SUPPLY_BILL } from '../magic-specialist';
import { PRAYER_RUNNER_COUNT, PRAYER_SUPPLY_BILL } from '../prayer-specialist';
import { RANGED_SPECIALIST_LIVE_KIT } from '../ranged-specialist';
import { BODY_RUNNER_COUNT, RUNECRAFT_SUPPLY_BILL } from '../runecraft-specialist';
import { SMITHING_SUPPLY_BILL } from '../smithing-specialist';
import {
    FLETCHING_SPECIALIST_LIVE_KIT,
    parseKitArg,
    resolveBaseId,
    THIEVING_SPECIALIST_LIVE_KIT,
} from '../specialist-supplier';
import {
    aggregateKitBank,
    collectRehearsalSummary,
    expandKitToSave,
    parseCliArgs,
    READY_SPECIALIST_ACCOUNTS,
    resolveSpecialistSegment,
    resolveSpecialistTargetCap,
    runHostedRehearsal,
} from './rehearse-specialist-cli';

function countSupplyMap(items: readonly { id: number; count: number }[]): Record<number, number> {
    const out: Record<number, number> = {};
    for (const item of items) {
        const base = resolveBaseId(item.id);
        out[base] = (out[base] ?? 0) + item.count;
    }
    return out;
}

test('all 10 ready specialists construct valid --specialist segments matching board expectations and supply bills', () => {
    expect(READY_SPECIALIST_ACCOUNTS).toEqual([
        'HalfInch',
        'NockAndLoad',
        'Shaftshooter',
        'FullBlooded',
        'PouchStuffed',
        'CutMyJewels',
        'GrindMyHerb',
        'CastMyLoad',
        'BigBoner',
        'SteelRod',
    ]);

    const expectedBills: Record<string, readonly { id: number; count: number }[]> = {
        HalfInch: THIEVING_SPECIALIST_LIVE_KIT.map(k => ({ id: k.id, count: k.count })),
        NockAndLoad: FLETCHING_SPECIALIST_LIVE_KIT.map(k => ({ id: k.id, count: k.count })),
        Shaftshooter: RANGED_SPECIALIST_LIVE_KIT.map(k => ({ id: k.id, count: k.count })),
        FullBlooded: HP_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
        PouchStuffed: RUNECRAFT_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
        CutMyJewels: CRAFTING_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
        GrindMyHerb: HERBLORE_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
        CastMyLoad: MAGIC_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
        BigBoner: PRAYER_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
        SteelRod: SMITHING_SUPPLY_BILL.map(b => ({ id: b.itemId, count: b.count })),
    };

    const expectedTargets: Record<string, number> = {
        HalfInch: 2221,
        NockAndLoad: 54,
        Shaftshooter: 5483,
        FullBlooded: 11116,
        PouchStuffed: 2207,
        CutMyJewels: 182,
        GrindMyHerb: 415,
        CastMyLoad: 1236,
        BigBoner: 1246,
        SteelRod: 1255,
    };

    for (const account of READY_SPECIALIST_ACCOUNTS) {
        const seg = resolveSpecialistSegment(account);
        const lower = account.toLowerCase();
        const expectedBoard = SPECIALIST_BOARDS[lower]!.name;

        expect(checkSpecialistSegment(seg, seg.specialist)).toBe(expectedBoard);
        expect(seg.specialist).toBe(account);
        expect(seg.start).toEqual({ fresh: true });
        expect(seg.expect.skills).toEqual({ [expectedBoard]: 99 });
        expect(seg.plan!.ticks).toBeGreaterThan(0);
        expect(seg.plan!.ticks).toBeLessThanOrEqual(expectedTargets[account]!);
        expect(resolveSpecialistTargetCap(account)).toBe(expectedTargets[account]!);
        expect(seg.timeoutMs).toBeGreaterThanOrEqual(seg.plan!.ticks * 400 + 120_000);
        expect(Number(seg.env?.CAP)).toBeGreaterThanOrEqual(seg.plan!.ticks);

        const sups = resolveSegmentSuppliers(seg);
        expect(sups.length).toBeGreaterThanOrEqual(1);
        for (const sup of sups) {
            expect(['scripts/specialist-supplier.ts', 'scripts/gathering-supplier.ts']).toContain(sup.script);
            expect(sup.args).toContain('{ACTOR}');
            expect(() => parseKitArg(sup.args ?? [])).not.toThrow();
            expect(sup.save.inventory!.length).toBeLessThanOrEqual(28);
            expect(sup.save.position).toBeDefined();
        }

        const combined = sups.flatMap(sup => [...(sup.save.inventory ?? []), ...(sup.save.bank ?? [])]);
        const totals = countSupplyMap(combined);
        if (seg.suppliers) {
            for (const [itemId, need] of Object.entries(countSupplyMap(expectedBills[account]!))) {
                expect(totals[Number(itemId)] ?? 0).toBeGreaterThanOrEqual(need);
            }
        } else {
            expect(totals).toEqual(countSupplyMap(expectedBills[account]!));
        }
    }

    const rc = resolveSpecialistSegment('PouchStuffed');
    expect(rc.suppliers).toHaveLength(1 + BODY_RUNNER_COUNT);
    expect(rc.suppliers![0]!.args).toContain('--role=starter');
    expect(rc.suppliers![0]!.save.position).toEqual({ x: 3223, z: 3222, level: 0 });
    for (let i = 1; i <= BODY_RUNNER_COUNT; i++) {
        expect(rc.suppliers![i]!.args).toContain('--role=runner');
        expect(rc.suppliers![i]!.save.position).toEqual({ x: 3050, z: 3442, level: 0 });
    }

    const prayer = resolveSpecialistSegment('BigBoner');
    expect(prayer.suppliers).toHaveLength(PRAYER_RUNNER_COUNT);
});

test('account lookup is case-insensitive and rejects unknown accounts or invalid overrides', () => {
    const lower = resolveSpecialistSegment('halfinch');
    const upper = resolveSpecialistSegment('HALFINCH');
    expect(lower).toEqual(upper);
    expect(lower.specialist).toBe('HalfInch');
    expect(lower.env?.LIVE).toBe('1');

    const ranged = resolveSpecialistSegment('shaftshooter', { planTicks: 4600 });
    expect(ranged.plan!.ticks).toBe(4600);
    expect(ranged.env?.VARIANT).toBe('live');

    expect(lower.plan!.ticks).toBe(2167);
    expect(resolveSpecialistSegment('Shaftshooter').plan!.ticks).toBe(4660);

    expect(() => resolveSpecialistSegment('Haggis')).toThrow('unknown specialist');
    expect(() => resolveSpecialistSegment('HalfInch', { planTicks: 0 })).toThrow('invalid planTicks');
    expect(() => resolveSpecialistSegment('HalfInch', { planTicks: -5 })).toThrow('invalid planTicks');
});

test('expandKitToSave and aggregateKitBank validate 28-slot limits and aggregate totals', () => {
    expect(() => expandKitToSave([{ id: 536, count: 29 }])).toThrow('exceeds 28 slots');
    expect(expandKitToSave([{ id: 53, count: 3600 }])).toEqual([{ id: 53, count: 3600 }]);
    expect(aggregateKitBank([{ id: 1631, count: 15 }, { id: 1631, count: 27 }])).toEqual([{ id: 1631, count: 42 }]);
});

test('parseCliArgs handles flags and positional account cleanly', () => {
    expect(parseCliArgs(['NockAndLoad'])).toEqual({
        account: 'NockAndLoad',
        dryRun: false,
        out: undefined,
        planTicks: undefined,
    });
    expect(parseCliArgs(['SteelRod', '--dry-run', '--out', '.practice/hosted-rehearse/custom', '--plan-ticks', '1220'])).toEqual({
        account: 'SteelRod',
        dryRun: true,
        out: '.practice/hosted-rehearse/custom',
        planTicks: 1220,
    });
    expect(parseCliArgs(['BigBoner', '--out=.practice/hosted-rehearse/bb', '--plan-ticks=1212'])).toEqual({
        account: 'BigBoner',
        dryRun: false,
        out: '.practice/hosted-rehearse/bb',
        planTicks: 1212,
    });
    expect(() => parseCliArgs([])).toThrow('usage:');
    expect(() => parseCliArgs(['HalfInch', '--bogus'])).toThrow('unknown flag');
    expect(() => parseCliArgs(['HalfInch', 'extra'])).toThrow('unexpected positional');
    expect(() => parseCliArgs(['HalfInch', '--plan-ticks', 'abc'])).toThrow('positive integer');
});

test('runHostedRehearsal supports --dry-run, invokes rehearse.ts outside outDir, and reports receipt fields', async () => {
    const dryLogs: string[] = [];
    const dry = await runHostedRehearsal(['NockAndLoad', '--dry-run'], { log: line => dryLogs.push(line) });
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dryLogs.join('\n')).specialist).toBe('NockAndLoad');

    const root = mkdtempSync(join(tmpdir(), 'hosted-rehearse-cli-'));
    try {
        await expect(runHostedRehearsal(['NockAndLoad', '--out', 'outside/dir'], { root })).rejects.toThrow('inside .practice/');

        const logs: string[] = [];
        let seenCmd: string[] = [];
        const outDir = resolve(root, '.practice/hosted-rehearse/nockandload');

        const result = await runHostedRehearsal(['NockAndLoad'], {
            root,
            log: line => logs.push(line),
            spawn: async cmd => {
                seenCmd = cmd;
                // Confirm output dir does not exist before rehearse.ts runs, while segment JSON does exist.
                expect(existsSync(outDir)).toBe(false);
                const segIdx = cmd.indexOf('--specialist');
                expect(segIdx).toBeGreaterThan(-1);
                const segPath = cmd[segIdx + 1]!;
                expect(existsSync(segPath)).toBe(true);
                const writtenSeg = JSON.parse(readFileSync(segPath, 'utf8'));
                expect(writtenSeg.specialist).toBe('NockAndLoad');

                mkdirSync(outDir, { recursive: true });
                writeFileSync(join(outDir, 'nockandload-fletching.json'), JSON.stringify({
                    ok: true,
                    segment: 'nockandload-fletching',
                    account: 'rhnoc1',
                    start: { fresh: true },
                    plan: writtenSeg.plan,
                    ticks: { used: 54, enter: 2, leave: 56, overPlan: 0 },
                    child: { code: 0, timedOut: false },
                    checks: { exit: true, saved: true, ticksMeasured: true, settledSave: true, 'skill.Fletching>=99': true, wholeClock: true },
                    end: null,
                    scope: 'One practice rehearsal',
                }));
                writeFileSync(join(outDir, 'nockandload-fletching.receipt.json'), JSON.stringify({
                    version: 2,
                    context: 'a'.repeat(64),
                    endPlaytime: 54,
                    boardTicks: { Fletching: 54 },
                    externalSupplies: [{ item: 'Headless arrow', count: 3600, itemId: 53 }],
                }));
                return 0;
            },
        });

        expect(seenCmd[0]).toBe('bun');
        expect(seenCmd[1]).toBe('packages/practice/src/rehearse.ts');
        expect(seenCmd).toContain('--start');
        expect(seenCmd).toContain('--out');
        expect(seenCmd[seenCmd.indexOf('--out') + 1]).toBe('.practice/hosted-rehearse/nockandload');
        expect(result.exitCode).toBe(0);
        expect(result.summary?.wholeClock).toBe(true);
        expect(result.summary?.boardTicks).toEqual({ Fletching: 54 });
        expect(result.summary?.externalSupplies).toEqual([{ item: 'Headless arrow', count: 3600, itemId: 53 }]);
        expect(logs.some(l => l.startsWith('HOSTED_REHEARSAL_SUMMARY '))).toBe(true);

        // Existing outDir is rejected cleanly.
        await expect(runHostedRehearsal(['NockAndLoad'], { root })).rejects.toThrow('already exists');

        // Failed rehearsal summary prints log tails and non-zero exit code.
        const failOut = resolve(root, '.practice/hosted-rehearse/steelrod-fail');
        const failLogs: string[] = [];
        const failRes = await runHostedRehearsal(['SteelRod', '--out', '.practice/hosted-rehearse/steelrod-fail'], {
            root,
            log: line => failLogs.push(line),
            spawn: async () => {
                mkdirSync(failOut, { recursive: true });
                writeFileSync(join(failOut, 'steelrod-smithing.json'), JSON.stringify({
                    ok: false,
                    checks: { exit: true, wholeClock: false },
                    ticks: { used: 1290, enter: 2, leave: 1292, overPlan: 60 },
                    scope: 'evidence error: saved specialist clocks differ from the plan by more than 2%',
                }));
                writeFileSync(join(failOut, 'steelrod-smithing.log'), 'START 3222 3222 0\nLOGOUT logged-out\nRESULT ok ticks=1290\n');
                return 1;
            },
        });
        expect(failRes.exitCode).toBe(1);
        expect(failRes.summary?.wholeClock).toBe(false);
        expect(failLogs.some(l => l.includes('steelrod-smithing.log (tail)'))).toBe(true);
        expect(collectRehearsalSummary(failOut, failRes.seg).scope).toContain('differ from the plan');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
