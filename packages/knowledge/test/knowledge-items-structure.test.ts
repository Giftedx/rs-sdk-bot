import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as itemSourcesFacade from '../src/item-sources';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.practice', 'generated-assets', '_unpack', 'client-assets']);
const FACADE = 'packages/knowledge/src/item-sources.ts';
const SUBDIR_PREFIX = 'packages/knowledge/src/item-sources/';

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

function declaredExports(rel: string): string[] {
    const sf = ts.createSourceFile(rel, readFileSync(join(repoRoot, rel), 'utf8'), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    for (const st of sf.statements) {
        const hasExport = (ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
            for (const el of st.exportClause.elements) out.push(el.name.text);
            continue;
        }
        if (!hasExport) continue;
        if (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
            if (st.name) out.push(st.name.text);
        } else if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
        }
    }
    return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('item-sources splits into >= 3 acyclic submodules behind a clean facade with zero back-imports', () => {
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src', 'item-sources'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const graph = relativeDeps([FACADE, ...submoduleFiles]);
    const backImports: string[] = [];
    for (const rel of submoduleFiles) {
        for (const target of graph.get(rel) ?? []) {
            if (target === FACADE) backImports.push(`${rel} -> ${target}`);
        }
    }
    expect(backImports).toEqual([]);

    const facadeImports = graph.get(FACADE) ?? [];
    expect(facadeImports.length).toBeGreaterThan(0);
    expect(facadeImports.every(target => target.startsWith(SUBDIR_PREFIX))).toBe(true);

    expect(findSccs(graph)).toEqual([]);
    expect(findSccs(relativeDeps(walkTs(join(repoRoot, 'packages', 'knowledge', 'src'))))).toEqual([]);
});

test('external callers import item-sources only through its facade', () => {
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === FACADE || rel.startsWith(SUBDIR_PREFIX)) continue;
        const abs = join(repoRoot, rel);
        const source = readFileSync(abs, 'utf8');
        if (!source.includes('item-sources')) continue;
        const info = ts.preProcessFile(source, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('item-sources/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(SUBDIR_PREFIX)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
}, 20000);

test('item-sources submodules stay within packages/knowledge, respect strict layers, and keep import.meta.main on facade', () => {
    const LAYER: Record<string, number> = {
        'model.ts': 0,
        'stock-adapter.ts': 1,
        'recipes.ts': 1,
        'report.ts': 1,
        'lookup.ts': 2,
        'drops.ts': 3,
        'build.ts': 4,
        'cli.ts': 5,
    };
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src', 'item-sources'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const name = rel.slice(SUBDIR_PREFIX.length);
        const layer = LAYER[name];
        if (layer === undefined) {
            violations.push(`unregistered submodule layer: ${rel}`);
            continue;
        }
        const abs = join(repoRoot, rel);
        const src = readFileSync(abs, 'utf8');
        if (src.split(/\r?\n/).length > 250) {
            violations.push(`submodule exceeds 250 lines: ${rel}`);
        }
        if (stripComments(src).includes('import.meta.main')) {
            violations.push(`import.meta.main in submodule: ${rel}`);
        }
        const info = ts.preProcessFile(src, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:')) continue;
            if (!spec.startsWith('.')) {
                violations.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (!target.startsWith('packages/knowledge/src/')) {
                violations.push(`${rel} -> ${target}`);
                continue;
            }
            if (target.startsWith(SUBDIR_PREFIX)) {
                const targetLayer = LAYER[target.slice(SUBDIR_PREFIX.length)];
                if (targetLayer === undefined || targetLayer >= layer) {
                    violations.push(`layer violation: ${rel} (L${layer}) -> ${target} (L${String(targetLayer)})`);
                }
            }
        }
    }
    expect(violations).toEqual([]);
    expect(stripComments(readFileSync(join(repoRoot, FACADE), 'utf8'))).toContain('import.meta.main');
});

test('item-sources facade preserves all external/test exports, hides internals, and resolves default research paths', () => {
    const expectedRuntime = [
        'buildItemSources',
        'counts',
        'defaultMarket',
        'gapsMarkdown',
        'ownedStockFromRows',
        'readMarket',
        'serializeItemSources',
        'shopUnitPrice',
        'sourceTiles',
    ];
    expect(Object.keys(itemSourcesFacade).sort()).toEqual(expectedRuntime);

    const expectedTypes = [
        'ActionSource',
        'Basis',
        'Cost',
        'DropSource',
        'GatherSource',
        'GeSource',
        'ItemSources',
        'MakeSource',
        'Market',
        'MarketQuoteInput',
        'Options',
        'OwnedAccountStock',
        'OwnedSource',
        'OwnedStatusRow',
        'OwnedStock',
        'PickupSource',
        'Place',
        'SharedMarketParser',
        'ShopSource',
        'Source',
        'Substitute',
        'Tile',
    ];
    const facadeExports = new Set(declaredExports(FACADE));
    expect([...facadeExports].sort()).toEqual([...expectedRuntime, ...expectedTypes].sort());

    for (const internal of [
        'OwnedItemRow', 'Base', 'Rung', 'ToolRec', 'SourceCatalog',
        'loadSourceCatalog', 'buildDropSources', 'geSource', 'ownedSource',
        'runItemSourcesCli', 'reasons', 'cost', 'r3', 'oldest', 'inWilderness', 'blocksOf', 'repoRoot',
    ]) {
        expect(facadeExports.has(internal)).toBe(false);
    }

    expect(itemSourcesFacade.shopUnitPrice(100, 1000, 10, 40, 50)).toBe(110);
    expect(itemSourcesFacade.counts([])).toEqual({ items: 0, withSource: 0, noSource: 0, onlyBlocked: 0, byKind: {} });

    const dir = mkdtempSync(join(tmpdir(), 'item-sources-struct-'));
    try {
        const market = itemSourcesFacade.defaultMarket(dir);
        expect(market).not.toBeNull();
        expect(market!.file).toMatch(/^research\/market-.*\.json$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
