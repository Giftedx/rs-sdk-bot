import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

function walkTs(dir: string, skipDirs: readonly string[] = [], filter = (_rel: string) => true): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (skipDirs.includes(entry.name)) continue;
            const full = join(d, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
                const rel = relative(repoRoot, full).replace(/\\/g, '/');
                if (filter(rel)) out.push(rel);
            }
        }
    };
    visit(dir);
    return out.sort();
}

function relativeTarget(fromAbs: string, spec: string): string {
    const target = relative(repoRoot, resolve(dirname(fromAbs), spec)).replace(/\\/g, '/');
    if (target.endsWith('.ts')) return target;
    return existsSync(join(repoRoot, `${target}.ts`)) ? `${target}.ts` : `${target}/index.ts`;
}

function relativeDeps(files: readonly string[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const rel of files) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        const deps: string[] = [];
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            deps.push(relativeTarget(abs, imp.fileName));
        }
        graph.set(rel, deps);
    }
    return graph;
}

function tarjanSccs(files: readonly string[]): string[][] {
    const graph = relativeDeps(files);
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
            if (comp.length > 1) sccs.push(comp.sort());
        }
    }

    for (const v of graph.keys()) if (!index.has(v)) strong(v);
    return sccs;
}

test('packages/planner/src production modules have zero circular dependencies', () => {
    const plannerFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src'));
    expect(plannerFiles.length).toBeGreaterThan(0);
    expect(tarjanSccs(plannerFiles)).toEqual([]);
});

test('packages/planner/src/autopilot submodules never import the autopilot facade', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'autopilot'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            const target = relativeTarget(abs, imp.fileName);
            if (target === 'packages/planner/src/autopilot.ts') violations.push(`${rel} -> ${target}`);
        }
    }
    expect(violations).toEqual([]);
    expect(tarjanSccs(submoduleFiles)).toEqual([]);
});
