import {test,expect} from 'bun:test';
import {runOwnedSword,swordQuote,swordTileSafe} from './buy-owned-sword';
import type {Session} from '../packages/core/src/inprocess';
import {expandPath} from '../packages/core/src/walk';
const config={sellMultiplier:1000,buyMultiplier:600,haggle:10};
const shelf=(count=2,id=1287)=>({id,name:'Adamant sword',count,slot:5,baseCost:id===1301?3200:2080,buyPrice:id===1301?3200:2080,sellPrice:1248});
test('actual shop formula prices one sword at2080/full or2100/one left, rather than generic six-unit budget',()=>{
    expect(swordQuote(shelf(),config).price).toBe(2080);expect(swordQuote(shelf(1),config)).toEqual({price:2100,reportedBuyPrice:2080});
    expect(()=>swordQuote(shelf(0),config)).toThrow();expect(()=>swordQuote(shelf(),undefined)).toThrow();
});
test('corridor permits known bank/shop and excludes southern thief/dark-wizard shortcuts and other floors',()=>{
    expect(swordTileSafe({x:3185,z:3436})).toBe(true);expect(swordTileSafe({x:3203,z:3397})).toBe(true);
    expect(swordTileSafe({x:3185,z:3395})).toBe(false);expect(swordTileSafe({x:3220,z:3380})).toBe(false);expect(swordTileSafe({x:3203,z:3397,level:1})).toBe(false);
});
test('reviewed actual SDK eastern shop approach and return are permitted, adjacent unreviewed cells stay refused',()=>{
    const forward=[{x:3197,z:3418},{x:3202,z:3413},{x:3202,z:3412},{x:3210,z:3404},{x:3210,z:3400},{x:3209,z:3399},{x:3206,z:3399},{x:3205,z:3398},{x:3203,z:3398},{x:3203,z:3400}];
    const backward=[{x:3203,z:3399},{x:3203,z:3398},{x:3207,z:3398},{x:3208,z:3399},{x:3209,z:3399},{x:3210,z:3400},{x:3210,z:3405},{x:3198,z:3417},{x:3196,z:3417},{x:3195,z:3418}];
    expect(expandPath({x:3195,z:3418},forward).every(swordTileSafe)).toBe(true);
    expect(expandPath({x:3203,z:3399},backward).every(swordTileSafe)).toBe(true);
    expect(swordTileSafe({x:3211,z:3404})).toBe(false);expect(swordTileSafe({x:3210,z:3398})).toBe(false);expect(swordTileSafe({x:3209,z:3407})).toBe(false);
});
function fixture(o:{itemId?:number;stock?:number;fakeBuy?:boolean;distance?:number}={}){
    let tick=0,open=false,shop=false,generation=0,buyCalls=0;const listeners=new Set<()=>void>();
    const inv:any[]=[{id:333,name:'Trout',count:1,slot:0},{id:333,name:'Trout',count:1,slot:1}];
    const bank:any[]=[{id:995,name:'Coins',count:2600,slot:7},{id:329,name:'Salmon',count:30,slot:8},{id:1277,name:'Bronze sword',count:1,slot:9}];
    const position={worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0};const state=()=>({player:position,equipment:[],bank:{isOpen:open,items:bank},shop:{isOpen:shop,shopItems:[shelf(o.stock??1,o.itemId)],shopConfig:config},nearbyNpcs:[{id:551,index:10,x:o.distance===5?3209:3203,z:o.distance===5?3399:3397,distance:o.distance??1,optionsWithIndex:[{text:'Trade',opIndex:3}]}]});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1),walks:number[][]=[];
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),bankObservation:()=>open?{generation,at:tick+1,items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getSkill:()=>({level:10})},
        bot:{dismissBlockingUI:async()=>{},openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            withdrawItem:async(item:any,n:number,options:any)=>{expect(typeof item).toBe('object');expect(item).toBe(bank[0]);expect(item.slot).toBe(7);expect(options.asNote).toBe(false);item.count-=n;inv.push({id:995,name:'Coins',count:n,slot:2});generation++;return{success:true};},
            depositItem:async(item:any)=>{let row=bank.find(i=>i.id===item.id);if(!row){row={...item,count:0};bank.push(row);}row.count+=item.count;inv.splice(inv.indexOf(item),1);generation++;return{success:true};},
            openShop:async(npc:any)=>{expect(npc.id).toBe(551);shop=true;return{success:true};},closeShop:async()=>{shop=false;return{success:true};},
            buyFromShop:async(item:any,n:number)=>{buyCalls++;expect(item.id).toBe(o.itemId??1287);expect(n).toBe(1);if(!o.fakeBuy){inv.find(i=>i.id===995).count-=swordQuote(item,config).price;inv.push({id:o.itemId??1287,name:'Adamant sword',count:1,slot:3});}return{success:true,amountBought:1};}}};
    return{s:s as Session,bank,inv,walks,walk:async(x:number,z:number,tol:number)=>{walks.push([x,z,tol]);position.worldX=x;position.worldZ=z;return true;},buyCalls:()=>buyCalls,dispose:()=>clearInterval(timer)};
}
test('one observed sword at2100 is banked,500coins remain, and original food/kit are preserved',async()=>{
    const f=fixture();try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});
        expect(r).toMatchObject({ok:true,targetMet:true,bought:1,banked:1,spent:2100,price:2100,coinsRemaining:500,preserved:true,hpMin:10});
        expect(f.buyCalls()).toBe(1);expect(f.bank.find(i=>i.id===329).count).toBe(30);expect(f.bank.find(i=>i.id===1277).count).toBe(1);
        expect(f.inv.filter(i=>i.id===333).length).toBe(2);expect(f.inv.some(i=>i.id===995||i.id===1287)).toBe(false);
        expect(f.walks[0]).toEqual([3185,3420,1]);expect(f.walks.at(-1)).toEqual([3185,3436,2]);
    }finally{f.dispose();}
});
test('over-budget shelf or empty shelf makes no purchase and returns all owned cash',async()=>{
    for(const stock of [0,1]){const f=fixture({stock});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2000,walk:f.walk});expect(r.ok).toBe(false);expect(f.buyCalls()).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);}finally{f.dispose();}}
});
test('a success-shaped shop reply without actual sword and coin deltas cannot pass',async()=>{
    const f=fixture({fakeBuy:true});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(false);expect(r.banked).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);expect(f.buyCalls()).toBe(1);}finally{f.dispose();}
});


test('wandering shopkeeper is approached inside the checked route before trade',async()=>{const f=fixture({distance:5});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(true);expect(f.walks).toContainEqual([3209,3399,1]);expect(f.buyCalls()).toBe(1);}finally{f.dispose();}});
test('unrecognised shop pricing remains refused',()=>{expect(()=>swordQuote(shelf(),{...config,haggle:20})).toThrow('unknown sword shop');});

test('a shopkeeper already within reach needs no redundant path dispatch',async()=>{
 const f=fixture();try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(true);expect(f.walks).not.toContainEqual([3203,3397,1]);expect(f.walks.at(-1)).toEqual([3185,3436,2]);}finally{f.dispose();}
});
test('unrelated owned food is conserved; purchasing does not require the old courier fixture',async()=>{
 const f=fixture();try{f.inv.splice(0,f.inv.length,{id:315,name:'Shrimps',count:1,slot:0},{id:2309,name:'Bread',count:1,slot:1});
 const before=JSON.stringify(f.inv),r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});
 expect(r.ok).toBe(true);expect(r.preserved).toBe(true);expect(JSON.stringify(f.inv)).toBe(before);
 }finally{f.dispose();}
});
test('reserve slots for withdrawn cash and purchased sword before any purchase',async()=>{
 const f=fixture();try{f.inv.splice(0,f.inv.length,...Array.from({length:27},(_,slot)=>({id:333,name:'Trout',count:1,slot})));
 await expect(runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk})).rejects.toThrow('2free pack slots');expect(f.buyCalls()).toBe(0);expect(f.bank[0].count).toBe(2600);
 }finally{f.dispose();}
});

test('Eastbank preparation rejects unsupported start, stop and invalid budget before bank input',async()=>{
 const {runOwnedSwordFromEast}=await import('./buy-owned-sword');let actions=0;
 const s:any={tick:()=>0,sdk:{getState:()=>({player:{worldX:3252,worldZ:3420,level:0}}),getSkill:()=>({level:10})},bot:{openBank:async()=>{actions++;return{success:true};}}};
 await expect(runOwnedSwordFromEast(s,{cap:900,maximumSpend:2500,stop:()=>true})).rejects.toThrow('healthy active');
 await expect(runOwnedSwordFromEast(s,{cap:0,maximumSpend:2500})).rejects.toThrow('positive CAP');
 s.sdk.getState=()=>({player:{worldX:3185,worldZ:3436,level:0}});
 await expect(runOwnedSwordFromEast(s,{cap:900,maximumSpend:2500})).rejects.toThrow('checked start');expect(actions).toBe(0);
});

test('longsword exact profile is3200 at default1, unknown IDs and mismatched prices stay refused',()=>{
 expect(swordQuote(shelf(1,1301),config).price).toBe(3200);
 expect(()=>swordQuote(shelf(0,1301),config)).toThrow();
 expect(()=>swordQuote({...shelf(1,1301),baseCost:2080},config)).toThrow();
 expect(()=>swordQuote(shelf(1,1303),config)).toThrow();
});
test('longsword purchase banks only the selected item and reconciles actual cost',async()=>{
 const f=fixture({itemId:1301});f.bank[0].count=6000;
 try{const r=await runOwnedSword(f.s,{itemId:1301,cap:100,maximumSpend:4000,walk:f.walk});
 expect(r).toMatchObject({ok:true,itemId:1301,bought:1,banked:1,spent:3200,coinsRemaining:2800,preserved:true});
 expect(f.bank.find(i=>i.id===1301)?.count).toBe(1);expect(f.bank.some(i=>i.id===1287)).toBe(false);
 }finally{f.dispose();}
});
test('unsupported target and raised short-sword cap fail before withdrawal',async()=>{
 for(const itemId of [1287,1303]){const f=fixture();try{await expect(runOwnedSword(f.s,{itemId,cap:100,maximumSpend:4000,walk:f.walk})).rejects.toThrow('item-specific');expect(f.bank[0].count).toBe(2600);expect(f.buyCalls()).toBe(0);}finally{f.dispose();}}
});
