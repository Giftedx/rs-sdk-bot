import { test, expect } from 'bun:test';
import { endedForGood, parseJob, startable } from './swarm';

test('parseJob keeps single-account jobs as before and reads host jobs', () => {
    const one = parseJob({ account: 'Mightyrod', script: 's.ts', enabled: true });
    expect(one).toEqual({ key: 'Mightyrod', accounts: ['Mightyrod'], host: false, job: expect.anything() });
    const h = parseJob({ accounts: ['Pocketpython', 'Pocketrocket'], script: 'scripts/goldfarm.ts', host: true, enabled: true });
    expect(h).toEqual({ key: 'host:Pocketpython+Pocketrocket', accounts: ['Pocketpython', 'Pocketrocket'], host: true, job: expect.anything() });
});

test('parseJob refuses malformed host jobs', () => {
    expect(parseJob({ accounts: [], script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/non-empty/) });
    expect(parseJob({ accounts: ['a', 'A'], script: 's', host: true, enabled: true })).toEqual({ error: 'account listed twice' });
    expect(parseJob({ accounts: ['a'], account: 'b', script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/both/) });
    expect(parseJob({ accounts: ['a'], script: 's', enabled: true })).toEqual({ error: expect.stringMatching(/host/) });
    expect(parseJob({ accounts: ['bad/name'], script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/bad account/) });
    expect(parseJob({ script: 's', enabled: true })).toEqual({ error: 'no account' });
});

test('a death ends an account for good, even with repeat; other ends restart only with repeat', () => {
    expect(endedForGood({ reason: 'died' }, true)).toBe(true);
    expect(endedForGood({ reason: 'died after 1 runs' }, true)).toBe(true);
    expect(endedForGood({ reason: 'done' }, true)).toBe(false);
    expect(endedForGood({ reason: 'done' }, false)).toBe(true);
    expect(endedForGood(undefined, false)).toBe(false);
});

test('startable leaves out dead and external accounts of a host job, per account', () => {
    const ended = new Map([['dead', { reason: 'died' }], ['fine', { reason: 'gave-up' }]]);
    const age = (a: string) => (a === 'ext' ? 5_000 : Infinity);
    const r = startable(['dead', 'fine', 'ext', 'new'], true, ended, age);
    expect(r.start).toEqual(['fine', 'new']);
    expect(r.blocked).toEqual({ dead: 'ended: died', ext: 'external (status fresh, not started by swarm)' });
});
