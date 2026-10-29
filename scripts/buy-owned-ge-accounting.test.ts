import {test,expect} from 'bun:test';import {orderAccounting,type ItemOrder} from './buy-owned-ge-item';
const request={actor:'flfixture',server:'localhost:8888',goal:'proof',item:1331,limit:45000,reserve:5000,createdAt:1000,reviewAt:2000,deadline:3000},journal=(phase:ItemOrder['phase']):ItemOrder=>({version:1,request,phase,coinsBefore:50015,itemsBefore:0,previousIds:[],at:1000});
test('unknown mutation outcomes never report unproved escrow as a known asset',()=>{for(const phase of ['placing','cancelling','collecting'] as const)expect(orderAccounting(journal(phase))).toMatchObject({escrow:null,maximumExposure:45000,outcomeUnresolved:true,acquired:0,spent:0});});
test('confirmed open order retains its known reserved amount',()=>{expect(orderAccounting({...journal('open'),offerId:1})).toMatchObject({escrow:45000,maximumExposure:45000,outcomeUnresolved:false,spent:0});});
test('settled fill reports only reconciled spend and clears outstanding exposure',()=>{expect(orderAccounting({...journal('settled'),acquired:1,refund:5000})).toEqual({acquired:1,refund:5000,spent:40000,escrow:0,maximumExposure:0,outcomeUnresolved:false});});
test('settled cancellation is a refund,not a purchase',()=>{expect(orderAccounting({...journal('settled'),acquired:0,refund:45000})).toMatchObject({acquired:0,refund:45000,spent:0,escrow:0,maximumExposure:0});});
test('no order implies no outstanding exposure',()=>{expect(orderAccounting()).toMatchObject({escrow:0,maximumExposure:0,outcomeUnresolved:false});});

test('a settled label without complete conserved counters cannot fabricate an acquisition cost',()=>{
 for(const extra of [{},{acquired:0,refund:0},{acquired:1,refund:45001},{acquired:2,refund:0},{acquired:1,refund:-1}]){
  expect(orderAccounting({...journal('settled'),...extra})).toMatchObject({acquired:0,spent:0,escrow:null,maximumExposure:45000,outcomeUnresolved:true});
 }
});
test('a privately observed filled open order separates execution cost from refundable cash',()=>{
 const progress={actor:request.actor,server:request.server,offerId:7,itemId:1331,side:'buy' as const,quantity:1,limit:45000,filled:1,gross:40000,tax:0,at:1500};
 expect(orderAccounting({...journal('open'),offerId:7,progress})).toMatchObject({acquired:0,spent:40000,escrow:5000,maximumExposure:45000,outcomeUnresolved:false});
 expect(orderAccounting({...journal('settled'),offerId:7,progress,acquired:1,refund:4999}).outcomeUnresolved).toBe(true);
 expect(orderAccounting({...journal('open'),offerId:8,progress}).outcomeUnresolved).toBe(true);
});
