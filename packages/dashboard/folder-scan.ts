import { readdirSync, watch, type FSWatcher } from 'node:fs';

// A folder with thousands of files of which few change. Each call names the files to check now: every file on
// the first call; after that the files the watcher named, the new names, the names to try again, and a slice
// of the rest. The slice moves on each call, so `cycle` calls check every file once: that repairs an event
// that the watcher lost. `gone` names the files that left the folder.
export function folderScan(dir: string, opts: { cycle?: number; listMs?: number; now?: () => number } = {}) {
    const cycle = opts.cycle ?? 30, listMs = opts.listMs ?? 30_000, now = opts.now ?? Date.now;
    const dirty = new Set<string>();
    let names: string[] = [], known = new Set<string>(), listedAt = -Infinity, cursor = 0, first = true;
    let watcher: FSWatcher | null = null;
    const startWatcher = () => {
        if (watcher) return;
        try {
            watcher = watch(dir, (_event, file) => { if (file) dirty.add(String(file)); else listedAt = -Infinity; });
            watcher.on('error', () => { try { watcher?.close(); } catch { /* closed */ } watcher = null; });
            watcher.unref?.();
        } catch { watcher = null; }
    };
    const scan = (): { check: string[]; gone: string[] } => {
        startWatcher();
        const gone: string[] = [];
        if (now() - listedAt >= listMs) {
            listedAt = now();
            let listed: string[] = [];
            try { listed = readdirSync(dir); } catch { /* no folder: every file is gone */ }
            const next = new Set(listed);
            for (const n of known) if (!next.has(n)) gone.push(n);
            for (const n of listed) if (!known.has(n)) dirty.add(n);
            names = listed; known = next;
        }
        if (first) { first = false; dirty.clear(); return { check: [...names], gone }; }
        const step = Math.ceil(names.length / cycle);
        for (let i = 0; i < step; i++) dirty.add(names[(cursor + i) % names.length]!);
        cursor = names.length ? (cursor + step) % names.length : 0;
        const check = [...dirty];
        dirty.clear();
        return { check, gone };
    };
    // A file that was half written, or a name the caller could not read yet: check it again on the next call.
    scan.retry = (name: string) => { dirty.add(name); };
    scan.close = () => { try { watcher?.close(); } catch { /* closed */ } watcher = null; };
    return scan;
}
