import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objPackIdSet, packMap, parsePackNameToId } from '../src/bank-artisan/catalog';
import { cookingRecipes } from '../src/bank-artisan/cooking';
import { HERBLORE_SPECIALIST_KIT, MAGIC_SPECIALIST_KIT } from '../src/logistics/specialist-supply';
import {
    ITEMS,
    SPELLS,
    bestFood,
    canCastChargeNow,
    castableFreeze,
    dangerReason,
    escapeCastable,
    getObjNames,
    isMulti,
    newSplats,
} from '../src/pvp/fight';
import { nativePvpSpell, validatePvpPlan } from '../src/pvp/microbot-pvp';
import { ThreatWatch, refineProtectActions } from '../src/pvp/pk-threat';
import { presetConfig, questPresetKeys, registerQuestPresets } from '../src/quest/presets';
import { questSpec } from '../src/quest/order';
import {
    guardianEmptyCrossbowSpec,
    guardianMagePose,
    guardianSaraAttackRange,
    guardianSaraLandingTail,
    guardianSaraMeleeLimit,
} from '../src/quest/clue-guardian-travel';
import {
    combatMagicRecipe,
    cowFoodPick,
    groundLootEffect,
    hasVarrockTeleport,
    planWildernessEscape,
    selectGreenDragon,
    selectGroundLoot,
} from '../src/combat/survivability';
import { nativeCombatTeleport } from '../src/combat/magic';
import { KBD_KIT, validateCombatKit } from '../src/combat/trip-kit';
import { loadGeItemCatalogue } from '../src/market/ge-common';
import { bankSellerCatalogue } from '../src/market/ge-bulk';
import { nativeMerchant, validateShopTrip } from '../src/market/shop-sell';
import { contentUnitBound, shopRules } from '../src/market/shop-price';
import { derivedProfile } from '../src/market/shop-profiles';
import { PROFILES, planShopPurchases, shopTargetsMet } from '../src/market/shop-buy';
import { contentSites, pathSteps, siteRocks } from '../src/gather/mining-rotation';
import { miningProfiles } from '../src/gather/mining';
import { nativeSmeltStands, smeltBonusRawXp, smeltRecipe, smithRecipe } from '../src/bank-artisan/smithing';
import { nativeArrowProfile } from '../src/bank-artisan/fletching';
import { itemMagicRecipe, nativeTeleport, orbGloryList, orbPackEffect, ownedOrbStaff, teleportReceipt } from '../src/bank-artisan/magic';
import { inventoryRecipes } from '../src/bank-artisan/crafting-production';
import { jewelleryRecipes } from '../src/bank-artisan/crafting';
import { bankDonorKey } from '../src/logistics/stage';
import { monitorGloryProfile, monitorWildernessLevel } from '../src/pvp/monitor';
import { pickSquadFocus, squadTarget } from '../src/pvp/squad';
import { Spells } from '../../../vendor/rs-sdk/sdk/spells';
import { retainedRecoveryTasks } from '../../../scripts/cloud-recover';
import type { Member, ThreatClass } from '../../core/src/pvp-threat';

const tempDirs: string[] = [];
afterEach(() => {
    registerQuestPresets(null);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

test('pvp/fight hot-loop helpers preserve food, danger, multi-way, splat, and spell semantics', () => {
    const foodInv = [
        { name: 'Rune platebody', optionsWithIndex: [{ text: 'Wear' }] },
        { name: 'Trout', optionsWithIndex: [{ text: 'Eat' }] },
        { name: 'Mystery cake', optionsWithIndex: [{ text: 'Use' }, { text: 'Eat' }] },
        { name: 'Shark', optionsWithIndex: [{ text: 'Eat' }] },
    ];
    expect(bestFood(foodInv)?.name).toBe('Shark');
    expect(bestFood(foodInv.slice(0, 3))?.name).toBe('Trout');
    expect(bestFood([foodInv[2]!])?.name).toBe('Mystery cake');
    expect(bestFood([foodInv[0]!])).toBeUndefined();

    expect(
        dangerReason({ hp: 20, maxHp: 99, food: false, prayer: 50, oppMax: 20, hits: [], dealt: [], now: 100 }),
    ).toBe('no food at HP 20');
    expect(
        dangerReason({
            hp: 90,
            maxHp: 99,
            food: true,
            prayer: 50,
            oppMax: 20,
            hits: [
                { tick: 95, damage: 5, src: 2 },
                { tick: 96, damage: 4, src: 3 },
                { tick: 97, damage: 2, src: 4 },
            ],
            dealt: [],
            now: 100,
        }),
    ).toBe('3 players hitting');
    expect(
        dangerReason({
            hp: 45,
            maxHp: 99,
            food: true,
            prayer: 50,
            oppMax: 20,
            hits: [{ tick: 90, damage: 32, src: 2 }],
            dealt: [{ tick: 90, damage: 10 }],
            now: 100,
        }),
    ).toBe('losing the race: took 32, dealt 10');
    expect(
        dangerReason({ hp: 40, maxHp: 99, food: true, prayer: 0, oppMax: 20, hits: [], dealt: [], now: 100 }),
    ).toBe('no prayer points');
    expect(
        dangerReason({ hp: 90, maxHp: 99, food: true, prayer: 50, oppMax: 20, hits: [{ tick: 99, damage: 5, src: 1 }], dealt: [], now: 100 }),
    ).toBeNull();

    expect(
        castableFreeze(85, [
            { id: ITEMS.earthRune, count: 5 },
            { id: ITEMS.waterRune, count: 5 },
            { id: ITEMS.natureRune, count: 4 },
        ]),
    ).toBe(SPELLS.entangle);
    expect(
        castableFreeze(85, [
            { id: ITEMS.earthRune, count: 4 },
            { id: ITEMS.waterRune, count: 4 },
            { id: ITEMS.natureRune, count: 3 },
        ]),
    ).toBe(SPELLS.snare);
    expect(
        castableFreeze(45, [
            { id: ITEMS.earthRune, count: 3 },
            { id: ITEMS.waterRune, count: 3 },
            { id: ITEMS.natureRune, count: 2 },
        ]),
    ).toBe(SPELLS.bind);

    expect(
        canCastChargeNow(
            80,
            [
                { id: ITEMS.fireRune, count: 3 },
                { id: ITEMS.bloodRune, count: 3 },
                { id: ITEMS.airRune, count: 3 },
            ],
            0,
        ),
    ).toBe(true);
    expect(
        canCastChargeNow(
            80,
            [
                { id: ITEMS.fireRune, count: 3 },
                { id: ITEMS.bloodRune, count: 3 },
                { id: ITEMS.airRune, count: 3 },
            ],
            12,
        ),
    ).toBe(false);
    expect(
        escapeCastable(
            Spells.VARROCK_TELEPORT,
            [
                { id: ITEMS.fireRune, count: 1 },
                { id: ITEMS.airRune, count: 3 },
                { id: ITEMS.lawRune, count: 1 },
            ],
            [],
            25,
        ),
    ).toBe(true);
    expect(escapeCastable(Spells.VARROCK_TELEPORT, [], [], 25)).toBe(false);

    const splatSeen: { cycles: number[] | null } = { cycles: null };
    const client = { players: [null, { damageCycles: [1, 0, 0, 0], damageValues: [12, 0, 0, 0] }] };
    expect(newSplats(client, 1, splatSeen)).toEqual([]);
    client.players[1] = { damageCycles: [1, 5, 0, 0], damageValues: [12, 24, 0, 0] };
    expect(newSplats(client, 1, splatSeen)).toEqual([24]);
    expect(newSplats(client, 2, splatSeen)).toBeNull();

    const customRoot = makeTempDir('multi-root-');
    mkdirSync(join(customRoot, 'vendor/rs-sdk/server/content/maps'), { recursive: true });
    writeFileSync(join(customRoot, 'vendor/rs-sdk/server/content/maps/multiway.csv'), '// comment\n0_50_50_8_16\n1_50_50_0_0\n');
    expect(isMulti((50 << 6) + 8, (50 << 6) + 16, customRoot)).toBe(true);
    expect(isMulti((50 << 6) + 0, (50 << 6) + 0, customRoot)).toBe(false);
    expect(isMulti(3070, 3640)).toBe(true);
    expect(isMulti(3222, 3222)).toBe(false);

    expect(getObjNames().get(ITEMS.shark)).toBe('shark');
});

test('pvp/pk-threat refineProtectActions and ThreatWatch adapt forgetting work across ticks', () => {
    const members: Member[] = [{ name: 'Ours1', x: 3070, z: 3640, combat: 126, prayer: 50, prayerLevel: 99, hp: 99, food: 8 }];
    const farMelee: ThreatClass = {
        record: {
            name: 'MeleeFar',
            combat: 126,
            tick: 10,
            x: 3076,
            z: 3640,
            wild: 16,
            multi: false,
            inView: true,
            worn: { weapon: 1333 },
            protect: [],
            skulled: false,
            nearest: { member: 'Ours1', dist: 6 },
            closing: true,
            speed: 1,
            styles: ['melee'],
            lastAttack: { style: 'melee', tick: 9 },
            weaponStyle: 'melee',
            targeting: null,
        },
        style: 'melee',
        cover: 'melee',
        by: 'attack',
        canHit: ['Ours1'],
        dangerous: true,
    };
    const closeMage: ThreatClass = {
        ...farMelee,
        record: {
            ...farMelee.record,
            name: 'MageTarget',
            x: 3074,
            worn: { weapon: 4675 },
            styles: ['magic'],
            lastAttack: { style: 'magic', tick: 10 },
            weaponStyle: 'magic',
            targeting: 'Ours1',
        },
        style: 'magic',
        cover: 'magic',
    };
    const refined = refineProtectActions(
        [farMelee, closeMage],
        members,
        [
            { kind: 'protect', member: 'Ours1', style: 'melee', reason: 'initial' },
            { kind: 'kit', member: 'Ours1', style: 'melee', wear: [1127], gain: 20, reason: 'old' },
        ],
        () => ({ wear: [2503], gain: 18 }),
    );
    expect(refined).toEqual([
        { kind: 'protect', member: 'Ours1', style: 'magic', reason: 'MageTarget magic by attack, 4 tiles' },
        { kind: 'kit', member: 'Ours1', style: 'magic', wear: [2503], gain: 18, reason: 'MageTarget magic: wear 2503 (+18)' },
    ]);

    let visible = true;
    const logs: string[] = [];
    const session = {
        name: 'Ours1',
        client: {
            localPlayer: null as unknown,
            players: [
                null,
                { name: 'Ours1' },
                { name: 'Rival', appearance: [], headicons: 0, primaryAnim: -1, spotanimId: -1 },
            ],
        },
        sdk: {
            getState: () => ({
                player: { name: 'Ours1', worldX: 3070, worldZ: 3640, combatLevel: 126, isDead: false, hp: 99 },
                nearbyPlayers: visible
                    ? [{ index: 2, name: 'Rival', combatLevel: 126, x: 3073, z: 3640, distance: 3 }]
                    : [],
                prayers: { activePrayers: [], prayerPoints: 50 },
            }),
            getEquipment: () => [],
            getInventory: () => [],
            getSkill: () => ({ level: 99 }),
        },
    };
    (session.client as { localPlayer: unknown }).localPlayer = session.client.players[1];
    const watch = new ThreatWatch({
        sessions: () => [session as never],
        server: 'demo.example:43594',
        friends: new Set(['ours1']),
        log: line => logs.push(line),
        recordRoot: false,
    });
    watch.step(1);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(1);
    watch.step(2);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(1);
    visible = false;
    watch.step(3);
    visible = true;
    watch.step(4);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(2);
});

test('lazy catalog, cooking, presets, specialist kits, and microbot-pvp preserve contracts', () => {
    const parsed = parsePackNameToId('1=first\r\n2=second\nbad\n3=third\n');
    expect(parsed.get('first')).toBe(1);
    expect(parsed.get('second')).toBe(2);
    expect(parsed.get('third')).toBe(3);

    expect(packMap('obj').get('shark')).toBe(385);
    expect(objPackIdSet().has(385)).toBe(true);
    expect(cookingRecipes().recipes.length).toBeGreaterThan(20);

    const keys = questPresetKeys();
    expect(keys.length).toBeGreaterThan(0);
    const firstKey = keys[0]!;
    expect(presetConfig(firstKey)).toBeDefined();
    registerQuestPresets({ [firstKey]: { quest: 'custom-override' } as never });
    expect(presetConfig(firstKey)).toEqual({ quest: 'custom-override' } as never);

    expect(HERBLORE_SPECIALIST_KIT.some(i => i.id === 221 && i.name === 'Eye of newt')).toBe(true);
    expect(MAGIC_SPECIALIST_KIT.some(i => i.id === 385 && i.name === 'Shark')).toBe(true);

    expect(nativePvpSpell('fire_wave').maximum).toBeGreaterThan(0);
    expect(validatePvpPlan({ cap: 10, hpFloor: 50, steps: [{ kind: 'tank' }] }).cap).toBe(10);
});

test('cloud-recover retainedRecoveryTasks deduplicates archive, keeps current order, and sees archive updates', () => {
    const root = makeTempDir('recover-archive-');
    const archiveDir = join(root, '.practice/coordinator/archive');
    mkdirSync(archiveDir, { recursive: true });
    const archive = join(archiveDir, 'tasks.jsonl');

    const failedTask = {
        status: 'failed',
        runId: 'run-1',
        receipt: { ok: false, error: 'boom' },
        spec: { id: 'recover-1', kind: 'run', capability: 'session-recovery-only' },
    };
    const runningTask = {
        status: 'running',
        runId: 'run-1',
        spec: { id: 'recover-1', kind: 'run', capability: 'session-recovery-only' },
    };
    const currentTask = {
        status: 'pending',
        createdAt: 123,
        spec: { id: 'recover-2', kind: 'qualify', capability: 'session-recovery-only' },
    };

    writeFileSync(archive, JSON.stringify(failedTask) + '\n');
    const out1 = retainedRecoveryTasks(root, [runningTask, currentTask]);
    expect(out1.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:pending']);

    // Repeat identical archive read (cache hit) preserves output and conflict detection.
    const out2 = retainedRecoveryTasks(root, [runningTask, currentTask]);
    expect(out2.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:pending']);
    expect(() =>
        retainedRecoveryTasks(root, [{ ...failedTask, status: 'succeeded' }]),
    ).toThrow('recovery outcome archive conflict');

    // Rewriting archive invalidates cache immediately.
    const secondArchived = {
        status: 'succeeded',
        runId: 'run-2',
        receipt: { ok: true, output: null },
        spec: { id: 'recover-2', kind: 'qualify', capability: 'session-recovery-only' },
    };
    writeFileSync(archive, JSON.stringify(failedTask) + '\n' + JSON.stringify(secondArchived) + '\n');
    const out3 = retainedRecoveryTasks(root, []);
    expect(out3.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:succeeded']);
});

test('combat survivability, trip-kit, and magic cached lookups and selectors preserve exact tie-breaking and cloning', () => {
    // cowFoodPick prefers lowest bite count (partial cake over full cake)
    expect(cowFoodPick([{ id: 995 }, { id: 1891 }, { id: 1895 }, { id: 1893 }])?.id).toBe(1895);
    expect(cowFoodPick([{ id: 995 }])).toBeUndefined();

    // selectGroundLoot skips conflicting counts at same tile and breaks ties by value desc, distance asc, order asc
    const lootState: any = {
        inventory: [],
        groundItems: [
            { id: 526, name: 'Bones', count: 1, x: 3200, z: 3200, distance: 1, reachable: true },
            { id: 526, name: 'Bones', count: 2, x: 3200, z: 3200, distance: 1, reachable: true }, // conflict on (526,3200,3200)
            { id: 536, name: 'Dragon bones', count: 1, x: 3202, z: 3200, distance: 4, reachable: true },
            { id: 536, name: 'Dragon bones', count: 1, x: 3201, z: 3200, distance: 2, reachable: true },
            { id: 536, name: 'Dragon bones', count: 1, x: 3205, z: 3205, distance: 1, reachable: true }, // player adjacent
        ],
        nearbyPlayers: [{ x: 3205, z: 3204 }],
    };
    const lootPolicy: any = { ids: [526, 536], names: [], minimumValue: 1, maximumValue: 10000, radius: 8, maximumUnits: 28, cap: 100, idleTicks: 50 };
    const lootDef = (id: number) => ({ name: id === 536 ? 'Dragon bones' : 'Bones', cost: id === 536 ? 500 : 10, stackable: false });
    const pickedLoot = selectGroundLoot(lootState, lootPolicy, lootDef, 28);
    expect(pickedLoot?.item.x).toBe(3201);
    expect(pickedLoot?.value).toBe(500);

    // groundLootEffect exact delta parity
    const invBefore: any = { inventory: [{ id: 995, count: 10 }] };
    const invSame: any = { inventory: [{ id: 995, count: 10 }] };
    const invAfter: any = { inventory: [{ id: 995, count: 10 }, { id: 536, count: 1 }] };
    const invBad: any = { inventory: [{ id: 995, count: 9 }, { id: 536, count: 1 }] };
    const groundBone: any = { id: 536, count: 1 };
    expect(groundLootEffect(invBefore, invSame, groundBone)).toBe(false);
    expect(groundLootEffect(invBefore, invAfter, groundBone)).toBe(true);
    expect(() => groundLootEffect(invBefore, invBad, groundBone)).toThrow('reconcile');

    // selectGreenDragon prioritizes dragon already targeting self, then nearest
    const dragons: any[] = [
        { id: 941, distance: 2, hp: 50, inCombat: false, targetIndex: -1, reachable: true },
        { id: 941, distance: 6, hp: 50, inCombat: true, targetIndex: 32768 + 4, reachable: true },
        { id: 941, distance: 1, hp: 50, inCombat: true, targetIndex: 32768 + 9, reachable: true },
    ];
    expect(selectGreenDragon(dragons, 4)?.distance).toBe(6);
    expect(selectGreenDragon(dragons, 1)?.distance).toBe(2);

    // planWildernessEscape & hasVarrockTeleport parity
    expect(planWildernessEscape({ x: 3150, z: 3925 }, { glory: true, teleport: false }).kind).toBe('lever');
    expect(planWildernessEscape({ x: 3094, z: 3957 }, { glory: false, teleport: false }).web?.id).toBe(733);
    expect(hasVarrockTeleport(25, [{ name: 'Law rune', count: 1 }, { name: 'Fire rune', count: 1 }], [{ name: 'Staff of air' }])).toBe(true);
    expect(hasVarrockTeleport(24, [{ name: 'Law rune', count: 1 }, { name: 'Fire rune', count: 1 }], [{ name: 'Staff of air' }])).toBe(false);

    // Lazy items.json combatMagicRecipe, cached nativeCombatTeleport defensive clone, and cached validateCombatKit
    const alch = combatMagicRecipe('high-alch', 'yew_longbow');
    expect(alch.output).toBeGreaterThan(0);
    const tp1 = nativeCombatTeleport('varrock');
    tp1.runes[554] = 999;
    tp1.to.x = 0;
    const tp2 = nativeCombatTeleport('varrock');
    expect(tp2.runes[554]).toBe(1);
    expect(tp2.to.x).toBeGreaterThan(3000);
    expect(validateCombatKit(KBD_KIT)).toEqual([
        { skill: 'Attack', level: 40 },
        { skill: 'Defence', level: 40 },
        { skill: 'Defence', level: 40 },
    ]);
});

test('market cached catalogues, shop-sell indexing, shop-price, shop-profiles, and shop-buy preserve exact contracts', () => {
    const cat1 = loadGeItemCatalogue();
    const len1 = cat1.length;
    cat1.pop();
    const cat2 = loadGeItemCatalogue();
    expect(cat2.length).toBe(len1);
    expect(cat2.length).toBeGreaterThan(1000);
    expect(bankSellerCatalogue().length).toBeGreaterThan(cat2.length);

    const m = nativeMerchant('alkharid-general');
    expect(m.title).toBe('Al-Kharid General Store');
    expect(validateShopTrip({
        merchant: 'alkharid-general',
        item: 1511,
        target: 10,
        batch: 28,
        minimumUnit: 1,
        cap: 1000,
        returnTicks: 100,
        members: false,
        bank: { x: 3269, z: 3167, level: 0 },
        site: { x: 3314, z: 3180, level: 0 },
    } as any).npc).toBe(m.npc);

    const rules = shopRules(PROFILES.aubury!.npc, PROFILES.aubury!.npcSpot);
    expect(rules.length).toBeGreaterThan(0);
    expect(contentUnitBound(rules, 'Air rune')).toBeGreaterThan(0);

    const p1 = derivedProfile('generalshop1');
    expect(p1).toBeDefined();
    const itemCount = p1!.items.length;
    p1!.items.pop();
    const p2 = derivedProfile('generalshop1');
    expect(p2).toBeDefined();
    expect(p2!.items.length).toBe(itemCount);

    const targets = PROFILES.aubury!.items;
    const stock = [
        { name: 'Fire rune', count: 50, buyPrice: 4 },
        { name: 'Air rune', count: 50, buyPrice: 4 },
    ];
    const plan = planShopPurchases(targets, stock, [{ name: 'Coins', count: 1000 }], new Map([['air rune', 498]]), 1000, 500, 10);
    expect(plan).toEqual([
        { name: 'Air rune', amount: 2 },
        { name: 'Fire rune', amount: 8 },
    ]);
    expect(shopTargetsMet([{ re: /^air rune$/i, buyPerTick: 50 }], [{ name: 'Air rune', count: 2 }], new Map([['air rune', 498]]), 500)).toBe(true);
    expect(shopTargetsMet([{ re: /^air rune$/i, buyPerTick: 50 }], [{ name: 'Air rune', count: 1 }], new Map([['air rune', 498]]), 500)).toBe(false);
});

test('gather mining-rotation square-indexed rocks, integer BFS, artisan recipes, logistics donor keys, pvp focus, and quest caches preserve parity', () => {
    // Mining rotation: square-scoped siteRocks matches full-map contentSites
    const iron = miningProfiles().find(p => p.name === 'iron_rock_table')!;
    const zooRocks = siteRocks(iron, { x: 2603, z: 3235, level: 0 }, 3);
    expect(zooRocks.map(r => `${r.x},${r.z}`)).toEqual(['2602,3233', '2602,3234', '2602,3236', '2605,3233', '2605,3235', '2605,3237']);
    const sites = contentSites(iron);
    expect(sites.reduce((n, s) => n + s.rocks.length, 0)).toBe(siteRocks(iron, { x: 0, z: 0, level: 0 }, 99999).length);
    expect(pathSteps({ x: 2603, z: 3235 }, zooRocks[0]!, zooRocks)).toBe(2);

    // Artisan smithing, fletching, magic, crafting caches & cloning
    expect(smeltRecipe('steel').product).toBe(2353);
    expect(smeltBonusRawXp({ kind: 'goldsmith', xpRate: 1 })).toBeGreaterThan(0);
    expect(smithRecipe(1277).bar).toBe(2349);
    const stands1 = nativeSmeltStands({ id: 2781, x: 2856, z: 2966, level: 0 });
    stands1[0]!.x = 0;
    const stands2 = nativeSmeltStands({ id: 2781, x: 2856, z: 2966, level: 0 });
    expect(stands2[0]!.x).toBeGreaterThan(2800);
    expect(nativeArrowProfile('steel').units).toBe(15);

    const alch1 = itemMagicRecipe('high-alch', 'yew_longbow');
    alch1.inputs[561] = 999;
    expect(itemMagicRecipe('high-alch', 'yew_longbow').inputs[561]).toBe(1);
    const mtp1 = nativeTeleport('varrock');
    mtp1.runes[563] = 999;
    expect(nativeTeleport('varrock').runes[563]).toBe(1);
    expect(teleportReceipt(mtp1, { 554: 1 }, { 554: 2 }, { 554: 1 }, 100, 135, { worldX: mtp1.to.x, worldZ: mtp1.to.z, level: mtp1.to.level })).toBe(true);
    expect(ownedOrbStaff([{ id: 1387, count: 1 }, { id: 1381, count: 1 }], 556, 'owned')).toBe(1381);
    expect(orbGloryList().length).toBeGreaterThan(0);
    expect(orbPackEffect({ 567: 1 }, { 567: 0, 571: 1 }, { 567: -1, 571: 1 })).toBe(true);
    expect(inventoryRecipes().length).toBeGreaterThan(10);
    expect(jewelleryRecipes().length).toBeGreaterThan(10);

    // Logistics bankDonorKey indexed lookup parity
    expect(bankDonorKey({ slot: 0, id: 1275, count: 1, name: 'Rune pickaxe' }).category).toBe('Tool-Pickaxe');
    expect(bankDonorKey({ slot: 1, id: 1275, count: 1, name: 'Rune pickaxe' }).tier).toBe(41);
    expect(bankDonorKey({ slot: 2, id: 995, count: 100, name: 'Coins' }).category).toBe('Currency');

    // PvP monitor lazy loaders and squad single-pass selectors
    expect(monitorWildernessLevel({ worldX: 3070, worldZ: 3640, level: 0 })).toBe(16);
    expect(monitorGloryProfile('Edgeville', 1712).next).toBe(1710);
    const view = [
        { name: 'Alpha', index: 1, distance: 4, x: 3070, z: 3640, combatLevel: 120, inCombat: false },
        { name: 'Beta', index: 2, distance: 6, x: 3070, z: 3640, combatLevel: 120, inCombat: false },
        { name: 'Gamma', index: 3, distance: 2, x: 3070, z: 3640, combatLevel: 120, inCombat: false },
    ];
    const targetSet = new Set(['alpha', 'beta', 'gamma']);
    const hpMap: Record<string, number> = { Alpha: 0.5, Beta: 0.54, Gamma: 0.4 };
    expect(squadTarget(view, targetSet, p => hpMap[p.name]!, new Set(['gamma']), { z: 3640, combatLevel: 120 })?.name).toBe('Alpha');
    expect(
        pickSquadFocus({
            view,
            targets: targetSet,
            health: p => hpMap[p.name]!,
            priority: new Set(['beta']),
            me: { x: 3070, z: 3640, combatLevel: 120 },
            inMulti: true,
            preferMulti: true,
        })?.name,
    ).toBe('Beta');
    // Active focus hysteresis (< 0.08 HP difference)
    expect(
        pickSquadFocus({
            view: view.slice(0, 2),
            targets: targetSet,
            health: p => hpMap[p.name]!,
            activeFocus: 'Beta',
            me: { x: 3070, z: 3640, combatLevel: 120 },
            inMulti: true,
        })?.name,
    ).toBe('Beta');

    // Quest order & clue-guardian-travel caches
    expect(questSpec('cook').questPoints).toBe(1);
    expect(guardianSaraAttackRange()).toBe(5);
    expect(guardianSaraLandingTail()).toBe(3);
    expect(guardianSaraMeleeLimit().maximum).toBe(14);
    const cb1 = guardianEmptyCrossbowSpec();
    cb1.item = 0;
    expect(guardianEmptyCrossbowSpec().item).toBe(837);
    expect(guardianMagePose({ animId: -1 })).toBe(false);
});
