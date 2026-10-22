import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function checkPin(vendorDir: string, pinFile: string): { ok: boolean; expected: string; actual: string } {
    const expected = readFileSync(pinFile, 'utf8').trim();
    const out = Bun.spawnSync(['git', '-C', vendorDir, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    const actual = out.stdout.toString().trim();
    return { ok: actual === expected, expected, actual };
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..');
    const r = checkPin(join(root, 'vendor', 'rs-sdk'), join(root, 'rs-sdk.pin'));
    if (r.ok) {
        console.log(`ok rs-sdk ${r.actual.slice(0, 8)}`);
    } else {
        console.error(`rs-sdk pin mismatch: expected ${r.expected}, found ${r.actual || '(no repo)'}`);
        process.exit(1);
    }
}
