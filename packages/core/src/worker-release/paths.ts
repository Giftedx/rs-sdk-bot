// Shared release roots, lazy TypeScript loader, and repository-relative path helpers.
import { statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type TS from 'typescript';

export const root = resolve(import.meta.dir, '../../../..');
// The TypeScript parser loads on its first use: about 100 MB of working set in each bot and supervisor process. A
// release that the disk cache answers never parses a file, so most processes never load it.
let tsLoaded: typeof TS | undefined;
export const ts = new Proxy({} as typeof TS, {
    get: (_, key) => (tsLoaded ??= require('typescript') as typeof TS)[key as keyof typeof TS],
});
// One fleet revision includes helpers and both host/single launch paths, not
// just the entry script. Credentials, mutable receipts and notes are excluded.
export const workerSourceRoots = ['scripts', 'packages', 'vendor/rs-sdk/sdk', 'vendor/rs-sdk/server/webclient/src', 'vendor/rs-sdk/server/vendor/rsmod-pathfinder'];
// These packages do not execute workers. A runtime import into them must be
// included deliberately instead of silently escaping the release fingerprint.
export const toolingRoots = ['packages/dashboard'];

// A release covers the files one process can run, not the whole tree (docs/script-contract.md, Release scope):
// its entries and every file they reach through relative imports or through string literals that name a file or
// folder under releaseDataRoots, plus the runtime trees and root files every worker runs on.
export const runtimeTrees = ['vendor/rs-sdk/sdk', 'vendor/rs-sdk/server/webclient/src', 'vendor/rs-sdk/server/vendor/rsmod-pathfinder'];
export const releaseRootFiles = ['package.json', 'bun.lock', 'tsconfig.json'];
export const releaseDataRoots = ['knowledge', 'scripts', 'packages'];
// The processes that start a swarm worker; supervise-host.ts names packages/core/src/host.ts.
export const workerLaunchers = ['packages/practice/src/supervise.ts', 'packages/practice/src/supervise-host.ts'];
// The controller and the recovery runner it starts (RECOVERY_SCRIPT in session-recovery-permit.ts).
export const launchEntries = ['scripts/swarm.ts', ...workerLaunchers, 'packages/core/src/session-recovery.ts'];
export const codeFile = /\.(?:ts|tsx|js|mjs|cjs)$/;
export const releaseFile = /\.(?:ts|tsx|js|mjs|cjs|json|wasm)$/;
export const skipped = new Set(['node_modules', '.git', '.practice']);
// These modules name files only to hash them and refuse changed bytes themselves, so their literals add nothing:
// the worker-release modules name release inputs; launch-evidence.ts binds the main launch to its own source fingerprint.
export const hashOnly = new Set([
    'packages/core/src/worker-release.ts',
    'packages/core/src/worker-release/paths.ts',
    'packages/core/src/worker-release/source-scan.ts',
    'packages/core/src/worker-release/closure.ts',
    'packages/core/src/worker-release/revision.ts',
    'packages/core/src/worker-release/peers.ts',
    'packages/core/src/launch-evidence.ts',
]);
// One call's file reads and parses; a check of several peers shares it. Never kept between calls.
export type ReleaseMemo = Map<string, unknown>;

export const posix = (p: string) => p.replaceAll('\\', '/');
export function repoPath(base: string, abs: string): string | undefined {
    const p = posix(relative(resolve(base), abs));
    return !p || p === '..' || p.startsWith('../') || /^[a-zA-Z]:/.test(p) || p.split('/').some(s => skipped.has(s)) ? undefined : p;
}
export function kind(base: string, p: string): 'file' | 'dir' | undefined {
    try { const s = statSync(join(base, p)); return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : undefined; } catch { return undefined; }
}
export function importedPath(base: string, file: string, spec: string): string {
    return relative(resolve(base), resolve(base, dirname(file), spec)).replaceAll('\\', '/');
}
