import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { questSweepNeeds } from '../src/quest/bank-needs';
import { assessQuestReadiness } from '../src/quest/modes';
import {
    BARE,
    PRAYER_QUESTS,
    QUEST_EXIT_RUNES,
    QUEST_KEEP,
    bareDeposits,
    bareRoomDeposits,
    bareWornDeposits,
    needs,
    presetFor,
    reservedEdible,
    withExitRunes,
} from '../src/quest/sweep-plan';
import { validateEntranaDungeonEntry } from '../../../scripts/generated/quest-zanaris';

const REPO = resolve(import.meta.dir, '../../..');

describe('PvP BiS unlock quest supply staging & reliability', () => {
    test('Death Plateau stages 10 bread (2309) and 10 trout (333) as required items and reserves them from eating', () => {
        const preset = presetFor('death');
        const base = needs(preset, false, 'death');
        const food = needs(preset, true, 'death');
        expect(base.get(2309)).toBe(10);
        expect(base.get(333)).toBe(10);
        expect(food.has(2309)).toBe(false);
        expect(food.has(333)).toBe(false);
        const reserved = reservedEdible(base);
        expect(reserved[2309]).toBe(10);
        expect(reserved[333]).toBe(10);

        const sw = questSweepNeeds('death', () => 99, false);
        const allIds = [...sw.bank, ...sw.shop].map((i) => i.id);
        expect(allIds).toContain(2309);
        expect(allIds).toContain(333);
        expect(sw.bank).toContainEqual(expect.objectContaining({ id: 2064, count: 1 }));
        expect(sw.bank).toContainEqual(expect.objectContaining({ id: 2351, count: 1 }));
    });

    test('Family Crest stages all 5 Caleb fish and Chronozon blast/teleport runes as required items', () => {
        const preset = presetFor('crest');
        const base = needs(preset, false, 'crest');
        const food = needs(preset, true, 'crest');
        for (const fish of [373, 365, 361, 329, 315]) {
            expect(base.get(fish)).toBe(1);
            expect(food.has(fish)).toBe(false);
        }
        for (const [rune, count] of [[556, 100], [555, 12], [557, 15], [554, 70], [560, 24], [563, 6]] as const) {
            expect(base.get(rune)).toBe(count);
        }
        // Only the 8 combat sharks remain in food.
        expect([...food]).toEqual([[385, 8]]);
        const reserved = reservedEdible(base);
        for (const fish of [373, 365, 361, 329, 315]) expect(reserved[fish]).toBe(1);
    });

    test('Mage Arena stages fire/air runes, goes BARE, and recharges Prayer at the altar', () => {
        expect(BARE.has('magearena')).toBe(true);
        expect(PRAYER_QUESTS.magearena).toBe(37);
        const base = needs(presetFor('magearena'), false, 'magearena');
        expect(base.get(554)).toBe(440);
        expect(base.get(556)).toBe(540);
        expect(base.get(565)).toBe(300);
        expect(base.get(946)).toBe(1);
        expect(base.get(2434)).toBe(4);
        const sw = questSweepNeeds('magearena', () => 99, false);
        expect(sw.shop).toContainEqual(expect.objectContaining({ id: 554, count: 440 }));
        expect(sw.shop).toContainEqual(expect.objectContaining({ id: 556, count: 540 }));
        expect(sw.shop).toContainEqual(expect.objectContaining({ id: 565, count: 300 }));
        expect(sw.bank).toContainEqual(expect.objectContaining({ id: 2434, count: 4 }));
    });

    test('TBWT and Heroes stage mandatory combat and teleport runes as required items', () => {
        const tbwtBase = needs(presetFor('tbwt'), false, 'tbwt');
        expect(tbwtBase.get(554)).toBe(31);
        expect(tbwtBase.get(556)).toBe(18);
        const heroBase = needs(presetFor('hero'), false, 'hero');
        expect(heroBase.get(554)).toBe(700);
        expect(heroBase.get(556)).toBe(650);
        expect(heroBase.get(555)).toBe(6);
        expect(heroBase.get(563)).toBe(10);
    });

    test('Lost City keeps banked Dramen branch/staff on resume and stages exit runes at Magic >= 31', () => {
        expect(QUEST_KEEP.zanaris).toEqual([771, 772]);
        expect(QUEST_EXIT_RUNES.zanaris).toEqual({
            magic: 31,
            items: [{ id: 563, count: 1 }, { id: 556, count: 3 }, { id: 557, count: 1 }],
        });
        const preset = presetFor('zanaris');
        const exitHigh = withExitRunes(needs(preset, false, 'zanaris'), needs(preset, true, 'zanaris'), 'zanaris', 99);
        expect(exitHigh.base.get(563)).toBe(1);
        expect(exitHigh.base.get(556)).toBe(3);
        expect(exitHigh.base.get(557)).toBe(1);
        expect(exitHigh.food.has(563)).toBe(false);

        const exitLow = withExitRunes(needs(preset, false, 'zanaris'), needs(preset, true, 'zanaris'), 'zanaris', 20);
        expect(exitLow.base.has(563)).toBe(false);

        const swHigh = questSweepNeeds('zanaris', () => 99, false);
        expect(swHigh.shop.some((i) => i.id === 556 && i.count === 3)).toBe(true);
        expect(swHigh.shop.some((i) => i.id === 557 && i.count === 1)).toBe(true);
    });

    test('BARE pass frees room in a full PvP pack before unequipping and banks untradeable worn armour', () => {
        // Full 28-slot PvP pack: 20 sharks + 4 rune stacks + coins + 3 supplies.
        const fullPack = [
            ...Array.from({ length: 20 }, () => ({ id: 385, count: 1 })),
            { id: 556, count: 100 },
            { id: 557, count: 30 },
            { id: 555, count: 30 },
            { id: 561, count: 20 },
            { id: 995, count: 5000 },
            { id: 946, count: 1 },
            { id: 1351, count: 1 },
            { id: 2446, count: 1 },
        ];
        expect(fullPack.length).toBe(28);
        // Unequipping 9 worn items needs 9 free slots; depositing sharks alone frees 20 slots in one click.
        expect(bareRoomDeposits(fullPack, 9)).toEqual([385]);
        // When already enough room, nothing extra is deposited.
        expect(bareRoomDeposits(fullPack.slice(0, 15), 9)).toEqual([]);

        // Untradeable worn armour (Klank's gauntlets 1495, Cape of saradomin 2412) is deposited by bareWornDeposits,
        // while Dramen staff (772) stays for zanaris (QUEST_KEEP.zanaris) and needed items stay.
        const need = new Map([[946, 1]]);
        expect(bareWornDeposits('zanaris', [1079, 1495, 2412, 772, 946], need)).toEqual([1079, 1495, 2412]);
        expect(bareWornDeposits('magearena', [1079, 1495, 2412, 772], need)).toEqual([1079, 1495, 2412, 772]);
        // Confirm bareDeposits alone still keeps untradeables (like Dramen branch 771) in pack.
        expect(bareDeposits('zanaris', [{ id: 771, count: 1 }, { id: 1079, count: 1 }], need, new Map(), (id) => id !== 771)).toEqual([1079]);
    });

    test('Lost City cave monk survival gate admits sturdy maxed PvP accounts with 10+ food and 0 prayer points', () => {
        expect(validateEntranaDungeonEntry({
            foodCount: 10, prayerBase: 99, prayerPoints: 0, prayerPotCount: 0, windBolt: false, hitpointsBase: 99, defenceBase: 99,
        })).toBeNull();
        // Non-sturdy account with 0 prayer points and 0 prayer potions is still blocked.
        expect(validateEntranaDungeonEntry({
            foodCount: 10, prayerBase: 43, prayerPoints: 0, prayerPotCount: 0, windBolt: false, hitpointsBase: 60, defenceBase: 60,
        })).toContain('Lost City entry unsafe');
        // Sturdy account with fewer than 10 meals still requires prayer points or a potion.
        expect(validateEntranaDungeonEntry({
            foodCount: 6, prayerBase: 99, prayerPoints: 0, prayerPotCount: 0, windBolt: false, hitpointsBase: 99, defenceBase: 99,
        })).toContain('Lost City entry unsafe');
    });

    test('assessQuestReadiness enforces quest point requirements when questPoints is provided', () => {
        const lowQp = assessQuestReadiness('dragon', {}, new Set(), {}, 12);
        expect(lowQp.blockers).toContain('quest points 12/32');
        const enoughQp = assessQuestReadiness('dragon', {}, new Set(), {}, 32);
        expect(enoughQp.blockers.some((b) => b.startsWith('quest points'))).toBe(false);
    });

    test('Dragon Slayer and Mage Arena scripts guard against 0 prayer points and null Kolodion', () => {
        expect(PRAYER_QUESTS.dragon).toBe(43);
        const dragonSrc = readFileSync(resolve(REPO, 'scripts/generated/quest-dragon.ts'), 'utf8');
        expect(dragonSrc).toContain('prayerPoints() <= 0');
        const maSrc = readFileSync(resolve(REPO, 'scripts/generated/quest-magearena.ts'), 'utf8');
        expect(maSrc).toContain('if (!inCellar() && !inArena())');
        expect(maSrc).toContain('const k = npcs([NPC.kolodion])[0]; return k ? q.talkTo(k) : q.waitTicks(1);');
        expect(maSrc).toContain('await q.waitUntil(() => !web(w), 3);');
        const zanarisSrc = readFileSync(resolve(REPO, 'scripts/generated/quest-zanaris.ts'), 'utf8');
        expect(zanarisSrc).not.toContain('if (windBolt && on && (q.s.sdk.getSkill');
        expect(zanarisSrc).toContain("if (on && (q.s.sdk.getSkill('Prayer')?.baseLevel ?? 0) < required) return;");
    });
});
