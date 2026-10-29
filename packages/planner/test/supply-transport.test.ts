import {test,expect} from 'bun:test';
import {supplyRoute,type SupplyRouteRequest} from '../src/supply-route';
import type {TravelModel} from '../src/travel';

const model:TravelModel={places:{start:{x:0,z:0},target:{x:10,z:0}},cache:{nearestBank:{},banks:{slow:{x:0,z:4},fast:{x:4,z:0}},legs:{}}};
const gate=(id:string,requires:string[][])=>({id,source:'pinned-content.rs2:1',requires});
const request=()=>({from:'start',to:'target',count:1,capacity:1,budget:{coins:10,food:0},resources:{held:{rope:1} as Record<string,number|null>|null,reserved:{} as Record<string,number>,facts:{} as Record<string,true|false|null>},stops:['slow','fast'].map(bank=>({holder:bank,bank,available:1,reserved:0,outbound:{coins:0,food:0,accessible:true,gates:[] as ReturnType<typeof gate>[]},onward:{coins:0,food:0,accessible:true,gates:[] as ReturnType<typeof gate>[]}}))});

test('whole-trip alternatives preserve the one rope needed after pickup',()=>{
 const r=request(),fast=r.stops[1]!;
 fast.outbound.gates=[gate('entry',[['consume:rope:1'],['coins:10']])];
 fast.onward.gates=[gate('exit',[['consume:rope:1']])];
 const before=JSON.stringify(r),result=supplyRoute(model,r as SupplyRouteRequest);
 expect(result.selected?.bank).toBe('fast');
 expect(result.selected?.remaining.coins).toBe(0);
 expect((result.selected as any)?.transport.remaining.held.rope).toBe(0);
 expect(JSON.stringify(r)).toBe(before);
});

test('one consumable cannot pay for both directions or consume reserved stock',()=>{
 for(const held of [1,2]){
  const r=request();r.resources.held={rope:held};r.resources.reserved={rope:held-1};
  r.stops[1]!.outbound.gates=[gate('entry',[['consume:rope:1']])];
  r.stops[1]!.onward.gates=[gate('exit',[['consume:rope:1']])];
  expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
 }
});

test('unknown item state and unsupported gate facts stay unknown',()=>{
 for(const held of [null,{rope:null}]){
  const r=request();r.resources.held=held;
  r.stops[1]!.outbound.gates=[gate('entry',[['consume:rope:1']])];
  const result=supplyRoute(model,r as SupplyRouteRequest);
  expect(result.selected?.bank).toBe('slow');
  expect((result.candidates.find(c=>c.bank==='fast') as any).transport.state).toBeNull();
 }
 const r=request();r.stops[1]!.outbound.gates=[gate('unknown',[['other:unmodeled state']])];
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
});

test('AND tokens use their own quantities and check held items before consuming',()=>{
 const r=request();r.resources.held={rope:2};
 r.stops[1]!.outbound.gates=[gate('entry',[['consume:rope:1','item:rope:held','consume:rope:1']])];
 const result=supplyRoute(model,r as SupplyRouteRequest);
 expect((result.selected as any)?.transport.remaining.held.rope).toBe(0);
 r.resources.held={rope:1};
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
});

test('an observed quest alternative avoids the repeated toll; unknown is not completion',()=>{
 const r=request();
 for(const c of [r.stops[1]!.outbound,r.stops[1]!.onward])c.gates=[gate('toll',[['coins:10'],['quest:prince>=100']])];
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
 r.resources.facts={'quest:prince>=100':true};
 const result=supplyRoute(model,r as SupplyRouteRequest);
 expect(result.selected?.bank).toBe('fast');
 expect(result.selected?.remaining.coins).toBe(10);
});

test('reserved coins remain after base fares and gate fees',()=>{
 const r=request();r.resources.reserved={coins:8};
 r.stops[1]!.outbound.coins=2;r.stops[1]!.outbound.gates=[gate('fare',[['coins:1']])];
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
});

test('unobserved legacy locked paths cannot become ready from a boolean alone',()=>{
 const m=structuredClone(model);m.cache.legs['fast>start']={runTicks:1,tiles:2,locked:['unparsed_door']};
 const r=request();delete (r.stops[1]!.outbound as any).gates;
 expect(supplyRoute(m,r as SupplyRouteRequest).selected?.bank).toBe('slow');
});

test('an empty caller gate list cannot erase cached modeled prerequisites',()=>{
 const m=structuredClone(model);m.cache.legs['fast>start']={runTicks:1,tiles:2,locked:['unparsed_door']};
 expect(supplyRoute(m,request() as SupplyRouteRequest).selected?.bank).toBe('slow');
});

test('whole-trip resource decisions agree with an independent counted-stock oracle',()=>{
 for(let rope=0;rope<=4;rope++)for(let coins=0;coins<=4;coins++)for(let reserve=0;reserve<=2;reserve++){
  const r=request();r.budget.coins=coins;r.resources.held={rope};r.resources.reserved={rope:reserve};
  r.stops[1]!.outbound.gates=[gate('entry',[['consume:rope:1'],['coins:2']])];
  r.stops[1]!.onward.gates=[gate('exit',[['consume:rope:2']])];
  const available=rope-reserve,possible=available>=3||available>=2&&coins>=2;
  expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank==='fast').toBe(possible);
 }
});

test('an empty parsed gate and a bounded-out alternative search remain explicit unknown',()=>{
 const r=request();r.stops[1]!.outbound.gates=[gate('unparsed',[])];
 let result=supplyRoute(model,r as SupplyRouteRequest);
 expect((result.candidates.find(c=>c.bank==='fast') as any).transport.state).toBeNull();
 const held:Record<string,number>={};
 r.stops[1]!.outbound.gates=Array.from({length:13},(_,i)=>{held['a'+i]=1;held['b'+i]=1;return gate('branch'+i,[[`consume:a${i}:1`],[`consume:b${i}:1`]]);});
 r.resources.held=held;result=supplyRoute(model,r as SupplyRouteRequest);
 expect(result.selected?.bank).toBe('slow');
 expect((result.candidates.find(c=>c.bank==='fast') as any).transport.blockers).toContain('transport alternative search bound exceeded');
});

test('unobserved coins cannot fund fares but do not block a proved free alternative',()=>{
 const r=request();Object.assign(r.resources,{coinsKnown:false});
 r.stops[1]!.outbound.gates=[gate('toll',[['coins:1'],['quest:prince>=100']])];
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
 r.resources.facts={'quest:prince>=100':true};
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('fast');
 r.stops[1]!.outbound.coins=1;
 expect(supplyRoute(model,r as SupplyRouteRequest).selected?.bank).toBe('slow');
});
