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

const GROUPS = ['bot', 'gather', 'loot'] as const;

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('bot, gather, and loot each split into >= 3 acyclic submodules behind a clean facade with zero back-imports', () => {
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

test('external callers import bot, gather, and loot only through their facades', () => {
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
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

test('bot, gather, and loot submodules never import upward and packages/core/src stays acyclic', () => {
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

    const coreFiles = walkTs(join(repoRoot, 'packages', 'core', 'src'));
    expect(findSccs(relativeDeps(coreFiles))).toEqual([]);
});

test('facades preserve every referenced export and keep internal-only helpers private inside submodules', () => {
    const botExports = new Set(declaredExports('packages/core/src/bot.ts'));
    for (const name of [
        'openBot', 'finish', 'getWorld', 'accountOf', 'settle', 'attachTickStallWatch', 'botWork', 'closeWithin',
        'releaseLine', 'sessionDied', 'watchUnexpectedEnd', 'serverFromEnv', 'assertServerAllowed', 'awaitBotReady',
        'deathStep', 'stopReasonOf', 'countItems', 'randomEventsOf', 'logoutSession', 'deathRecoveryOf',
        'logoutAdapter', 'openHooks', 'finishHooks', 'releasePrayerGuard', 'BotRecord', 'SettlementOptions',
    ]) {
        expect(botExports.has(name)).toBe(true);
    }
    for (const internal of [
        'STALL_TICKS', 'repoRoot', 'LifeFields', 'FinishDetail', 'ledgers', 'statuses', 'stallWatches',
        'randomEvents', 'deathRecoveries', 'prayerGuards', 'eatGuards', 'records', 'settling', 'settlements',
    ]) {
        expect(botExports.has(internal)).toBe(false);
    }

    const gatherExports = new Set(declaredExports('packages/core/src/gather.ts'));
    for (const name of [
        'MILK', 'BUCKET', 'COW', 'LOC_SOURCES', 'Gather', 'PICK_SOURCES', 'NpcSource', 'NPC_SOURCES',
        'COMBINE_SOURCES', 'BRONZE_PICKAXE', 'MINE_SOURCES', 'TINDERBOX', 'LOGS', 'BURN_SOURCES', 'USE_SOURCES',
        'BOWS', 'ARROWS', 'ARROWS_PER_KILL', 'MagicKit', 'magicKit', 'castsPerKill', 'castsFor', 'rangedKit',
        'denseSpawns', 'KILL_SOURCES', 'sharedDrops', 'killAttempts', 'KillStyle', 'killStyle', 'arrowsFor',
        'killSpawns', 'gatherPlan', 'gatherItems',
    ]) {
        expect(gatherExports.has(name)).toBe(true);
    }
    for (const internal of [
        'PICKAXES', 'FIRE_TICKS', 'WATER_SOURCES', 'SPELLS', 'STAFF_RUNE',
        'CASTS_MIN', 'CLUSTER', 'SERIES_CLUSTER', 'EASY_KILL', 'canKill',
    ]) {
        expect(gatherExports.has(internal)).toBe(false);
    }

    const lootExports = new Set(declaredExports('packages/core/src/loot.ts'));
    for (const name of [
        'Ground', 'Held', 'ItemInfo', 'LootTables', 'LootRules', 'LOOT_RULES', 'GUARD_VALUE', 'LURE_PAUSE',
        'sellsItems', 'recordRun', 'unitValue', 'pileValue', 'detourTicks', 'worthIt', 'lootRisk', 'lureGuard',
        'lootRoom', 'pileKey', 'claimPile', 'releasePile', 'sharedLootTables', 'marketValue', 'fileTables',
    ]) {
        expect(lootExports.has(name)).toBe(true);
    }
    for (const internal of [
        'COINS', 'ALCH_SHARE', 'COMBAT_TICKS', 'PLAYER_RANGE', 'NEAR_WILD',
        'ANCHOR_RESET', 'LURE_PICKUPS', 'LURE_TICKS', 'WANTED_SHARE', 'nearWild', 'stacks', 'UNBID_BASE_MULT',
    ]) {
        expect(lootExports.has(internal)).toBe(false);
    }
});
