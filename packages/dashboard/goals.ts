import { COST_RECEIPTS,netCosts } from './net-costs';
import { gearProgress,questProgress,batchCosts } from './goal-details';
import { SKILLS } from '../planner/src/haggis';
import { xpForLevel } from '../planner/src/curve';
import {COMBAT_SKILLS,type OwnerGoals,type GoalEvidence} from '../router/src/goal-scoreboard';

// The joined plan owns goal wording and pause state. Metrics remain separate observations.
export function goalPlan(text: string) {
    const section = text.split(/^## (?:Lanes|Goals and next evidence(?: after resume)?)[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    const titles=['Main Overall','Coverage','Specialist hiscores','Wealth / logistics / GE','Gear / collection','Efficiency / visibility'];
    const rows=section.split('\n').filter(line=>line.trim().startsWith('|')).map(line=>line.split('|').slice(1,-1).map(v=>v.trim()));
    const header=rows.shift()??[],column=(name:string)=>header.findIndex(v=>v.toLowerCase()===name);
    const titleColumn=column('lane')<0?column('goal'):column('lane'),targetColumn=column('target'),nextColumn=column('next'),ownerColumn=column('owner');
    const parsed=titleColumn<0||targetColumn<0||nextColumn<0?[]:rows.map(row=>({title:row[titleColumn]??'',target:row[targetColumn]??'',next:row[nextColumn]??'',...(ownerColumn<0?{}:{owner:row[ownerColumn]??''})})).filter(row=>row.title&&row.target&&row.next);
    // Goal cards use these six positions. Operational lanes such as Autopilot
    // retain their plan ownership without shifting a specialist's goal card.
    const lanes=titles.flatMap(title=>{const row=parsed.find(row=>row.title===title);return row?[row]:[];});
    return { paused: /\*\*Execution paused by the user/.test(text), available: lanes.length === titles.length, lanes };
}

import type { GoalRow } from './goal-types';
export type { GoalRow } from './goal-types';
type Lane = { title:string; metric:string; meta:string; level:string; blocker:string; next:string; rows:GoalRow[] };
export type GoalInputs = { requirements:{item:string;count:number;itemId?:number}[]|null; items:any[]; quests:any[]; questConstants:string; receipts:Record<string,any> };
const validAt=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now;
const fresh=(at:any,now:number,limit=300000)=>validAt(at,now)&&now-at<limit;
export type QuestPointObservation={points:number;at:number;source:'status'|'hiscores'};
// Quest points are account observations, never a substitute for individual quest flags. Prefer the newest dated
// source, with direct server state winning a tie; an explicit unknown source date cannot borrow another timestamp.
export function questPointObservation(bot:any,now:number):QuestPointObservation|null{
 const server='rs-sdk-demo.fly.dev',name=typeof bot?.name==='string'?bot.name.toLowerCase():'';
 const points=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
 const compatible=(value:any)=>value&&typeof value==='object'&&!value.practice
  &&(!Object.hasOwn(value,'server')||typeof value.server==='string'&&value.server.toLowerCase()===server)
  &&['name','account'].every(key=>!Object.hasOwn(value,key)||typeof value[key]==='string'&&value[key].toLowerCase()===name);
 if(!/^[a-z0-9_ -]{1,12}$/.test(name)||typeof bot.server!=='string'||bot.server.toLowerCase()!==server
  ||!compatible(bot)||!Number.isFinite(now)||now<=0)return null;
 const facts=bot.guildFacts,qp=facts?.varps?.qp;
 let selected:QuestPointObservation|null=compatible(facts)&&points(qp)&&validAt(bot.at,now)?{points:qp,at:bot.at,source:'status'}:null;
 for(const rank of Array.isArray(bot.ranks)?bot.ranks:[]){
  if(rank?.board!=='Quest Points'||!compatible(rank)||!points(rank.level))continue;
  const at=Object.hasOwn(rank,'at')?rank.at:bot.ranksAt;
  if(validAt(at,now)&&(!selected||at>selected.at))selected={points:rank.level,at,source:'hiscores'};
 }
 return selected;
}
const nameKey=(s:string)=>s.trim().toLowerCase().replace(/\s*\(noted\)$/,'').replace(/^feathers$/,'feather').replace(/^headless arrows$/,'headless arrow');
const boardKey=(s:string)=>s.toLowerCase().replace(/^lava maze /,'').replace(/[^a-z]/g,'');
const num=(v:number)=>Number.isFinite(v)?Number(v.toFixed(2)).toLocaleString('en-US'):'?';
// Pinned catalog debug names distinguish tutorial/fake items and unstrung bows.
const supplyAliases:Record<string,string>={'pot of flour':'pot_flour','raw shrimps':'raw_shrimp',coins:'coins',logs:'logs','magic shortbow':'magic_shortbow','yew shortbow':'yew_shortbow','dragonfire shield (quest)':'antidragonbreathshield',...Object.fromEntries(['guam','harralander','ranarr','irit','avantoe','kwuarm'].map(h=>[h+' potion (unf)',h+'vial']))};
export const GOAL_RECEIPTS={
 ...COST_RECEIPTS,
 delivery:'.practice/joined-plan/batch-native-proof.json',
 production:'.practice/joined-plan/production-repeat-completed.json',
 apron:'.practice/joined-plan/apron-native-proof.json',
 guildPractice:'.practice/joined-plan/guild-packed-proof.json',
 guildLive:'.practice/joined-plan/guild-packed-native-proof.json',
 combat:'.practice/joined-plan/combat-block-review.json',
 rune:'.practice/recovery-20261025/MineYourBiz-qualification/native-reset-quest-proof.json',
};

function ownerGoalCards(state:any):Lane[]|null{
 const g=state.scoreboard?.goals as OwnerGoals|undefined,now=state.now;
 if(g?.version!==1||!validAt(g.at,now)||!g.main||!Array.isArray(g.specialists?.targets)||!Array.isArray(g.specialists.rank1s)
  ||!Array.isArray(g.quests?.remaining)||!Array.isArray(g.collection?.missing)||!Array.isArray(g.army?.roster)||!Array.isArray(g.army.accounts))return null;
 const row=(label:string,value:unknown,source:string,at?:number|null,tone:GoalRow['tone']='dm'):GoalRow=>({label,value:String(value),source,...(validAt(at,now)?{at:at!}:{}),tone});
 const source=(e:GoalEvidence[]|undefined)=>{
  const list=[...new Set((e??[]).map(x=>x.source).filter(Boolean))];
  if(!list.length)return '.practice/coordinator/scoreboard.json';
  return list.length>6?`${list.slice(0,4).join('; ')}; +${list.length-4} more`:list.join('; ');
 };
 const at=(e:GoalEvidence[]|undefined)=>(e??[]).find(e=>validAt(e.at,now))?.at;
 const evidenceRows=(e:GoalEvidence[]|undefined)=>(e??[]).map((e,i)=>row(`Evidence ${i+1}`,e.gap??(e.ageMs===null?'Observation date unknown':`${num(e.ageMs)} ms old at ledger build`),e.source,e.at,e.gap?'warn':'dm'));
 const pause=state.objectives?.paused?'After resume: ':'';
 const n=(value:number|null)=>value===null?'unknown':num(value);
 const observed=validAt(g.main.rankAt,now)&&fresh(g.main.rankAt,now,3_600_000);
 const mainMetric=observed?g.main.rank1===true?'#1 observed':g.main.rank===null?'Rank unknown':`Rank #${g.main.rank}`:g.main.rank===null?'Rank unknown':'Rank stale';
 const held=g.specialists.rank1s.filter(r=>fresh(r.at,now,3_600_000)),boardsHeld=new Set(held.map(r=>r.board.toLowerCase())).size;
 const supplyRows=g.collection.missing.map(s=>row(s.item,`${num(s.owned)}/${num(s.need)} recent${s.verifyOwned?` · ${num(s.verifyOwned)} need verification`:''}`,s.consumer,undefined,'warn'));
 const nextSupply=g.collection.missing[0];
 const nextSupplyAction=nextSupply?nextSupply.verifyOwned?`Refresh the held ${nextSupply.item} for ${nextSupply.consumer}.`:`Stage ${num(Math.max(0,nextSupply.need-nextSupply.owned))} ${nextSupply.item} for ${nextSupply.consumer}.`:'Keep exact reservations and delivery proof for each named consumer.';
 const nextArmy=g.army.accounts.find(a=>!a.maxed),nextSkill=nextArmy?COMBAT_SKILLS.find(skill=>nextArmy.levels[skill]!==99):undefined;
 return[
  {title:'Main Overall rank 1',metric:mainMetric,meta:`${n(g.main.modelTicks)} model ticks · ${n(g.main.gapTicks)} to launch margin`,level:observed?'LIVE OBSERVATION':'MODEL / UNKNOWN',
   blocker:g.main.rank1===true&&observed?'A saved rank observation proves first place at its source time.':'The route model and launch readiness do not prove a recorded Overall win.',
   next:pause+(g.main.rank1===true&&observed?'Keep current rank evidence and advance the remaining owner goals.':g.main.gapTicks===null?'Restore the Overall record and route model.':g.main.gapTicks>0?`Cut ${num(g.main.gapTicks)} model ticks, then qualify the full route.`:'Check rehearsal, staging and fresh targets before the scored run.'),
   rows:[row('Recorded Overall rank',observed?g.main.rank===null?'Unknown':`#${g.main.rank}`:'Unknown or stale',source(g.main.evidence),g.main.rankAt),row('Model / launch target',`${n(g.main.modelTicks)} / ${n(g.main.launchTargetTicks)} ticks`,source(g.main.evidence),at(g.main.evidence)),row('Record',`${n(g.main.recordTicks)} ticks`,source(g.main.evidence),at(g.main.evidence)),...evidenceRows(g.main.evidence)]},
  {title:'Specialist board wins',metric:`${boardsHeld} board${boardsHeld===1?'':'s'} held`,meta:`${g.specialists.targets.length} formal candidates · priced routes remain separate`,level:'LIVE / MODEL',
   blocker:g.specialists.scopeKnown?'Each target still needs a priced route and a current recorded win.':'The winnable specialist target set is incomplete; estimates and rehearsals are separate from recorded wins.',
   next:pause+'Price the next specialist route against a fresh record and its exact staged supplies.',
   rows:[...held.map(r=>row(`${r.board} · ${r.account}`,'#1 observed',r.source,r.at,'good')),...g.specialists.targets.map(t=>row(`${t.board} · ${t.account}`,`plan ${n(t.planTicks)} · rehearsal ${n(t.rehearsalTicks)} · record ${n(t.recordTicks)} ticks · margin ${n(t.marginTicks)}`,source(t.evidence),at(t.evidence))),...evidenceRows(g.specialists.evidence)]},
  {title:'All quests',metric:`${g.quests.complete}/${g.quests.total} complete`,meta:`implemented journal targets · ${g.quests.observedAccounts} account observations`,level:'LIVE JOURNAL',
   blocker:g.quests.remaining.length?`${g.quests.remaining.length} implemented quests lack a live completion observation.`:g.quests.total?'Every listed quest has a live journal completion observation.':'The implemented quest target list is unavailable.',
   next:pause+(g.quests.remaining[0]?`Finish ${g.quests.remaining[0]} and record its journal flag.`:'Keep journal evidence for the complete implemented target list.'),
   rows:[row('Implemented quests',`${g.quests.complete}/${g.quests.total}`,source(g.quests.evidence),at(g.quests.evidence)),...g.quests.remaining.map(name=>row(name,'Live completion not proved',source(g.quests.evidence),undefined,'warn')),...evidenceRows(g.quests.evidence)]},
  {title:'Useful items & best gear',metric:g.collection.scopeKnown?`${g.collection.held}/${g.collection.targets} held`:'Scope unknown',meta:'route supplies and declared kits are a supported subset',level:'OBSERVED / UNKNOWN',
   blocker:g.collection.scopeKnown?'Holdings still need exact item identity and current observations.':'The full useful-item and best-in-slot target set is undefined; supported supply coverage cannot prove collection completion.',
   next:pause+'Map the full useful-item and best-in-slot targets from the item and gear catalogues.',
   rows:[row('Supported subset',`${g.collection.held}/${g.collection.targets} named supply lines`,source(g.collection.evidence),at(g.collection.evidence)),row('Full useful-item / best-in-slot scope',g.collection.scopeKnown?'Defined':'Unknown',source(g.collection.evidence),undefined,g.collection.scopeKnown?'dm':'warn'),...evidenceRows(g.collection.evidence)]},
  {title:'Maxed PK army',metric:g.army.roster.length?`${g.army.maxed}/${g.army.roster.length} maxed`:'Roster unknown',meta:`seven combat skills at 99 on each account · ${g.army.missingLevels} target levels unverified or missing`,level:'LIVE / UNKNOWN',
   blocker:'Maxed levels, credited player kills and Wilderness control each need their own proof.',
   next:pause+(nextArmy&&nextSkill?`${nextArmy.levels[nextSkill]===null?'Observe':'Train'} ${nextArmy.account} · ${nextSkill} toward 99.`:'Bind credited player kills and Wilderness control to live evidence.'),
   rows:[...g.army.accounts.flatMap(a=>COMBAT_SKILLS.map(skill=>row(`${a.account} · ${skill}`,a.levels[skill]===null?'Unknown / 99':`${a.levels[skill]}/99`,source(g.army.evidence),a.at,a.levels[skill]===99?'good':'warn'))),row('Credited player kills',g.army.creditedKills===null?'Unknown':g.army.creditedKills,source(g.army.evidence),undefined,'warn'),row('Wilderness control',g.army.wildernessControl===null?'Unknown':g.army.wildernessControl,source(g.army.evidence),undefined,'warn'),...evidenceRows(g.army.evidence)]},
  {title:'Named supply support',metric:`${g.collection.held}/${g.collection.targets} lines`,meta:'finite route and kit demand · current stock only',level:'SUPPORT',
   blocker:g.collection.missing.length?'Current stock is short or needs a fresh observation; gold counts only against a named consumer.':'Stock coverage still requires reservations, staging and delivery proof.',next:pause+nextSupplyAction,
   rows:[...supplyRows,row('Support scope','Supplies serve the owner goals; wealth and coin rate are not separate goals.',source(g.collection.evidence)),...evidenceRows(g.collection.evidence)]},
 ];
}

// Pure, read-only projection. Historical receipts never become current staging or live promotion.
export function goalProgress(state:any,input:GoalInputs):Lane[]{
 const owner=ownerGoalCards(state);if(owner)return owner;
 input={...input,items:Array.isArray(input.items)?input.items:[],quests:Array.isArray(input.quests)?input.quests:[],questConstants:typeof input.questConstants==='string'?input.questConstants:'',receipts:input.receipts??{}};
 const now=state.now,bots=(state.bots??[]).filter((b:any)=>!b.practice&&!b.reserved&&b.server==='rs-sdk-demo.fly.dev'),owned=new Set<string>(bots.map((b:any)=>String(b.name).toLowerCase()));
 const row=(label:string,value:unknown,source:string,at?:number,tone?:GoalRow['tone']):GoalRow=>({label,value:String(value),source,...(validAt(at,now)?{at}:{}),tone});
 const statusPath=(b:any)=>`.practice/status/${b.name}.json`;
 const snapshotBots=bots.filter((b:any)=>validAt(b.at,now)),banks=bots.filter((b:any)=>validAt(b.bankAt,now)&&Array.isArray(b.bank)&&b.bank.every((i:any)=>i&&Number.isSafeInteger(i.baseId??i.id)&&Number.isSafeInteger(i.count)&&i.count>0));
 const catalog=new Map<string,any[]>();for(const i of input.items){if(!i||typeof i.name!=='string'||!Number.isSafeInteger(i.id))continue;const k=nameKey(i.name);catalog.set(k,[...(catalog.get(k)??[]),i]);}
 const demand=new Map<string|number,{item:string;count:number;id:number|null}>();
 for(const r of input.requirements??[]){
  const key=nameKey(r.item),alias=supplyAliases[key];
  const matches=r.itemId!==undefined?input.items.filter(i=>i?.id===r.itemId)
   :alias?input.items.filter(i=>i?.debugname===alias):(catalog.get(key)??[]);
  const id=matches.length===1&&Number.isSafeInteger(matches[0].id)?matches[0].id:null;
  const pool=id??key,prior=demand.get(pool);
  demand.set(pool,{item:prior?.item??r.item,count:(prior?.count??0)+r.count,id});
 }
 const supply=[...demand.values()].map(r=>{
  const {id}=r;
  const holders=id===null?[]:banks.flatMap((b:any)=>{const count=b.bank.filter((i:any)=>(i.baseId??i.id)===id).reduce((n:number,i:any)=>n+i.count,0);return count?[{name:b.name,count,at:b.bankAt,recent:fresh(b.bankAt,now)}]:[]});
  const recent=holders.filter((h:any)=>h.recent).reduce((n:number,h:any)=>n+h.count,0),old=holders.filter((h:any)=>!h.recent).reduce((n:number,h:any)=>n+h.count,0);
  return {...r,id,holders,recent,old,missing:Math.max(0,r.count-recent)};
 });
 const covered=supply.filter(r=>r.id!==null&&r.missing===0),unresolved=supply.filter(r=>r.id===null),short=supply.filter(r=>r.id!==null&&r.missing>0);
 const r=input.receipts,net=netCosts(r,owned,now),d=r.delivery,p=r.production,ps=p?.status;
 const recipients=Array.isArray(d?.result?.results)?d.result.results:[];
 const deliveryOK=validAt(d?.at,now)&&d.ok===true&&d.result?.ok===true&&!d.timedOut&&recipients.length>0&&new Set(recipients.map((x:any)=>x?.name)).size===recipients.length&&recipients.every((x:any)=>x&&owned.has(String(x.name).toLowerCase())&&Number.isSafeInteger(x.target)&&x.target>0&&Number.isSafeInteger(x.result?.incoming)&&x.result.incoming>=x.target)&&Array.isArray(d.after)&&d.after.length>0&&d.after.every((b:any)=>b?.server==='rs-sdk-demo.fly.dev'&&owned.has(String(b.name).toLowerCase()));
 const matchedDelivery=deliveryOK&&recipients.every((x:any)=>d.after.some((b:any)=>String(b.name).toLowerCase()===String(x.name).toLowerCase()&&validAt(b.at,now)&&Array.isArray(b.bank)&&b.bank.some((i:any)=>i&&(i.baseId??i.id)===333&&Number.isSafeInteger(i.count)&&i.count>=x.result.incoming)));
 const delivered=matchedDelivery?recipients.reduce((n:number,x:any)=>n+x.result.incoming,0):null;
 const lines=Array.isArray(p?.logTail)?p.logTail:[],result=lines.find((s:string)=>/^RESULT ok\b/.test(s))??'';
 const counter=(key:string)=>{const m=result.match(new RegExp('(?:^|\\s)'+key+'=(\\d+(?:\\.\\d+)?)\\b'));return m?Number(m[1]):null;};
 const ticks=counter('ticks'),banked=counter('banked');
 const productionOK=validAt(p?.at,now)&&validAt(ps?.at,now)&&ps?.server==='rs-sdk-demo.fly.dev'&&owned.has(String(ps?.name).toLowerCase())&&/^ok\b/.test(ps?.result??'')&&lines.includes('LOGOUT logged-out')&&/\bdied=false\b/.test(result)&&ticks!==null&&ticks>0&&banked!==null&&banked>0;
 const rate=productionOK?banked!/ticks!:null;
 const paused=(state.objectives?.paused)?'After resume: ':'';
 const needs=bots.filter((b:any)=>['blocked','failed','died'].includes(b.operation));
 const fleetRows=[...net.rows,row('Owned delivery',matchedDelivery?`${num(delivered!)} fish → ${recipients.length} recipients`:'No accepted record',GOAL_RECEIPTS.delivery,d?.at,matchedDelivery?'good':'warn'),row('Completed production',productionOK?`${num(banked!)} coins banked / ${num(ticks!)} ticks`:'No accepted record',GOAL_RECEIPTS.production,p?.at,productionOK?'good':'warn'),row('Food consumed',productionOK?`${counter('eaten')??'?'} · cost not valued`:'unknown',GOAL_RECEIPTS.production,p?.at),row('Fire Giant repeat',validAt(Date.parse(r.combat?.at),now)&&r.combat?.result?`${r.combat.result.creditedKills} credited kills · ${r.combat.result.eaten} food consumed`:'unknown',GOAL_RECEIPTS.combat,Date.parse(r.combat?.at), 'warn'),row('Full replenishment loop','Unproved', 'docs/plans/joined-plan.md',undefined,'warn'),...needs.map((b:any)=>row(b.name,b.planJob?.state||b.operation,statusPath(b),b.at,'warn'))];
 const gearTarget=gearProgress(bots,input.items,now),questFlags=questProgress(bots,now),costs=batchCosts(counter,productionOK,p?.at);
 const gear=snapshotBots.filter((b:any)=>Array.isArray(b.equipment));
 const collectionRows=[...gearTarget.rows,row('Route inputs covered',input.requirements?`${covered.length}/${supply.length} by recent banks`:'Model unavailable','packages/planner/src/haggis-boards.json'),row('Unresolved input IDs',unresolved.length,'knowledge/items.json',undefined,unresolved.length?'warn':'dm'),row('Bank observations',`${banks.filter((b:any)=>fresh(b.bankAt,now)).length} recent · ${banks.length} known / ${bots.length} owned`,'.practice/status'),row('Gear snapshots',`${gear.length}/${bots.length} accounts · ${gear.filter((b:any)=>fresh(b.at,now)).length} recent`,'.practice/status'),...supply.map(s=>row(s.item,s.id===null?'ID unresolved':`${num(s.recent)}/${num(s.count)} recent · ${num(s.old)} old`,'packages/planner/src/haggis-boards.json; '+s.holders.map((h:any)=>`.practice/status/${h.name}.json`).join(', '),s.holders.length?Math.min(...s.holders.map((h:any)=>h.at)):undefined,s.id===null||s.missing>0?'warn':'good')),...gear.map((b:any)=>row(`${b.name} gear`,b.equipment.map((i:any)=>i?.name).join(', ')||'observed empty',statusPath(b),b.at)),row('Useful / rare target set','Undefined; route inputs are only a subset','docs/plans/joined-plan.md',undefined,'warn')];
 const sourceQP=[...input.questConstants.matchAll(/^\^(\w+)_questpoints\s*=\s*(\d+)/gm)],maxQP=sourceQP.reduce((n,m)=>n+Number(m[2]),0),parsedQP=input.quests.reduce((n,q)=>n+(Number(q?.questPoints)||0),0);
 const skillRows=SKILLS.map(skill=>{const candidates=snapshotBots.flatMap((b:any)=>(b.skills??[]).filter((s:any)=>s.name?.toLowerCase()===skill&&Number.isFinite(s.level)&&Number.isFinite(s.xp)).map((s:any)=>({...s,account:b.name,at:b.at}))).sort((a:any,b:any)=>b.level-a.level||b.xp-a.xp);return {skill,best:candidates[0]};});
 const maxed=skillRows.filter(s=>s.best?.level>=99),pairs=snapshotBots.reduce((n:number,b:any)=>n+(b.skills??[]).filter((s:any)=>SKILLS.includes(s.name?.toLowerCase())&&s.level>=99).length,0);

 const qp=bots.flatMap((b:any)=>{const value=questPointObservation(b,now);return value?[{name:b.name,...value,
  path:value.source==='hiscores'?'hiscore snapshot':b.remote||b.snapshotOnly?`fleet/snapshots/${b.side??'unknown'}.json`:statusPath(b)}]:[];});
 const a=r.apron,g=r.guildPractice,gl=r.guildLive;
 const apronOK=validAt(a?.at,now)&&a.ok===true&&a.assetCheck===true&&a.code===0&&a.after?.server==='rs-sdk-demo.fly.dev'&&owned.has(String(a.after?.name).toLowerCase())&&Array.isArray(a.result?.bank?.items)&&a.result.bank.items.some((i:any)=>i&&i.id===1757&&i.count>0);
 const practiceOK=g?.ok===true&&g.code===0&&g.assetCheck===true&&g.result?.gained>0&&validAt(g.result?.bankAfter?.at,now);
 const liveGuild=validAt(gl?.at,now)&&gl.ok===false?'failed / stopped':'unproved';
 const questRows=[...questFlags.rows.slice(0,2),row('Reward extract',`${input.quests.length}/${sourceQP.length||'?'} · ${parsedQP}/${maxQP||'?'} QP`,'knowledge/quests.json; vendor/rs-sdk/server/content/scripts/general/configs/quest.constant',undefined,input.quests.length!==sourceQP.length?'warn':'dm'),row('Rune Mysteries · live',r.rune?.ok===false&&validAt(r.rune?.status?.at,now)?r.rune.status.result:'No accepted completion',GOAL_RECEIPTS.rune,r.rune?.status?.at,'warn'),...questFlags.rows.slice(2),...qp.map((q:any)=>row(`${q.name} recorded QP`,`${q.points}/${maxQP||'?'} · not a quest census`,q.path,q.at)),row('99s observed',`${pairs} skill-account pairs · ${maxed.length}/${SKILLS.length} skill types`,'.practice/status'),row('Brown apron',apronOK?'acquired + banked live':'unproved',GOAL_RECEIPTS.apron,a?.at,apronOK?'good':'warn'),row('Guild chain · practice',practiceOK?`${g.result.gained} ore · cloned inputs`:'unproved',GOAL_RECEIPTS.guildPractice,g?.result?.bankAfter?.at,practiceOK?'good':'warn'),row('Guild chain · live',liveGuild,GOAL_RECEIPTS.guildLive,gl?.at,'warn'),...skillRows.map(s=>row(s.skill,s.best?`${s.best.level}/99 · ${s.best.account} · ${num(Math.max(0,xpForLevel(99)-s.best.xp))} XP left`:'no observation',s.best?`.practice/status/${s.best.account}.json`:'.practice/status',s.best?.at,s.best?.level>=99?'good':'dm'))];
 const specialist=(state.boards??[]).map((b:any)=>{const ranks=bots.flatMap((a:any)=>(a.ranks??[]).filter((x:any)=>boardKey(x.board)===boardKey(b.board)&&fresh(x.at??a.ranksAt,now,600000)&&Number.isSafeInteger(x.rank)&&x.rank>0).map((x:any)=>({...x,account:a.name,at:x.at??a.ranksAt}))).sort((a:any,b:any)=>a.rank-b.rank);return {board:b.board,best:ranks[0],top:b.top,kind:b.kind,cutoff:b.cutoff};});
 const known=specialist.filter((s:any)=>s.best),first=known.filter((s:any)=>s.best.rank===1),contender=known.filter((s:any)=>s.best.rank>1).sort((a:any,b:any)=>a.best.rank-b.best.rank)[0];
 const rankRows=specialist.map((s:any)=>row(s.board,s.best?`#${s.best.rank} · ${s.best.account} · level ${s.best.level}`:s.kind==='value'?(s.cutoff?`Not in the top ${s.cutoff.rank} (#${s.cutoff.rank} holds ${s.cutoff.text})`:'Board not read'):'Recent rank missing',s.best?'hiscore snapshot':'packages/dashboard/server.ts',s.best?.at,s.best?'dm':'warn'));
 const race=state.race,overall=race?.rows?.find((x:any)=>x.id==='overall'),gates=state.gates,passes=gates?.valid?gates.gates.filter((g:any)=>g.pass).length:null;
 const mainRows=[row('Overall model',overall?`${num(overall.real.finish)} / ${num(overall.deadline)} ticks`:'unavailable','packages/planner/src/haggis.ts',race?.sourceAt,'warn'),row('Model wins',`${race?.wins??'?'}/24 · not recorded wins`,'packages/planner/src/haggis.ts',race?.sourceAt),row('Unmeasured inputs',race?.unmeasured??'?','packages/planner/src/haggis-boards.json'),row('Route supply coverage',`${covered.length}/${supply.length} recent · not reserved`,'packages/planner/src/haggis-boards.json'),...(gates?.gates??[]).map((g:any)=>row(g.name,g.detail,'.practice/haggis-readiness.json',gates?.at,g.pass?'good':'warn'))];
 const efficiencyRows=[...net.rows,...(net.valid?[]:costs.rows),row('Saved gross coin rate',rate!==null?`${num(rate)} coins / tick`:'unknown',GOAL_RECEIPTS.production,p?.at,rate!==null?'good':'warn'),row('Recorded bank output',productionOK?`${num(banked!)} coins · ${num(ticks!)} ticks`:'unknown',GOAL_RECEIPTS.production,p?.at),...bots.filter((b:any)=>fresh(b.at,now,20000)&&b.operation==='observed'&&b.ledger).map((b:any)=>{const t=Object.values(b.ledger).reduce((n:number,v:any)=>n+(Number(v)||0),0);return row(b.name,t?`${num(100*(b.ledger.idle??0)/t)}% unchanged / ${num(t)} ticks`:'no ledger',statusPath(b),b.at);}),row('Matched comparison','No matched baseline linked in current plan','docs/plans/joined-plan.md',undefined,'warn')];
 return [
  {title:'Fleet & wealth',metric:net.valid?`+${num(net.net!)}`:delivered===null?'No proof':`${num(delivered)} fish`,meta:net.valid?'saved net cash · food cost unknown':matchedDelivery?`${recipients.length} recipients · saved live proof`:'Delivery evidence missing',level:'LIVE RECORD',blocker:net.valid?`Opening food cost unknown; ${Math.abs(net.eaten!-net.fishUsed!)} eat event differs from stock depletion.`:'Net resources counted; food/support costs unallocated; full refill cycle unproved.',next:net.valid?'Trace opening food acquisition and the one-item depletion mismatch.':paused+'Bind food lot, NPC spend and support ticks to one refill cycle.',rows:fleetRows},
  {title:'Collection & gear',metric:input.requirements?`${covered.length}/${supply.length}`:'Unknown',meta:`route inputs · gear ${gearTarget.held}/${gearTarget.total} recent`,level:'OBSERVED',blocker:`${unresolved.length} input IDs unresolved; full collection target undefined; scoring set mapped, combat fit unproved.`,next:unresolved.length?`Resolve ${unresolved[0]!.item} to exact item IDs.`:short.length?`Plan ${num(short[0]!.missing)} ${short[0]!.item}; reserve operating stock first.`:'Define the useful/rare item target set and gear requirements.',rows:collectionRows},
  {title:'Quests · unlocks · 99s',metric:`${maxed.length}/${SKILLS.length} at 99`,meta:`best skill levels · journals ${questFlags.observed}/${bots.length}`,level:'MIXED',blocker:`${questFlags.observed}/${bots.length} account journals observed; live guild unproved. ${sourceQP.length?'Reward extract omits '+Math.max(0,sourceQP.length-input.quests.length)+' rules.':'Quest source unavailable.'}`,next:questFlags.observed?'Review unknown quest flags and blocked unlocks.':'Passive journal capture is ready; keep existing sessions untouched.',rows:questRows},
  {title:'Specialist hiscores',metric:known.length?`${first.length} #1`:'Unknown',meta:`${known.length}/24 recent owned board ranks`,level:'OBSERVED',blocker:'Tie acceptance unverified.',next:contender?`Assess ${contender.best.account} on ${contender.board} (#${contender.best.rank}); plan a matched practice route.`:'Refresh owned rank coverage before choosing a contender.',rows:[row('Candidate by current rank',contender?`${contender.board} · #${contender.best.rank}`:'unknown','hiscore snapshot',contender?.best.at),...rankRows]},
  {title:'Main Overall',metric:overall?.real.slack<0?`${num(-overall.real.slack)} late`:passes===null?'No check':`${passes}/5 checks`,meta:overall?.real.slack<0?'model ticks · not a measured run':'launch checks · not goal completion',level:'MODEL',blocker:`${race?.unmeasured??'?'} unmeasured inputs; staging/rehearsals must pass the gate.`,next:race?.unmeasured?'Plan measurement of the largest unresolved shared-clock input.':'Inspect failed launch checks; keep main offline.',rows:mainRows},
  {title:'Tick efficiency',metric:rate===null?'Unknown':`${num(rate)} c/t`,meta:'saved cash rate · supply costs unallocated',level:'LIVE RECORD',blocker:net.valid?'Cash costs reconciled; opening food cost and full producer time unknown.':'Net-cost allocation incomplete: food lot and support work not linked.',next:net.valid?'Reconcile the opening food lot; keep full net profit unknown.':'Link consumed food to producer spend and courier receipt; exclude owned transfers.',rows:efficiencyRows}
 ];
}
