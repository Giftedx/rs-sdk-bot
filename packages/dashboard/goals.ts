import { COST_RECEIPTS,netCosts } from './net-costs';
import { gearProgress,questProgress,batchCosts } from './goal-details';
import { SKILLS } from '../planner/src/haggis';
import { xpForLevel } from '../planner/src/curve';

// The joined plan owns goal wording and pause state. Metrics remain separate observations.
const CORE_LANES = ['Main Overall', 'Coverage', 'Specialist hiscores', 'Wealth / logistics / GE', 'Gear / collection', 'Efficiency / visibility'];
export function goalPlan(text: string) {
    const section = text.split(/^## (?:Lanes|Goals and next evidence(?: after resume)?)[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ?? '';
    // Columns come from the header row (Lane, Owner, Target, Next), so the table may add a column.
    const rows = section.split('\n').filter(line => /^\|[^-]/.test(line)).map(line => line.split('|').slice(1, -1).map(v => v.trim()));
    const head = (rows[0] ?? []).map(h => h.toLowerCase()), col = (name: string) => head.indexOf(name);
    const at = { title: col('lane'), owner: col('owner'), target: col('target'), next: col('next') };
    const lanes = rows.slice(1).map(r => ({ title: r[at.title] ?? '', target: r[at.target] ?? '', next: r[at.next] ?? '', ...(at.owner >= 0 ? { owner: r[at.owner] ?? '' } : {}) }))
        .filter(row => row.title && row.target && row.next);
    // The six core lanes must all be there; a plan may add more (Autopilot).
    const titles = new Set(lanes.map(l => l.title));
    return { paused: /\*\*Execution paused by the user/.test(text), available: at.title >= 0 && at.target >= 0 && at.next >= 0 && CORE_LANES.every(t => titles.has(t)), lanes };
}

export type GoalRow = { label:string; value:string; at?:number; source:string; tone?:'warn'|'good'|'dm' };
type Lane = { title:string; metric:string; meta:string; level:string; blocker:string; next:string; rows:GoalRow[] };
export type GoalInputs = { requirements:{item:string;count:number}[]|null; items:any[]; quests:any[]; questConstants:string; receipts:Record<string,any> };
const validAt=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now;
const fresh=(at:any,now:number,limit=300000)=>validAt(at,now)&&now-at<limit;
const nameKey=(s:string)=>s.trim().toLowerCase().replace(/\s*\(noted\)$/,'').replace(/^feathers$/,'feather').replace(/^headless arrows$/,'headless arrow');
const boardKey=(s:string)=>s.toLowerCase().replace(/^lava maze /,'').replace(/[^a-z]/g,'');
const num=(v:number)=>Number.isFinite(v)?Number(v.toFixed(2)).toLocaleString('en-US'):'?';
// Pinned catalog debug names distinguish tutorial/fake items and unstrung bows.
const supplyAliases:Record<string,string>={'pot of flour':'pot_flour','raw shrimps':'raw_shrimp',coins:'coins',logs:'logs','magic shortbow':'magic_shortbow','yew shortbow':'yew_shortbow','anti-dragon shield (quest)':'antidragonbreathshield',...Object.fromEntries(['guam','harralander','ranarr','irit','avantoe','kwuarm'].map(h=>[h+' potion (unf)',h+'vial']))};
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

// Pure, read-only projection. Historical receipts never become current staging or live promotion.
export function goalProgress(state:any,input:GoalInputs):Lane[]{
 input={...input,items:Array.isArray(input.items)?input.items:[],quests:Array.isArray(input.quests)?input.quests:[],questConstants:typeof input.questConstants==='string'?input.questConstants:'',receipts:input.receipts??{}};
 const now=state.now,bots=(state.bots??[]).filter((b:any)=>!b.practice&&!b.reserved&&b.server==='rs-sdk-demo.fly.dev'),owned=new Set(bots.map((b:any)=>b.name.toLowerCase()));
 const row=(label:string,value:unknown,source:string,at?:number,tone?:GoalRow['tone']):GoalRow=>({label,value:String(value),source,...(validAt(at,now)?{at}:{}),tone});
 const statusPath=(b:any)=>`.practice/status/${b.name}.json`;
 const snapshotBots=bots.filter((b:any)=>validAt(b.at,now)),banks=bots.filter((b:any)=>validAt(b.bankAt,now)&&Array.isArray(b.bank)&&b.bank.every((i:any)=>Number.isSafeInteger(i.baseId??i.id)&&Number.isSafeInteger(i.count)&&i.count>0));
 const catalog=new Map<string,any[]>();for(const i of input.items){if(!i||typeof i.name!=='string'||!Number.isSafeInteger(i.id))continue;const k=nameKey(i.name);catalog.set(k,[...(catalog.get(k)??[]),i]);}
 const supply=(input.requirements??[]).map(r=>{
  const key=nameKey(r.item),alias=supplyAliases[key],matches=alias?input.items.filter(i=>i?.debugname===alias):(catalog.get(key)??[]),id=matches.length===1&&Number.isSafeInteger(matches[0].id)?matches[0].id:null;
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
 const collectionRows=[...gearTarget.rows,row('Route inputs covered',input.requirements?`${covered.length}/${supply.length} by recent banks`:'Model unavailable','packages/planner/src/haggis-boards.json'),row('Unresolved input IDs',unresolved.length,'knowledge/items.json',undefined,unresolved.length?'warn':'dm'),row('Bank observations',`${banks.filter((b:any)=>fresh(b.bankAt,now)).length} recent · ${banks.length} known / ${bots.length} owned`,'.practice/status'),row('Gear snapshots',`${gear.length}/${bots.length} accounts · ${gear.filter((b:any)=>fresh(b.at,now)).length} recent`,'.practice/status'),...supply.map(s=>row(s.item,s.id===null?'ID unresolved':`${num(s.recent)}/${num(s.count)} recent · ${num(s.old)} old`,'packages/planner/src/haggis-boards.json; '+s.holders.map((h:any)=>`.practice/status/${h.name}.json`).join(', '),s.holders.length?Math.min(...s.holders.map((h:any)=>h.at)):undefined,s.id===null||s.missing>0?'warn':'good')),...gear.map((b:any)=>row(`${b.name} gear`,b.equipment.map((i:any)=>i.name).join(', ')||'observed empty',statusPath(b),b.at)),row('Useful / rare target set','Undefined; route inputs are only a subset','docs/plans/joined-plan.md',undefined,'warn')];
 const sourceQP=[...input.questConstants.matchAll(/^\^(\w+)_questpoints\s*=\s*(\d+)/gm)],maxQP=sourceQP.reduce((n,m)=>n+Number(m[2]),0),parsedQP=input.quests.reduce((n,q)=>n+(Number(q?.questPoints)||0),0);
 const skillRows=SKILLS.map(skill=>{const candidates=snapshotBots.flatMap((b:any)=>(b.skills??[]).filter((s:any)=>s.name?.toLowerCase()===skill&&Number.isFinite(s.level)&&Number.isFinite(s.xp)).map((s:any)=>({...s,account:b.name,at:b.at}))).sort((a:any,b:any)=>b.level-a.level||b.xp-a.xp);return {skill,best:candidates[0]};});
 const maxed=skillRows.filter(s=>s.best?.level>=99),pairs=snapshotBots.reduce((n:number,b:any)=>n+(b.skills??[]).filter((s:any)=>SKILLS.includes(s.name?.toLowerCase())&&s.level>=99).length,0);

 const qp=bots.flatMap((b:any)=>(b.ranks??[]).filter((q:any)=>q.board==='Quest Points'&&validAt(b.ranksAt,now)&&Number.isFinite(q.level)).map((q:any)=>({name:b.name,points:q.level,at:b.ranksAt})));
 const a=r.apron,g=r.guildPractice,gl=r.guildLive;
 const apronOK=validAt(a?.at,now)&&a.ok===true&&a.assetCheck===true&&a.code===0&&a.after?.server==='rs-sdk-demo.fly.dev'&&owned.has(String(a.after?.name).toLowerCase())&&Array.isArray(a.result?.bank?.items)&&a.result.bank.items.some((i:any)=>i&&i.id===1757&&i.count>0);
 const practiceOK=g?.ok===true&&g.code===0&&g.assetCheck===true&&g.result?.gained>0&&validAt(g.result?.bankAfter?.at,now);
 const liveGuild=validAt(gl?.at,now)&&gl.ok===false?'failed / stopped':'unproved';
 const questRows=[...questFlags.rows.slice(0,2),row('Reward extract',`${input.quests.length}/${sourceQP.length||'?'} · ${parsedQP}/${maxQP||'?'} QP`,'knowledge/quests.json; vendor/rs-sdk/server/content/scripts/general/configs/quest.constant',undefined,input.quests.length!==sourceQP.length?'warn':'dm'),row('Rune Mysteries · live',r.rune?.ok===false&&validAt(r.rune?.status?.at,now)?r.rune.status.result:'No accepted completion',GOAL_RECEIPTS.rune,r.rune?.status?.at,'warn'),...questFlags.rows.slice(2),...qp.map((q:any)=>row(`${q.name} recorded QP`,`${q.points}/${maxQP||'?'} · not a quest census`,'hiscore snapshot',q.at)),row('99s observed',`${pairs} skill-account pairs · ${maxed.length}/${SKILLS.length} skill types`,'.practice/status'),row('Brown apron',apronOK?'acquired + banked live':'unproved',GOAL_RECEIPTS.apron,a?.at,apronOK?'good':'warn'),row('Guild chain · practice',practiceOK?`${g.result.gained} ore · cloned inputs`:'unproved',GOAL_RECEIPTS.guildPractice,g?.result?.bankAfter?.at,practiceOK?'good':'warn'),row('Guild chain · live',liveGuild,GOAL_RECEIPTS.guildLive,gl?.at,'warn'),...skillRows.map(s=>row(s.skill,s.best?`${s.best.level}/99 · ${s.best.account} · ${num(Math.max(0,xpForLevel(99)-s.best.xp))} XP left`:'no observation',s.best?`.practice/status/${s.best.account}.json`:'.practice/status',s.best?.at,s.best?.level>=99?'good':'dm'))];
 const specialist=(state.boards??[]).map((b:any)=>{const ranks=bots.flatMap((a:any)=>(a.ranks??[]).filter((x:any)=>boardKey(x.board)===boardKey(b.board)&&fresh(a.ranksAt,now,600000)&&Number.isSafeInteger(x.rank)&&x.rank>0).map((x:any)=>({...x,account:a.name,at:a.ranksAt}))).sort((a:any,b:any)=>a.rank-b.rank);return {board:b.board,best:ranks[0],top:b.top,kind:b.kind};});
 const known=specialist.filter((s:any)=>s.best),first=known.filter((s:any)=>s.best.rank===1),contender=known.filter((s:any)=>s.best.rank>1).sort((a:any,b:any)=>a.best.rank-b.best.rank)[0];
 const rankRows=specialist.map((s:any)=>row(s.board,s.best?`#${s.best.rank} · ${s.best.account} · level ${s.best.level}`:s.kind==='value'?'Owned rank not fetched':'Recent rank missing',s.best?'hiscore snapshot':'packages/dashboard/server.ts',s.best?.at,s.best?'dm':'warn'));
 const race=state.race,overall=race?.rows?.find((x:any)=>x.id==='overall'),gates=state.gates,passes=gates?.valid?gates.gates.filter((g:any)=>g.pass).length:null;
 const mainRows=[row('Overall model',overall?`${num(overall.real.finish)} / ${num(overall.deadline)} ticks`:'unavailable','packages/planner/src/haggis.ts',race?.sourceAt,'warn'),row('Model wins',`${race?.wins??'?'}/24 · not recorded wins`,'packages/planner/src/haggis.ts',race?.sourceAt),row('Unmeasured inputs',race?.unmeasured??'?','packages/planner/src/haggis-boards.json'),row('Route supply coverage',`${covered.length}/${supply.length} recent · not reserved`,'packages/planner/src/haggis-boards.json'),...(gates?.gates??[]).map((g:any)=>row(g.name,g.detail,'.practice/haggis-readiness.json',gates?.at,g.pass?'good':'warn'))];
 const efficiencyRows=[...net.rows,...(net.valid?[]:costs.rows),row('Saved gross coin rate',rate!==null?`${num(rate)} coins / tick`:'unknown',GOAL_RECEIPTS.production,p?.at,rate!==null?'good':'warn'),row('Recorded bank output',productionOK?`${num(banked!)} coins · ${num(ticks!)} ticks`:'unknown',GOAL_RECEIPTS.production,p?.at),...bots.filter((b:any)=>fresh(b.at,now,20000)&&b.operation==='observed'&&b.ledger).map((b:any)=>{const t=Object.values(b.ledger).reduce((n:number,v:any)=>n+(Number(v)||0),0);return row(b.name,t?`${num(100*(b.ledger.idle??0)/t)}% unchanged / ${num(t)} ticks`:'no ledger',statusPath(b),b.at);}),row('Matched comparison','No matched baseline linked in current plan','docs/plans/joined-plan.md',undefined,'warn')];
 return [
  {title:'Fleet & wealth',metric:net.valid?`+${num(net.net!)}`:delivered===null?'No proof':`${num(delivered)} fish`,meta:net.valid?'saved net cash · food cost unknown':matchedDelivery?`${recipients.length} recipients · saved live proof`:'Delivery evidence missing',level:'LIVE RECORD',blocker:net.valid?`Opening food cost unknown; ${Math.abs(net.eaten!-net.fishUsed!)} eat event differs from stock depletion.`:'Net resources counted; food/support costs unallocated; full refill cycle unproved.',next:net.valid?'Trace opening food acquisition and the one-item depletion mismatch.':paused+'Bind food lot, NPC spend and support ticks to one refill cycle.',rows:fleetRows},
  {title:'Collection & gear',metric:input.requirements?`${covered.length}/${supply.length}`:'Unknown',meta:`route inputs · gear ${gearTarget.held}/${gearTarget.total} recent`,level:'OBSERVED',blocker:`${unresolved.length} input IDs unresolved; full collection target undefined; scoring set mapped, combat fit unproved.`,next:unresolved.length?`Resolve ${unresolved[0]!.item} to exact item IDs.`:short.length?`Plan ${num(short[0]!.missing)} ${short[0]!.item}; reserve operating stock first.`:'Define the useful/rare item target set and gear requirements.',rows:collectionRows},
  {title:'Quests · unlocks · 99s',metric:`${maxed.length}/${SKILLS.length} at 99`,meta:`best skill levels · journals ${questFlags.observed}/${bots.length}`,level:'MIXED',blocker:`${questFlags.observed}/${bots.length} account journals observed; live guild unproved. ${sourceQP.length?'Reward extract omits '+Math.max(0,sourceQP.length-input.quests.length)+' rules.':'Quest source unavailable.'}`,next:questFlags.observed?'Review unknown quest flags and blocked unlocks.':'Passive journal capture is ready; keep existing sessions untouched.',rows:questRows},
  {title:'Specialist hiscores',metric:known.length?`${first.length} #1`:'Unknown',meta:`${known.length}/24 recent owned board ranks`,level:'OBSERVED',blocker:'Value-board ownership and tie acceptance unverified.',next:contender?`Assess ${contender.best.account} on ${contender.board} (#${contender.best.rank}); plan a matched practice route.`:'Refresh owned rank coverage before choosing a contender.',rows:[row('Candidate by current rank',contender?`${contender.board} · #${contender.best.rank}`:'unknown','hiscore snapshot',contender?.best.at),...rankRows]},
  {title:'Main · all 24',metric:overall?.real.slack<0?`${num(-overall.real.slack)} late`:passes===null?'No check':`${passes}/5 checks`,meta:overall?.real.slack<0?'model ticks · not a measured run':'launch checks · not goal completion',level:'MODEL',blocker:`${race?.unmeasured??'?'} unmeasured inputs; staging/rehearsals must pass the gate.`,next:race?.unmeasured?'Plan measurement of the largest unresolved shared-clock input.':'Inspect failed launch checks; keep main offline.',rows:mainRows},
  {title:'Tick efficiency',metric:rate===null?'Unknown':`${num(rate)} c/t`,meta:'saved cash rate · supply costs unallocated',level:'LIVE RECORD',blocker:net.valid?'Cash costs reconciled; opening food cost and full producer time unknown.':'Net-cost allocation incomplete: food lot and support work not linked.',next:net.valid?'Reconcile the opening food lot; keep full net profit unknown.':'Link consumed food to producer spend and courier receipt; exclude owned transfers.',rows:efficiencyRows}
 ];
}
