import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderScan } from './folder-scan';

function folder(n: number) {
    const dir = mkdtempSync(join(tmpdir(), 'folder-scan-'));
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.json`), '{}');
    return dir;
}

test('the first call names every file and later calls name a slice that covers the folder in one cycle', () => {
    const dir = folder(100), scan = folderScan(dir, { cycle: 10, listMs: 1e9 });
    try {
        expect(scan().check.length).toBe(100);
        const seen = new Set<string>();
        for (let i = 0; i < 10; i++) { const { check } = scan(); expect(check.length).toBeLessThanOrEqual(20); for (const f of check) seen.add(f); }
        expect(seen.size).toBe(100);
    } finally { scan.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a new file is named on the next listing and a removed file is reported gone', () => {
    const dir = folder(40), scan = folderScan(dir, { cycle: 40, listMs: 0 });
    try {
        scan();
        writeFileSync(join(dir, 'new.json'), '{}');
        rmSync(join(dir, 'f000.json'));
        const { check, gone } = scan();
        expect(check).toContain('new.json');
        expect(gone).toEqual(['f000.json']);
    } finally { scan.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a name given to retry is named again, and a missing folder gives no files', () => {
    const dir = folder(40), scan = folderScan(dir, { cycle: 40, listMs: 1e9 });
    try { scan(); scan.retry('f039.json'); expect(scan().check).toContain('f039.json'); }
    finally { scan.close(); rmSync(dir, { recursive: true, force: true }); }
    const none = folderScan(join(dir, 'absent'));
    expect(none()).toEqual({ check: [], gone: [] });
    none.close();
});

test('the watcher names a changed file before the slice reaches it', async () => {
    const dir = folder(200), scan = folderScan(dir, { cycle: 200, listMs: 1e9 });
    try {
        scan(); scan();
        writeFileSync(join(dir, 'f150.json'), '{"a":1}');
        await new Promise(r => setTimeout(r, 300));
        expect(scan().check).toContain('f150.json');
    } finally { scan.close(); rmSync(dir, { recursive: true, force: true }); }
});
