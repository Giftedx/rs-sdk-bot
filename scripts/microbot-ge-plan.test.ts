import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGEPlan,runGEPlanSession,validateGEPlan,gePlanEntry,reclaimGEPlanLock,type GEPricePlan} from './microbot-ge-plan';
import {geSaleRequest} from './microbot-ge-trip';

function fixture(lost=false){
 const dir=mkdtempSync(join(tmpdir(),'ge-plan-')),path=join(dir,'plan.json'),request:GEPricePlan={actor:'seller',server:'local',goal:'suggested',item:1511,quantity:3,reserve:2,floor:90,deadline:Date.now()+60000,cap:4000,prices:[{price:119,fillWait:2},{price:101,fillWait:2}]};
 let actions=0,calls=0,lostOnce=false;const assets:Record<number,number>={1511:5,995:10,2357:1},player={lifeId:1,respawnCount:0,worldX:3185,worldZ:3436,level:0,isDead:false};
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getSkill:()=>({level:99})}};
 const trip:any=async(_s:any,q:any,stop:()=>boolean,deps:any)=>{
  calls++;const parent=JSON.parse(readFileSync(path,'utf8'));expect(parent.current).toEqual(q);expect(parent.phase).toBe('running');
  if(!readFileSync(path,'utf8').includes('"current"'))throw Error('intent missing');
  if(!require('node:fs').existsSync(deps.paths.parent)){
   expect(stop()).toBe(false);const initial={...assets};gePlanEntry(parent.rounds.at(-1),{initial,initialGear:[]});actions++;const filled=q.goal.endsWith('p0')?1:q.quantity,gross=filled*q.price,tax=Math.floor(gross/20),outcome={filled,gross,tax,net:gross-tax,unsubmitted:false};
   assets[1511]-=filled;assets[995]+=outcome.net;
   writeFileSync(deps.paths.parent,JSON.stringify({version:1,request:q,phase:'banked',initial,initialGear:[],outcome}));
   writeFileSync(deps.paths.lower,JSON.stringify({version:1,request:geSaleRequest(q),phase:'settled',progress:{filled,gross,tax},claim:{items:q.quantity-filled,coins:outcome.net}}));
  }
  if(lost&&!lostOnce){lostOnce=true;return{ok:false,banked:true,failure:'lost return observation'};}
  return{ok:true,banked:true};
 };
 return{dir,path,request,s,player,assets,deps:{path,trip},counts:()=>({actions,calls})};
}
test('explicit partial modification settles old escrow before remaining relist and sums per-offer tax',async()=>{
 const f=fixture();try{const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r).toMatchObject({ok:true,remaining:0,filled:3,gross:321,tax:15,net:306});expect(r.journal!.rounds.map(r=>r.request.quantity)).toEqual([3,2]);expect(f.assets).toEqual({1511:2,995:316,2357:1});const before=f.counts(),replay=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(replay.replay).toBe(true);expect(f.counts()).toEqual(before);}finally{rmSync(f.dir,{recursive:true});}
});
test('lost parent acknowledgement retains same pending round and resumes without a second sale',async()=>{
 const f=fixture(true);try{const first=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(first.ok).toBe(false);expect(first.pending).toBe(true);expect(f.counts().actions).toBe(1);const resumed=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(resumed.ok).toBe(true);expect(f.counts()).toEqual({actions:2,calls:3});}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish settles only the explicit pending round and never starts a new suggested price',async()=>{
 const f=fixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const r=await runGEPlan(f.s,f.request,()=>false,f.deps,true);expect(r).toMatchObject({ok:true,finished:false,filled:1,remaining:2});expect(f.counts()).toEqual({actions:1,calls:2});}finally{rmSync(f.dir,{recursive:true});}
});
test('mutated between-round stock and changed durable plan identity refuse further payment',async()=>{
 const f=fixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);f.assets[2357]=2;const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(r.failure).toContain('between-round');expect(f.counts().actions).toBe(1);await expect(runGEPlan(f.s,{...f.request,reserve:1},()=>false,f.deps)).rejects.toThrow('identity');}finally{rmSync(f.dir,{recursive:true});}
});
test('unknown lower escrow cannot be declared banked or relisted; original-life replacement blocks next round',async()=>{
 const f=fixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8')),p=f.path+'.'+j.current.goal+'.sell.json',lower=JSON.parse(readFileSync(p,'utf8'));lower.phase='open';writeFileSync(p,JSON.stringify(lower));const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('plan limits and original stop refuse a fresh market intent',async()=>{
 const f=fixture();try{expect(()=>validateGEPlan({...f.request,prices:[]})).toThrow();expect(()=>validateGEPlan({...f.request,prices:[{price:89,fillWait:1}]})).toThrow();const r=await runGEPlan(f.s,f.request,()=>true,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(0);}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish lists explicit owned stock as fresh resting escrow and replay performs no lower action',async()=>{
 const f=fixture();let calls=0;const o:any={id:9,slot:0,item:1511,side:'sell',quantity:3,price:119,remaining:2,filled:1,state:'open',items:0,coins:114,gross:119,tax:5};
 f.s.sdk.getStateAge=()=>0;f.s.sdk.getEquipment=()=>[];f.s.sdk.getInventory=()=>[];f.s.sdk.getGEState=()=>({offers:[o]});
 const trip:any=async(_s:any,q:any,_stop:any,d:any)=>{calls++;writeFileSync(d.paths.parent,JSON.stringify({version:1,request:q,phase:'market',initial:f.assets,initialGear:[]}));writeFileSync(d.paths.lower,JSON.stringify({version:1,request:geSaleRequest(q),phase:'open',coinsBefore:0,itemsBefore:3,previousIds:[],offerId:9}));return{ok:false,recoveryDeferred:true};};
 try{const r=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);if(!r.ok)throw Error(r.failure);expect(r.ok).toBe(true);expect('resting' in r&&r.resting).toMatchObject({offerId:9,remaining:2,coinsEscrow:114,settled:false,banked:false});expect(r.journal!.phase).toBe('resting');const replay=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);expect(replay.replay).toBe(true);expect(calls).toBe(1);o.price=118;const foreign=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);expect(foreign.ok).toBe(false);expect(calls).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('same cached player life mutation after a round prevents the next price suggestion',async()=>{
 const f=fixture(),trip=f.deps.trip;f.deps.trip=async(...args:any[])=>{const r=await trip(...args);f.player.lifeId=2;return r;};
 try{const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish after saved-round crash window never creates the next price intent',async()=>{
 const f=fixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8')),child=JSON.parse(readFileSync(f.path+'.'+j.current.goal+'.json','utf8'));j.rounds.push({request:j.current,filled:child.outcome.filled,gross:child.outcome.gross,tax:child.outcome.tax,net:child.outcome.net,unsubmitted:false,initial:child.initial,gear:child.initialGear});delete j.current;writeFileSync(f.path,JSON.stringify(j));const before=f.counts(),r=await runGEPlan(f.s,f.request,()=>false,f.deps,true);expect(r).toMatchObject({ok:true,finished:false,filled:1,remaining:2});expect(f.counts()).toEqual(before);expect(r.journal!.current).toBeUndefined();}finally{rmSync(f.dir,{recursive:true});}
});
test('CLI lock recovery requires exact known dead PID and preserves live or unknown owners',()=>{
 const f=fixture(),path=join(f.dir,'owner.lock'),seen:number[]=[];try{writeFileSync(path,JSON.stringify({pid:17}));expect(()=>reclaimGEPlanLock(path,pid=>{seen.push(pid);return true;})).toThrow('already owned');expect(existsSync(path)).toBe(true);reclaimGEPlanLock(path,pid=>{seen.push(pid);return false;});expect(seen).toEqual([17,17]);expect(existsSync(path)).toBe(false);writeFileSync(path,JSON.stringify({pid:0}));expect(()=>reclaimGEPlanLock(path,()=>false)).toThrow('unknown');expect(existsSync(path)).toBe(true);}finally{rmSync(f.dir,{recursive:true});}
});


test('CLI session settles a thrown durable identity consumer failure without any sale',async()=>{
 const f=fixture();const settled:any[]=[];
 try{
  writeFileSync(f.path,JSON.stringify({version:1,request:{...f.request,reserve:1},phase:'prepared',rounds:[]}));
  const code=await runGEPlanSession(f.s,f.request,()=>false,f.deps,false,async(sessions,ok,reason)=>{settled.push({sessions,ok,reason});return ok;});
  expect(code).toBe(1);expect(settled).toEqual([{sessions:[f.s],ok:false,reason:'finite explicit GE price plan'}]);expect(f.counts()).toEqual({actions:0,calls:0});expect(f.assets).toEqual({1511:5,995:10,2357:1});
 }finally{rmSync(f.dir,{recursive:true});}
});
