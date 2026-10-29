import { expect, test } from 'bun:test';
import { deliveryResume, foodDeficit, featherPurchaseAmount, selectFoodSource, deliveryRecipientAtBank, foodRestockAmount } from './courier-route';
const at = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });
test('failed hand-outs resume held cargo instead of buying feathers and collecting fish again', () => {
    expect(deliveryResume(at(2653, 3284), 1035, 4)).toBe('bank');
    expect(deliveryResume(at(2888, 3164), 1035, 4)).toBe('karamja');
    expect(deliveryResume(at(2619, 3332), 50, 1)).toBe('bank');
    expect(deliveryResume(at(2662, 3294), 75, 4)).toBe('bank'); // interrupted while looking for farmers
});
test('empty or unknown cargo routes retain collection and route refusal', () => {
    expect(deliveryResume(at(2653, 3284), 0, 4)).toBeNull();
    expect(deliveryResume(at(2653, 3284), 1035, 0)).toBeNull();
    expect(deliveryResume(at(3222, 3218), 1035, 4)).toBeNull();
    expect(deliveryResume(at(2888, 3164, 1), 1035, 4)).toBeNull();
    expect(deliveryResume(undefined, 1035, 4)).toBeNull();
});
test('a hungry live recipient precedes fed farms; unknown stock is never treated as empty', () => {
    const now = 100000, base = { name: 'Farmer', server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now - 1000, bank: [], inventory: [], result: '' };
    expect(foodDeficit('Farmer', base, now)).toBe(80);
    expect(foodDeficit('Farmer', { ...base, bank: [{ id: 333, count: 238 }], inventory: [{ id: 329, count: 26 }] }, now)).toBe(0);
    expect(foodDeficit('Farmer', { ...base, bank: [{ id: 333, count: 50 }], inventory: [{ id: 330, count: 10 }] }, now)).toBe(20);
    for (const patch of [{ name: 'Stranger' }, { server: 'localhost:8888' }, { at: now - 30000 }, { at: now + 1 }, { result: 'fail died' }, { bankAt: undefined }, { bank: null }, { inventory: [{ id: 333, count: -1 }] }])
        expect(foodDeficit('Farmer', { ...base, ...patch }, now)).toBeUndefined();
});

test('feather purchases fill an observed cook deficit instead of buying500every trip', () => {
    const now=100000,status={name:'Cook',server:'rs-sdk-demo.fly.dev',at:now,result:'',inventory:[{id:314,count:2490}]};
    expect(featherPurchaseAmount(500,'Cook',status,now)).toBe(0);
    expect(featherPurchaseAmount(500,'Cook',{...status,inventory:[{id:314,count:800}]},now)).toBe(200);
    expect(featherPurchaseAmount(500,'Cook',{...status,inventory:[]},now)).toBe(500);
    for(const patch of [{name:'Stranger'},{server:'localhost:8888'},{at:now-30000},{at:now+1},{result:'ok stopped'},{inventory:null}])
        expect(featherPurchaseAmount(500,'Cook',{...status,...patch},now)).toBe(500);
});

 test('either active owned cook can supply collection; invalid and offline stock cannot',()=>{
    const now=100000,owned=new Set(['first','second']);
    const cook=(name:string,n:number)=>({name,server:'rs-sdk-demo.fly.dev',at:now,bankAt:now-1000,result:'',bank:[{id:333,count:n}]});
    const first=cook('First',10),second=cook('Second',170);
    expect(selectFoodSource(['First','Second'],[first,second],owned,now)).toBe('Second');
    expect(selectFoodSource(['First','Second'],[first,{...second,result:'fail stopped'}],owned,now)).toBe('First');
    expect(selectFoodSource(['First','Second'],[first,{...second,at:now-30000}],owned,now,20)).toBeUndefined();
    expect(selectFoodSource(['First','Second'],[first,second],new Set(['first']),now)).toBeUndefined();
    expect(selectFoodSource(['First','Second'],[{...first,bankAt:now+1},{...second,server:'localhost:8888'}],owned,now)).toBeUndefined();
 });


test('a visible farmer away from the bank cannot make the courier auto-follow it',()=>{
    const bank={x:2654,z:3283},at={worldX:2654,worldZ:3283,level:0};
    expect(deliveryRecipientAtBank(at,[{name:'Farm',distance:2}],'Farm',bank)).toBe(true);
    expect(deliveryRecipientAtBank(at,[{name:'Farm',distance:17}],'Farm',bank)).toBe(false);
    expect(deliveryRecipientAtBank({...at,worldZ:3302},[{name:'Farm',distance:1}],'Farm',bank)).toBe(false);
    expect(deliveryRecipientAtBank({...at,level:1},[{name:'Farm',distance:1}],'Farm',bank)).toBe(false);
    expect(deliveryRecipientAtBank(at,[{name:'Foreign',distance:1}],'Farm',bank)).toBe(false);
    expect(deliveryRecipientAtBank(at,[{name:'Farm',distance:-1}],'Farm',bank)).toBe(false);
});

test('restock wakes below80 and fills toward160 instead of reconnecting for every fish eaten',()=>{
    const now=100000,s={name:'Farm',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now-1,result:'',bank:[],inventory:[{id:333,count:79}]};
    expect(foodRestockAmount('Farm',s,now)).toBe(81);
    expect(foodRestockAmount('Farm',{...s,inventory:[{id:333,count:80}]},now)).toBe(0);
    expect(foodRestockAmount('Farm',{...s,inventory:[{id:333,count:160}]},now)).toBe(0);
    expect(foodRestockAmount('Farm',{...s,at:now-30000},now)).toBeUndefined();
});


test('food refill binds to an explicit local server while the live default still rejects local snapshots',()=>{
 const now=100000,s={name:'Farm',server:'localhost:8888',at:now,bankAt:now-1,result:'',bank:[],inventory:[]};
 expect(foodRestockAmount('Farm',s,now)).toBeUndefined();
 expect(foodRestockAmount('Farm',s,now,'localhost:8888')).toBe(160);
 expect(foodRestockAmount('Farm',{...s,server:'rs-sdk-demo.fly.dev'},now,'localhost:8888')).toBeUndefined();
});
