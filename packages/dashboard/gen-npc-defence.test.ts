import { expect, test } from 'bun:test';
import { hitChance, npcDefence } from './gen-npc-defence';

test('the NPC defence table: attackable NPCs by name, each variant once, lowest combat first, missing values defaulted', () => {
    const npc = '[giantspider2]\nname=Giant spider\nop2=Attack\ndefence=21\n\n[giantspider1]\nname=Giant spider\nop2=Attack\nparam=stabdefence,-10\nparam=slashdefence,-10\nparam=crushdefence,-10\nparam=magicdefence,-10\nparam=rangedefence,-10\n\n[banker]\nname=Banker\nop1=Talk-to\n';
    expect(npcDefence([npc], new Map([['giantspider1', 2], ['giantspider2', 27]]))).toEqual({ 'Giant spider': [[2, 1, 1, -10, -10, -10, -10, -10], [27, 21, 1, 0, 0, 0, 0, 0]] });
});

test('the hit chance of two rolls drawn from 0 up to each', () => {
    expect(hitChance(1000, 500)).toBeCloseTo(1 - 502 / 2002, 10);
    expect(hitChance(500, 1000)).toBeCloseTo(500 / 2002, 10);
    expect(hitChance(0, 0)).toBe(0);
});
