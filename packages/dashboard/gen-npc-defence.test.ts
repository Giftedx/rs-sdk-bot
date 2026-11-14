import { expect, test } from 'bun:test';
import { hitChance, huntKinds, npcDefence } from './gen-npc-defence';

test('the NPC defence table: attackable NPCs by name, each variant once, lowest combat first, missing values defaulted', () => {
    const npc = '[giantspider2]\nname=Giant spider\nop2=Attack\ndefence=21\nattack=20\nstrength=24\nhitpoints=30\nrespawnrate=60\nparam=damagetype,^stab_style\nparam=combat_xp_multiplier,25\n\n[giantspider1]\nname=Giant spider\nop2=Attack\nparam=stabdefence,-10\nparam=slashdefence,-10\nparam=crushdefence,-10\nparam=magicdefence,-10\nparam=rangedefence,-10\n\n[banker]\nname=Banker\nop1=Talk-to\n';
    expect(npcDefence([npc], new Map([['giantspider1', 2], ['giantspider2', 27]]))).toEqual({ 'Giant spider': [[2, 1, 1, -10, -10, -10, -10, -10, 1, 1, 0, 0, -1, 1, 1000, 100, 0, -1], [27, 21, 1, 0, 0, 0, 0, 0, 20, 24, 0, 0, 0, 30, 25, 60, 0, -1]] });
});

test('the hunt kind: player hunt modes, the too-strong rule and check_afk; huntrange 0 does not hunt', () => {
    const hunt = '[cowardly]\ntype=player\ncheck_nottoostrong=outside_wilderness\n\n[aggressive_melee]\ntype=player\ncheck_nottoostrong=off\n\n[worker]\ntype=player\ncheck_afk=off\n\n[eat]\ntype=obj\n';
    const kinds = huntKinds([hunt]);
    expect([...kinds]).toEqual([['cowardly', 1], ['aggressive_melee', 2], ['worker', 3]]);
    const npc = '[a]\nname=A\nop2=Attack\nhuntmode=cowardly\nhuntrange=3\nvislevel=12\n\n[b]\nname=B\nop2=Attack\nhuntmode=aggressive_melee\nhuntrange=1\n\n[c]\nname=C\nop2=Attack\nhuntmode=aggressive_melee\n\n[d]\nname=D\nop2=Attack\nhuntmode=eat\nhuntrange=5\n';
    const out = npcDefence([npc], new Map(), kinds);
    expect([out.A[0].slice(16), out.B[0].slice(16), out.C[0].slice(16), out.D[0].slice(16)]).toEqual([[1, 12], [2, -1], [0, -1], [0, -1]]);
});

test('the hit chance of two rolls drawn from 0 up to each', () => {
    expect(hitChance(1000, 500)).toBeCloseTo(1 - 502 / 2002, 10);
    expect(hitChance(500, 1000)).toBeCloseTo(500 / 2002, 10);
    expect(hitChance(0, 0)).toBe(0);
});
