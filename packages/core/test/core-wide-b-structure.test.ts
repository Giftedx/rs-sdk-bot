import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import * as dangerFacade from '../src/danger';
import * as sessionRecoveryPermitFacade from '../src/session-recovery-permit';
import * as workerReleaseFacade from '../src/worker-release';

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

const GROUPS = ['session-recovery-permit', 'worker-release', 'danger'] as const;

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('session-recovery-permit, worker-release, and danger each split into >= 3 acyclic submodules behind a clean facade', () => {
    for (const group of GROUPS) {
        const facade = `packages/core/src/${group}.ts`;
        const subDirPrefix = `packages/core/src/${group}/`;
        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'core', 'src', group));
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

test('external callers import session-recovery-permit, worker-release, and danger only through their facades', () => {
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
                const facade = `packages/core/src/${group}.ts`;
                const subDirPrefix = `packages/core/src/${group}/`;
                if (rel === facade || rel.startsWith(subDirPrefix)) continue;
                if (!spec.startsWith('.')) {
                    if (spec.startsWith(subDirPrefix) || spec.startsWith(`@rsbot/core/${group}/`) || spec.startsWith(`@rsbot/core/src/${group}/`)) {
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
});

test('submodules never import upward, worker-release keeps import.meta.main only on the facade, and packages/core/src stays acyclic', () => {
    const bannedRoots = ['packages/planner/', 'packages/practice/', 'packages/router/', 'packages/dashboard/', 'scripts/'];
    const bannedSpecs = ['@rsbot/planner', '@rsbot/practice', '@rsbot/router', '@rsbot/dashboard'];
    const violations: string[] = [];

    for (const group of GROUPS) {
        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'core', 'src', group));
        expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);
        for (const rel of submoduleFiles) {
            const abs = join(repoRoot, rel);
            const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
            for (const imp of info.importedFiles) {
                const spec = imp.fileName;
                if (bannedSpecs.some(b => spec === b || spec.startsWith(`${b}/`))) {
                    violations.push(`${rel} -> ${spec}`);
                    continue;
                }
                if (!spec.startsWith('.')) continue;
                const target = resolveImportTarget(abs, spec);
                if (bannedRoots.some(r => target.startsWith(r))) {
                    violations.push(`${rel} -> ${target}`);
                }
            }
        }
    }
    expect(violations).toEqual([]);

    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const workerReleaseSrc = readFileSync(join(repoRoot, 'packages/core/src/worker-release.ts'), 'utf8');
    expect(stripComments(workerReleaseSrc)).toContain('import.meta.main');
    expect(workerReleaseSrc.trimStart().startsWith('//') || workerReleaseSrc.trimStart().startsWith('/*')).toBe(false);
    for (const rel of walkTs(join(repoRoot, 'packages', 'core', 'src', 'worker-release'))) {
        expect(stripComments(readFileSync(join(repoRoot, rel), 'utf8'))).not.toContain('import.meta.main');
    }

    const coreFiles = walkTs(join(repoRoot, 'packages', 'core', 'src'));
    expect(findSccs(relativeDeps(coreFiles))).toEqual([]);
});

test('facades preserve every external/test export and keep internal-only helpers private inside submodules', () => {
    const permitExports = new Set(declaredExports('packages/core/src/session-recovery-permit.ts'));
    const expectedPermitRuntime = [
        'RECOVERY_SCHEMA', 'RECOVERY_BINDING_MS', 'FLEET_HEARTBEAT_MAX_MS', 'RECOVERY_SCRIPT',
        'assertNativeFixtureRoot', 'assertRecoveryNotStopped', 'validateRecoveryRequest', 'recoveryLifecycleRoot', 'recoveryPermitPaths', 'assertNoRecoveryLease',
        'NATIVE_RECOVERY_CHECKS', 'verifyNativeRecoveryProof', 'FLEET_REFUSALS', 'assertFleetResolved',
        'issueRecoveryPermit', 'bindRecoveryChild', 'waitForRecoveryChildBinding', 'consumeRecoveryPermit',
        'consumeRecoveryConnection', 'spendRecoveryConnection', 'assertSpentRecoveryConnection', 'STALE_HEARTBEAT_WAIT_MS', 'waitOutStaleHeartbeat',
        'recoveryStatePreserved', 'finishRecoveryPermit', 'launchObservations', 'launchPermittedRecovery', 'recoveredSessionForRun',
        'releaseExpiredRecoveryLease', 'releaseExpiredRecoveryLeases', 'cachedProcessStarts', 'heldRecoveryOwners',
    ];
    for (const name of [...expectedPermitRuntime, 'RecoveryRequest', 'ControlledRecoveryRequest', 'RecoveryPermitChecks', 'RecoveryConnectionAdmission', 'LeaseReleaseChecks']) {
        expect(permitExports.has(name)).toBe(true);
    }
    for (const internal of ['EvidenceRef', 'ProducerRef', 'Permit', 'repoRoot', 'sha', 'json', 'same', 'evidence', 'authority', 'capabilityRelease', 'current', 'childRunning', 'START_CACHE_MS', 'startCache']) {
        expect(permitExports.has(internal)).toBe(false);
    }
    expect(Object.keys(sessionRecoveryPermitFacade).sort()).toEqual([...expectedPermitRuntime].sort());

    const releaseExports = new Set(declaredExports('packages/core/src/worker-release.ts'));
    const expectedReleaseRuntime = [
        'workerSourceRoots', 'sourceScans', 'forgetSourceScans', 'workerSourceRevision',
        'runtimeTrees', 'workerLaunchers', 'releaseFiles', 'releaseRevision', 'workerEntries',
        'capabilityRevision', 'launchRevision', 'releaseEntries', 'forgetReleaseMemory',
        'cachedReleaseFor', 'cachedReleaseFiles', 'cachedLaunchRevision', 'assertWorkerRelease', 'standingPeer',
        'assertCompatibleWorkers', 'standingAccounts', 'isWorkerReleaseHold', 'crashResidue',
        'assertLiveWorkerRelease', 'LOST_SESSION_DROP_MS', 'closedSessionRow',
        'PEER_STALE_MS', 'SILENT_SESSION_DROP_MS', 'silentSessionRow', 'readPeerStatuses', 'loginBlockers',
    ];
    for (const name of [...expectedReleaseRuntime, 'ReleaseMemo']) {
        expect(releaseExports.has(name)).toBe(true);
    }
    for (const internal of ['typescriptLoaded', 'launchEntries', 'releaseFor', 'toolingRoots', 'releaseRootFiles', 'releaseDataRoots', 'hashOnly', 'revisionOf', 'bunfigPreloads', 'pidAlive']) {
        expect(releaseExports.has(internal)).toBe(false);
    }
    expect(Object.keys(workerReleaseFacade).sort()).toEqual([...expectedReleaseRuntime].sort());

    const dangerExports = new Set(declaredExports('packages/core/src/danger.ts'));
    const expectedDangerRuntime = [
        'combatLevel', 'parseHunter', 'CAGED', 'parseRoamer', 'loadRoamers', 'loadHunters',
        'hunts', 'deadly', 'PROTECT_MELEE_LEVEL', 'meleeOnly', 'deadlyTo', 'protectedFromMelee', 'liveHunters',
        'pack', 'unpack', 'dangerSet', 'dangerTiles', 'activeDanger', 'withDanger', 'escapeTiles', 'guardRoute', 'guardWalk',
        'cornerTiles', 'cornersOf', 'dangerSummary', 'foodHealOf', 'harmSet', 'huntersNear', 'isMulti', 'npcReach', 'planAroundHarm',
        'routeDanger', 'routeExposure', 'routeHarmKeep', 'routeHarmSet', 'runTiles', 'stateWalkProfile', 'walkExposure', 'walkFloorLine', 'walkProfile',
        'walkThreats', 'walkVerdict', 'DISTANT_HIT_RANGE', 'WIDE_DANGER_SQUARE', 'setDangerDoorAt',
    ];
    for (const name of [...expectedDangerRuntime, 'Hunter', 'Roamer', 'LiveHunter']) {
        expect(dangerExports.has(name)).toBe(true);
    }
    for (const internal of ['dangerKey', 'HUNTS_ALL', 'FloorGrid', 'guardProtects', 'active']) {
        expect(dangerExports.has(internal)).toBe(false);
    }
    expect(Object.keys(dangerFacade).sort()).toEqual([...expectedDangerRuntime].sort());

    // Preserve exact NUL-byte key delimiter semantics in launchObservations (`pid + '\0' + marker`).
    const calls: Array<[number, string]> = [];
    const wrapped = sessionRecoveryPermitFacade.launchObservations({ matches: (pid, marker) => { calls.push([pid, marker]); return pid === 1; } });
    expect(wrapped.matches!(1, '23')).toBe(true);
    expect(wrapped.matches!(1, '23')).toBe(true);
    expect(wrapped.matches!(12, '3')).toBe(false);
    expect(calls).toEqual([[1, '23'], [12, '3']]);
});
