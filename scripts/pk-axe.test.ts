import { expect, test } from 'bun:test';
import { defaultSpec, shootingKit } from './pk';
import { itemId, kitItems, kitSwitches } from './pk-kits';

// The rune throwing axe special (scripts/pk.ts defaultSpec, pvp_rune_thrownaxe.rs2): 10% energy, the thrown weapon bar.
test('a kit that carries rune throwing axes uses their special in place of the dagger special', () => {
    const axe = kitSwitches('live-walker-iron-rune-chain-bind-axe');
    expect(axe.ranged).toContain(itemId('rune_thrownaxe'));
    expect(defaultSpec(axe)).toEqual({ kit: [itemId('rune_thrownaxe')], bar: 'combat_thrown:specbar', cost: 100, below: 1, style: 'ranged' });
    // The same kit with no axe keeps the dagger special.
    expect(defaultSpec(kitSwitches('live-walker-iron-rune-chain-bind'))).toMatchObject({ bar: 'combat_stabsword:specbar', cost: 250, style: 'melee' });
});

test('the axe is the special weapon only: plain ranged turns shoot the bow', () => {
    const axe = kitSwitches('live-walker-iron-rune-chain-bind-axe');
    expect(shootingKit(axe)).toEqual([itemId('magic_shortbow')]);
});

test('the axe kit fits the pack: one food slot gives way to the axe stack, and the runes and potion are the bind kit\'s', () => {
    const base = kitItems('live-walker-iron-rune-chain-bind'), axe = kitItems('live-walker-iron-rune-chain-bind-axe');
    expect(axe.inventory.length).toBe(base.inventory.length);
    expect(axe.inventory.filter(i => i.id === itemId('rune_thrownaxe')).length).toBe(1);
    expect(axe.inventory.filter(i => i.id === itemId('shark')).length).toBe(base.inventory.filter(i => i.id === itemId('shark')).length - 1);
    for (const id of ['3doseantipoison', 'lawrune', 'airrune', 'earthrune', 'waterrune', 'naturerune', 'magic_shortbow']) expect(axe.inventory.some(i => i.id === itemId(id))).toBe(true);
});
