import {expect,test} from 'bun:test';
import {preparationGear} from './preparation-report';
import type {ItemOrder} from './buy-owned-ge-item';
const now=1_000_000;
const job={account:'Mightyrod',script:'scripts/gather-fire-combat.ts',goal:'Restore productive combat'};
const snapshot=(name='Mightyrod')=>({name,server:'rs-sdk-demo.fly.dev',at:now-10,bankAt:now-10,skills:[{name:'Attack',level:30}],inventory:[],equipment:[],bank:[{id:1277,count:1},{id:1171,count:1},{id:295,count:1},{id:954,count:1},{id:329,count:16}]});

test('actual Fire contract resolves alternative owned gear without clearing its exact procurement target',()=>{
 const jobs=[job,{account:'Buyer',script:'scripts/buy-owned-ge-item.ts',env:{ITEM_ID:'1331'},goal:'Deliver upgrade'}];
 const report=preparationGear(jobs,[snapshot()],['Mightyrod','Buyer'],now);
 expect(report.kits[0]?.loadout.state).toBe('ready');expect(report.kits[0]?.loadout.selected[0]?.id).toBe(1277);
 expect(report.kits[0]?.staged).toBe(false);expect(report.procurement[0]).toMatchObject({itemId:1331,accepted:false});
});
test('own reservations block stock and another owned holder is only a delivery lead',()=>{
 const report=preparationGear([job],[snapshot(),{...snapshot('Donor'),bank:[{id:1331,count:1}]}],['Mightyrod','Donor'],now,[{account:'Mightyrod',id:1277,count:1}]);
 expect(report.kits[0]?.loadout.state).toBe('missing');expect(report.kits[0]?.foreignStock.find(x=>x.id===1331)?.holders).toEqual(['Donor']);
});
test('stale, foreign, practice and missing skills do not become current gear readiness',()=>{
 const base=snapshot();
 for(const changed of [{...base,at:now-300001,bankAt:now-300001},{...base,server:'foreign'},{...base,practice:true},{...base,skills:[]}]){
  expect(preparationGear([job],[changed],['Mightyrod'],now).kits[0]?.loadout.state).not.toBe('ready');
 }
});
test('unbanked noted weapons never equip and dated bank/pack quantities are not added twice',()=>{
 const base=snapshot();base.bank=[];
 const noted={...base,inventory:[{id:1332,baseId:1331,count:1},{id:1171,count:1},{id:295,count:1},{id:954,count:1},{id:329,count:16}]};
 expect(preparationGear([job],[noted],['Mightyrod'],now).kits[0]?.loadout.state).toBe('missing');
 const half={...snapshot(),inventory:[{id:329,count:8}],bank:snapshot().bank.map(i=>i.id===329?{...i,count:8}:i)};
 expect(preparationGear([job],[half],['Mightyrod'],now).kits[0]?.loadout.state).toBe('missing');
});
test('actual host job accounts expand without undefined identities or shared stock',()=>{
 const jobs=[{accounts:['Mightyrod','Other'],script:job.script}];
 const report=preparationGear(jobs,[snapshot()],['Mightyrod','Other'],now);
 expect(report.kits.map(k=>k.account)).toEqual(['Mightyrod','Other']);
 expect(report.kits.map(k=>k.loadout.state)).toEqual(['ready','unknown']);
});
test('dated canceled procurement shows its refund, while stale open or foreign orders stay unknown',()=>{
 const buyer={account:'Buyer',script:'scripts/buy-owned-ge-item.ts',env:{ITEM_ID:'1331',ORDER_KEY:'gear'}};
 const journal:ItemOrder={version:1,request:{actor:'Buyer',server:'rs-sdk-demo.fly.dev',goal:'gear',item:1331,limit:45000,reserve:5000,createdAt:1,reviewAt:2,deadline:3},phase:'settled',coinsBefore:50000,itemsBefore:0,previousIds:[],offerId:9,acquired:0,refund:45000,at:now-400000};
 const result=(j:ItemOrder)=>preparationGear([buyer],[],['Buyer'],now,[],{buyer:j}).procurement[0]!;
 expect(result(journal).order).toMatchObject({state:'historical-settled',accounting:{acquired:0,refund:45000,spent:0,escrow:0},costBasis:{units:0,coins:0}});
 expect(result({...journal,phase:'open'}).order).toMatchObject({state:'unknown',accounting:null});
 expect(result({...journal,request:{...journal.request,actor:'Other'}}).order.state).toBe('unknown');
 expect(result({...journal,request:{...journal.request,server:'foreign'}}).order.state).toBe('unknown');
 expect(result(journal).accepted).toBe(false);
});
