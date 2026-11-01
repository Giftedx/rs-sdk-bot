import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');

test('infoboxes: boosted and drained skills of the followed account; Hitpoints and Prayer stay in the orbs',()=>{
 const code=shell.slice(shell.indexOf('  function infoboxes(){'),shell.indexOf('  // Board progress'));
 const el={innerHTML:''};
 const run=new Function('account','hud','E','asset','skillFile','dur','age','realSkill',code+';infoboxes();');
 const skills=[{name:'Attack',level:60,currentLevel:65},{name:'Strength',level:50,currentLevel:45},{name:'Defence',level:40,currentLevel:40},{name:'Hitpoints',level:56,currentLevel:30},{name:'Prayer',level:43,currentLevel:0}];
 run(()=>({name:'Worker',skills}),{querySelector:()=>el},String,(n:string)=>n,(n:string)=>n.toLowerCase(),String,String,(k:any)=>k.name!=='Overall');
 expect(el.innerHTML).toContain('class="infobox boost-up" title="Attack boosted: 65 / 60"');
 expect(el.innerHTML).toContain('class="infobox boost-down" title="Strength drained: 45 / 50"');
 expect(el.innerHTML).not.toContain('Defence');expect(el.innerHTML).not.toContain('Hitpoints');expect(el.innerHTML).not.toContain('Prayer');
});
