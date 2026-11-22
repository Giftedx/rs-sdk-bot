import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as sessionRecoveryProof from '../src/session-recovery-proof';
import * as questSweepProof from '../src/quest-sweep-proof';
import * as cowProgressIsolatedProof from '../src/cow-progress-isolated-proof';

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

function lineCount(rel: string): number {
    return readFileSync(join(repoRoot, rel), 'utf8').split(/\r?\n/).length;
}

let cachedModuleImports: Map<string, readonly string[]> | undefined;
function allModuleImports(): Map<string, readonly string[]> {
    if (cachedModuleImports) return cachedModuleImports;
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const map = new Map<string, readonly string[]>();
    for (const rel of allModules) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        map.set(rel, info.importedFiles.map(imp => imp.fileName));
    }
    cachedModuleImports = map;
    return map;
}

function assertSplitFacade(spec: {
    name: string;
    facade: string;
    subDir: string;
    maxFacadeLines: number;
    allowedRoots: readonly string[];
    allowedExact?: readonly string[];
}) {
    const subDirPrefix = `${spec.subDir}/`;
    const submoduleFiles = walkTs(join(repoRoot, spec.subDir));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
    expect(lineCount(spec.facade)).toBeLessThanOrEqual(spec.maxFacadeLines);

    const graph = relativeDeps([spec.facade, ...submoduleFiles]);
    const backImports: string[] = [];
    for (const rel of submoduleFiles) {
        for (const target of graph.get(rel) ?? []) {
            if (target === spec.facade) backImports.push(`${rel} -> ${target}`);
        }
    }
    expect(backImports).toEqual([]);

    const facadeImports = graph.get(spec.facade) ?? [];
    expect(facadeImports.some(target => target.startsWith(subDirPrefix))).toBe(true);
    expect(findSccs(graph)).toEqual([]);

    const facadeSource = readFileSync(join(repoRoot, spec.facade), 'utf8');
    expect(facadeSource).toContain('import.meta.main');
    for (const rel of submoduleFiles) {
        expect(readFileSync(join(repoRoot, rel), 'utf8')).not.toContain('import.meta.main');
    }

    const directSubmoduleImports: string[] = [];
    for (const [rel, specs] of allModuleImports()) {
        if (rel === spec.facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        for (const importSpec of specs) {
            if (!importSpec.startsWith('.')) {
                if (importSpec.includes(`${spec.name}/`)) directSubmoduleImports.push(`${rel} -> ${importSpec}`);
                continue;
            }
            const target = resolveImportTarget(abs, importSpec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);

    const bannedScripts = new Set(['scripts/measure/fleet-player-save.ts', 'scripts/fleet-trade-settlement.ts']);
    const layerViolations: string[] = [];
    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const importSpec = imp.fileName;
            if (importSpec.startsWith('node:') || importSpec === 'bun:sqlite') continue;
            if (!importSpec.startsWith('.')) {
                layerViolations.push(`${rel} -> ${importSpec}`);
                continue;
            }
            const target = resolveImportTarget(abs, importSpec);
            if (bannedScripts.has(target)) {
                layerViolations.push(`${rel} -> ${target}`);
                continue;
            }
            const ok = spec.allowedRoots.some(r => target.startsWith(r))
                || (spec.allowedExact?.includes(target) ?? false);
            if (!ok) layerViolations.push(`${rel} -> ${target}`);
        }
    }
    expect(layerViolations).toEqual([]);
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('session-recovery-proof splits into >= 3 acyclic submodules behind clean facade with zero back-imports', () => {
    assertSplitFacade({
        name: 'session-recovery-proof',
        facade: 'packages/practice/src/session-recovery-proof.ts',
        subDir: 'packages/practice/src/session-recovery-proof',
        maxFacadeLines: 320,
        allowedRoots: ['packages/practice/src/', 'packages/core/src/'],
        allowedExact: ['scripts/swarm.ts'],
    });
}, 20000);

test('quest-sweep-proof splits into >= 3 acyclic submodules behind clean facade with zero back-imports', () => {
    assertSplitFacade({
        name: 'quest-sweep-proof',
        facade: 'packages/practice/src/quest-sweep-proof.ts',
        subDir: 'packages/practice/src/quest-sweep-proof',
        maxFacadeLines: 120,
        allowedRoots: ['packages/practice/src/', 'packages/core/src/'],
    });
}, 20000);

test('session-recovery-proof facade preserves all 42 runtime exports', () => {
    expect(Object.keys(sessionRecoveryProof).sort()).toEqual([
        'CHECK_CASES',
        'RECOVERY_MEMORY_WAIT_MS',
        'TAKEOVER_WINDOW_MS',
        'afterStalledConnection',
        'authReplies',
        'buttonTraceFor',
        'claimStopArtifact',
        'classifyCooldownWindow',
        'deriveChecks',
        'evidenceFiles',
        'fleetHandoff',
        'installAuthObserver',
        'installButtonObserver',
        'installLocObserver',
        'latestOwnerLoginBefore',
        'loginAfterTakeoverWindow',
        'noRecoveryLogin',
        'observeAuth',
        'observePartialOwner',
        'observeRecoveryBoundary',
        'orphanRecoveryReadyAt',
        'orphanServerEnd',
        'ownerSessionEvidence',
        'publishControlFile',
        'reconcileNegativeControls',
        'reconcileSaves',
        'recoveryArtifactPresence',
        'recoveryAuthorityInputs',
        'recoveryCapability',
        'recoveryConsumptionBytes',
        'recoveryMemoryGate',
        'recoverySessionAuth',
        'releaseStopArtifact',
        'requireRecoveryRegistration',
        'retainRequiredRecoveryCase',
        'serveAnyHost',
        'stockOf',
        'verifyCompletedRecoveryDelivery',
        'waitOwnerAuthLogout',
        'waitRecoveryRuntime',
        'worldHost',
    ]);
});

test('quest-sweep-proof facade preserves all 12 external/test runtime exports and hides internal helpers', () => {
    expect(Object.keys(questSweepProof).sort()).toEqual([
        'QUEST_SWEEP_PROOF_CASE_IDS',
        'equipment',
        'questSweepChecks',
        'questSweepChildConfiguration',
        'questSweepElenaPreset',
        'questSweepProofAccountEnv',
        'questSweepProofEndpoints',
        'runQuestSweepProofCase',
        'selectFreshQuestSweepProofName',
        'selectQuestSweepProofCases',
        'selectQuestSweepProofEndpoints',
        'startQuestSweepProofStack',
    ]);
});

test('cow-progress-isolated-proof tightens exports to the 28 referenced runtime symbols and preserves import.meta.main', () => {
    expect(Object.keys(cowProgressIsolatedProof).sort()).toEqual([
        'GIANT_HITPOINTS_XP',
        'MIGHTYROD',
        'NABTHEKNOB',
        'SWORDINHAND',
        'cases',
        'claimCowStop',
        'cowChildChecks',
        'cowChildConfiguration',
        'cowEntry',
        'cowFixture',
        'cowResult',
        'cowSaveChecks',
        'cowSequenceChecks',
        'giantChildChecks',
        'giantChildConfiguration',
        'giantEntry',
        'giantFixture',
        'giantResult',
        'giantSaveChecks',
        'refusedCow',
        'retainCowStop',
        'trooperCases',
        'trooperChildChecks',
        'trooperChildConfiguration',
        'trooperEntry',
        'trooperFixture',
        'trooperSaveChecks',
        'xpForLevel',
    ]);
    const source = readFileSync(join(repoRoot, 'packages/practice/src/cow-progress-isolated-proof.ts'), 'utf8');
    expect(source).toContain('import.meta.main');
    expect(source).not.toMatch(/^export\s+(?:type\s+CowStop\b|const\s+giantCases\b|function\s+verifyCow\b)/m);
});

test('packages/practice/src has zero SCCs across all production modules', () => {
    const practiceFiles = walkTs(join(repoRoot, 'packages', 'practice', 'src'));
    expect(findSccs(relativeDeps(practiceFiles))).toEqual([]);
});
