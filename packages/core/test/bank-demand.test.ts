import { expect,test } from 'bun:test';
import { hasDelivery, hasPayout } from '../src/bank-demand';
import {foodStock,cookedFoodRestock,selectCookedFoodSource} from '../src/bank-demand';
test('shark notes satisfy generic food stock/demand but raw and burnt never do',()=>{
    expect(foodStock([{id:385,count:25},{id:386,count:55},{id:383,count:500},{id:387,count:10}])).toBe(80);
    const s={name:'Endgame',server:'local',at:1000,bankAt:1000,bank:[{id:385,count:100}],inventory:[],result:''};
    expect(cookedFoodRestock('Endgame',s,1001,'local')).toBe(0);
    expect(cookedFoodRestock('Endgame',{...s,bank:[{id:383,count:100}]},1001,'local')).toBe(160);
    expect(selectCookedFoodSource(['Endgame'],[s],new Set(['endgame']),1001,25,'local')).toBe('Endgame');
    expect(selectCookedFoodSource(['Endgame'],[{...s,at:0}],new Set(['endgame']),40000,25,'local')).toBeUndefined();
    expect(selectCookedFoodSource(['Endgame'],[s],new Set(),1001,25,'local')).toBeUndefined();
});
test('banker demand requires fresh unfinished cargo, not coins or stale/offline inventory',()=>{
    const s={at:100,result:'',inventory:[{name:'Flax',count:81}]};
    expect(hasDelivery(s,200)).toBe(true);
    expect(hasDelivery({...s,result:'ok delivered'},200)).toBe(false);
    expect(hasDelivery(s,40000)).toBe(false);
    expect(hasDelivery({...s,inventory:[{name:'Coins',count:500}]},200)).toBe(false);
    expect(hasDelivery({...s,at:300},200)).toBe(false);
    expect(hasDelivery({...s,pos:{x:2727,z:3492,level:0}},200,{x:2654,z:3283,radius:50})).toBe(false);
    expect(hasDelivery({...s,pos:{x:2654,z:3310,level:0}},200,{x:2654,z:3283,radius:50})).toBe(true);
});

test('coins-only owned account near bank wakes payout demand with a fresh valid request', () => {
    const status={name:'Bigpackage',server:'rs-sdk-demo.fly.dev',at:1000,result:'',pos:{x:2654,z:3283,level:0},inventory:[{name:'Coins',count:100}]};
    const near={x:2654,z:3283,radius:50},request={items:[{name:'Coins',count:40000},{name:'Trout',count:2}]};
    expect(hasDelivery(status,2000,near)).toBe(false);
    expect(hasPayout('Bigpackage',status,request,1000,2000,near)).toBe(true);
    expect(hasPayout('bigpackage',status,request,1000,181000,near)).toBe(false); // status offline even when request still valid
    expect(hasPayout('Bigpackage',{...status,at:181000},request,1000,181000,near)).toBe(true); // inclusive3min
});
test('payout rejects stale/future/malformed requests and foreign/offline/far status', () => {
    const now=200000,near={x:2654,z:3283,radius:50};
    const status={name:'Bigpackage',server:'rs-sdk-demo.fly.dev',at:now,result:'',pos:{x:2654,z:3283,level:0}};
    const request={items:[{name:'Coins',count:40000}]};
    expect(hasPayout('Bigpackage',status,request,now-180001,now,near)).toBe(false);
    expect(hasPayout('Bigpackage',status,request,now+1,now,near)).toBe(false);
    for(const items of [[],[{name:'',count:1}],[{name:'Coins',count:0}],[{name:'Coins',count:1.5}],[{name:'Coins',count:-1}],null])
        expect(hasPayout('Bigpackage',status,{items},now,now,near)).toBe(false);
    for(const change of [{name:'Stranger'},{server:'localhost:8888'},{at:now+1},{at:now-30000},{result:'ok done'},
        {pos:{x:2727,z:3492,level:0}},{pos:{x:2654,z:3283,level:1}},{pos:null}])
        expect(hasPayout('Bigpackage',{...status,...change},request,now,now,near)).toBe(false);
    expect(hasPayout('Bigpackage',status,request,now,now)).toBe(false); // no bank location proof
});

test('payout validation can bind an explicitly selected local test server without weakening the live default',()=>{
 const s={name:'Local',server:'localhost:8888',at:1000,result:'',pos:{x:2654,z:3283,level:0}};
 const request={items:[{name:'Coins',count:5000}]},near={x:2654,z:3283,radius:6};
 expect(hasPayout('Local',s,request,1000,1000,near)).toBe(false);
 expect(hasPayout('Local',s,request,1000,1000,near,'localhost:8888')).toBe(true);
 expect(hasPayout('Local',{...s,server:'rs-sdk-demo.fly.dev'},request,1000,1000,near,'localhost:8888')).toBe(false);
});
