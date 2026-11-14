import { expect, test } from 'bun:test';
import { fishChance, gatherChance } from './gen-gather-chance';

test('the gather rolls: each axe of a tree and the roll of a rock, by the log or ore they give', () => {
    const trees = '[willow_tree_table]\ntable=woodcutting_trees\ndata=levelrequired,30\ndata=product,willow_logs\ndata=successchance,bronze_axe,16,50\ndata=successchance,rune_axe,56,175\n';
    const rocks = '[iron_rock_table]\ntable=mining_table\ndata=rock_output,iron_ore\ndata=rock_successchance,96,350\n\n[iron_rock_table2]\ntable=mining_table\ndata=rock_output,iron_ore\ndata=rock_successchance,1,1\n';
    const names = new Map([['willow_logs', 'Willow logs'], ['bronze_axe', 'Bronze axe'], ['rune_axe', 'Rune axe'], ['iron_ore', 'Iron ore']]);
    expect(gatherChance(trees, rocks, names)).toEqual({ 'Willow logs': { tool: [['Bronze axe', 16, 50], ['Rune axe', 56, 175]] }, 'Iron ore': { roll: [96, 350] } });
});

test('the fish rolls: the struct that each fish names, by the fish name', () => {
    const obj = '[raw_shark]\nname=Raw shark\nparam=fishing_struct,fishing_struct_shark\n\n[net]\nname=Small fishing net\n';
    const struct = '[fishing_struct_shark]\nparam=productexp,1100\nparam=success_low,3\nparam=success_high,40\n';
    expect(fishChance(obj, struct, new Map([['raw_shark', 'Raw shark']]))).toEqual({ 'Raw shark': { roll: [3, 40] } });
});
