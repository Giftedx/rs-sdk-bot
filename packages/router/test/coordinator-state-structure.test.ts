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

const GROUPS = ['coordinator', 'coordinator-planner'] as const;

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('coordinator and coordinator-planner split into >= 3 acyclic submodules behind clean facades with zero back-imports', () => {
    for (const group of GROUPS) {
        const facade = `packages/router/src/${group}.ts`;
        const subDirRel = `packages/router/src/${group}`;
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

test('coordinator and coordinator-planner submodules preserve layer boundaries and packages/router/src has zero SCCs', () => {
    const coordFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'coordinator'));
    expect(coordFiles.length).toBeGreaterThanOrEqual(3);
    const coordBannedRoots = [
        'packages/router/src/coordinator-planner',
        'packages/router/src/coordinator-live',
        'packages/router/src/coordinator-cli',
        'packages/dashboard/',
        'packages/practice/',
        'packages/planner/',
        'scripts/',
    ];
    const coordBannedSpecs = ['@rsbot/dashboard', '@rsbot/practice', '@rsbot/planner'];
    const coordViolations: string[] = [];
    for (const rel of coordFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (coordBannedSpecs.some(b => spec === b || spec.startsWith(`${b}/`))) {
                coordViolations.push(`${rel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (coordBannedRoots.some(r => target === `${r}.ts` || target.startsWith(r))) {
                coordViolations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(coordViolations).toEqual([]);

    const plannerFiles = walkTs(join(repoRoot, 'packages', 'router', 'src', 'coordinator-planner'));
    expect(plannerFiles.length).toBeGreaterThanOrEqual(3);
    const plannerBannedTargets = new Set([
        'scripts/fleet-trade-settlement.ts',
        'scripts/fail-loops.ts',
        'scripts/fleet-owner-claim.ts',
        'scripts/heavy-admission.ts',
    ]);
    const plannerViolations: string[] = [];
    for (const rel of plannerFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec === '@rsbot/dashboard' || spec.startsWith('@rsbot/dashboard/')) {
                plannerViolations.push(`${rel} -> ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (
                target.startsWith('packages/dashboard/')
                || target === 'packages/router/src/coordinator-cli.ts'
                || target.startsWith('packages/router/src/coordinator-cli/')
                || plannerBannedTargets.has(target)
            ) {
                plannerViolations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(plannerViolations).toEqual([]);

    const routerFiles = walkTs(join(repoRoot, 'packages', 'router', 'src'));
    expect(findSccs(relativeDeps(routerFiles))).toEqual([]);
});

test('facades preserve every external and test export while keeping internal-only helpers private inside submodules', () => {
    const coordExports = new Set(declaredExports('packages/router/src/coordinator.ts'));
    for (const name of [
        'boundAccounts', 'GOALS', 'GoalId', 'Effect', 'CoordTask', 'Receipt', 'TaskRecord',
        'usefulLiveReceipt', 'CapabilityChange', 'CoordinatorState', 'fleetExpansion', 'replaceTasks',
        'orderOnlyDependency', 'coveredQualification', 'dependencyMet', 'needsFreshQualification',
        'recoverySlotBusy', 'qualificationDemand', 'qualificationRefreshCapabilities',
        'refreshQualifications', 'buildWorkOrder', 'initialState', 'provisionRefs',
        'NEW_EVIDENCE_MAX', 'validateTask', 'addTasks', 'preparedNativeDelivery',
        'FOCUS_FAILURE_LIMIT', 'failedBuildStreak', 'BUILD_HOLD_MS', 'repeatedBuildFault',
        'heldBuilds', 'activeBuildFocus', 'deadRoots', 'preparedProvisionRuns',
        'preparedProvisionClaims', 'chooseTask', 'ARCHIVE_AFTER_MS', 'finishedAt',
        'compactState', 'startTask', 'finishTask', 'boundedWorkerEndMessage', 'acceptStatus',
    ]) {
        expect(coordExports.has(name)).toBe(true);
    }
    for (const internal of [
        'aliveQualification', 'lastBuildOutcome', 'buildHeld', 'buildOverlap', 'deferredReviewTask',
        'TASK_ID', 'exclusive', 'finishedBuilds', 'qualificationGroup', 'unsettled',
        'qualificationTimedOut', 'replaceableQualification', 'LiveStatusContext', 'matchesLiveStatus',
    ]) {
        expect(coordExports.has(internal)).toBe(false);
    }

    const plannerExports = new Set(declaredExports('packages/router/src/coordinator-planner.ts'));
    for (const name of [
        'parseModelObject', 'GAME_SKILLS', 'gameCoverage', 'queueFacts', 'briefEnded',
        'briefSpec', 'repairModelTask', 'readPlannerControllerCapacity', 'readPlannerStatuses',
        'readRecoveryProblems', 'readWorld', 'supplyBillSummary', 'assetSummary',
        'scoreboardSummary', 'fleetLeads', 'plannerStatusSummary', 'plannerPrompt',
        'prepareProposal', 'acceptProposal', 'SubscriptionModelDeps', 'runSubscriptionModel',
        'runPlannerModel', 'planWork',
    ]) {
        expect(plannerExports.has(name)).toBe(true);
    }
    for (const internal of [
        'FLEET_BAND', 'clip', 'receiptOutputReason', 'receiptBuildEvidence', 'recentStockStatus',
    ]) {
        expect(plannerExports.has(internal)).toBe(false);
    }
});
