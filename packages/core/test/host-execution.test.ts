import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { hostedEntrySource, rewriteScript, runHost } from '../src/host';
import type { Session } from '../src/inprocess';

test('host finish cancels pending SDK helpers for only that worker', async () => {
    const evidence: Record<string, any> = {};
    (globalThis as any).__hostExecutionEvidence = evidence;
    const logDir = join(tmpdir(), `host-execution-${process.pid}-${Date.now()}`);
    mkdirSync(logDir, { recursive: true });
    try {
        const script = join(import.meta.dir, 'fixtures/host-execution.ts');
        const result = await runHost([{ name: 'scope-finisher', script }, { name: 'scope-survivor', script }], { logDir, out: () => {}, guard: false });
        expect(result.every(r => r.ok)).toBe(true);
        const first = evidence['scope-finisher'], second = evidence['scope-survivor'];
        expect(first.activeBeforeFinish).toBe(true);
        expect(second.activeBeforeFinish).toBe(true);
        expect(second.otherFinished).toBe(true);
        expect(first.signal).not.toBe(second.signal);
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
        expect((first.sdk as any).stateListeners.size).toBe(0);
        expect((second.sdk as any).stateListeners.size).toBe(0);
    } finally {
        delete (globalThis as any).__hostExecutionEvidence;
        rmSync(logDir, { recursive: true, force: true });
    }
});

test('a hosted process.exit waits for its owned session cleanup', async () => {
    const evidence: Record<string, any> = {};
    (globalThis as any).__hostExecutionEvidence = evidence;
    const logDir = join(tmpdir(), `host-exit-cleanup-${process.pid}-${Date.now()}`);
    mkdirSync(logDir, { recursive: true });
    try {
        const [result] = await runHost([{ name: 'scope-exiter', script: join(import.meta.dir, 'fixtures/host-execution.ts') }], { logDir, out: () => {}, guard: false });
        expect(result!.code).toBe(3);
        expect(evidence['scope-exiter'].closed).toBe(true);
        expect(evidence['scope-exiter'].signal.aborted).toBe(true);
    } finally {
        delete (globalThis as any).__hostExecutionEvidence;
        rmSync(logDir, { recursive: true, force: true });
    }
});

test('host rewriting changes code references while keeping literal data intact', () => {
    const source = `const label = "process.env; process.exit(1); console.log";\nconst owner = process.argv[2];\nprocess.exit /* retain this comment */ (3);`;
    const output = rewriteScript(source, 'inert', 'F:/r/scripts', 'F:/r/packages/core/src/bot.ts');
    expect(output).toContain('"process.env; process.exit(1); console.log"');
    expect(output).toContain('__host.argv[2]');
    expect(output).toMatch(/__host\.exit\s*\/\* retain this comment \*\/\s*\(3\)/);
});

test('scoped worker entries retain static imports and executable exported helpers', () => {
    const source = `import { x } from './helper';\nexport function value() { return x; }\nexport const n = value();\nexport default { value: n };`;
    const output = hostedEntrySource(source, 'inert', 'F:/r/scripts');
    expect(output.indexOf('import')).toBeLessThan(output.indexOf('execution.run'));
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(output)).not.toThrow();
    expect(output).toContain('function value()');
});

test('host exit keeps ownership of an unfinished open until its late session is closed', async () => {
    let started!: () => void, release!: (s: Session) => void;
    const opened = new Promise<void>(r => { started = r; });
    const factory = new Promise<Session>(r => { release = r; });
    const logDir = join(tmpdir(), `host-open-race-${process.pid}-${Date.now()}`);
    let closed = false, returned = false, calls = 0, retained: any;
    const session = { name: 'scope-opening', sdk: {}, bot: {}, direct: async () => ({}), onTick: () => () => {}, ended: Promise.resolve({ reason: 'logged-out' }), close: async () => { closed = true; } } as unknown as Session;
    try {
        const run = runHost([{ name: 'scope-opening', script: join(import.meta.dir, 'fixtures/host-open-race.ts') }], { logDir, out: () => {}, guard: false, open: async () => {
            calls++;
            retained = [...((globalThis as any).__rsBotHost as Map<string, any>).values()].find(x => x.name === 'scope-opening');
            started(); return factory;
        } });
        void run.then(() => { returned = true; });
        await opened;
        for (let n = 0; n < 20; n++) await Promise.resolve();
        const prematureReturn = returned;
        release(session);
        const [result] = await run;
        expect(prematureReturn).toBe(false);
        expect(closed).toBe(true);
        expect(result!.code).toBe(3);
        void retained.execution.run(() => retained.openBot('scope-opening')).catch(() => {});
        for (let n = 0; n < 20; n++) await Promise.resolve();
        expect(calls).toBe(1);
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});
