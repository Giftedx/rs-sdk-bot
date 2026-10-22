import { test, expect } from 'bun:test';
import { parseConfigs } from '../src/config';
import { buildDbTables } from '../src/dbtables';
import { buildSkillActions } from '../src/skills';

const tables = buildDbTables(
    parseConfigs('[woodcutting_trees]\ncolumn=levelrequired,int\ncolumn=tree,loc,LIST\ncolumn=productexp,int\ncolumn=product,namedobj\ncolumn=respawnrate,int\n\n[mining_table]\ncolumn=rock,loc,LIST\ncolumn=rock_output,namedobj\ncolumn=rock_level,int\ncolumn=rock_exp,int\n\n[cooking_generic]\ncolumn=cooked,namedobj\ncolumn=uncooked,namedobj\ncolumn=levelrequired,int\ncolumn=experience,int\n', 'scripts/t.dbtable'),
    parseConfigs('[oak]\ntable=woodcutting_trees\ndata=tree,oaktree\ndata=tree,oaktree2\ndata=levelrequired,15\ndata=productexp,375\ndata=product,oak_logs\ndata=respawnrate,14\n\n[copper]\ntable=mining_table\ndata=rock,copperrock1\ndata=rock_output,copper_ore\ndata=rock_level,1\ndata=rock_exp,175\n\n[shrimp]\ntable=cooking_generic\ndata=cooked,shrimps\ndata=uncooked,raw_shrimps\ndata=levelrequired,1\ndata=experience,300\n', 'scripts/t.dbrow'),
);

test('woodcutting rows give level, whole XP (tenths / 10), product and the tree locs', () => {
    const a = buildSkillActions(tables).find(x => x.row === 'oak')!;
    expect(a).toMatchObject({ skill: 'woodcutting', level: 15, xp: 37.5, outputs: ['oak_logs'], inputs: [], at: { locs: ['oaktree', 'oaktree2'] } });
    expect(a.src.xp).toBe('scripts/t.dbrow:6'); // [oak] is line 1, productexp is line 6
});

test('mining and cooking rows map their own column names', () => {
    const acts = buildSkillActions(tables);
    expect(acts.find(x => x.row === 'copper')).toMatchObject({ skill: 'mining', level: 1, xp: 17.5, outputs: ['copper_ore'], at: { locs: ['copperrock1'] } });
    expect(acts.find(x => x.row === 'shrimp')).toMatchObject({ skill: 'cooking', level: 1, xp: 30, inputs: ['raw_shrimps'], outputs: ['shrimps'] });
});
