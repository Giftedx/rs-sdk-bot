import { expect, test } from 'bun:test';
import { parseConfigs } from '../src/config';
import { parseScriptSources, parseShopNpcs, questNames } from '../src/gear-sources';

const names = questNames([{ varp: 'deathplateau', folder: 'quest_death' }, { varp: 'dragonquest', folder: 'quest_dragon' }], new Map([['deathplateau', 'Death Plateau'], ['dragonquest', 'Dragon Slayer']]));
const ids = new Map([['boots', 1], ['shield', 2], ['helm', 3], ['bark_helm', 4], ['clue_hat', 5]]);

const SHERPA = `[opnpc1,sherpa]
if(%death_equiproom = ^death_complete) {
    if(inv_total(inv, coins) < 12) {
    } else {
        inv_del(inv, coins, 12);
        inv_add(inv, boots, 1);
    }
}
`;

test('a coin check above inv_add is the price and the first if of the trigger is the gate', () => {
    const { npc } = parseScriptSources([{ file: 'scripts/quests/quest_death/scripts/sherpa.rs2', text: SHERPA }], ids, names);
    expect(npc).toEqual([{ npc: 'sherpa', item: 'boots', id: 1, cost: 12, gate: { text: '%death_equiproom = ^death_complete', src: 'scripts/quests/quest_death/scripts/sherpa.rs2:2', quest: 'Death Plateau' }, src: 'scripts/quests/quest_death/scripts/sherpa.rs2:6' }]);
});

test('a free hand-out names the quest of its varp; an unknown gate or an exchange is left out', () => {
    const duke = `[opnpc1,duke]\nif (%dragonquest >= ^dragon_complete) {\n}\n[label,duke_shield]\ninv_add(inv, shield, 1);\n`;
    const other = `[opnpc1,sage]\nif (%somethingelse = 1) {\n}\n[label,sage_gives]\ninv_add(inv, helm, 1);\n`;
    const exchange = `[opnpc1,smith]\n[label,smith_makes]\ninv_del(inv, hollow_bark, 2);\ninv_del(inv, coins, 6000);\ninv_add(inv, bark_helm, 1);\n`;
    const r = parseScriptSources([
        { file: 'scripts/areas/a/scripts/duke.rs2', text: duke },
        { file: 'scripts/areas/a/scripts/sage.rs2', text: other },
        { file: 'scripts/areas/a/scripts/smith.rs2', text: exchange },
    ], ids, names);
    expect(r.npc.map(n => [n.npc, n.item, n.cost, n.gate?.quest])).toEqual([['duke', 'shield', 0, 'Dragon Slayer']]);
});

test('quest folder calls without a price and clue reward procs are rows', () => {
    const quest = `[queue,x_complete]\ninv_add(inv, helm, 1);\n`;
    const clue = `[proc,trail_clue_hard_normal]\ninv_add(trail_rewardinv, clue_hat, 1);\n`;
    const r = parseScriptSources([
        { file: 'scripts/quests/quest_dragon/scripts/q.rs2', text: quest },
        { file: 'scripts/minigames/game_trail/scripts/hard/r.rs2', text: clue },
    ], ids, names);
    expect(r.quest).toEqual([{ quest: 'Dragon Slayer', item: 'helm', id: 3, src: 'scripts/quests/quest_dragon/scripts/q.rs2:2' }]);
    expect(r.clue).toEqual([{ tier: 'hard', item: 'clue_hat', id: 5, src: 'scripts/minigames/game_trail/scripts/hard/r.rs2:2' }]);
});

test('parseShopNpcs reads owned_shop params with the NPC spawns', () => {
    const blocks = parseConfigs('[oziach]\nname=Oziach\nparam=owned_shop,runeplateshop\n[bob]\nname=Bob\n', 'a.npc');
    expect(parseShopNpcs(blocks, n => (n === 'oziach' ? [{ x: 1, z: 2, level: 0 }] : []))).toEqual([{ shop: 'runeplateshop', npc: 'oziach', spawns: [{ x: 1, z: 2, level: 0 }] }]);
});
