import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionWalker} from '../packages/core/src/walk';
import {selectBankSales,bankSellerPrice,bankSellerPrices,validateBankSeller,runBankSeller,type BankSellerPolicy} from './microbot-bank-seller';
import {runGEPlan} from './microbot-ge-plan';
import {geSaleRequest} from './microbot-ge-trip';
const native=[{id:995,name:'Coins',tradeable:true},{id:1511,name:'Logs',tradeable:true},{id:556,name:'Air rune',tradeable:true},{id:2357,name:'Gold bar',tradeable:true},{id:1,name:'Tool kit',tradeable:false}];
function policy():BankSellerPolicy{return{actor:'seller',server:'local',goal:'allowned',allTradeable:true,protect:[2357],reserves:{1511:2},maxItems:3,maxUnits:10,perItem:4,discount:10,floor:1,unitCap:1000,fillWait:2,deadline:Date.now()+60000,cap:5000,childCap:1000};}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'bank-seller-')),path=join(dir,'parent.json'),r=policy(),player={lifeId:1,respawnCount:0,isDead:false},client={executeBotAction:()=>{}},assets:Record<number,number>={1511:7,556:3,2357:1,995:37},bank=[{id:1511,count:7},{id:556,count:3},{id:2357,count:1},{id:995,count:37}],calls:number[]=[],auditCalls:number[]=[];
 let stop=false,fail=false,drift=false;const s:any={name:'seller',client,lifecycle:{account:'seller',server:'local'},ended:new Promise(()=>{}),tick:()=>0,onTick:()=>()=>{},sdk:{config:{botUsername:'seller',browserLaunchUrl:'https://local/bot'},getState:()=>({player}),getSkill:()=>({level:99})}};
 const deps:any={path,catalogue:native,quote:async()=>100,inspect:async()=>({snapshot:{assets:{...assets},bank,gear:[]},protected:[],offers:[]}),audit:async()=>{auditCalls.push(1);return{assets:{...assets,...drift?{2357:2}:{}},bank,gear:[]};},plan:async(_s:any,q:any,_stop:any,d:any)=>{
  const parent=JSON.parse(readFileSync(path,'utf8'));expect(parent.plans).toContainEqual(q);expect(parent.request).toEqual(r);
  const child=d.path;if(existsSync(child)){const prior=JSON.parse(readFileSync(child,'utf8'));if(prior.phase==='complete')return{ok:true,replay:true};}
  calls.push(q.item);writeFileSync(child,JSON.stringify({version:1,request:q,phase:'running',rounds:[],current:{}}));if(fail)return{ok:false,pending:true};
  const filled=1,gross=q.prices[0].price,tax=Math.floor(gross/20),net=gross-tax;assets[q.item]-=filled;assets[995]+=net;
  writeFileSync(child,JSON.stringify({version:1,request:q,phase:'complete',rounds:[{filled,gross,tax,net}]}));return{ok:true,replay:false};
 }};return{dir,path,r,s,deps,assets,calls,auditCalls,player,client,setStop:(v:boolean)=>stop=v,stop:()=>stop,setFail:(v:boolean)=>fail=v,setDrift:(v:boolean)=>drift=v};
}
test('automatic bank order excludes starting/offer IDs, explicit protects, coins and native untradeables; retains exact reserves and finite bounds',()=>{
 const r=policy();const rows=[{id:1511,count:7},{id:556,count:3},{id:2357,count:1},{id:995,count:37},{id:1,count:1}];
 expect(selectBankSales(rows,[556],r,native).selected).toEqual([{id:1511,count:4}]);
 expect(selectBankSales(rows,[],{...r,maxUnits:5},native).selected).toEqual([{id:1511,count:4},{id:556,count:1}]);
 expect(selectBankSales(rows,[1512],r,[...native,{id:1512,name:'Logs',tradeable:true,baseId:1511}]).selected).toEqual([{id:556,count:3}]);
 expect(()=>selectBankSales([{id:999999,count:1}],[],r,native)).toThrow('metadata');expect(()=>selectBankSales([rows[0]!,rows[0]!],[],r,native)).toThrow('identity');
});
test('native integer discount compounds and finite policy must explicitly authorize bank-wide sales',()=>{
 expect(bankSellerPrice(100,10)).toBe(91);expect(bankSellerPrice(2,50)).toBe(1);expect(bankSellerPrice(119,50)).toBe(59);expect(bankSellerPrice(119,5)).toBe(114);
 expect(()=>validateBankSeller({...policy(),allTradeable:false}as any)).toThrow();expect(()=>validateBankSeller({...policy(),perItem:25})).toThrow();
});
test('parent intent precedes child mutation; partial filled lots settle before next type and terminal replay makes zero calls',async()=>{
 const f=fixture();try{const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(true);expect(f.calls).toEqual([1511,556]);expect(result.journal!.outcomes.map(o=>o.filled)).toEqual([1,1]);expect(f.assets).toEqual({1511:6,556:2,2357:1,995:211});const count=f.auditCalls.length;const replay=await runBankSeller(f.s,f.r,()=>true,f.deps);expect(replay.ok).toBe(true);expect(replay.replay).toBe(true);expect(f.calls).toEqual([1511,556]);expect(f.auditCalls.length).toBe(count);}finally{rmSync(f.dir,{recursive:true});}
});
test('unknown child escrow parks entire scan; resume recovers same item before later sale',async()=>{
 const f=fixture();try{f.setFail(true);const first=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(first.ok).toBe(false);expect(f.calls).toEqual([1511]);f.setFail(false);const next=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(next.ok).toBe(true);expect(f.calls).toEqual([1511,1511,556]);}finally{rmSync(f.dir,{recursive:true});}
});
test('stop makes zero new sale calls; full asset drift refuses before first child',async()=>{
 const f=fixture();try{f.setStop(true);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);f.setStop(false);f.setDrift(true);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('same mutable player life replacement during inspection stops before durable sales',async()=>{
 const f=fixture();try{const inspect=f.deps.inspect;f.deps.inspect=async()=>{const result=await inspect();f.player.lifeId++;return result;};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('executor replacement during inspection stops before any child or quote',async()=>{
 const f=fixture();try{const inspect=f.deps.inspect;f.deps.inspect=async()=>{const result=await inspect();f.client.executeBotAction=()=>{};return result;};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('parent cannot turn a protected bank row into a resumed child',async()=>{
 const f=fixture();try{f.setFail(true);await runBankSeller(f.s,f.r,f.stop,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8'));j.plans[0].item=2357;writeFileSync(f.path,JSON.stringify(j));f.setFail(false);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([1511]);}finally{rmSync(f.dir,{recursive:true});}
});
test('unrelated stock changes after a settled child prevent the next item',async()=>{
 const f=fixture();try{const plan=f.deps.plan;f.deps.plan=async(...args:any[])=>{const result=await plan(...args);f.assets[2357]++;return result;};const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(false);expect(f.calls).toEqual([1511]);expect(result.journal!.outcomes).toHaveLength(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('same gear values with different native container field order authorize the next settled bank boundary',async()=>{
 const f=fixture();try{const inspect=f.deps.inspect,audit=f.deps.audit;f.deps.inspect=async()=>{const v=await inspect();v.snapshot.gear=[{id:1289,count:1,slot:3}];return v;};f.deps.audit=async()=>({...await audit(),gear:[{id:1289,slot:3,count:1}]});expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(true);expect(f.calls).toEqual([1511,556]);}finally{rmSync(f.dir,{recursive:true});}
});
test('unsubmitted child returns an explicit failed banked result and never proceeds to the next type',async()=>{
 const f=fixture();try{f.deps.plan=async(_s:any,q:any,_stop:any,d:any)=>{f.calls.push(q.item);writeFileSync(d.path,JSON.stringify({version:1,request:q,phase:'stopped',rounds:[{filled:0,gross:0,tax:0,net:0,unsubmitted:true}]}));return{ok:true};};const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(false);expect(result.banked).toBe(true);expect(result.journal!.outcomes[0]!.unsubmitted).toBe(true);expect(f.calls).toEqual([1511]);}finally{rmSync(f.dir,{recursive:true});}
});
test('actual sessionWalker direct continuation cannot dispatch walk, door or run through a replaced owner',async()=>{
 const f=fixture();let direct=0;try{f.s.direct=async()=>{direct++;};f.deps.plan=async(view:any)=>{const walker=await sessionWalker(view);await Promise.resolve();f.client.executeBotAction=()=>{};for(const action of[()=>walker.walk(3185,3436),()=>walker.interactLoc!({id:1,x:3184,z:3436}as any,1),()=>walker.runOn!()])await expect(action()).rejects.toThrow('direct original');return{ok:false,pending:true};};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(direct).toBe(0);}finally{rmSync(f.dir,{recursive:true});}
});
test('exported API rejects actual account, server and HTTP-origin mismatch before inspection',async()=>{
 for(const kind of['account','server','origin']){const f=fixture();let inspected=0;try{f.deps.inspect=async()=>{inspected++;throw Error('unexpected inspection');};if(kind==='account')f.s.lifecycle.account='other';if(kind==='server')f.s.lifecycle.server='foreign';if(kind==='origin')f.s.sdk.config.browserLaunchUrl='https://foreign/bot';await expect(runBankSeller(f.s,f.r,f.stop,f.deps)).rejects.toThrow('actual session');expect(inspected).toBe(0);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}}
});
test('liquidation requires an explicit1GP floor and finite native wait; default price plan stays one unchanged round',()=>{
 const r=policy();expect(bankSellerPrices(91,r)).toEqual([{price:91,fillWait:2}]);const enabled={...r,floor:1,childCap:1500,liquidation:{waitTicks:150,fillWait:10}};validateBankSeller(enabled);expect(bankSellerPrices(91,enabled)).toEqual([{price:91,fillWait:150},{price:1,fillWait:10}]);expect(bankSellerPrices(1,enabled)).toEqual([{price:1,fillWait:150}]);for(const p of[{...enabled,floor:2},{...enabled,childCap:1499},{...enabled,liquidation:{waitTicks:149,fillWait:10}}])expect(()=>validateBankSeller(p)).toThrow('liquidation');
});
test('actual durable GE plan liquidates only previously-unsold owned quantity and sums tax per offer',async()=>{
 const f=fixture();try{f.r.maxItems=1;f.r.childCap=1500;f.r.liquidation={waitTicks:150,fillWait:10};const offered:{quantity:number;price:number;wait:number}[]=[];
  f.deps.plan=async(s:any,q:any,stop:any,d:any)=>runGEPlan(s,q,stop,{...d,trip:async(_s:any,request:any,_stop:any,paths:any)=>{
   const initial={...f.assets},first=offered.length===0,filled=first?1:request.quantity,gross=filled*request.price,tax=Math.floor(gross/20),net=gross-tax;offered.push({quantity:request.quantity,price:request.price,wait:request.fillWait});f.assets[request.item]-=filled;f.assets[995]+=net;const outcome={filled,gross,tax,net,unsubmitted:false};writeFileSync(paths.paths.parent,JSON.stringify({version:1,request,phase:'banked',initial,initialGear:[],outcome}));writeFileSync(paths.paths.lower,JSON.stringify({version:1,request:geSaleRequest(request),phase:'settled',progress:{filled,gross,tax},claim:{items:request.quantity-filled,coins:net}}));return{ok:true,banked:true}as any;
  }});
  const r=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(r.ok).toBe(true);expect(offered).toEqual([{quantity:4,price:91,wait:150},{quantity:3,price:1,wait:10}]);expect(r.journal!.outcomes[0]).toEqual({filled:4,gross:94,tax:4,net:90,unsubmitted:false});expect(f.assets[1511]).toBe(3);expect(f.assets[556]).toBe(3);const count=offered.length;expect((await runBankSeller(f.s,f.r,()=>true,f.deps)).replay).toBe(true);expect(offered).toHaveLength(count);
 }finally{rmSync(f.dir,{recursive:true});}
});
