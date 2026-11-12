import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROLLERS, GATE_STALE_MS, LAUNCH_ENV, LEASE_STALE_MS, controllerNamed, controllerState, controllerStates, leaseHolder, readLaunch, readLease, releaseLease, renewLease, saveLaunch, takeLease } from '../src/controllers';

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

test('a different live process at the gate stops a take, and the ticket of an ended process does not', () => {
    const dir = tmp(), file = join(dir, 'x.lock'), gate = join(dir, 'x.lock.gate'), ticket = (pid: number) => join(gate, `${pid}.00000000-0000-4000-8000-000000000000`);
    try {
        // A live process is at the gate: no take, and its ticket stays.
        mkdirSync(gate); writeFileSync(ticket(77), '');
        const before = Date.now();
        expect(takeLease(file, 10, { now, alive: pid => pid === 77 })).toBe(false);
        expect(Date.now() - before).toBeGreaterThanOrEqual(7 * 20);    // it tried again after each short wait
        expect(readdirSync(dir)).toEqual(['x.lock.gate']);
        expect(readdirSync(gate)).toEqual(['77.00000000-0000-4000-8000-000000000000']);
        // That process ended: its ticket is removed and the take goes on.
        expect(takeLease(file, 10, { now, alive: () => false })).toBe(true);
        expect(readdirSync(gate)).toEqual([]);
        // A ticket older than GATE_STALE_MS is of an ended process, also when its id is alive again in a new process.
        writeFileSync(ticket(78), ''); setTime(ticket(78), Date.now() - GATE_STALE_MS);
        setTime(file, now - LEASE_STALE_MS);
        expect(takeLease(file, 11, { now, alive: () => true })).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe('11');
        // A ticket that an ended process left with this process's id does not stop this process.
        writeFileSync(ticket(12), '');
        setTime(file, now - LEASE_STALE_MS);
        expect(takeLease(file, 12, { now, alive: () => true })).toBe(true);
        // No ticket, temporary file or moved file stays.
        expect(readdirSync(dir)).toEqual(['x.lock', 'x.lock.gate']);
        expect(readdirSync(gate)).toEqual([]);
        // A new checkout has no folder for the lease: the take makes it.
        const fresh = join(dir, 'new', '.practice', 'autopilot.lock');
        expect(takeLease(fresh, 13, { now, alive: () => true })).toBe(true);
        expect(readdirSync(join(dir, 'new', '.practice'))).toEqual(['autopilot.lock', 'autopilot.lock.gate']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a heartbeat is one step at the gate, and with a busy gate it writes nothing', () => {
    const dir = tmp(), file = join(dir, 'x.lock'), gate = join(dir, 'x.lock.gate'), busy = { alive: (pid: number) => pid === 77 };
    try {
        expect(takeLease(file, 11, { now, alive: () => false })).toBe(true);
        // The usual case: the time of the lease becomes the time of the heartbeat.
        expect(renewLease(file, 11, now + 5000)).toBe(true);
        expect(readLease(file)).toEqual({ pid: 11, at: now + 5000 });
        // A different process is at the gate and stays there. A lease that is still new stays held, with no write.
        writeFileSync(join(gate, '77.00000000-0000-4000-8000-000000000000'), '');
        expect(renewLease(file, 11, now + 6000, busy)).toBe(true);
        expect(readLease(file)!.at).toBe(now + 5000);
        // A lease that is old enough to be taken, with a different process at the gate: lost, and no time is set.
        expect(renewLease(file, 11, now + 5000 + LEASE_STALE_MS, busy)).toBe(false);
        expect(readLease(file)!.at).toBe(now + 5000);
        // The different process took the lease: this heartbeat does not set the time of that lease.
        rmSync(join(gate, '77.00000000-0000-4000-8000-000000000000'));
        expect(takeLease(file, 22, { now: now + 5000 + LEASE_STALE_MS, alive: () => true })).toBe(true);
        const taken = readLease(file)!;
        expect(taken.pid).toBe(22);
        expect(renewLease(file, 11, now + 9_000_000)).toBe(false);
        expect(readLease(file)).toEqual(taken);
        // A release by the process that lost the lease does not remove the lease of the new holder.
        releaseLease(file, 11);
        expect(readLease(file)).toEqual(taken);
        releaseLease(file, 22);
        expect(existsSync(file)).toBe(false);
        expect(readdirSync(gate)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('of eight processes that try in the same millisecond, one takes the lease', async () => {
    const racer = join(import.meta.dir, 'lease-racer.ts');
    for (const start of ['no lease', 'lease of an ended process', 'lease and gate ticket of an ended process']) {
        const dir = tmp(), file = join(dir, 'x.lock');
        try {
            if (start !== 'no lease') {
                const ended = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
                await ended.exited;
                writeFileSync(file, String(ended.pid));
                if (start.includes('gate')) { mkdirSync(join(dir, 'x.lock.gate')); writeFileSync(join(dir, 'x.lock.gate', `${ended.pid}.00000000-0000-4000-8000-000000000000`), ''); }
            }
            const at = Date.now() + 2000;
            const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, racer, file, String(at)], { stdout: 'pipe', stderr: 'pipe' }));
            const said = await Promise.all(children.map(async c => (await new Response(c.stdout).text()).trim() + (await new Response(c.stderr).text()).trim()));
            expect(said.filter(s => s === 'TOOK').length, `${start}: ${said.join(',')}`).toBe(1);
            expect(said.filter(s => s === 'REFUSED').length, `${start}: ${said.join(',')}`).toBe(7);
            expect(readFileSync(file, 'utf8'), start).toBe(String(children[said.indexOf('TOOK')]!.pid));
            expect(readdirSync(dir), start).toEqual(['x.lock', 'x.lock.gate']);
            expect(readdirSync(join(dir, 'x.lock.gate')), start).toEqual([]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }
}, 60_000);

test('the launch record gives back the arguments, and a damaged record gives null', () => {
    const dir = tmp(), file = join(dir, 'autopilot', 'launch.json');
    try {
        expect(readLaunch(file)).toBeNull();
        // Only the LAUNCH_ENV settings are kept. A secret, an empty value and each other variable stay out of the file.
        saveLaunch(file, ['C:/fleet/.practice/cloud-handoff/swarm.json'], { FLEET_SIDE: 'cloud', SWARM_PLAN: 'C:/fleet/plan.json', DEMO_OK: '1', CYCLE: '', FLEET_SEED: 'secret', PATH: 'C:/bin', LEAD: undefined });
        expect(readLaunch(file)).toEqual({ args: ['C:/fleet/.practice/cloud-handoff/swarm.json'], env: { FLEET_SIDE: 'cloud', SWARM_PLAN: 'C:/fleet/plan.json', DEMO_OK: '1' } });
        expect(readFileSync(file, 'utf8')).not.toContain('secret');
        expect([...LAUNCH_ENV]).toEqual(['FLEET_SIDE', 'SWARM_PLAN', 'FLEET_DIR', 'CYCLE', 'LEAD', 'DEMO_OK']);
        saveLaunch(file, [], {});
        expect(readLaunch(file)).toEqual({ args: [], env: {} });
        for (const bad of ['', '{', 'null', '[]', '{"args":[]}', '{"args":"swarm.json","env":{}}', '{"args":[1],"env":{}}', '{"args":[""],"env":{}}', '{"args":["a\\u0000b"],"env":{}}',
            '{"args":[],"env":[]}', '{"args":[],"env":{"PATH":"x"}}', '{"args":[],"env":{"FLEET_SEED":"x"}}', '{"args":[],"env":{"FLEET_SIDE":7}}', '{"args":[],"env":{"FLEET_SIDE":""}}']) {
            writeFileSync(file, bad); expect(readLaunch(file), bad).toBeNull();
        }
        expect(controllerNamed('autopilot').launch).toBe('.practice/autopilot/launch.json');
        expect(controllerNamed('fleet-agent').launch).toBe('.practice/fleet-agent.launch.json');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a controller is running, stopped, down or never', () => {
    const root = tmp(), agent = CONTROLLERS.find(c => c.name === 'fleet-agent')!, pilot = CONTROLLERS.find(c => c.name === 'autopilot')!;
    try {
        mkdirSync(join(root, '.practice'));
        expect(controllerStates(root, { now }).map(s => [s.name, s.state, s.pid, s.seenAt])).toEqual([['fleet-agent', 'never', null, null], ['autopilot', 'never', null, null]]);

        // The traces of a one-shot pass are not a daemon start: a log, a state folder, and a lease with no launch record.
        writeFileSync(join(root, '.practice/fleet-agent.log'), 'log'); mkdirSync(join(root, '.practice/autopilot'));
        writeFileSync(join(root, pilot.lease), '55'); setTime(join(root, pilot.lease), now - 3 * 3600_000);
        expect(controllerStates(root, { now, alive: () => false }).map(s => s.state)).toEqual(['never', 'never']);
        rmSync(join(root, pilot.lease));
        // A record that does not have the exact form is not a daemon start.
        writeFileSync(join(root, agent.launch), '{"args":[]}');
        expect(controllerState(root, agent, { now }).state).toBe('never');

        // A daemon started here and nothing holds the lease: down. With no lease file, the start is the time last seen.
        saveLaunch(join(root, agent.launch), [], { DEMO_OK: '1' }); setTime(join(root, agent.launch), now - 9 * 3600_000);
        expect(controllerState(root, agent, { now })).toEqual({ name: 'fleet-agent', label: 'Fleet agent', state: 'down', pid: null, seenAt: now - 9 * 3600_000 });

        // A lease of an ended process is still down. A live holder with a fresh lease is running.
        writeFileSync(join(root, agent.lease), '77'); setTime(join(root, agent.lease), now - 60_000);
        expect(controllerState(root, agent, { now, alive: () => false })).toMatchObject({ state: 'down', pid: null, seenAt: now - 60_000 });
        expect(controllerState(root, agent, { now, alive: () => true })).toMatchObject({ state: 'running', pid: 77, seenAt: now - 60_000 });

        // The owner's stop file: stopped, not down. A live holder still shows as running.
        writeFileSync(join(root, agent.stop), '');
        expect(controllerState(root, agent, { now, alive: () => false }).state).toBe('stopped');
        expect(controllerState(root, agent, { now, alive: () => true }).state).toBe('running');

        saveLaunch(join(root, pilot.launch), [join(root, 'swarm.json')], {});
        expect(controllerState(root, pilot, { now }).state).toBe('down');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
