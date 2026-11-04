// Behaviour rewrite of Microbot-Hub BonesToBananasScript, BSD-2-Clause.
// Source and licence: research/microbot-ports.md. No Java runtime or mouse automation.
export type BonesSnapshot={bones:number;bananas:number;earth:number;water:number;nature:number;xp:number};
export type BonesCosts={earth:number;water:number;nature:number};
export interface BonesIO {
 tick():number; stopped():boolean; level():number; read():BonesSnapshot;
 costs?():BonesCosts;
 prepare(maximum:number):Promise<boolean>; cast():Promise<unknown>;
 wait(done:()=>boolean):Promise<unknown>; deposit():Promise<number>; close():Promise<void>;
}
export function bonesEffect(b:BonesSnapshot,a:BonesSnapshot,costs:BonesCosts={earth:2,water:2,nature:1}):boolean {
 return b.bones>0&&a.bones===0&&a.bananas-b.bananas===b.bones&&
  b.earth-a.earth===costs.earth&&b.water-a.water===costs.water&&b.nature-a.nature===costs.nature&&a.xp>b.xp;
}
export async function runBonesConversion(io:BonesIO,o:{maximum:number;cap:number}) {
 if(!Number.isSafeInteger(o.maximum)||o.maximum<1||!Number.isSafeInteger(o.cap)||o.cap<1)
  throw Error('invalid bones conversion limits');
 const start=io.tick();let made=0,banked=0,casts=0,failure='';
 const over=()=>io.stopped()||io.tick()-start>=o.cap;
 try {
  if(io.level()<15)throw Error('bones conversion requires Magic 15');
  if(io.read().bananas)throw Error('bank existing bananas before conversion');
  while(made<o.maximum&&!over()){
   if(!await io.prepare(o.maximum-made))throw Error('bones conversion inputs unavailable');
   if(over())break;
   const before=io.read();
   const costs=io.costs?.()??{earth:2,water:2,nature:1};
   if(before.bones<1||before.bones>o.maximum-made||before.earth<costs.earth||before.water<costs.water||before.nature<costs.nature)
    throw Error('bones conversion input bound failed');
   casts++;await io.cast();
   await io.wait(()=>over()||bonesEffect(before,io.read(),costs));
   if(!bonesEffect(before,io.read(),costs))throw Error('bones conversion receipt mismatch');
   made+=before.bones;
   banked+=await io.deposit();
   if(banked!==made)throw Error('bones conversion bank receipt mismatch');
  }
  if(made!==o.maximum||over())throw Error('bones conversion stopped before target or budget');
 }catch(e){failure=String(e);}
 finally{try{await io.close();}catch(e){failure||=String(e);}}
 return {ok:!failure,made,banked,casts,ticks:io.tick()-start,failure:failure||'-'};
}

// Bank-side worker. The caller owns staging and travel. Plain runes make costs explicit.
export async function runBonesBank(s:import('../packages/core/src/inprocess').Session,o:{maximum:number;cap:number;members?:boolean;stop?:()=>boolean}){
 const {waitUntil,waitTicks}=await import('../packages/core/src/ticks');
 const {depositObserved}=await import('../packages/core/src/deposit');
 const {componentId}=await import('../packages/core/src/logout');
 const {elementalRuneCost}=await import('./microbot-magic-items');
 const ids={bones:526,bananas:1963,earth:557,water:555,nature:561} as const;
 const inv=()=>s.sdk.getInventory();
 const count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const state=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!state()?.player&&!!s.sdk.getSkill('Magic')&&!!s.sdk.getSkill('Hitpoints'),{timeoutTicks:10}))
  throw Error('bones conversion initial state unavailable');
 const p0=state()!.player;
 const costs=():BonesCosts=>({earth:elementalRuneCost(557,2,s.sdk.getEquipment(),!!o.members),water:elementalRuneCost(555,2,s.sdk.getEquipment(),!!o.members),nature:1});
 const protectedItems=new Map(inv().filter(i=>!Object.values(ids).includes(i.id as any)).map(i=>[i.id,count(i.id)]));
 let ended=false;void s.ended.then(()=>{ended=true;});
 const stopped=()=>{const p=state()?.player;return ended||!!o.stop?.()||!p||p.isDead||
  (s.sdk.getSkill('Hitpoints')?.level??0)<=0||
  (p.respawnCount??0)>(p0?.respawnCount??0)||p0?.lifeId!==undefined&&p.lifeId!==p0.lifeId;};
 const open=async()=>{
  if(stopped())throw Error('bones conversion session stopped');
  const ready=()=>!!state()?.bank?.isOpen&&!!s.bankObservation?.();if(ready())return;
  if(state()?.dialog?.isOpen||state()?.interface?.isOpen){await s.direct({type:'closeModal',reason:'bones bank access'});
   if(!await waitUntil(s,()=>!state()?.dialog?.isOpen&&!state()?.interface?.isOpen,{timeoutTicks:8}))throw Error('bones conversion blocking interface remains');}
  const generation=s.bankObservation?.()?.generation??-1;
  if(stopped()||!(await s.bot.openBank()).success)throw Error('bones conversion bank unavailable');
  if(!await waitUntil(s,()=>ready()&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('bones conversion fresh bank unknown');
 };
 const read=():BonesSnapshot=>({...Object.fromEntries(Object.entries(ids).map(([k,id])=>[k,count(id)])) as Omit<BonesSnapshot,'xp'>,xp:s.sdk.getSkillXp('Magic')??0});
 const conversionStart=s.tick();
 const result=await runBonesConversion({tick:()=>s.tick(),stopped,level:()=>s.sdk.getSkill('Magic')?.level??0,read,costs,
  prepare:async maximum=>{
   await open();
   for(const [name,need] of Object.entries(costs()) as [keyof BonesCosts,number][]){
    const id=ids[name],missing=Math.max(0,need-count(id));
    if(missing){const before=count(id);const r=await s.bot.withdrawItem(new RegExp(`^${name} rune$`,'i'),missing,{asNote:false});
     if(!r.success||!await waitUntil(s,()=>count(id)===before+missing,{timeoutTicks:10}))return false;}
   }
   const owned=count(ids.bones);
   if(owned>maximum)return false;
   if(!owned){
    const available=(s.bankObservation?.()?.items??[]).filter(i=>i.id===ids.bones).reduce((n,i)=>n+i.count,0);
    const amount=Math.min(maximum,available,28-inv().length);
    if(amount<1)return false;
    const r=await s.bot.withdrawItem(/^bones$/i,amount,{asNote:false});
    if(!r.success||!await waitUntil(s,()=>count(ids.bones)===amount,{timeoutTicks:10}))return false;
   }
   await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank?.isOpen,{timeoutTicks:8}))return false;
   return !stopped();
  },
  cast:()=>s.direct({type:'clickComponent',componentId:componentId('magic:bones_to_bananas'),reason:'SDK'}),
  wait:done=>waitUntil(s,done,{timeoutTicks:12}),
  deposit:async()=>{
   // Native convert_bones.rs2 delays two ticks after publishing the converted items.
   // Cross the following publication boundary before sending a bank click.
   if(o.cap-(s.tick()-conversionStart)<=3)throw Error('bones conversion bank budget exhausted');
   await waitTicks(s,3);
   if(stopped()||s.tick()-conversionStart>=o.cap)throw Error('bones conversion stopped before bank');
   await open();const item=inv().find(i=>i.id===ids.bananas);return item?depositObserved(s,item):0;
  },
  close:async()=>{if(!stopped())await s.bot.closeBank();},
 },o);
 if(stopped()){result.ok=false;result.failure='bones conversion session stopped';}
 if([...protectedItems].some(([id,n])=>count(id)!==n)){result.ok=false;result.failure='bones conversion protected inventory changed';}
 console.log('MICROBOT_BONES '+JSON.stringify(result));return result;
}
if(import.meta.main){
 const {openBot,finish}=await import('../packages/core/src/bot');
 const maximum=Number(process.env.MAX_MAKE??25),cap=Number(process.env.CAP??500);
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid bones conversion limits');
 let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const r=await runBonesBank(s,{maximum,cap,members:process.env.MEMBERS==='1',stop:()=>stopped});await finish([s],r.ok,JSON.stringify(r));}
 catch(e){await finish([s],false,String(e));}
}
