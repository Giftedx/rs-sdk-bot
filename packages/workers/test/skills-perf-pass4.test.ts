import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { WorkerAccountView, WorkerWorldView } from '../src/contracts';
import {
    ARROWS,
    BOWS,
    GIANT_ARROWS,
    GIANT_BOWS,
    LOWE_ARROWS,
    bestBow,
    bestElementalStaffForRunes,
    canWearGear,
    chooseArrow,
    crossedTierBoundary,
    gearById,
    gearIdByName,
    selectCombatLoadout,
    selectGiantArmour,
    usableArrows,
} from '../src/combat/gear';
import { loadGear } from '../../knowledge/src/gear-query';
import { chickenCombatUnlockPlan, chickenDesiredSkill } from '../src/combat/chickens';
import { levelsMet, parseLevels, parsePhases, pickTarget } from '../src/combat/cannon';
import { trawlerAssetsReconcile, trawlerCatchRows } from '../src/combat/boss-minigame';
import { incomingFarmerProfile } from '../src/combat/prayer-flick';
import { COMBAT_SITES, combatPreflight, estimateSetupTicks } from '../src/combat/preflight';
import { xpForLevel, levelForXp } from '../src/combat/xp';
import {
    bestMiningPickaxe,
    bestWoodcuttingAxe,
    crossedTierBoundary as crossedGatherTierBoundary,
    planToolShopUpgrade,
} from '../src/gather/tools';
import { gatherEstimate, gatherPreflight } from '../src/gather/preflight';
import { floorExit, nearestMeatBank, reconcile, selectRecipe } from '../src/bank-artisan/herblore';
import { druidPouchFillDelta, qolDropSelection } from '../src/bank-artisan/foraging-qol';
import { actionSessionOwner, nearestBank } from '../src/bank-artisan/runtime';
import { artisanEstimate, artisanPreflight } from '../src/bank-artisan/preflight';
import { ALL_ALTARS, carrierAltar, chooseRuneAltar, inRuinFootprint, ruinTarget } from '../src/runecraft/altars';
import { runeBankBalanced } from '../src/runecraft/bank-craft';
import { exactCarrierOffer } from '../src/runecraft/carrier-trade';
import { runecraftEstimate, runecraftPreflight } from '../src/runecraft/preflight';
import { agilityEstimate, evaluateAgilityPreflight } from '../src/agility/preflight';

const ROOT = resolve(import.meta.dir, '../../..');

function makeAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'PerfCheck',
        side: 'local',
        protectedClock: false,
        skills: {
            Attack: { level: 70, xp: 800_000 },
            Strength: { level: 70, xp: 800_000 },
            Defence: { level: 70, xp: 800_000 },
            Hitpoints: { level: 70, xp: 800_000 },
            Prayer: { level: 45, xp: 70_000 },
            Ranged: { level: 70, xp: 800_000 },
            Magic: { level: 70, xp: 800_000 },
            Woodcutting: { level: 65, xp: 500_000 },
            Mining: { level: 65, xp: 500_000 },
            Fishing: { level: 80, xp: 2_000_000 },
            Cooking: { level: 85, xp: 3_300_000 },
            Firemaking: { level: 65, xp: 500_000 },
            Fletching: { level: 65, xp: 500_000 },
            Smithing: { level: 65, xp: 500_000 },
            Crafting: { level: 65, xp: 500_000 },
            Herblore: { level: 65, xp: 500_000 },
            Agility: { level: 65, xp: 500_000 },
            Thieving: { level: 65, xp: 500_000 },
            Runecraft: { level: 55, xp: 200_000 },
        },
        quests: {
            'Dragon Slayer': 'complete',
            'Lost City': 'complete',
            'Rune Mysteries': 'complete',
            'Shilo Village': 'complete',
            'Alfred Grimhand Barcrawl': 'complete',
            'Waterfall Quest': 'complete',
            'Nature Spirit': 'complete',
            'Throne of Miscellania': 'complete',
        },
        inventory: { 995: 50_000, 1436: 20, 1438: 1, 385: 10 },
        equipment: { 1359: 1 },
        bank: {
            observedAt: 0,
            trusted: true,
            items: {
                995: 100_000,
                1436: 500,
                385: 100,
                1511: 200,
                335: 200,
                377: 50,
                1987: 100,
                1937: 100,
                590: 1,
                946: 1,
                311: 1,
                1275: 1,
                1454: 1,
                772: 1,
                1462: 1,
                2: 200,
                6: 1,
                8: 1,
                10: 1,
                12: 1,
                554: 500,
                556: 500,
                558: 500,
                1381: 1,
            },
        },
        pos: { x: 3092, z: 3243, level: 0 },
        ...overrides,
    };
}

function makeWorld(overrides: Partial<WorkerWorldView> = {}): WorkerWorldView {
    return {
        at: 0,
        side: 'local',
        server: 'local',
        accounts: {},
        reserves: {},
        geEscrowCoins: {},
        spotOccupancy: {},
        ...overrides,
    };
}

function bruteForceUnlockPlan(
    levels: { Attack: number; Defence: number; Hitpoints: number; Prayer: number; Ranged: number; Magic: number },
    xp: { Strength: number; Defence: number; Hitpoints: number },
    targetCombat: number,
) {
    const fixed = 0.25 * Math.floor(levels.Prayer / 2);
    const otherTerm = Math.max(
        0.325 * (Math.floor(levels.Ranged / 2) + levels.Ranged),
        0.325 * (Math.floor(levels.Magic / 2) + levels.Magic),
    );
    const combatOf = (strLevel: number, defLevel: number, hpLevel: number) =>
        Math.floor(0.25 * (defLevel + hpLevel) + fixed + Math.max(0.325 * (levels.Attack + strLevel), otherTerm));

    let best: { strength: number; defence: number; hitpoints: number; combat: number; requiredXp: number } | undefined;
    for (let str = levelForXp(xp.Strength); str <= 99; str++) {
        for (let def = levelForXp(xp.Defence); def <= 99; def++) {
            const requiredXp = Math.max(0, xpForLevel(str) - xp.Strength) + Math.max(0, xpForLevel(def) - xp.Defence);
            const hp = levelForXp(xp.Hitpoints + Math.floor((requiredXp * 13) / 40));
            const combat = combatOf(str, def, hp);
            if (combat < targetCombat) continue;
            if (!best || requiredXp < best.requiredXp || (requiredXp === best.requiredXp && str > best.strength)) {
                best = { strength: str, defence: def, hitpoints: hp, combat, requiredXp };
            }
        }
    }
    return best!;
}

describe('skills perf pass 4 parity and lazy-loading', () => {
    test('lazy gear catalog proxies preserve Array semantics and combat/giant loadout parity', () => {
        expect(Array.isArray(BOWS)).toBe(true);
        expect(Array.isArray(ARROWS)).toBe(true);
        expect(Array.isArray(LOWE_ARROWS)).toBe(true);
        expect(Array.isArray(GIANT_BOWS)).toBe(true);
        expect(Array.isArray(GIANT_ARROWS)).toBe(true);
        expect(BOWS.length).toBeGreaterThan(0);
        expect(ARROWS.length).toBeGreaterThan(0);
        expect(LOWE_ARROWS.length).toBeGreaterThan(0);
        expect(LOWE_ARROWS.length).toBeLessThanOrEqual(ARROWS.length);
        const arrowIds = new Set(ARROWS.map(a => a.id));
        expect([...LOWE_ARROWS].every(id => arrowIds.has(id))).toBe(true);

        const stock = [
            { id: 1277, count: 1 },
            { id: 1333, count: 1 },
            { id: 4587, count: 1 },
            { id: 1127, count: 1 },
            { id: 1079, count: 1 },
            { id: 1163, count: 1 },
            { id: 1201, count: 1 },
            { id: 861, count: 1 },
            { id: 841, count: 1 },
            { id: 882, count: 500 },
            { id: 892, count: 500 },
            { id: 1381, count: 1 },
            { id: 1387, count: 1 },
        ];
        const levels = { Attack: 70, Strength: 70, Defence: 70, Ranged: 70, Magic: 70 };
        const quests = new Set(['Dragon Slayer', 'Monkey Madness']);

        const melee = selectCombatLoadout('melee', stock, levels, quests);
        expect(melee.worn.weapon?.id).toBe(1333);
        expect(melee.worn.body?.id).toBe(1127);
        expect(melee.worn.shield?.id).toBe(1201);
        expect(melee.bonuses.strength).toBeGreaterThanOrEqual(44);

        const ranged = selectCombatLoadout('ranged', stock, levels, quests);
        expect(ranged.worn.weapon?.id).toBe(861);
        expect(ranged.ammo?.id).toBe(892);
        expect(ranged.worn.shield).toBeNull();

        const magic = selectCombatLoadout('magic', stock, levels, quests);
        expect(magic.worn.weapon?.id).toBe(1387);

        const staff = bestElementalStaffForRunes(stock, levels, quests, [556]);
        expect(staff?.id).toBe(1381);

        const giantArmour = selectGiantArmour(stock, 60, quests, levels);
        expect(giantArmour.map(e => e.id)).toEqual([1163, 1127, 1079, 1201]);
        expect(bestBow(stock, 70)?.id).toBe(861);
        expect(usableArrows(50, 70)).toContain(892);
        expect(chooseArrow(stock, 50, 70)?.id).toBe(892);
        expect(gearIdByName('Rune scimitar')).toBe(1333);
        expect(gearById(1333)?.name).toBe('Rune scimitar');
        expect(crossedTierBoundary({ Attack: 39, Defence: 39 }, { Attack: 40, Defence: 39 }, ['attack', 'defence'], 'melee')).toBe(true);
        expect(crossedTierBoundary({ Attack: 40, Defence: 40 }, { Attack: 41, Defence: 40 }, ['attack', 'defence'], 'melee')).toBe(false);

        const excluded = loadGear().filter(
            g => g.staffOnly || /^macro_|^death_spikedboots$|^ikov_bootsoflightnessworn$|^flowers_waterfall$/.test(g.debugname),
        );
        expect(excluded.length).toBeGreaterThan(0);
        expect(canWearGear(excluded[0]!, { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99 }, quests)).toBe(false);
        const excludedLoadout = selectCombatLoadout(
            'melee',
            excluded.map(g => ({ id: g.id, count: 1 })),
            { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99 },
            quests,
        );
        expect(excludedLoadout.items).toEqual([]);
    });

    test('chickenCombatUnlockPlan matches brute-force oracle across multiple level states', () => {
        expect(chickenDesiredSkill({ Attack: 5, Strength: 5, Defence: 5 })).toBe('Strength');
        expect(chickenDesiredSkill({ Attack: 5, Strength: 6, Defence: 5 })).toBe('Attack');
        expect(chickenDesiredSkill({ Attack: 6, Strength: 6, Defence: 5 })).toBe('Defence');

        const cases = [
            { levels: { Attack: 1, Defence: 1, Hitpoints: 10, Prayer: 1, Ranged: 1, Magic: 1 }, str: 1, def: 1, hp: 10, target: 13 },
            { levels: { Attack: 5, Defence: 5, Hitpoints: 10, Prayer: 1, Ranged: 1, Magic: 1 }, str: 5, def: 5, hp: 10, target: 29 },
            { levels: { Attack: 25, Defence: 20, Hitpoints: 25, Prayer: 1, Ranged: 1, Magic: 1 }, str: 30, def: 20, hp: 25, target: 40 },
            { levels: { Attack: 38, Defence: 38, Hitpoints: 40, Prayer: 43, Ranged: 1, Magic: 1 }, str: 38, def: 38, hp: 40, target: 50 },
        ];
        for (const c of cases) {
            const xp = { Strength: xpForLevel(c.str), Defence: xpForLevel(c.def), Hitpoints: xpForLevel(c.hp) };
            expect(chickenCombatUnlockPlan(c.levels, xp, c.target)).toEqual(bruteForceUnlockPlan(c.levels, xp, c.target));
        }
    });

    test('combat cannon, boss minigame, and farmer profile helpers preserve behavior and stat-cache identity', () => {
        const picked = pickTarget(
            [
                { index: 1, name: 'Poison spider', x: 3289, z: 3810, hp: 12, distance: 2, targetIndex: -1, reachable: true, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] },
                { index: 2, name: 'Poison spider', x: 3287, z: 3811, hp: 14, distance: 1, targetIndex: -1, reachable: true, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] },
                { index: 3, name: 'Rat', x: 3287, z: 3810, hp: 2, distance: 0, targetIndex: -1, reachable: true, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] },
            ],
            { target: /^poison spider$/i, centre: { x: 3287, z: 3810 }, me: { x: 3287, z: 3810 }, near: 10, reach: 10, skip: () => false },
        );
        expect(picked?.index).toBe(2);
        const pickedLowHp = pickTarget(
            [
                { index: 1, name: 'Poison spider', x: 3287, z: 3810, hp: 12, distance: 0, targetIndex: -1, reachable: true, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] },
                { index: 2, name: 'Poison spider', x: 3287, z: 3811, hp: 14, distance: 1, targetIndex: -1, reachable: true, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] },
            ],
            { target: /^poison spider$/i, centre: { x: 3287, z: 3810 }, me: { x: 3287, z: 3810 }, near: 10, reach: 10, skip: () => false },
        );
        expect(pickedLowHp?.index).toBe(1);

        const parsed = parseLevels('Attack=40,Strength=50');
        expect(parsed).toEqual({ Attack: 40, Strength: 50 });
        expect(levelsMet(k => ({ Attack: 45, Strength: 50 }[k] ?? 1), parsed)).toBe(true);
        expect(levelsMet(k => ({ Attack: 39, Strength: 50 }[k] ?? 1), parsed)).toBe(false);
        expect(parsePhases('1333:0:Attack=50;4587:1:Strength=60').length).toBe(2);

        expect(trawlerCatchRows({ linkObjType: Int32Array.from([384, 0, 378]), linkObjNumber: Int32Array.from([5, 0, 3]) })).toEqual([
            { id: 383, slot: 0, count: 5 },
            { id: 377, slot: 2, count: 3 },
        ]);
        expect(trawlerAssetsReconcile(new Map([[1941, 100], [954, 10]]), { 1941: 90, 954: 8, 383: 5 }, { 383: 5 }, 10, 2)).toBe(true);
        expect(trawlerAssetsReconcile(new Map([[1941, 100]]), { 1941: 91 }, {}, 10, 0)).toBe(false);

        const p1 = incomingFarmerProfile();
        const p2 = incomingFarmerProfile();
        expect(p2).toBe(p1);
        expect(p1.npc).toBeGreaterThan(0);
        expect(p1.rate).toBeGreaterThan(0);
    });

    test('gather tools preserve enumerable lazy shops getter and tier-boundary checks', () => {
        const stock = [
            { id: 1351, count: 1 },
            { id: 1359, count: 1 },
            { id: 1265, count: 1 },
            { id: 1275, count: 1 },
        ];
        const axe = bestWoodcuttingAxe(stock, { Woodcutting: 45 });
        expect(axe.bestUsable?.item.id).toBe(1359);
        expect(Object.keys(axe.bestUsable!)).toContain('shops');
        expect(Array.isArray(axe.bestUsable!.shops)).toBe(true);

        const pick = bestMiningPickaxe(stock, { Mining: 45 });
        expect(pick.bestUsable?.item.id).toBe(1275);
        expect(Object.keys(pick.bestUsable!)).toContain('shops');
        expect(Array.isArray(pick.bestUsable!.shops)).toBe(true);

        expect(crossedGatherTierBoundary({ Woodcutting: 40 }, { Woodcutting: 41 }, ['woodcutting'], 'woodcutting-axe')).toBe(true);
        expect(crossedGatherTierBoundary({ Woodcutting: 41 }, { Woodcutting: 42 }, ['woodcutting'], 'woodcutting-axe')).toBe(false);
        expect(crossedGatherTierBoundary({}, { Hitpoints: 10 }, ['hitpoints'], [10])).toBe(true);
        expect(crossedGatherTierBoundary({ Hitpoints: 10 }, {}, ['hitpoints'], [10])).toBe(false);
        expect(crossedGatherTierBoundary({ Woodcutting: 40 }, { Woodcutting: 100 }, ['woodcutting'], 'woodcutting-axe')).toBe(false);
        expect(planToolShopUpgrade('woodcutting-axe', [{ id: 1351, count: 1 }], 50_000, { Woodcutting: 45 })?.target.id).toBe(1353);
    });

    test('bank-artisan herblore, foraging-qol, and runtime preserve parity and floorExit WeakMap caching', () => {
        expect(selectRecipe(70, { 199: 5, 207: 10, 213: 5 }).key).toBe('super_str');
        expect(selectRecipe(70, { 199: 5, 207: 10 }, 'prayer').key).toBe('prayer');
        expect(reconcile({ 199: 10, 227: 10 }, { 199: 9, 227: 9, 91: 1 }, { 199: -1, 227: -1, 91: 1 })).toBe(true);
        expect(reconcile({ 199: 10 }, { 199: 8 }, { 199: -1 })).toBe(false);
        expect(nearestMeatBank(3092, 3243)).toEqual({ x: 3092, z: 3243 });

        const locs = [
            { id: 1746, x: 3205, z: 3209, optionsWithIndex: [{ text: 'Climb-down', opIndex: 1 }] },
            { id: 1746, x: 3210, z: 3215, optionsWithIndex: [{ text: 'Climb-up', opIndex: 1 }] },
        ];
        const customRowsA = [{ from: { x: 3205, z: 3209, level: 1 }, to: { x: 3205, z: 3209, level: 0 } }];
        const customRowsB = [{ from: { x: 3210, z: 3215, level: 1 }, to: { x: 3210, z: 3215, level: 0 } }];
        expect(floorExit({ x: 3206, z: 3210, level: 1 }, locs, customRowsA)?.known).toBe(true);
        expect(floorExit({ x: 3206, z: 3210, level: 1 }, locs, customRowsB)?.known).toBe(false);

        const rows = [
            { id: 1511, name: 'Logs', slot: 0, count: 1 },
            { id: 1511, name: 'Logs', slot: 4, count: 1 },
            { id: 1359, name: 'Rune axe', slot: 1, count: 1 },
            { id: 1511, name: 'Logs', slot: 2, count: 1 },
        ];
        expect(qolDropSelection(rows, { ids: [1511], names: ['logs'], mode: 'listed', order: 'column', maximumDrops: 10, cap: 50 }).map(r => r.slot)).toEqual([0, 4, 2]);
        expect(qolDropSelection(rows, { ids: [1359], names: [], mode: 'except', order: 'reverse', maximumDrops: 10, cap: 50 }).map(r => r.slot)).toEqual([4, 2, 0]);
        expect(() => qolDropSelection([rows[0]!, { ...rows[0]! }], { ids: [1511], names: [], mode: 'listed', order: 'slot', maximumDrops: 5, cap: 50 })).toThrow();

        expect(druidPouchFillDelta([{ id: 2957, count: 1 }, { id: 2974, count: 2 }, { id: 2970, count: 2 }]).charges).toBe(7);
        expect(nearestBank({ x: 3185, z: 3436, level: 0 })).toEqual({ x: 3185, z: 3440, level: 0 });
        const config = { gatewayUrl: 'ws://a', host: 'h', port: 1 };
        const fakeSession: any = {
            name: 'OwnerBot',
            client: { executeBotAction: () => {}, selfSlot: 1 },
            sdk: { config, getState: () => ({ player: { lifeId: 1, respawnCount: 0 } }), getSkill: () => ({ level: 10 }) },
        };
        const owner = actionSessionOwner(fakeSession);
        expect(owner.identity()).toBe(true);
        config.host = 'other';
        expect(owner.identity()).toBe(false);
    });

    test('runecraft altars, runeBankBalanced, exactCarrierOffer, and immutable ruinTarget parity', () => {
        const chosen = chooseRuneAltar(55, new Set([1438, 1448, 1444, 1440, 1442, 1446]));
        expect(chosen.altar?.name).toBe('body');
        expect(chosen.wanted).toEqual([]);
        const missingBody = chooseRuneAltar(55, new Set([1438, 1448, 1444, 1440, 1442]));
        expect(missingBody.altar?.name).toBe('fire');
        expect(missingBody.wanted).toEqual(['body']);
        expect(() => chooseRuneAltar(55, new Set([1438]), 'body')).toThrow();

        const target1 = ruinTarget(ALL_ALTARS[0]!);
        target1.at.x = 9999;
        target1.q.id = -1;
        const target2 = ruinTarget(ALL_ALTARS[0]!);
        expect(target2.at.x).not.toBe(9999);
        expect(target2.q.id).toBe(2452);
        expect(inRuinFootprint(ALL_ALTARS[0]!, target2.at)).toBe(true);
        expect(carrierAltar('body').rune).toBe(559);
        expect(() => carrierAltar('chaos')).toThrow();

        expect(runeBankBalanced({ essence0: 100, essence: 73, air0: 0, air: 0, consumed: 27, crafted: 135, runes: { 556: { before: 10, after: 145, crafted: 135 } } })).toBe(true);
        expect(runeBankBalanced({ essence0: 100, essence: 73, air0: 0, air: 0, consumed: 27, crafted: 135, runes: { 556: { before: 10, after: 144, crafted: 135 } } })).toBe(false);
        expect(runeBankBalanced({ essence0: 50, essence: 23, air0: 0, air: 27, consumed: 27, crafted: 27 })).toBe(true);

        const essOffer = { id: 1436, count: 27, slot: 0, name: 'Rune essence' };
        const coinOffer = { id: 995, count: 1, slot: 0, name: 'Coins' };
        const talOffer = { id: 1446, count: 1, slot: 0, name: 'Body talisman' };
        const ess26 = { id: 1436, count: 26, slot: 1, name: 'Rune essence' };
        expect(exactCarrierOffer({ isOpen: true, screen: 'offer', partner: 'Helper1', myOffer: [], theirOffer: [essOffer], myAccepted: false, partnerAccepted: false }, false, 'helper1', 27)).toBe(true);
        expect(exactCarrierOffer({ isOpen: true, screen: 'offer', partner: 'Helper1', myOffer: [coinOffer], theirOffer: [essOffer], myAccepted: false, partnerAccepted: false }, false, 'helper1', 27)).toBe(false);
        expect(exactCarrierOffer({ isOpen: true, screen: 'offer', partner: 'Helper1', myOffer: [], theirOffer: [talOffer, ess26], myAccepted: false, partnerAccepted: false }, false, 'helper1', 27)).toBe(false);
    });

    test('preflight and estimate helpers cover gather, combat, bank-artisan, runecraft, and agility', () => {
        const acct = makeAccount();
        const world = makeWorld();

        expect(gatherPreflight(acct, { skill: 'woodcutting', method: 'yews', region: 'draynor' }, world).ok).toBe(true);
        expect(gatherEstimate(acct, { skill: 'fishing', method: 'shark' }, world).xpPerTick).toBeGreaterThan(0);

        expect(combatPreflight(acct, { mode: 'chicken' }, world).ok).toBe(true);
        expect(estimateSetupTicks(acct, COMBAT_SITES.chicken)).toBeGreaterThanOrEqual(0);

        expect(artisanPreflight(acct, { skill: 'cooking', method: 'food' }, world).ok).toBe(true);
        expect(artisanPreflight(acct, { skill: 'cooking', method: 'batch' }, world).ok).toBe(true);
        expect(artisanPreflight(acct, { skill: 'crafting', method: 'jewellery', args: ['sapphire_ring'] }, world).ok).toBe(false);
        expect(artisanEstimate(acct, { skill: 'herblore', method: 'potions' }, world).xpPerTick).toBeGreaterThan(0);

        expect(runecraftPreflight(acct, { mode: 'bank-craft' }, world).ok).toBe(true);
        expect(runecraftEstimate(acct, { mode: 'nature' }, world).xpPerTick).toBeGreaterThan(0);

        expect(evaluateAgilityPreflight(acct, { course: 'progressive' }, world).ok).toBe(true);
        expect(evaluateAgilityPreflight(acct, { course: 'ape-atoll' }, world).ok).toBe(false);
        expect(agilityEstimate(acct, { course: 'gnome' }, world).xpPerTick).toBeGreaterThan(0);
    });

    test('lazy-loaded submodules are not loaded by preflight or gear module imports', () => {
        const probe = (entryRel: string, forbiddenSubstrings: string[]) => {
            const abs = resolve(ROOT, entryRel).replace(/\\/g, '/');
            const code = [
                `await import(${JSON.stringify(abs)});`,
                `const keys = Object.keys(require.cache).map(k => k.replace(/\\\\/g, '/'));`,
                `const hit = ${JSON.stringify(forbiddenSubstrings)}.filter(s => keys.some(k => k.includes(s)));`,
                `if (hit.length) { console.error('UNEXPECTED_LOAD:' + hit.join(',')); process.exit(2); }`,
            ].join(' ');
            const res = spawnSync('bun', ['--eval', code], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
            expect(res.status, `${entryRel} stderr: ${res.stderr}`).toBe(0);
        };

        probe('packages/workers/src/combat/preflight.ts', [
            '/combat/cannon.ts',
            '/combat/special-mobs.ts',
            '/combat/survivability.ts',
            '/combat/gear.ts',
        ]);
        probe('packages/workers/src/gather/preflight.ts', [
            '/gather/fishing.ts',
            '/gather/foraging.ts',
            '/gather/mining-rotation.ts',
            '/gather/mining.ts',
            '/gather/thieving.ts',
        ]);
        probe('packages/workers/src/bank-artisan/preflight.ts', [
            '/bank-artisan/cooking.ts',
            '/bank-artisan/crafting.ts',
            '/bank-artisan/firemaking.ts',
            '/bank-artisan/fletching.ts',
            '/bank-artisan/herblore.ts',
            '/bank-artisan/magic.ts',
            '/bank-artisan/prayer.ts',
            '/bank-artisan/smithing.ts',
        ]);
        probe('packages/workers/src/agility/preflight.ts', [
            '/core/src/walk.ts',
            '/core/src/ticks.ts',
        ]);
        probe('packages/workers/src/runecraft/preflight.ts', [
            '/runecraft/carrier-roster.ts',
            '/logistics/admission.ts',
            '/logistics/walk-helpers.ts',
        ]);
    });
});
