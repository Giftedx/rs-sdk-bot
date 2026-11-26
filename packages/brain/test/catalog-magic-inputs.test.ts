import { expect, test } from 'bun:test';
import { createActivityCatalog } from '../src/catalog';
import type { AccountState, WorldSnapshot } from '../src/contracts';
import { evaluateBestGearUpgrade, xpForLevel } from '../src/planner';

const inputsOf = (id: string) => {
    const act = createActivityCatalog().get(id);
    if (!act) throw Error('missing activity ' + id);
    return Object.fromEntries((act.inputs ?? []).map((io) => [io.itemId, io.countPerUnit]));
};

test('magic training steps name the inputs of the spell their default arguments cast', () => {
    // enchant:sapphire_ring: a Sapphire ring, a Cosmic rune and a Water rune per cast.
    expect(inputsOf('bank-artisan:magic-items')).toEqual({ 1637: 1, 564: 1, 555: 1 });
    // Varrock Teleport: one Law rune, three Air runes and one Fire rune.
    expect(inputsOf('bank-artisan:magic-teleport')).toEqual({ 563: 1, 556: 3, 554: 1 });
    // Curse over the Ardougne fence: one Body, two Water and three Earth runes.
    expect(inputsOf('combat:magic-splash')).toEqual({ 559: 1, 555: 2, 557: 3 });
    // The level-1 coop spell is Wind Strike: one Air and one Mind rune.
    expect(inputsOf('combat:magic-splash-coop')).toEqual({ 556: 1, 558: 1 });
    // Bones to Bananas: one bone per unit, and two Earth, two Water and one Nature rune per 25 bones.
    expect(inputsOf('bank-artisan:magic-bones')).toEqual({ 526: 1, 557: 0.08, 555: 0.08, 561: 0.04 });
});

test('enchanting gets no staff upgrade: a weapon does not change item spell XP', () => {
    const catalog = createActivityCatalog();
    const enchant = catalog.get('bank-artisan:magic-items')!;
    const now = 1_700_000_000_000;
    const acct: AccountState = {
        name: 'Earlyshooter',
        side: 'local',
        role: 'army',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Magic: { level: 7, xp: xpForLevel(7) }, Hitpoints: { level: 10, xp: xpForLevel(10) } },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 6_548 },
        equipment: {},
        bank: { items: { 995: 50_000 }, observedAt: now - 10_000, trusted: true },
    };
    const world: WorldSnapshot = { schemaVersion: 1, at: now, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { Earlyshooter: acct } };
    const rate = enchant.baselineRate;
    const upgrade = evaluateBestGearUpgrade({
        acct,
        activity: enchant,
        rate,
        remainingXp: xpForLevel(90) - xpForLevel(7),
        acquireCtx: { world },
        trainingSkill: 'Magic',
    });
    expect(upgrade).toBeNull();
});
