import {test,expect} from 'bun:test';
import {spellRunes,castable,staffRunes,spellLevel} from './teleport-runes';
const pack=(items:Record<number,number>)=>(id:number)=>items[id]??0;
test('a teleport needs every rune the spell costs, not only the law rune',()=>{
 expect(spellRunes('magic:lumbridge_teleport')).toEqual({557:1,556:3,563:1});
 expect(spellRunes('magic:ardougne_teleport')).toEqual({555:2,563:2});
 expect(spellRunes('magic:nothing')).toBeNull();
 // Monk's Friend leaves 8 law runes beside 1 air, 2 water and 1 earth: Lumbridge still needs 3 air.
 expect(castable('magic:lumbridge_teleport',pack({563:8,556:1,555:2,557:1}))).toBe(false);
 expect(castable('magic:lumbridge_teleport',pack({563:1,556:3,557:1}))).toBe(true);
 // Lumbridge Teleport needs Magic 31 (magic_spells.dbrow:75): the runes alone do not make it castable.
 expect(castable('magic:lumbridge_teleport',pack({563:1,556:3,557:1}),[],1)).toBe(false);
 expect(castable('magic:lumbridge_teleport',pack({563:1,556:3,557:1}),[],31)).toBe(true);
 expect(spellLevel('magic:lumbridge_teleport')).toBe(31);expect(spellLevel('magic:nothing')).toBeNull();
 expect(castable('magic:ardougne_teleport',pack({563:1,555:2}))).toBe(false);
 expect(castable('magic:nothing',pack({563:99,556:99}))).toBe(false);
});
test('a worn elemental staff stands in for its rune',()=>{
 expect(staffRunes(['staff_of_air'])).toEqual(new Set(['airrune']));
 expect(staffRunes(['lava_battlestaff'])).toEqual(new Set(['earthrune','firerune']));
 // 1381 staff of air: Lumbridge with the earth and law runes only.
 expect(castable('magic:lumbridge_teleport',pack({563:1,557:1}),[1381])).toBe(true);
 expect(castable('magic:lumbridge_teleport',pack({563:1}),[1381])).toBe(false);
});
