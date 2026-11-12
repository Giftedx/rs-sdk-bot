import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROLLERS, LEASE_STALE_MS, controllerState, controllerStates, leaseHolder, readLaunch, readLease, releaseLease, renewLease, saveLaunch, takeLease } from '../src/controllers';

const now = 1_800_000_000_000;
const setTime = (file: string, at: number) => utimesSync(file, at / 1000, at / 1000);
const tmp = () => mkdtempSync(join(tmpdir(), 'controllers-'));

test('a lease is held only by a live process with a fresh file', () => {
    const dir = tmp(), file = join(dir, 'x.lock');
    try {
        expect(readLease(file)).toBeNull();
        expect(leaseHolder(file, { now, alive: () => true })).toBeNull();
        writeFileSync(file, '4242'); setTime(file, now - 1000);
        expect(readLease(file)).toEqual({ pid: 4242, at: now - 1000 });
        expect(leaseHolder(file, { now, alive: () => true })).toBe(4242);
        expect(leaseHolder(file, { now, alive: () => false })).toBeNull();
        // The id of an ended process can belong to a new process. A file with no heartbeat is not a held lease.
        setTime(file, now - LEASE_STALE_MS);
        expect(leaseHolder(file, { now, alive: () => true })).toBeNull();
        setTime(file, now - LEASE_STALE_MS + 1);
        expect(leaseHolder(file, { now, alive: () => true })).toBe(4242);
        for (const bad of ['', 'abc', '-3', '0', '1.5']) { writeFileSync(file, bad); expect(readLease(file)).toBeNull(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('take, renew and release let one process hold the lease and tell a holder that it lost it', () => {
    const dir = tmp(), file = join(dir, 'x.lock'), live = { now, alive: () => true };
    try {
        expect(takeLease(file, 10, live)).toBe(true);
        setTime(file, now - 1000);
        expect(takeLease(file, 11, live)).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe('10');
        expect(takeLease(file, 10, live)).toBe(true);
        expect(renewLease(file, 10)).toBe(true);
        expect(renewLease(file, 11)).toBe(false);
        releaseLease(file, 11);
        expect(existsSync(file)).toBe(true);
        // The holder ended, or its heartbeat stopped: the next process takes the lease, and the first one learns it.
        setTime(file, now - 1000);
        expect(takeLease(file, 11, { now, alive: () => false })).toBe(true);
        setTime(file, now - LEASE_STALE_MS);
        expect(takeLease(file, 12, live)).toBe(true);
        expect(renewLease(file, 11)).toBe(false);
        expect(renewLease(file, 12)).toBe(true);
        releaseLease(file, 12);
        expect(existsSync(file)).toBe(false);
        expect(renewLease(file, 12)).toBe(false);
        releaseLease(file, 12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the launch record gives back the arguments, and a damaged record gives null', () => {
    const dir = tmp(), file = join(dir, 'autopilot', 'launch.json');
    try {
        expect(readLaunch(file)).toBeNull();
        saveLaunch(file, ['C:/fleet/.practice/cloud-handoff/swarm.json']);
        expect(readLaunch(file)).toEqual(['C:/fleet/.practice/cloud-handoff/swarm.json']);
        saveLaunch(file, []);
        expect(readLaunch(file)).toEqual([]);
        for (const bad of ['', '{', 'null', '{"args":"swarm.json"}', '{"args":[1]}', '{"args":[""]}', '{"args":["a\\u0000b"]}']) { writeFileSync(file, bad); expect(readLaunch(file)).toBeNull(); }
        expect(CONTROLLERS.find(c => c.name === 'autopilot')!.launch).toBe('.practice/autopilot/launch.json');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a controller is running, stopped, down or never', () => {
    const root = tmp(), agent = CONTROLLERS.find(c => c.name === 'fleet-agent')!, pilot = CONTROLLERS.find(c => c.name === 'autopilot')!;
    try {
        mkdirSync(join(root, '.practice'));
        expect(controllerStates(root, { now }).map(s => [s.name, s.state, s.pid, s.seenAt])).toEqual([['fleet-agent', 'never', null, null], ['autopilot', 'never', null, null]]);

        // It ran before and nothing holds the lease: down. The time of its last trace is the time it was last seen.
        writeFileSync(join(root, agent.ran), 'log'); setTime(join(root, agent.ran), now - 9 * 3600_000);
        expect(controllerState(root, agent, { now })).toEqual({ name: 'fleet-agent', label: 'Fleet agent', state: 'down', pid: null, seenAt: now - 9 * 3600_000 });

        // A lease of an ended process is still down. A live holder with a fresh lease is running.
        writeFileSync(join(root, agent.lease), '77'); setTime(join(root, agent.lease), now - 60_000);
        expect(controllerState(root, agent, { now, alive: () => false })).toMatchObject({ state: 'down', pid: null, seenAt: now - 60_000 });
        expect(controllerState(root, agent, { now, alive: () => true })).toMatchObject({ state: 'running', pid: 77, seenAt: now - 60_000 });

        // The owner's stop file: stopped, not down. A live holder still shows as running.
        writeFileSync(join(root, agent.stop), '');
        expect(controllerState(root, agent, { now, alive: () => false }).state).toBe('stopped');
        expect(controllerState(root, agent, { now, alive: () => true }).state).toBe('running');

        mkdirSync(join(root, pilot.ran));
        expect(controllerState(root, pilot, { now }).state).toBe('down');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
