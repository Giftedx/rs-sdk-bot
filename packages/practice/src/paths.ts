import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { practiceRoot, simBotsDir, simLogsDir, simRoot } from '../../core/src/practice-paths';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

export function rsSdkRoot(): string {
    return join(repoRoot, 'vendor', 'rs-sdk');
}

export function deliveryLockDir(): string {
    const dir = practiceRoot(repoRoot);
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function practiceBotsRoot(): string {
    return simBotsDir(repoRoot);
}

export function practiceDir(): string {
    const dir = simRoot(repoRoot);
    mkdirSync(simLogsDir(repoRoot), { recursive: true });
    return dir;
}
