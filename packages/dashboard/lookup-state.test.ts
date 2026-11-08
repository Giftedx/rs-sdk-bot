import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
test('pending or failed lookups do not assert that a player is offline',()=>{
 const code=shell.slice(shell.indexOf('  function lookupCard(l){'),shell.indexOf('  function lookup(name){'));
 const card=new Function('l','E','age','window',`${code};return lookupCard(l);`);
 for(const note of ['Looking up…','Lookup failed']){
  const html=card({name:'Worker',rows:null,note},String,String,{});
  expect(html).toContain('presence not loaded');expect(html).not.toContain('not seen online');
 }
 expect(card({name:'Worker',rows:null,online:false},String,String,{})).toContain('not seen online');
});

test('the current roster overrides cached online status without losing lookup details',()=>{
 const code=shell.slice(shell.indexOf('  function lookupCard(l){'),shell.indexOf('  function refreshWorldLookup(){'));
 const card=new Function('l','E','age','window','LIVE_ROSTER','placeOf',`${code};return lookupCard(l);`);
 const snapshot={name:'Worker',rows:null,online:true,combat:20,note:'Published lookup'};
 const live={atlasLiveRoster:()=>true};
 const missing=card(snapshot,String,String,live,{players:[]},()=> 'Varrock');
 expect(missing).toContain('not seen online');
 expect(missing).not.toContain('Watch in 3D');
 const seen=card(snapshot,String,String,live,{players:[['wOrKeR',3210,3220,0,77]]},()=> 'Varrock');
 expect(seen).toContain('online Varrock');
 expect(seen).toContain('Combat <b>77</b>');
 expect(seen).toContain('Watch in 3D');
 expect(seen).toContain('Published lookup');
});

test('an older lookup cannot overwrite a newer request for the same player',async()=>{
 const code=shell.slice(shell.indexOf('  let worldLookup=null'),shell.indexOf('  // Info'))+shell.slice(shell.indexOf('  function refreshWorldLookup(){'),shell.indexOf('  window.atlasLookup=lookup;'));
 const pending:Array<(r:Response)=>void>=[];
 const run=new Function('fetch','body','put',`const selectedPlugin='world',lookupCard=JSON.stringify;${code};return {lookup,value:()=>worldLookup};`)(()=>new Promise<Response>(r=>pending.push(r)),{querySelector:()=>({innerHTML:''})},(el:{innerHTML:string},html:string)=>el.innerHTML=html);
 run.lookup('Worker');run.lookup('Other');run.lookup('Worker');
 pending[2]!(Response.json({name:'Worker',marker:'new'}));await Bun.sleep(0);
 pending[0]!(Response.json({name:'Worker',marker:'old'}));await Bun.sleep(0);
 expect(run.value().marker).toBe('new');
 pending[1]!(Response.json({name:'Other'}));await Bun.sleep(0);
});
