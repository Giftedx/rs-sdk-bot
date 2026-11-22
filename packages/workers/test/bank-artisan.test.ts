// Unified WorkerModule<ArtisanConfig> contract, preflight, estimate, outcome, and catalog tests.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createWorkerRegistry,
    isPreflightResult,
    isRateEstimate,
    isRunOutcome,
    isWorkerModule,
    validateWorkerModule,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    ARTISAN_METHOD_MAP,
    VALID_ARTISAN_SKILLS,
    artisanDbtablesCatalog,
    artisanEstimate,
    artisanPreflight,
    bankArtisanWorker,
    normalizeArtisanConfig,
    parseArtisanTokens,
    resolveArtisanSetting,
    runArtisan,
    runArtisanCli,
    toArtisanWorkerOutcome,
    type ArtisanConfig,
} from '../src/bank-artisan';
import { bankArtisanWorker as rootExportedArtisanWorker } from '../src';

function makeAccount(over: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'ArtisanTester',
        side: 'local',
        protectedClock: false,
        skills: {
            Attack: { level: 45, xp: 62_000 },
            Strength: { level: 45, xp: 62_000 },
            Defence: { level: 45, xp: 62_000 },
            Hitpoints: { level: 70, xp: 750_000 },
            Prayer: { level: 50, xp: 105_000 },
            Cooking: { level: 80, xp: 2_000_000 },
            Firemaking: { level: 75, xp: 1_210_421 },
            Fletching: { level: 85, xp: 3_300_000 },
            Smithing: { level: 85, xp: 3_300_000 },
            Crafting: { level: 85, xp: 3_300_000 },
            Herblore: { level: 65, xp: 450_000 },
            Magic: { level: 70, xp: 750_000 },
            Runecraft: { level: 50, xp: 105_000 },
        },
        quests: {
            'Throne of Miscellania': 'complete',
            'Nature Spirit': 'complete',
            'Tourist Trap': 'complete',
        },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        equipment: {},
        bank: {
            items: {
                995: 50_000, // Coins
                314: 500, // Feather
                317: 200, // Raw shrimps
                335: 200, // Raw trout
                377: 200, // Raw lobster
                383: 200, // Raw shark
                1987: 100, // Grapes
                1937: 100, // Jug of water
                590: 2, // Tinderbox
                1511: 200, // Logs
                1521: 200, // Oak logs
                946: 2, // Knife
                52: 500, // Arrow shafts
                53: 500, // Headless arrow
                39: 200, // Bronze arrowtips
                40: 200, // Iron arrowtips
                41: 200, // Steel arrowtips
                1777: 200, // Bow string
                1779: 200, // Flax
                440: 100, // Iron ore
                453: 300, // Coal
                2349: 100, // Bronze bar
                2351: 100, // Iron bar
                2353: 100, // Steel bar
                2357: 100, // Gold bar
                1607: 100, // Sapphire
                1623: 100, // Uncut sapphire
                1592: 1, // Ring mould
                1733: 1, // Needle
                1734: 100, // Thread
                1739: 50, // Cowhide
                1741: 10, // Leather
                1747: 50, // Black dragonhide
                1783: 100, // Bucket of sand
                1781: 100, // Soda ash
                1755: 1, // Chisel
                2347: 1, // Hammer
                4: 1, // Ammo mould
                434: 50, // Clay
                1925: 1, // Bucket
                526: 100, // Bones
                554: 500, // Fire rune
                555: 500, // Water rune
                556: 500, // Air rune
                557: 500, // Earth rune
                561: 500, // Nature rune
                563: 500, // Law rune
                564: 500, // Cosmic rune
                567: 100, // Unpowered orb
                1436: 100, // Rune essence
                227: 100, // Vial of water
                2136: 1, // Raw bear meat
                1929: 20, // Bucket of water
                1933: 20, // Pot of flour
                2313: 20, // Pie dish
                1953: 20, // Pastry dough
                2: 500, // Cannonball
            },
            observedAt: 1_000_000,
            trusted: true,
        },
        ...over,
    };
}

function makeWorld(acct: WorkerAccountView, over: Partial<WorkerWorldView> = {}): WorkerWorldView {
    return {
        at: 1_000_000,
        side: 'local',
        server: 'localhost:8888',
        accounts: { [acct.name]: acct },
        ...over,
    };
}

test('bankArtisanWorker satisfies WorkerModule contract, root barrel export, and registry queries', () => {
    expect(rootExportedArtisanWorker).toBe(bankArtisanWorker);
    expect(validateWorkerModule(bankArtisanWorker)).toEqual([]);
    expect(isWorkerModule(bankArtisanWorker)).toBe(true);
    expect(bankArtisanWorker.id).toBe('bank-artisan:unified');
    expect(bankArtisanWorker.family).toBe('bank-artisan');
    expect(bankArtisanWorker.kind).toBe('produce');
    expect(bankArtisanWorker.trust).toBe('practice_passed');
    expect(bankArtisanWorker.protectedAllowed).toBe(false);

    const reg = createWorkerRegistry([bankArtisanWorker]);
    expect(reg.size()).toBe(1);
    expect(reg.require('bank-artisan:unified')).toBe(bankArtisanWorker);
    expect(reg.list({ family: 'bank-artisan' })).toEqual([bankArtisanWorker]);
    expect(reg.list({ kind: 'produce', minTrust: 'practice_passed', protectedAllowed: false })).toEqual([bankArtisanWorker]);
    expect(reg.list({ minTrust: 'live_proven' })).toEqual([]);
    expect(VALID_ARTISAN_SKILLS).toContain('cooking');
    expect(ARTISAN_METHOD_MAP.smithing).toContain('cannonballs');
});

test('bank-artisan module and tests respect phase3 acyclic import and rcair boundaries', () => {
    const dir = join(import.meta.dir, '../src/bank-artisan');
    const files = ['index.ts', 'types.ts', 'preflight.ts', 'dispatch.ts', 'runtime.ts', 'catalog.ts', 'magic.ts', 'earth-production.ts'];
    for (const file of files) {
        const text = readFileSync(join(dir, file), 'utf8');
        const imports = [...text.matchAll(/^(?:import|export)\s+[^\n]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]!);
        for (const spec of imports) {
            expect(spec).not.toMatch(/packages\/router|autopilot|progression|rcair/);
        }
    }
    const dbtables = artisanDbtablesCatalog();
    expect(dbtables.cooking.length).toBeGreaterThan(0);
    expect(dbtables.cooking.some(c => c.uncooked.includes('trout'))).toBe(true);
});

test('parseArtisanTokens, normalizeArtisanConfig, and resolveArtisanSetting honor env precedence', () => {
    const parsed = parseArtisanTokens(['CAP=1200', 'iron', 'MAX_MAKE=28', 'extra']);
    expect(parsed.args).toEqual(['iron', 'extra']);
    expect(parsed.env).toEqual({ CAP: '1200', MAX_MAKE: '28' });

    const norm = normalizeArtisanConfig({
        skill: ' Cooking ' as any,
        method: ' FOOD ',
        args: ['500', 'FOOD_TYPE=shark', 'CAP=900'],
        env: { CAP: '1500' },
    });
    expect(norm.skill).toBe('cooking');
    expect(norm.method).toBe('food');
    expect(norm.args).toEqual(['500']);
    expect(resolveArtisanSetting(norm, 'FOOD_TYPE')).toBe('shark');
    expect(resolveArtisanSetting(norm, 'CAP')).toBe('1500');
    expect(resolveArtisanSetting(norm, 'MISSING', 'fallback')).toBe('fallback');
});

test('artisanPreflight admits valid artisan routes across all families and surfaces exact blockers', () => {
    const acct = makeAccount();
    const world = makeWorld(acct);

    const passConfigs: ArtisanConfig[] = [
        { skill: 'cooking', method: 'food', args: ['500', 'lobster'] },
        { skill: 'cooking', method: 'stock', env: { RAW_RESERVE: '50' } },
        { skill: 'cooking', method: 'wine', args: ['14'] },
        { skill: 'cooking', method: 'mixed-wine', args: ['14'] },
        { skill: 'cooking', method: 'batch', args: ['cooking_generic_trout'] },
        { skill: 'cooking', method: 'ge-cook', args: ['cooking_generic_trout', 'oak'] },
        { skill: 'firemaking', method: 'order', args: ['500', 'oak'] },
        { skill: 'fletching', method: 'shafts' },
        { skill: 'fletching', method: 'worker' },
        { skill: 'fletching', method: 'arrows', args: ['500', 'headless'] },
        { skill: 'fletching', method: 'arrows', args: ['500', 'oak-bows'] },
        { skill: 'fletching', method: 'arrows', args: ['500', 'steel'] },
        { skill: 'smithing', method: 'smelt', args: ['500', 'steel'] },
        { skill: 'smithing', method: 'cannonballs', args: ['10'] },
        { skill: 'smithing', method: 'anvil', args: ['500', '1205'] },
        { skill: 'crafting', method: 'bowstrings' },
        { skill: 'crafting', method: 'jewellery', args: ['sapphire_ring'] },
        { skill: 'crafting', method: 'jewellery-trip', env: { RECIPE: 'sapphire_ring', TARGET: '10' } },
        { skill: 'crafting', method: 'legacy-jewelry', args: ['500', 'cut', 'sapphire'] },
        { skill: 'crafting', method: 'glass' },
        { skill: 'crafting', method: 'tanning', args: ['soft', '5'] },
        { skill: 'crafting', method: 'black-dhide-sets', env: { PIECE: 'vambraces' } },
        { skill: 'crafting', method: 'soften-clay' },
        { skill: 'crafting', method: 'inventory', args: ['pie-shell'] },
        { skill: 'crafting', method: 'progressive', env: { MODE: 'fletch', TARGET_LEVEL: '20' } },
        { skill: 'herblore', method: 'potions', args: ['500', 'attack'] },
        { skill: 'herblore', method: 'meats' },
        { skill: 'prayer', method: 'bury' },
        { skill: 'magic', method: 'items', args: ['superheat:iron'] },
        { skill: 'magic', method: 'teleport', args: ['varrock'] },
        { skill: 'magic', method: 'orbs', args: ['air'] },
        { skill: 'magic', method: 'orbs-at-site', args: ['water'] },
        { skill: 'magic', method: 'bones' },
        { skill: 'magic', method: 'alch-train', args: ['65'], env: { ALCH_ITEM: 'feather' } },
        { skill: 'magic', method: 'earth-production', args: ['talismans'] },
        { skill: 'magic', method: 'earth-production', args: ['craft'] },
        { skill: 'foraging', method: 'miscellania-coffer', args: ['5000'] },
        { skill: 'foraging', method: 'care', args: ['miscellania'] },
        { skill: 'foraging', method: 'care', args: ['pouch'] },
        { skill: 'foraging', method: 'qol', args: ['run', '20'] },
        { skill: 'bank-job', method: 'run', args: ['--job=jobs/cook.json'] },
    ];

    for (const cfg of passConfigs) {
        const res = bankArtisanWorker.preflight(acct, cfg, world);
        expect(isPreflightResult(res)).toBe(true);
        expect({ cfg, res }).toMatchObject({ res: { ok: true } });
    }

    expect(artisanPreflight(acct, { skill: 'invalid' as any, method: 'food' }, world).ok).toBe(false);
    expect(artisanPreflight(acct, { skill: 'cooking', method: 'invalid' }, world).ok).toBe(false);
    expect(artisanPreflight(makeAccount({ protectedClock: true }), { skill: 'prayer', method: 'bury' }, world).blockers[0]?.kind).toBe('protected_clock');
    expect(artisanPreflight(makeAccount({ maxLevels: { Cooking: 75 } }), { skill: 'cooking', method: 'food' }, world).blockers[0]?.kind).toBe('max_level_cap');
    expect(artisanPreflight(acct, { skill: 'cooking', method: 'stock', env: { RAW_RESERVE: '10' } }, world).blockers[0]?.kind).toBe('invalid_config');
    expect(artisanPreflight(acct, { skill: 'bank-job', method: 'run', args: [] }, world).blockers[0]?.kind).toBe('invalid_config');
    expect(artisanPreflight(acct, { skill: 'smithing', method: 'anvil', args: ['500', 'bad'] }, world).blockers[0]?.kind).toBe('invalid_config');
    expect(artisanPreflight(acct, { skill: 'magic', method: 'items' }, world).blockers[0]?.kind).toBe('invalid_config');
    expect(artisanPreflight(acct, { skill: 'magic', method: 'orbs', args: ['chaos'] }, world).blockers[0]?.kind).toBe('invalid_config');
    expect(artisanPreflight(acct, { skill: 'magic', method: 'earth-production', args: ['unknown'] }, world).blockers[0]?.kind).toBe('invalid_config');
});

test('artisanPreflight checks Varrock-Al Kharid toll coins, missing supplies, skill gaps, quests, and combat safety', () => {
    const varrockPoor = makeAccount({
        pos: { x: 3253, z: 3420, level: 0 },
        bank: { items: { 440: 50, 453: 50, 995: 5 }, observedAt: 1, trusted: true },
    });
    const varrockRes = artisanPreflight(varrockPoor, { skill: 'smithing', method: 'smelt', args: ['500', 'iron'] }, makeWorld(varrockPoor));
    expect(varrockRes.ok).toBe(false);
    expect(varrockRes.travelCoins).toBe(10);
    expect(varrockRes.blockers.some(b => b.kind === 'missing_coins')).toBe(true);

    const varrockRich = makeAccount({ pos: { x: 3253, z: 3420, level: 0 } });
    const varrockOk = artisanPreflight(varrockRich, { skill: 'smithing', method: 'smelt', args: ['500', 'iron'] }, makeWorld(varrockRich));
    expect(varrockOk.ok).toBe(true);
    expect(varrockOk.travelCoins).toBe(10);

    const weakAccount = makeAccount({
        skills: { Cooking: { level: 1, xp: 0 }, Hitpoints: { level: 10, xp: 1154 } },
        quests: { 'Throne of Miscellania': 'not_started', 'Nature Spirit': 'started' },
        bank: { items: {}, observedAt: 1, trusted: true },
    });
    const weakWorld = makeWorld(weakAccount);

    expect(artisanPreflight(weakAccount, { skill: 'cooking', method: 'food', args: ['500', 'shark'] }, weakWorld).blockers.some(b => b.kind === 'skill_level')).toBe(true);
    expect(artisanPreflight(weakAccount, { skill: 'firemaking', method: 'order', env: { TOOL_BUDGET: '50' } }, weakWorld).missingItems?.some(m => m.itemId === 590)).toBeFalsy();
    expect(artisanPreflight(weakAccount, { skill: 'herblore', method: 'meats' }, weakWorld).blockers[0]?.kind).toBe('combat_survivability');
    expect(artisanPreflight(weakAccount, { skill: 'foraging', method: 'miscellania-coffer', args: ['10'] }, weakWorld).blockers[0]?.kind).toBe('quest_incomplete');
    expect(artisanPreflight(weakAccount, { skill: 'foraging', method: 'care', args: ['pouch'] }, weakWorld).blockers[0]?.kind).toBe('quest_incomplete');

    const highMagic = makeAccount({
        skills: { Magic: { level: 60, xp: 300_000 } },
        bank: { items: {}, observedAt: 1, trusted: true },
    });
    expect(artisanPreflight(highMagic, { skill: 'magic', method: 'alch-train', args: ['55'], env: { ALCH_ITEM: 'feather' } }, makeWorld(highMagic)).ok).toBe(true);
});

test('artisanEstimate returns valid RateEstimate shapes across artisan skills', () => {
    const acct = makeAccount();
    const world = makeWorld(acct);
    const lowMagic = makeAccount({ skills: { Magic: { level: 25, xp: 7842 } } });

    const cases: [WorkerAccountView, ArtisanConfig][] = [
        [acct, { skill: 'cooking', method: 'food', args: ['500', 'lobster'] }],
        [acct, { skill: 'cooking', method: 'wine' }],
        [acct, { skill: 'firemaking', method: 'order', args: ['500', 'magic'] }],
        [acct, { skill: 'fletching', method: 'shafts' }],
        [acct, { skill: 'fletching', method: 'arrows' }],
        [acct, { skill: 'smithing', method: 'smelt' }],
        [acct, { skill: 'smithing', method: 'anvil' }],
        [acct, { skill: 'smithing', method: 'cannonballs' }],
        [acct, { skill: 'crafting', method: 'bowstrings' }],
        [acct, { skill: 'crafting', method: 'jewellery' }],
        [acct, { skill: 'herblore', method: 'potions' }],
        [acct, { skill: 'herblore', method: 'meats' }],
        [acct, { skill: 'prayer', method: 'bury' }],
        [lowMagic, { skill: 'magic', method: 'alch-train' }],
        [acct, { skill: 'magic', method: 'alch-train' }],
        [acct, { skill: 'magic', method: 'orbs' }],
        [acct, { skill: 'magic', method: 'teleport' }],
        [acct, { skill: 'foraging', method: 'care' }],
        [acct, { skill: 'bank-job', method: 'run', args: ['job.json'] }],
    ];

    for (const [a, cfg] of cases) {
        const est = bankArtisanWorker.estimate(a, cfg, world);
        expect(isRateEstimate(est)).toBe(true);
    }

    expect(artisanEstimate(lowMagic, { skill: 'magic', method: 'alch-train' }, world).xpPerTick).toBeLessThan(
        artisanEstimate(acct, { skill: 'magic', method: 'alch-train' }, world).xpPerTick,
    );
    expect(artisanEstimate(acct, { skill: 'firemaking', method: 'order', args: ['500', 'magic'] }, world).xpPerTick).toBe(75.0);
});

test('toArtisanWorkerOutcome classifies target_met, death, missing_supply, location_stranded, and worker_defect', () => {
    const cfg = normalizeArtisanConfig({ skill: 'cooking', method: 'food' });
    expect(toArtisanWorkerOutcome({ ok: true, summary: 'cooked=28', ticks: 90, produced: 28 }, 'Acc', cfg, 10).kind).toBe('target_met');
    expect(toArtisanWorkerOutcome({ ok: false, summary: 'player died', ticks: 12, produced: 0, failure: 'died' }, 'Acc', cfg, 10).kind).toBe('death');
    expect(toArtisanWorkerOutcome({ ok: false, summary: 'short', ticks: 12, produced: 0, failure: 'insufficient raw supplies' }, 'Acc', cfg, 10).kind).toBe('missing_supply');
    expect(toArtisanWorkerOutcome({ ok: false, summary: 'blocked', ticks: 12, produced: 0, failure: 'walk unreachable stair' }, 'Acc', cfg, 10).kind).toBe('location_stranded');
    expect(toArtisanWorkerOutcome({ ok: false, summary: 'crash', ticks: 0, produced: 0, failure: 'unexpected error' }, 'Acc', cfg, 25)).toMatchObject({
        kind: 'worker_defect',
        activityId: 'bank-artisan:cooking:food',
        ticksElapsed: 25,
    });

    const bjCfg = normalizeArtisanConfig({ skill: 'bank-job', method: 'run' });
    expect(toArtisanWorkerOutcome({ ok: true, summary: 'ok', ticks: 5, produced: 1 }, 'Acc', bjCfg, 5).activityId).toBe('bank-artisan:bank-job');
});

test('runArtisan, runArtisanCli, and bankArtisanWorker.run handle invalid config and bank-job outcomes', async () => {
    const mockSession: any = {
        name: 'Tester',
        tick: () => 10,
        ended: new Promise(() => {}),
        sdk: { getState: () => ({ player: { lifeId: 1 } }), getSkill: () => ({ level: 99 }), getInventory: () => [] },
        bot: {},
    };

    expect((await runArtisan(mockSession, { skill: 'nope' as any, method: 'x' })).failure).toBe('invalid_config');
    expect((await runArtisan(mockSession, { skill: 'cooking', method: 'nope' })).failure).toBe('invalid_config');
    await expect(runArtisanCli('Tester', { skill: 'nope' as any, method: 'x' })).rejects.toThrow('unknown artisan skill');
    await expect(runArtisanCli('Tester', { skill: 'cooking', method: 'nope' })).rejects.toThrow('unknown cooking method');

    const dir = mkdtempSync(join(tmpdir(), 'bank-artisan-unit-'));
    try {
        const jobPath = join(dir, 'job.json');
        writeFileSync(jobPath, JSON.stringify({ recipe: 'trout', batch: 14 }));

        const okOutcome = await bankArtisanWorker.run(mockSession, {
            skill: 'bank-job',
            method: 'run',
            args: [`--job=${encodeURIComponent(JSON.stringify({ recipe: 'trout', batch: 14 }))}`],
            deps: {
                validateBankJob: j => {
                    expect((j as any).recipe).toBe('trout');
                },
                runBankJob: async () => ({ ok: true, completed: 14, trips: 1, atBank: true, failure: '' }),
            },
        });
        expect(isRunOutcome(okOutcome)).toBe(true);
        expect(okOutcome).toMatchObject({
            kind: 'target_met',
            activityId: 'bank-artisan:bank-job',
            account: 'Tester',
            unitsCompleted: 14,
        });

        const failOutcome = await bankArtisanWorker.run(mockSession, {
            skill: 'bank-job',
            method: 'run',
            args: [jobPath],
            deps: {
                runBankJob: async () => ({ ok: false, completed: 0, trips: 0, atBank: true, failure: 'missing supplies in bank' }),
            },
        });
        expect(failOutcome.kind).toBe('missing_supply');
    } finally {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
});
