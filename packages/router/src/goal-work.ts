import {boundAccounts,deadRoots,provisionRefs,type CoordinatorState,type CoordTask} from './coordinator';
import type {OwnerGoals} from './goal-scoreboard';

export interface GoalWorkValue {value:number|null;reason:string;consumers:string[]}
// `loginAfter(account, at)`: a login attempt of the account began after `at`, or that cannot be excluded.
export interface GoalWorkContext {entryOf?:(capability:string)=>string|undefined;loginAfter?:(account:string,at:number)=>boolean}
const key=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
const combat=new Set(['attack','strength','defence','ranged','magic','prayer','hitpoints']);
const pkEntries=new Set(['scripts/pk-hunt.ts','scripts/pk-roam.ts','scripts/pk-army.ts']);
const QP_RECORD_TICKS=73866;
const validTime=(value:unknown,now:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=now;
const fresh=(value:unknown,now:number)=>validTime(value,now)&&now-value<300000;

// This worker reads a fresh bank before funding and refuses a changed baseline. Observation support may dispatch
// that bounded entry without treating unknown stock as an acquired item or relaxing the runtime's admission.
const isGeBuyEntry=(entry:string|undefined)=>entry==='scripts/aio-market.ts'||entry==='scripts/buy-owned-ge-item.ts';

function boundedGeQuantity(task:CoordTask,entry:string|undefined,id:number,target:number):number|null{
 if(!isGeBuyEntry(entry)||id===995||!Number.isSafeInteger(task.timeoutMs)||!(task.timeoutMs!>0)
  ||Object.keys(task.accept?.bank??{}).length!==1)return null;
 const env=task.env??{},item=Number(env.ITEM_ID),quantity=Number(env.QUANTITY),owned=Number(env.EXPECTED_OWNED??0),price=Number(env.LIMIT_PRICE),reserve=Number(env.CASH_RESERVE),period=Number(env.ORDER_MS);
 if(item!==id||![quantity,price].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(owned)||owned<0
  ||!Number.isSafeInteger(reserve)||reserve<0||!Number.isSafeInteger(period)||period<=1||period>task.timeoutMs!
  ||quantity*price>2147483647||owned+quantity!==target)return null;
 return quantity;
}

const isInspectEntry=(task:CoordTask,entry:string|undefined):boolean=>
 entry==='scripts/aio-logistics.ts'&&(!task.args?.length||(task.args.length===1&&task.args[0]==='inspect'));
export function boundedBankObserver(task:CoordTask,entry:string|undefined):boolean{
 return isInspectEntry(task,entry)&&task.env?.REQUIRE_BANK==='1'
  &&Number.isSafeInteger(task.timeoutMs)&&task.timeoutMs!>0&&task.timeoutMs!<=120000
  &&Object.keys(task.accept??{}).length===1&&Object.keys(task.accept?.counters??{}).length===1
  &&task.accept?.counters?.bankObserved===1;
}
export function boundedSkillsObserver(task:CoordTask,entry:string|undefined):boolean{
 return isInspectEntry(task,entry)&&task.env?.REQUIRE_BANK==='0'&&task.env.LOOT_WATCH==='0'&&task.env.RANDOM_EVENTS==='0'
  &&Number.isSafeInteger(task.timeoutMs)&&task.timeoutMs!>0&&task.timeoutMs!<=120000
  &&Object.keys(task.accept??{}).length===1&&Object.keys(task.accept?.skills??{}).length===1&&task.accept?.skills?.Hitpoints===1;
}

/** Estimate useful effects. A null value requires an observation before a run can claim the effect. */
export function goalWork(state:CoordinatorState,goals:OwnerGoals,statuses:readonly any[],now:number,context:GoalWorkContext={}):Map<string,GoalWorkValue>{
 const observations=new Map<string,any>();
 for(const row of statuses){
  if(typeof row?.name!=='string'||row.practice||row.server!=='rs-sdk-demo.fly.dev'||!validTime(row.at,now))continue;
  const name=key(row.name),old=observations.get(name);
  if(!old||row.at>old.at)observations.set(name,row);
 }
 // The last bank read is known for 5 minutes. After the session ended (a result in its status row) it stays known until a
 // newer login attempt of the account begins (context.loginAfter): a closed account's bank does not change, and an
 // inspection login would only read what is here already.
 const bankKnown=(account:string)=>{
  const own=observations.get(key(account));
  if(!own||!Array.isArray(own.bank)||!validTime(own.bankAt,now)||!(own.bankAt<=own.at))return false;
  if(fresh(own.bankAt,now))return true;
  return !!own.result&&context.loginAfter?.(account,own.bankAt)===false;
 };
 const supplyLines=(id:number)=>goals.collection.missing.filter(line=>line.id===id&&line.consumer.trim()&&line.consumer!=='unresolved named supply'&&line.need>line.owned);
 const termsByTask=new Map<string,Map<string,number>>();
 const direct=(task:CoordTask):GoalWorkValue=>{
  const terms=new Map<string,number>();termsByTask.set(task.id,terms);
  if(task.sessionRecovery){terms.set('recovery:'+key(task.sessionRecovery.account),.01);return{value:.01,reason:'Explicit session recovery supports the owned job. This is not game progress.',consumers:[task.id]};}
  const names=boundAccounts(task,state),account=names?.[task.acceptIndex??0];
  let entry:string|undefined;try{entry=task.capability&&context.entryOf?.(task.capability);}catch{/* An unreadable entry cannot prove the worker's role. */}
  // An inspection does not produce the stock, levels or quests named by an acceptance condition.
  if(isInspectEntry(task,entry))return{value:0,reason:'Bank inspection observes existing state. This is not game progress.',consumers:[task.id]};
  const effects:string[]=[],unknown:string[]=[];
  let value=0;
  const credit=(id:string,gain:number)=>{const prior=terms.get(id)??0;if(gain>prior){terms.set(id,gain);value+=gain-prior;}};
  const remaining=new Set(goals.quests.remaining.map(key));
  const preCheckOwn=account?observations.get(key(account)):undefined;
  const rawPlaytime=[preCheckOwn?.playtimeTicks,preCheckOwn?.playtime,...(Array.isArray(preCheckOwn?.ranks)?preCheckOwn.ranks.map((r:any)=>r?.ticks):[])]
   .find((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0);
  const lowPlaytimeQp=rawPlaytime!==undefined&&rawPlaytime<QP_RECORD_TICKS;
  const rawJournal=Array.isArray(preCheckOwn?.questJournal)?preCheckOwn.questJournal:Array.isArray(preCheckOwn?.quests)?preCheckOwn.quests:null;
  const ownQuestState=(quest:string)=>{
   if(!rawJournal?.length)return undefined;
   const hit=rawJournal.find((q:any)=>key(typeof q==='string'?q:q?.name??'')===key(quest));
   if(!hit)return undefined;
   return typeof hit==='string'?'complete':hit.state;
  };
  for(const quest of new Set(task.accept?.quests??[])){
   if(remaining.has(key(quest))){credit('quest:'+key(quest),1);effects.push('quest '+quest);}
   else if(account&&lowPlaytimeQp){
    const state=ownQuestState(quest);
    if(state==='not started'||state==='started'){
     credit('quest:'+key(account)+':'+key(quest),1);
     effects.push('Quest Points race '+account+' ('+rawPlaytime+'t < '+QP_RECORD_TICKS+'t): '+quest);
    }
   }
  }
  if(!account)return{value:value>0?value:null,reason:effects.join(' ')||'Observe the bound account before selecting its goal effect.',consumers:[task.id]};
  const own=preCheckOwn;
  if(entry&&pkEntries.has(entry)&&task.timeoutMs!==undefined&&task.timeoutMs>0&&task.timeoutMs<=1800000
   &&names!.every(name=>goals.army.roster.some(member=>key(member)===key(name)))){
   credit('pk-proof:'+key(account),.01);effects.push('Bounded army PK proof supports the player-kill and Wilderness goals. The result remains unproved.');
  }
  const army=goals.army.accounts.find(row=>key(row.account)===key(account));
  for(const [skill,target] of Object.entries(task.accept?.skills??{})){
   if(!combat.has(key(skill))||!army||!goals.army.roster.some(name=>key(name)===key(account)))continue;
   const observed=Object.entries(army.levels).find(([name])=>key(name)===key(skill))?.[1];
   if(observed===null||observed===undefined){unknown.push(account+' '+skill+' level');continue;}
   const gain=Math.max(0,Math.min(99,target)-observed)/98;
   if(gain){credit('army:'+key(account)+':'+key(skill),gain);effects.push('army '+account+' '+skill+' '+observed+' to '+Math.min(99,target));}
  }
  const holdings=(rows:any[])=>rows.reduce((total,row)=>{
   const id=row?.baseId??row?.id,count=row?.count;
   if(Number.isSafeInteger(id)&&Number.isSafeInteger(count)&&count>0)total.set(id,(total.get(id)??0)+count);
   return total;
  },new Map<number,number>());
  const held=bankKnown(account)?holdings(own.bank):null;
  const runiteTarget=Number(task.accept?.bank?.[451]??task.accept?.bank?.['451']);
  if(entry==='scripts/lava-maze-escorted-ore.ts'&&names?.length===2
   &&task.timeoutMs!==undefined&&Number.isSafeInteger(task.timeoutMs)&&task.timeoutMs>0&&task.timeoutMs<=1800000
   &&Number.isSafeInteger(runiteTarget)&&runiteTarget>0&&(task.env?.MAX_ORE===undefined||Number(task.env.MAX_ORE)===1)){
   const rawExpected=task.env?.EXPECTED_BANK_ORE;
   const expected=rawExpected!==undefined?Number(rawExpected):undefined;
   const validExpected=expected!==undefined&&Number.isSafeInteger(expected)&&expected>=0;
   const advancesKnown=held!==null&&runiteTarget>(held.get(451)??0)&&(expected===undefined||(validExpected&&runiteTarget===expected+1));
   const advancesExpected=held===null&&validExpected&&runiteTarget===expected+1;
   if(advancesKnown||advancesExpected){
    credit('runite-board:'+key(account)+':451:'+runiteTarget,.01);
    effects.push('Bounded Lava Maze Runite trip for '+account+' targets '+runiteTarget+' ore.');
   }else if(held===null&&rawExpected===undefined){
    unknown.push(account+' holdings of item 451');
   }
  }
  for(const [idText,target] of Object.entries(task.accept?.bank??{})){
   const id=Number(idText);
   if(!Number.isSafeInteger(id))continue;
   const lines=supplyLines(id);
   if(!lines.length)continue;
   if(names?.length===1&&(!held||lines.some(line=>(line.verifyOwned??0)>0))&&(!held||target>(held.get(id)??0))){
    const quantity=boundedGeQuantity(task,entry,id,target);
    const line=quantity===null?undefined:lines.find(line=>quantity<=Math.max(0,line.need-line.owned-(line.verifyOwned??0)));
    if(line){
     credit('supply-observation:'+line.consumer+':'+id+':'+line.need,.01);
     effects.push('Bounded GE observation supports '+line.consumer+' for item '+id+'. This is not game progress.');
    }
   }
   if(!held){unknown.push(account+' holdings of item '+id);continue;}
   let available=Math.max(0,target-(held.get(id)??0));
   for(const line of lines){
    const unverified=Math.max(0,line.verifyOwned??0),room=Math.max(0,line.need-line.owned-unverified);
    if(unverified>0){
     unknown.push('previously observed '+line.item+' for '+line.consumer+' before replacing that stock');
     // Reserve uncertain holdings. A finite new batch may fill only the shortage beyond that reserve.
     if(isGeBuyEntry(entry)||available>room)continue;
    }
    const gain=Math.min(available,room);
    if(gain>0){credit('supply:'+line.consumer+':'+id+':'+line.need,gain/line.need);available-=gain;effects.push(gain+' '+line.item+' for '+line.consumer);}
   }
  }
  const skillEffects=Object.entries(task.accept?.skills??{});
  const prep=(label:string,skill?:string)=>{
   for(const [name,target] of skillEffects){
    if(skill&&key(name)!==key(skill))continue;
    const observed=own?.skills?.find((row:any)=>key(row.name??'')===key(name))?.level;
    const gain=typeof observed==='number'?Math.max(0,Math.min(99,target)-observed)/98:Math.max(0,Math.min(99,target)-1)/98;
    if(gain){credit('preparation:'+label+':'+key(account)+':'+key(name),gain);effects.push(label+' '+name+' preparation. Rank remains unproved.');}
   }
  };
  if(task.goal==='main24'&&key(account)==='haggis'&&!goals.main.rank1)prep('main Overall');
  if(task.goal==='specialists')for(const target of goals.specialists.targets){
   if(key(target.account)!==key(account)||target.rank1||target.marginTicks===null||target.marginTicks<=0)continue;
   prep('priced specialist '+target.board,target.board);
  }
  return{value:value>0?value:unknown.length?null:0,
   reason:[...effects,...unknown.map(item=>'Observe '+item+'.')].join(' ')||'The accepted effect does not move an unresolved owner goal.',consumers:[task.id]};
 };
 const result=new Map<string,GoalWorkValue>(),dead=deadRoots(state);
 const open=state.tasks.filter(row=>row.status==='pending'),byId=new Map(open.map(row=>[row.spec.id,row.spec]));
 const consumers=new Map<string,Map<string,GoalWorkValue>>();
 for(const row of open){
  if(row.spec.kind!=='run'||dead.has(row.spec.id))continue;
  const effect=direct(row.spec),seen=new Set<string>(),visit=[row.spec.id];
  result.set(row.spec.id,effect);
  while(visit.length){
   const id=visit.pop()!,task=byId.get(id);
   if(!task||seen.has(id))continue;
   seen.add(id);
   const inherited=consumers.get(id)??new Map<string,GoalWorkValue>();
   inherited.set(row.spec.id,effect);consumers.set(id,inherited);
   visit.push(...task.dependsOn,...provisionRefs(task));
  }
 }
 // A bounded input purchase or strict bank inspection observes its pending consumer's bank. Credit only the
 // observing entry and its non-run prerequisites; ordinary workers still need fresh bank evidence to dispatch.
 const observationTerms=new Map<string,string>(),inspections=new Set<string>();
 for(const row of open){
  const task=row.spec,names=boundAccounts(task,state),effect=result.get(task.id),order=Object.entries(task.accept?.bank??{})[0];
  if(task.kind!=='run'||dead.has(task.id)||names?.length!==1||!effect||(effect.value??0)>0)continue;
  let entry:string|undefined;
  try{entry=task.capability&&context.entryOf?.(task.capability);}catch{/* Unknown workers cannot observe a bank. */}
  const skillsObserver=boundedSkillsObserver(task,entry);
  if(skillsObserver)inspections.add(task.id);
  const observer=boundedBankObserver(task,entry),id=Number(order?.[0]);
  if(!skillsObserver&&!observer&&(!order||!Number.isSafeInteger(id)||id<=0||boundedGeQuantity(task,entry,id,order[1])===null))continue;
  for(const consumerId of consumers.get(task.id)?.keys()??[]){
   const consumer=byId.get(consumerId),accounts=consumer&&boundAccounts(consumer,state);
   if(consumerId===task.id||!consumer||accounts?.length!==1||key(accounts[0]!)!==key(names[0]!))continue;
   if(skillsObserver){
    const own=observations.get(key(accounts[0]!)),skills=Object.keys(consumer.accept?.skills??{}),value=result.get(consumerId)?.value;
    const known=own&&fresh(own.at,now)&&Array.isArray(own.skills)&&own.skills.length>0&&skills.every(skill=>own.skills.some((row:any)=>key(row.name??'')===key(skill)&&Number.isSafeInteger(row.level)&&row.level>=1&&row.level<=99&&Number.isFinite(row.xp)&&row.xp>=0));
    const namedUnknown=value===null&&goals.army.roster.some(name=>key(name)===key(accounts[0]!))&&skills.some(skill=>combat.has(key(skill)));
    if(known||!((value??0)>0||namedUnknown))continue;
    const term='skills-observation:'+key(accounts[0]!)+':'+consumerId;
    termsByTask.get(task.id)!.set(term,.01);observationTerms.set(task.id,term);effect.value=.01;
    effect.reason='Bounded owned skill observation supports '+consumerId+'. This is not game progress.';break;
   }
   if(observer&&Object.keys(consumer.accept?.skills??{}).length===1&&(result.get(consumerId)?.value??0)>0){
    const own=observations.get(key(accounts[0]!));if(bankKnown(accounts[0]!)&&own?.equipmentObserved===true)continue;
    const term='entry-observation:'+key(accounts[0]!)+':'+consumerId;
    termsByTask.get(task.id)!.set(term,.01);observationTerms.set(task.id,term);inspections.add(task.id);effect.value=.01;
    effect.reason='Bounded owned bank and kit observation supports '+consumerId+'. This is not game progress.';break;
   }
   if(bankKnown(accounts[0]!)||result.get(consumerId)?.value!==null)continue;
   const line=Object.entries(consumer.accept?.bank??{}).flatMap(([goalId,quantity])=>{
    const item=Number(goalId);
    return item>0&&item!==995&&Number.isSafeInteger(item)&&Number.isSafeInteger(quantity)&&quantity>0
     ?supplyLines(item).filter(line=>{
      const room=Math.max(0,line.need-line.owned-(line.verifyOwned??0));
      // A read-only refresh may observe stock already included in the consumer's absolute bank target.
      return room>0&&quantity<=(observer?line.need:room);
     }):[];
   })[0];
   if(!line)continue;
   const term='supply-observation:'+line.consumer+':'+line.id+':'+line.need;
   termsByTask.get(task.id)!.set(term,.01);observationTerms.set(task.id,term);
   effect.value=.01;effect.reason=(observer?'Bounded bank observation':'Bounded GE input observation')+' supports '+consumerId+' for '+line.consumer+' item '+line.id+'. This is not game progress.';
   break;
  }
 }
 for(const row of state.tasks){
  const directEffect=result.get(row.spec.id);
  const inherited=consumers.get(row.spec.id),terms=new Map<string,number>();
  for(const id of inherited?.keys()??[])for(const [effect,gain] of termsByTask.get(id)??[]){
   if(inspections.has(row.spec.id)&&row.spec.id!==id)continue;
   if(row.spec.kind==='run'&&row.spec.id!==id&&observationTerms.get(id)===effect)continue;
   terms.set(effect,Math.max(terms.get(effect)??0,gain));
  }
  const value=[...terms.values()].reduce((sum,gain)=>sum+gain,0);
  result.set(row.spec.id,{value:value>0?value:[...(inherited?.values()??[])].some(effect=>effect.value===null)?null:0,
   reason:inherited?.size===1&&inherited.has(row.spec.id)?directEffect!.reason:inherited?.size?'Supports finite consumers: '+[...inherited.keys()].join(', ')+'. '+[...inherited.values()].map(effect=>effect.reason).join(' '):'No viable pending run connects this task to an owner goal.',
   consumers:[...(inherited?.keys()??[])].sort()});
 }
 return result;
}

/** Score a rule proposal before its missing source refresh enters the queue with the run. */
export function ruleGoalValue(state:CoordinatorState,goals:OwnerGoals,statuses:readonly any[],now:number,context:GoalWorkContext={}):(task:CoordTask)=>GoalWorkValue{
 return task=>{
  const records=new Map(state.tasks.map(row=>[row.spec.id,row]));
  const refusal=(reason:string):GoalWorkValue=>({value:0,reason,consumers:[]});
  if(records.has(task.id))return refusal('The proposed rule task already exists.');
  const allowed=task.kind==='run'&&task.rule==='next-band'&&task.capability;
  const dependsOn:string[]=[];
  for(const id of task.dependsOn){
   const dependency=records.get(id);
   if(!dependency&&allowed&&id.startsWith('refresh-'+task.capability+'-'))continue;
   if(!dependency||dependency.status==='failed'||dependency.status==='superseded')return refusal('The rule requires a viable dependency: '+id+'.');
   dependsOn.push(id);
  }
  const candidate:CoordinatorState={...state,tasks:[...state.tasks,{spec:{...task,dependsOn},status:'pending',createdAt:now,attempts:0}]};
  return goalWork(candidate,goals,statuses,now,context).get(task.id)??refusal('The rule has no viable goal effect.');
 };
}
