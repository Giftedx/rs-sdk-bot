import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs,listConfigFiles} from '../packages/knowledge/src/config';
import {openBot,settle,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {goTo} from '../packages/core/src/walk';
import {waitTicks} from '../packages/core/src/ticks';
import {componentId} from '../packages/core/src/logout';
import {watchProductionLife} from './microbot-c-lifetime';
import {discoverNativeClueNpcHandlers,nativeSpecialClueSearchHandlers} from './microbot-c-clue-handlers';
type Point={x:number;z:number;level:number};
export type NativeClueStep={name:string;id:number;tier:string;kind:'dig'|'search'|'talk'|'challenge'|'open'|'unsupported';point?:Point;casket?:number;tools:number[];npc?:number;source:string;line:number;gap:string;gapType?:string;description?:string;nativeParams?:string[];challengeItem?:number;answer?:number;handlerSource?:string;handlerLine?:number;guards?:string[];consumedInputs?:number[];executor?:string;entryId?:number};
const root=resolve(import.meta.dir,'..'),content=resolve(root,'vendor/rs-sdk/server/content');
const trail='scripts/minigames/game_trail/';
function pack(file:string){return new Map(readFileSync(resolve(content,'pack',file),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));}
export function nativeCluePoint(value:string):Point{
 const parts=value.split('_').map(Number);if(parts.length!==5||!parts.every(Number.isSafeInteger)||parts.some(n=>n<0))throw Error('invalid native clue coord');
 return{level:parts[0]!,x:parts[1]!*64+parts[3]!,z:parts[2]!*64+parts[4]!};
}
let clueCache:NativeClueStep[]|undefined;
export function nativeClueSteps():NativeClueStep[]{
 if(clueCache)return clueCache;
 const objs=pack('obj.pack'),npcs=pack('npc.pack'),out:NativeClueStep[]=[];
 for(const file of ['trail_easy.obj','trail_medium.obj','trail_hard.obj','trail_casket.obj','trail.obj']){
  const source=trail+'configs/'+file;
  for(const b of parseConfigs(readFileSync(resolve(content,source),'utf8'),source)){
   const category=b.props.category?.[0]??'';if(!/^trail_(?:(?:clue|casket)_(?:easy|medium|hard)|puzzle|challenge)$/.test(category))continue;
   const params=b.props.param??[],param=(key:string)=>params.find(v=>v.startsWith(key+','))?.slice(key.length+1),id=objs.get(b.name);
   if(id===undefined)throw Error('native clue object unresolved '+b.name);
   const point=param('trail_coord')?nativeCluePoint(param('trail_coord')!):undefined;
   const r:NativeClueStep={name:b.name,id,tier:category.split('_').at(-1)!,kind:'unsupported',tools:[],source:'vendor/rs-sdk/server/content/'+source,line:b.line,gap:'',description:param('trail_desc'),nativeParams:params};
   if(category==='trail_puzzle'){r.gapType='puzzle';r.gap='Native 25-tile puzzle has staged board solver and all nine native exact NPC collection/turn-ins in scripts/microbot-c-clue-puzzle.ts. NPC-specific travel and practice qualification remain open.';}
   else if(category==='trail_challenge'){r.gapType='challenge';r.gap='Native challenge scroll requires its exact NPC question, answer '+(param('trail_challenge_answer')??'not declared')+' and clue state; no generic item-open handler advances it.';}
   else if(category.startsWith('trail_casket_'))r.kind='open';
   else if(param('trail_guardian')){r.gapType='guardian';r.gap='Native spade handler spawns '+param('trail_guardian')+' at '+(param('trail_coord')??'unmapped coordinate')+' and requires guardian kill flag; combat/quest/supply route is not implemented.';}
   else if(point&&param('trail_casket')){
    r.kind='dig';r.point=point;r.casket=objs.get(param('trail_casket')!);r.tools=[objs.get('spade')!];
    if(!r.casket)throw Error('native casket unresolved '+b.name);
    if(['yes','true','^true'].includes(param('trail_sextant')??''))r.tools.push(...['trail_watch','trail_chart','trail_sextant'].map(n=>objs.get(n)!));
   }else if(point&&['yes','true','^true'].includes(param('trail_loc')??'')){r.kind='search';r.point=point;}
   else if(b.name==='trail_clue_easy_simple008'){
    const script=readFileSync(resolve(content,'scripts/areas/area_alkharid/scripts/tanner.rs2'),'utf8');
    if(!script.includes('@trail_tanner;')||!script.includes('~progress_clue_easy(trail_clue_easy_simple008,'))throw Error('native Tanner clue handler changed');
    const row=(JSON.parse(readFileSync(resolve(root,'knowledge/npcs.json'),'utf8')) as any[]).find(n=>n.debugname==='tanner'),spawn=row?.spawns?.[0];
    if(!spawn)r.gap='Native Tanner spawn is not mapped in knowledge/npcs.json';else{r.kind='talk';r.npc=npcs.get('tanner')!;r.point={x:spawn.x,z:spawn.z,level:spawn.level};}
   }else{r.gapType='specific-handler';r.gap='No generic native coordinate/casket or trail_loc mapping. Native requirement: '+(param('trail_desc')??b.name)+'. Its exact NPC dialogue, challenge/key, quest or item handler needs consumer mapping; this is supported native content, not an absent-server claim.';}
   out.push(r);
  }
 }
 const npcData=JSON.parse(readFileSync(resolve(root,'knowledge/npcs.json'),'utf8')) as any[];
 for(const h of discoverNativeClueNpcHandlers()){
  const r=out.find(r=>r.name===h.clue);if(!r||!['unsupported','talk'].includes(r.kind))continue;
  const id=npcs.get(h.npc),spawn=npcData.find(n=>n.debugname===h.npc)?.spawns?.[0];
  if(id===undefined||!spawn){r.gap='Exact native handler '+h.source+':'+h.line+' targets '+h.npc+'; generated native NPC ID/spawn mapping is missing.';r.gapType='npc-spawn';continue;}
  const challenge=h.challenge?out.find(v=>v.name===h.challenge):undefined,answer=challenge?.nativeParams?.find(v=>v.startsWith('trail_challenge_answer,'))?.split(',')[1];
  if(h.kind==='challenge'&&(!challenge||!Number.isSafeInteger(Number(answer)))){r.gap='Native challenge handler '+h.source+':'+h.line+' requires '+h.challenge+' but numeric answer/object mapping is unresolved.';continue;}
  Object.assign(r,{kind:h.kind,npc:id,point:{x:spawn.x,z:spawn.z,level:spawn.level},gap:'',gapType:undefined,handlerSource:h.source,handlerLine:h.line,guards:h.guards,...(challenge?{challengeItem:challenge.id,answer:Number(answer)}:{})});
  if(challenge){challenge.gap='Use original clue '+r.name+' at native NPC '+h.npc+'; collect challenge if absent, then submit native configured answer '+answer+'. The executor needs original clue and owned count prompt, not item-read.';challenge.handlerSource=h.source;challenge.handlerLine=h.line;}
 }
 for(const r of out.filter(r=>r.kind==='unsupported'&&r.gapType==='specific-handler'))if(out.some(p=>p.name===r.name+'_puzzlebox')){r.gapType='puzzle-turnin';r.gap='Native puzzle clue '+r.name+' has matching box. Board solver and all nine exact staged NPC collection/turn-ins exist in scripts/microbot-c-clue-puzzle.ts; NPC-specific travel and practice qualification remain open. Requirement: '+r.description;}
 for(const h of nativeSpecialClueSearchHandlers()){
  const r=out.find(r=>r.name===h.clue);if(!r)throw Error('native special clue object missing');
  const key=h.key?objs.get(h.key):undefined;if(h.key&&key===undefined)throw Error('native clue key unresolved');
  Object.assign(r,{kind:'search',point:nativeCluePoint(h.coord),gap:'',gapType:undefined,handlerSource:h.source,handlerLine:h.line,...(key!==undefined?{tools:[key],consumedInputs:[key],guards:['Requires owned '+h.key+'; native trail_checkmediumdrop defines its acquisition NPC.']}:{})});
 }
 for(const h of [{name:'trail_clue_hard_map001',coord:'0_51_54_45_47',source:'scripts/quests/quest_fluffs/scripts/quest_fluffs.rs2',needle:'@trail_clue_hard_loc_interact(trail_clue_hard_map001);'},{name:'trail_clue_hard_riddle022',coord:'1_42_53_14_17',source:'scripts/general_use/scripts/bookcases.rs2',needle:'@trail_clue_hard_loc_interact(trail_clue_hard_riddle022);'}]){
  const text=readFileSync(resolve(content,h.source),'utf8'),r=out.find(r=>r.name===h.name);if(!r||!text.includes(h.coord)||!text.includes(h.needle))throw Error('native special search mapping changed');
  Object.assign(r,{kind:'search',point:nativeCluePoint(h.coord),gap:'',gapType:undefined,handlerSource:'vendor/rs-sdk/server/content/'+h.source,handlerLine:text.slice(0,text.indexOf(h.needle)).split('\n').length});
 }
 for(const r of out){
  if(r.kind!=='unsupported'){r.executor='scripts/microbot-c-clues.ts';r.entryId=r.id;}
  else if(r.gapType==='guardian'){r.executor='scripts/microbot-c-clue-guardian.ts';r.entryId=r.id;r.gap='Staged native guardian composition exists with exact new own-target binding and repeat-dig casket proof. Requires full spell/escape rune budget, HP70/Prayer40, isolated tile, staged gear/food and protection; any HP damage aborts combat and invokes bounded recovery. Native routes, damage-free mitigation and practice/live combat remain unqualified. Native requirement: '+r.nativeParams?.join('; ');}
  else if(r.gapType==='puzzle'||r.gapType==='puzzle-turnin'){r.executor='scripts/microbot-c-clue-puzzle.ts';r.entryId=r.gapType==='puzzle'?r.id:out.find(b=>b.name===r.name+'_puzzlebox')?.id;}
  else if(r.gapType==='challenge'){const original=out.find(v=>v.challengeItem===r.id);if(original){r.executor='scripts/microbot-c-clues.ts';r.entryId=original.id;}}
 }
 return clueCache=out;
}
type SearchLoc={id:number;option:number;openOnly:boolean};let locCache:SearchLoc[]|undefined;
export function nativeClueSearchLocs():SearchLoc[]{
 if(locCache)return locCache;
 const ids=pack('loc.pack'),out:SearchLoc[]=[];
 // Generic handlers read trail_coord+trail_loc at these exact categories.
 const cats:Record<string,{option:number;openOnly:boolean}>={empty_crate:{option:1,openOnly:false},empty_crates:{option:1,openOnly:false},empty_boxes:{option:1,openOnly:false},chest_closed:{option:1,openOnly:true},chest_open:{option:2,openOnly:false},drawer:{option:1,openOnly:true},empty_drawer:{option:2,openOnly:false},bookcase:{option:1,openOnly:false}};
 for(const file of listConfigFiles('.loc'))for(const b of parseConfigs(readFileSync(resolve(content,file),'utf8'),file)){
  const action=cats[b.props.category?.[0]??''],id=ids.get(b.name);if(action&&id!==undefined)out.push({id,...action});
 }
 const special=ids.get('gertrudeempty_crate');if(special===undefined)throw Error('native trail map crate unresolved');out.push({id:special,option:1,openOnly:false});return locCache=out;
}
type Stock=readonly{id:number;count:number}[];
const count=(items:Stock,id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function clueEffect(step:NativeClueStep,before:Stock,after:Stock,completedMessage:boolean){
 if(count(before,step.id)-count(after,step.id)!==1)return{ok:false,outcome:'no-observed-clue-debit'};
 if(step.kind==='dig')return{ok:!!step.casket&&count(after,step.casket)-count(before,step.casket)===1,outcome:'casket'};
 const steps=nativeClueSteps(),clueIds=new Set(steps.map(s=>s.id));
 const next=after.find(i=>clueIds.has(i.id)&&count(after,i.id)>count(before,i.id));
 if(next)return{ok:true,outcome:'next-clue-or-casket',next:next.id};
 const rewards=after.filter(i=>!clueIds.has(i.id)&&count(after,i.id)>count(before,i.id));
 return{ok:completedMessage&&rewards.length>0,outcome:'reward',rewards};
}
export async function runNativeClueStep(s:Session,clueId:number,cap:number,stop:()=>boolean=()=>false,walk?:(point:Point,stop:()=>boolean)=>Promise<boolean>){
 if(!Number.isSafeInteger(clueId)||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid native clue step');
 const step=nativeClueSteps().find(v=>v.id===clueId);if(!step||step.kind==='unsupported')throw Error(step?.gap??'unknown native clue');
 const life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap,stock=()=>s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
 const before=stock(),cursor=Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick));
 const complete=()=>(s.sdk.getState()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&/Well done you've completed the Treasure Trail!/.test(m.text));
 let detail='',effect:ReturnType<typeof clueEffect>={ok:false,outcome:'not-started'};
 try{
  if(count(before,clueId)!==1)throw Error('stage exactly one selected clue/casket');
  if(s.sdk.getDialog()?.isOpen||(s.client as any)?.isChatBackInputOpen?.())throw Error('native clue requires existing dialogue/count prompt closed');
  if(before.some(i=>i.id!==clueId&&i.id!==step.challengeItem&&nativeClueSteps().some(v=>v.id===i.id)))throw Error('stage only one native clue/casket; generic handler selects first clue');
  // Native player.inv gives trail_rewardinv nine slots; retain reward headroom.
  if(s.sdk.getInventory().length>19)throw Error('native clue step requires nine free inventory slots');
  if(step.tools.some(id=>count(before,id)<1))throw Error('native clue requires staged tools/key: '+step.tools.join(','));
  if(step.point){
   const point=step.point;
   const distance=()=>{
    const p=s.sdk.getState()?.player;
    return p?.level===point.level?Math.max(Math.abs(p.worldX-point.x),Math.abs(p.worldZ-point.z)):Infinity;
   };
   if(distance()!==0){
    if(walk){if(!await walk(point,over))throw Error('native clue route refused');}
    else{
     const ac=new AbortController(),off=s.onTick(()=>{if(over())ac.abort();});
     try{const result=await goTo(s,await getWorld(),point,accountOf(s),{signal:ac.signal,legTimeoutTicks:Math.min(60,cap)});if(!result.ok)throw Error('native clue route '+result.detail);}finally{off();}
    }
   }
   if(distance()>2)throw Error('native clue destination unobserved');
  }
  let sent=false,openedAt:number|undefined,challengeReady=step.challengeItem!==undefined&&count(before,step.challengeItem)>0,answered=false,rewardClosed=false;
  while(!over()){
   effect=clueEffect(step,before,stock(),complete());if(effect.ok)break;
   const modal=s.sdk.getState()?.interface;
   if(sent&&!rewardClosed&&modal?.isOpen&&modal.interfaceId===componentId('trail_reward')&&
      complete()&&count(stock(),clueId)===0){
    rewardClosed=true;
    if(!(await s.sdk.sendCloseModal()).success)throw Error('native clue reward close refused');
    await waitTicks(s,1);
    continue;
   }
   const dialog=s.sdk.getDialog();
   if(step.kind==='challenge'&&sent&&!answered&&(s.client as any)?.isChatBackInputOpen?.()){
    if(!challengeReady||step.answer===undefined)throw Error('native challenge prompt appeared before staged challenge');await s.sdk.sendCountDialog(step.answer);answered=true;
   }else if(dialog?.isOpen){if(dialog.options.length===1&&/continue/i.test(dialog.options[0]!.text))await s.sdk.sendClickDialog(dialog.options[0]!.index);else throw Error('native clue dialogue choice is not mapped');}
   else if(!sent){
    if(step.kind==='open'||step.kind==='dig'){
     const item=s.sdk.getInventory().find(i=>i.id===(step.kind==='dig'?step.tools[0]:step.id));if(!item)throw Error('native clue action item unavailable');await s.sdk.sendUseItem(item.slot,1);sent=true;
    }else if(step.kind==='talk'||step.kind==='challenge'){
     const npc=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===step.npc);if(!npc)throw Error('mapped native clue NPC not nearby');await s.sdk.sendInteractNpc(npc.index,1);sent=true;
    }else{
     const target=s.sdk.getState()?.nearbyLocs.find(l=>l.x===step.point!.x&&l.z===step.point!.z&&l.level===step.point!.level&&nativeClueSearchLocs().some(n=>n.id===l.id));
     if(!target)throw Error('native clue search location/category not observed at exact coordinate');
     const rule=nativeClueSearchLocs().find(n=>n.id===target.id)!;
     if(rule.openOnly&&openedAt!==undefined){if(s.tick()-openedAt>=8)throw Error('native clue container open effect unobserved');}
     else{await s.sdk.sendInteractLoc(target.x,target.z,target.id,rule.option);sent=!rule.openOnly;if(rule.openOnly)openedAt=s.tick();}
    }
   }else if(step.kind==='challenge'&&!challengeReady&&step.challengeItem!==undefined&&count(stock(),step.challengeItem)===1){challengeReady=true;sent=false;}
   await waitTicks(s,1);
  }
  if(!effect.ok)throw Error(life.reason()||'native clue effect budget; same-ID replacement is not proved by inventory totals');
 }catch(error){detail=String(error);}
 const preserved=before.every(i=>i.id===step.id||i.id===step.challengeItem||step.consumedInputs?.includes(i.id)||count(stock(),i.id)>=count(before,i.id));if(effect.ok&&step.challengeItem!==undefined&&count(stock(),step.challengeItem)!==0)detail ||= 'native challenge debit unconfirmed';if(effect.ok&&step.consumedInputs?.some(id=>count(before,id)-count(stock(),id)!==1))detail ||= 'native clue key debit unconfirmed';detail ||= life.reason();
 return{ok:!detail&&effect.ok&&preserved,clue:step.name,kind:step.kind,effect,preserved,ticks:s.tick()-start,detail};
}
if(import.meta.main){
 const name=process.argv[2]??'',clue=Number(process.argv[3]),cap=Number(process.argv[4]??200);
 if(!name||!Number.isSafeInteger(clue)||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage (members world): bun scripts/microbot-c-clues.ts <account> <native-clue-id> [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{const r=await runNativeClueStep(s,clue,cap,()=>stopped);console.log('NATIVE_CLUE_RESULT '+JSON.stringify(r));ok=r.ok;}finally{ok=await settle([s],ok,'finite native clue step');}process.exitCode=ok?0:1;
}
