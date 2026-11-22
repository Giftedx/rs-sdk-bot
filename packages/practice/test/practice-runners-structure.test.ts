import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as presetsFacade from '../src/presets';
import { DRAGON_PRESETS } from '../src/presets-dragon';
import { FILLER_PRESETS } from '../src/presets-filler';
import { GANG_PRESETS } from '../src/presets-gang';
import { LEGENDS_PRESETS } from '../src/presets-legends';
import { LONG_PRESETS } from '../src/presets-long';
import { MEDIUM_PRESETS } from '../src/presets-medium';
import { MM_PRESETS } from '../src/presets-mm';
import { PARTNER_PRESETS } from '../src/presets-partner';
import { PATH_PRESETS } from '../src/presets-path';
import { REST_PRESETS } from '../src/presets-rest';
import { SHORT_PRESETS } from '../src/presets-short';
import * as rehearseFacade from '../src/rehearse';

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

function assertFacadeAndSubmodules(
    facade: string,
    subDirRel: string,
    minSubmodules: number,
    extraCycleCheckFiles: readonly string[] = [],
) {
    const subDirPrefix = `${subDirRel}/`;
    const submoduleFiles = walkTs(join(repoRoot, subDirRel));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(minSubmodules);

    const graph = relativeDeps([facade, ...submoduleFiles, ...extraCycleCheckFiles]);
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
                if (spec.includes(`practice/src/${subDirStem}/`)) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('rehearse splits into >= 4 acyclic submodules behind a facade with zero back-imports or direct external imports', () => {
    assertFacadeAndSubmodules('packages/practice/src/rehearse.ts', 'packages/practice/src/rehearse', 4);
});

test('presets splits into >= 5 acyclic submodules behind a facade with zero back-imports, direct external imports, or preset cycles', () => {
    const presetFiles = walkTs(join(repoRoot, 'packages', 'practice', 'src')).filter(
        rel => /^packages\/practice\/src\/preset(?:s.*|-types)\.ts$/.test(rel),
    );
    assertFacadeAndSubmodules('packages/practice/src/presets.ts', 'packages/practice/src/presets', 5, presetFiles);
});

test('rehearse and presets submodules obey layer boundaries and never import presets back into rehearse or upward into router/dashboard/scripts', () => {
    const practiceFiles = walkTs(join(repoRoot, 'packages', 'practice', 'src'));
    expect(findSccs(relativeDeps(practiceFiles))).toEqual([]);

    const rehearseSubs = walkTs(join(repoRoot, 'packages', 'practice', 'src', 'rehearse'));
    const presetsSubs = walkTs(join(repoRoot, 'packages', 'practice', 'src', 'presets'));
    expect(rehearseSubs.length).toBeGreaterThanOrEqual(4);
    expect(presetsSubs.length).toBeGreaterThanOrEqual(5);

    const disallowedPrefixes = ['packages/router/', 'packages/dashboard/', 'scripts/'];
    const disallowedSpecs = ['@rsbot/router', '@rsbot/dashboard'];
    const violations: string[] = [];

    for (const rel of [...rehearseSubs, ...presetsSubs]) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:') || spec === 'bun' || spec.startsWith('bun:')) continue;
            if (!spec.startsWith('.')) {
                if (disallowedSpecs.some(b => spec === b || spec.startsWith(`${b}/`))) {
                    violations.push(`${rel} -> ${spec}`);
                }
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (disallowedPrefixes.some(p => target.startsWith(p))) {
                violations.push(`${rel} -> ${target}`);
            }
            if (rel.startsWith('packages/practice/src/presets/') && (target === 'packages/practice/src/rehearse.ts' || target.startsWith('packages/practice/src/rehearse/'))) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
});

test('rehearse facade preserves every public export, keeps internals private, and resolves save-endpoint preload cleanly', () => {
    expect(Object.keys(rehearseFacade).sort()).toEqual([
        'ISOLATED',
        'ISOLATED_ENGINE_ENV',
        'SUPPLIER_ONLINE_TIMEOUT_MS',
        'TickWindow',
        'checkExpect',
        'checkSpecialistSegment',
        'findSegment',
        'isolatedStackOptions',
        'itemCount',
        'pointBotAt',
        'rehearsalChildEnv',
        'rehearse',
        'rehearseLockstep',
        'resolveSegmentSuppliers',
        'startIsolatedStack',
        'stopHelperProcs',
        'waitForSuppliersOnline',
    ]);

    const preloadModule = rehearseFacade.isolatedStackOptions().enginePreload?.module;
    expect(preloadModule).toBe(resolve(repoRoot, 'packages/practice/src/save-endpoint.ts'));
    expect(existsSync(preloadModule!)).toBe(true);
});

test('presets facade preserves every public export and aggregates all presets-* groups', () => {
    expect(Object.keys(presetsFacade).sort()).toEqual([
        'PRESETS',
        'applyPreset',
        'preparePresetDirectory',
    ]);

    const groups = [
        MM_PRESETS,
        DRAGON_PRESETS,
        SHORT_PRESETS,
        GANG_PRESETS,
        MEDIUM_PRESETS,
        PARTNER_PRESETS,
        FILLER_PRESETS,
        PATH_PRESETS,
        REST_PRESETS,
        LONG_PRESETS,
        LEGENDS_PRESETS,
    ];
    for (const group of groups) {
        for (const key of Object.keys(group)) {
            expect(presetsFacade.PRESETS[key]).toEqual(group[key]);
        }
    }
    for (const coreKey of ['fresh_lumbridge', 'wc_lumbridge', 'measure_trees', 'floor_herblore', 'combat_wk_40', 'agility_gnome_1', 'quest_waterfall']) {
        expect(presetsFacade.PRESETS[coreKey]).toBeDefined();
    }
});
