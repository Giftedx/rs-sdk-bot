import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { bindHostedScope, finish as botFinish, finishHooks } from '../src/bot';
import { startLedger } from '../src/ledger';
import { watchRandomEvents } from '../src/randomevents';
import { checkoutRev, clearCheckoutRevMemo, readCheckoutRevDirect } from '../src/route-service-client';
import { beginSessionAttempt } from '../src/session-lifecycle';
import { savedProcessAliveAsync } from '../src/session-takeover';
import { startStatus } from '../src/status';
import { assertLiveWorkerReleaseAsync, LOST_SESSION_DROP_MS } from '../src/worker-release';

test('readCheckoutRevDirect resolves regular repo, worktree pointer, and packed-refs without spawning git', () => {
    const base = mkdtempSync(join(tmpdir(), 'rev-direct-'));
    try {
        const sha1 = 'a'.repeat(40);
        mkdirSync(join(base, 'regular', '.git', 'refs', 'heads'), { recursive: true });
        writeFileSync(join(base, 'regular', '.git', 'HEAD'), 'ref: refs/heads/master\n');
        writeFileSync(join(base, 'regular', '.git', 'refs', 'heads', 'master'), sha1 + '\n');
        expect(readCheckoutRevDirect(join(base, 'regular'))).toBe(sha1);

        const sha2 = 'b'.repeat(40);
        mkdirSync(join(base, 'common', 'worktrees', 'wt1'), { recursive: true });
        mkdirSync(join(base, 'wt1'), { recursive: true });
        writeFileSync(join(base, 'common', 'packed-refs'), `# pack-refs\n${sha2} refs/heads/feature\n`);
        writeFileSync(join(base, 'common', 'worktrees', 'wt1', 'commondir'), '../..\n');
        writeFileSync(join(base, 'common', 'worktrees', 'wt1', 'HEAD'), 'ref: refs/heads/feature\n');
        writeFileSync(join(base, 'wt1', '.git'), `gitdir: ${join(base, 'common', 'worktrees', 'wt1')}\n`);
        expect(readCheckoutRevDirect(join(base, 'wt1'))).toBe(sha2);

        clearCheckoutRevMemo();
        expect(checkoutRev(join(base, 'wt1'))).toBe(sha2);
        expect(readCheckoutRevDirect(resolve(import.meta.dir, '../../..'))).toMatch(/^[0-9a-f]{40}$/);
    } finally {
        clearCheckoutRevMemo();
        rmSync(base, { recursive: true, force: true });
    }
});

test('savedProcessAliveAsync and assertLiveWorkerReleaseAsync operate without sync process queries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peers-async-'));
    const server = 'rs-sdk-demo.fly.dev';
    const now = 1_750_000_000_000;
    try {
        const statusDir = join(root, '.practice', 'live', 'status');
        const lifeDir = join(root, '.practice', 'live', 'session-lifecycle');
        mkdirSync(statusDir, { recursive: true });
        mkdirSync(lifeDir, { recursive: true });

        const a1 = beginSessionAttempt(
            { account: 'StaleA', server },
            { root: lifeDir, now: () => now - LOST_SESSION_DROP_MS - 60_000, owner: { pid: 41001, coordinatorRunId: null, workerRelease: null, script: 'scripts/goldfarm.ts', role: null, participants: null } },
        );
        writeFileSync(join(statusDir, 'StaleA.json'), JSON.stringify({
            name: 'StaleA', server, at: now - LOST_SESSION_DROP_MS - 10_000, sessionAttemptId: a1.attemptId, workRevision: '0'.repeat(64),
        }));

        let batchCalls = 0;
        let fetchedPids: number[] = [];
        expect(await savedProcessAliveAsync(41001, now - 60_000, async pids => {
            batchCalls++;
            fetchedPids = [...pids];
            return new Map([[41001, now - 10_000]]);
        }, () => true)).toBe(false);
        expect(batchCalls).toBe(1);
        expect(fetchedPids).toEqual([41001]);

        expect(await savedProcessAliveAsync(41002, now - 10_000, async () => new Map([[41002, now - 60_000]]), () => true)).toBe(true);
        expect(await savedProcessAliveAsync(41003, now - 10_000, async () => { throw Error('should not query dead pid'); }, () => false)).toBe(false);

        await expect(assertLiveWorkerReleaseAsync('localhost:8888', {}, root)).resolves.toBeUndefined();
        await expect(assertLiveWorkerReleaseAsync(server, { STANDING: '1' }, root)).resolves.toBeUndefined();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('finish with finishHooks routes LOGOUT and RESULT through hosted scope log instead of unprefixed console', async () => {
    const botName = `HookLog${process.pid}`;
    const routed: string[] = [];
    let endResolve!: (v: { reason: string }) => void;
    const ended = new Promise<{ reason: string }>(r => { endResolve = r; });
    const session: any = {
        name: botName,
        ended,
        tick: () => 1,
        onTick: () => () => {},
        sdk: { getState: () => ({ tick: 1, player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1 }, skills: [], dialog: { isOpen: false } }) },
        direct: async () => ({ success: true }),
        close: async () => {},
    };
    const ctxLog = (_level: 'log' | 'warn' | 'error', args: unknown[]) => { routed.push(args.map(String).join(' ')); };
    bindHostedScope(ctxLog, {
        name: botName,
        log: l => routed.push(l),
        finish: async () => new Promise<never>(() => {}),
        openBot: async () => session,
        exit: () => { throw Error('unexpected exit'); },
    });

    const hooked: boolean[] = [];
    finishHooks.set(botName.toLowerCase(), ok => { hooked.push(ok); });
    try {
        const ac = new AbortController();
        executionContext.run({ signal: ac.signal, log: ctxLog }, () => {
            void botFinish([session], true, 'quest done', {
                logout: async () => { endResolve({ reason: 'logged-out' }); return 'logged-out'; },
            });
        });
        await new Promise(r => setTimeout(r, 50));
        expect(hooked).toEqual([true]);
        expect(routed.some(l => l === 'LOGOUT logged-out')).toBe(true);
        expect(routed.some(l => l === 'RESULT ok quest done')).toBe(true);
    } finally {
        finishHooks.delete(botName.toLowerCase());
    }
});

test('watchRandomEvents records lastAction on passes(a) during exclusive work', async () => {
    const state: any = {
        inventory: [{ slot: 0, id: 385, optionsWithIndex: [{ opIndex: 1, text: 'Eat' }] }],
        player: { worldX: 3200, worldZ: 3200, level: 0 },
        gameMessages: [],
        skills: [],
    };
    const session: any = {
        tick: () => 10,
        onTick: () => () => {},
        direct: async () => ({ success: true }),
        sdk: { getState: () => state, send: () => {} },
    };
    const watch = watchRandomEvents(session, { events: false, gate: true, danger: null, log: () => {} });
    try {
        await watch.exclusive(async () => {
            await session.direct({ type: 'useInventoryItem', slot: 0, optionIndex: 1 });
            expect(watch.lastAction()).toBe('useInventoryItem');
            session.sdk.send({ type: 'sdk_action', actionId: '1', action: { type: 'walkTo', x: 3205, z: 3205 } });
            expect(watch.lastAction()).toBe('walkTo');
        });
    } finally {
        watch.stop();
    }
});

test('startStatus writes live tickStats snapshot alongside ledger counts', () => {
    const name = `TickStats${process.pid}`;
    const file = resolve(import.meta.dir, '../../../.practice/sim/status', `${name}.json`);
    const cbs: (() => void)[] = [];
    let tick = 0;
    const state: any = { tick: 0, player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1 }, inventory: [], skills: [], dialog: { isOpen: false } };
    const sess: any = { name, sdk: { getState: () => state }, tick: () => tick, onTick: (cb: () => void) => { cbs.push(cb); return () => {}; } };
    const led = startLedger(sess, () => 'walkTo', 50, { script: 'aio-logistics:walk-to' });
    const status = startStatus(sess, 'localhost:8888', led.counts, () => led.rows.map(r => r.kind[0]).join(''), { tickStats: () => led.snapshot() });
    try {
        for (let i = 0; i < 5; i++) {
            tick++; state.tick = tick;
            for (const cb of cbs) cb();
        }
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        expect(doc.tickStats).toMatchObject({
            ticks: 5,
            standStill: 5,
            standStillPct: 100,
            currentStandStill: 5,
            currentStandStillWhy: 'after:walkTo',
            script: 'aio-logistics:walk-to',
        });
    } finally {
        status.stop();
        led.stop();
        rmSync(file, { force: true });
    }
});
