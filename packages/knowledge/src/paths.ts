import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

export function contentRoot(): string {
    return join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
}

export function knowledgeDir(): string {
    return join(repoRoot, 'knowledge');
}
