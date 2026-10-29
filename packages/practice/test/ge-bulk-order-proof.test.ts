import {test,expect} from 'bun:test';
import {bulkOrderChecks,ORDER} from '../src/ge-bulk-order-proof';
import type {ItemOrder} from '../../../scripts/buy-owned-ge-item';

const save=(bank:{id:number;count:number}[],pack:{id:number;count:number}[]=[])=>({version:9,position:{x:3185,z:3436,level:0},vars:{},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===3?10:1,xp:0,rawExperience:0})),
 inventories:{93:pack.map((item,slot)=>({...item,slot})),94:[],95:bank.map((item,slot)=>({...item,slot}))}});
const request={actor:'gebuyx1',server:'localhost:8888',goal:'native-1',item:ORDER.item,quantity:ORDER.quantity,limit:ORDER.limit,reserve:ORDER.reserve,createdAt:1,reviewAt:2,deadline:3};
const journal:ItemOrder={version:1,request,phase:'settled',coinsBefore:2000,itemsBefore:0,previousIds:[],at:4,offerId:7,acquired:300,refund:600};
const line=(r:object)=>'OWNED_GE_ITEM '+JSON.stringify(r)+'\nLOGOUT logged-out\n';
const input={before:save([{id:995,count:2000}]),after:save([{id:995,count:1100},{id:1987,count:300}]),repeat:save([{id:995,count:1100},{id:1987,count:300}]),journal,
 sell:{code:0,log:'GE_SELL_RESULT {"ok":true,"detail":"x"}\nLOGOUT logged-out\n'},
 buy:{code:0,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,acquired:300,spent:900,phase:'settled',offerId:7})},
 again:{code:0,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,phase:'settled',offerId:7,newItemsThisSession:0,cashDeltaThisSession:0})}};

test('exact banked quantity, bounded spend, kept reserve and resumed rerun pass',()=>{
 expect(bulkOrderChecks(input)).toEqual({entry:true,seller:true,bank:true,assets:true,pack:true,coins:true,journal:true,result:true,logout:true,restart:true,healthy:true});
});
test('a short fill, an overspend or a lost reserve fails the consumer',()=>{
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100},{id:1987,count:299}])}).bank).toBe(false);
 expect(bulkOrderChecks({...input,after:save([{id:995,count:499},{id:1987,count:300}])}).coins).toBe(false);
 expect(bulkOrderChecks({...input,order:{...ORDER,reserve:1200}}).coins).toBe(false);
});
test('banknotes left in the pack are not banked stock',()=>{
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100}],[{id:1988,count:300}])}).bank).toBe(false);
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100},{id:1987,count:300}],[{id:1988,count:1}])}).pack).toBe(false);
});
test('a rerun that places, buys or changes cash again is not a resume',()=>{
 expect(bulkOrderChecks({...input,again:{code:0,log:line({ok:true,phase:'settled',offerId:8,newItemsThisSession:0,cashDeltaThisSession:0})}}).restart).toBe(false);
 expect(bulkOrderChecks({...input,again:{code:0,log:line({ok:true,phase:'settled',offerId:7,newItemsThisSession:300,cashDeltaThisSession:-900})}}).restart).toBe(false);
 expect(bulkOrderChecks({...input,repeat:save([{id:995,count:200},{id:1987,count:600}])}).restart).toBe(false);
});
test('journal must agree with the saved coin delta and the exact quantity',()=>{
 expect(bulkOrderChecks({...input,journal:{...journal,refund:601}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...journal,acquired:299}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:null}).journal).toBe(false);
 expect(bulkOrderChecks({...input,buy:{code:0,log:'LOGOUT logged-out\n'}}).result).toBe(false);
});

test('the receipt must bind the banked result to the journal offer and reserve',()=>{
 expect(bulkOrderChecks({...input,journal:{...journal,coinsBefore:1999}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...journal,request:{...request,reserve:99}}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,buy:{code:0,log:line({ok:true,targetMet:true,conserved:true,acquired:300,spent:900,phase:'open',offerId:7})}}).result).toBe(false);
});

test('rerun must preserve carried assets, health and the observed bank area',()=>{
 expect(bulkOrderChecks({...input,repeat:save([{id:995,count:1100},{id:1987,count:300}],[{id:1,count:1}])}).restart).toBe(false);
 const hurt=save([{id:995,count:1100},{id:1987,count:300}]);hurt.skills[3]!.level=9;
 expect(bulkOrderChecks({...input,repeat:hurt}).healthy).toBe(false);
 const moved={...input.repeat,position:{x:3200,z:3436,level:0}};
 expect(bulkOrderChecks({...input,repeat:moved}).healthy).toBe(false);
});

test('logout text must be a complete confirmation line for each participant',()=>{
 expect(bulkOrderChecks({...input,buy:{...input.buy,log:input.buy.log.replace('LOGOUT logged-out','WARN LOGOUT logged-out failed')}}).logout).toBe(false);
 expect(bulkOrderChecks({...input,sell:{...input.sell,log:'GE_SELL_RESULT {"ok":true}\n'}}).seller).toBe(false);
});

test('saved low HP entry must account for exactly one owned salmon and observed healing',()=>{
 const before=save([{id:995,count:2000},{id:329,count:2}]);before.skills[3]!.level=3;
 const after=save([{id:995,count:1100},{id:1987,count:300},{id:329,count:1}]);
 const p={...input,before,after,repeat:after,buy:{...input.buy,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,acquired:300,spent:900,phase:'settled',offerId:7,foodUsed:[{id:329,count:1}]})}};
 expect(Object.values(bulkOrderChecks(p)).every(Boolean)).toBe(true);
 expect(bulkOrderChecks({...p,after:save([{id:995,count:1100},{id:1987,count:300}])}).assets).toBe(false);
 const hurt={...after,skills:after.skills.map(s=>({...s}))};hurt.skills[3]!.level=3;
 expect(bulkOrderChecks({...p,after:hurt}).healthy).toBe(false);
});

test('the consumer rejects a lost unrelated bank item on either purchase or rerun',()=>{
 const before=save([{id:995,count:2000},{id:1351,count:1}]);
 expect(bulkOrderChecks({...input,before}).assets).toBe(false);
 const after=save([{id:995,count:1100},{id:1987,count:300},{id:1351,count:1}]);
 expect(bulkOrderChecks({...input,before,after}).assets).toBe(false);
});


test('saved exact output accepts cumulative recovery receipts and rejects a reused offer',()=>{
 const recovered:ItemOrder={...journal,rounds:[{offerId:6,quantity:300,acquired:120,refund:1140}],
  progress:{actor:request.actor,server:request.server,offerId:7,itemId:1987,side:'buy',quantity:180,limit:5,filled:180,gross:540,tax:0,at:4}};
 expect(Object.values(bulkOrderChecks({...input,journal:recovered})).every(Boolean)).toBe(true);
 expect(bulkOrderChecks({...input,journal:{...recovered,rounds:[{...recovered.rounds![0]!,offerId:7}]}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...recovered,progress:{...recovered.progress!,quantity:300}}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...recovered,progress:{...recovered.progress!,gross:539}}}).journal).toBe(false);
});
