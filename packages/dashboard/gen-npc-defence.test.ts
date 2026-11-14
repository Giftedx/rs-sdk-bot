import { expect, test } from 'bun:test';
import { hitChance, huntKinds, npcDefence, npcHunters } from './gen-npc-defence';

test('the hunters: player hunt modes and their rules; each variant with its own spawns; huntrange 0 and no spawns left out', () => {
    const hunt = '[cowardly]\ntype=player\ncheck_nottoostrong=outside_wilderness\n\n[aggressive_melee]\ntype=player\ncheck_nottoostrong=off\n\n[worker]\ntype=player\ncheck_afk=off\n\n[eat]\ntype=obj\n';
    const kinds = huntKinds([hunt]);
    expect([...kinds]).toEqual([['cowardly', 1], ['aggressive_melee', 2], ['worker', 3]]);
    const npc = '[w]\nname=Worker\nhuntmode=cowardly\nhuntrange=3\nvislevel=28\n\n[w_chamber]\nname=Worker\nhuntmode=worker\nhuntrange=3\n\n[b]\nname=B\nhuntmode=aggressive_melee\nhuntrange=1\n\n[c]\nname=C\nhuntmode=aggressive_melee\n\n[d]\nname=D\nhuntmode=eat\nhuntrange=5\n';
    const spawns = [{ debugname: 'w', spawns: [{ x: 1, z: 2, level: 2 }] }, { debugname: 'w_chamber', spawns: [] }, { debugname: 'b', spawns: [{ x: 5, z: 6 }] }, { debugname: 'c', spawns: [{ x: 7, z: 8 }] }, { debugname: 'd', spawns: [{ x: 9, z: 9 }] }];
    // The chamber variant never spawns, so its never-ending hunt is not at the worker's tile.
    expect(npcHunters([npc], kinds, spawns)).toEqual([['B', 2, -1, [5, 6, 0]], ['Worker', 1, 28, [1, 2, 2]]]);
});

test('the NPC defence table: attackable NPCs by name, each variant once, lowest combat first, missing values defaulted', () => {
    const npc = '[giantspider2]\nname=Giant spider\nop2=Attack\ndefence=21\nattack=20\nstrength=24\nhitpoints=30\nrespawnrate=60\nparam=damagetype,^stab_style\nparam=combat_xp_multiplier,25\n\n[giantspider1]\nname=Giant spider\nop2=Attack\nparam=stabdefence,-10\nparam=slashdefence,-10\nparam=crushdefence,-10\nparam=magicdefence,-10\nparam=rangedefence,-10\n\n[banker]\nname=Banker\nop1=Talk-to\n';
    expect(npcDefence([npc], new Map([['giantspider1', 2], ['giantspider2', 27]]))).toEqual({ 'Giant spider': [[2, 1, 1, -10, -10, -10, -10, -10, 1, 1, 0, 0, -1, 1, 1000, 100], [27, 21, 1, 0, 0, 0, 0, 0, 20, 24, 0, 0, 0, 30, 25, 60]] });
});

test('the hit chance of two rolls drawn from 0 up to each', () => {
    expect(hitChance(1000, 500)).toBeCloseTo(1 - 502 / 2002, 10);
    expect(hitChance(500, 1000)).toBeCloseTo(500 / 2002, 10);
    expect(hitChance(0, 0)).toBe(0);
});
