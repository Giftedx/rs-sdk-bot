import { expect, test } from 'bun:test';
import { tradeRefusal } from '../src/tradeguard';

const owned = new Set(['our mule']);
const state = (name: string | null) => ({ nearbyPlayers: [{ index: 7, name }], trade: { partner: name } });
test('trade requests require a currently visible owned account', () => {
    expect(tradeRefusal({ type: 'interactPlayer', optionIndex: 4, playerIndex: 7 }, state('Our Mule'), owned)).toBeNull();
    expect(tradeRefusal({ type: 'interactPlayer', optionIndex: 4, playerIndex: 7 }, state('Stranger'), owned)).toContain('owned');
    expect(tradeRefusal({ type: 'interactPlayer', optionIndex: 4, playerIndex: 8 }, state('Our Mule'), owned)).toContain('owned');
});
test('both accept screens refuse unknown or unowned partners', () => {
    for (const id of [3420, 3546]) {
        expect(tradeRefusal({ type: 'clickComponent', componentId: id }, state('Our Mule'), owned)).toBeNull();
        expect(tradeRefusal({ type: 'clickComponent', componentId: id }, state('Stranger'), owned)).toContain('owned');
        expect(tradeRefusal({ type: 'clickComponent', componentId: id }, state(null), owned)).toContain('owned');
    }
    expect(tradeRefusal({ type: 'walkTo' }, state(null), owned)).toBeNull();
});
