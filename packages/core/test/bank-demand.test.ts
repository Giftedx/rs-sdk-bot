import { expect,test } from 'bun:test';
import { hasDelivery, hasPayout } from '../src/bank-demand';
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
