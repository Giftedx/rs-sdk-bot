import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as liveUpdateFacade from '../src/live-update';
import type { Dirty, LiveRun, LiveRunsOptions, RebasedFiles, UpdateInput, UpdatePlan } from '../src/live-update';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.practice', 'generated-assets']);

function walkTs(dir: string, includeTests = false): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(d, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (
                entry.name.endsWith('.ts')
                && !entry.name.endsWith('.d.ts')
                && (includeTests || !entry.name.endsWith('.test.ts'))
            ) {
                out.push(relative(repoRoot, full).replaceAll('\\', '/'));
            }
        }
    };
    visit(dir);
    return out.sort();
}

function resolveImportTarget(fromAbs: string, spec: string): string {
    const target = relative(repoRoot, resolve(dirname(fromAbs), spec)).replaceAll('\\', '/');
    if (target.endsWith('.ts')) return target;
    if (existsSync(join(repoRoot, `${target}.ts`))) return `${target}.ts`;
    if (existsSync(join(repoRoot, target, 'index.ts'))) return `${target}/index.ts`;
    return `${target}.ts`;
}

function relativeDeps(files: readonly string[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const rel of files) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        const deps: string[] = [];
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            deps.push(resolveImportTarget(abs, imp.fileName));
        }
        graph.set(rel, deps);
    }
    return graph;
}

function findSccs(graph: ReadonlyMap<string, readonly string[]>): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let idx = 0;

    function strong(v: string) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) ?? []) {
            if (!graph.has(w)) continue;
            if (!index.has(w)) {
                strong(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) === index.get(v)) {
            const comp: string[] = [];
            while (true) {
                const w = stack.pop()!;
                onStack.delete(w);
                comp.push(w);
                if (w === v) break;
            }
            if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) {
                sccs.push(comp.sort());
            }
        }
    }

    for (const v of graph.keys()) if (!index.has(v)) strong(v);
    return sccs.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('live-update splits into >= 3 acyclic submodules behind a clean facade with zero back-imports or direct external imports', () => {
    const facade = 'packages/router/src/live-update.ts';
    const subDirPrefix = 'packages/router/src/live-update/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'live-update'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const graph = relativeDeps([facade, ...submoduleFiles]);
    const backImports: string[] = [];
    for (const rel of submoduleFiles) {
        for (const target of graph.get(rel) ?? []) {
            if (target === facade) backImports.push(`${rel} -> ${target}`);
        }
    }
    expect(backImports).toEqual([]);

    const facadeImports = graph.get(facade) ?? [];
    expect(facadeImports.length).toBeGreaterThan(0);
    expect(facadeImports.every(target => target.startsWith(subDirPrefix))).toBe(true);

    expect(findSccs(graph)).toEqual([]);

    // Enforce facade-only ./live-update/* imports across packages/ and scripts/.
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        const source = readFileSync(abs, 'utf8');
        if (!source.includes('live-update')) continue;
        const info = ts.preProcessFile(source, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('live-update/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
});

test('live-update keeps import.meta.main only on the facade and submodules import only allowed targets', () => {
    const facade = 'packages/router/src/live-update.ts';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'live-update'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    expect(stripComments(readFileSync(join(repoRoot, facade), 'utf8'))).toContain('import.meta.main');
    const subMains = submoduleFiles.filter(rel => stripComments(readFileSync(join(repoRoot, rel), 'utf8')).includes('import.meta.main'));
    expect(subMains).toEqual([]);

    const allowedTargets = (target: string) =>
        target.startsWith('packages/router/src/')
        || target.startsWith('packages/core/src/')
        || target === 'scripts/worktree-setup.ts';

    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:')) continue;
            if (!spec.startsWith('.')) {
                violations.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (!allowedTargets(target)) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});

test('live-update facade preserves all expected runtime and type exports', () => {
    const _typeCheck: [Dirty?, LiveRun?, LiveRunsOptions?, RebasedFiles?, UpdateInput?, UpdatePlan?] = [];
    expect(_typeCheck).toEqual([]);
    expect(Object.keys(liveUpdateFacade).sort()).toEqual([
        'DAEMONS',
        'LIVE_ROW_MS',
        'LIVE_SERVER',
        'REBASED_FILE',
        'SDK',
        'SDK_PATCH',
        'TRADE_ENTRY',
        'TRADE_HOLD_MS',
        'addedPreloads',
        'applyUpdate',
        'coordinatorHolds',
        'gitIn',
        'liveRuns',
        'mergeText',
        'mergedDeliveryCopies',
        'parseStatus',
        'patchChangedFiles',
        'patchCollisions',
        'patchSections',
        'planUpdate',
        'preloadOnlyChange',
        'qualificationSource',
        'readCheckout',
        'readRebased',
        'rebasableDeliveryEdits',
        'releaseClosure',
        'reloadsFor',
        'resetVendor',
        'vendorExact',
        'vendorReleaseFiles',
        'vendorState',
    ]);
});
