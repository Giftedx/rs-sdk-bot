import { expect, test } from 'bun:test';
import { npcBlocks, npcLoot, type DropEntry } from './gen-npc-loot';

test('expected drops of a kill: always items, rolls and table items, the death drop, a shared proc and a category', () => {
    const npc = '[mossgiant]\nname=Moss giant\nop2=Attack\nparam=death_drop,big_bones\n\n[canifis_man]\nname=Man\nop2=Attack\ncategory=canafis_citizen\n\n[man]\nname=Man\nop2=Attack\n\n[lesser_demon]\nname=Lesser demon\nop2=Attack\nparam=death_drop,ashes\n';
    const drops: DropEntry[] = [
        { trigger: 'mossgiant', always: [{ item: 'death_drop', count: 1 }], rolls: [{ item: 'coins', count: 37, chance: 0.5 }, { item: 'law_rune', count: 2, chance: 0.1, conditional: true }, { chance: 0.01, table: 'randomherb', items: [{ item: 'coins', count: 10, chance: 0.01, conditional: true }, { item: 'unidentified_guam', count: 1, chance: 0.0025 }] }] },
        { trigger: '_canafis_citizen', always: [], rolls: [{ item: 'fur', count: 1, chance: 0.2 }, { item: 'grey_wolf_fur', count: 1, chance: 0.2 }] },
        { trigger: 'man', always: [], rolls: [{ item: 'coins', count: 3, chance: 0.6 }] },
        { trigger: 'lesser_demon', always: [], rolls: [], uses: 'ai_queue3_lesser_demon' },
        { trigger: 'label:ai_queue3_lesser_demon', always: [{ item: 'death_drop', count: 1 }], rolls: [{ item: 'coins', count: 120, chance: 0.5 }] },
    ];
    const names = new Map([['big_bones', 'Big bones'], ['coins', 'Coins'], ['unidentified_guam', 'Herb'], ['fur', 'Fur'], ['grey_wolf_fur', 'Grey wolf fur'], ['bones', 'Bones'], ['ashes', 'Ashes']]);
    // The plain Man has more spawns than the Canifis one, so its drops win.
    const out = npcLoot(drops, npcBlocks([npc]), d => names.get(d) ?? d, new Map([['man', 40], ['canifis_man', 8]]));
    expect(out['Moss giant']).toEqual([['Coins', 18.5], ['Big bones', 1], ['Herb', 0.0025]]);
    // This handler lists no death_drop, so it drops no bones (a handler drops what it lists).
    expect(out['Man']).toEqual([['Coins', 1.8]]);
    expect(out['Lesser demon']).toEqual([['Coins', 60], ['Ashes', 1]]);
});

test('a handler that drops its bones itself gets no second death drop; a ranged quantity counts its mean; no handler drops the death drop', () => {
    const npc = '[king_dragon]\nname=King Black Dragon\nop2=Attack\nparam=death_drop,dragon_bones\n\n[kalphite]\nname=Kalphite Soldier\nop2=Attack\n\n[goblin]\nname=Goblin\nop2=Attack\n';
    const drops: DropEntry[] = [
        { trigger: 'king_dragon', always: [{ item: 'dragon_bones', count: 1 }], rolls: [] },
        { trigger: 'kalphite', always: [], rolls: [{ item: 'nature_rune', count: 1, countMax: 4, chance: 0.015625 }] },
    ];
    const names = new Map([['dragon_bones', 'Dragon bones'], ['nature_rune', 'Nature rune'], ['bones', 'Bones']]);
    const out = npcLoot(drops, npcBlocks([npc]), d => names.get(d) ?? d);
    expect(out['King Black Dragon']).toEqual([['Dragon bones', 1]]);
    expect(out['Kalphite Soldier']).toEqual([['Nature rune', 0.03906]]);
    expect(out['Goblin']).toEqual([['Bones', 1]]);
});
