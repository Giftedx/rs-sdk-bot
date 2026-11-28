// Engine options that cut the committed memory of every bun process of the fleet. On Windows each JSC helper thread
// commits its stack, and a 16-core PC gets 15 wasm compiler threads at the first wasm module (the rsmod route finder)
// and 8 parallel GC markers. With one of each, measured with scripts/measure/solo-route-memory.ts, 3 runs each: a
// worker at its route plans holds 256-257 MB private against 327-331 MB, with the same plan times; an idle bun
// process holds 68 MB against 87 MB. A value the environment sets already is kept.
export const LEAN_BUN_ENV: Readonly<Record<string, string>> = {
    BUN_JSC_numberOfWasmCompilerThreads: '1',
    BUN_JSC_numberOfGCMarkers: '1',
};

export function leanBunEnv<T extends Record<string, string | undefined>>(env: T): T & Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...env };
    for (const [k, v] of Object.entries(LEAN_BUN_ENV)) if (out[k] === undefined || out[k] === '') out[k] = v;
    return out as T & Record<string, string | undefined>;
}
