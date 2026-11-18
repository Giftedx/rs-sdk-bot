import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pvpDeathLimits, pvpDeathRefusal, PVP_DEATH_WINDOW_MS, readPvpDeaths, recordPvpDeath } from '../src/pvp-deaths';

const LIVE = 'rs-sdk-demo.fly.dev', NOW = 1_800_000_000_000, HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ledger = () => { const d = mkdtempSync(join(tmpdir(), 'pvp-deaths-')); dirs.push(d); return join(d, 'sub', 'pvp-deaths.json'); };
const died = (file: string, account: string, ago: number, server = LIVE) => recordPvpDeath({ account, server, at: NOW - ago, script: 'scripts/pk-squad.ts', near: { x: 3066, z: 3641 } }, file);
const SQUAD = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const refusal = (file: string, o: { accounts?: string[]; server?: string } = {}) => pvpDeathRefusal({ accounts: o.accounts ?? SQUAD, server: o.server ?? LIVE, now: NOW, file, limits: { perAccount: 2, squad: 3 } });

test('a missing ledger refuses nothing, and a death is recorded in the file', () => {
    const file = ledger();
    expect(readPvpDeaths(file)).toEqual([]);
    expect(refusal(file)).toBeNull();
    expect(died(file, 'Alpha', HOUR)).toBe(true);
    expect(readPvpDeaths(file)).toEqual([{ schema: 'pvp-death/1', account: 'Alpha', server: LIVE, at: NOW - HOUR, script: 'scripts/pk-squad.ts', near: { x: 3066, z: 3641 } }]);
    expect(refusal(file)).toBeNull();
});

test('an account with its limit of deaths in 24 hours stops the run, and so does a squad with its limit', () => {
    const file = ledger();
    died(file, 'Alpha', 3 * HOUR);
    died(file, 'alpha', 2 * HOUR);
    expect(refusal(file)).toBe('death ledger: Alpha died 2 times in 24 h (limit 2)');
    // A run of other accounts is not refused by it.
    expect(refusal(file, { accounts: ['Bravo', 'Charlie'] })).toBeNull();
    const squad = ledger();
    died(squad, 'Alpha', HOUR); died(squad, 'Bravo', HOUR); died(squad, 'Charlie', HOUR);
    expect(refusal(squad)).toBe('death ledger: the squad died 3 times in 24 h (limit 3)');
    // Deaths of accounts that are not in the run do not count for its squad.
    expect(refusal(squad, { accounts: ['Alpha', 'Bravo'] })).toBeNull();
});

test('a death older than 24 hours, a death of another server and a death in the future do not count', () => {
    const file = ledger();
    died(file, 'Alpha', PVP_DEATH_WINDOW_MS + 1); died(file, 'Alpha', PVP_DEATH_WINDOW_MS + HOUR);
    died(file, 'Alpha', HOUR, 'other.example.org'); died(file, 'Alpha', -HOUR);
    expect(refusal(file)).toBeNull();
    died(file, 'Alpha', PVP_DEATH_WINDOW_MS - 1); died(file, 'Alpha', HOUR);
    expect(refusal(file)).toBe('death ledger: Alpha died 2 times in 24 h (limit 2)');
});

test('a local server records nothing and is never refused', () => {
    const file = ledger();
    for (const server of ['localhost:8888', '127.0.0.1:21000']) expect(died(file, 'Alpha', HOUR, server)).toBe(false);
    expect(readPvpDeaths(file)).toEqual([]);
    const live = ledger();
    died(live, 'Alpha', HOUR); died(live, 'Alpha', 2 * HOUR);
    expect(pvpDeathRefusal({ accounts: SQUAD, server: 'localhost:8888', now: NOW, file: live })).toBeNull();
});

test('a ledger that cannot be read stops the run, and a limit of 0 refuses after the first death', () => {
    const file = ledger();
    died(file, 'Alpha', HOUR);
    writeFileSync(file, '{');
    expect(refusal(file)).toMatch(/^death ledger unreadable: /);
    writeFileSync(file, JSON.stringify([{ nope: true }]));
    expect(refusal(file)).toMatch(/^death ledger unreadable: Error: invalid pvp death ledger/);
    const one = ledger();
    expect(pvpDeathRefusal({ accounts: SQUAD, server: LIVE, now: NOW, file: one, limits: { perAccount: 0, squad: 0 } })).toBeNull();
    died(one, 'Bravo', HOUR);
    expect(pvpDeathRefusal({ accounts: SQUAD, server: LIVE, now: NOW, file: one, limits: { perAccount: 0, squad: 0 } })).toBe('death ledger: Bravo died 1 times in 24 h (limit 0)');
    expect(JSON.parse(readFileSync(one, 'utf8'))).toHaveLength(1);
});

test('the limits come from the environment as whole numbers and fall back to 2 and 3', () => {
    expect(pvpDeathLimits({})).toEqual({ perAccount: 2, squad: 3 });
    expect(pvpDeathLimits({ PVP_MAX_DEATHS_PER_ACCOUNT: '1', PVP_MAX_DEATHS_SQUAD: '5' })).toEqual({ perAccount: 1, squad: 5 });
    expect(pvpDeathLimits({ PVP_MAX_DEATHS_PER_ACCOUNT: 'x', PVP_MAX_DEATHS_SQUAD: '-1' })).toEqual({ perAccount: 2, squad: 3 });
    expect(pvpDeathLimits({ PVP_MAX_DEATHS_PER_ACCOUNT: '', PVP_MAX_DEATHS_SQUAD: '2.5' })).toEqual({ perAccount: 2, squad: 3 });
});
