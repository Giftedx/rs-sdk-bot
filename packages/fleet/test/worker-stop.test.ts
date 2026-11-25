import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askTradesToStop, fleetOwnerStop, stopTradesThenExit } from '../src/fleet-agent';
import { recoveryLogOutThenExit, SWARM_STOP, swarmSignalStop } from '../src/swarm';
import { askWorkersToLogOut } from '../src/worker-stop';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempBase = () => { const d = mkdtempSync(join(tmpdir(), 'worker-stop-')); dirs.push(d); mkdirSync(join(d, '.practice'), { recursive: true }); return d; };

// A clock that moves only when the code under test sleeps.
function fakeClock(onSleep: (at: number) => void = () => {}) {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => { t += Math.max(1, ms); onSleep(t); }, at: () => t };
}

test('askWorkersToLogOut asks each running worker once, then waits for the workers to end', async () => {
    const asked: string[] = [];
    let ended = false;
    const clock = fakeClock(t => { if (t >= 1_000_000 + 1_500) ended = true; });
    const left = await askWorkersToLogOut(
        [{ account: 'Dipstick', ended: () => ended }, { account: 'Gone', ended: () => true }],
        { writeStop: a => asked.push(a), now: clock.now, sleep: clock.sleep, pollMs: 500, graceMs: 90_000 },
    );
    expect(asked).toEqual(['Dipstick']);
    expect(left).toEqual([]);
    expect(clock.at() - 1_000_000).toBeLessThan(2_000);
});

test('askWorkersToLogOut gives up at the grace and names the workers still running', async () => {
    const clock = fakeClock();
    const left = await askWorkersToLogOut([{ account: 'Stuck', ended: () => false }], { writeStop: () => {}, now: clock.now, sleep: clock.sleep, graceMs: 90_000 });
    expect(left).toEqual(['Stuck']);
    expect(clock.at() - 1_000_000).toBe(90_000);
});

test('an owner stop asks every running fleet-agent trade to log out, once', () => {
    const base = tempBase(), running = new Map([['dipstick', 'Dipstick'], ['packhorse', 'Packhorse']]), asked = new Set<string>();
    expect(fleetOwnerStop(base)).toBeNull();
    expect(askTradesToStop(base, running, asked)).toEqual([]);

    // The cloud side's normal stop text is the swarm's own; it stops the agent with SIGTERM instead.
    writeFileSync(join(base, '.practice', 'stop-swarm'), SWARM_STOP.all);
    expect(fleetOwnerStop(base)).toBeNull();
    expect(askTradesToStop(base, running, asked)).toEqual([]);

    writeFileSync(join(base, '.practice', 'stop-swarm'), 'Owner requested immediate stop');
    writeFileSync(join(base, '.practice', 'stop-Packhorse'), 'owner hold');
    expect(fleetOwnerStop(base)).toBe('owner stop-swarm');
    expect(askTradesToStop(base, running, asked)).toEqual(['Dipstick', 'Packhorse']);
    expect(readFileSync(join(base, '.practice', 'stop-Dipstick'), 'utf8')).toBe(SWARM_STOP.all);
    expect(readFileSync(join(base, '.practice', 'stop-Packhorse'), 'utf8')).toBe('owner hold');
    expect(askTradesToStop(base, running, asked)).toEqual([]);

    rmSync(join(base, '.practice', 'stop-swarm'));
    writeFileSync(join(base, '.practice', 'stop-fleet-agent'), '');
    expect(fleetOwnerStop(base)).toBe('stop-fleet-agent');
    expect(askTradesToStop(base, new Map([['shaftsinker', 'Shaftsinker']]), asked)).toEqual(['Shaftsinker']);
});

test('a signal stops the fleet agent only after its running trades end or the grace ends', async () => {
    const base = tempBase(), running = new Map([['dipstick', 'Dipstick']]), lines: string[] = [];
    let exitAt: number | null = null;
    const clock = fakeClock(t => { if (t >= 1_000_000 + 4_000) running.delete('dipstick'); });
    await stopTradesThenExit(base, running, 'SIGTERM', { now: clock.now, sleep: clock.sleep, exit: () => { exitAt = clock.at(); }, log: l => lines.push(l) });
    expect(readFileSync(join(base, '.practice', 'stop-Dipstick'), 'utf8')).toBe(SWARM_STOP.all);
    expect(exitAt).not.toBeNull();
    expect(exitAt! - 1_000_000).toBeGreaterThanOrEqual(4_000);
    expect(exitAt! - 1_000_000).toBeLessThan(90_000);
    expect(lines).toEqual(['FLEET_AGENT SIGTERM: asking Dipstick to log out before exit']);

    const idle = tempBase();
    let idleExit = false;
    await stopTradesThenExit(idle, new Map(), 'SIGINT', { exit: () => { idleExit = true; }, log: l => lines.push(l) });
    expect(idleExit).toBe(true);
    expect(existsSync(join(idle, '.practice', 'stop-Dipstick'))).toBe(false);
});

test('a signal stops the swarm only after its attached recovery child ends or the grace ends', async () => {
    const asked: string[] = [], lines: string[] = [];
    let alive = true, exits = 0;
    const clock = fakeClock(t => { if (t >= 1_000_000 + 2_000) alive = false; });
    await recoveryLogOutThenExit({ account: 'Fixer', pid: 4242 }, () => alive, a => asked.push(a), { now: clock.now, sleep: clock.sleep, exit: () => { exits++; }, log: l => lines.push(l) });
    expect(asked).toEqual(['Fixer']);
    expect(exits).toBe(1);
    expect(clock.at() - 1_000_000).toBeLessThan(3_000);

    const stuck = fakeClock();
    await recoveryLogOutThenExit({ account: 'Fixer', pid: 4242 }, () => true, () => {}, { now: stuck.now, sleep: stuck.sleep, exit: () => { exits++; }, log: l => lines.push(l) });
    expect(stuck.at() - 1_000_000).toBe(90_000);
    expect(lines.at(-1)).toBe('SWARM signal: recovery Fixer did not end in the grace; it ends with this process');

    await recoveryLogOutThenExit(undefined, () => true, () => { throw Error('no recovery to ask'); }, { exit: () => { exits++; } });
    expect(exits).toBe(3);
});

test('the first swarm signal stops new starts before the recovery wait; a second signal exits at once', async () => {
    // The swarm tick returns while `stopping` is true (runSwarmCli). Without that, the 2 s tick could start new
    // detached runs during the 90 s wait, and they would outlive the controller.
    let alive = true, exits = 0;
    const asked: string[] = [];
    const clock = fakeClock(t => { if (t >= 1_000_000 + 30_000) alive = false; });
    const stop = swarmSignalStop({
        active: () => ({ account: 'Fixer', pid: 4242 }),
        alive: () => alive,
        writeStop: a => asked.push(a),
        now: clock.now, sleep: clock.sleep, exit: () => { exits++; }, log: () => {},
    });
    expect(stop.stopping).toBe(false);
    stop.onSignal();
    expect(stop.stopping).toBe(true);
    expect(asked).toEqual(['Fixer']);
    expect(exits).toBe(0);
    stop.onSignal();
    expect(exits).toBe(1);
    await new Promise(r => setTimeout(r, 20));
    expect(alive).toBe(false);
    expect(exits).toBe(2);
});
