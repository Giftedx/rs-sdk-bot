import {afterEach, expect, spyOn, test} from 'bun:test';
import {existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicJson, OWNER_START_READ_EVERY_MS, recoverConcurrentPlanWrite, withPlanWrite} from '../src/plan-lock';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true}); });
const nonce = '00000000-0000-4000-8000-000000000001';
const recoveryId = '00000000-0000-4000-8000-000000000002';
const ticketAt = 1_000_000, now = ticketAt + 120_000;
function abandonedTicket(timed = true) {
    const directory = mkdtempSync(join(tmpdir(), 'rsbot-plan-ticket-'));
    directories.push(directory);
    const file = join(directory, 'plan-write-lock.json'), intent = join(directory, `plan-write-${nonce}.intent.json`);
    const raw = JSON.stringify({pid: 123, nonce, at: 1});
    writeFileSync(intent, raw); linkSync(intent, file);
    const ticket = join(directory, `plan-recover-${nonce}-456-${timed ? ticketAt + '-' : ''}${recoveryId}.intent.json`);
    renameSync(intent, ticket);
    return {directory, file, intent, ticket, raw};
}
const recovererAlive = (pid: number) => pid === 456;

test('an abandoned ticket is recoverable when a later process holds its recoverer PID', () => {
    const fixture = abandonedTicket();
    const starts = (pids: readonly number[]) => {
        expect(pids).toEqual([456]);
        return new Map([[456, ticketAt + 60_000]]);
    };
    expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now)).toBe(true);
    expect(existsSync(fixture.file)).toBe(false);
    expect(readdirSync(fixture.directory)).toEqual(['plan-lock-recovery']);
    const archive = join(fixture.directory, 'plan-lock-recovery');
    expect(readdirSync(archive)).toHaveLength(1);
    expect(readFileSync(join(archive, readdirSync(archive)[0]!), 'utf8')).toBe(fixture.raw);
});

test('live, unobserved, young and future ticket owners keep their recovery claim', () => {
    for (const [start, at] of [[ticketAt - 1, now], [null, now], [undefined, now], [ticketAt + 60_000, ticketAt + 1000], [ticketAt + 60_000, ticketAt - 1]] as const) {
        const fixture = abandonedTicket(); let reads = 0;
        const starts = () => { reads++; return start === null ? null : start === undefined ? new Map<number, number>() : new Map([[456, start]]); };
        expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, at)).toBe(false);
        expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.raw);
        expect(existsSync(fixture.ticket)).toBe(true);
        expect(reads).toBe(at < ticketAt + 5000 ? 0 : 1);
    }
});

test('a waiting writer rate limits an unchanged recovery ticket start-time read', () => {
    const fixture = abandonedTicket(); let reads = 0;
    const starts = () => { reads++; return reads === 1 ? null : new Map([[456, ticketAt + 60_000]]); };
    expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now)).toBe(false);
    expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now + 25)).toBe(false);
    expect(reads).toBe(1);
    expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now + OWNER_START_READ_EVERY_MS)).toBe(true);
    expect(reads).toBe(2);
});

test('legacy tickets stay conservative without a recoverer timestamp', () => {
    const fixture = abandonedTicket(false); let reads = 0;
    const starts = () => { reads++; return new Map([[456, ticketAt + 60_000]]); };
    expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now)).toBe(false);
    expect(reads).toBe(0);
    expect(existsSync(fixture.ticket)).toBe(true);
    expect(recoverConcurrentPlanWrite(fixture.directory, () => false, starts, now)).toBe(true);
    expect(existsSync(fixture.file)).toBe(false);
});

test('a failed archive restores the intent without changing the shared ownership evidence', () => {
    const fixture = abandonedTicket();
    const clock = spyOn(Date, 'now').mockImplementationOnce(() => now).mockImplementationOnce(() => {
        const tickets = readdirSync(fixture.directory).filter(name => name.startsWith('plan-recover-'));
        expect(tickets).toHaveLength(1);
        expect(tickets[0]).toStartWith(`plan-recover-${nonce}-${process.pid}-${now}-`);
        expect(readFileSync(join(fixture.directory, tickets[0]!), 'utf8')).toBe(fixture.raw);
        expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.raw);
        throw Error('interrupted archive');
    });
    try {
        expect(() => recoverConcurrentPlanWrite(fixture.directory, () => false, () => null, now)).toThrow('interrupted archive');
    } finally { clock.mockRestore(); }
    expect(existsSync(fixture.ticket)).toBe(false);
    expect(readFileSync(fixture.intent, 'utf8')).toBe(fixture.raw);
    expect(recoverConcurrentPlanWrite(fixture.directory, () => false, () => null, now)).toBe(true);
});

test('a delayed ticket takeover cannot remove a replacement writer admitted by another recoverer', async () => {
    const fixture = abandonedTicket();
    let release: (() => void) | undefined, active: Promise<void> | undefined;
    try {
        const starts = () => {
            expect(recoverConcurrentPlanWrite(fixture.directory, () => false, () => null, now)).toBe(true);
            active = withPlanWrite(() => new Promise<void>(done => { release = done; }), fixture.directory, 100);
            return new Map([[456, ticketAt + 60_000]]);
        };
        expect(recoverConcurrentPlanWrite(fixture.directory, recovererAlive, starts, now)).toBe(false);
        const replacement = JSON.parse(readFileSync(fixture.file, 'utf8'));
        expect(replacement.pid).toBe(process.pid);
        expect(replacement.nonce).not.toBe(nonce);
        release?.(); await active;
        expect(existsSync(fixture.file)).toBe(false);
    } finally { release?.(); await active; }
});

test('atomicJson retries transient EPERM renames and cleans temp files on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsbot-atomic-json-'));
    directories.push(dir);
    const target = join(dir, 'fleet-state.json');
    let attempts = 0;
    atomicJson(target, { ok: true, count: 2 }, (from, to) => {
        attempts++;
        if (attempts <= 2) throw Object.assign(Error('transient lock'), { code: 'EPERM' });
        renameSync(from, to);
    });
    expect(attempts).toBe(3);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ok: true, count: 2 });
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);

    expect(() => atomicJson(target, { ok: false }, () => {
        throw Object.assign(Error('io failure'), { code: 'EIO' });
    })).toThrow('io failure');
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
