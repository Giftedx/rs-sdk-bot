import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {runeContinuationHelpers,runeContinuationVarpDifferences,runeMeasurementBankedOutput} from '../packages/practice/src/rune-continuation-proof';

test('saved measurement rejects moving otherwise conserved output from bank to backpack',()=>{
 const before={inventories:{93:[],95:[{slot:0,id:559,count:12522}]}},after={inventories:{93:[] as {slot:number;id:number;count:number}[],95:[{slot:0,id:559,count:13494}]}};
 expect(runeMeasurementBankedOutput(before,after,972)).toBe(true);
 const mutated=structuredClone(after);mutated.inventories[95][0]!.count-=972;mutated.inventories[93].push({slot:0,id:559,count:972});
 const total=(s:typeof after)=>Object.values(s.inventories).flat().reduce((n,i)=>n+i.count,0);
 expect(total(mutated)).toBe(total(after));
 expect(runeMeasurementBankedOutput(before,mutated,972)).toBe(false);
 expect(runeMeasurementBankedOutput(before,after,973)).toBe(false);
});

test('continuation reconciles dense and sparse lifecycle varps without accepting quest or unexplained changes',()=>{
 const before={version:6,vars:Object.fromEntries(Array.from({length:309},(_,id)=>[id,id===63?6:id===281?1000:0]))};
 const after={version:10,vars:{21:1114112,25:16384,63:6,101:1,134:923,166:2,168:2,169:2,275:4294967295,277:4294967295,281:1000,300:1000,346:2,367:4294967295}};
 const refusal={version:10,vars:{...after.vars,134:999,4:4294967295,9:4294967295,13:4294967295,16:4294967295,28:4294967295,64:4294967295,181:4294967295,209:4294967295}};
 expect(runeContinuationVarpDifferences(before,after,'craft')).toEqual([]);
 expect(runeContinuationVarpDifferences(after,refusal,'refusal')).toEqual([]);
 for(const [b,a,phase] of [[before,after,'craft'],[after,refusal,'refusal']] as const){
  for(const [id,value] of [[63,5],[29,1],[4,12345],[21,1114113],[101,2],[300,999],[134,0],[390,1]]){
   expect(runeContinuationVarpDifferences(b,{...a,vars:{...a.vars,[id!]:value!}},phase).some(d=>d.id===id)).toBe(true);
  }
 }
 expect(runeContinuationVarpDifferences({...after,vars:{...after.vars,4:12345}},refusal,'refusal').some(d=>d.id===4)).toBe(true);
 const falador={...after,vars:{...after.vars,21:1118208,24:2148532224}};
 expect(runeContinuationVarpDifferences(before,falador,'craft','falador-bank')).toEqual([]);
 expect(runeContinuationVarpDifferences(before,falador,'craft').map(d=>d.id)).toEqual([21,24]);
 for(const [id,value]of [[63,5],[21,1118209],[24,2148532225]])expect(runeContinuationVarpDifferences(before,{...falador,vars:{...falador.vars,[id!]:value!}},'craft','falador-bank').some(d=>d.id===id)).toBe(true);
});

function bankApproach(mode:'far'|'near'|'cancel'){
 const code=`
 import {mock} from 'bun:test';
 import {resolve} from 'node:path';
 let player={worldX:${mode==='near'?3092:3011},worldZ:${mode==='near'?3491:3355},level:0},generation=7,open=false,approaches=0,opens=0,routes=0,aborted=false;const budgets=[];
 let inventory=[{id:1446,count:1},{id:1436,count:27}],items=[{id:1436,count:108}];
 const loc={id:2213,x:3095,z:3491,level:0,name:'Bank booth',distance:4,optionsWithIndex:[{text:'Use',opIndex:1},{text:'Use-quickly',opIndex:2}]};
 const s={name:'retained',tick:()=>100,bankObservation:()=>({generation,items}),
  sdk:{getInventory:()=>inventory,getSkill:()=>({level:10}),getState:()=>({player,nearbyLocs:[loc],bank:{isOpen:open,items}})},
  bot:{openBank:async()=>{opens++;if(player.worldX!==3094||player.worldZ!==3491)throw Error('travel tolerance is not booth reach');open=true;generation++;return {success:true};}}
 };
 const modules={
 '../packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
 '../packages/core/src/walk':{sessionWalker:async()=>s,walkPath:async(_w,[p],opts)=>{budgets.push(opts.maxTicks);if(player.worldZ<3400)throw Error('long Falador staging exceeds refill150tick budget');if(p.x===3092&&p.z===3496){player={worldX:3092,worldZ:3491,level:0};return{ok:false,ticks:151,still:23,repaths:3,detail:'live bank waypoint stalled'}}player={worldX:p.x,worldZ:p.z,level:0};return {ok:true};},
 walkRoute:async(_w,[leg],opts)=>{routes++;if(leg.kind!=='walk'||leg.to.x!==3094||leg.to.z!==3491||leg.to.level!==0||leg.tolerance!==2||!opts.signal)throw Error('wrong staging leg');if('${mode}'==='cancel'){queueMicrotask(()=>stopCarriers());await new Promise(r=>opts.signal.addEventListener('abort',()=>{aborted=true;r();},{once:true}));return{ok:false,reason:'aborted',ticks:1};}player={worldX:leg.to.x,worldZ:leg.to.z,level:0};return{ok:true,ticks:161};}},
 '../packages/core/src/world':{interactionApproach:async(_sdk,at,q)=>{approaches++;if(at.x!==3095||at.z!==3491||at.level!==0||q.id!==2213||q.shape!==10||q.angle!==3||q.width!==1||q.height!==1||q.blockAccessFlags!==0)throw Error('wrong booth geometry');return {x:3094,z:3491,level:0};}},
 '../packages/core/src/deposit':{depositObserved:async(_s,item)=>{if(!open||generation<=7)throw Error('stale bank');const held=inventory.find(i=>i.id===item.id);const bank=items.find(i=>i.id===item.id);if(bank)bank.count+=held.count;else items.push({...held});inventory=inventory.filter(i=>i.id!==item.id);generation++;}},
 './rune-bank-craft':{RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442}}],ruinTarget:()=>({}),dispatchRuneEntry:async()=>({})},
 './rune-carrier-trade':{state:a=>a.sdk.getState(),ess:()=>0}
 };
 for(const [p,m]of Object.entries(modules))mock.module(resolve('scripts',p),()=>m);
 const {bankCarrier,stopCarriers}=await import('./scripts/rune-carrier-bank');
 let assets,failure;try{assets=await bankCarrier(s);}catch(e){failure=String(e);}console.log(JSON.stringify({assets,failure,approaches,opens,generation,inventory,routes,budgets,aborted}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('Falador staging uses the distance-budget route before observing the booth and bank',()=>{
 const r=bankApproach('far');expect(r.failure).toBeUndefined();expect(r.routes).toBe(1);expect(r.budgets).toEqual([150]);
 expect(r.assets).toEqual({1436:135,1446:1});expect(r.inventory).toEqual([]);
 expect(r.approaches).toBeGreaterThan(0);expect(r.opens).toBe(1);expect(r.generation).toBe(10);
});
test('near-bank staging retains its150tick walks and exact booth face',()=>{
 const r=bankApproach('near');expect(r.failure).toBeUndefined();expect(r.routes).toBe(0);expect(r.budgets).toEqual([150,150]);expect(r.opens).toBe(1);
});
test('stopping a long staging leg aborts it before opening or depositing',()=>{
 const r=bankApproach('cancel');expect(r.aborted).toBe(true);expect(r.failure).toContain('carrier stopped');expect(r.opens).toBe(0);expect(r.inventory).toEqual([{id:1446,count:1},{id:1436,count:27}]);
});
test('measurement allocates only full packs on an existing99 while normal continuation still refuses99',()=>{
 const code=`import{continuationLoads}from'./scripts/rune-carriers';
 const stocks=Array(16).fill(405),errors=[];const measure=continuationLoads(998625,stocks,187.5,37);
 for(const args of [[998625,stocks,187.5],[793125,stocks,187.5,37],[199999000,stocks,187.5,13],[998625,Array(16).fill(26),187.5,12],[998625,stocks,187.5,49]]){try{continuationLoads(...args);errors.push('accepted');}catch(e){errors.push(String(e));}}
 console.log(JSON.stringify({measure,errors}));`;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(r.measure.needed).toBe(999);expect(r.measure.loads.flat()).toHaveLength(37);expect(r.measure.loads.flat().every((n:number)=>n===27)).toBe(true);expect(r.errors).toHaveLength(5);expect(r.errors.every((e:string)=>e!=='accepted')).toBe(true);
});

function continuationCase(measurePacks?:number,craftAfter='inventory'){
 const code=`
 import {mock} from 'bun:test';
 import {resolve} from 'node:path';
 let tick=0,stopped=false,xp=${measurePacks===undefined?793125:998625},starterCalls=0,swaps=0,bankFailure=false;
 const options=${JSON.stringify({measurePacks,craftAfter})};let craftCalls=0;
 const sum=(a,id)=>a.pack[id]??0;
 const fixtures=${JSON.stringify(runeContinuationHelpers)};
 const actor=(i)=>({name:'retained'+i,pack:i?{1446:1,...(fixtures[i-1][2]?{1436:fixtures[i-1][2]}:{})}:{559:9234},bank:i?{1436:fixtures[i-1][3],...(i===2?{1446:1}:{})}:{995:500,559:7},position:i&&fixtures[i-1][1]<4800?'bank-route':'altar',
  tick:()=>tick,bot:{dismissBlockingUI:async()=>({success:true})},
  sdk:{getInventory(){return Object.entries(this.owner.pack).filter(([,n])=>n).map(([id,count])=>({id:+id,count}));},getEquipment:()=>[],getSkillXp:()=>xp,getSkill:n=>({baseLevel:n==='Runecraft'?(xp>=998458?99:95):10,level:10}),getState(){return {player:{worldX:2523,worldZ:4833,level:0},nearbyLocs:[{id:2483,x:2521,z:4840}]};}},
  direct:async function(){craftCalls++;const n=sum(this,1436);delete this.pack[1436];this.pack[559]=(this.pack[559]??0)+n*3;xp+=n*187.5;tick+=2;return{success:true};}
 });
 const all=Array.from({length:17},(_,i)=>actor(i));for(const a of all)a.sdk.owner=a;
 const move=(a,b,items)=>{for(const [id,n] of Object.entries(items)){if(sum(a,id)!==n)throw Error('whole item swap mismatch');delete a.pack[id];b.pack[id]=(b.pack[id]??0)+n;}};
 const bank=async a=>{if(bankFailure){if(a===all[1])throw Error('first bank refusal');await Promise.resolve();await Promise.resolve();throw Error('secondary carrier stopped');}if(stopped)throw Error('stopped');for(const [id,n]of Object.entries(a.pack))a.bank[id]=(a.bank[id]??0)+n;a.pack={};a.position='bank';tick+=4;return {...a.bank};};
 const withdraw=async(a,id,n)=>{if((a.bank[id]??0)<n)throw Error('short');a.bank[id]-=n;if(!a.bank[id])delete a.bank[id];a.pack[id]=(a.pack[id]??0)+n;};
 const modules={
 '../packages/core/src/bot':{getWorld:async()=>({}),openBot:async()=>{throw Error('unexpected open')},settle:async()=>true,serverFromEnv:()=>''},
 '../packages/core/src/fleet':{assertSideOwns:()=>{}},
 '../packages/core/src/ticks':{waitTicks:async()=>{},waitUntil:async(_s,p)=>{for(let i=0;i<30&&!p();i++)await Promise.resolve();return p();}},
 './rune-carrier-start':{freshBodyStart:async()=>{starterCalls++;throw Error('tutorial prohibited');}},
 './rune-carrier-bank':{bankCarrier:bank,withdrawCarrier:withdraw,closeCarrierBank:async()=>{},inside:a=>a.position==='altar',enterBody:async a=>{a.position='altar';},stopCarriers:()=>{stopped=true;},restock:async()=>{throw Error('fresh refill prohibited');},
  stageCarrier:async(a,n,fromBank)=>{if(!fromBank)await bank(a);await withdraw(a,1446,1);await withdraw(a,1436,n);a.position='altar';}},
 './rune-carrier-trade':{ess:a=>sum(a,1436),state:a=>a.sdk.getState(),ownedSwap:async(a,b,giveA,giveB)=>{swaps++;move(a,b,giveA);move(b,a,giveB);return{ticks:1};},transfer:async(a,b,_stop,n=27,craft)=>{move(b,a,{1436:n});tick+=10;if(craft)await craft.send();return 10;}}
 };
 for(const [p,m]of Object.entries(modules))mock.module(resolve('scripts',p),()=>m);
 const {continueRuneBody}=await import('./scripts/rune-carriers');
 const r=await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800,options);
 let normalRefusal;try{await continueRuneBody(all[0],all.slice(1),()=>stopped);}catch(e){normalRefusal=String(e);}
 xp=${measurePacks===undefined?793125:998625};bankFailure=true;let failure;
 try{await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800,options);}catch(e){failure=String(e);}
 console.log(JSON.stringify({r,starterCalls,swaps,tick,failure,normalRefusal,craftCalls}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('persisted95 uses mixed retained stock and positions without tutorial or starter swaps',()=>{
 const {r,starterCalls,swaps,tick,failure,normalRefusal}=continuationCase();
 expect(normalRefusal).toContain('below99');
 expect(failure).toBe('Error: first bank refusal');
 expect(starterCalls).toBe(0);expect(swaps).toBeGreaterThanOrEqual(2);
 expect(r.xp0).toBe(793125);expect(r.level).toBe(99);expect(r.consumed).toBe(1096);expect(r.crafted).toBe(3288);
 expect(new Set(r.rows.slice(0,16).map((row:any)=>row.helper)).size).toBe(16);
 expect(r.before.slice(1).reduce((n:number,b:any)=>n+(b[1436]??0),0)).toBe(8628);
 expect(r.after[0][559]).toBe(9234+7+3288);expect(r.after[0][995]).toBe(500);
 expect(r.after[2][1446]).toBe(2);expect(r.after[0][1446]??0).toBe(0);expect(tick).toBeLessThan(2800);
});
test('existing99 measurement banks exactly37 full packs while ordinary entry still refuses it',()=>{
 const {r,starterCalls,swaps,failure,normalRefusal}=continuationCase(37);
 expect(r.mode).toBe('body-measure');expect(r.requestedPacks).toBe(37);expect(r.batches).toBe(37);expect(r.consumed).toBe(999);expect(r.crafted).toBe(2997);expect(r.xp0).toBe(998625);expect(r.xp).toBe(1185937.5);
 expect(r.after[0][559]).toBe(9234+7+2997);expect(new Set(r.rows.slice(0,16).map((row:any)=>row.helper)).size).toBe(16);expect(starterCalls).toBe(0);expect(swaps).toBe(2);expect(failure).toBe('Error: first bank refusal');expect(normalRefusal).toContain('below99');
});
test('combined continuation crafting dispatches once per measured pack with the same final balances',()=>{
 const {r,craftCalls,normalRefusal}=continuationCase(37,'trade-message');expect(r.craftAfter).toBe('trade-message');expect(craftCalls).toBe(37);expect(r.consumed).toBe(999);expect(r.crafted).toBe(2997);expect(r.after[0][559]).toBe(12238);expect(normalRefusal).toContain('below99');
});
