import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {supplyRoute,type SupplyRouteRequest} from '../packages/planner/src/supply-route';
import {ARDY_BANK,DRAYNOR_BANK,BOAT_FARES_OUT} from './courier-route';
import {courierIslandProblem} from './courier-purchase';

const SOURCE='.practice/joined-plan/delivery-source.json';
const PROOF='.practice/joined-plan/delivery-native-proof.json';
const FAILED='.practice/net-costs/upstream-courier.json';
const need=(ok:unknown,why:string)=>{if(!ok)throw Error(why);};
const integer=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0;
const sum=(s:any,ids:number[])=>[...s.inventory,...s.bank].filter(i=>ids.includes(i.baseId??i.id)).reduce((n,i)=>n+i.count,0);
const field=(s:string,k:string)=>Number(s.match(new RegExp(`(?:^| )${k}=([0-9]+)(?: |$)`))?.[1]??NaN);

// This deliberately accepts one recorded route shape. Do not generalise a survivor
// into access for weaker accounts, a different direction, or today's server state.
export function bindCourierReturn(before:any[],proof:any,failed:any,owned:Set<string>,now:number) {
 const date=(x:any)=>Number.isSafeInteger(x)&&x>0&&x<=now;
 need(proof?.ok===true&&proof.result?.ok===true&&!proof.failure&&!proof.timedOut&&date(proof.at),'Failed or undated delivery');
 const snapshot=(s:any)=>{
  need(s&&owned.has(s.name?.toLowerCase())&&s.server==='rs-sdk-demo.fly.dev'&&!s.practice&&date(s.at)&&date(s.bankAt)&&s.bankAt<=s.at,'Foreign or undated snapshot');
  for(const rows of [s.bank,s.inventory])need(Array.isArray(rows)&&rows.every((i:any)=>integer(i.baseId??i.id)&&integer(i.count)&&i.count>0),'Invalid assets');
  return s;
 };
 need(Array.isArray(before)&&Array.isArray(proof.after),'Missing snapshots');
 const find=(rows:any[],name:string)=>{const matches=rows.filter(s=>s.name===name);need(matches.length===1,'Missing or duplicate account');return snapshot(matches[0]);};
 const start=find(before,'Bigpackage'),end=find(proof.after,'Bigpackage');
 need(date(end.started)&&start.at<end.started&&end.started<end.at&&end.at<=proof.at,'Invalid receipt ordering');
 const near=(s:any,p:{x:number;z:number})=>s.pos?.level===0&&Math.max(Math.abs(s.pos.x-p.x),Math.abs(s.pos.z-p.z))<=2;
 need(near(start,DRAYNOR_BANK)&&near(end,ARDY_BANK),'Route endpoints changed');
 need(start.combat===end.combat&&!courierIslandProblem(start.combat),'Combat access not supported');
 const result=end.result;
 need(typeof result==='string'&&result.startsWith('ok ')&&result.includes('died=false'),'Courier did not survive');
 const opening=Number(result.match(/legs=draynor coins=(\d+)@0,received0@0,ardougne@(\d+)/)?.[1]);
 const travel=Number(result.match(/ardougne@(\d+)/)?.[1]);
 const fare=sum(start,[995])-sum(end,[995]);
 const wallet=(s:any)=>s.inventory.filter((i:any)=>i.id===995).reduce((n:number,i:any)=>n+i.count,0);
 need(opening===wallet(start)&&opening===sum(start,[995])&&field(result,'coins')===wallet(end)&&field(result,'coins')===sum(end,[995])&&fare===BOAT_FARES_OUT,'Cash does not reconcile');
 for(const k of ['ticks','walkTicks','boatTicks','giveTicks','received','handed','fishNotes','coins','waitTicks','feathersBought'])need(integer(field(result,k))&&field(result,k)===end.counters?.[k],'Result/counter mismatch: '+k);
 need(field(result,'received')===0&&field(result,'waitTicks')===0&&field(result,'feathersBought')===0&&field(result,'featherTicks')===0,'Run has extra work');
 need(travel===field(result,'walkTicks')+field(result,'boatTicks')&&field(result,'ticks')===travel+field(result,'giveTicks'),'Timing does not reconcile');
 const notes=(s:any)=>s.inventory.filter((i:any)=>[330,334].includes(i.id)).reduce((n:number,i:any)=>n+i.count,0);
 const handed=field(result,'handed'),cargo=notes(start);
 need(handed>0&&cargo-notes(end)===handed&&sum(start,[329,333])-sum(end,[329,333])===handed&&notes(end)===field(result,'fishNotes'),'Cargo does not reconcile');
 const recipient=proof.after.filter((s:any)=>s.name!=='Bigpackage');
 need(recipient.length===1,'Ambiguous recipient');
 const receiver=snapshot(recipient[0]),receiverBefore=find(before,receiver.name);
 need(receiverBefore.at<end.started&&receiver.at>=end.started&&receiver.at<=proof.at&&sum(receiver,[329,333])-sum(receiverBefore,[329,333])===handed&&proof.result.result?.incoming===handed,'Recipient does not reconcile');
 // No unexplained fish loss: for this recorded run, cargo depletion equals receipt.
 // Zero is historical net depletion, not a future food guarantee.
 need(cargo>0,'No noted cargo');
 need(failed?.name===start.name&&failed.server===start.server&&date(failed.started)&&date(failed.at)&&failed.started<failed.at&&failed.at<start.at&&Array.isArray(failed.lines),'Failed trip not bound');
 need(createHash('sha256').update(failed.lines.join('\n')).digest('hex')===failed.source?.sha256,'Failed log hash mismatch');
 const failures=failed.lines.filter((l:string)=>l.startsWith('RESULT '));
 need(failures.length===1&&failures[0].startsWith('RESULT fail ')&&failures[0].includes('needs 60 coins for the boats home')&&failures[0].includes('at=3092,3242,0'),'Wrong failed route');
 const failedCash=field(failures[0],'coins');
 need(failedCash===4&&field(failures[0],'received')===cargo&&field(failures[0],'fishNotes')===cargo&&field(failures[0],'handed')===0,'Failed trip cargo changed');
 const model={places:{},cache:{legs:{},nearestBank:{},banks:{draynor:DRAYNOR_BANK,ardougne:ARDY_BANK}}};
 const request:SupplyRouteRequest={from:'draynor',to:'ardougne',count:handed,capacity:cargo,budget:{coins:opening,food:0},context:{account:start.name,server:start.server,at:end.at,maxAgeMs:0,combat:start.combat},stops:[{holder:start.name,bank:'draynor',available:cargo,reserved:0,outbound:{coins:0,food:0,accessible:true},onward:{coins:fare,food:0,accessible:true,observed:{ticks:travel,at:end.at,source:PROOF,from:'draynor',to:'ardougne',account:start.name,server:start.server,minCombat:start.combat}}}]};
 return {scope:'Historical replay only; no current access, reservation or execution permission.',account:start.name,server:start.server,observedAt:end.at,combat:start.combat,request,
  funded:supplyRoute(model,request),unfunded:supplyRoute(model,{...request,budget:{coins:failedCash,food:0}}),
  current:supplyRoute(model,{...request,context:{...request.context!,at:now}}),
  outboundUnproved:supplyRoute(model,{...request,from:'ardougne',stops:request.stops.map(s=>({...s,outbound:{coins:null,food:null,accessible:null}}))}),
  observed:{fare,travelTicks:travel,handoffTicks:field(result,'giveTicks'),delivered:handed},
  gain:{cashShortfallDetected:fare-failedCash,measuredTicksSaved:null,reason:'No matched alternative route runs. Later funding/access proof cannot establish an earlier speed gain.'},
  limits:['Cargo capacity is the already-carried noted load; no new pickup or reservation proved.','Zero food cost is reconciled net depletion on this one run.','Earlier failed trip has no matched combat/access snapshot here.','Recheck position, combat, cargo, reservations, wallet and route conditions before any future use.']};
}

if(import.meta.main){
 const root=resolve(import.meta.dir,'..'),sources:Record<string,string>={};
 const read=(p:string)=>{const raw=readFileSync(resolve(root,p));sources[p]=createHash('sha256').update(raw).digest('hex');return JSON.parse(raw.toString());};
 // Names are from the existing manifest; importing it does not start jobs.
 const {FLEET}=await import('./fleet');
 const replay=bindCourierReturn(read(SOURCE),read(PROOF),read(FAILED),new Set(FLEET.filter(a=>a.role!=='main').map(a=>a.name.toLowerCase())),Date.now());
 const proof=read(PROOF);
 const code=['scripts/courier-route-evidence.ts','scripts/courier-route.ts','scripts/courier-purchase.ts','scripts/foodcourier.ts','packages/planner/src/supply-route.ts'];
 const sourceHashes=Object.fromEntries(code.map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')]));
 const out=resolve(root,'.practice/shared-supply/courier-replay.json');
 mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({...replay,sources,sourceHashes,recordedRuntimeHashes:proof.sha},null,2)+'\n');
 console.log(JSON.stringify({output:out,...replay.observed,gain:replay.gain,funded:!!replay.funded.selected,unfunded:!!replay.unfunded.selected}));
}
