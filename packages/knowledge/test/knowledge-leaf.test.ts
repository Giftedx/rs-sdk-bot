import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const knowledgeSrc = join(repoRoot, 'packages', 'knowledge', 'src');

function tsSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) tsSourceFiles(full, out);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
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

test('packages/knowledge/src production modules import only within packages/knowledge', () => {
    const violations: string[] = [];
    for (const file of tsSourceFiles(knowledgeSrc)) {
        const fromRel = relative(repoRoot, file).replace(/\\/g, '/');
        const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('@rsbot/')) {
                violations.push(`${fromRel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = relative(repoRoot, resolve(dirname(file), spec)).replace(/\\/g, '/');
            if (!target.startsWith('packages/knowledge/')) {
                violations.push(`${fromRel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});

test('Tarjan SCC detector catches direct, indirect, and self cycles while accepting DAGs', () => {
    const cycle2 = new Map([
        ['a.ts', ['b.ts']],
        ['b.ts', ['a.ts']],
        ['c.ts', ['a.ts']],
    ]);
    expect(findSccs(cycle2)).toEqual([['a.ts', 'b.ts']]);

    const cycle3 = new Map([
        ['a.ts', ['b.ts']],
        ['b.ts', ['c.ts']],
        ['c.ts', ['a.ts']],
    ]);
    expect(findSccs(cycle3)).toEqual([['a.ts', 'b.ts', 'c.ts']]);

    const selfLoop = new Map([
        ['a.ts', ['a.ts']],
        ['b.ts', []],
    ]);
    expect(findSccs(selfLoop)).toEqual([['a.ts']]);

    const dag = new Map([
        ['a.ts', ['b.ts', 'c.ts']],
        ['b.ts', ['c.ts']],
        ['c.ts', []],
    ]);
    expect(findSccs(dag)).toEqual([]);
});

test('packages/knowledge/src production modules have zero circular dependencies', () => {
    const knowledgeFiles = tsSourceFiles(knowledgeSrc).map(f => relative(repoRoot, f).replaceAll('\\', '/'));
    expect(knowledgeFiles.length).toBeGreaterThanOrEqual(25);
    expect(tarjanSccs(knowledgeFiles)).toEqual([]);
});
