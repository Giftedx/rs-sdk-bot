// Engine options that cut the committed memory of every bun process of the fleet. On Windows each JSC helper thread
// and libuv async IO thread commits its stack (8 MiB per libuv thread by default), and a 16-core PC gets 15 wasm
// compiler threads, 7 FTL compiler threads, 3 baseline/worklist threads, 2 DFG compiler threads, and 8 parallel GC
// markers; DFG/FTL JIT caches, non-mini VM heap growth, concurrent GC headroom, and retained Eden pages add further
// committed pages. Baseline JIT and Wasm BBQ/OMG remain enabled so `bun:ffi` and pathfinder WASM work at full speed
// (route-service overrides `BUN_JSC_useDFGJIT=1` for A*). A value the environment sets already is kept.
export const LEAN_BUN_ENV: Readonly<Record<string, string>> = {
    UV_THREADPOOL_SIZE: '1',
    BUN_JSC_numberOfWasmCompilerThreads: '1',
    BUN_JSC_numberOfGCMarkers: '1',
    BUN_JSC_numberOfBaselineCompilerThreads: '1',
    BUN_JSC_numberOfDFGCompilerThreads: '1',
    BUN_JSC_numberOfFTLCompilerThreads: '1',
    BUN_JSC_minNumberOfWorklistThreads: '1',
    BUN_JSC_maxNumberOfWorklistThreads: '1',
    BUN_JSC_useDFGJIT: '0',
    BUN_JSC_useFTLJIT: '0',
    BUN_JSC_forceMiniVMMode: '1',
    BUN_JSC_useConcurrentGC: '0',
    BUN_JSC_jitMemoryReservationSize: '8388608',
    BUN_JSC_maxPerThreadStackUsage: '524288',
    BUN_JSC_forceRAMSize: '268435456',
};

export function leanBunEnv<T extends Record<string, string | undefined>>(env: T): T & Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...env };
    for (const [k, v] of Object.entries(LEAN_BUN_ENV)) if (out[k] === undefined || out[k] === '') out[k] = v;
    return out as T & Record<string, string | undefined>;
}
