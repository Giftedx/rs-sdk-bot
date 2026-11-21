import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

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

let cachedRepoImports: { rel: string; abs: string; specs: string[] }[] | undefined;
function repoImports() {
    if (!cachedRepoImports) {
        const allModules = [
            ...walkTs(join(repoRoot, 'packages'), true),
            ...walkTs(join(repoRoot, 'scripts'), true),
        ];
        cachedRepoImports = allModules.map(rel => {
            const abs = join(repoRoot, rel);
            const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
            return { rel, abs, specs: info.importedFiles.map(i => i.fileName) };
        });
    }
    return cachedRepoImports;
}

function assertFacadeAndSubmodules(facade: string, subDirRel: string, minSubmodules: number) {
    const subDirPrefix = `${subDirRel}/`;
    const submoduleFiles = walkTs(join(repoRoot, subDirRel));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(minSubmodules);

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

    const subDirStem = subDirRel.split('/').pop()!;
    const directSubmoduleImports: string[] = [];
    for (const { rel, abs, specs } of repoImports()) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        for (const spec of specs) {
            if (!spec.startsWith('.')) {
                if (spec.includes(`${subDirStem}/`)) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
}

test('Tarjan SCC detector catches direct, indirect, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('coordinator-cli splits into >= 3 acyclic submodules behind a facade with zero back-imports or direct external imports', () => {
    assertFacadeAndSubmodules('packages/router/src/coordinator-cli.ts', 'packages/router/src/coordinator-cli', 3);
});

test('coverage splits into >= 3 acyclic submodules behind a facade with zero back-imports or direct external imports', () => {
    assertFacadeAndSubmodules('packages/router/src/coverage.ts', 'packages/router/src/coverage', 3);
});

test('coverage submodules never import from packages/dashboard, packages/practice, packages/planner, or scripts', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'coverage'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    const bannedRoots = ['packages/dashboard/', 'packages/practice/', 'packages/planner/', 'scripts/'];
    const bannedSpecs = ['@rsbot/dashboard', '@rsbot/practice', '@rsbot/planner'];
    const violations: string[] = [];

    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (bannedSpecs.some(b => spec === b || spec.startsWith(`${b}/`))) {
                violations.push(`${rel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (bannedRoots.some(r => target.startsWith(r))) violations.push(`${rel} -> ${target}`);
        }
    }
    expect(violations).toEqual([]);
});

test('coordinator-cli submodules never import from packages/dashboard or promoted script libraries', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'coordinator-cli'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    const bannedTargets = new Set(['scripts/fleet-trade-settlement.ts', 'scripts/fail-loops.ts']);
    const violations: string[] = [];

    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec === '@rsbot/dashboard' || spec.startsWith('@rsbot/dashboard/')) {
                violations.push(`${rel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith('packages/dashboard/') || bannedTargets.has(target)) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});
