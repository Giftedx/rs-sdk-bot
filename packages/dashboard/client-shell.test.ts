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

function lookupHarness(fetch:typeof globalThis.fetch){
 const code=shell.slice(shell.indexOf('  function lookup(name){'),shell.indexOf('  window.atlasLookup=lookup;'));
 const target={innerHTML:''};
 return new Function('fetch','body','lookupCard',`let worldLookupName='',worldLookup=null,selectedPlugin='world';const showPlugin=()=>{};${code};return{lookup,value:()=>worldLookup};`)(fetch,{querySelector:()=>target},JSON.stringify);
}

test('player lookup shows HTTP errors instead of an unnamed empty player',async()=>{
 const h=lookupHarness(async()=>Response.json({error:'Player service unavailable'},{status:503}));
 h.lookup('Worker');await Bun.sleep(0);
 expect(h.value().name).toBe('Worker');expect(h.value().note).toContain('Player service unavailable');
});

test('an old lookup failure cannot overwrite the player chosen afterward',async()=>{
 let rejectOld!:(error:Error)=>void;
 const h=lookupHarness((url:any)=>String(url).includes('Old')?new Promise((_resolve,reject)=>{rejectOld=reject;}):Promise.resolve(Response.json({name:'New',rows:[]})));
 h.lookup('Old');h.lookup('New');await Bun.sleep(0);rejectOld(Error('Old lookup failed'));await Bun.sleep(0);
 expect(h.value().name).toBe('New');expect(h.value().rows).toEqual([]);
});

test('infoboxes: a reached goal has no goal box', () => {
 const code=shell.slice(shell.indexOf('  function infoboxes(){'),shell.indexOf('  // Board progress'));
 const el={innerHTML:''};
 const run=new Function('account','hud','E','asset','skillFile','dur','age','realSkill',code+';infoboxes();');
 const stubs=[{querySelector:()=>el},String,(n:string)=>n,(n:string)=>n.toLowerCase(),String,String,(k:any)=>k.name!=='Overall'] as const;
 run(()=>({name:'Worker',goalSkill:'Thieving',goalLevel:99,goalNow:99,eta:'0m 0s',skills:[]}),...stubs);expect(el.innerHTML).not.toContain('Thieving');
 run(()=>({name:'Worker',goalSkill:'Thieving',goalLevel:99,goalNow:60,eta:'2h',skills:[]}),...stubs);expect(el.innerHTML).toContain('Thieving 60 → 99 in 2h');
});
