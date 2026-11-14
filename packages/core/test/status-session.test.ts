import { expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { noteStatusLine, startStatus } from '../src/status';
import { assertCompatibleWorkers } from '../src/worker-release';

const server = 'localhost:8888';
const file = (name: string) => resolve(import.meta.dir, '../../../.practice/status', `${name}.json`);
const read = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
const remove = (name: string) => { rmSync(file(name), { force: true }); rmSync(file(name) + '.tmp', { force: true }); };
function session(name: string, attemptId: string) {
    const callbacks = new Set<() => void>();
    const s: any = {
        name, lifecycle: { attemptId }, sdk: { getState: () => ({ inventory: [], skills: [] }) }, tick: () => 1,
        onTick: (callback: () => void) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    };
    return { s, flush: () => { for (let n = 0; n < 5; n++) for (const callback of callbacks) callback(); } };
}

test('a hosted chain step clears previous terminal output and remains an unfinished worker', () => {
    const name = `ChainStatus${process.pid}`;
    const first = session(name, 'first-attempt');
    noteStatusLine(name, 'START 1 1 0');
    const before = startStatus(first.s, server);
    noteStatusLine(name, 'MILESTONE previous step');
    noteStatusLine(name, 'RESULT ok ticks=12 banked=20');
    before.stop();
    expect(read(name).result).toBe('ok ticks=12 banked=20');

    const next = session(name, 'next-attempt');
    noteStatusLine(name, 'START 2 2 0');
    const current = startStatus(next.s, server);
    try {
        const row = read(name);
        expect(row.sessionAttemptId).toBe('next-attempt');
        expect(row.phase).toBe('');
        expect(row.result).toBe('');
        expect(row.counters).toEqual({});
        expect(() => assertCompatibleWorkers('a'.repeat(64), server, [{ ...row, workRevision: 'b'.repeat(64) }], row.at + 1)).toThrow();
        before.stop();
        expect(read(name).sessionAttemptId).toBe('next-attempt');
        noteStatusLine(name.toLowerCase(), 'MILESTONE current step');
        noteStatusLine(name.toLowerCase(), 'RESULT ok ticks=3 banked=1');
        current.stop();
        expect(read(name)).toMatchObject({ phase: 'current step', result: 'ok ticks=3 banked=1', counters: { ticks: 3, banked: 1 } });
    } finally { before.stop(); current.stop(); remove(name); }
});

test('standalone sessions clear prior console output without erasing another active actor', () => {
    const a = `SoloStatusA${process.pid}`, b = `SoloStatusB${process.pid}`;
    const first = session(a, 'first'), before = startStatus(first.s, server);
    console.log('MILESTONE first phase');
    console.log('RESULT ok ticks=7');
    before.stop();
    const other = session(b, 'other'), concurrent = startStatus(other.s, server);
    const next = session(a, 'next'), current = startStatus(next.s, server);
    try {
        expect(read(a)).toMatchObject({ phase: '', result: '', counters: {} });
        expect(read(b)).toMatchObject({ phase: '', result: '', counters: {} });
        console.log('MILESTONE current phase');
        console.log('RESULT ok ticks=2');
        next.flush(); other.flush();
        expect(read(a)).toMatchObject({ phase: 'current phase', result: 'ok ticks=2', counters: { ticks: 2 } });
        expect(read(b)).toMatchObject({ phase: 'current phase', result: 'ok ticks=2', counters: { ticks: 2 } });
        const third = session(`SoloStatusC${process.pid}`, 'third'), fresh = startStatus(third.s, server);
        try {
            expect(read(third.s.name).result).toBe('');
            other.flush();
            expect(read(b).result).toBe('ok ticks=2');
        } finally { fresh.stop(); remove(third.s.name); }
    } finally { before.stop(); current.stop(); concurrent.stop(); remove(a); remove(b); }
});

test('opening another actor preserves an active hosted actor and ignores global RESULT lines', () => {
    const a = `HostedStatusA${process.pid}`, b = `HostedStatusB${process.pid}`;
    noteStatusLine(a, 'START 1 1 0');
    const first = session(a, 'first'), active = startStatus(first.s, server);
    noteStatusLine(a, 'MILESTONE keep working');
    const second = session(b, 'second'), other = startStatus(second.s, server);
    try {
        console.log('RESULT ok global=999');
        first.flush();
        expect(read(a)).toMatchObject({ phase: 'keep working', result: '', counters: {} });
    } finally { active.stop(); other.stop(); remove(a); remove(b); }
});
