import { expect, test } from 'bun:test';
import { nextStages, packIds, tableRows } from './gen-resources';

test('the resource generator reads loc ids, depleted forms and respawn tables', () => {
    expect([...packIds('450=rocks1\n2106=runiterock1\n')]).toEqual([['rocks1', 450], ['runiterock1', 2106]]);
    expect([...nextStages('[runiterock1]\nname=Rocks\nparam=next_loc_stage_mining,rocks1\n[other]\nparam=x,y\n', 'next_loc_stage_mining')]).toEqual([['runiterock1', 'rocks1']]);
    expect(tableRows('[runite_rock_table]\ntable=mining_table\ndata=rock,runiterock1\ndata=rock,runiterock2\ndata=ore_name,runite\ndata=rock_respawnrate,1200\n', 'rock', 'rock_respawnrate'))
        .toEqual([{ table: 'runite_rock_table', names: ['runiterock1', 'runiterock2'], label: 'runite', respawn: 1200 }]);
});
