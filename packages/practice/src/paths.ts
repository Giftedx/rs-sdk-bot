import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

export function rsSdkRoot(): string {
    return join(repoRoot, 'vendor', 'rs-sdk');
}

export function practiceDir(): string {
    const dir = join(repoRoot, '.practice');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    return dir;
}
