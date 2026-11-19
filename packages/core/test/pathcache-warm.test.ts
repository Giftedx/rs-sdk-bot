import { expect, test } from 'bun:test';
import { pathfindingDataKey, pathfindingSourceKey, shouldWarmSnapshot, warmSnapshotGrid } from '../src/pathcache';

test('only win32 warms the snapshot: the warm searches run there and nowhere else', () => {
    const calls: number[][] = [];
    const sdk = { findLongPath: (...a: number[]) => { calls.push(a); return []; } };
    expect(shouldWarmSnapshot('win32')).toBe(true);
    for (const platform of ['linux', 'darwin', 'freebsd']) expect(shouldWarmSnapshot(platform)).toBe(false);
    expect(warmSnapshotGrid(sdk, 'linux')).toBe(0);
    expect(calls).toHaveLength(0);
    expect(warmSnapshotGrid(sdk, 'win32')).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.length === 5)).toBe(true);
});

test('the source key differs between a warmed and a plain snapshot, so a snapshot of the other kind is rebuilt', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const keyOn = (platform: string) => {
        Object.defineProperty(process, 'platform', { ...real, value: platform });
        try { return pathfindingSourceKey(); } finally { Object.defineProperty(process, 'platform', real); }
    };
    const win = keyOn('win32'), linux = keyOn('linux');
    expect(win).not.toBe(linux);
    expect(JSON.parse(win).v).toBe(5);
    expect(JSON.parse(linux).v).toBe(4);
    expect(keyOn('darwin')).toBe(linux);
});

test('the key of the leg cache and the area labels is the data key: the same on every platform', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const dataOn = (platform: string) => {
        Object.defineProperty(process, 'platform', { ...real, value: platform });
        try { return pathfindingDataKey(); } finally { Object.defineProperty(process, 'platform', real); }
    };
    expect(dataOn('win32')).toBe(dataOn('linux'));
    expect(JSON.parse(dataOn('win32')).v).toBe(4);
    // On a platform that does not warm, the data key is the snapshot key.
    const sourceOnLinux = (() => { Object.defineProperty(process, 'platform', { ...real, value: 'linux' }); try { return pathfindingSourceKey(); } finally { Object.defineProperty(process, 'platform', real); } })();
    expect(dataOn('linux')).toBe(sourceOnLinux);
});
