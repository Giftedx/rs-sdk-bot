import { expect, test } from 'bun:test';
import { startable } from '../src/swarm';

const never = () => Infinity;

test('a held non-death end runs once more after the job release changes', () => {
    for (const reason of ['refused after 1 runs', 'blocked after 2 runs', 'gave-up after 3 runs', 'stopped after 1 runs', 'exit 1']) {
        const ended = new Map([['Rod', { at: 1, reason, revision: 'sig', release: 'rel-a' }]]);
        // Same mission, same release: still held.
        expect(startable(['Rod'], true, ended, never, undefined, 'sig', () => false, () => true, 'rel-a').blocked.Rod).toBe(`ended: ${reason}`);
        // A new release of the job's entries: one more start.
        expect(startable(['Rod'], true, ended, never, undefined, 'sig', () => false, () => true, 'rel-b').start).toEqual(['Rod']);
    }
});

test('a death, an end with no release, or a stop file stays held on a new release', () => {
    const died = new Map([['Rod', { at: 1, reason: 'died after 1 runs', revision: 'sig', release: 'rel-a' }]]);
    expect(startable(['Rod'], true, died, never, undefined, 'sig', () => false, () => true, 'rel-b').start).toEqual([]);
    const old = new Map([['Rod', { at: 1, reason: 'refused after 1 runs', revision: 'sig' }]]);
    expect(startable(['Rod'], true, old, never, undefined, 'sig', () => false, () => true, 'rel-b').start).toEqual([]);
    const blocked = new Map([['Rod', { at: 1, reason: 'blocked after 2 runs', revision: 'sig', release: 'rel-a' }]]);
    expect(startable(['Rod'], true, blocked, never, undefined, 'sig', () => true, () => true, 'rel-b').blocked.Rod).toBe('paused: stop file');
    // No current release (entries unresolved): held.
    expect(startable(['Rod'], true, blocked, never, undefined, 'sig', () => false, () => true, undefined).start).toEqual([]);
});

test('a completed job that does not repeat stays ended on a new release', () => {
    const done = new Map([['Rod', { at: 1, reason: 'done after 1 runs', revision: 'sig', release: 'rel-a' }]]);
    expect(startable(['Rod'], false, done, never, undefined, 'sig', () => false, () => true, 'rel-b').start).toEqual([]);
});
