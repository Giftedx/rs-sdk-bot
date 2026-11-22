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
    return out.sort();
}

function assertAllowedPlannerLayers(submoduleFiles: readonly string[]) {
    const allowedRoots = ['packages/planner/', 'packages/core/', 'packages/knowledge/', 'vendor/'];
    const allowedSpecs = ['@rsbot/planner', '@rsbot/core', '@rsbot/knowledge'];
    const violations: string[] = [];
    for (const rel of submoduleFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:')) continue;
            if (!spec.startsWith('.')) {
                if (!allowedSpecs.some(a => spec === a || spec.startsWith(`${a}/`)) && !allowedRoots.some(r => spec.startsWith(r))) {
                    violations.push(`${rel} -> ${spec}`);
                }
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (!allowedRoots.some(r => target.startsWith(r))) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);
}

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('pk-kits splits into >= 3 acyclic submodules behind pk-kits.ts with zero back-imports and Mage Arena literals kept in pk-kits.ts', () => {
    const facade = 'packages/planner/src/pk-kits.ts';
    const subDirPrefix = 'packages/planner/src/pk-kits/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'pk-kits'));
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

    // Keep 'Mage Arena' literals inside packages/planner/src/pk-kits.ts so check-rev289-names.ts:65 passes unchanged.
    const mageArenaLeaks = submoduleFiles.filter(rel => /['"]Mage Arena['"]/.test(readFileSync(join(repoRoot, rel), 'utf8')));
    expect(mageArenaLeaks).toEqual([]);

    // Enforce facade-only ./pk-kits/* imports across packages/ and scripts/.
    const allModules = [...walkTs(join(repoRoot, 'packages'), true), ...walkTs(join(repoRoot, 'scripts'), true)];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        const text = readFileSync(abs, 'utf8');
        if (!text.includes('pk-kits')) continue;
        const info = ts.preProcessFile(text, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('pk-kits/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
    assertAllowedPlannerLayers(submoduleFiles);
});

test('gear-progression/reconcile splits into >= 3 acyclic submodules behind reconcile.ts with zero back-imports or direct external imports', () => {
    const facade = 'packages/planner/src/gear-progression/reconcile.ts';
    const outerFacade = 'packages/planner/src/gear-progression.ts';
    const subDirPrefix = 'packages/planner/src/gear-progression/reconcile/';
    const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'gear-progression', 'reconcile'));
    expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

    const graph = relativeDeps([facade, ...submoduleFiles]);
    const backImports: string[] = [];
    for (const rel of submoduleFiles) {
        for (const target of graph.get(rel) ?? []) {
            if (target === facade || target === outerFacade) backImports.push(`${rel} -> ${target}`);
        }
    }
    expect(backImports).toEqual([]);

    const facadeImports = graph.get(facade) ?? [];
    expect(facadeImports.length).toBeGreaterThan(0);
    expect(facadeImports.every(target => target.startsWith(subDirPrefix))).toBe(true);
    expect(findSccs(graph)).toEqual([]);

    // Enforce facade-only ./reconcile/* imports across packages/ and scripts/.
    const allModules = [...walkTs(join(repoRoot, 'packages'), true), ...walkTs(join(repoRoot, 'scripts'), true)];
    const directSubmoduleImports: string[] = [];
    for (const rel of allModules) {
        if (rel === facade || rel.startsWith(subDirPrefix)) continue;
        const abs = join(repoRoot, rel);
        const text = readFileSync(abs, 'utf8');
        if (!text.includes('reconcile')) continue;
        const info = ts.preProcessFile(text, true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (!spec.startsWith('.')) {
                if (spec.includes('gear-progression/reconcile/')) directSubmoduleImports.push(`${rel} -> ${spec}`);
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (target.startsWith(subDirPrefix)) directSubmoduleImports.push(`${rel} -> ${target}`);
        }
    }
    expect(directSubmoduleImports).toEqual([]);
    assertAllowedPlannerLayers(submoduleFiles);
});

test('pk-kits and gear-progression/reconcile facades preserve export parity, content resolution, and hide internals', async () => {
    const pkDeclared = declaredExports('packages/planner/src/pk-kits.ts');
    expect(pkDeclared).toEqual([
        'DragonSpecComparison', 'GOD_LOADOUTS', 'GodLoadoutSpec', 'GodName', 'KITS', 'KitSpec', 'QUEST_CHAIN',
        'QUEST_VARP', 'buildGodSpellKit', 'combatLevel', 'compareDragonSpecs', 'godCapeStaffConflict', 'itemId',
        'kitCost', 'kitItems', 'kitOptions', 'kitRoute', 'kitSkills', 'kitSwitches', 'kitVarps', 'levelsBeforeRoute',
        'overBuild', 'trained',
    ]);
    for (const internal of [
        'pkKitsRoot', 'costOf', 'Worn', 'SLOT', 'PURE', 'MAXED', 'RUNE', 'WAVE', 'FREEZE',
        'PRAYER_POTS', 'BOOSTS', 'PURE_RANGE', 'DEF_TRIBRID', 'kitOf', 'ITEM_QUEST', 'VARP_QUEST',
    ]) {
        expect(pkDeclared).not.toContain(internal);
    }

    const pkMod = await import('../src/pk-kits');
    expect(Object.keys(pkMod).sort()).toEqual([
        'GOD_LOADOUTS', 'KITS', 'QUEST_CHAIN', 'QUEST_VARP', 'buildGodSpellKit', 'combatLevel',
        'compareDragonSpecs', 'godCapeStaffConflict', 'itemId', 'kitCost', 'kitItems', 'kitOptions',
        'kitRoute', 'kitSkills', 'kitSwitches', 'kitVarps', 'levelsBeforeRoute', 'overBuild', 'trained',
    ]);
    expect(pkMod.itemId('shark')).toBe(385);
    expect(pkMod.kitCost('tribrid')).toBeGreaterThan(0);
    expect(pkMod.kitRoute('pure-god')).toEqual({ quests: ['Mage Arena'], breaks: [] });

    const recDeclared = declaredExports('packages/planner/src/gear-progression/reconcile.ts');
    expect(recDeclared).toEqual([
        'BankToolSwapPlan', 'KnownToolShop', 'ReconcileBankToolHooks', 'SHOP_RESTOCK_COOLDOWN_TICKS',
        'SessionToolLike', 'ShopRetryGate', 'ShopToolPurchaseHooks', 'executeShopToolPurchase',
        'planBankToolSwap', 'reconcileBankTool', 'recordShopAttempt', 'sessionShopGate',
        'sessionToolHooks', 'shouldAttemptShopUpgrade',
    ]);
    for (const internal of ['TOOL_SHOP_LOCATIONS', 'checkStop', 'countIn', 'tryOpenBank', 'tryCloseBank']) {
        expect(recDeclared).not.toContain(internal);
    }

    const gpMod = await import('../src/gear-progression');
    for (const name of [
        'SHOP_RESTOCK_COOLDOWN_TICKS', 'executeShopToolPurchase', 'planBankToolSwap',
        'reconcileBankTool', 'recordShopAttempt', 'sessionShopGate', 'sessionToolHooks',
        'shouldAttemptShopUpgrade',
    ]) {
        expect(name in gpMod).toBe(true);
    }
});

test('haggis/model.ts has zero unreferenced internal exports and planner production modules stay acyclic', () => {
    const modelExports = declaredExports('packages/planner/src/haggis/model.ts');
    const haggisFiles = ['packages/planner/src/haggis.ts', ...walkTs(join(repoRoot, 'packages', 'planner', 'src', 'haggis'))]
        .filter(rel => rel !== 'packages/planner/src/haggis/model.ts');
    const consumerText = haggisFiles.map(rel => readFileSync(join(repoRoot, rel), 'utf8')).join('\n');
    const unreferenced = modelExports.filter(name => !new RegExp(`\\b${name}\\b`).test(consumerText));
    expect(unreferenced).toEqual([]);

    const plannerFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src'));
    expect(findSccs(relativeDeps(plannerFiles))).toEqual([]);
});
