import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSetB64 } from '../hosted-bench';
import { encodeHostedArgs, formatByCaseTable, formatSweepSummary, formatSweepTable, parseCandidateSpec, parseCandidatesFile, rankSweepRows, summarizeCandidateByCase, summarizeCandidateDir, type SweepRow } from './pk-squad-sweep';

test('parseCandidateSpec and parseCandidatesFile handle bare, JSON, and KEY=VALUE specs', () => {
    expect(parseCandidateSpec('baseline')).toEqual({ name: 'baseline', env: {} });
    expect(parseCandidateSpec('combo:{"SQUAD_OPTS":{"comboFood":true,"eatAt":65},"SPEAR_LOCK":1}')).toEqual({
        name: 'combo',
        env: { SQUAD_OPTS: '{"comboFood":true,"eatAt":65}', SPEAR_LOCK: '1' },
    });
    expect(parseCandidateSpec('entangle:SPEAR_LOCK=1 SQUAD_OPTS={"freeze":true,"freezeMagicCap":99}')).toEqual({
        name: 'entangle',
        env: { SPEAR_LOCK: '1', SQUAD_OPTS: '{"freeze":true,"freezeMagicCap":99}' },
    });
    expect(parseCandidatesFile(JSON.stringify([{ name: 'a', env: { SQUAD_THREAT: 1, SQUAD_OPTS: { cureNow: true } } }]))).toEqual([
        { name: 'a', env: { SQUAD_THREAT: '1', SQUAD_OPTS: '{"cureNow":true}' } },
    ]);
    expect(() => parseCandidateSpec(':SQUAD_THREAT=1')).toThrow();
    expect(() => parseCandidateSpec('bad:lower=1')).toThrow();
});

test('encodeHostedArgs emits --set for plain values and --set-b64 for JSON payloads', () => {
    const encoded = encodeHostedArgs({ SPEAR_LOCK: '1', SQUAD_OPTS: '{"eatAt":65,"comboFood":true}' }, ['--profile']);
    expect(encoded).toContain('--profile');
    expect(encoded).toContain('--set SPEAR_LOCK=1');
    const m = /--set-b64 (SQUAD_OPTS=\S+)/.exec(encoded);
    expect(m).not.toBeNull();
    expect(decodeSetB64(m![1]!)).toEqual({ key: 'SQUAD_OPTS', value: '{"eatAt":65,"comboFood":true}' });
});

test('rankSweepRows enforces 0-death hard invariant then ranks by kills, kills/hr, HP/kill, and MinHP', () => {
    const mk = (candidate: string, runId: string, o: Partial<SweepRow['row']>): SweepRow => ({
        candidate,
        runId,
        row: {
            batch: candidate, condition: 'c', runs: [], kills: 12, gang: 12, deaths: 0,
            hpAKill: 30, ticksARun: 250, killsAnHour: 20, accountTicksAKill: 300, coinsAKill: 450,
            avgKillTicks: 40, ticksPerKill: 40, minHp: 55, sharksEaten: 10, karamEaten: 2,
            freezesCast: 8, freezesLanded: 6, freezePct: 75, suppliesPerKill: 1, escapes: 0, hasMetrics: true,
            ...o,
        },
    });
    const table = formatSweepTable([
        mk('deadly-fast', '101', { deaths: 1, kills: 12, killsAnHour: 25, hpAKill: 20 }),
        mk('safe-slow', '102', { deaths: 0, kills: 12, killsAnHour: 18, hpAKill: 28 }),
        mk('safe-fast-lower-hp', '103', { deaths: 0, kills: 12, killsAnHour: 21, hpAKill: 22, minHp: 64 }),
        mk('safe-fast-higher-hp', '104', { deaths: 0, kills: 12, killsAnHour: 21, hpAKill: 35, minHp: 41 }),
    ]);
    const ranked = rankSweepRows([
        mk('deadly-fast', '101', { deaths: 1, kills: 12, killsAnHour: 25, hpAKill: 20 }),
        mk('safe-slow', '102', { deaths: 0, kills: 12, killsAnHour: 18, hpAKill: 28 }),
        mk('safe-fast-lower-hp', '103', { deaths: 0, kills: 12, killsAnHour: 21, hpAKill: 22, minHp: 64 }),
        mk('safe-fast-higher-hp', '104', { deaths: 0, kills: 12, killsAnHour: 21, hpAKill: 35, minHp: 41 }),
    ]);
    expect(ranked.map(r => r.candidate)).toEqual(['safe-fast-lower-hp', 'safe-fast-higher-hp', 'safe-slow', 'deadly-fast']);
    expect(table).toContain('| Rank | Candidate | Kills | Deaths | HP/kill | Ticks/kill | Kills/hr | Freeze% | MinHP | Supplies/kill | Run |');
    expect(table).toContain('| 1 | `safe-fast-lower-hp` | 12 of 12 | 0 | 22 | 40 | 21 | 75% | 64 | 1 | 103 |');
});

test('summarizeCandidateDir reads hosted-bench artifact folders with SQUAD_METRICS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squad-sweep-'));
    try {
        const sub = join(dir, 'bench-p1-s1-deadbeef');
        mkdirSync(join(sub, 'aio-bench', 'output'), { recursive: true });
        mkdirSync(join(sub, 'bench-cases'), { recursive: true });
        writeFileSync(join(sub, 'bench-cases', 'bench.log'), 'AIO_BENCH start cases=1 runs=1 lockstep seed=1\nextra:clone-squad-4-chainbind-x1    pass    220\n');
        const metrics = { accounts: 4, kills: 3, deaths: 0, taken: 60, trips: 4, avgKillTicks: 38, minHp: 57, sharksEaten: 3, karamEaten: 0, freezesCast: 4, freezesLanded: 3, escapes: 0 };
        writeFileSync(join(sub, 'aio-bench', 'output', 'extra_clone-squad-4-chainbind-x1.log'),
            `SQUAD_METRICS ${JSON.stringify(metrics)}\nRESULT ok squad accounts=4 kills=3 gangDied=3 died=0 taken=60 trips=4 picked={}\n`);
        const r = summarizeCandidateDir('test-cand', dir);
        expect(r).toMatchObject({
            kills: 3,
            deaths: 0,
            hpAKill: 20,
            ticksARun: 220,
            avgKillTicks: 38,
            minHp: 57,
            freezePct: 75,
            suppliesPerKill: 1,
        });
        const byCase = summarizeCandidateByCase('test-cand', '999', dir);
        expect(byCase).toHaveLength(1);
        expect(formatByCaseTable(byCase)).toContain('| `extra:clone-squad-4-chainbind-x1` | 1 | `test-cand` |');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('formatSweepSummary renders winner delta vs baseline and per-arm timings', () => {
    const mk = (candidate: string, runId: string, o: Partial<SweepRow['row']>, elapsedMs?: number): SweepRow => ({
        candidate,
        runId,
        elapsedMs,
        ok: true,
        row: {
            batch: candidate, condition: 'c', runs: [], kills: 12, gang: 12, deaths: 0,
            hpAKill: 30, ticksARun: 250, killsAnHour: 20, accountTicksAKill: 300, coinsAKill: 450,
            avgKillTicks: 40, ticksPerKill: 40, minHp: 55, sharksEaten: 10, karamEaten: 2,
            freezesCast: 8, freezesLanded: 6, freezePct: 75, suppliesPerKill: 1, escapes: 0, hasMetrics: true,
            ...o,
        },
    });
    const text = formatSweepSummary([
        mk('baseline', '100', { kills: 10, hpAKill: 35, killsAnHour: 16.5, ticksPerKill: 50, minHp: 48 }, 42_000),
        mk('combo', '101', { kills: 12, hpAKill: 25, killsAnHour: 21.0, ticksPerKill: 38, minHp: 61 }, 39_500),
    ], 42_500);
    expect(text).toContain('winner: combo');
    expect(text).toContain('delta vs baseline: kills +2, deaths 0, hp/kill -10, kills/hr +4.5, ticks/kill -12, minHp +13');
    expect(text).toContain('timings: combo=39.5s (ok), baseline=42.0s (ok) | sweep 42.5s');
});
