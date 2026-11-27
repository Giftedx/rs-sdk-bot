import { describe, expect, test } from 'bun:test';
import { attackersOn, createCombatAdmissionGuard, plainFood } from '../src/combat/admission';
import { combatAdmissionBlocker } from '../src/combat/preflight';
import { genericCombatNpcIds } from '../src/combat/melee-gather';
import type { CombatSession } from '../src/combat/types';

const LOBSTER = 379;

function fakeSession(o: { hp: number; maxHp: number; defence?: number; food?: number; bankFood?: number; attackers?: number }) {
    const state = { hp: o.hp, food: o.food ?? 0, attackers: o.attackers ?? 0 };
    const s = {
        name: 'Porksword',
        client: { selfSlot: 5 },
        sdk: {
            getSkill: (name: string) =>
                name === 'Hitpoints' ? { level: state.hp, baseLevel: o.maxHp } : name === 'Defence' ? { level: o.defence ?? 1, baseLevel: o.defence ?? 1 } : undefined,
            getInventory: () => (state.food > 0 ? [{ id: LOBSTER, name: 'Lobster', count: state.food, slot: 0 }] : []),
            getState: () => ({
                equipment: [],
                nearbyNpcs: Array.from({ length: state.attackers }, (_, i) => ({ index: i, inCombat: true, targetIndex: 32768 + 5 })),
            }),
        },
        bankObservation: () => (o.bankFood === undefined ? null : { items: o.bankFood > 0 ? [{ id: LOBSTER, name: 'Lobster', count: o.bankFood }] : [] }),
    } as unknown as CombatSession;
    return { s, state };
}

const quiet = { log: () => {} };

describe('combat admission guard', () => {
    test('refuses a 12 Hitpoints account at the wizards before the first walk', () => {
        const { s } = fakeSession({ hp: 12, maxHp: 12, food: 10 });
        const g = createCombatAdmissionGuard(s, 'wizard', genericCombatNpcIds('wizard'), quiet);
        expect(g.entry()).toStartWith('no combat progress: wizard admission refused: too weak');
    });

    test('takes food for a 60 Hitpoints account, then refuses when the bank has none', () => {
        const { s } = fakeSession({ hp: 60, maxHp: 60, bankFood: 0 });
        const g = createCombatAdmissionGuard(s, 'wizard', genericCombatNpcIds('wizard'), quiet);
        expect(g.entry()).toBeUndefined();
        expect(g.beforeAttack(false)).toEqual({ kind: 'bank' });
        const after = g.beforeAttack(true);
        expect(after.kind).toBe('refuse');
        expect(after.kind === 'refuse' && after.detail).toStartWith('no food: wizard admission');
    });

    test('a bank trip takes the food the admission needs', () => {
        const { s } = fakeSession({ hp: 60, maxHp: 60 });
        const g = createCombatAdmissionGuard(s, 'wizard', genericCombatNpcIds('wizard'), quiet);
        expect(g.foodWant(5)).toBeGreaterThan(5);
        expect(g.foodWant(0)).toBe(0);
    });

    test('leaves the fight at the retreat line with no food', () => {
        const { s, state } = fakeSession({ hp: 30, maxHp: 59, defence: 40 });
        const g = createCombatAdmissionGuard(s, 'giant', genericCombatNpcIds('giant'), quiet);
        expect(g.tick(1)).toBeUndefined();
        state.hp = 6;
        expect(g.tick(2)).toStartWith('retreat:');
    });

    test('the crowd rule leaves a spot with three attackers and ends the run after three leaves', () => {
        const { s } = fakeSession({ hp: 59, maxHp: 59, defence: 40, food: 8, attackers: 3 });
        const g = createCombatAdmissionGuard(s, 'giant', genericCombatNpcIds('giant'), quiet);
        const why = g.tick(1)!;
        expect(why).toStartWith('crowd:');
        expect(g.left(why)).toBeUndefined();
        expect(g.left(why)).toBeUndefined();
        expect(g.left(why)).toStartWith('no combat progress: giant danger');
    });

    test('helpers count food and attackers', () => {
        expect(plainFood([{ id: LOBSTER, count: 3 }, { id: 1, count: 9 }])).toEqual({ pieces: 3, heal: 12 });
        expect(attackersOn([{ inCombat: true, targetIndex: 32773 }, { inCombat: true, targetIndex: 1 }], 5)).toBe(1);
        expect(attackersOn([{ inCombat: true, targetIndex: 32773 }], undefined)).toBe(0);
    });
});

describe('worker preflight admission', () => {
    const acct = (hp: number) => ({ skills: { Hitpoints: { level: hp, xp: 0 }, Defence: { level: 1, xp: 0 } } }) as never;
    test('blocks the weak account and the account with no food', () => {
        expect(combatAdmissionBlocker(acct(11), { threatNpcIds: [13] }, [{ id: LOBSTER, count: 20 }])?.reason).toBe('hitpoints');
        expect(combatAdmissionBlocker(acct(60), { threatNpcIds: [13] }, [])?.reason).toBe('food');
        expect(combatAdmissionBlocker(acct(60), { threatNpcIds: [13] }, [{ id: LOBSTER, count: 20 }])).toBeUndefined();
    });
});
