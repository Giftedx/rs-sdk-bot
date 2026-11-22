import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as methodModelFacade from '../src/method-model';
import * as skillToolsFacade from '../src/skill-tools';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.practice', 'generated-assets', '_unpack', 'client-assets']);

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

const GROUPS = ['skill-tools', 'method-model'] as const;

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('skill-tools and method-model each split into >= 3 acyclic submodules behind a clean facade', () => {
    for (const group of GROUPS) {
        const facade = `packages/knowledge/src/${group}.ts`;
        const subDirPrefix = `packages/knowledge/src/${group}/`;
        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src', group));
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
    }
});

test('external callers import skill-tools and method-model only through their facades', () => {
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        const abs = join(repoRoot, rel);
        const source = readFileSync(abs, 'utf8');
        if (!GROUPS.some(g => source.includes(g))) continue;
        const info = ts.preProcessFile(source, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            for (const group of GROUPS) {
                const facade = `packages/knowledge/src/${group}.ts`;
                const subDirPrefix = `packages/knowledge/src/${group}/`;
                if (rel === facade || rel.startsWith(subDirPrefix)) continue;
                if (!spec.startsWith('.')) {
                    if (spec.startsWith(subDirPrefix) || spec.startsWith(`@rsbot/knowledge/${group}/`) || spec.startsWith(`@rsbot/knowledge/src/${group}/`)) {
                        directSubmoduleImports.push(`${rel} -> ${spec}`);
                    }
                } else {
                    const target = resolveImportTarget(abs, spec);
                    if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
                }
            }
        }
    }
    expect(directSubmoduleImports).toEqual([]);
}, 20_000);

test('submodules stay leaf-bounded inside packages/knowledge, skill-tools keeps import.meta.main on the facade, and packages/knowledge/src stays acyclic', () => {
    const violations: string[] = [];
    for (const group of GROUPS) {
        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src', group));
        expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
        for (const rel of submoduleFiles) {
            const abs = join(repoRoot, rel);
            const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
            for (const imp of info.importedFiles) {
                const spec = imp.fileName;
                if (spec.startsWith('@rsbot/')) {
                    violations.push(`${rel} -> ${spec}`);
                    continue;
                }
                if (!spec.startsWith('.')) continue;
                const target = resolveImportTarget(abs, spec);
                if (!target.startsWith('packages/knowledge/')) {
                    violations.push(`${rel} -> ${target}`);
                }
            }
        }
    }
    expect(violations).toEqual([]);

    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const skillToolsSrc = readFileSync(join(repoRoot, 'packages/knowledge/src/skill-tools.ts'), 'utf8');
    expect(stripComments(skillToolsSrc)).toContain('import.meta.main');
    for (const rel of walkTs(join(repoRoot, 'packages', 'knowledge', 'src', 'skill-tools'))) {
        expect(stripComments(readFileSync(join(repoRoot, rel), 'utf8'))).not.toContain('import.meta.main');
    }

    const knowledgeFiles = walkTs(join(repoRoot, 'packages', 'knowledge', 'src'));
    expect(findSccs(relativeDeps(knowledgeFiles))).toEqual([]);
}, 20_000);

test('facades preserve every external/test export and keep internal-only helpers private inside submodules', () => {
    const skillToolsExports = new Set(declaredExports('packages/knowledge/src/skill-tools.ts'));
    const expectedSkillToolsRuntime = ['lines', 'cite', 'buildAxes', 'buildPickaxes', 'buildFishing', 'buildSkillTools'];
    const expectedSkillToolsTypes = ['Hold', 'Cite', 'ItemNeed', 'Consume', 'LocNeed', 'Condition', 'AppliesTo', 'ToolRecord', 'AxeRow', 'PickaxeRow'];
    expect(skillToolsExports.size).toBe(expectedSkillToolsRuntime.length + expectedSkillToolsTypes.length);
    for (const name of [...expectedSkillToolsRuntime, ...expectedSkillToolsTypes]) {
        expect(skillToolsExports.has(name)).toBe(true);
    }
    for (const internal of [
        'Rung', 'ObjBlock', 'Spec', 'SPECS', 'fromSpec', 'configBlocks', 'walk', 'itemId', 'loadRungs',
        'applies', 'emptyRecord', 'wieldAttack', 'grindRecords', 'scanRecord', 'skillToolsJsonPath', 'WC_SCRIPT', 'PICK_CHECK',
    ]) {
        expect(skillToolsExports.has(internal)).toBe(false);
    }
    expect(Object.keys(skillToolsFacade).sort()).toEqual([...expectedSkillToolsRuntime].sort());

    const methodModelExports = new Set(declaredExports('packages/knowledge/src/method-model.ts'));
    const expectedMethodModelRuntime = [
        'XP_RATE', 'XP_RATE_SRC', 'ACTIONS_PER_TICK', 'ACTIONS_PER_TICK_SRC', 'STAT_RANDOM_SRC', 'P_DELAY_SRC', 'WEAKQUEUE_SRC',
        'statRandomChance', 'pDelayTicks', 'loadContent', 'param', 'prop', 'block', 'findAll', 'find',
        'ticksPerSuccess', 'modelXpPerTickAt', 'bestRoll', 'modelBands', 'coordTile', 'MODEL_FILES', 'modelRung',
    ];
    const expectedMethodModelTypes = ['Roll', 'Timing', 'Facts', 'Content', 'Hit', 'Band', 'Row', 'ModelInput'];
    expect(methodModelExports.size).toBe(expectedMethodModelRuntime.length + expectedMethodModelTypes.length);
    for (const name of [...expectedMethodModelRuntime, ...expectedMethodModelTypes]) {
        expect(methodModelExports.has(name)).toBe(true);
    }
    for (const internal of [
        'facts', 'doneFacts', 'tenths', 'rowCol', 'rowColSrc', 'rowItems',
        'pDelayTiming', 'instantTiming', 'queueLoopTiming', 'withRolls', 'struct',
        'STRUCT_ALIASES', 'structFor', 'structFacts', 'fishFacts', 'magicFacts',
        'COMBAT_XP', 'targetFacts', 'COURSE_RUNGS', 'gatheringFacts', 'productionFacts', 'activityFacts',
    ]) {
        expect(methodModelExports.has(internal)).toBe(false);
    }
    expect(Object.keys(methodModelFacade).sort()).toEqual([...expectedMethodModelRuntime].sort());
});

test('skill-tools facade matches knowledge/skill-tools.json output identically', () => {
    const disk = readFileSync(join(repoRoot, 'knowledge', 'skill-tools.json'), 'utf8');
    const fresh = JSON.stringify(skillToolsFacade.buildSkillTools(), null, 1) + '\n';
    expect(fresh).toBe(disk);
}, 20_000);
