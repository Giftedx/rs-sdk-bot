import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {openBot,settle,serverFromEnv} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {orderPaths} from './buy-owned-ge-item';
import {runGETrip,validateGETrip,geTripPaths,geSaleRequest,geOutcome,geTripStop,type GETripRequest,type GETripJournal} from './microbot-ge-trip';
import {runOwnedSale,saleResting,type SaleJournal} from './sell-owned-ge-item';

export type GEPricePlan={actor:string;server:string;goal:string;item:number;quantity:number;reserve:number;floor:number;deadline:number;cap:number;prices:{price:number;fillWait:number}[]};
type Round={request:GETripRequest;filled:number;gross:number;tax:number;net:number;unsubmitted:boolean;initial:Record<number,number>;gear:GETripJournal['initialGear']};
export type GEPlanJournal={version:1;request:GEPricePlan;phase:'prepared'|'running'|'resting'|'complete'|'stopped';rounds:Round[];current?:GETripRequest;failure?:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function validateGEPlan(r:GEPricePlan){
 if(!r||!Array.isArray(r.prices)||r.prices.length<1||r.prices.length>8||!/^[a-z0-9_-]{1,40}$/i.test(r.goal)||!Number.isSafeInteger(r.cap)||r.cap<600||r.cap>100000)throw Error('invalid finite explicit GE plan');
 for(const p of r.prices)validateGETrip({...r,goal:r.goal+'-p0',price:p.price,fillWait:p.fillWait});
}
export function gePlanPaths(r:GEPricePlan){return orderPaths(r.server,r.actor,'ge-plan-'+r.goal);}
export function reclaimGEPlanLock(path:string,alive:(pid:number)=>boolean=pid=>{try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}}){
 if(!existsSync(path))return;const owner=JSON.parse(readFileSync(path,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('GE plan lock owner unknown');if(alive(owner.pid))throw Error('GE plan actor already owned');unlinkSync(path);
}
export function gePlanRound(r:GEPricePlan,index:number,remaining:number,cap:number):GETripRequest{
 const p=r.prices[index];if(!p)throw Error('GE price suggestion absent');
 return{actor:r.actor,server:r.server,goal:r.goal+'-p'+index,item:r.item,quantity:remaining,reserve:r.reserve,floor:r.floor,price:p.price,fillWait:p.fillWait,deadline:r.deadline,cap};
}
export function gePlanTotals(rows:readonly Round[]){return rows.reduce((a,r)=>({filled:a.filled+r.filled,gross:a.gross+r.gross,tax:a.tax+r.tax,net:a.net+r.net}),{filled:0,gross:0,tax:0,net:0});}
const afterRound=(r:Round)=>{const after={...r.initial};after[r.request.item]=(after[r.request.item]??0)-r.filled;after[995]=(after[995]??0)+r.net;return after;};
const sameAssets=(a:Record<number,number>,b:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>(a[Number(k)]??0)===(b[Number(k)]??0));
export function gePlanEntry(previous:Round|undefined,current:Pick<GETripJournal,'initial'|'initialGear'>){if(previous&&(!sameAssets(afterRound(previous),current.initial)||!same(previous.gear,current.initialGear)))throw Error('GE plan between-round assets/gear changed before sale');}
export function gePlanResting(s:Session,q:GETripRequest,paths:{parent:string;lower:string}){
 const parent=JSON.parse(readFileSync(paths.parent,'utf8'))as GETripJournal,lower=JSON.parse(readFileSync(paths.lower,'utf8'))as SaleJournal,ge=s.sdk.getGEState();
 if(s.name.toLowerCase()!==q.actor.toLowerCase()||parent.version!==1||!same(parent.request,q)||lower.version!==1||!same(lower.request,geSaleRequest(q))||lower.phase!=='open'||!ge||s.sdk.getStateAge()>5000)throw Error('fresh owned resting GE identity absent');
 const count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 if(!same(parent.initialGear,s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot)))throw Error('resting GE gear changed');
 return{...saleResting(lower,{actor:s.name,server:q.server,items:count(q.item),coins:count(995),offers:ge.offers}),quantity:q.quantity,unlisted:0,settled:false,banked:false};
}
type Deps={path?:string;trip?:typeof runGETrip};
export async function runGEPlan(s:Session,r:GEPricePlan,requestStop:()=>boolean=()=>false,deps:Deps={},finish=false){
 validateGEPlan(r);if(s.name.toLowerCase()!==r.actor.toLowerCase())throw Error('GE plan actor mismatch');
 const path=deps.path??gePlanPaths(r).journal,trip=deps.trip??runGETrip;
 const roundPaths=(q:GETripRequest)=>deps.path?{parent:path+'.'+q.goal+'.json',lower:path+'.'+q.goal+'.sell.json'}:geTripPaths(q);
 let j:GEPlanJournal|undefined=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
 if(j&&(j.version!==1||!same(j.request,r)||!Array.isArray(j.rounds)||!['prepared','running','resting','complete','stopped'].includes(j.phase)))throw Error('GE plan journal identity invalid');
 const save=()=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(j,null,2));renameSync(path+'.tmp',path);};
 const readRound=(q:GETripRequest):Round=>{
  validateGETrip(q);
  const p=roundPaths(q);if(!existsSync(p.parent))throw Error('GE round durable settlement absent');
  const parent=JSON.parse(readFileSync(p.parent,'utf8'))as GETripJournal;
  if(parent.version!==1||parent.phase!=='banked'||!same(parent.request,q))throw Error('GE round identity/bank settlement invalid');
  const lower=existsSync(p.lower)?JSON.parse(readFileSync(p.lower,'utf8'))as SaleJournal:undefined;
  const outcome=parent.outcome?.unsubmitted?{filled:0,gross:0,tax:0,net:0,unsubmitted:true}:lower&&geOutcome(lower);
  if(!outcome||!same(outcome,parent.outcome)||lower&&(lower.version!==1||!same(lower.request,geSaleRequest(q)))||outcome.unsubmitted&&lower&&lower.phase!=='prepared')throw Error('GE round outcome changed');
  if(!parent.initial||!Array.isArray(parent.initialGear)||Object.entries(parent.initial).some(([id,n])=>!/^\d+$/.test(id)||!Number.isSafeInteger(n)||n<0)||(parent.initial[q.item]??0)<q.quantity+q.reserve)throw Error('GE round initial assets invalid');
  return{request:q,filled:outcome.filled,gross:outcome.gross,tax:outcome.tax,net:outcome.net,unsubmitted:outcome.unsubmitted,initial:parent.initial,gear:parent.initialGear};
 };
 const validateRounds=()=>{
  for(let i=0;i<j!.rounds.length;i++){
   const row=j!.rounds[i]!,remaining=r.quantity-gePlanTotals(j!.rounds.slice(0,i)).filled;
   if(!same(row.request,gePlanRound(r,i,remaining,row.request.cap))||!same(row,readRound(row.request)))throw Error('GE plan recorded round changed');
   if(i&&(!sameAssets(afterRound(j!.rounds[i-1]!),row.initial)||!same(j!.rounds[0]!.gear,row.gear)))throw Error('GE plan between-round assets/gear changed');
  }
  if(j!.rounds.length>r.prices.length)throw Error('GE plan extra round');
 };
 if(j){validateRounds();if(['complete','stopped'].includes(j.phase)&&j.current)throw Error('GE terminal plan retains unresolved round');if(j.phase==='complete'&&j.rounds.length<r.prices.length&&gePlanTotals(j.rounds).filled<r.quantity)throw Error('GE terminal plan lacks completed price/quantity bound');}
 // Terminal replay reads durable receipts only. It does not claim a fresh view
 // of a closed bank, and cannot submit another market or bank action.
 if(j&&['complete','stopped'].includes(j.phase))return{ok:true,replay:true,finished:j.phase==='complete',remaining:r.quantity-gePlanTotals(j.rounds).filled,...gePlanTotals(j.rounds),journal:j,assetAudit:'durable banked round receipts; current bank unobserved'};
 const first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,hp=s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick();let ended=false;void s.ended.then(()=>{ended=true;});
 const fatal=()=>{const p=s.sdk.getState()?.player;return ended||!first||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||(s.sdk.getSkill('Hitpoints')?.level??0)<hp||hp<1;};
 const stop=()=>fatal()||requestStop()||geTripStop(r.actor)||Date.now()>=r.deadline||s.tick()-start>=r.cap-150;
 try{
  if(!j){if(stop())throw Error('GE plan stopped before durable intent');j={version:1,request:r,phase:'prepared',rounds:[]};save();}
  if(j.phase==='resting'&&finish&&!stop())return{ok:true,replay:true,resting:gePlanResting(s,j.current!,roundPaths(j.current!)),...gePlanTotals(j.rounds),journal:j};
  while(j.current||j.rounds.length<r.prices.length&&gePlanTotals(j.rounds).filled<r.quantity){
   if(!j.current){if(stop()||finish&&j.rounds.length>0)break;const cap=r.cap-(s.tick()-start);if(cap<600)break;j.current=gePlanRound(r,j.rounds.length,r.quantity-gePlanTotals(j.rounds).filled,cap);j.phase='running';save();}
   const q=j.current;if(!same(q,gePlanRound(r,j.rounds.length,r.quantity-gePlanTotals(j.rounds).filled,q.cap)))throw Error('GE pending round changed');
   if(fatal())throw Error('GE original life/HP unavailable');
   const paths=roundPaths(q),lower=existsSync(paths.lower)?JSON.parse(readFileSync(paths.lower,'utf8'))as SaleJournal:undefined;
   if(finish&&lower?.phase==='open'){
    const kept=await runOwnedSale(s,geSaleRequest(q),paths.lower,stop,0,false,{leaveOpen:true,fatal});
    if(!kept.ok)throw Error('GE Finish observation/recovery pending');
    if(kept.resting){const resting=gePlanResting(s,q,paths);j.phase='resting';delete j.failure;save();return{ok:true,replay:false,resting,...gePlanTotals(j.rounds),journal:j};}
   }
   const seller:typeof runOwnedSale=(...args)=>{
    // The bank adapter has observed its complete initial ledger before it
    // calls the seller. Reject drift before a new market escrow is submitted.
    // Existing uncertain escrow must still be allowed to cancel and recover.
    if(!args[5])gePlanEntry(j!.rounds.at(-1),JSON.parse(readFileSync(roundPaths(q).parent,'utf8')));
    return runOwnedSale(args[0],args[1],args[2],args[3],args[4],args[5],{leaveOpen:finish&&!stop(),fatal});
   };
   const result=await trip(s,q,stop,{paths:roundPaths(q),seller});
   if(finish&&!stop()&&result.recoveryDeferred){const resting=gePlanResting(s,q,roundPaths(q));j.phase='resting';delete j.failure;save();return{ok:true,replay:false,resting,...gePlanTotals(j.rounds),journal:j};}
   if(!result.ok||!result.banked)throw Error('GE round pending: '+result.failure);
   const row=readRound(q);if(j.rounds.length&&(!sameAssets(afterRound(j.rounds.at(-1)!),row.initial)||!same(j.rounds[0]!.gear,row.gear)))throw Error('GE plan between-round assets/gear changed');
   j.rounds.push(row);delete j.current;save();if(stop()||finish||row.unsubmitted)break;
  }
  j.phase=stop()||finish||j.rounds.at(-1)?.unsubmitted||j.rounds.length<r.prices.length&&gePlanTotals(j.rounds).filled<r.quantity?'stopped':'complete';delete j.failure;save();
  const total=gePlanTotals(j.rounds);return{ok:!fatal(),replay:false,finished:j.phase==='complete',remaining:r.quantity-total.filled,...total,journal:j,assetAudit:'each round exact owned bank ledger; per-offer native tax summed'};
 }catch(error){if(j){j.failure=String(error);save();}return{ok:false,replay:false,pending:!!j?.current,failure:String(error),journal:j};}
}
export async function runGEPlanSession(s:Session,r:GEPricePlan,stop:()=>boolean=()=>false,deps:Deps={},finish=false,finishSession:typeof settle=settle){
 let ok=false;
 try{const result=await runGEPlan(s,r,stop,deps,finish);console.log('GE_PLAN '+JSON.stringify(result));ok=result.ok;}
 catch(error){console.error('GE_PLAN_ERROR '+String(error));}
 const settled=await finishSession([s],ok,'finite explicit GE price plan');return ok&&settled?0:1;
}
if(import.meta.main){
 const [actor,file]=process.argv.slice(2);if(!actor||!file)throw Error('usage: microbot-ge-plan.ts actor explicit-plan.json [--finish]');const request=JSON.parse(readFileSync(file,'utf8'))as GEPricePlan;validateGEPlan(request);
 const actual=serverFromEnv(readFileSync('vendor/rs-sdk/bots/'+actor+'/bot.env','utf8'));if(actual!==request.server)throw Error('GE plan server mismatch');
 const p=gePlanPaths(request);mkdirSync(p.base,{recursive:true});reclaimGEPlanLock(p.lock);const lock=openSync(p.lock,'wx');writeFileSync(lock,JSON.stringify({pid:process.pid,goal:request.goal}));let s:Session|undefined,stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 try{s=await openBot(actor);process.exitCode=await runGEPlanSession(s,request,()=>stopped,{},process.argv.includes('--finish'));}finally{closeSync(lock);unlinkSync(p.lock);}
}
