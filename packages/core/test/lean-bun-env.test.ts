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

test('bun accepts the options without a warning and keeps bun:ffi usable', () => {
    const code = 'import { ptr } from "bun:ffi"; console.log(typeof ptr === "function" ? "ok" : "bad")';
    const r = Bun.spawnSync([process.execPath, '-e', code], { env: leanBunEnv({ ...process.env }), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe('ok');
    expect(r.stderr.toString()).toBe('');
    expect(LEAN_BUN_ENV.BUN_JSC_useJIT).toBeUndefined();
    expect(LEAN_BUN_ENV.BUN_JSC_useOMGJIT).toBeUndefined();
    expect(LEAN_BUN_ENV.BUN_JSC_useBBQJIT).toBeUndefined();
});
