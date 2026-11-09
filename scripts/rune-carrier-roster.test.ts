import {test,expect} from 'bun:test';
import {runeCarrierRoster,assertFreshRuneSkills,assertRuneDonor} from './rune-carrier-roster';
const skills=Array.from({length:21},(_,i)=>({name:i===3?'Hitpoints':'Skill'+i,baseLevel:i===3?10:1,experience:i===3?980:0}));
test('the composed worker uses the complete ordered supervisor roster',()=>{
 expect(runeCarrierRoster(['Wandwaver','Shaftsinker','Bigchopper','--carriers'])).toEqual(['Wandwaver','Shaftsinker','Bigchopper']);
 for(const args of [['Wandwaver','--carriers'],['Wandwaver','Shaftsinker','shaftsinker','--carriers'],['Wandwaver','99','--carriers','extra']])expect(()=>runeCarrierRoster(args)).toThrow();
 expect(()=>runeCarrierRoster(['Wandwaver',...Array.from({length:17},(_,i)=>'helper'+i),'--carriers'])).toThrow();
});
test('bounded body measurements require an explicit12..48 pack mode and the retained16 helpers',()=>{
 const names=['Wandwaver',...Array.from({length:16},(_,i)=>'helper'+i)];
 for(const n of [12,13,37,48])expect(runeCarrierRoster([...names,'--body-measure='+n])).toEqual(names);
 for(const mode of ['--body-measure=0','--body-measure=11','--body-measure=49','--body-measure=013','--body-measure=NaN','--body-measure=13.5'])expect(()=>runeCarrierRoster([...names,mode])).toThrow();
 expect(()=>runeCarrierRoster([...names.slice(1),'--body-measure=13'])).toThrow();
 expect(()=>runeCarrierRoster([...names,'--body-continuation','--body-measure=13'])).toThrow();
});
test('a missing or trained skill refuses the fresh route',()=>{
 expect(()=>assertFreshRuneSkills(skills)).not.toThrow();
 expect(()=>assertFreshRuneSkills(skills.slice(1))).toThrow();
 expect(()=>assertFreshRuneSkills(skills.map((s,i)=>i===20?{...s,experience:1}:s))).toThrow();
 expect(()=>assertFreshRuneSkills(skills.map((s,i)=>i===0?{...s,baseLevel:2}:s))).toThrow();
});
test('the opening donor is checked before the fresh account logs in',()=>{
 const player={worldX:3222,worldZ:3223,level:0},inventory=[{id:1438,count:1},...Array.from({length:27},()=>({id:1436,count:1}))];
 expect(()=>assertRuneDonor(player,inventory)).not.toThrow();
 expect(()=>assertRuneDonor({...player,worldZ:3200},inventory)).toThrow();
 expect(()=>assertRuneDonor(player,inventory.slice(1))).toThrow();
 expect(()=>assertRuneDonor(player,[...inventory,{id:995,count:1}])).toThrow();
});
