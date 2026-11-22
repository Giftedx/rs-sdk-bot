import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.practice', 'generated-assets', 'client-assets']);

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

function exportedSymbols(rel: string): string[] {
    const abs = join(repoRoot, rel);
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    sf.forEachChild(node => {
        const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        const hasExport = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        if (hasExport) {
            if ((ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
                names.push(node.name.text);
            } else if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
                }
            }
        } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) names.push(el.name.text);
        }
    });
    return [...new Set(names)].sort();
}

function importedSymbolsFrom(targets: readonly string[], importers: readonly string[]): Map<string, Set<string>> {
    const targetSet = new Set(targets);
    const used = new Map<string, Set<string>>();
    for (const target of targets) used.set(target, new Set());
    for (const rel of importers) {
        const abs = join(repoRoot, rel);
        const text = readFileSync(abs, 'utf8');
        if (!text.includes('state') && !text.includes('config') && !text.includes('world-view')) continue;
        const info = ts.preProcessFile(text, true, true);
        const hitsTarget = info.importedFiles.some(imp => imp.fileName.startsWith('.') && targetSet.has(resolveImportTarget(abs, imp.fileName)));
        if (!hitsTarget) continue;
        const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
        sf.forEachChild(node => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
                const target = resolveImportTarget(abs, node.moduleSpecifier.text);
                const bucket = used.get(target);
                if (!bucket) return;
                const named = node.importClause?.namedBindings;
                if (named && ts.isNamedImports(named)) {
                    for (const el of named.elements) bucket.add((el.propertyName ?? el.name).text);
                }
            } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
                const target = resolveImportTarget(abs, node.moduleSpecifier.text);
                const bucket = used.get(target);
                if (!bucket) return;
                if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                    for (const el of node.exportClause.elements) bucket.add((el.propertyName ?? el.name).text);
                }
            }
        });
    }
    return used;
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('server/state splits into >= 3 acyclic submodules behind a clean facade with zero back-imports or direct external imports', () => {
    const facade = 'packages/dashboard/server/state.ts';
    const subDirPrefix = 'packages/dashboard/server/state/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'dashboard', 'server', 'state'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const graph = relativeDeps([facade, ...submoduleFiles]);
    const forbiddenBackTargets = new Set([
        facade,
        'packages/dashboard/server.ts',
        'packages/dashboard/server/routes.ts',
    ]);
    const backImports: string[] = [];
    for (const rel of submoduleFiles) {
        for (const target of graph.get(rel) ?? []) {
            if (forbiddenBackTargets.has(target)) backImports.push(`${rel} -> ${target}`);
        }
    }
    expect(backImports).toEqual([]);

    const facadeImports = graph.get(facade) ?? [];
    expect(facadeImports.length).toBeGreaterThan(0);
    expect(facadeImports.every(target => target.startsWith(subDirPrefix))).toBe(true);

    expect(findSccs(graph)).toEqual([]);
    expect(existsSync(join(repoRoot, 'packages', 'dashboard', 'server', 'state', 'index.ts'))).toBe(false);

    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        const text = readFileSync(abs, 'utf8');
        if (!text.includes('state/') && !text.includes('state\\')) continue;
        const info = ts.preProcessFile(text, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('state/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
});

test('server/state submodules follow layered boundaries and never import scripts/', () => {
    const subDirPrefix = 'packages/dashboard/server/state/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'dashboard', 'server', 'state'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const layerOf = new Map<string, number>([
        ['packages/dashboard/server/state/host.ts', 0],
        ['packages/dashboard/server/state/results.ts', 0],
        ['packages/dashboard/server/state/plans.ts', 0],
        ['packages/dashboard/server/state/statuses.ts', 1],
        ['packages/dashboard/server/state/views.ts', 2],
        ['packages/dashboard/server/state/build.ts', 3],
        ['packages/dashboard/server/state/runtime.ts', 4],
    ]);

    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const myLayer = layerOf.get(rel);
        if (myLayer === undefined) violations.push(`unlayered submodule ${rel}`);
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
                continue;
            }
            if (target.startsWith(subDirPrefix)) {
                const targetLayer = layerOf.get(target);
                if (targetLayer === undefined || (myLayer !== undefined && targetLayer >= myLayer)) {
                    violations.push(`layer violation ${rel} -> ${target}`);
                }
            }
        }
    }
    expect(violations).toEqual([]);
});

test('server/state, server/config, and world-view expose only referenced exports', () => {
    const stateFacade = 'packages/dashboard/server/state.ts';
    const configFile = 'packages/dashboard/server/config.ts';
    const worldViewFile = 'packages/dashboard/world-view.ts';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'dashboard', 'server', 'state'));
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];

    expect(exportedSymbols(stateFacade)).toEqual([
        'FIRST_STATE_MAX_AGE_MS',
        'clients',
        'current',
        'getLatest',
        'maybeScanProcs',
        'scanProcs',
        'startStateBackground',
        'viewerTimings',
    ]);

    const targets = [stateFacade, configFile, worldViewFile, ...submoduleFiles];
    const used = importedSymbolsFrom(targets, allModules);
    const unused: string[] = [];
    for (const target of targets) {
        const refSet = used.get(target) ?? new Set();
        for (const sym of exportedSymbols(target)) {
            if (!refSet.has(sym)) unused.push(`${target}:${sym}`);
        }
    }
    expect(unused).toEqual([]);
});
