import {test,expect} from 'bun:test';
import {goTo} from '../src/walk';
import {guildActorFacts} from '../src/guild-observation';

function fixture(branch:'crossed'|'refused'|'foreign',started=false){
 let tick=0,page=0,opened=false,calls=0;
 const p={worldX:2729,worldZ:3349,level:0};
 const client:any={ingame:true,mainModalId:-1,ifType:(id:number)=>id===8144?{text:'The Legends Quest'}:id===7366&&started?{colour:0xf8f800}:{}};
 const pages=[{text:'Yes sir, how can I help you?',options:[{index:0,text:'Click here to continue'}]},
  {text:'',options:[{index:3,text:'What is this place?'}]},
  {text:'This is the Legends Guild!',options:[{index:0,text:'Click here to continue'}]},
  {text:'',options:[{index:2,text:'Can I go on the quest?'}]},
  branch==='refused'?{text:"I'm very sorry but you need to complete more quests before you can go on this quest.",options:[{index:0,text:'Click here to continue'}]}:{text:'',options:[{index:4,text:"Yes, I'd like to talk to Grand Vizier Erkle."}]},
  {text:'The guard unlocks the gate and pushes it open for you.',options:[{index:0,text:'Click here to continue'}]}];
 const state={player:p,skills:[],inventory:[],equipment:[],nearbyLocs:[{id:2392,x:2729,z:3349,level:0,distance:0}]};
 const s:any={client,tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;queueMicrotask(()=>{if(active){tick++;cb();}});return()=>{active=false;};},
  sdk:{getState:()=>state,getDialog:()=>branch==='foreign'?{isOpen:true,text:'Foreign trade or quest',options:[]}:opened&&page<pages.length?{isOpen:true,isWaiting:false,...pages[page]}:null,
   sendClickDialog:async()=>{page++;if(page===pages.length&&branch==='crossed')p.worldZ=3350;return{success:true};}},
  direct:async(a:any)=>{calls++;if(a.type==='clickComponent')client.mainModalId=8134;if(a.type==='closeModal')client.mainModalId=-1;if(a.type==='interactLoc')opened=true;return{success:true};},bot:{}};
 let routes=0,planned:any;const world:any={route:(from:any,_to:any,actor:any)=>{routes++;planned={from,actor};return{ok:true,legs:[],cost:0};}};
 return{s,world,p,client,get routes(){return routes;},get planned(){return planned;},get calls(){return calls;}};
}
const goal={x:2728,z:3351,level:0},account={skills:{},varps:{},items:[]};

test('fresh owned missing-quest refusal returns before expensive world search and is not cached',async()=>{
 const f=fixture('refused');const result=await goTo(f.s,f.world,goal,account);
 expect(result).toMatchObject({ok:false,reason:'precondition',detail:'Legends Guild guard refused first entry'});expect(f.routes).toBe(0);expect(f.p.worldZ).toBe(3349);
 expect(guildActorFacts(f.client)).toEqual({varps:{},questStages:{},unlocks:[]});expect(result.ticks).toBeGreaterThanOrEqual(0);
},3000);
test('actual first crossing plans from inside without fabricating quest stage1',async()=>{
 const f=fixture('crossed');expect((await goTo(f.s,f.world,goal,account)).ok).toBe(true);expect(f.routes).toBe(1);expect(f.planned.from).toEqual({x:2729,z:3350,level:0});expect(f.planned.actor.questStages).toEqual({});
},3000);
test('unobserved first entry preserves foreign UI and cannot start global no-route search',async()=>{
 const f=fixture('foreign');const result=await goTo(f.s,f.world,goal,account);expect(result).toMatchObject({ok:false,reason:'precondition',detail:'Legends Guild first entry was not observed'});expect(f.routes).toBe(0);expect(f.calls).toBe(0);
},3000);
test('observed started quest keeps its ordinary gate route when no first-entry probe is possible',async()=>{
 const f=fixture('foreign',true);expect((await goTo(f.s,f.world,goal,account)).ok).toBe(true);expect(f.routes).toBe(1);expect(f.planned.actor.questStages.legendsquest).toBe(1);expect(f.calls).toBe(0);
},3000);
test('already inside the courtyard at quest zero does not repeat or require first admission',async()=>{
 const f=fixture('foreign');f.p.worldX=2730;f.p.worldZ=3350;
 expect((await goTo(f.s,f.world,goal,account)).ok).toBe(true);expect(f.routes).toBe(1);expect(f.planned.actor.questStages).toEqual({});expect(f.calls).toBe(0);
},3000);
