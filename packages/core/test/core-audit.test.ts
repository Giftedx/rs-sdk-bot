import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { accountForSdk, registerRouteActor } from '../src/door-policy';
import { hasCredential } from '../src/fleet-vault';
import type { Session } from '../src/inprocess';
import { beginSessionAttempt, readLogoutProof } from '../src/session-lifecycle';
import { holdSessionEater, registerSessionEater } from '../src/sustain';
import { unwrapGuarded, workerExecution } from '../src/worker-execution';
import { installDoorPolicy } from '../src/world';

test('workerExecution guard proxy preserves raw SDK identity for sustain, door-policy, and pathfinding', async () => {
    const rawSdk: any = {
        getState: () => ({
            player: { worldX: 3200, worldZ: 3200, level: 0 },
            skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10 }],
            inventory: [],
            equipment: [],
            nearbyLocs: [{ id: 100, x: 3201, z: 3200, level: 0 }],
        }),
        findPath: () => [{ x: 3201, z: 3200 }],
    };
    const client: any = { ingame: true };
    const exec = workerExecution(() => {});
    const session = {
        name: 'ProxyBot',
        sdk: rawSdk,
        bot: {},
        tick: () => 1,
        onTick: () => () => {},
        direct: async () => ({ success: true }),
        ended: new Promise(() => {}),
        close: async () => {},
        client,
    } as unknown as Session;

    let released = false;
    registerSessionEater(session.sdk, () => ({ ateAt: 42, release: () => { released = true; } }));
    registerRouteActor(session.sdk, client);

    exec.bind(session);
    expect(session.sdk).not.toBe(rawSdk);
    expect(unwrapGuarded(session.sdk)).toBe(rawSdk);
    expect(unwrapGuarded(exec.bind(session).sdk)).toBe(rawSdk);

    const held = holdSessionEater(session.sdk);
    expect(held.ateAt).toBe(42);
    held.release();
    expect(released).toBe(true);

    expect(accountForSdk(session.sdk).visibleLocs).toEqual([{ id: 100, x: 3201, z: 3200, level: 0 }]);

    await installDoorPolicy(session.sdk, client);
    const wrappedOnce = rawSdk.findPath;
    await installDoorPolicy(rawSdk, client);
    expect(rawSdk.findPath).toBe(wrappedOnce);
});

test('beginSessionAttempt.record rolls back in-memory ended state when receipt write fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-rollback-'));
    const attemptFileDir = join(root, 'practice', 'localhost_8888', 'ana', 'attempts');
    const parked = `${attemptFileDir}.parked`;
    try {
        let clock = 1_700_000_000_000;
        const attempt = beginSessionAttempt({ account: 'Ana', server: 'localhost:8888' }, { root, now: () => clock });
        const attemptFile = join(attemptFileDir, `${attempt.attemptId}.json`);
        renameSync(attemptFileDir, parked);
        try {
            clock += 1000;
            expect(attempt.record('ended', 'logged-out')).toBe(false);
        } finally {
            renameSync(parked, attemptFileDir);
        }
        clock += 1000;
        expect(attempt.record('ended', 'logged-out')).toBe(true);
        const proof = readLogoutProof('Ana', 'localhost:8888', { root });
        expect(proof.state).toBe('confirmed');
        if (proof.state === 'confirmed') {
            expect(proof.attemptId).toBe(attempt.attemptId);
            expect(proof.loggedOutAt).toBe(1_700_000_002_000);
        }
        expect(existsSync(attemptFile)).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('hasCredential rejects invalid account names and unreadable vault entries without throwing', () => {
    const base = mkdtempSync(join(tmpdir(), 'vault-hardening-'));
    const botsDir = join(base, 'bots');
    const dir = join(base, 'vault');
    try {
        mkdirSync(join(botsDir, 'bad name'), { recursive: true });
        writeFileSync(join(botsDir, 'bad name', 'bot.env'), 'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=secret\n');
        expect(hasCredential('bad name', { botsDir, dir, key: null })).toBe(false);
        expect(hasCredential('../escape', { botsDir, dir, key: null })).toBe(false);

        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'corrupt.json'), '{not valid json');
        expect(hasCredential('Corrupt', { botsDir, dir, key: Buffer.alloc(32, 1) })).toBe(false);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('planTripOffThread rejects pending work on unexpected close and re-sends SharedLabels if postMessage fails', async () => {
    const probe = `
        import assert from 'node:assert/strict';
        import { labelAreas, shareLabels, attachSharedLabels } from './packages/core/src/components';
        const labels = labelAreas([[0, 0, 0]], () => true, () => true);
        const shared = shareLabels(labels);
        assert.ok(shared);
        attachSharedLabels(shared);
        const workers = [];
        let failFirstPost = true;
        globalThis.Worker = class {
            constructor() { workers.push(this); this.requests = []; this.listeners = new Map(); }
            ref() {} unref() {} terminate() {}
            addEventListener(type, fn) {
                const list = this.listeners.get(type) ?? [];
                list.push(fn);
                this.listeners.set(type, list);
            }
            emit(type, ev) {
                for (const fn of this.listeners.get(type) ?? []) fn(ev);
            }
            postMessage(req) {
                if (failFirstPost) { failFirstPost = false; throw Error('transient post failure'); }
                this.requests.push(req);
            }
        };
        const { planTripOffThread } = await import('./packages/core/src/route-plan');
        const tile = { x: 1, z: 1, level: 0 }, acct = { skills: {}, varps: {}, items: [] };
        await assert.rejects(planTripOffThread(tile, tile, acct), /transient post failure/);
        const p2 = planTripOffThread(tile, tile, acct);
        assert.ok(workers[1].requests[0].sharedAreas);
        workers[1].emit('close');
        await assert.rejects(p2, /route worker closed unexpectedly/);
    `;
    const child = Bun.spawn([process.execPath, '-e', probe], {
        cwd: resolve(import.meta.dir, '../../..'),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    const deadline = setTimeout(() => child.kill(), 5000);
    try {
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    } finally {
        clearTimeout(deadline);
    }
});
