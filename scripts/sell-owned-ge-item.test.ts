import{resolve}from'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import {describe,it,expect} from 'bun:test';
import {saleStopRequested,runOwnedSale,validateSale,salePlacement,salePlacementReady,saleProgress,saleClaim,saleCollected,type SaleJournal,type SaleView} from './sell-owned-ge-item';
const journal=():SaleJournal=>({version:1,request:{actor:'seller',server:'localhost:19081',goal:'surplus',item:1511,quantity:3,price:100,floor:90,reserveItems:2,deadline:Date.now()+60000},phase:'attempted',coinsBefore:15,itemsBefore:5,previousIds:[]});
const offer=()=>({id:1,slot:0,item:1511,name:'Logs',side:'sell' as const,quantity:3,price:100,remaining:1,filled:2,state:'open' as 'open'|'cancelled'|'completed',items:0,coins:190,gross:200,tax:10});
const view=():SaleView=>({actor:'seller',server:'localhost:19081',coins:15,items:2,offers:[offer()]});
describe('owned finite sell journal',()=>{
 it('checks floor and finite lot',()=>{validateSale(journal().request);expect(()=>validateSale({...journal().request,price:89})).toThrow();expect(()=>validateSale({...journal().request,quantity:Infinity})).toThrow();});
 it('recovers lost placement by exact escrow and private ID',()=>{expect(salePlacement(journal(),view())?.id).toBe(1);expect(()=>salePlacement(journal(),{...view(),items:3})).toThrow();expect(()=>salePlacement(journal(),{...view(),offers:[offer(),{...offer(),id:2}]})).toThrow();});
 it('waits for offer-first pack-later but rejects wrong terminal escrow',()=>{const first={...view(),items:5};expect(salePlacementReady(journal(),first)).toBe(false);expect(salePlacementReady(journal(),view())).toBe(true);expect(()=>salePlacement(journal(),first)).toThrow('sale escrow debit mismatch');expect(()=>salePlacementReady(journal(),{...view(),offers:[offer(),{...offer(),id:2}]})).toThrow('ambiguous');});
 it('requires cumulative fee and monotonic fill',()=>{const j={...journal(),offerId:1};j.progress=saleProgress(j,offer());expect(()=>saleProgress(j,{...offer(),filled:1,gross:100,tax:5})).toThrow();expect(()=>saleProgress(j,{...offer(),tax:9})).toThrow();});
 it('keeps cumulative rounding across separate fills',()=>{const j={...journal(),offerId:1};j.progress=saleProgress(j,{...offer(),filled:1,gross:119,tax:5,coins:114});const next=saleProgress(j,{...offer(),filled:2,gross:228,tax:11,coins:217});expect(next.tax-j.progress.tax).toBe(6);});
 it('closes partial cancel with unsold stock plus net proceeds',()=>{const j={...journal(),offerId:1};const o={...offer(),state:'cancelled' as const,remaining:0,items:1};j.progress=saleProgress(j,o);j.claim=saleClaim(j,o);expect(j.claim).toEqual({items:1,coins:190});expect(saleCollected(j,{...view(),offers:[],items:3,coins:205})).toBe(true);expect(saleCollected(j,{...view(),offers:[],items:4,coins:205})).toBe(false);expect(()=>saleClaim(j,{...o,items:2})).toThrow();});
});

it('CLI global stop callback prevents exchange entry and owned escrow dispatch',async()=>{
 let opens=0,placements=0;const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0}}),getStateAge:()=>0,getSkill:()=>({level:50})},bot:{openGE:async()=>{opens++;return{success:true};},placeGEOffer:async()=>{placements++;return{success:true};}}};
 const stop=()=>saleStopRequested('seller',path=>path===resolve('.practice','stop-all'));
 const result=await runOwnedSale(s,journal().request,resolve(tmpdir(),'ge-stop-'+randomUUID()+'.json'),stop,40);
 expect(result.ok).toBe(false);expect(result.error).toContain('sale stopped before exchange');expect(opens).toBe(0);expect(placements).toBe(0);expect(result.journal).toBeUndefined();
});
