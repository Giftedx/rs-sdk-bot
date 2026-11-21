// Builds the --specialist Segment JSON and runs the isolated 400 ms practice rehearsal for one ready specialist account.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SPECIALIST_BOARDS } from '../../packages/core/src/specialist-boards';
import { checkSpecialistSegment, type RehearsalReport, type Segment, type SupplierSpec } from '../../packages/practice/src/rehearse';
import type { SaveConfig } from '../../packages/practice/src/presets';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { scoredClock } from '../../packages/practice/src/specialist-rehearsal';
import { CRAFTING_BATCHES } from '../crafting-specialist';
import { ITEM_IDS } from '../fast-skills-lib';
import { buildFiremakingSupplierConfigs } from '../firemaking-specialist';
import { HERBLORE_NOTED_SUPPLIES, HERBLORE_STARTER_BATCH } from '../herblore-specialist';
import { LUMBRIDGE_SAFE_SPOT, MAGIC_BATCHES } from '../magic-specialist';
import { PRAYER_RUNNER_COUNT } from '../prayer-specialist';
import { RANGED_SPECIALIST_LIVE_TRADE1, RANGED_SPECIALIST_LIVE_TRADE2 } from '../ranged-specialist';
import { BODY_RUNNER_COUNT } from '../runecraft-specialist';
import { SMITHING_RUNNER_QUEUE, VARROCK_WEST_BANK } from '../smithing-specialist';
import {
    AGILITY_SPECIALIST_KIT,
    COOKING_SPECIALIST_LIVE_KIT,
    FISHING_SPECIALIST_KIT,
    FLETCHING_SPECIALIST_LIVE_KIT,
    MINING_SPECIALIST_LIVE_KIT,
    THIEVING_SPECIALIST_LIVE_KIT,
    WOODCUTTING_SPECIALIST_LIVE_KIT,
    type KitSpecItem,
} from '../specialist-supplier';

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
] as const;

export type ReadySpecialistAccount = (typeof READY_SPECIALIST_ACCOUNTS)[number];

const STACKABLE_SAVE_IDS = new Set<number>([
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
]);

const SUPPLIER_GUARD_ENV: Record<string, string> = {
    LOOT_WATCH: '0',
    PRAYER_GUARD: '0',
    EAT_GUARD: '0',
    STALL_TICKS: '0',
};

export function expandKitToSave(items: readonly Pick<KitSpecItem, 'id' | 'count'>[], stackableMap?: ReadonlySet<number>): { id: number; count: number }[] {
    const out: { id: number; count: number }[] = [];
    for (const item of items) {
        const isStackable = stackableMap?.has(item.id)
            || STACKABLE_SAVE_IDS.has(item.id)
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
    const deliveries = SMITHING_RUNNER_QUEUE.filter((_, i) => i % runnerCount === runnerIdx);
    const [first, ...rest] = deliveries;
    return {
        inventory: first ? expandKitToSave([{ id: first.barId, count: first.count }]) : [],
        bank: aggregateKitBank(rest.map(d => ({ id: d.barId, count: d.count }))),
    };
}

interface SpecialistSupplierDef {
    readonly script: 'scripts/specialist-supplier.ts' | 'scripts/gathering-supplier.ts';
    readonly args: readonly string[];
    readonly save: () => SaveConfig;
}

interface SpecialistSpecDefinition {
    readonly account: ReadySpecialistAccount;
    readonly id: string;
    readonly script: string;
    readonly args?: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly supplier?: SpecialistSupplierDef;
    readonly suppliers?: () => readonly SpecialistSupplierDef[];
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
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=thieving-live', '3200'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(THIEVING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 1965,
        planSource: '400ms rehearsal 1955t / hosted-bench extra:specialist-thieving-live (<=2221t vs #1 2267t)',
        targetCap: 2221,
    },
    {
        account: 'TipMyShaft',
        id: 'tipmyshaft-fletching',
        script: 'scripts/fletching-specialist.ts',
        env: { CAP: '200' },
        supplier: {
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=fletching-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(FLETCHING_SPECIALIST_LIVE_KIT),
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
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=cooking-live', '200'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(COOKING_SPECIALIST_LIVE_KIT),
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
        suppliers: () => buildFiremakingSupplierConfigs().map((cfg): SpecialistSupplierDef => ({
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=firemaking', `--role=${cfg.role}`, '1200'],
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
        env: { CAP: '3200' },
        supplier: {
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=woodcutting-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(WOODCUTTING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 2700,
        planSource: '400ms rehearsal <=2818t (Barbarian Village East 2t flinch/3t knife Oaks vs #1 2876t)',
        targetCap: 2818,
    },
    {
        account: 'Shaftshooter',
        id: 'shaftshooter-ranged',
        script: 'scripts/ranged-specialist.ts',
        env: { CAP: '5600', VARIANT: 'live' },
        supplier: {
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=ranged-live', '6000'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(RANGED_SPECIALIST_LIVE_TRADE1),
                bank: aggregateKitBank(RANGED_SPECIALIST_LIVE_TRADE2),
            }),
        },
        planTicks: 4660,
        planSource: 'hosted-bench extra:ranged-specialist-live 4505-4774t (<=5483t vs #1 5595t)',
        targetCap: 5483,
    },
    {
        account: 'PouchStuffed',
        id: 'pouchstuffed-runecraft',
        script: 'scripts/runecraft-specialist.ts',
        env: { CAP: '2300' },
        suppliers: () => [
            {
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=runecraft', '--role=starter', '3000'],
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
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=runecraft', '--role=runner', '--bank-x=3094', '--bank-z=3491', '3000'],
                save: () => ({
                    position: { x: 3050, z: 3442, level: 0 },
                    inventory: expandKitToSave([
                        { id: ITEM_IDS.body_talisman, count: 1 },
                        { id: ITEM_IDS.blankrune, count: 26 },
                    ]),
                    bank: [{ id: ITEM_IDS.blankrune, count: 500 }],
                }),
            })),
        ],
        planTicks: 2155,
        planSource: 'hosted-bench extra:specialist-runecraft 2147-2161t (<=2207t vs #1 2253t)',
        targetCap: 2207,
    },
    {
        account: 'CutMyJewels',
        id: 'cutmyjewels-crafting',
        script: 'scripts/crafting-specialist.ts',
        env: { CAP: '2500' },
        suppliers: () => CRAFTING_BATCHES.map((batch, i): SpecialistSupplierDef => ({
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=crafting', `--batch=${i}`, '3000'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(batch.give),
            }),
        })),
        planTicks: 174,
        planSource: '400ms rehearsals 172-175t; hosted-bench skiller:crafting:specialist 181t (<=182t vs #1 186t)',
        targetCap: 182,
    },
    {
        account: 'GrindMyHerb',
        id: 'grindmyherb-herblore',
        script: 'scripts/herblore-specialist.ts',
        env: { CAP: '600' },
        suppliers: () => [
            {
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=herblore', '--batch=0', '1000'],
                save: () => ({
                    position: { x: 3223, z: 3222, level: 0 },
                    inventory: expandKitToSave(HERBLORE_STARTER_BATCH.give),
                }),
            },
            {
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=herblore', '--batch=1', '1000'],
                save: () => ({
                    position: { x: 3094, z: 3491, level: 0 },
                    inventory: [],
                    bank: aggregateKitBank(HERBLORE_NOTED_SUPPLIES),
                }),
            },
        ],
        planTicks: 411,
        planSource: 'hosted-bench skiller:herblore:specialist 410-411t (<=415t vs #1 424t)',
        targetCap: 415,
    },
    {
        account: 'CastMyLoad',
        id: 'castmyload-magic',
        script: 'scripts/magic-specialist.ts',
        env: { CAP: '2500' },
        suppliers: () => MAGIC_BATCHES.map((batch, i): SpecialistSupplierDef => ({
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=magic', `--batch=${i}`, '3000'],
            save: () => ({
                position: i === 0
                    ? { x: 3223, z: 3222, level: 0 }
                    : { x: LUMBRIDGE_SAFE_SPOT.x, z: LUMBRIDGE_SAFE_SPOT.z, level: 0 },
                inventory: expandKitToSave(batch.give),
            }),
        })),
        planTicks: 1170,
        planSource: '400ms rehearsals 1135-1208t (median 1150-1170t); hosted-bench skiller:magic:specialist 1137-1184t (<=1236t vs #1 1262t)',
        targetCap: 1236,
    },
    {
        account: 'BigBoner',
        id: 'bigboner-prayer',
        script: 'scripts/prayer-specialist.ts',
        env: { CAP: '1500' },
        suppliers: () => Array.from({ length: PRAYER_RUNNER_COUNT }, (): SpecialistSupplierDef => ({
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=prayer', '2000'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave([{ id: ITEM_IDS.dragon_bones, count: 28 }]),
                bank: [{ id: ITEM_IDS.dragon_bones, count: 250 }],
            }),
        })),
        planTicks: 1213,
        planSource: 'hosted-bench skiller:prayer:specialist 1212-1214t (<=1246t vs #1 1272t)',
        targetCap: 1246,
    },
    {
        account: 'SteelRod',
        id: 'steelrod-smithing',
        script: 'scripts/smithing-specialist.ts',
        env: { CAP: '1500' },
        suppliers: () => [
            {
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=smithing', '--role=starter', '2000'],
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
                script: 'scripts/specialist-supplier.ts',
                args: ['{ACTOR}', '--kit=smithing', '--role=runner', `--runner=${i}/${SMITHING_EXTERNAL_RUNNER_COUNT}`, '2000'],
                save: () => ({
                    position: { x: VARROCK_WEST_BANK.x, z: VARROCK_WEST_BANK.z, level: 0 },
                    ...smithingRunnerQueueSlice(i, SMITHING_EXTERNAL_RUNNER_COUNT),
                }),
            })),
        ],
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
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=mining-live', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(MINING_SPECIALIST_LIVE_KIT),
            }),
        },
        planTicks: 3800,
        planSource: 'hosted-bench skiller:mining:specialist 3789-3807t (<=3884t vs #1 3964t)',
        targetCap: 3884,
    },
    {
        account: 'Lochnessrod',
        id: 'lochnessrod-fishing',
        script: 'scripts/fishing-specialist.ts',
        env: { CAP: '3600' },
        supplier: {
            script: 'scripts/gathering-supplier.ts',
            args: ['{ACTOR}', '--kit=fishing', '400'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(FISHING_SPECIALIST_KIT),
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
            script: 'scripts/specialist-supplier.ts',
            args: ['{ACTOR}', '--kit=agility', '6500'],
            save: () => ({
                position: { x: 3223, z: 3222, level: 0 },
                inventory: expandKitToSave(AGILITY_SPECIALIST_KIT),
            }),
        },
        planTicks: 5913,
        planSource: '400ms rehearsal Polevaulter 5884t (hosted extra:specialist-agility 5795/5971/5931t; <=6031t vs #1 6155t)',
        targetCap: 6031,
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

export function resolveSpecialistSegment(account: string, opts?: { planTicks?: number }): SpecialistSegmentSpec {
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
        env: { ...SUPPLIER_GUARD_ENV },
    });
    const seg: SpecialistSegmentSpec = {
        id: def.id,
        specialist: def.account,
        start: { fresh: true },
        script: def.script,
        ...(def.args?.length ? { args: [...def.args] } : {}),
        env: { ...def.env },
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
}

function parseSeedList(raw: string): number[] {
    const nums = raw.split(',').map(x => Number(x.trim())).filter(Boolean);
    if (!nums.length || nums.some(n => !Number.isSafeInteger(n) || n <= 0)) {
        throw Error(`usage: --seeds requires positive integers (got "${raw}")`);
    }
    return nums;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
    let account = '';
    let dryRun = false;
    let out: string | undefined;
    let planTicks: number | undefined;
    let seeds: number[] | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--dry-run' || arg === '--print') {
            dryRun = true;
        } else if (arg === '--out') {
            out = argv[++i];
            if (!out) throw Error('usage: rehearse-specialist-cli.ts <specialistAccount> [--out <dir>] [--plan-ticks <n>] [--seeds <7,8,9>] [--dry-run]');
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
        } else if (arg.startsWith('--')) {
            throw Error(`rehearse-specialist-cli: unknown flag ${arg}`);
        } else if (!account) {
            account = arg;
        } else {
            throw Error(`rehearse-specialist-cli: unexpected positional argument ${arg}`);
        }
    }
    if (!account) {
        throw Error(`usage: rehearse-specialist-cli.ts <${READY_SPECIALIST_ACCOUNTS.join('|')}> [--out <dir>] [--plan-ticks <n>] [--seeds <7,8,9>] [--dry-run]`);
    }
    return { account, dryRun, out, planTicks, ...(seeds ? { seeds } : {}) };
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
    const seg = resolveSpecialistSegment(parsed.account, { planTicks: parsed.planTicks });
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
        const res = await runSingleSeedRehearsal(root, seg, segFile, normOut, spawn, log);
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
