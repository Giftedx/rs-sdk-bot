// Builds the --specialist Segment JSON and runs the isolated 400 ms practice rehearsal for one ready specialist account.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { SPECIALIST_BOARDS } from '../../packages/core/src/specialist-boards';
import { checkSpecialistSegment, type RehearsalReport, type Segment, type SupplierSpec } from '../../packages/practice/src/rehearse';
import type { SaveConfig } from '../../packages/practice/src/presets';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { scoredClock } from '../../packages/practice/src/specialist-rehearsal';
import type { KitSpecItem } from '../../packages/workers/src/logistics/specialist-supply';

const require = createRequire(import.meta.url);
const loadMod = <T>(rel: string): T => require(rel) as T;
const getItemIds = () => loadMod<typeof import('../fast-skills-lib')>('../fast-skills-lib').ITEM_IDS;
const getLogisticsKits = () => loadMod<typeof import('../../packages/workers/src/logistics/specialist-supply')>('../../packages/workers/src/logistics/specialist-supply');

const ROOT = resolve(import.meta.dir, '..', '..');
const DEFAULT_OUT_BASE = '.practice/hosted-rehearse';

export type SpecialistSegmentSpec = Segment & { specialist: string };

export const READY_SPECIALIST_ACCOUNTS = [
    'StickyFinger',
    'TipMyShaft',
    'Saltysausage',
    'Lightmylog',
    'Morningwood',
    'Lochnessrod',
    'Shaftshooter',
    'PouchStuffed',
    'CutMyJewels',
    'GrindMyHerb',
    'CastMyLoad',
    'BigBoner',
    'SteelRod',
    'Mineshafted',
    'Polevaulter',
    'HiltsDeep',
    'RockSolid',
    'BigSwinger',
    'FullBlooded',
] as const;

export type ReadySpecialistAccount = (typeof READY_SPECIALIST_ACCOUNTS)[number];

let stackableSaveIdsCache: Set<number> | undefined;
function getStackableSaveIds(): Set<number> {
    if (stackableSaveIdsCache) return stackableSaveIdsCache;
    const ITEM_IDS = getItemIds();
    const { HERBLORE_NOTED_SUPPLIES } = loadMod<typeof import('../herblore-specialist')>('../herblore-specialist');
    stackableSaveIdsCache = new Set<number>([
        2, // Cannonball
        39, // Bronze arrowtips
        40, // Iron arrowtips
        41, // Steel arrowtips
        42, // Mithril arrowtips
        43, // Adamant arrowtips
        44, // Rune arrowtips
        53, // Headless arrow
        313, // Fishing bait
        314, // Feather
        881, // Barbed bolts
        884, // Iron arrow
        892, // Rune arrow
        995, // Coins
        1996, // Noted Unfermented wine
        ITEM_IDS.airrune,
        ITEM_IDS.waterrune,
        ITEM_IDS.earthrune,
        ITEM_IDS.firerune,
        ITEM_IDS.mindrune,
        ITEM_IDS.cosmicrune,
        ITEM_IDS.lawrune,
        ITEM_IDS.bloodrune,
        ITEM_IDS.bodyrune,
        ...HERBLORE_NOTED_SUPPLIES.map(s => s.certId),
        ...loadMod<typeof import('../crafting-specialist')>('../crafting-specialist').CRAFTING_CW_NOTED_SUPPLIES.map(s => s.certId),
    ]);
    return stackableSaveIdsCache;
}

const SUPPLIER_GUARD_ENV: Record<string, string> = {
    LOOT_WATCH: '0',
    PRAYER_GUARD: '0',
    EAT_GUARD: '0',
    STALL_TICKS: '0',
};

export function expandKitToSave(items: readonly Pick<KitSpecItem, 'id' | 'count'>[], stackableMap?: ReadonlySet<number>): { id: number; count: number }[] {
    const stackableIds = getStackableSaveIds();
    const out: { id: number; count: number }[] = [];
    for (const item of items) {
        const isStackable = stackableMap?.has(item.id)
            || stackableIds.has(item.id)
            || ('stackable' in item && Boolean((item as KitSpecItem).stackable));
        if (isStackable) {
            out.push({ id: item.id, count: item.count });
        } else {
            for (let i = 0; i < item.count; i++) out.push({ id: item.id, count: 1 });
        }
    }
    if (out.length > 28) {
        throw Error(`rehearse-specialist-cli: supplier inventory exceeds 28 slots (${out.length})`);
    }
    return out;
}

export function aggregateKitBank(items: readonly { id: number; count: number }[]): { id: number; count: number }[] {
    const totals = new Map<number, number>();
    for (const item of items) {
        totals.set(item.id, (totals.get(item.id) ?? 0) + item.count);
    }
    return [...totals.entries()].map(([id, count]) => ({ id, count }));
}

const SMITHING_EXTERNAL_RUNNER_COUNT = 3;

function smithingRunnerQueueSlice(runnerIdx: number, runnerCount: number): Pick<SaveConfig, 'inventory' | 'bank'> {
    const { SMITHING_RUNNER_QUEUE } = loadMod<typeof import('../smithing-specialist')>('../smithing-specialist');
    const deliveries = SMITHING_RUNNER_QUEUE.filter((_, i) => i % runnerCount === runnerIdx);
    const [first, ...rest] = deliveries;
    return {
        inventory: first ? expandKitToSave([{ id: first.barId, count: first.count }]) : [],
        bank: aggregateKitBank(rest.map(d => ({ id: d.barId, count: d.count }))),
    };
}

interface SpecialistSupplierDef {
    readonly script: 'scripts/aio-logistics.ts' | 'scripts/measure/specialist-combat-quests-cases.ts';
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly save: () => SaveConfig;
}

const PVP_COMPANION_GUARD_ENV: Readonly<Record<string, string>> = {
    FLEE_GUARD: '0',
    DEATH_RECOVERY: '0',
    VALUE_GUARD: '0',
    RANDOM_EVENTS: '0',
};

type CombatPvpMode = 'attack-pvp' | 'defence' | 'strength' | 'hp-pvp' | 'ranged-pvp-glory';

function combatPvpSuppliers(mode: CombatPvpMode, rangedTank = false): readonly SpecialistSupplierDef[] {
    const {
        COMBAT_BENCH_MODES,
        RANGED_TANK_SKILLS,
        tankPostPresetConfig,
        tankSupplierPresetConfig,
    } = loadMod<typeof import('./specialist-combat-quests-cases')>('./specialist-combat-quests-cases');
    const kit = COMBAT_BENCH_MODES[mode].kit;
    const skills = rangedTank ? RANGED_TANK_SKILLS : undefined;
    return [
        {
            script: 'scripts/measure/specialist-combat-quests-cases.ts',
            args: ['--companion', '{ACTOR}', 'supplier-tank', mode, '1'],
            env: PVP_COMPANION_GUARD_ENV,
            save: () => tankSupplierPresetConfig(kit, skills),
        },
        {
            script: 'scripts/measure/specialist-combat-quests-cases.ts',
            args: ['--companion', '{ACTOR}', 'tank', mode, '0'],
            env: PVP_COMPANION_GUARD_ENV,
            save: () => tankPostPresetConfig(0, skills),
        },
        {
            script: 'scripts/measure/specialist-combat-quests-cases.ts',
            args: ['--companion', '{ACTOR}', 'tank', mode, '2'],
            env: PVP_COMPANION_GUARD_ENV,
            save: () => tankPostPresetConfig(2, skills),
        },
    ];
}

interface SpecialistSpecDefinition {
    readonly account: ReadySpecialistAccount;
    readonly id: string;
    readonly script: string;
    readonly args?: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly supplier?: SpecialistSupplierDef;
    readonly suppliers?: () => readonly SpecialistSupplierDef[];
    readonly defaultSeed?: number;
    readonly planTicks: number;
    readonly planSource: string;
    readonly targetCap: number;
}

const SPECIALIST_DEFINITIONS: readonly SpecialistSpecDefinition[] = [
    {
        account: 'StickyFinger',
        id: 'stickyfinger-thieving',
        script: 'scripts/thieving-specialist.ts',
        env: { CAP: '3200', LIVE: '1' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=thieving-live', '3200'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().THIEVING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 2142,
        planSource: '400ms rehearsal median across 2084..2217t (<=2221t vs #1 2267t, Castle Wars + Super energy(4) + 26 Chocolate cake)',
        targetCap: 2221,
    },
    {
        account: 'TipMyShaft',
        id: 'tipmyshaft-fletching',
        script: 'scripts/fletching-specialist.ts',
        env: { CAP: '200' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=fletching-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().FLETCHING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 54,
        planSource: 'hosted-bench extra:specialist-fletching 54t (<=54t vs #1 56t)',
        targetCap: 54,
    },
    {
        account: 'Saltysausage',
        id: 'saltysausage-cooking',
        script: 'scripts/cooking-specialist.ts',
        env: { CAP: '100' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=cooking-live', '200'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().COOKING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 20,
        planSource: '400ms rehearsal 20t (20t login.rs2:70 fermenting_wine floor)',
        targetCap: 20,
    },
    {
        account: 'Lightmylog',
        id: 'lightmylog-firemaking',
        script: 'scripts/firemaking-specialist.ts',
        env: { CAP: '900' },
        suppliers: () => loadMod<typeof import('../firemaking-specialist')>('../firemaking-specialist').buildFiremakingSupplierConfigs().map((cfg): SpecialistSupplierDef => ({
            script: 'scripts/aio-logistics.ts',
            args: ['specialist-supplier', '{ACTOR}', '--kit=firemaking', `--role=${cfg.role}`, '1200'],
            save: () => ({
                position: cfg.position,
                inventory: cfg.inventory,
                bank: cfg.bank,
            }),
        })),
        planTicks: 749,
        planSource: '400ms rehearsals 741-757t (waitLogs=0 across 3 seeds vs 667t zero-setup stat_random floor in supply-floors.md)',
        targetCap: 646,
    },
    {
        account: 'Morningwood',
        id: 'morningwood-woodcutting',
        script: 'scripts/woodcutting-specialist.ts',
        env: { CAP: '3500' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=woodcutting-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().WOODCUTTING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 3240,
        planSource: '400ms rehearsal empirical Draynor Jail 3-oak flinch ~3230-3260t (1062 rolls / 987187xp Lv98 at 3200t; targetCap 2818 vs #1 2876t below 2.50t/roll guard floor, stays offline)',
        targetCap: 2818,
    },
    {
        account: 'Shaftshooter',
        id: 'shaftshooter-ranged',
        script: 'scripts/ranged-specialist.ts',
        env: { CAP: '2500', VARIANT: 'pvp-glory' },
        suppliers: () => combatPvpSuppliers('ranged-pvp-glory', true),
        defaultSeed: 7,
        planTicks: 1393,
        planSource: '400ms rehearsal SIM_SEED=7 1393t (<=1663t vs #1 1697t, 15-slot Glory/Yew shortbow/MSB Keep PvP)',
        targetCap: 1663,
    },
    {
        account: 'PouchStuffed',
        id: 'pouchstuffed-runecraft',
        script: 'scripts/runecraft-specialist.ts',
        env: { CAP: '2300' },
        suppliers: () => {
            const ITEM_IDS = getItemIds();
            const { BODY_RUNNER_COUNT } = loadMod<typeof import('../runecraft-specialist')>('../runecraft-specialist');
            return [
                {
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=runecraft', '--role=starter', '3000'],
                    save: () => ({
                        position: { x: 3223, z: 3222, level: 0 },
                        inventory: expandKitToSave([
                            { id: ITEM_IDS.amulet_of_glory_4, count: 1 },
                            { id: ITEM_IDS.air_talisman, count: 1 },
                            { id: ITEM_IDS.body_talisman, count: 1 },
                            { id: ITEM_IDS.blankrune, count: 25 },
                        ]),
                    }),
                },
                ...Array.from({ length: BODY_RUNNER_COUNT }, (): SpecialistSupplierDef => ({
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=runecraft', '--role=runner', '--bank-x=3094', '--bank-z=3491', '3000'],
                    save: () => ({
                        position: { x: 3050, z: 3442, level: 0 },
                        inventory: expandKitToSave([
                            { id: ITEM_IDS.body_talisman, count: 1 },
                            { id: ITEM_IDS.blankrune, count: 26 },
                        ]),
                        bank: [{ id: ITEM_IDS.blankrune, count: 500 }],
                    }),
                })),
            ];
        },
        planTicks: 2155,
        planSource: 'hosted-bench extra:specialist-runecraft 2147-2161t (above targetCap 1845t vs #1 1883t; offline)',
        targetCap: 1845,
    },
    {
        account: 'CutMyJewels',
        id: 'cutmyjewels-crafting',
        script: 'scripts/crafting-specialist.ts',
        env: { CAP: '2500', CRAFTING_MODE: 'cw' },
        suppliers: () => {
            const batch = loadMod<typeof import('../crafting-specialist')>('../crafting-specialist').CRAFTING_CW_BATCH;
            return [{
                script: 'scripts/aio-logistics.ts',
                args: ['specialist-supplier', '{ACTOR}', '--kit=crafting-cw', '3000'],
                save: () => ({
                    position: { x: 3223, z: 3222, level: 0 },
                    inventory: expandKitToSave(batch.give),
                }),
            }];
        },
        planTicks: 96,
        planSource: '400ms Castle Wars Bank Chest single-trade CW route (~96t vs #1 137t)',
        targetCap: 134,
    },
    {
        account: 'GrindMyHerb',
        id: 'grindmyherb-herblore',
        script: 'scripts/herblore-specialist.ts',
        env: { CAP: '600' },
        suppliers: () => {
            const { HERBLORE_NOTED_SUPPLIES, HERBLORE_STARTER_BATCH } = loadMod<typeof import('../herblore-specialist')>('../herblore-specialist');
            return [
                {
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=herblore', '--batch=0', '1000'],
                    save: () => ({
                        position: { x: 3223, z: 3222, level: 0 },
                        inventory: expandKitToSave(HERBLORE_STARTER_BATCH.give),
                    }),
                },
                {
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=herblore', '--batch=1', '1000'],
                    save: () => ({
                        position: { x: 3094, z: 3491, level: 0 },
                        inventory: [],
                        bank: aggregateKitBank(HERBLORE_NOTED_SUPPLIES),
                    }),
                },
            ];
        },
        planTicks: 411,
        planSource: 'hosted-bench skiller:herblore:specialist 410-411t (<=415t vs #1 424t)',
        targetCap: 415,
    },
    {
        account: 'CastMyLoad',
        id: 'castmyload-magic',
        script: 'scripts/magic-specialist.ts',
        env: { CAP: '2500' },
        suppliers: () => {
            const { LUMBRIDGE_SAFE_SPOT, MAGIC_BATCHES } = loadMod<typeof import('../magic-specialist')>('../magic-specialist');
            return MAGIC_BATCHES.map((batch, i): SpecialistSupplierDef => ({
                script: 'scripts/aio-logistics.ts',
                args: ['specialist-supplier', '{ACTOR}', '--kit=magic', `--batch=${i}`, '3000'],
                save: () => ({
                    position: i === 0
                        ? { x: 3223, z: 3222, level: 0 }
                        : { x: LUMBRIDGE_SAFE_SPOT.x, z: LUMBRIDGE_SAFE_SPOT.z, level: 0 },
                    inventory: expandKitToSave(batch.give),
                }),
            }));
        },
        planTicks: 1170,
        planSource: '400ms rehearsals 1135-1208t (median 1150-1170t); hosted-bench skiller:magic:specialist 1137-1184t (<=1236t vs #1 1262t)',
        targetCap: 1236,
    },
    {
        account: 'BigBoner',
        id: 'bigboner-prayer',
        script: 'scripts/prayer-specialist.ts',
        env: { CAP: '1500' },
        suppliers: () => {
            const ITEM_IDS = getItemIds();
            const { PRAYER_RUNNER_COUNT } = loadMod<typeof import('../prayer-specialist')>('../prayer-specialist');
            return Array.from({ length: PRAYER_RUNNER_COUNT }, (): SpecialistSupplierDef => ({
                script: 'scripts/aio-logistics.ts',
                args: ['specialist-supplier', '{ACTOR}', '--kit=prayer', '2000'],
                save: () => ({
                    position: { x: 3223, z: 3222, level: 0 },
                    inventory: expandKitToSave([{ id: ITEM_IDS.dragon_bones, count: 28 }]),
                    bank: [{ id: ITEM_IDS.dragon_bones, count: 250 }],
                }),
            }));
        },
        planTicks: 1213,
        planSource: 'hosted-bench skiller:prayer:specialist 1212-1214t (above targetCap 1143t vs #1 1167t; offline)',
        targetCap: 1143,
    },
    {
        account: 'SteelRod',
        id: 'steelrod-smithing',
        script: 'scripts/smithing-specialist.ts',
        env: { CAP: '1500' },
        suppliers: () => {
            const ITEM_IDS = getItemIds();
            const { VARROCK_WEST_BANK } = loadMod<typeof import('../smithing-specialist')>('../smithing-specialist');
            return [
                {
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=smithing', '--role=starter', '2000'],
                    save: () => ({
                        position: { x: 3223, z: 3222, level: 0 },
                        inventory: expandKitToSave([
                            { id: ITEM_IDS.hammer, count: 1 },
                            { id: ITEM_IDS.amulet_of_glory_4, count: 1 },
                            { id: ITEM_IDS.bronze_bar, count: 9 },
                            { id: ITEM_IDS.iron_bar, count: 17 },
                        ]),
                    }),
                },
                ...Array.from({ length: SMITHING_EXTERNAL_RUNNER_COUNT }, (_, i): SpecialistSupplierDef => ({
                    script: 'scripts/aio-logistics.ts',
                    args: ['specialist-supplier', '{ACTOR}', '--kit=smithing', '--role=runner', `--runner=${i}/${SMITHING_EXTERNAL_RUNNER_COUNT}`, '2000'],
                    save: () => ({
                        position: { x: VARROCK_WEST_BANK.x, z: VARROCK_WEST_BANK.z, level: 0 },
                        ...smithingRunnerQueueSlice(i, SMITHING_EXTERNAL_RUNNER_COUNT),
                    }),
                })),
            ];
        },
        planTicks: 1230,
        planSource: 'hosted-bench skiller:smithing:specialist 1197-1244t (<=1255t vs #1 1281t)',
        targetCap: 1255,
    },
    {
        account: 'Mineshafted',
        id: 'mineshafted-mining',
        script: 'scripts/mining-specialist.ts',
        env: { CAP: '4200', LIVE: '1' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=mining-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().MINING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 3800,
        planSource: 'hosted-bench skiller:mining:specialist 3789-3807t (above targetCap 3557t vs #1 3630t; offline)',
        targetCap: 3557,
    },
    {
        account: 'Lochnessrod',
        id: 'lochnessrod-fishing',
        script: 'scripts/fishing-specialist.ts',
        env: { CAP: '3600' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['gathering-supplier', '{ACTOR}', '--kit=fishing', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().FISHING_SPECIALIST_KIT),
            }),
        },
        planTicks: 2778,
        planSource: '400ms rehearsals Lochnessrod 2712-2844t (FM 1-30 + Sea Slug burst 179,375 XP + 3t Barbarian Village Fly 54-99 <=2924t vs #1 2984t)',
        targetCap: 2924,
    },
    {
        account: 'Polevaulter',
        id: 'polevaulter-agility',
        script: 'scripts/agility-specialist.ts',
        env: { CAP: '6500', AGI_ROUTE: 'monkeybars', AGI_POTION: '1', AGI_PRAY: '1', AGI_PIPE_ALIGN: '0' },
        supplier: {
            script: 'scripts/aio-logistics.ts',
            args: ['specialist-supplier', '{ACTOR}', '--kit=agility', '6500'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(getLogisticsKits().AGILITY_SPECIALIST_KIT),
            }),
        },
        planTicks: 5913,
        planSource: '400ms rehearsal Polevaulter 5884t (hosted extra:specialist-agility 5795/5971/5931t; <=6031t vs #1 6155t)',
        targetCap: 6031,
    },
    {
        account: 'HiltsDeep',
        id: 'hiltsdeep-attack',
        script: 'scripts/attack-specialist.ts',
        env: { CAP: '5000', VARIANT: 'pvp' },
        suppliers: () => combatPvpSuppliers('attack-pvp'),
        defaultSeed: 7,
        planTicks: 1975,
        planSource: '400ms rehearsal 1975t (<=2554t vs #1 2607t, Waterfall + 1-tick Rune 2h relog Keep PvP)',
        targetCap: 2554,
    },
    {
        account: 'RockSolid',
        id: 'rocksolid-defence',
        script: 'scripts/defence-specialist.ts',
        env: { CAP: '7500' },
        suppliers: () => combatPvpSuppliers('defence'),
        defaultSeed: 7,
        planTicks: 2382,
        planSource: '400ms rehearsals 2326..2438t (<=3937t vs #1 4018t, Waterfall + 1-tick Rune 2h relog Keep PvP)',
        targetCap: 3937,
    },
    {
        account: 'BigSwinger',
        id: 'bigswinger-strength',
        script: 'scripts/strength-specialist.ts',
        env: { CAP: '6000' },
        suppliers: () => combatPvpSuppliers('strength'),
        defaultSeed: 7,
        planTicks: 1931,
        planSource: '400ms rehearsal 1931t (<=3222t vs #1 3288t, Waterfall + 1-tick Rune 2h relog Keep PvP)',
        targetCap: 3222,
    },
    {
        account: 'FullBlooded',
        id: 'fullblooded-hitpoints',
        script: 'scripts/hp-specialist.ts',
        env: { CAP: '6000', HP_MODE: 'pvp' },
        suppliers: () => combatPvpSuppliers('hp-pvp'),
        defaultSeed: 7,
        planTicks: 3609,
        planSource: '400ms rehearsal 3609t (<=5263t vs #1 5371t, Waterfall + 1-tick Rune 2h relog Keep PvP)',
        targetCap: 5263,
    },
];

const BY_ACCOUNT = new Map<string, SpecialistSpecDefinition>(
    SPECIALIST_DEFINITIONS.map(def => [def.account.toLowerCase(), def]),
);

export function resolveSpecialistTargetCap(account: string): number {
    const def = BY_ACCOUNT.get(account.trim().toLowerCase());
    if (!def) {
        throw Error(`rehearse-specialist-cli: unknown specialist "${account}" (expected ${READY_SPECIALIST_ACCOUNTS.join(', ')})`);
    }
    return def.targetCap;
}

export function resolveSpecialistSegment(
    account: string,
    opts?: { planTicks?: number; env?: Record<string, string> },
): SpecialistSegmentSpec {
    const key = account.trim().toLowerCase();
    const def = BY_ACCOUNT.get(key);
    const board = SPECIALIST_BOARDS[key]?.name;
    if (!def || !board) {
        throw Error(`rehearse-specialist-cli: unknown specialist "${account}" (expected ${READY_SPECIALIST_ACCOUNTS.join(', ')})`);
    }
    const planTicks = opts?.planTicks ?? def.planTicks;
    if (!Number.isSafeInteger(planTicks) || planTicks <= 0) {
        throw Error(`rehearse-specialist-cli: invalid planTicks ${planTicks}`);
    }
    const buildSupplier = (s: SpecialistSupplierDef): SupplierSpec => ({
        save: s.save(),
        script: s.script,
        args: [...s.args],
        env: s.env ? { ...SUPPLIER_GUARD_ENV, ...s.env } : { ...SUPPLIER_GUARD_ENV },
    });
    const seg: SpecialistSegmentSpec = {
        id: def.id,
        specialist: def.account,
        start: { fresh: true },
        script: def.script,
        ...(def.args?.length ? { args: [...def.args] } : {}),
        env: { ...def.env, ...(opts?.env ?? {}) },
        ...(def.suppliers
            ? { suppliers: def.suppliers().map(buildSupplier) }
            : { supplier: buildSupplier(def.supplier!) }),
        plan: {
            ticks: planTicks,
            source: def.planSource,
        },
        expect: {
            skills: { [board]: 99 },
        },
        timeoutMs: Math.max(600_000, planTicks * 400 + 180_000),
    };
    checkSpecialistSegment(seg, seg.specialist);
    return seg;
}

export interface ParsedCliArgs {
    readonly account: string;
    readonly dryRun: boolean;
    readonly out?: string;
    readonly planTicks?: number;
    readonly seeds?: readonly number[];
    readonly env?: Readonly<Record<string, string>>;
}

function parseSeedList(raw: string): number[] {
    const nums = raw.split(',').map(x => Number(x.trim())).filter(Boolean);
    if (!nums.length || nums.some(n => !Number.isSafeInteger(n) || n <= 0)) {
        throw Error(`usage: --seeds requires positive integers (got "${raw}")`);
    }
    return nums;
}

function parseEnvEntry(raw: string, out: Record<string, string>): void {
    const m = /^([A-Z][A-Z0-9_]*)=([\w.,:+@\/-]*)$/.exec(raw);
    if (!m) throw Error(`usage: --env needs KEY=VALUE (got "${raw}")`);
    out[m[1]!] = m[2]!;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
    let account = '';
    let dryRun = false;
    let out: string | undefined;
    let planTicks: number | undefined;
    let seeds: number[] | undefined;
    const env: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--dry-run' || arg === '--print') {
            dryRun = true;
        } else if (arg === '--out') {
            out = argv[++i];
            if (!out) throw Error('usage: rehearse-specialist-cli.ts <specialistAccount> [--out <dir>] [--plan-ticks <n>] [--seeds <7,8,9>] [--env KEY=VALUE] [--dry-run]');
        } else if (arg.startsWith('--out=')) {
            out = arg.slice(6);
            if (!out) throw Error('usage: --out=<dir> requires a path');
        } else if (arg === '--plan-ticks') {
            planTicks = Number(argv[++i]);
            if (!Number.isSafeInteger(planTicks) || planTicks <= 0) throw Error('usage: --plan-ticks requires a positive integer');
        } else if (arg.startsWith('--plan-ticks=')) {
            planTicks = Number(arg.slice(13));
            if (!Number.isSafeInteger(planTicks) || planTicks <= 0) throw Error('usage: --plan-ticks=<n> requires a positive integer');
        } else if (arg === '--seed') {
            seeds = parseSeedList(argv[++i] ?? '');
        } else if (arg.startsWith('--seed=')) {
            seeds = parseSeedList(arg.slice(7));
        } else if (arg === '--seeds') {
            seeds = parseSeedList(argv[++i] ?? '');
        } else if (arg.startsWith('--seeds=')) {
            seeds = parseSeedList(arg.slice(8));
        } else if (arg === '--env') {
            parseEnvEntry(argv[++i] ?? '', env);
        } else if (arg.startsWith('--env=')) {
            parseEnvEntry(arg.slice(6), env);
        } else if (arg.startsWith('--')) {
            throw Error(`rehearse-specialist-cli: unknown flag ${arg}`);
        } else if (!account) {
            account = arg;
        } else {
            throw Error(`rehearse-specialist-cli: unexpected positional argument ${arg}`);
        }
    }
    if (!account) {
        throw Error(`usage: rehearse-specialist-cli.ts <${READY_SPECIALIST_ACCOUNTS.join('|')}> [--out <dir>] [--plan-ticks <n>] [--seeds <7,8,9>] [--env KEY=VALUE] [--dry-run]`);
    }
    return {
        account,
        dryRun,
        out,
        planTicks,
        ...(seeds ? { seeds } : {}),
        ...(Object.keys(env).length ? { env } : {}),
    };
}

export interface RehearsalSummary {
    readonly account: string;
    readonly board: string;
    readonly targetCap: number;
    readonly ok: boolean;
    readonly wholeClock: boolean;
    readonly planTicks: number;
    readonly ticks: RehearsalReport['ticks'] | null;
    readonly checks: Record<string, boolean> | null;
    readonly endPlaytime: number | null;
    readonly boardTicks: Record<string, number> | null;
    readonly externalSupplies: readonly { item: string; count: number; itemId?: number }[] | null;
    readonly context: string | null;
    readonly scope: string | null;
    readonly outDir: string;
}

function readJsonIfExists<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function tailLines(path: string, maxLines = 80): string {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8').split(/\r?\n/).slice(-maxLines).join('\n').trim();
}

export function collectRehearsalSummary(outDir: string, seg: SpecialistSegmentSpec): RehearsalSummary {
    const board = Object.keys(seg.expect.skills ?? {})[0] ?? '';
    const report = readJsonIfExists<RehearsalReport>(join(outDir, `${seg.id}.json`));
    const receipt = readJsonIfExists<{
        context?: string;
        endPlaytime?: number;
        boardTicks?: Record<string, number>;
        externalSupplies?: { item: string; count: number; itemId?: number }[];
    }>(join(outDir, `${seg.id}.receipt.json`));
    let endPlaytime = receipt?.endPlaytime ?? null;
    let boardTicks = receipt?.boardTicks ?? null;
    if (!receipt && report?.account && board) {
        try {
            const clock = scoredClock(readFileSync(playerSavePath(report.account)), board);
            endPlaytime = clock.endPlaytime;
            boardTicks = { [board]: clock.boardTick };
        } catch {
            // Rehearsal may fail before writing a final player save on the runner.
        }
    }
    return {
        account: seg.specialist,
        board,
        targetCap: resolveSpecialistTargetCap(seg.specialist),
        ok: report?.ok === true,
        wholeClock: report?.checks?.wholeClock === true,
        planTicks: seg.plan!.ticks,
        ticks: report?.ticks ?? null,
        checks: report?.checks ?? null,
        endPlaytime,
        boardTicks,
        externalSupplies: receipt?.externalSupplies ?? null,
        context: receipt?.context ?? null,
        scope: report?.scope ?? null,
        outDir,
    };
}

export type RehearseSpawnFn = (cmd: string[], cwd: string, extraEnv?: Record<string, string>) => Promise<number>;

const defaultSpawn: RehearseSpawnFn = async (cmd, cwd, extraEnv) => {
    const proc = Bun.spawn(cmd, {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdout: 'inherit',
        stderr: 'inherit',
        windowsHide: true,
    });
    return proc.exited;
};

async function runSingleSeedRehearsal(
    root: string,
    seg: SpecialistSegmentSpec,
    segFile: string,
    normOut: string,
    spawn: RehearseSpawnFn,
    log: (line: string) => void,
    seed?: number,
): Promise<{ exitCode: number; summary: RehearsalSummary }> {
    const outAbs = resolve(root, normOut);
    if (existsSync(outAbs)) {
        throw Error(`rehearse-specialist-cli: output directory already exists: ${normOut}`);
    }
    const exitCode = await spawn(
        ['bun', 'packages/practice/src/rehearse.ts', '--specialist', segFile, '--start', '--out', normOut],
        root,
        seed !== undefined ? { SIM_SEED: String(seed) } : undefined,
    );
    const summary = collectRehearsalSummary(outAbs, seg);
    const boardKey = Object.keys(seg.expect.skills ?? {})[0] ?? '';
    const boardTick = summary.boardTicks?.[boardKey];
    const targetOk = boardTick === undefined ? summary.ok : boardTick <= summary.targetCap;
    const seedOk = exitCode === 0 && summary.ok && summary.wholeClock && targetOk;
    log(`HOSTED_REHEARSAL_SUMMARY ${JSON.stringify({ ...(seed !== undefined ? { seed } : {}), ...summary, targetOk })}`);

    if (!seedOk) {
        const exts = ['log', 'err'];
        if (seg.suppliers && seg.suppliers.length > 1) {
            for (let i = 1; i <= Math.min(seg.suppliers.length, 3); i++) {
                exts.push(`supplier-${i}.log`, `supplier-${i}.err`);
            }
        } else {
            exts.push('supplier.log', 'supplier.err');
        }
        for (const ext of exts) {
            const tail = tailLines(join(outAbs, `${seg.id}.${ext}`), 60);
            if (tail) log(`--- ${seg.id}.${ext} (tail) ---\n${tail}`);
        }
    }
    return { exitCode: seedOk ? 0 : (exitCode || 1), summary };
}

export async function runHostedRehearsal(
    argv: readonly string[],
    opts: { root?: string; spawn?: RehearseSpawnFn; log?: (line: string) => void } = {},
): Promise<{ exitCode: number; seg: SpecialistSegmentSpec; summary?: RehearsalSummary; summaries?: readonly RehearsalSummary[] }> {
    const root = opts.root ?? ROOT;
    const log = opts.log ?? console.log;
    const parsed = parseCliArgs(argv);
    const seg = resolveSpecialistSegment(parsed.account, { planTicks: parsed.planTicks, env: parsed.env });
    if (parsed.dryRun) {
        log(JSON.stringify(seg, null, 2));
        return { exitCode: 0, seg };
    }
    const outRel = parsed.out ?? `${DEFAULT_OUT_BASE}/${seg.specialist.toLowerCase()}`;
    const outAbs = resolve(root, outRel);
    const normOut = relative(root, outAbs).replaceAll('\\', '/');
    if (!normOut.startsWith('.practice/') || normOut.includes('..')) {
        throw Error(`rehearse-specialist-cli: --out must be inside .practice/ (got ${outRel})`);
    }
    const stageDir = resolve(root, DEFAULT_OUT_BASE);
    mkdirSync(stageDir, { recursive: true });
    const segFile = join(stageDir, `${seg.specialist.toLowerCase()}.segment.json`);
    rmSync(segFile, { force: true });
    writeFileSync(segFile, JSON.stringify(seg, null, 2) + '\n');

    const spawn = opts.spawn ?? defaultSpawn;
    if (!parsed.seeds?.length) {
        const defaultSeed = BY_ACCOUNT.get(seg.specialist.toLowerCase())?.defaultSeed;
        const res = await runSingleSeedRehearsal(root, seg, segFile, normOut, spawn, log, defaultSeed);
        return { exitCode: res.exitCode, seg, summary: res.summary };
    }

    const summaries: RehearsalSummary[] = [];
    let allExit = 0;
    for (const seed of parsed.seeds) {
        const res = await runSingleSeedRehearsal(root, seg, segFile, `${normOut}-s${seed}`, spawn, log, seed);
        summaries.push(res.summary);
        if (res.exitCode !== 0 && allExit === 0) allExit = res.exitCode;
    }
    log(`HOSTED_REHEARSAL_BATCH ${JSON.stringify({ account: seg.specialist, seeds: parsed.seeds, allOk: allExit === 0, boardTicks: summaries.map(s => s.boardTicks) })}`);
    return { exitCode: allExit, seg, summary: summaries[summaries.length - 1], summaries };
}

if (import.meta.main) {
    const res = await runHostedRehearsal(process.argv.slice(2));
    process.exit(res.exitCode);
}
