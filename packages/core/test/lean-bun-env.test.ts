import { expect, test } from 'bun:test';
import { LEAN_BUN_ENV, leanBunEnv } from '../src/lean-bun-env';

test('adds the lean engine options and keeps every other variable', () => {
    const env = leanBunEnv({ PATH: 'p', DEMO_OK: '1' });
    expect(env).toEqual({ PATH: 'p', DEMO_OK: '1', ...LEAN_BUN_ENV });
});

test('a value the environment sets is kept', () => {
    const env = leanBunEnv({ BUN_JSC_numberOfGCMarkers: '4', BUN_JSC_numberOfWasmCompilerThreads: '' });
    expect(env.BUN_JSC_numberOfGCMarkers).toBe('4');
    expect(env.BUN_JSC_numberOfWasmCompilerThreads).toBe('1');
});

test('bun accepts the options without a warning', () => {
    const r = Bun.spawnSync([process.execPath, '-e', 'console.log("ok")'], { env: leanBunEnv({ ...process.env }), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(r.stdout.toString().trim()).toBe('ok');
    expect(r.stderr.toString()).toBe('');
});
