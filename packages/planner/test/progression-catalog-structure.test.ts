import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as progressionCatalog from '../src/progression-catalog';

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
                out.push(relative(repoRoot, full).replace(/\\/g, '/'));
            }
        }
    };
    visit(dir);
    return out.sort();
}

function resolveImportTarget(fromAbs: string, spec: string): string {
    const target = relative(repoRoot, resolve(dirname(fromAbs), spec)).replace(/\\/g, '/');
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

test('progression-catalog splits into >= 3 acyclic submodules behind a facade with zero back-imports or direct external imports', () => {
    const facade = 'packages/planner/src/progression-catalog.ts';
    const subDirPrefix = 'packages/planner/src/progression-catalog/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'progression-catalog'));
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

    // Enforce facade-only ./progression-catalog/* imports across all packages/ and scripts/.
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('progression-catalog/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
});

test('progression-catalog submodules only import allowed layers (planner, core, knowledge, or node:*)', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'progression-catalog'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    const allowedRoots = ['packages/planner/src/', 'packages/core/src/', 'packages/knowledge/src/'];
    const allowedSpecs = ['@rsbot/planner', '@rsbot/core', '@rsbot/knowledge'];
    const violations: string[] = [];

    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:')) continue;
            if (!spec.startsWith('.')) {
                if (!allowedSpecs.some(a => spec === a || spec.startsWith(`${a}/`)) && !allowedRoots.some(r => spec.startsWith(r))) {
                    violations.push(`${rel} -> ${spec}`);
                }
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (!allowedRoots.some(r => target.startsWith(r))) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});

test('progression-catalog facade preserves all runtime exports and default root catalog loading', () => {
    expect(Object.keys(progressionCatalog).sort()).toEqual([
        'PROGRESSION_SKILLS',
        'accountFromStatus',
        'catalogCoverage',
        'intentForEntry',
        'loadProgressionCatalog',
        'matchingProgressionRoutes',
        'progressionMethods',
        'progressionStep',
    ]);
    expect(Array.isArray(progressionCatalog.PROGRESSION_SKILLS)).toBe(true);
    expect(progressionCatalog.PROGRESSION_SKILLS).toHaveLength(19);
    expect(typeof progressionCatalog.loadProgressionCatalog).toBe('function');
    expect(typeof progressionCatalog.accountFromStatus).toBe('function');
    expect(typeof progressionCatalog.matchingProgressionRoutes).toBe('function');
    expect(typeof progressionCatalog.intentForEntry).toBe('function');
    expect(typeof progressionCatalog.progressionStep).toBe('function');
    expect(typeof progressionCatalog.progressionMethods).toBe('function');
    expect(typeof progressionCatalog.catalogCoverage).toBe('function');

    const catalog = progressionCatalog.loadProgressionCatalog();
    expect(catalog.version).toBe(1);
    expect(catalog.routes.length).toBeGreaterThan(0);
    expect(progressionCatalog.catalogCoverage(catalog).routes).toBe(catalog.routes.length);
});
