import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

function walkTs(dir: string, skipDirs: readonly string[] = []): string[] {
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

test('packages/router/src production modules have zero circular dependencies', () => {
    const routerFiles = walkTs(join(repoRoot, 'packages', 'router', 'src'));
    expect(routerFiles.length).toBeGreaterThanOrEqual(35);
    expect(tarjanSccs(routerFiles)).toEqual([]);
});

function collectRouterImports(files: readonly string[]): {
    bare: Array<{ rel: string; spec: string }>;
    relative: Array<{ rel: string; target: string }>;
} {
    const bare: Array<{ rel: string; spec: string }> = [];
    const relativeTargets: Array<{ rel: string; target: string }> = [];
    for (const rel of files) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                bare.push({ rel, spec });
                continue;
            }
            relativeTargets.push({ rel, target: resolveImportTarget(abs, spec) });
        }
    }
    return { bare, relative: relativeTargets };
}

test('packages/router/src production modules never import promoted shared libraries from scripts', () => {
    const routerFiles = walkTs(join(repoRoot, 'packages', 'router', 'src'));
    const bannedTargets = new Set([
        'scripts/fleet-trade-settlement.ts',
        'scripts/fail-loops.ts',
        'scripts/fleet-owner-claim.ts',
        'scripts/heavy-admission.ts',
        'scripts/worktree-setup.ts',
    ]);
    const bannedBare = new Set(
        [...bannedTargets].flatMap(target => [target.slice(0, -3), target]),
    );
    const { bare, relative: relativeTargets } = collectRouterImports(routerFiles);
    const violations = [
        ...bare.filter(({ spec }) => bannedBare.has(spec)).map(({ rel, spec }) => `${rel} -> ${spec}`),
        ...relativeTargets.filter(({ target }) => bannedTargets.has(target)).map(({ rel, target }) => `${rel} -> ${target}`),
    ];
    expect(violations).toEqual([]);
});

test('packages/router/src production modules only import explicitly allowlisted scripts targets', () => {
    const routerFiles = walkTs(join(repoRoot, 'packages', 'router', 'src'));
    const allowedRouterScriptImports = new Set([
        'scripts/autopilot.ts',
        'scripts/cloud-recover.ts',
        'scripts/fleet.ts',
        'scripts/haggis-gate.ts',
        'scripts/provision-readiness.ts',
        'scripts/ranged-train.ts',
        'scripts/swarm.ts',
        'scripts/train-prayer.ts',
    ]);
    const { bare, relative: relativeTargets } = collectRouterImports(routerFiles);
    const violations: string[] = [];
    const observedTargets = new Set<string>();

    for (const { rel, spec } of bare) {
        if (spec === 'scripts' || spec.startsWith('scripts/')) {
            violations.push(`${rel} -> ${spec}`);
        }
    }
    for (const { rel, target } of relativeTargets) {
        if (target !== 'scripts' && !target.startsWith('scripts/')) continue;
        observedTargets.add(target);
        if (!allowedRouterScriptImports.has(target)) {
            violations.push(`${rel} -> ${target}`);
        }
    }

    expect(violations).toEqual([]);
    expect([...observedTargets].sort()).toEqual([...allowedRouterScriptImports].sort());
});
