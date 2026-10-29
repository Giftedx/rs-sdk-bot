// One real engagement -> frozen adjacent cancellation helper -> bank. Never runs an imp camp.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {openBot,finish} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../../packages/core/src/walk';
import {cancelImpTarget,guardImpWalker,impInsideFence} from '../gather-imps';
import {equipCowKit} from '../gather-combat';
import {parseJm2} from '../../packages/knowledge/src/jm2';
const sourceSha256=createHash('sha256').update(readFileSync('scripts/gather-imps.ts')).digest('hex').toUpperCase();
if(sourceSha256!=='ACD265B5BB2F72DF3A3F34285C0E8E0F195672ED608D033E2B235661B299F42D')throw new Error('frozen cancellation source changed');
const sword=JSON.parse(readFileSync('.practice/status/Swordinhand.json','utf8'));
if(!Array.isArray(sword.equipment))throw new Error('public Sword equipment unknown');
const route=JSON.parse(readFileSync('.practice/fleet-proof/imp-route-admission.json','utf8'));
if(route.decision!=='GO_FOR_BOUNDED_PRACTICE_ONLY'||route.via?.x!==2649||route.via?.z!==3267)throw new Error('corrected route GO missing');
const inside=(x:number,z:number,margin=0)=>x>=2627+margin&&x<=2645-margin&&z>=3222+margin&&z<=3253-margin;
const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
type MoveOut={pos:number;p1Enc:(opcode:number)=>void};
export function meterMove(out:MoveOut,tick:()=>number){
 const packets:{tick:number;opcode:number;before:number;after:number}[]=[],original=out.p1Enc;
 out.p1Enc=function(opcode:number){const before=out.pos;original.call(out,opcode);if(opcode===234)packets.push({tick:tick(),opcode,before,after:out.pos});};
 return {packets,restore:()=>{out.p1Enc=original;}};
}
if(process.argv[2]==='--offline-meter'){
 const root=resolve('vendor/rs-sdk/server/webclient/src');await import(resolve(root,'lite/dom-shim.ts'));
 const {findPathToTile}=await import(resolve(root,'lite/movement.ts')),{default:CollisionMap}=await import(resolve(root,'dash3d/CollisionMap.ts'));
 const writes:[string,number][]=[],out={pos:0,p1Enc(n:number){writes.push(['opcode',n]);this.pos++;},p1(n:number){writes.push(['p1',n]);this.pos++;},p2(n:number){writes.push(['p2',n]);this.pos+=2;}};
 const client={ensureCollision(){},collision:[new CollisionMap()],minusedlevel:0,localPlayer:{routeX:[50],routeZ:[50]},mapBuildBaseX:2589,mapBuildBaseZ:3178,out};
 const meter=meterMove(out,()=>1),currentTileAccepted=findPathToTile(client,50,50,false),currentTilePackets=meter.packets.length,currentTileBytes=out.pos;
 const adjacentAccepted=findPathToTile(client,51,50,false);meter.restore();
 const ok=currentTileAccepted&&currentTilePackets===0&&currentTileBytes===0&&adjacentAccepted&&meter.packets.length===1&&meter.packets[0]!.opcode===234&&meter.packets[0]!.after-meter.packets[0]!.before===1&&JSON.stringify(writes)===JSON.stringify([['opcode',234],['p1',5],['p1',0],['p2',2640],['p2',3228]]);
 const result={ok,currentTileAccepted,currentTilePackets,currentTileBytes,adjacentAccepted,packets:meter.packets,writes,totalBytes:out.pos,sourceSha256,qualification:'OFFLINE actual vendored findPathToTile with collision map and EXACT same meterMove used by native helper; no actor/server input.'};
 writeFileSync('.practice/fleet-proof/imp-cancel-meter-offline.json',JSON.stringify(result,null,2));console.log('OFFLINE_MOVE_METER '+JSON.stringify(result));process.exitCode=ok?0:1;
}else if(process.argv[2]==='--child'){
 const s=await openBot(process.argv[3]!);const start=s.tick();let failure='',proof:Awaited<ReturnType<typeof cancelImpTarget>>|undefined,engagement:unknown,banked=false,eaten=0,hpMin=99;
 let packets:{tick:number;opcode:number;before:number;after:number}[]=[];
 const state=()=>s.sdk.getState(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkill('Attack')?.experience??0;
 const danger=()=>{const p=state()?.player;if(!p||p.level!==0||hp()<=6)return 'missing player or low HP';return route.threats.some((h:{b:number[];r:number})=>Math.max(Math.max(h.b[0]!-p.worldX,0,p.worldX-h.b[2]!),Math.max(h.b[1]!-p.worldZ,0,p.worldZ-h.b[3]!))<=h.r)?'source threat envelope':null;};
 let initialXp=0,initialHpXp=0;const off=s.onTick(()=>{if(hp()>0)hpMin=Math.min(hpMin,hp());});
 const planner=await sessionWalker(s);
 const walk=async(points:{x:number;z:number;tol:number}[],hunt=false)=>{const g=guardImpWalker(planner,danger,hunt);const r=await walkPath(g.deps,points,{maxTicks:180,look:4,stop:()=>!!danger()||s.tick()-start>450});if(!r.ok||g.reason())throw new Error(`cancel-only route ${g.reason()??r.detail}`);};
 try{
  await waitUntil(s,()=>hp()>0,{timeoutTicks:15});
  if(!state()!.skills.every((v,i)=>v.experience===sword.skills[i].xp&&v.baseLevel===sword.skills[i].level)||hp()!==sword.hp.now)throw new Error('exact public Sword runtime mismatch');
  initialXp=xp();initialHpXp=s.sdk.getSkill('Hitpoints')!.experience;
  console.log('CANCEL_INITIAL '+JSON.stringify({skills:state()!.skills,player:state()!.player,inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment()}));
  if(!(await s.bot.openBank()).success)throw new Error('initial bank unavailable');await waitTicks(s,2);await s.bot.closeBank();await equipCowKit(s);
  if(state()?.autoRetaliateEnabled===true)await s.direct({type:'clickComponent',componentId:151,reason:'cancel-only auto-retaliate off'});
  if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===false,{timeoutTicks:10}))throw new Error('OFF unobserved');
  if(!(await s.sdk.sendSetCombatStyle(0)).success)throw new Error('Attack style dispatch failed');
  if(!await waitUntil(s,()=>state()?.combatStyle?.known===true&&state()?.combatStyle?.currentStyle===0,{timeoutTicks:10}))throw new Error('Attack style unobserved');
  await walk([{x:2649,z:3267,tol:0},{x:2644,z:3250,tol:0},{x:2633,z:3243,tol:0}]);
  let attacked=false;const seek=s.tick();
  while(s.tick()-seek<120&&!attacked){
   if(danger())throw new Error(String(danger()));
   const n=state()?.nearbyNpcs.find(n=>n.id===708&&inside(n.tileX??n.x,n.tileZ??n.z,3)&&!n.inCombat&&n.reachable!==false);
   if(!n){await waitTicks(s,1);continue;}
   await walk([{x:n.tileX??n.x,z:n.tileZ??n.z,tol:1}],true);
   const fresh=state()?.nearbyNpcs.find(v=>v.index===n.index&&v.id===708),p=state()?.player;
   if(!fresh||!p||!inside(p.worldX,p.worldZ,2)||!inside(fresh.tileX??fresh.x,fresh.tileZ??fresh.z,3)||Math.max(Math.abs((fresh.tileX??fresh.x)-p.worldX),Math.abs((fresh.tileZ??fresh.z)-p.worldZ))>1)continue;
   const option=fresh.optionsWithIndex.find(o=>/^attack$/i.test(o.text));if(!option)throw new Error('Attack option missing');
   if(!(await s.sdk.sendInteractNpc(fresh.index,option.opIndex)).success)throw new Error('real attack refused');attacked=true;
   const encounterSafe=()=>{const p=state()?.player,n=state()?.nearbyNpcs.find(v=>v.index===fresh.index&&v.id===708);return !!p&&inside(p.worldX,p.worldZ,2)&&!!n&&inside(n.tileX??n.x,n.tileZ??n.z,3);};
   const active=await waitUntil(s,()=>{const p=state()?.player;return xp()>initialXp&&p?.combat?.targetType==='npc'&&p.combat.targetIndex===fresh.index||!!danger()||!encounterSafe();},{timeoutTicks:60});
   const engaged=state()?.player;
   if(!active||danger()||!encounterSafe()||!engaged||engaged.combat?.targetType!=='npc'||engaged.combat.targetIndex!==fresh.index||xp()<=initialXp)throw new Error('real safe damaged engagement not observed');
   engagement={tick:s.tick(),npcIndex:fresh.index,player:engaged,attackXp:xp()-initialXp,autoRetaliate:state()?.autoRetaliateEnabled};console.log('CANCEL_ENGAGED '+JSON.stringify(engagement));
   const client=s.client as {out:MoveOut}|undefined;
   if(!client?.out?.p1Enc)throw new Error('native packet meter inaccessible');
   const meter=meterMove(client.out,()=>s.tick());packets=meter.packets;
   try{proof=await cancelImpTarget(s,planner,()=>!!danger());}finally{meter.restore();}
   console.log('CANCEL_EFFECT '+JSON.stringify({proof,packets,player:state()?.player,autoRetaliate:state()?.autoRetaliateEnabled}));
  }
  if(!attacked)throw new Error('bounded search found no safe Imp');
 }catch(e){failure=String(e);}
 finally{
  try{
   if(hp()<=8){const food=s.sdk.getInventory().find(i=>i.id===333),before=count(s.sdk.getInventory(),333),beforeHp=hp();if(!food)throw new Error('owned food unavailable');await s.bot.eatFood(food);await waitUntil(s,()=>count(s.sdk.getInventory(),333)<before&&hp()>beforeHp,{timeoutTicks:6});eaten=before-count(s.sdk.getInventory(),333);if(eaten!==1||hp()<=beforeHp)throw new Error('owned heal not observed');}
   await walk([{x:2644,z:3250,tol:0},{x:2649,z:3267,tol:0},{x:2655,z:3283,tol:2}]);
   if(!(await s.bot.openBank()).success)throw new Error('final bank unavailable');await waitTicks(s,2);banked=true;
  }catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();
 }
 const ok=!!proof&&banked&&!failure&&packets.filter(p=>p.opcode===234&&p.after>p.before).length===1;
 const result={ok,proof,packets,engagement,banked,eaten,hpMin,attackXp:xp()-initialXp,hpXp:(s.sdk.getSkill('Hitpoints')?.experience??0)-initialHpXp,ticks:s.tick()-start,failure:failure||'-'};
 console.log('CANCEL_NATIVE_RESULT '+JSON.stringify(result));await finish([s],ok,`cancel-only ${JSON.stringify(result)}`);
}else{
 if(process.env.REUSE_STACK!=='1')throw new Error('operator must start and warm stack');
 const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());if(free<9)throw new Error(`warm admission needs9GiB; actual${free}`);
 const actor=runBotName('flcanc',1),dir=resolve('.practice/fleet-proof'),prefix=`imp-cancel-${actor}`;await createBot(actor);
 const path=await applyPreset(actor,{position:sword.pos,skills:Object.fromEntries(sword.skills.map((v:{name:string;level:number})=>[v.name,v.level])),inventory:sword.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),equipment:sword.equipment.map((i:{id:number;count:number;slot:number})=>({id:i.id,count:i.count,slot:i.slot})),bank:sword.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))});setPracticeSkills(path,sword.skills.map((v:{name:string;level:number;xp:number})=>({level:v.name==='Hitpoints'?sword.hp.now:v.level,xp:v.xp})));
 const initial=readPracticeSave(path);writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));console.log(`PROOF_START cancel-only actor=${actor} source=${sourceSha256} freeGiB=${free} sourceStatusAt=${sword.at}`);
 const p=Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),'--preload',resolve('scripts/measure/fleet-imp-observe.ts'),import.meta.path,'--child',actor],{env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_TRACE_PATH:'1'},stdout:'pipe',stderr:'pipe',windowsHide:true});let output='';const timer=setTimeout(()=>p.kill(),210000);
 const read=async(stream:ReadableStream<Uint8Array>)=>{for await(const b of stream){const part=new TextDecoder().decode(b);output+=part;writeFileSync(resolve(dir,`${prefix}.log`),output);process.stdout.write(part);}};await Promise.all([read(p.stdout),read(p.stderr)]);const code=await p.exited;clearTimeout(timer);
 const result=JSON.parse(output.match(/^CANCEL_NATIVE_RESULT (.+)$/m)?.[1]??'null');
 const final=await waitPracticeSave(path,v=>!!result&&v.skills[0]!.xp===initial.skills[0]!.xp+result.attackXp&&v.position.z>=3280,{timeoutMs:6000});
 const totals=(v:typeof initial)=>{const m=new Map<number,number>();for(const items of Object.values(v.inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};const a=totals(initial),b=totals(final.save);
 const assets=!!result&&[...new Set([...a.keys(),...b.keys()])].every(id=>(b.get(id)??0)===(a.get(id)??0)-(id===333?result.eaten:0));
 const xpLedger=!!result&&final.save.skills.every((v,i)=>v.xp===initial.skills[i]!.xp+(i===0?result.attackXp:i===3?result.hpXp:0));
 const booths=parseJm2('m41_51.jm2',readFileSync('vendor/rs-sdk/server/content/maps/m41_51.jm2','utf8')).locs.filter(l=>l.id===2213&&l.level===0&&l.x>=2650&&l.x<=2660&&l.z>=3280&&l.z<=3290),atBank=final.save.position.level===0&&booths.some(b=>Math.max(Math.abs(final.save.position.x-b.x),Math.abs(final.save.position.z-b.z))<=1);
 const frames=output.split(/\r?\n/).filter(l=>l.startsWith('IMP_FRAME ')).map(l=>JSON.parse(l.slice(10)));
 const threatSafe=frames.length>0&&frames.every(f=>f.pos[2]===0&&!route.threats.some((h:{b:number[];r:number})=>Math.max(Math.max(h.b[0]!-f.pos[0],0,f.pos[0]-h.b[2]!),Math.max(h.b[1]!-f.pos[1],0,f.pos[1]-h.b[3]!))<=h.r));
 const proof=result?.proof,actualEffect=!!proof&&Math.max(Math.abs(proof.from[0]-proof.to[0]),Math.abs(proof.from[1]-proof.to[1]))===1&&frames.some(f=>f.tick===proof.observedTick&&f.pos[0]===proof.to[0]&&f.pos[1]===proof.to[1]&&f.combat.targetType==='none'&&f.combat.targetIndex===-1&&f.autoRetaliate===false);
 const ok=code===0&&result?.ok&&final.matched&&assets&&xpLedger&&atBank&&threatSafe&&actualEffect&&/PROOF_SURVIVAL started=true died=false/.test(output)&&output.includes('LOGOUT logged-out');
 writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourceStatusAt:sword.at,result,assets,xpLedger,atBank,threatSafe,actualEffect,qualification:'Cancellation-only; opcode234 queued by actual LiteClient plus actual adjacent arrival and server target clearing. No kill/loot/camp/live admission claim.',initial,final:final.save},null,2));console.log(`PROOF_GATE cancel-only ok=${ok} assets=${assets} xpLedger=${xpLedger} actualEffect=${actualEffect}`);process.exitCode=ok?0:1;
}
