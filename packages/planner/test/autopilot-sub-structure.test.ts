import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', '.practice', 'generated-assets']);
const GROUPS = ['world', 'pricing', 'catalogue', 'plan'] as const;
const MAX_SUBMODULE_LINES = 250;

const SUBMODULE_LAYERS: Readonly<Record<typeof GROUPS[number], Readonly<Record<string, number>>>> = {
    world: { model: 0, capacity: 1, travel: 2, resources: 2 },
    pricing: { equipment: 0, feeds: 0, staging: 0, valuation: 1 },
    catalogue: {
        constants: 0, builds: 0, aio: 1, makers: 1, 'squad-gather': 1, 'squad-herblore': 1,
        'army-combat': 1, 'army-quests': 2, 'squad-craft': 2, 'squad-shops': 3, assemble: 4,
    },
    plan: { needs: 0, kits: 1, 'goal-needs': 2, context: 3, candidates: 4, acquire: 4, supply: 5, orchestrate: 6 },
};

const EXPECTED_AUTOPILOT_RUNTIME_EXPORTS = [
    'AIO_PLACES', 'AIR_STOCK', 'AMMO_BATCH', 'AMMO_LOW', 'AMMO_MARKET', 'ARMOUR_BAND', 'ARMOUR_IDS',
    'ARMOUR_MARKET', 'ARMOUR_SETS', 'ARMY_BANK', 'ARROW_LOW', 'ARROW_STOCK', 'BLACK_CAVE',
    'BLACK_CAVE_PLACES', 'BLOOD_FOOD', 'BLOOD_MEALS', 'BONE_KEEP', 'BONE_PURSE', 'BONE_SKILL',
    'BONE_START', 'BOUGHT_BONE_XP', 'BOW_IDS', 'BUILD_QUESTS', 'CANNON_BARS', 'CAPACITY',
    'CHICKEN_PENS', 'CLAIM_MAX_AGE_MS', 'COW_BANDS', 'COW_FIELD', 'COW_FIELD_CAPACITY',
    'COW_WEAPONS', 'CURSE_LEVEL', 'CURSE_XP', 'DRAIN_RESULT', 'FEATHER_STOCK', 'FEATHER_TARGET',
    'FERRY_FARE', 'FIRE_STOCK', 'FLAX_SPIN', 'FLETCH_KEEP', 'FLETCH_MAKE', 'FOOD_HEAL',
    'FRAIL_FOOD_BUY', 'FRAIL_FOOD_BUY_ID', 'FREMENNIK', 'FREMENNIK_BAND', 'FUND_RESERVE',
    'GEM_RINGS', 'GOLDFARM_FOOD', 'GOLDFARM_FRAIL', 'GRAIL_BAND', 'GRAIL_MEALS', 'GRAIL_PLACE',
    'GRAIL_RUNES', 'HIDE_TARGET', 'HUNT_ARROWS', 'HUNT_ARROW_STOCK', 'HUNT_BAND', 'HUNT_FOOD',
    'HUNT_KILLS', 'HUNT_RUNE_ARROWS', 'HUNT_RUNE_SPEND', 'HUNT_RUNE_STOCK', 'JAKUT_CAP',
    'JAKUT_COINS', 'JAKUT_RESERVE', 'JAKUT_SWORDS', 'JAKUT_WAIT', 'KIT_BUY', 'KIT_BUY_SCRIPT',
    'KIT_CASH_RESERVE', 'KIT_COIN_MARGIN', 'KIT_PRICE_CAPS', 'KNIGHT_BANK', 'KNIGHT_SHARE',
    'KNIGHT_SPOTS', 'LEATHER_LEVEL', 'LOST_CITY', 'LOST_CITY_BUILD', 'LOST_CITY_MEALS',
    'LOST_CITY_PLACES', 'LOWE_STOCK', 'MAGIC_BAND', 'MAKE_BATCH', 'NATURE_STOCK',
    'OBSERVATION_FRESH_MS', 'PEN_QUEST_POINTS', 'PILOT_FALLBACK_SHARE', 'PLACES',
    'PRAYER_FIELD_BAND', 'QUEST_BAND', 'QUEST_BOW_ARROWS', 'QUEST_CAP_FACTOR', 'QUEST_CAP_MIN',
    'QUEST_DEMAND', 'QUEST_DEMAND_BAND', 'QUEST_DEMAND_PLACES', 'QUEST_DEMAND_ROWS',
    'RANGED_ARMOUR_BAND', 'RANGED_KIT', 'REGICIDE_MEALS', 'REGICIDE_PACK', 'REGICIDE_RUNES',
    'RETIRE_FAILS', 'RING_BATCH', 'ROUTE_BEFORE', 'RUNE_ARROW_COST', 'RUNE_ARROW_SPEND',
    'SET_HIDES', 'SET_SHOP', 'SHARED', 'SHOP_STOCK', 'SPECIALIST_STAGE_BILLS', 'SPLASH_FENCE',
    'SPLASH_KIT', 'SPLASH_PLACES', 'SPLASH_START', 'SPLASH_TO', 'SQUAD_RESTOCK',
    'SQUAD_UNIT_COST', 'STEW_BATCH', 'STRIKE_TILE', 'SWEEP_MEALS', 'TAN_COIN', 'TOLL',
    'TRAIN_SHARE', 'TROOPER_FIELD', 'TROOPER_FIELD_CAPACITY', 'UNF_POTIONS', 'UPASS',
    'UPASS_AGILITY', 'UPASS_MEALS', 'UPASS_THIEVING', 'WEAPON', 'WEAPON_BAND', 'WEAPON_HELD',
    'WEAPON_MARKET', 'accountFrom', 'accountStyle', 'aioTemplates', 'ammoStageFor', 'assess',
    'bandLeft', 'bowStageFor', 'buildBand', 'catalogue', 'claimFor', 'combatLevel',
    'finishedTrainers', 'freshest', 'goalNeeds', 'inWestArdougne', 'jobFor', 'jobResources',
    'kitLacks', 'kitReserve', 'kitStyle', 'knightCoinsPerTick', 'makerChains', 'meetFor',
    'mergeJobs', 'norm', 'onKaramja', 'pairKey', 'placeOf', 'plan', 'plannableAccounts',
    'priceTable', 'progressed', 'proportionalLines', 'questDemand', 'questKitCaps',
    'questResource', 'questsDoneIn', 'recoveringOwnerJobs', 'reservedAccounts',
    'reservedResources', 'selfServePilot', 'specialistStagingNeeds', 'splashKit', 'squadSupplies',
    'unitValue', 'usableTool', 'wayCost',
] as const;

const INTERNAL_ONLY_HIDDEN_EXPORTS: Readonly<Record<typeof GROUPS[number], readonly string[]>> = {
    world: ['WEAPON_BUYERS', 'ARMOUR_BUYERS', 'GRAIL_PLACES', 'FREMENNIK_PLACES', 'UPASS_PLACES', 'KNIGHT_SHARED_RATE', 'CATHERBY_BANK', 'VARROCK_EAST_BANK'],
    pricing: ['BILL_PREMIUM'],
    catalogue: [
        'LOST_CITY_FOOD', 'FLETCH_TO', 'COW_PASSES', 'TROOPER_FOOD', 'TROOPER_STOCK', 'TROOPER_FED',
        'TROOPER_BANDS', 'PRAYER_BAND', 'RANGED_BAND', 'GUILD_BAND', 'RANGED_TROOPER_DEFENCE',
        'ZAFF_WAIT', 'BOWSTRING_BATCH', 'SHAFT_LOGS', 'BLOOD_LOOTS', 'SQUAD_CRAFT_ESSENCE',
        'SQUAD_RUNE_SETS', 'SQUAD_SHARK_RUN', 'RING_MOULD_COINS', 'makerShopSteps',
    ],
    plan: ['unmet', 'kitBuyTemplate'],
};

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

test('Tarjan SCC detector catches direct, multi-node, and self cycles while accepting DAGs', () => {
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['a.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts']]);
    expect(findSccs(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]))).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    expect(findSccs(new Map([['self.ts', ['self.ts']]]))).toEqual([['self.ts']]);
    expect(findSccs(new Map([['top.ts', ['mid.ts', 'leaf.ts']], ['mid.ts', ['leaf.ts']], ['leaf.ts', []]]))).toEqual([]);
});

test('each deepened autopilot group splits into >= 3 bounded acyclic submodules behind a clean facade', () => {
    const allModules = [
        ...walkTs(join(repoRoot, 'packages'), true),
        ...walkTs(join(repoRoot, 'scripts'), true),
    ];

    for (const group of GROUPS) {
        const facade = `packages/planner/src/autopilot/${group}.ts`;
        const subDirPrefix = `packages/planner/src/autopilot/${group}/`;
        const submoduleFiles = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'autopilot', group));
        expect(submoduleFiles.length).toBeGreaterThanOrEqual(3);

        for (const rel of [facade, ...submoduleFiles]) {
            expect(lineCount(rel)).toBeLessThanOrEqual(MAX_SUBMODULE_LINES);
        }

        const graph = relativeDeps([facade, ...submoduleFiles]);
        const backImports: string[] = [];
        for (const rel of submoduleFiles) {
            for (const target of graph.get(rel) ?? []) {
                if (target === facade || target === 'packages/planner/src/autopilot.ts') {
                    backImports.push(`${rel} -> ${target}`);
                }
            }
        }
        expect(backImports).toEqual([]);

        const facadeImports = graph.get(facade) ?? [];
        expect(facadeImports.length).toBeGreaterThan(0);
        expect(facadeImports.every(target => target.startsWith(subDirPrefix))).toBe(true);
        expect(findSccs(graph)).toEqual([]);

        const layers = SUBMODULE_LAYERS[group];
        const intraLayerViolations: string[] = [];
        for (const rel of submoduleFiles) {
            const name = rel.slice(subDirPrefix.length, -3);
            const fromLayer = layers[name];
            expect(fromLayer).toBeDefined();
            for (const target of graph.get(rel) ?? []) {
                if (!target.startsWith(subDirPrefix)) continue;
                const targetName = target.slice(subDirPrefix.length, -3);
                const toLayer = layers[targetName];
                if (toLayer === undefined || toLayer >= fromLayer!) {
                    intraLayerViolations.push(`${rel} (L${fromLayer}) -> ${target} (L${toLayer ?? '?'})`);
                }
            }
        }
        expect(intraLayerViolations).toEqual([]);

        const directExternalImports: string[] = [];
        for (const rel of allModules) {
            if (rel === facade || rel.startsWith(subDirPrefix)) continue;
            const abs = join(repoRoot, rel);
            const text = readFileSync(abs, 'utf8');
            if (!text.includes(group)) continue;
            const info = ts.preProcessFile(text, true, true);
            for (const imp of info.importedFiles) {
                const spec = imp.fileName;
                if (!spec.startsWith('.')) {
                    if (spec.includes(`autopilot/${group}/`)) directExternalImports.push(`${rel} -> ${spec}`);
                    continue;
                }
                const target = resolveImportTarget(abs, spec);
                if (target.startsWith(subDirPrefix)) directExternalImports.push(`${rel} -> ${target}`);
            }
        }
        expect(directExternalImports).toEqual([]);
    }
});

test('autopilot submodule graph preserves strict cross-group layering and allowed planner dependencies', () => {
    const autopilotFacade = 'packages/planner/src/autopilot.ts';
    const autopilotTree = walkTs(join(repoRoot, 'packages', 'planner', 'src', 'autopilot'));
    const fullGraph = relativeDeps([autopilotFacade, ...autopilotTree]);
    expect(findSccs(fullGraph)).toEqual([]);

    const rankOf = (rel: string): number => {
        if (rel === 'packages/planner/src/autopilot/world.ts' || rel.startsWith('packages/planner/src/autopilot/world/')) return 0;
        if (rel === 'packages/planner/src/autopilot/pricing.ts' || rel.startsWith('packages/planner/src/autopilot/pricing/')) return 1;
        if (rel === 'packages/planner/src/autopilot/catalogue.ts' || rel.startsWith('packages/planner/src/autopilot/catalogue/')) return 2;
        if (rel === 'packages/planner/src/autopilot/claims.ts') return 2;
        if (rel === 'packages/planner/src/autopilot/plan.ts' || rel.startsWith('packages/planner/src/autopilot/plan/')) return 3;
        return 4;
    };

    const allowedRoots = ['packages/planner/', 'packages/core/', 'packages/knowledge/', 'vendor/'];
    const allowedSpecs = ['@rsbot/planner', '@rsbot/core', '@rsbot/knowledge'];
    const layerViolations: string[] = [];
    const crossViolations: string[] = [];

    for (const rel of autopilotTree) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        const fromRank = rankOf(rel);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('node:')) continue;
            if (!spec.startsWith('.')) {
                if (!allowedSpecs.some(a => spec === a || spec.startsWith(`${a}/`)) && !allowedRoots.some(r => spec.startsWith(r))) {
                    layerViolations.push(`${rel} -> ${spec}`);
                }
                continue;
            }
            const target = resolveImportTarget(abs, spec);
            if (!allowedRoots.some(r => target.startsWith(r))) {
                layerViolations.push(`${rel} -> ${target}`);
            }
            if (target === autopilotFacade) {
                crossViolations.push(`${rel} -> ${target}`);
                continue;
            }
            if (target.startsWith('packages/planner/src/autopilot/')) {
                const toRank = rankOf(target);
                const isCatalogue = (p: string) => p === 'packages/planner/src/autopilot/catalogue.ts' || p.startsWith('packages/planner/src/autopilot/catalogue/');
                if (toRank > fromRank || (fromRank === 2 && toRank === 2 && isCatalogue(rel) !== isCatalogue(target))) {
                    crossViolations.push(`${rel} -> ${target}`);
                }
            }
        }
    }
    expect(layerViolations).toEqual([]);
    expect(crossViolations).toEqual([]);
});

test('autopilot facade preserves runtime export surface while group facades keep internal-only helpers private', async () => {
    const facade = await import('../src/autopilot');
    expect(Object.keys(facade).sort()).toEqual([...EXPECTED_AUTOPILOT_RUNTIME_EXPORTS]);

    for (const group of GROUPS) {
        const mod = await import(`../src/autopilot/${group}`) as Record<string, unknown>;
        const leaked = INTERNAL_ONLY_HIDDEN_EXPORTS[group].filter(name => name in mod);
        expect(leaked).toEqual([]);
    }
});
