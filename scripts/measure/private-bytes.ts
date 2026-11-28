// Private bytes (commit charge) and working set of this process. On Windows it reads PROCESS_MEMORY_COUNTERS_EX by
// K32GetProcessMemoryInfo through bun:ffi, because a shell scan from a long bun process can hang (spawnSync). On other
// platforms private is null and the working set is process.memoryUsage().rss.
export type ProcessMemory = { privateMb: number | null; workingSetMb: number };

let read: (() => ProcessMemory) | null = null;
export function processMemory(): ProcessMemory {
    if (read) return read();
    if (process.platform !== 'win32') return (read = () => ({ privateMb: null, workingSetMb: Math.round(process.memoryUsage().rss / 2 ** 20) }))();
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const k32 = dlopen('kernel32.dll', {
        GetCurrentProcess: { args: [], returns: FFIType.ptr },
        K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    // PROCESS_MEMORY_COUNTERS_EX: cb u32, PageFaultCount u32, then 8 SIZE_T fields, then PrivateUsage SIZE_T (80 bytes).
    const buf = new BigUint64Array(10), view = new DataView(buf.buffer);
    view.setUint32(0, 80, true);
    const handle = k32.symbols.GetCurrentProcess();
    read = () => {
        if (!k32.symbols.K32GetProcessMemoryInfo(handle, ptr(buf), 80)) throw Error('K32GetProcessMemoryInfo failed');
        const mb = (i: number) => Math.round(Number(buf[i]) / 2 ** 20);
        return { privateMb: mb(9), workingSetMb: mb(2) };
    };
    return read();
}
