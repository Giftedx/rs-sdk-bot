import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..');

function walkTs(dir: string, skipDirs: readonly string[] = []): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (skipDirs.includes(entry.name)) continue;
            const full = join(d, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
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

function tarjanSccs(files: readonly string[]): string[][] {
    return findSccs(relativeDeps(files));
}

test('Tarjan SCC detector catches direct, indirect, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['a.ts', ['a.ts']], ['b.ts', []]]))).toEqual([['a.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts', 'c.ts']], ['b.ts', ['c.ts']], ['c.ts', []]]))).toEqual([]);
});

test('packages/dashboard production modules never import from scripts/', () => {
    const dashboardFiles = walkTs(join(repoRoot, 'packages', 'dashboard'), ['tools', 'node_modules', 'client-assets']);
    expect(dashboardFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const rel of dashboardFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec === 'scripts' || spec.startsWith('scripts/')) violations.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target === 'scripts' || target.startsWith('scripts/')) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});

test('packages/dashboard production modules have zero circular dependencies', () => {
    const dashboardFiles = walkTs(join(repoRoot, 'packages', 'dashboard'), ['tools', 'node_modules', 'client-assets']);
    expect(dashboardFiles.length).toBeGreaterThan(0);
    expect(tarjanSccs(dashboardFiles)).toEqual([]);
});

test('packages/dashboard/server submodules have >= 3 modules with zero back-imports to server.ts', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'dashboard', 'server'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            const target = resolveImportTarget(abs, imp.fileName);
            if (target === 'packages/dashboard/server.ts') violations.push(`${rel} -> ${target}`);
        }
    }
    expect(violations).toEqual([]);
    expect(tarjanSccs(submoduleFiles)).toEqual([]);
});
