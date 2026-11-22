import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as npcTravelFacade from '../src/npc-travel';
import * as shortcutsFacade from '../src/shortcuts';
import * as teleportsFacade from '../src/teleports';

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
        const candidateRe = /(?:shortcuts|npc-travel|teleports)[/\\]/;
        cachedRepoImports = [];
        for (const rel of allModules) {
            const abs = join(repoRoot, rel);
            const src = readFileSync(abs, 'utf8');
            if (!candidateRe.test(src)) continue;
            const info = ts.preProcessFile(src, true, true);
            cachedRepoImports.push({ rel, abs, specs: info.importedFiles.map(i => i.fileName) });
        }
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
                if (spec.includes(`knowledge/src/${subDirStem}/`)) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
}

function assertLayerOrder(subDirRel: string, rank: Record<string, number>) {
    const files = walkTs(join(repoRoot, subDirRel));
    expect(files.map(f => f.slice(subDirRel.length + 1)).sort()).toEqual(Object.keys(rank).sort());
    const graph = relativeDeps(files);
    const upward: string[] = [];
    for (const [from, deps] of graph) {
        const fromName = from.slice(subDirRel.length + 1);
        for (const dep of deps) {
            if (!dep.startsWith(`${subDirRel}/`)) continue;
            const depName = dep.slice(subDirRel.length + 1);
            if ((rank[depName] ?? 99) >= (rank[fromName] ?? -1)) {
                upward.push(`${fromName} -> ${depName}`);
            }
        }
    }
    expect(upward).toEqual([]);
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('shortcuts, npc-travel, and teleports split into acyclic submodules behind clean facades with zero back-imports', () => {
    assertFacadeAndSubmodules('packages/knowledge/src/shortcuts.ts', 'packages/knowledge/src/shortcuts', 5);
    assertFacadeAndSubmodules('packages/knowledge/src/npc-travel.ts', 'packages/knowledge/src/npc-travel', 5);
    assertFacadeAndSubmodules('packages/knowledge/src/teleports.ts', 'packages/knowledge/src/teleports', 5);
}, 30_000);

test('submodule dependency layers strictly separate types, static tables, lookups, and builders', () => {
    assertLayerOrder('packages/knowledge/src/shortcuts', {
        'types.ts': 0,
        'tables.ts': 1,
        'parser.ts': 2,
        'assumptions.ts': 2,
        'interpreter.ts': 3,
        'build.ts': 4,
    });
    assertLayerOrder('packages/knowledge/src/npc-travel', {
        'types.ts': 0,
        'files.ts': 0,
        'lookup.ts': 1,
        'specs-sea.ts': 2,
        'specs-world.ts': 2,
        'specs.ts': 3,
        'build.ts': 4,
    });
    assertLayerOrder('packages/knowledge/src/teleports', {
        'types.ts': 0,
        'tables.ts': 1,
        'lookup.ts': 2,
        'spells-items.ts': 3,
        'world-builders.ts': 3,
        'build.ts': 4,
    });
});

test('packages/knowledge/src stays leaf-only with zero SCCs and CLI entrypoints stay solely on facades', () => {
    const knowledgeFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src'));
    expect(findSccs(relativeDeps(knowledgeFiles))).toEqual([]);

    const disallowedSpecs = ['@rsbot/core', '@rsbot/planner', '@rsbot/practice', '@rsbot/router', '@rsbot/dashboard'];
    const subdirs = [
        'packages/knowledge/src/shortcuts',
        'packages/knowledge/src/npc-travel',
        'packages/knowledge/src/teleports',
    ];
    const violations: string[] = [];
    for (const dir of subdirs) {
        for (const rel of walkTs(join(repoRoot, dir))) {
            const abs = join(repoRoot, rel);
            const src = readFileSync(abs, 'utf8');
            if (src.includes('import.meta.main')) violations.push(`${rel}: unexpected import.meta.main`);
            const info = ts.preProcessFile(src, true, true);
            for (const imp of info.importedFiles) {
                const spec = imp.fileName;
                if (spec.startsWith('node:')) continue;
                if (!spec.startsWith('.')) {
                    if (disallowedSpecs.some(b => spec === b || spec.startsWith(`${b}/`))) violations.push(`${rel} -> ${spec}`);
                    continue;
                }
                const target = resolveImportTarget(abs, spec);
                if (!target.startsWith('packages/knowledge/')) violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);

    for (const facade of [
        'packages/knowledge/src/shortcuts.ts',
        'packages/knowledge/src/npc-travel.ts',
        'packages/knowledge/src/teleports.ts',
    ]) {
        expect(readFileSync(join(repoRoot, facade), 'utf8')).toContain('import.meta.main');
    }
    // teleports.ts relies on SCRIPT_DESCRIPTIONS in scripts/script-descriptions.ts; a leading comment would break script-index.test.ts.
    expect(readFileSync(join(repoRoot, 'packages/knowledge/src/teleports.ts'), 'utf8').trimStart().startsWith('import ')).toBe(true);
});

test('facades preserve every public runtime export and keep internal helpers private', () => {
    expect(Object.keys(shortcutsFacade).sort()).toEqual([
        'buildShortcuts',
        'loadInput',
        'movingScripts',
        'parseCoord',
        'parseScripts',
        'stripComments',
    ]);
    expect(Object.keys(npcTravelFacade).sort()).toEqual([
        'SPECS',
        'buildNpcTravel',
        'find',
        'parseCoord',
    ]);
    expect(Object.keys(teleportsFacade).sort()).toEqual([
        'buildTeleports',
    ]);
});
