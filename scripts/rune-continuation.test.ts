import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {runeContinuationHelpers,runeContinuationVarpDifferences} from '../packages/practice/src/rune-continuation-proof';

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

test('bankCarrier reaches the booth face before opening a fresh bank and depositing retained stock',()=>{
 const code=`
 import {mock} from 'bun:test';
 import {resolve} from 'node:path';
 let player={worldX:3011,worldZ:3355,level:0},generation=7,open=false,approaches=0,opens=0;
 let inventory=[{id:1446,count:1},{id:1436,count:27}],items=[{id:1436,count:108}];
 const loc={id:2213,x:3095,z:3491,level:0,name:'Bank booth',distance:4,optionsWithIndex:[{text:'Use',opIndex:1},{text:'Use-quickly',opIndex:2}]};
 const s={name:'retained',tick:()=>100,bankObservation:()=>({generation,items}),
  sdk:{getInventory:()=>inventory,getSkill:()=>({level:10}),getState:()=>({player,nearbyLocs:[loc],bank:{isOpen:open,items}})},
  bot:{openBank:async()=>{opens++;if(player.worldX!==3094||player.worldZ!==3491)throw Error('travel tolerance is not booth reach');open=true;generation++;return {success:true};}}
 };
 const modules={
 '../packages/core/src/ticks':{waitUntil:async(_s,p)=>p()},
 '../packages/core/src/walk':{sessionWalker:async()=>s,walkPath:async(_w,[p])=>{if(p.x===3092&&p.z===3496){player={worldX:3092,worldZ:3491,level:0};return{ok:false,ticks:151,still:23,repaths:3,detail:'live bank waypoint stalled'}}player={worldX:p.x,worldZ:p.z,level:0};return {ok:true};}},
 '../packages/core/src/world':{interactionApproach:async(_sdk,at,q)=>{approaches++;if(at.x!==3095||at.z!==3491||at.level!==0||q.id!==2213||q.shape!==10||q.angle!==3||q.width!==1||q.height!==1||q.blockAccessFlags!==0)throw Error('wrong booth geometry');return {x:3094,z:3491,level:0};}},
 '../packages/core/src/deposit':{depositObserved:async(_s,item)=>{if(!open||generation<=7)throw Error('stale bank');const held=inventory.find(i=>i.id===item.id);const bank=items.find(i=>i.id===item.id);if(bank)bank.count+=held.count;else items.push({...held});inventory=inventory.filter(i=>i.id!==item.id);generation++;}},
 './rune-bank-craft':{RUNE_ALTARS:[{name:'body',outside:{x:3050,z:3442}}],ruinTarget:()=>({}),dispatchRuneEntry:async()=>({})},
 './rune-carrier-trade':{state:a=>a.sdk.getState(),ess:()=>0}
 };
 for(const [p,m]of Object.entries(modules))mock.module(resolve('scripts',p),()=>m);
 const {bankCarrier}=await import('./scripts/rune-carrier-bank');
 const assets=await bankCarrier(s);console.log(JSON.stringify({assets,approaches,opens,generation,inventory}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(r.assets).toEqual({1436:135,1446:1});expect(r.inventory).toEqual([]);
 expect(r.approaches).toBeGreaterThan(0);expect(r.opens).toBe(1);expect(r.generation).toBe(10);
});

test('persisted95 uses mixed retained stock and positions without tutorial or starter swaps',()=>{
 const code=`
 import {mock} from 'bun:test';
 import {resolve} from 'node:path';
 let tick=0,stopped=false,xp=793125,starterCalls=0,swaps=0,bankFailure=false;
 const sum=(a,id)=>a.pack[id]??0;
 const fixtures=${JSON.stringify(runeContinuationHelpers)};
 const actor=(i)=>({name:'retained'+i,pack:i?{1446:1,...(fixtures[i-1][2]?{1436:fixtures[i-1][2]}:{})}:{559:9234},bank:i?{1436:fixtures[i-1][3],...(i===2?{1446:1}:{})}:{995:500,559:7},position:i&&fixtures[i-1][1]<4800?'bank-route':'altar',
  tick:()=>tick,bot:{dismissBlockingUI:async()=>({success:true})},
  sdk:{getInventory(){return Object.entries(this.owner.pack).filter(([,n])=>n).map(([id,count])=>({id:+id,count}));},getEquipment:()=>[],getSkillXp:()=>xp,getSkill:n=>({baseLevel:n==='Runecraft'?(xp>=998458?99:95):10,level:10}),getState(){return {player:{worldX:2523,worldZ:4833,level:0},nearbyLocs:[{id:2483,x:2521,z:4840}]};}},
  direct:async function(){const n=sum(this,1436);delete this.pack[1436];this.pack[559]=(this.pack[559]??0)+n*3;xp+=n*187.5;tick+=2;}
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
 './rune-carrier-trade':{ess:a=>sum(a,1436),state:a=>a.sdk.getState(),ownedSwap:async(a,b,giveA,giveB)=>{swaps++;move(a,b,giveA);move(b,a,giveB);return{ticks:1};},transfer:async(a,b,_stop,n=27)=>{move(b,a,{1436:n});tick+=10;return 10;}}
 };
 for(const [p,m]of Object.entries(modules))mock.module(resolve('scripts',p),()=>m);
 const {continueRuneBody}=await import('./scripts/rune-carriers');
 const r=await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800);
 xp=793125;bankFailure=true;let failure;
 try{await continueRuneBody(all[0],all.slice(1),()=>stopped||tick>2800);}catch(e){failure=String(e);}
 console.log(JSON.stringify({r,starterCalls,swaps,tick,failure}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 const {r,starterCalls,swaps,tick,failure}=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
 expect(failure).toBe('Error: first bank refusal');
 expect(starterCalls).toBe(0);expect(swaps).toBeGreaterThanOrEqual(2);
 expect(r.xp0).toBe(793125);expect(r.level).toBe(99);expect(r.consumed).toBe(1096);expect(r.crafted).toBe(3288);
 expect(r.before.slice(1).reduce((n:number,b:any)=>n+(b[1436]??0),0)).toBe(8628);
 expect(r.after[0][559]).toBe(9234+7+3288);expect(r.after[0][995]).toBe(500);
 expect(r.after[2][1446]).toBe(2);expect(r.after[0][1446]??0).toBe(0);expect(tick).toBeLessThan(2800);
});
