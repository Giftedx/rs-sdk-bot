import {expect,test} from 'bun:test';
import {npcNames} from './export-npc-names';

test('npc names: pack ids map to config names and shown combat levels; hidden levels and unknown keys stay empty',()=>{
 const pack='0=hans\n1=man\n3=ghost_key\n';
 const configs=['[hans]\nvislevel=hide\nname=Hans\n\n[man]\nname=Man\nvislevel=2\nop2=Attack\n'];
 expect(npcNames(pack,configs)).toEqual([['Hans'],['Man',2],null,null]);
});
