import {existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks} from '../packages/core/src/ticks';
import {componentId} from '../packages/core/src/logout';
import {questFlags} from '../packages/core/src/quest-status';
import {watchProductionLife} from './microbot-c-lifetime';
export const MISC_COFFER={npc:1375,interface:componentId('misc_both_manage'),balance:componentId('misc_both_manage:com_87'),deposit:componentId('misc_both_manage:com_88'),maximum:5000000} as const;
export function cofferText(text:unknown){if(typeof text!=='string'||!/^(0|[1-9]\d*)$/.test(text))return;const n=Number(text);return Number.isSafeInteger(n)&&n<=MISC_COFFER.maximum?n:undefined;}
export function cofferDepositEffect(amount:number,beforeCoins:number,afterCoins:number,before:number,after:number){return[amount,beforeCoins,afterCoins,before,after].every(Number.isSafeInteger)&&amount>0&&beforeCoins>=amount&&afterCoins>=0&&before>=0&&after<=MISC_COFFER.maximum&&beforeCoins-afterCoins===amount&&after-before===amount;}
export const MISC_RESOURCES={"Maple Logs":1518,"Coal":454,"Tuna":362,"Swordfish":374,"Raw Tuna":360,"Raw Swordfish":372} as const;
export const MISC_HERBS=[254,256,258,260,262,264,266,2482,268] as const;
export const MISC_NOTES:readonly number[]=[...Object.values(MISC_RESOURCES),...MISC_HERBS];
export function miscResourceText(text:string){
 const normalized=text.replace(/<br\s*\/?>/gi,' ').replace(/[|\n]/g,' ').trim();if(normalized==='No Resources')return{} as Record<string,number>;
 const result:Record<string,number>={};let invalid=false;
 const rest=normalized.replace(/([1-9]\d*) (Maple Logs|Coal|Raw Tuna|Raw Swordfish|Tuna|Swordfish|Herbs)/g,(_,n:string,label:string)=>{if(result[label]!==undefined||!Number.isSafeInteger(Number(n)))invalid=true;result[label]=Number(n);return '';});
 return !invalid&&!rest.trim()&&Object.keys(result).length?result:undefined;
}
export function miscResourceEffect(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>,text:string){
 const report=miscResourceText(text);if(!report)return;
 const delta=(id:number)=>(after.get(id)??0)-(before.get(id)??0),credits:Record<number,number>={};
 for(const [label,id]of Object.entries(MISC_RESOURCES)){if(delta(id)!==(report[label]??0))return;if(delta(id))credits[id]=delta(id);}
 let herbs=0;for(const id of MISC_HERBS){if(delta(id)<0)return;herbs+=delta(id);if(delta(id))credits[id]=delta(id);}if(herbs!==(report.Herbs??0))return;
 if([...new Set([...before.keys(),...after.keys()])].some(id=>!MISC_NOTES.includes(id)&&delta(id)!==0))return;
 return credits;
}
const marker=(s:Session)=>Math.max(-1,...(s.sdk.getState()?.gameMessages??[]).map(m=>m.observationId??m.tick),...(s.sdk.getState()?.recentDialogs??[]).map(m=>m.observationId??m.tick));
const fresh=(s:Session,cursor:number,re:RegExp)=>(s.sdk.getState()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&re.test(m.text))||(s.sdk.getState()?.recentDialogs??[]).some(m=>(m.observationId??m.tick)>cursor&&re.test(m.text.join(' ')));
export async function depositMiscCoffer(s:Session,amount:number,cap:number,requestStop:()=>boolean=()=>false,options:{collectResources?:boolean}={}){
 if(!Number.isSafeInteger(amount)||amount<1||amount>MISC_COFFER.maximum||!Number.isSafeInteger(cap)||cap<1||cap>500)throw Error('invalid finite Miscellania coffer deposit');
 const ui=s.client as {membersAccount?:number;getModalInterface:()=>number;isChatBackInputOpen:()=>boolean;ifType:(id:number)=>{text?:string}},state=()=>s.sdk.getState(),first=state()?.player;
 if(!first||first.level!==1||Math.max(Math.abs(first.worldX-2499),Math.abs(first.worldZ-3857))>8||!Number.isSafeInteger(first.lifeId)||ui.membersAccount!==1||!questFlags(s.client)?.some(q=>/^Throne of Miscellania$/i.test(q.name)&&q.state==='complete'))throw Error('observed member account, original life and completed Throne of Miscellania required');
 const lifeId=first.lifeId,respawns=first.respawnCount??0,life=watchProductionLife(s,requestStop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap;
 const alive=()=>{const p=state()?.player;return!!p&&!p.isDead&&p.lifeId===lifeId&&(p.respawnCount??0)===respawns&&(s.sdk.getSkill('Hitpoints')?.level??0)>0;};
 const rows=()=>[...s.sdk.getInventory(),...s.sdk.getEquipment()],stock=()=>{const a=new Map<number,number>();for(const i of rows())a.set(i.id,(a.get(i.id)??0)+i.count);return a;},initial=stock(),coins0=initial.get(995)??0,gear=JSON.stringify(s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 if(coins0<amount)throw Error('declared coffer amount exceeds owned carried coins');
 let collectionStock=initial;const unchanged=()=>{const now=stock();return[...new Set([...collectionStock.keys(),...now.keys()])].every(id=>(collectionStock.get(id)??0)===(now.get(id)??0));};
 const balance=()=>ui.getModalInterface()===MISC_COFFER.interface?cofferText(ui.ifType(MISC_COFFER.balance)?.text):undefined;
 let pendingChoice:string|undefined;const choiceKey=()=>JSON.stringify(s.sdk.getDialog()?.options.map(o=>[o.index,o.text,o.componentId]));
 let collectionSubmitted=false,collectionConfirmed=false,collectionText='',collectionCredits:Record<number,number>={},collectionCursor=-1;
 let submitted=false,ownedUi=false,prompt=false,asked=false,before:number|undefined,after:number|undefined,detail='';const cursor=marker(s);
 const observeCollection=()=>{if(collectionSubmitted&&!collectionConfirmed){for(const d of state()?.recentDialogs??[]){if((d.observationId??d.tick)<=collectionCursor)continue;const text=d.text.join(' '),credits=miscResourceEffect(initial,stock(),text);if(credits){collectionText=text;collectionCredits=credits;collectionStock=stock();collectionConfirmed=true;break;}}}};
 const check=()=>{if(over())throw Error(life.reason()||'Miscellania deposit tick budget');};
 const step=async()=>{check();await waitTicks(s,1);check();};
 const proceed=async()=>{const d=s.sdk.getDialog();if(d?.isOpen&&!d.isWaiting){if(d.options.length!==1||!/continue/i.test(d.options[0]!.text))throw Error('unmapped Miscellania continuation');check();await s.sdk.sendClickDialog(d.options[0]!.index);}};
 try{
  check();await s.sdk.sendCloseModal();await step();
  const targets=state()?.nearbyNpcs.filter(n=>n.id===MISC_COFFER.npc&&n.distance<=5&&n.reachable!==false)??[];if(targets.length!==1)throw Error('stage beside the unique observed Advisor Ghrim');
  ownedUi=true;if(!(await s.sdk.sendInteractNpc(targets[0]!.index,1)).success)throw Error('Ghrim conversation refused');
  while(ui.getModalInterface()!==MISC_COFFER.interface){
   check();const d=s.sdk.getDialog();if(pendingChoice){if(choiceKey()===pendingChoice){await step();continue;}pendingChoice=undefined;}
   if(d?.isOpen&&!d.isWaiting&&d.options.length>1){
    const option=!asked?d.options.find(o=>o.text==='How is the Kingdom faring?'):fresh(s,cursor,/Would you like to collect the resources gathered by your subjects\?/i)?d.options.find(o=>o.text===(options.collectResources?'Yes':'No')):undefined;
    if(!option)throw Error('unmapped Ghrim choice');
    if(asked&&options.collectResources){const pack=s.sdk.getInventory();if(collectionSubmitted||28-pack.length<MISC_NOTES.filter(id=>!pack.some(i=>i.id===id)).length||MISC_NOTES.some(id=>(stock().get(id)??0)>2147483647-200000))throw Error('Miscellania collection needs all native note slots and stack headroom');collectionSubmitted=true;collectionCursor=marker(s);}
    pendingChoice=choiceKey();if(!(await s.sdk.clickDialogByText(!asked?/^How is the Kingdom faring\?$/i:options.collectResources?/^Yes$/i:/^No$/i)).success)throw Error('guarded Ghrim choice refused; no retry');asked=true;
   }else{
    observeCollection();
    await proceed();
   }await step();
  }
  await step();for(let settle=0;collectionSubmitted&&!collectionConfirmed&&settle<8;settle++){observeCollection();if(!collectionConfirmed)await step();}if(collectionSubmitted&&!collectionConfirmed)throw Error('native resource report/pack credits unconfirmed; no retry');before=balance();if(before===undefined)throw Error('fresh canonical coffer balance text unavailable');if(!unchanged())throw Error('owned assets changed before deposit');if(amount>MISC_COFFER.maximum-before)throw Error('declared coffer amount exceeds observed capacity');
  const depositCursor=marker(s);check();if(!(await s.sdk.sendClickComponent(MISC_COFFER.deposit)).success)throw Error('coffer deposit button refused');
  while(!ui.isChatBackInputOpen()){
   check();prompt ||= fresh(s,depositCursor,new RegExp('You are carrying '+coins0+' coins\\.'))&&fresh(s,depositCursor,/Enter an amount to deposit in the coffers\./);
   const d=s.sdk.getDialog();if(d?.isOpen&&!d.isWaiting&&prompt)await proceed();await step();
  }
  check();if(!prompt||!unchanged())throw Error('coffer amount prompt or owned funds changed');submitted=true;
  if(!(await s.sdk.sendCountDialog(amount)).success)throw Error('coffer amount dispatch uncertain; no retry');
  const added=new RegExp('Added '+amount+' coins to the coffers\\.');
  while(true){
   check();after=balance();const confirmed=fresh(s,depositCursor,added);if(after!==undefined&&confirmed&&cofferDepositEffect(amount,coins0,stock().get(995)??0,before,after))break;
   if(!confirmed&&fresh(s,depositCursor,/Added \d+ coins to the coffers\./))throw Error('native coffer addition receipt differs');
   const d=s.sdk.getDialog();if(d?.isOpen&&!d.isWaiting&&confirmed)await proceed();await step();
  }
  if(!cofferDepositEffect(amount,coins0,stock().get(995)??0,before,after))throw Error('exact declared coin/coffer transfer unconfirmed');
 }catch(error){detail=String(error);}
 finally{if(ownedUi&&alive())try{await s.sdk.sendCloseModal();}catch(error){detail ||= String(error);}}
 const final=stock(),preserved=[...new Set([...initial.keys(),...final.keys()])].every(id=>id===995||(initial.get(id)??0)+(collectionCredits[id]??0)===(final.get(id)??0))&&gear===JSON.stringify(s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 return{ok:!detail&&!life.stopped()&&preserved&&submitted&&before!==undefined&&after!==undefined&&cofferDepositEffect(amount,coins0,final.get(995)??0,before,after),amount,submitted,collectionRequested:!!options.collectResources,collectionSubmitted,collectionConfirmed,collectionCredits,collectionText,coinsSpent:coins0-(final.get(995)??0),cofferBefore:before,cofferAfter:after,preserved,ticks:s.tick()-start,detail,collectionPending:collectionSubmitted&&!collectionConfirmed,pending:collectionSubmitted&&!collectionConfirmed||submitted&&(before===undefined||after===undefined||!cofferDepositEffect(amount,coins0,final.get(995)??0,before,after)),scope:'one optional native noted-resource collection and declared coffer deposit; no withdrawal or worker allocation; native bank delivery is commented out'};
}
if(import.meta.main){const account=process.argv[2];if(!account)throw Error('account and exact coin amount required');let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(account);let ok=false;try{const r=await depositMiscCoffer(s,Number(process.argv[3]),Number(process.argv[4]??120),()=>stopped||existsSync('.practice/stop-all')||existsSync('.practice/stop-'+account)||existsSync('.practice/stop-misc-coffer'),{collectResources:process.argv[5]==='--collect'});console.log('MISC_COFFER '+JSON.stringify(r));ok=r.ok;}finally{process.exitCode=await settle([s],ok,'finite native coffer deposit')?0:1;}}
