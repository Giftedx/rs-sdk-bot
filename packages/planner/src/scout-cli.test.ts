import { expect, test } from 'bun:test';
import { keptProfiles, parseScoutArgs, snapshotIsFresh } from './scout-cli';

const BASE = 'https://rs-sdk-demo.fly.dev';
const NOW = 1_800_000_000_000, MIN = 60_000;
const snap = (ageMs: number, profiles?: { name: string; status: number; at: number }[]) => ({
    base: BASE, takenAt: new Date(NOW - ageMs).toISOString(), tickMs: 400, boards: [{ board: 'Overall', category: 0, rows: [] }],
    ...(profiles ? { profiles } : {}),
});

test('parseScoutArgs reads --max-age-ms and refuses a bad value', () => {
    expect(parseScoutArgs(['--out=x.json', '--max-age-ms=3000000'])).toEqual({ base: BASE, output: 'x.json', freshAccounts: [], maxAgeMs: 3_000_000 });
    expect(parseScoutArgs(['--fresh-account=RockSolid'])).toEqual({ base: BASE, freshAccounts: ['rocksolid'] });
    expect(() => parseScoutArgs(['--max-age-ms=0'])).toThrow('invalid --max-age-ms');
    expect(() => parseScoutArgs(['--max-age-ms=soon'])).toThrow('invalid --max-age-ms');
});

test('snapshotIsFresh keeps a young snapshot of the same base and refreshes an old one', () => {
    expect(snapshotIsFresh(snap(10 * MIN), BASE, [], 50 * MIN, NOW)).toBe(true);
    // The 31 h old snapshot that held three launch-qualified campaigns in staging.
    expect(snapshotIsFresh(snap(31 * 60 * MIN), BASE, [], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh(snap(10 * MIN), 'http://localhost:8888', [], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh({ ...snap(10 * MIN), boards: [] }, BASE, [], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh({ ...snap(10 * MIN), takenAt: 'bad' }, BASE, [], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh(null, BASE, [], 50 * MIN, NOW)).toBe(false);
});

test('snapshotIsFresh refreshes when a --fresh-account has no young profile observation', () => {
    expect(snapshotIsFresh(snap(10 * MIN), BASE, ['rocksolid'], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh(snap(10 * MIN, [{ name: 'rocksolid', status: 404, at: NOW - 90 * MIN }]), BASE, ['rocksolid'], 50 * MIN, NOW)).toBe(false);
    expect(snapshotIsFresh(snap(10 * MIN, [{ name: 'rocksolid', status: 404, at: NOW - 5 * MIN }]), BASE, ['rocksolid'], 50 * MIN, NOW)).toBe(true);
});

test('keptProfiles keeps the earlier observations that this run does not replace, for the same base only', () => {
    const old = snap(30 * MIN, [{ name: 'rocksolid', status: 404, at: NOW - 30 * MIN }, { name: 'bigswinger', status: 404, at: NOW - 40 * MIN }]);
    const fresh = { name: 'bigswinger', status: 404, at: NOW };
    const profiles = old.profiles!;
    expect(keptProfiles(old, BASE, [])).toEqual(profiles);
    expect(keptProfiles(old, BASE, [fresh])).toEqual([profiles[0], fresh]);
    expect(keptProfiles(old, 'http://localhost:8888', [fresh])).toEqual([fresh]);
    expect(keptProfiles(null, BASE, [])).toEqual([]);
});
