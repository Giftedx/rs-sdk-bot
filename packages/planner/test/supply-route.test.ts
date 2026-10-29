import {expect,test} from 'bun:test';
import {supplyRoute,type SupplyRouteRequest} from '../src/supply-route';
import {resolve,leg,type TravelModel} from '../src/travel';
import {goalRequirementsFor,suppliesFor,type Activity} from '../src/haggis';

export const model:TravelModel={places:{start:{x:0,z:0},target:{x:10,z:0}},cache:{nearestBank:{},banks:{near:{x:0,z:2},through:{x:4,z:0}},legs:{}}};
const cost={coins:30,food:1,accessible:true};
export const request=():SupplyRouteRequest=>({from:'start',to:'target',count:10,capacity:10,budget:{coins:120,food:3},stops:['near','through'].map(bank=>({holder:bank,bank,available:10,reserved:0,outbound:cost,onward:cost}))});
test('whole trip beats nearest-bank selection with the same stock and costs',()=>{
 const nearest=resolve(model,'start','bank');
 const baseline=leg(model,'start',nearest).ticks+leg(model,nearest,'target').ticks;
 const result=supplyRoute(model,request());
 expect(nearest).toBe('near');expect(baseline).toBe(12);
 expect(result.selected).toMatchObject({bank:'through',ticks:11,remaining:{coins:60,food:1}});
});
test('stock, reservations, food, fares, capacity and access can each block a cheap route',()=>{
 for(const change of [
  (r:SupplyRouteRequest)=>{r.stops[1]!.available=null;},
  (r:SupplyRouteRequest)=>{r.stops[1]!.reserved=1;},
  (r:SupplyRouteRequest)=>{r.stops[1]!.outbound={...cost,coins:121};},
  (r:SupplyRouteRequest)=>{r.stops[1]!.onward={...cost,food:3};},
  (r:SupplyRouteRequest)=>{r.stops[1]!.onward={...cost,accessible:null};},
  (r:SupplyRouteRequest)=>{r.stops[1]!.onward={...cost,accessible:false};},
 ]){const r=request();change(r);expect(supplyRoute(model,r).selected?.bank).toBe('near');}
 const r=request();r.capacity=9;expect(supplyRoute(model,r).selected).toBeNull();
});
test('remaining cash cannot fund a fare before pickup; invalid budgets fail',()=>{
 const r=request();r.budget.coins=20;expect(supplyRoute(model,r).selected).toBeNull();
 r.budget.coins=NaN;expect(()=>supplyRoute(model,r)).toThrow();
 const invalid=request();invalid.stops[0]!.bank='target';expect(()=>supplyRoute(model,invalid)).toThrow('Unknown pickup bank');
});
test('unknown costs cannot become zero and dated observations cannot cross direction/account/time',()=>{
 const r=request();r.stops=r.stops.slice(0,1);
 r.stops[0]!.outbound={...r.stops[0]!.outbound,coins:null};
 expect(supplyRoute(model,r).selected).toBeNull();
 // Do not mutate shared fixture costs when attaching an observation.
 r.stops[0]!.outbound={coins:30,food:1,accessible:true,observed:{ticks:3,at:1000,source:'receipt',from:'start',to:'near',account:'A',server:'demo',minCombat:29}};
 r.context={at:1000,maxAgeMs:0,account:'A',server:'demo',combat:29};
 expect(supplyRoute(model,r).selected).not.toBeNull();
 for(const context of [{...r.context,at:1001},{...r.context,account:'B'},{...r.context,server:'practice'},{...r.context,combat:28}])expect(supplyRoute(model,{...r,context}).selected).toBeNull();
 r.stops[0]!.outbound.observed!.to='target';expect(supplyRoute(model,r).selected).toBeNull();
});
test('shared unlocks occur once while consumable demands add and retain consumers',()=>{
 const acts:Activity[]=[
  {id:'unlock',label:'unlock',serves:['questpoints'],ticks:{floor:1,realistic:1},evidence:'ESTIMATE',source:'fixture'},
  ...['quest','gear'].map(id=>({id,label:id,serves:['attack' as const],requires:['unlock'],supplies:[{item:'Trout',count:6}],ticks:{floor:1,realistic:1},evidence:'ESTIMATE' as const,source:'fixture'})),
 ];
 const opts={mode:'realistic' as const,tricks:new Set<never>()};
 const r=goalRequirementsFor(acts,opts);
 expect(r.unlocks).toEqual([{activity:'unlock',consumers:['quest','gear'],selected:true}]);
 expect(r.supplies).toEqual([{item:'Trout',count:12,consumers:['quest','gear']}]);
 expect(suppliesFor(acts,opts)).toEqual([{item:'Trout',count:12}]);
});

test('two-leg affordability agrees with an independent budget oracle at every boundary',()=>{
 // Cargo is not operating food: collecting ten fish cannot fund the onward leg.
 for(const coins of [0,29,30,59,60,61])for(const food of [0,1,2,3]){
  const r=request();r.stops=r.stops.slice(0,1);r.budget={coins,food};
  const result=supplyRoute(model,r);
  expect(result.selected!==null).toBe(coins>=60&&food>=2);
  if(result.selected)expect(result.selected.remaining).toEqual({coins:coins-60,food:food-2});
 }
});

test('a faster receipt cannot outrank valid fallback when either leg loses evidence',()=>{
 const base=request();base.context={account:'A',server:'demo',at:2000,maxAgeMs:1000,combat:29};
 const fast=base.stops[1]!;
 fast.outbound={...cost,observed:{ticks:1,at:1000,source:'outbound receipt',from:'start',to:'through',account:'A',server:'demo',minCombat:29}};
 fast.onward={...cost,observed:{ticks:1,at:1000,source:'onward receipt',from:'through',to:'target',account:'A',server:'demo',minCombat:29}};
 expect(supplyRoute(model,base).selected?.bank).toBe('through');
 for(const legName of ['outbound','onward'] as const)for(const mutation of ['stale','future','account','server','direction','food','access'] as const){
  const r=structuredClone(base),c=r.stops[1]![legName],o=c.observed!;
  if(mutation==='stale')o.at=999;
  if(mutation==='future')o.at=2001;
  if(mutation==='account')o.account='B';
  if(mutation==='server')o.server='practice';
  if(mutation==='direction')[o.from,o.to]=[o.to,o.from];
  if(mutation==='food')c.food=null;
  if(mutation==='access')c.accessible=false;
  const result=supplyRoute(model,r);
  expect(result.selected?.bank).toBe('near');
  expect(result.candidates.find(c=>c.bank==='through')!.blockers.length).toBeGreaterThan(0);
 }
});
