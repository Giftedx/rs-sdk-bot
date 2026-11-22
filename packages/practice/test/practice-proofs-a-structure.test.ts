import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

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

const GROUPS = ['agility-order-proof', 'fresh-rune-supply-proof'] as const;

const AGILITY_EXPORTS = [
    'sources', 'trainedLevel', 'agilityFixturePreset', 'agilityInitializationChecks', 'agilitySaveDifferences',
    'strongholdGateCrossed', 'femiGateVarp', 'agilitySaveChecks', 'interruptionDeadlineMs', 'interruptionSaveChecks',
    'fallRecoveryCheck', 'NATIVE_DEADLINE_MS', 'FALL_SAMPLE_PLAN', 'NATIVE_FORMAT', 'INITIALIZATION_CONFIGURATION',
    'fallSampleAdmitted', 'fallSampleChecks', 'zeroFallObserved', 'FallOutcome', 'fallSampleOutcome', 'FallSample',
    'sampleFalls', 'FallFiles', 'initializationEvidenceChecks', 'verifyFallSamples', 'readFallSamples',
    'savedCoursePosition', 'childChecks', 'retainedApproachChecks', 'DRAYNOR_START', 'draynorEntryChecks',
    'FOOD_RECOVERY_CONFIGURATION', 'GNOME_FOOD_RESTART_CONFIGURATION', 'foodRecoveryChecks',
    'INFLIGHT_FOOD_CONFIGURATION', 'settlementEvidence', 'inflightFoodChecks', 'inflightFoodOutcome',
    'verifyInflightFood', 'verifyFoodRecovery', 'verificationReport', 'verify', 'GNOME_SCOPE', 'GNOME_FRESH_MS',
    'GNOME_STEPS', 'gnomeScope', 'sharedSettlementChecks', 'gnomeFoodChecks', 'ARDOUGNE_ENTRY_CONFIGURATION',
    'healSequence', 'ardougneEntryChecks', 'GNOME_FOOD_PLAN', 'GNOME_FOOD_CONFIGURATION', 'ARDOUGNE_PLAN',
    'ARDOUGNE_CONFIGURATION', 'GNOME_CONSUMER_PLAN', 'GNOME_CONSUMER_CONFIGURATION', 'verifyGnomeFood',
    'verifyArdougneEntry', 'restartInitialProjection', 'restartChainChecks', 'gnomeConsumerCaseChecks',
    'verifyGnomeConsumer', 'verifyDraynorEvidence', 'verifyRetainedApproachEvidence', 'verifyGnome',
] as const;

const AGILITY_INTERNALS = [
    'repoRoot', 'owned', 'foodIds', 'musicVarps', 'cases', 'refusalCases', 'CHILD_TIMEOUT_MS', 'SAVE_WAIT_MS',
    'items', 'lastLine', 'progressXp', 'sha256', 'traceLines', 'foodLines', 'actionLines', 'integer',
    'samplesValid', 'sampleValue', 'readInflightSample', 'foodBinding', 'initializationBinding', 'savedLogoutOf',
    'singleIdentity', 'readCase', 'caseEvidence', 'modeEvidence', 'publishedReport', 'readJson', 'missing',
    'restartHashes', 'gnomeCheckpoint', 'restartBinding', 'child', 'caseHashes', 'run',
] as const;

const FRESH_RUNE_EXPORTS = [
    'freshRuneChildTimeout', 'PORT_WAIT_MS', 'PORT_STEP_MS', 'waitForProofPorts', 'FreshRuneStackDeps',
    'withFreshRuneStack', 'freshRuneDefaultSkills', 'freshRuneSupportedInterruption', 'freshRuneSupplyChecks',
    'freshRuneCookingDiagnosticInput', 'freshRuneCookingDiagnosticChecks', 'freshRuneEssenceDiagnosticInput',
    'freshRuneEssenceDiagnosticChecks', 'diagnoseFreshRuneEssence', 'diagnoseFreshRuneCooking',
    'airRecoveryPositions', 'freshRuneRecoveryContentsEqual', 'freshRuneAirRecoveryChecks', 'POSTCRAFT_XP',
    'freshRunePostCraftChecks', 'verifyFreshRuneAirRecovery', 'proveFreshRuneAirRecovery', 'freshRuneStages',
    'FreshRuneStage', 'freshRuneStageInput', 'freshRunePublishedStages', 'freshRuneStageWorker',
    'freshRuneSavedResult', 'proveFreshRuneStage', 'verifyFreshRuneSupply', 'proveFreshRuneSupply',
] as const;

const FRESH_RUNE_INTERNALS = [
    'repoRoot', 'workMs', 'checkpoints', 'sum', 'assets', 'summary', 'logout', 'retainedProgress',
    'hash', 'sources', 'stageFile', 'json', 'same', 'readRun', 'engineSave', 'freshRuneServerHash',
    'freshRuneBinding', 'freshRuneCommand', 'freshRuneRecoveryClock', 'stagedChecks', 'stageDeps',
] as const;

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('agility-order-proof and fresh-rune-supply-proof split into >= 3 acyclic submodules behind clean facades with zero back-imports', () => {
    for (const group of GROUPS) {
        const facade = `packages/practice/src/${group}.ts`;
        const subDirRel = `packages/practice/src/${group}`;
        const subDirPrefix = `${subDirRel}/`;
        const submoduleFiles = walkTs(join(repoRoot, subDirRel));
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

        const directSubmoduleImports: string[] = [];
        for (const { rel, abs, specs } of repoImports()) {
            if (rel === facade || rel.startsWith(subDirPrefix)) continue;
            for (const spec of specs) {
                if (!spec.startsWith('.')) {
                    if (spec.includes(`${group}/`)) directSubmoduleImports.push(`${rel} -> ${spec}`);
                    continue;
                }
                const target = resolveImportTarget(abs, spec);
                if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
            }
        }
        expect(directSubmoduleImports).toEqual([]);
    }
});

test('proof submodules preserve layer boundaries, keep CLI entrypoints on facades, and packages/practice/src has zero SCCs', () => {
    const bannedRoots = ['packages/dashboard/', 'packages/router/', 'packages/planner/'];
    const bannedSpecs = ['@rsbot/dashboard', '@rsbot/router', '@rsbot/planner'];
    const bannedTargets = new Set(['scripts/measure/fleet-player-save.ts', 'scripts/fleet-trade-settlement.ts']);
    const launcherTargets = new Set([
        'packages/practice/src/stack.ts',
        'packages/practice/src/bots.ts',
        'packages/practice/src/prove.ts',
        'packages/practice/src/presets.ts',
        'packages/core/src/proc.ts',
    ]);
    const pureVerifyStems = new Set(['contracts.ts', 'checks.ts', 'save-checks.ts', 'food-checks.ts', 'verify.ts']);
    const violations: string[] = [];
    const misplacedMain: string[] = [];

    for (const group of GROUPS) {
        const facadeText = readFileSync(join(repoRoot, 'packages', 'practice', 'src', `${group}.ts`), 'utf8');
        expect(facadeText).toContain('import.meta.main');

        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'practice', 'src', group));
        expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
        for (const rel of submoduleFiles) {
            const abs = join(repoRoot, rel);
            const text = readFileSync(abs, 'utf8');
            if (text.includes('import.meta.main')) misplacedMain.push(rel);
            const info = ts.preProcessFile(text, true, true);
            for (const imp of info.importedFiles) {
                const spec = imp.fileName;
                if (bannedSpecs.some(b => spec === b || spec.startsWith(`${b}/`)) || bannedTargets.has(spec.replace(/\.ts$/, '') + '.ts')) {
                    violations.push(`${rel} -> ${spec}`);
                    continue;
                }
                if (!spec.startsWith('.')) continue;
                const target = resolveImportTarget(abs, spec);
                if (bannedRoots.some(r => target.startsWith(r)) || bannedTargets.has(target)) {
                    violations.push(`${rel} -> ${target}`);
                }
            }
            const fileName = rel.split('/').pop()!;
            if (pureVerifyStems.has(fileName)) {
                const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
                for (const st of sf.statements) {
                    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
                    const clause = st.importClause;
                    const typeOnly = Boolean(clause?.isTypeOnly)
                        || (!clause?.name && !!clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
                            && clause.namedBindings.elements.every(el => el.isTypeOnly));
                    if (typeOnly) continue;
                    const spec = st.moduleSpecifier.text;
                    if (!spec.startsWith('.')) continue;
                    const target = resolveImportTarget(abs, spec);
                    if (launcherTargets.has(target)) {
                        violations.push(`${rel} runtime-imports ${target}`);
                    }
                }
            }
        }
    }
    expect(misplacedMain).toEqual([]);
    expect(violations).toEqual([]);

    const practiceFiles = walkTs(join(repoRoot, 'packages', 'practice', 'src'));
    expect(findSccs(relativeDeps(practiceFiles))).toEqual([]);
});

test('facades preserve exact export parity while keeping purely internal helpers private inside submodules', async () => {
    const agilityDeclared = declaredExports('packages/practice/src/agility-order-proof.ts');
    expect([...new Set(agilityDeclared)].sort()).toEqual([...AGILITY_EXPORTS].sort());
    for (const internal of AGILITY_INTERNALS) {
        expect(agilityDeclared).not.toContain(internal);
    }

    const freshRuneDeclared = declaredExports('packages/practice/src/fresh-rune-supply-proof.ts');
    expect([...new Set(freshRuneDeclared)].sort()).toEqual([...FRESH_RUNE_EXPORTS].sort());
    for (const internal of FRESH_RUNE_INTERNALS) {
        expect(freshRuneDeclared).not.toContain(internal);
    }

    const agilityMod = await import('../src/agility-order-proof');
    const agilityTypes = new Set(['FallOutcome', 'FallSample', 'FallFiles']);
    expect(Object.keys(agilityMod).sort()).toEqual(AGILITY_EXPORTS.filter(n => !agilityTypes.has(n)).sort());
    expect(typeof agilityMod.sources).toBe('function');
    expect(agilityMod.sources().files['packages/practice/src/agility-order-proof.ts']).toMatch(/^[0-9a-f]{64}$/);

    const freshRuneMod = await import('../src/fresh-rune-supply-proof');
    const freshRuneTypes = new Set(['FreshRuneStackDeps', 'FreshRuneStage']);
    expect(Object.keys(freshRuneMod).sort()).toEqual(FRESH_RUNE_EXPORTS.filter(n => !freshRuneTypes.has(n)).sort());
    expect(typeof freshRuneMod.verifyFreshRuneSupply).toBe('function');
});
