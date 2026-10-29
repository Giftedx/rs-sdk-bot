import type {GoalRow} from './goals';
import {createHash} from 'node:crypto';

export const COST_RECEIPTS={
 upstreamSource:'.practice/recovery-20261025/courier-return/before.json',
 upstreamLog:'.practice/net-costs/upstream-courier.json',
 fundingSource:'.practice/joined-plan/funding-source.json',
 funding:'.practice/joined-plan/funding-native-proof.json',
 foodSource:'.practice/joined-plan/delivery-source.json',
 foodDelivery:'.practice/joined-plan/delivery-native-proof.json',
 batchSource:'.practice/joined-plan/batch-source.json',
 firstProduction:'.practice/joined-plan/production-completed-batch.json',
 hostProduction:'.practice/joined-plan/host-production-completed.json',
 foodStock:'.practice/joined-plan/food-loop-stock-review.json',
};
const root='.practice/joined-plan/';
const count=(s:any,ids:number[])=>[...s.inventory,...s.bank].filter(i=>ids.includes(i.baseId??i.id)).reduce((n,i)=>n+i.count,0);
const n=(x:number)=>x.toLocaleString('en-US');

// A bounded historical cash reconciliation, not a valuation of opening food stock.
// Each production gain must agree with BOTH its raw RESULT and account cash delta.
export function netCosts(r:Record<string,any>,owned:Set<string>,now:number){
 const rows:GoalRow[]=[];
 const row=(label:string,value:string,source:string,at?:number)=>rows.push({label,value,source,at});
 const need=(ok:unknown,why:string):void=>{if(!ok)throw Error(why);};
 const date=(v:any)=>Number.isFinite(v)&&v>0&&v<=now;
 const snapshot=(s:any)=>{
  need(s&&typeof s.name==='string'&&owned.has(s.name.toLowerCase())&&s.server==='rs-sdk-demo.fly.dev'&&date(s.at)&&date(s.bankAt)&&s.bankAt<=s.at,'Missing, foreign or undated account snapshot');
  for(const list of [s.inventory,s.bank])need(Array.isArray(list)&&list.every(i=>i&&Number.isSafeInteger(i.baseId??i.id)&&Number.isSafeInteger(i.count)&&i.count>0),'Malformed inventory or bank');
  return s;
 };
 const list=(v:any)=>{need(Array.isArray(v)&&v.length>0,'Missing receipt accounts');const a=v.map(snapshot);need(new Set(a.map((s:any)=>s.name.toLowerCase())).size===a.length,'Duplicate account snapshot');return a;};
 const get=(a:any[],name:string)=>{const s=a.find(s=>s.name===name);need(s,'Missing linked account '+name);return s;};
 const proof=(p:any)=>need(p?.ok===true&&p.result?.ok===true&&!p.timedOut&&!p.failure&&date(p.at),'Missing or failed live delivery/funding receipt');
 try{
  proof(r.funding);proof(r.foodDelivery);proof(r.delivery);
  const opening=list(r.fundingSource),funded=list(r.funding.after),foodSource=list(r.foodSource),delivered=list(r.foodDelivery.after),batchSource=list(r.batchSource),batch=list(r.delivery.after);
  const courier=get(funded,'Bigpackage'),donor=get(funded,'Moneyshot');
  const upstream=snapshot(r.upstreamSource?.source?.Bigpackage),capture=r.upstreamLog;
  need(capture?.name===upstream.name&&capture.server===upstream.server&&capture.at===upstream.at&&capture.started===upstream.started&&Array.isArray(capture.lines)&&capture.lines.every((l:any)=>typeof l==='string'),'Missing upstream courier log binding');
  need(createHash('sha256').update(capture.lines.join('\n')).digest('hex')===capture.source?.sha256,'Upstream log hash mismatch');
  const entry=capture.lines.filter((l:string)=>l.startsWith('FOODCOURIER ')),exit=capture.lines.filter((l:string)=>l.startsWith('RESULT '));
  need(entry.length===1&&exit.length===1&&entry[0].includes('coins=3014 fishNotes=0')&&exit[0].startsWith('RESULT fail ')&&exit[0].includes('received=2150 handed=0 fishNotes=2150 coins=4')&&exit[0].includes('feathersBought=340')&&capture.lines.includes('FUNDING_RECEIPT received=0 reason=sufficient coins=3014'),'Upstream trip scope changed');
  need(upstream.result.startsWith('fail ')&&upstream.counters?.received===2150&&upstream.counters?.coins===4&&upstream.counters?.feathersBought===340,'Failed trip snapshot disagrees');
  const cargoOpening=get(opening,courier.name);
  need(upstream.at<cargoOpening.at&&count(upstream,[995])===4&&count(cargoOpening,[995])===4&&count(upstream,[329,333])===count(cargoOpening,[329,333]),'Upstream cargo/cash does not join funding baseline');
  const upstreamSpend=3014-4;
  need(opening.length===2&&funded.length===2,'Funding scope changed');
  const transfer=count(courier,[995])-count(get(opening,courier.name),[995]);
  need(transfer===5000&&count(get(opening,donor.name),[995])-count(donor,[995])===transfer,'Funding transfer does not cancel');
  const firstCourier=get(delivered,courier.name),lastCourier=get(batch,courier.name);
  for(const [a,b] of [[courier,get(foodSource,courier.name)],[firstCourier,get(batchSource,courier.name)]])need(a.at<=b.at&&count(a,[995])===count(b,[995])&&count(a,[329,333])===count(b,[329,333]),'Courier handoff gap');
  need(courier.at<firstCourier.started&&firstCourier.at<lastCourier.started,'Courier sequence overlaps');
  need(/^ok\b/.test(firstCourier.result)&&/^ok\b/.test(lastCourier.result),'Courier run not completed');
  const fare=count(courier,[995])-count(firstCourier,[995]),batchSpend=count(firstCourier,[995])-count(lastCourier,[995]);
  need(fare===60&&batchSpend===0&&firstCourier.counters?.feathersBought===0&&lastCourier.counters?.feathersBought===0,'Courier cash or purchase scope changed');
  const single=r.foodDelivery.result.result?.incoming,group=r.delivery.result.results;
  need(single===159&&Array.isArray(group)&&group.length===4&&new Set(group.map((x:any)=>x?.name)).size===4,'Delivery quantities unavailable');
  const incoming=single+group.reduce((sum:number,x:any)=>{need(x&&x.result?.incoming===159,'Batch quantity changed');return sum+x.result.incoming;},0);
  need(count(courier,[329,333])-count(lastCourier,[329,333])===incoming,'Courier cargo delta disagrees');
  const first=snapshot(r.firstProduction?.status),second=snapshot(r.production?.status),host=list(r.hostProduction?.states);
  need(first.name==='Pocketrocket'&&second.name===first.name&&host.length===4,'Production scope changed');
  const startSingle=get(delivered,first.name),starts=host.map((s:any)=>get(batch,s.name));
  need(count(startSingle,[329,333])-count(get(foodSource,first.name),[329,333])===single,'Single recipient food mismatch');
  for(const s of starts)need(group.some((x:any)=>x.name===s.name)&&count(s,[329,333])-count(get(batchSource,s.name),[329,333])===159,'Batch recipient food mismatch');
  // Preserve item identity through each saved handoff, not only total fish.
  for(const id of [329,333]){
   const singleGain=count(startSingle,[id])-count(get(foodSource,first.name),[id]);
   need(singleGain>=0&&count(get(foodSource,courier.name),[id])-count(firstCourier,[id])===singleGain,'Single delivery item mismatch');
   const gains=starts.map(s=>count(s,[id])-count(get(batchSource,s.name),[id]));
   need(gains.every(g=>g>=0)&&count(get(batchSource,courier.name),[id])-count(lastCourier,[id])===gains.reduce((a,b)=>a+b,0),'Batch delivery item mismatch');
   for(const [a,b] of [[upstream,cargoOpening],[courier,get(foodSource,courier.name)],[firstCourier,get(batchSource,courier.name)]])
    need(count(a,[id])===count(b,[id]),'Food item identity changed between receipts');
  }
  let earned=0,eaten=0,ticks=0;
  const foodGaps:{name:string;started:number;depleted:number;events:number}[]=[];
  const sessions=new Set<string>();
  for(const [receipt,end,start,source,hosted] of [[r.firstProduction,first,startSingle,'production-completed-batch.json',false],[r.production,second,first,'production-repeat-completed.json',false],...host.map((s:any)=>[r.hostProduction,s,get(batch,s.name),'host-production-completed.json',true])] as any[]){
   need(date(receipt.at)&&receipt.at>=end.at&&date(end.started)&&end.started>start.at&&end.at>end.started,'Production dates overlap or are invalid');
   const key=end.name+':'+end.started;need(!sessions.has(key),'Duplicate production session');sessions.add(key);
   const prefix=hosted?`[${end.name}] `:'';
   const logs=receipt.logTail;need(Array.isArray(logs)&&logs.includes(prefix+'LOGOUT logged-out'),'Missing production logout');
   const results=logs.filter((l:any)=>typeof l==='string'&&l.startsWith(prefix+'RESULT '));need(results.length===1&&results[0].startsWith(prefix+'RESULT ok '),'Ambiguous or failed production result');
   const pairs=[...results[0].matchAll(/(?:^|\s)(\w+)=(-?\d+)(?=\s|$)/g)].map((m:any)=>[m[1],Number(m[2])]);
   need(new Set(pairs.map((p:any)=>p[0])).size===pairs.length,'Duplicate result counter');
   const counters=Object.fromEntries(pairs);
   for(const k of ['coinsGained','eaten','ticks'])need(Number.isSafeInteger(counters[k])&&counters[k]===end.counters?.[k],'Counter mismatch: '+k);
   need(counters.eaten>=0&&counters.ticks>0&&results[0].includes('died=false')&&/^ok\b/.test(end.result),'Incomplete production run');
   need(count(end,[995])-count(start,[995])===counters.coinsGained,'Cash delta disagrees with new earnings');
   earned+=counters.coinsGained;eaten+=counters.eaten;ticks+=counters.ticks;
   const depleted=count(start,[329,333])-count(end,[329,333]);
   if(depleted!==counters.eaten)foodGaps.push({name:end.name,started:end.started,depleted,events:counters.eaten});
   row(`${end.name}${end===second?' · repeat':''}`,`+${n(counters.coinsGained)} coins · ${depleted} fish / ${counters.eaten} eat events`,root+source,end.at);
  }
  const fishUsed=[startSingle,...starts].reduce((sum,s)=>sum+count(s,[329,333]),0)-[second,...host].reduce((sum,s)=>sum+count(s,[329,333]),0);
  need(fishUsed>=0,'Food stock increased outside delivery scope');
  const recipientOpening=count(get(foodSource,first.name),[329,333])+starts.reduce((sum,s)=>sum+count(get(batchSource,s.name),[329,333]),0);
  const recipientRemaining=[second,...host].reduce((sum,s)=>sum+count(s,[329,333]),0);
  const courierOpening=count(courier,[329,333]),courierRemaining=count(lastCourier,[329,333]);
  need(recipientOpening+incoming===fishUsed+recipientRemaining,'Consumer food balance does not close');
  need(courierOpening===incoming+courierRemaining,'Courier food balance does not close');
  need(courierOpening>=2150,'Collection exceeds opening courier stock');
  // A location is not an acquisition receipt. Only locate the residual when
  // the saved pack independently agrees with the reported collection quantity.
  const packFish=count({...upstream,bank:[]},[329,333]);
  const otherStockLocation=packFish===2150?{location:'bank',items:[329,333].map(id=>({id,quantity:count({...upstream,inventory:[]},[id])})).filter(i=>i.quantity>0)}:null;
  const foodChain={
   evidence:'saved-live-snapshots',production:{quantity:null,acquisitionCost:null,reason:'No matched producer opening inputs, purchases, output and collection debit'},
   collection:{reportedReceived:2150,cookDebit:null,matched:false,unattributedCourierStock:courierOpening-2150,otherStockLocation},
   delivery:{quantity:incoming,courierOpening,courierRemaining,recipientOpening,recipientRemaining,matched:true},
   consumption:{stockDepleted:fishUsed,eatEvents:eaten,unexplainedEvents:foodGaps.reduce((sum,g)=>sum+Math.abs(g.events-g.depleted),0),lotAttributed:false},
   costs:{earned,courierCash:upstreamSpend+fare+batchSpend,collectionTrip:{total:upstreamSpend,supplies:null,travel:null},foodAcquisition:null,producerTicks:null,fullNetProfit:null},
  };
  const net=earned-upstreamSpend-fare-batchSpend,at=Math.max(second.at,...host.map((s:any)=>s.at));
  const sources=Object.values(COST_RECEIPTS).join('; ')+'; '+root+'batch-native-proof.json; '+root+'production-repeat-completed.json';
  rows.unshift({label:'Net cash · saved cohort',value:`${net>=0?'+':''}${n(net)} coins after ${n(upstreamSpend+fare+batchSpend)} known costs`,source:sources,at},{label:'Earnings reconciled',value:`${n(earned)} new coins · 6 completed runs / 5 workers`,source:sources,at});
  row('Owned funding',`${n(transfer)} coins moved · 0 fleet expense`,COST_RECEIPTS.funding,r.funding.at);
  row('Courier cost',`${n(upstreamSpend)} failed collection + ${fare} return + ${batchSpend} handoff`,COST_RECEIPTS.upstreamLog+'; '+COST_RECEIPTS.foodDelivery+'; '+root+'batch-native-proof.json',lastCourier.at);
  row('Food lot',`${incoming} delivered · ${n(count(lastCourier,[329,333]))} courier pack + bank`,COST_RECEIPTS.foodDelivery+'; '+root+'batch-native-proof.json',lastCourier.at);
  row('Food reconciliation',`${fishUsed} fish depleted vs ${eaten} eat events · ${foodGaps.reduce((sum,g)=>sum+Math.abs(g.events-g.depleted),0)} unexplained across ${foodGaps.length} runs`,sources,at);
  row('Measured labour',`${n(ticks)} production actor-ticks; producer time not linked`,sources,at);
  row('Opening food cost','Unknown acquisition cost; not zero and not deducted twice',COST_RECEIPTS.foodSource);
  row('Cash scope','Collection supplies/travel split unknown; full trip charged once; no feather credit',COST_RECEIPTS.upstreamLog);
  row('Cook stock receipt','Later stock / partial logs; no matching acquisition-cost lot',COST_RECEIPTS.foodStock);
  row('Full net profit','Unknown: opening food cost'+(foodGaps.length?' + session depletion mismatch':''),sources);
  row('Food chain · production','Unknown lot: cook inputs, output and acquisition cost not joined',COST_RECEIPTS.foodStock+'; '+COST_RECEIPTS.upstreamLog);
  row('Food chain · collection',`2,150 reported received; ${otherStockLocation?otherStockLocation.items.map(i=>`${i.quantity} ${i.id===329?'salmon':'trout'}`).join(' + ')+' banked':n(foodChain.collection.unattributedCourierStock)+' other stock'} unpriced; cook debit unverified`,COST_RECEIPTS.upstreamLog+'; '+COST_RECEIPTS.upstreamSource,upstream.at);
  row('Food chain · delivery',`${n(courierOpening)} courier stock = ${incoming} delivered + ${n(courierRemaining)} remaining; item deltas matched`,sources,lastCourier.at);
  row('Food chain · consumption',`${n(recipientOpening)} opening + ${incoming} delivered = ${fishUsed} depleted + ${n(recipientRemaining)} remaining; no lot attribution`,sources,at);
  const priority=['Net cash · saved cohort','Earnings reconciled','Courier cost','Owned funding','Food reconciliation','Opening food cost','Full net profit','Food lot','Measured labour'];
  rows.sort((a,b)=>(priority.indexOf(a.label)<0?99:priority.indexOf(a.label))-(priority.indexOf(b.label)<0?99:priority.indexOf(b.label)));
  return {valid:true,net,earned,courierSpend:upstreamSpend+fare+batchSpend,fishUsed,eaten,foodGaps,ticks,foodChain,rows,at};
 }catch(error){return {valid:false,net:null,rows:[{label:'Net cash reconciliation',value:'Unavailable · '+(error instanceof Error?error.message:'invalid receipts'),source:Object.values(COST_RECEIPTS).join('; '),tone:'warn' as const}]};}
}
