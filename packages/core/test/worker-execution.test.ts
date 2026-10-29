import { expect, test } from 'bun:test';
import { workerExecution } from '../src/worker-execution';
import { waitTicks, waitUntil } from '../src/ticks';
import { walkPath, walkRoute } from '../src/walk';
import { fakeSession, at } from './fake';
import { executionContext, executionWait } from '../../../vendor/rs-sdk/sdk/execution-context';
import type { Session } from '../src/inprocess';

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('host work cancellation rejects pending local tick waits as well as SDK waits', async () => {
    const scope = workerExecution(() => {}), s = fakeSession([at(0, 0)]);
    let tickResult = '', untilResult = '';
    const tick = scope.run(() => waitTicks(s, 100)).then(() => { tickResult = 'completed'; }, () => { tickResult = 'cancelled'; });
    const until = scope.run(() => waitUntil(s, () => false, { timeoutTicks: 100 })).then(() => { untilResult = 'completed'; }, () => { untilResult = 'cancelled'; });
    scope.stop(new Error('worker ended'));
    await flush();
    expect(tickResult).toBe('cancelled');
    expect(untilResult).toBe('cancelled');
    await Promise.all([tick, until]);
});

test('cancelled work cannot dispatch again while cleanup and another worker can', async () => {
    const first = workerExecution(() => {}), second = workerExecution(() => {});
    let sends = 0;
    const session = first.bind({ sdk: { getState: () => ({}) }, bot: { work: async () => { sends++; } }, direct: async () => { sends++; }, onTick: () => () => {} } as unknown as Session);
    first.stop('done');
    let returned = false;
    void first.run(() => (session.bot as any).work()).then(() => { returned = true; });
    await flush();
    expect(sends).toBe(0);
    expect(returned).toBe(false);
    await first.cleanup(() => (session.bot as any).work());
    expect(sends).toBe(1);
    const other = second.bind({ sdk: {}, bot: { work: async () => { sends++; } }, direct: async () => {}, onTick: () => () => {} } as unknown as Session);
    await second.run(() => (other.bot as any).work());
    expect(sends).toBe(2);
});

test('a route leg keeps its owner cancellation and log context', async () => {
    const owner = new AbortController(), s = fakeSession([at(0, 0)]);
    let cancelled = false, settled = false, inheritedLog: unknown;
    const log = () => {};
    const walker = { ...s, bot: { interactLoc: async () => ({}), walkTo: async () => {
        inheritedLog = executionContext.getStore()?.log;
        return executionWait(() => () => { cancelled = true; });
    } } };
    const pending = executionContext.run({ signal: owner.signal, log }, () => walkRoute(walker, [{ kind: 'walk', to: { x: 10, z: 0, level: 0 } }]));
    void pending.then(() => { settled = true; });
    await flush();
    owner.abort('owner stopped');
    await flush();
    expect(settled).toBe(true);
    expect(cancelled).toBe(true);
    expect(inheritedLog).toBe(log);
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
});

test('abort during transport retry backoff cannot open a door or send another walk', async () => {
    const state = { ...at(0, 0), nearbyLocs: [
        { x: 0, z: 0, level: 0, name: 'Staircase' },
        { x: 1, z: 0, level: 0, name: 'Door', options: ['Open'] },
    ] };
    const s = fakeSession([state as any]), abort = new AbortController();
    let recoveryInputs = 0;
    const walker = { ...s, bot: {
        interactLoc: async () => ({ success: false, message: "Can't reach" }),
        openDoor: async () => { recoveryInputs++; },
        walkTo: async () => { recoveryInputs++; },
    } };
    const pending = walkRoute(walker, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 0, z: 0, level: 0 }, to: { x: 0, z: 0, level: 1 }, exact: true }], { signal: abort.signal });
    await flush();
    abort.abort('flee owns movement');
    await s.run(5);
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
    expect(recoveryInputs).toBe(0);
});

test('an aborted child scope cannot dispatch through Session.direct', async () => {
    const owner = workerExecution(() => {}), child = new AbortController();
    let sends = 0;
    const s = owner.bind({ sdk: {}, bot: {}, direct: async () => { sends++; }, onTick: () => () => {} } as unknown as Session);
    child.abort('leg ended');
    void executionContext.run({ signal: child.signal }, () => s.direct({ type: 'walkTo' }));
    await flush();
    expect(sends).toBe(0);
    expect(owner.signal.aborted).toBe(false);
});

test('owner cancellation ends a direct walk promptly instead of waiting for a false transport stall', async () => {
    const owner = workerExecution(() => {}), source = fakeSession([at(0, 0)]);
    const s = owner.bind({ ...source, bot: {}, direct: async () => ({ success: true }) } as unknown as Session);
    let result: { ok: boolean; detail?: string } | undefined;
    const pending = owner.run(() => walkPath({ pos: () => ({ x: 0, z: 0, level: 0 }), onTick: s.onTick,
        walk: () => s.direct({ type: 'walkTo' }), interactLoc: () => ({}), locs: () => [], plan: () => [{ x: 10, z: 0 }],
    }, [{ x: 10, z: 0 }], { idleMs: 30 })).then(value => { result = value; });
    owner.stop('worker finished');
    await flush();
    expect(result).toMatchObject({ ok: false, detail: 'stopped' });
    await pending;
});
