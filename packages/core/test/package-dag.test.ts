import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const PACKAGE_NAMES = [
    'knowledge',
    'core',
    'planner',
    'workers',
    'brain',
    'fleet',
    'practice',
    'dashboard',
] as const;
type PackageName = (typeof PACKAGE_NAMES)[number];

/**
 * Strict downward package DAG: lower architectural layers must never depend on
 * upper orchestration/execution layers (`brain`, `fleet`, `practice`, `dashboard`).
 */
const ALLOWED_PACKAGE_IMPORTS: Readonly<Record<PackageName, readonly PackageName[]>> = {
    knowledge: [],
    core: ['knowledge'],
    planner: ['knowledge', 'core'],
    workers: ['knowledge', 'core', 'planner'],
    brain: ['knowledge', 'core', 'planner', 'workers'],
    fleet: ['knowledge', 'core', 'workers', 'brain'],
    practice: ['knowledge', 'core', 'planner', 'workers'],
    dashboard: ['knowledge', 'core', 'planner', 'workers', 'brain'],
};

const LOWER_LAYERS: ReadonlySet<PackageName> = new Set(['knowledge', 'core', 'planner', 'workers']);
const UPPER_LAYERS: ReadonlySet<PackageName> = new Set(['brain', 'fleet', 'practice', 'dashboard']);

function walkProductionTs(rootDir: string, out: string[] = []): string[] {
    if (!existsSync(rootDir)) return out;
    for (const entry of readdirSync(rootDir).sort()) {
        if (entry === 'node_modules' || entry === 'vendor' || entry.startsWith('.')) continue;
        const full = resolve(rootDir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (entry === 'test' || entry === '__tests__') continue;
            walkProductionTs(full, out);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
            out.push(relative(REPO_ROOT, full).replace(/\\/g, '/'));
        }
    }
    return out;
}

function resolveImportCandidates(fromRel: string, spec: string): string[] {
    const abs = resolve(dirname(resolve(REPO_ROOT, fromRel)), spec);
    const candidates = [
        `${abs}.ts`,
        `${abs}.tsx`,
        resolve(abs, 'index.ts'),
        resolve(abs, 'index.tsx'),
        abs,
    ];
    return candidates.map((c) => relative(REPO_ROOT, c).replace(/\\/g, '/'));
}

function resolveExistingImportTarget(fromRel: string, spec: string): string {
    const candidates = resolveImportCandidates(fromRel, spec);
    for (const rel of candidates) {
        if (existsSync(resolve(REPO_ROOT, rel))) return rel;
    }
    return candidates[0]!;
}

function packageOfPath(relPath: string): PackageName | null {
    const m = /^packages\/([^/]+)\//.exec(relPath);
    if (!m) return null;
    return (PACKAGE_NAMES as readonly string[]).includes(m[1]!) ? (m[1] as PackageName) : null;
}

export function extractTypeScriptImports(sourceText: string): readonly string[] {
    const info = ts.preProcessFile(sourceText, true, true);
    return info.importedFiles.map((imp) => imp.fileName);
}

/** Tarjan strongly connected components: detects direct cycles and multi-node SCCs. */
export function tarjanSccs(nodes: readonly string[], adj: ReadonlyMap<string, readonly string[]>): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let nextIndex = 0;

    function visit(v: string): void {
        index.set(v, nextIndex);
        low.set(v, nextIndex);
        nextIndex += 1;
        stack.push(v);
        onStack.add(v);

        for (const w of adj.get(v) ?? []) {
            if (!adj.has(w) && !index.has(w)) continue;
            if (!index.has(w)) {
                visit(w);
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
            if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) {
                sccs.push(comp.sort());
            }
        }
    }

    for (const node of [...nodes].sort()) {
        if (!index.has(node)) visit(node);
    }
    return sccs;
}

interface RepoImportGraph {
    readonly files: readonly string[];
    readonly adj: ReadonlyMap<string, readonly string[]>;
    readonly rawEdges: readonly { readonly from: string; readonly spec: string; readonly resolved: string | null }[];
}

function buildImportGraph(roots: readonly string[]): RepoImportGraph {
    const files: string[] = [];
    for (const root of roots) {
        walkProductionTs(resolve(REPO_ROOT, root), files);
    }
    const uniqueFiles = [...new Set(files)].sort();
    const fileSet = new Set(uniqueFiles);
    const adj = new Map<string, string[]>();
    const rawEdges: { from: string; spec: string; resolved: string | null }[] = [];

    for (const rel of uniqueFiles) {
        const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
        const specs = extractTypeScriptImports(src);
        const deps: string[] = [];
        for (const spec of specs) {
            if (!spec.startsWith('.')) {
                rawEdges.push({ from: rel, spec, resolved: null });
                continue;
            }
            const target = resolveExistingImportTarget(rel, spec);
            rawEdges.push({ from: rel, spec, resolved: target });
            if (fileSet.has(target)) deps.push(target);
        }
        adj.set(rel, [...new Set(deps)]);
    }

    return { files: uniqueFiles, adj, rawEdges };
}

export function auditCrossLayerViolations(
    edges: readonly { readonly from: string; readonly spec: string; readonly resolved: string | null }[],
): {
    workspaceImports: string[];
    toolsRuntimeImports: string[];
    packageLayerViolations: string[];
    packageGraphSccs: string[][];
} {
    const workspaceImports: string[] = [];
    const toolsRuntimeImports: string[] = [];
    const packageLayerViolations: string[] = [];
    const pkgEdges = new Map<string, Set<string>>(PACKAGE_NAMES.map((p) => [p, new Set<string>()]));

    for (const edge of edges) {
        if (edge.spec.startsWith('@rsbot/')) {
            workspaceImports.push(`${edge.from} -> ${edge.spec}`);
            continue;
        }
        if (!edge.resolved) continue;

        const isRuntimeFile = edge.from.startsWith('packages/') || edge.from.startsWith('scripts/');
        if (isRuntimeFile && edge.resolved.startsWith('tools/')) {
            toolsRuntimeImports.push(`${edge.from} -> ${edge.resolved}`);
        }

        const fromPkg = packageOfPath(edge.from);
        const toPkg = packageOfPath(edge.resolved);
        if (fromPkg && toPkg && fromPkg !== toPkg) {
            pkgEdges.get(fromPkg)!.add(toPkg);
            const allowed = ALLOWED_PACKAGE_IMPORTS[fromPkg];
            if (!allowed.includes(toPkg)) {
                packageLayerViolations.push(`${fromPkg} (${edge.from}) -> ${toPkg} (${edge.resolved})`);
            }
            if (LOWER_LAYERS.has(fromPkg) && UPPER_LAYERS.has(toPkg)) {
                packageLayerViolations.push(`reverse layer edge ${fromPkg} -> ${toPkg}: ${edge.from} -> ${edge.resolved}`);
            }
        }
    }

    const pkgAdj = new Map<string, readonly string[]>(
        [...pkgEdges.entries()].map(([k, v]) => [k, [...v]]),
    );
    const packageGraphSccs = tarjanSccs([...PACKAGE_NAMES], pkgAdj);

    return {
        workspaceImports,
        toolsRuntimeImports,
        packageLayerViolations: [...new Set(packageLayerViolations)],
        packageGraphSccs,
    };
}

describe('CI package dependency DAG & runtime boundary enforcement', () => {
    test('Tarjan SCC detector and layer auditor catch cycles, reverse edges, tools/ imports, and @rsbot/*', () => {
        const acyclic = new Map<string, readonly string[]>([
            ['a', ['b']],
            ['b', ['c']],
            ['c', []],
        ]);
        expect(tarjanSccs(['a', 'b', 'c'], acyclic)).toEqual([]);

        const cyclic = new Map<string, readonly string[]>([
            ['a', ['b']],
            ['b', ['c']],
            ['c', ['a']],
        ]);
        expect(tarjanSccs(['a', 'b', 'c'], cyclic)).toEqual([['a', 'b', 'c']]);

        const audit = auditCrossLayerViolations([
            { from: 'packages/core/src/x.ts', spec: '@rsbot/knowledge', resolved: null },
            { from: 'packages/core/src/x.ts', spec: '../../brain/src/contracts', resolved: 'packages/brain/src/contracts.ts' },
            { from: 'scripts/aio-skiller.ts', spec: '../tools/now', resolved: 'tools/now.ts' },
        ]);
        expect(audit.workspaceImports).toEqual(['packages/core/src/x.ts -> @rsbot/knowledge']);
        expect(audit.toolsRuntimeImports).toEqual(['scripts/aio-skiller.ts -> tools/now.ts']);
        expect(audit.packageLayerViolations.some((v) => v.includes('core') && v.includes('brain'))).toBe(true);
    });

    const graph = buildImportGraph(['packages', 'scripts', 'tools']);

    test('zero @rsbot/* workspace imports exist in packages/, scripts/, or tools/', () => {
        const audit = auditCrossLayerViolations(graph.rawEdges);
        expect(audit.workspaceImports).toEqual([]);
    });

    test('runtime code in packages/ and scripts/ never imports tools/', () => {
        const audit = auditCrossLayerViolations(graph.rawEdges);
        expect(audit.toolsRuntimeImports).toEqual([]);
    });

    test('packages/* strictly follow the downward acyclic package DAG with zero reverse edges', () => {
        const audit = auditCrossLayerViolations(graph.rawEdges);
        expect(audit.packageGraphSccs).toEqual([]);
        expect(audit.packageLayerViolations).toEqual([]);
        expect(existsSync(resolve(REPO_ROOT, 'packages', 'router'))).toBe(false);
        const routerRefs = graph.rawEdges.filter(
            (e) => e.spec.includes('@rsbot/router') || e.resolved?.startsWith('packages/router/'),
        );
        expect(routerRefs).toEqual([]);
    });

    test('zero circular module dependencies across all production TypeScript files in packages/, tools/, and scripts/', () => {
        const packageGraph = buildImportGraph(['packages']);
        expect(tarjanSccs(packageGraph.files, packageGraph.adj)).toEqual([]);

        const toolsGraph = buildImportGraph(['tools']);
        expect(tarjanSccs(toolsGraph.files, toolsGraph.adj)).toEqual([]);

        const scriptsGraph = buildImportGraph(['scripts']);
        expect(tarjanSccs(scriptsGraph.files, scriptsGraph.adj)).toEqual([]);

        expect(tarjanSccs(graph.files, graph.adj)).toEqual([]);
    });
});
