import {test,expect} from 'bun:test';
import {fireSpell,fireRune,fireRunesFor} from './fire-spells';

test('the strongest fire spell the level and the pack allow',()=>{
 const has=(ids:number[])=>(id:number)=>ids.includes(id);
 expect(fireSpell(99,has([565,560,562]))).toBe('magic:fire_wave');
 expect(fireSpell(62,has([565,560,562]))).toBe('magic:fire_blast');
 expect(fireSpell(62,has([562]))).toBe('magic:fire_bolt');
 expect(fireRune(74)).toBe(560);expect(fireRune(58)).toBe(562);expect(fireRune(75)).toBe(565);
});
test('cast runes above the level move to the allowed spell; runes of a lower spell stay',()=>{
 expect([...fireRunesFor(new Map([[565,60],[556,300]]),62)]).toEqual([[556,300],[560,60]]);
 expect([...fireRunesFor(new Map([[565,60]]),50)]).toEqual([[562,60]]);
 expect([...fireRunesFor(new Map([[562,80],[556,240]]),62)]).toEqual([[562,80],[556,240]]);
 expect([...fireRunesFor(new Map([[565,60]]),80)]).toEqual([[565,60]]);
});
