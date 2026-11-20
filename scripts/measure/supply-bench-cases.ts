// Practice bench cases for continuous non-Wilderness PK squad raw-to-finished supply routes.
import type { BenchCase } from './aio-bench-cases';

const ok = (s: string) => /^RESULT ok\b/m.test(s);
const loggedOut = (s: string) => ok(s) && s.includes('LOGOUT logged-out');

const karambwanCookJob = encodeURIComponent(JSON.stringify({
    family: 'cooking',
    recipe: 'cooking_generic_karambwan',
    target: 3,
    batch: 3,
    cap: 600,
    returnTicks: 150,
    members: true,
    reserve: 0,
}));

export const SUPPLY_BENCH_CASES: readonly BenchCase[] = [
    {
        key: 'extra:supply-oziach-platebody',
        script: 'scripts/aio-market.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['shop-buy', 'oziach', '1200', 'ITEMS=rune platebody', 'STOCK_TARGET=1', 'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', 'FLOAT=170000', 'COIN_RESERVE=200', 'MAX_SPEND=169000'],
        presetConfig: { position: { x: 3094, z: 3491, level: 0 }, varps: { 176: 10 }, bank: [{ id: 995, count: 200_000 }] },
        pass: s => ok(s) && /boughtTotal=1 bankedTotal=1 /.test(s),
    },
    {
        key: 'extra:supply-tenzing-boots',
        script: 'scripts/aio-market.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['shop-buy', 'tenzing', '2000', 'ITEMS=climbing boots', 'STOCK_TARGET=2', 'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', 'FLOAT=100', 'COIN_RESERVE=20', 'MAX_SPEND=80'],
        presetConfig: { position: { x: 2946, z: 3368, level: 0 }, varps: { 314: 80, 315: 8 }, bank: [{ id: 995, count: 500 }] },
        pass: s => ok(s) && /boughtTotal=2 bankedTotal=2 /.test(s),
    },
    {
        key: 'extra:supply-jukat-dagger',
        script: 'scripts/aio-market.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['shop-buy', 'jukat_dagger', '2000', 'ITEMS=dragon dagger', 'STOCK_TARGET=2', 'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', 'FLOAT=130000', 'COIN_RESERVE=5000', 'MAX_SPEND=125000'],
        presetConfig: { position: { x: 3269, z: 3167, level: 0 }, varps: { 147: 6 }, bank: [{ id: 772, count: 1 }, { id: 995, count: 150_000 }, { id: 1601, count: 1 }] },
        pass: s => ok(s) && /boughtTotal=2 bankedTotal=2 /.test(s),
    },
    {
        key: 'extra:supply-brew-weapon-poison',
        script: 'scripts/aio-skiller.ts',
        preset: 'bank_gems',
        scriptArgs: ['crafting', 'inventory', 'brew:weapon_poison', 'MAX_MAKE=2', 'CAP=600', 'MEMBERS=1'],
        presetConfig: { position: { x: 3092, z: 3243, level: 0 }, skills: { Herblore: 60 }, bank: [{ id: 105, count: 2 }, { id: 241, count: 2 }] },
        pass: s => loggedOut(s) && /"made":2,"banked":2\b/.test(s),
    },
    {
        key: 'extra:supply-poison-dds',
        script: 'scripts/aio-skiller.ts',
        preset: 'bank_gems',
        scriptArgs: ['crafting', 'inventory', 'poison:dragon-dagger', 'MAX_MAKE=2', 'CAP=600', 'MEMBERS=1'],
        presetConfig: { position: { x: 3092, z: 3243, level: 0 }, skills: { Herblore: 60 }, bank: [{ id: 1215, count: 2 }, { id: 187, count: 2 }] },
        pass: s => loggedOut(s) && /"made":2,"banked":2\b/.test(s),
    },
    {
        key: 'extra:supply-prayer-potion',
        script: 'scripts/aio-skiller.ts',
        preset: 'bank_gems',
        scriptArgs: ['crafting', 'inventory', 'brew:3doseprayerrestore', 'MAX_MAKE=2', 'CAP=600', 'MEMBERS=1'],
        presetConfig: { position: { x: 3092, z: 3243, level: 0 }, skills: { Herblore: 38 }, bank: [{ id: 99, count: 2 }, { id: 231, count: 2 }] },
        pass: s => loggedOut(s) && /"made":2,"banked":2\b/.test(s),
    },
    {
        key: 'extra:supply-karambwan-cook',
        script: 'scripts/aio-skiller.ts',
        preset: 'bank_gems',
        scriptArgs: ['bank-job', `--job=${karambwanCookJob}`],
        presetConfig: { position: { x: 2809, z: 3441, level: 0 }, varps: { 322: 8 }, skills: { Cooking: 99 }, bank: [{ id: 3142, count: 3 }] },
        pass: s => loggedOut(s) && s.includes('"ok":true'),
    },
    {
        key: 'extra:supply-smith-rune-tips',
        script: 'scripts/aio-skiller.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['smithing', 'anvil', '600', 'PRODUCT_ID=44', 'MAX_MAKE=2', 'BAR_RESERVE=0'],
        presetConfig: { position: { x: 3185, z: 3436, level: 0 }, skills: { Smithing: 90 }, inventory: [{ id: 2347, count: 1 }], bank: [{ id: 2363, count: 2 }] },
        pass: s => ok(s) && /"made":2,"banked":30\b/.test(s),
    },
    {
        key: 'extra:supply-chaos-wine',
        script: 'scripts/gather-combat.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['2000', 'chaos_wine', 'MAX_KILLS=1', 'TELEGRAB_MAX=1', 'TELEGRAB_XP_MULTIPLIER=25'],
        presetConfig: { position: { x: 2946, z: 3368, level: 0 }, skills: { Magic: 99, Hitpoints: 99 }, inventory: [{ id: 563, count: 15 }, { id: 556, count: 15 }] },
        pass: s => ok(s) && /looted=1 /.test(s) && s.includes('COMBAT_TELEGRAB '),
    },
    {
        key: 'extra:supply-taverley-druid',
        script: 'scripts/gather-combat.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['2500', 'taverley_druid', 'MAX_KILLS=2'],
        presetConfig: {
            position: { x: 2946, z: 3368, level: 0 },
            skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99 },
            equipment: [{ id: 1333, count: 1, slot: 3 }],
            inventory: [{ id: 385, count: 5 }],
            bank: [{ id: 385, count: 10 }],
        },
        pass: s => ok(s) && /kills=2 /.test(s),
    },
    {
        key: 'extra:supply-taverley-scales',
        script: 'scripts/gather-combat.ts',
        preset: 'fresh_lumbridge',
        scriptArgs: ['2500', 'taverley_scales', 'MAX_KILLS=2'],
        presetConfig: {
            position: { x: 2946, z: 3368, level: 0 },
            skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99 },
            equipment: [{ id: 1540, count: 1, slot: 5 }],
            inventory: [{ id: 1590, count: 1 }, { id: 385, count: 5 }],
            bank: [{ id: 385, count: 10 }],
        },
        pass: s => ok(s) && /looted=2 /.test(s),
    },
];
