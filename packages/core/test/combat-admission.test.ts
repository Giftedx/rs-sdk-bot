import { describe, expect, test } from 'bun:test';
import {
    carryableFood,
    combatAdmission,
    crowdDanger,
    MIN_HITS_ABOVE_RETREAT,
    npcHitChance,
    pickAdmittedTarget,
    retreatLine,
    type CombatThreat,
} from '../src/combat-admission';
import { npcThreat } from '../../knowledge/src/npc-threat';

// The NPCs of the deaths: Wizard 13 (Draynor), Unicorn 89, Giant 117 (Edgeville dungeon), Black Knight 179 (Taverley).
const WIZARD = npcThreat(13)!;
const UNICORN = npcThreat(89)!;
const GIANT = npcThreat(117)!;
const KNIGHT = npcThreat(179)!;

describe('npc threat table', () => {
    test('reads the max hits of the death targets from content', () => {
        // wizard.rs2: npc_cast_spell_with_forced_max_hit(^fire_strike, 4, 4).
        expect(WIZARD.magicMaxHit).toBe(4);
        expect(WIZARD.maxHit).toBe(4);
        // Giant: strength 22, strengthbonus 16: floor(((22 + 9) * 80 + 320) / 640) = 4; attackrate 6.
        expect(GIANT.maxHit).toBe(4);
        expect(GIANT.attackRate).toBe(6);
        // Unicorn: strength 13, no strength bonus: floor((22 * 64 + 320) / 640) = 2.
        expect(UNICORN.maxHit).toBe(2);
        // Black Knight: strength 25, strengthbonus 16: floor((34 * 80 + 320) / 640) = 4; attack roll (25 + 9) * 82.
        expect(KNIGHT.maxHit).toBe(4);
        expect(KNIGHT.attackRoll).toBe(34 * 82);
    });
});

describe('combat admission', () => {
    const acct = (hp: number, extra: Partial<Parameters<typeof combatAdmission>[1]> = {}) => ({
        hp,
        maxHp: hp,
        defence: 1,
        foodPieces: 0,
        healPerPiece: 12,
        ...extra,
    });

    test('the retreat line is one max hit of each attacker plus a margin', () => {
        expect(retreatLine(4)).toBe(6);
        expect(retreatLine(4, 2)).toBe(10);
        expect(retreatLine(20)).toBe(30);
        for (const t of [WIZARD, GIANT, KNIGHT, UNICORN]) expect(combatAdmission(t, acct(99)).retreatAt).toBeGreaterThan(t.maxHit);
    });

    test('refuses the 10-12 Hitpoints accounts that the wizards killed', () => {
        // Porksword 12, Quiverfull 11, Staffstiffy 10: retreat 6 + 3 max hits of 4 = 18 Hitpoints at least.
        for (const hp of [10, 11, 12]) {
            const a = combatAdmission(WIZARD, acct(hp, { foodPieces: 20 }));
            expect(a.verdict).toBe('refuse');
            expect(a.reason).toStartWith('too weak');
        }
        expect(combatAdmission(WIZARD, acct(6 + MIN_HITS_ABOVE_RETREAT * 4, { foodPieces: 20 })).verdict).toBe('admit');
    });

    test('a 60 Hitpoints account with no food takes food before the wizards', () => {
        // Magicwanda: 60 Hitpoints, no food, killed by a wizard.
        const unknownBank = combatAdmission(WIZARD, acct(60));
        expect(unknownBank.verdict).toBe('resupply');
        expect(unknownBank.foodNeeded).toBeGreaterThan(0);
        const emptyBank = combatAdmission(WIZARD, acct(60, { bankFoodPieces: 0 }));
        expect(emptyBank.verdict).toBe('refuse');
        expect(emptyBank.reason).toStartWith('no food');
        const fed = combatAdmission(WIZARD, acct(60, { foodPieces: unknownBank.foodNeeded }));
        expect(fed.verdict).toBe('admit');
    });

    test('a drained account must eat before the next unicorn', () => {
        // AFKnight 13 Hitpoints at 3: one unicorn fight more killed it.
        const a = combatAdmission(UNICORN, acct(13, { hp: 3, bankFoodPieces: 0 }));
        expect(a.verdict).toBe('refuse');
        expect(combatAdmission(UNICORN, acct(13, { hp: 3, foodPieces: 10 })).verdict).toBe('admit');
    });

    test('a crowd of giants needs more food than one giant', () => {
        const one = combatAdmission(GIANT, acct(59, { hp: 30, defence: 40 }));
        const two = combatAdmission(GIANT, acct(59, { hp: 30, defence: 40 }), { attackers: 2 });
        expect(two.retreatAt).toBeGreaterThan(one.retreatAt);
        expect(two.foodNeeded).toBeGreaterThan(one.foodNeeded);
    });

    test('Defence and armour lower the hit chance', () => {
        expect(npcHitChance(GIANT.attackRoll, 70, 100)).toBeLessThan(npcHitChance(GIANT.attackRoll, 1, 0));
        expect(npcHitChance(0, 1)).toBe(0);
    });

    test('a target that cannot hit admits any account', () => {
        const none: CombatThreat = { maxHit: 0, attackRoll: 100, attackRate: 4 };
        expect(combatAdmission(none, acct(10)).verdict).toBe('admit');
    });

    test('more food than the worker carries refuses', () => {
        const big: CombatThreat = { maxHit: 20, attackRoll: 20_000, attackRate: 4 };
        const a = combatAdmission(big, acct(99, { foodPieces: 5 }), { carryMax: 20 });
        expect(a.verdict).toBe('refuse');
    });
});

describe('carryable food', () => {
    test('takes the highest heal first up to the carry limit', () => {
        expect(carryableFood([{ count: 200, heal: 3 }, { count: 5, heal: 20 }], 20)).toEqual({ pieces: 20, heal: (5 * 20 + 15 * 3) / 20 });
        expect(carryableFood([], 20)).toEqual({ pieces: 0, heal: 0 });
    });

    test('held food above the carry limit covers nothing', () => {
        const a = combatAdmission(WIZARD, { hp: 30, maxHp: 30, defence: 1, foodPieces: 200, healPerPiece: 3 }, { carryMax: 20 });
        expect(a.verdict).toBe('refuse');
    });
});

describe('target fallback', () => {
    test('picks the first target that the account survives', () => {
        const account = { hp: 12, maxHp: 12, defence: 1, foodPieces: 5, healPerPiece: 12 };
        const r = pickAdmittedTarget(
            [{ name: 'wizard', threat: WIZARD }, { name: 'unicorn', threat: UNICORN }],
            c => combatAdmission(c.threat, account),
        );
        expect(r.target?.name).toBe('unicorn');
        expect(r.refused.map(x => x.target.name)).toEqual(['wizard']);
        expect(r.refused[0]!.reason).toStartWith('too weak');
    });

    test('returns no target when every candidate refuses', () => {
        const account = { hp: 5, maxHp: 5, defence: 1, foodPieces: 0, healPerPiece: 12 };
        const r = pickAdmittedTarget([WIZARD, GIANT], t => combatAdmission(t, account));
        expect(r.target).toBeUndefined();
        expect(r.refused).toHaveLength(2);
    });
});

describe('crowd and danger rule', () => {
    test('leaves when more NPCs attack than the limit', () => {
        expect(crowdDanger([], 100, { hp: 50, retreatAt: 10, foodHeal: 100, attackers: 3 }).leave).toBe(true);
        expect(crowdDanger([], 100, { hp: 50, retreatAt: 10, foodHeal: 100, attackers: 2 }).leave).toBe(false);
    });

    test('leaves when the damage rate outruns the food', () => {
        const hits = Array.from({ length: 10 }, (_, i) => ({ tick: 100 + i * 9, damage: 4 }));
        // 40 damage in the last minute: 120 for 3 minutes against 20 + 0 cover.
        const out = crowdDanger(hits, 190, { hp: 30, retreatAt: 10, foodHeal: 0, attackers: 1 });
        expect(out.leave).toBe(true);
        expect(out.damagePerMinute).toBe(40);
        // The same hits with 8 sharks of food: 20 + 160 cover.
        expect(crowdDanger(hits, 190, { hp: 30, retreatAt: 10, foodHeal: 160, attackers: 1 }).leave).toBe(false);
    });

    test('old hits leave the window', () => {
        const hits = [{ tick: 0, damage: 50 }];
        expect(crowdDanger(hits, 150, { hp: 30, retreatAt: 10, foodHeal: 0, attackers: 1 }).damagePerMinute).toBe(0);
    });
});
