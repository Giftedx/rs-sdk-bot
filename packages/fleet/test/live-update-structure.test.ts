import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as fleetLiveUpdate from '../src/live-update';

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
            if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) sccs.push(comp);
        }
    }

    for (const v of graph.keys()) if (!index.has(v)) strong(v);
    return sccs;
}

test('packages/fleet/src has zero router, dashboard, coordinator, or @rsbot imports and stays acyclic', () => {
    const fleetFiles = walkTs(join(repoRoot, 'packages', 'fleet', 'src'), false);
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'fleet', 'src', 'live-update'), false);

    expect(fleetFiles.length).toBeGreaterThanOrEqual(6);
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const graph = new Map<string, string[]>();
    const badImports: string[] = [];

    for (const rel of fleetFiles) {
        const abs = join(repoRoot, rel);
        const text = readFileSync(abs, 'utf8');
        const info = ts.preProcessFile(text, true, true);
        const deps: string[] = [];

        for (const imp of info.importedFiles) {
            if (imp.fileName.startsWith('@rsbot/')) {
                badImports.push(`${rel}: forbidden workspace import ${imp.fileName}`);
            }
            if (!imp.fileName.startsWith('.')) continue;
            const resolved = resolveImportTarget(abs, imp.fileName);
            if (resolved.startsWith('packages/router/') || resolved.startsWith('packages/dashboard/')) {
                badImports.push(`${rel}: forbidden upward import ${resolved}`);
            }
            if (resolved.startsWith('packages/fleet/src/')) deps.push(resolved);
        }

        if (rel.startsWith('packages/fleet/src/live-update/') && /\bimport\.meta\.main\b/.test(text)) {
            badImports.push(`${rel}: live-update submodule must not carry import.meta.main`);
        }

        graph.set(rel, deps);
    }

    expect(badImports).toEqual([]);
    expect(findSccs(graph)).toEqual([]);

    // Watchdog has no coordinator CLI or coordinator restart dependency.
    const watchdogText = readFileSync(join(repoRoot, 'packages', 'fleet', 'src', 'watchdog.ts'), 'utf8');
    expect(watchdogText).not.toContain('coordinator-cli');
    expect(watchdogText).not.toContain('coordinator.ts');

    // Facade keeps stable exports.
    expect(typeof fleetLiveUpdate.planUpdate).toBe('function');
    expect(typeof fleetLiveUpdate.applyUpdate).toBe('function');
});
