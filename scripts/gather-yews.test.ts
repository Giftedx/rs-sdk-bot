import {test,expect} from 'bun:test';
import {treeAfterBank,runDraynorOak,oakGrove,westOakPathAllowed} from './gather-yews';
import type {Session} from '../packages/core/src/inprocess';

test('explicit TREE survives a bank visit with fewer than100normal logs',()=>{
    expect(treeAfterBank('oak',13)).toBe('oak');expect(treeAfterBank('normal',500)).toBe('normal');
    expect(treeAfterBank(undefined,13)).toBe('normal');expect(treeAfterBank(undefined,100)).toBe('oak');
});
function fixture(stalled=false,west=false){
    let tick=0,open=false,generation=0,xp=1010625;const listeners=new Set<()=>void>();
    const inv:any[]=[],bank:any[]=[{id:1349,name:'Iron axe',count:2,slot:0},{id:1351,name:'Bronze axe',count:1,slot:1},{id:315,name:'Shrimps',count:1,slot:2},{id:2309,name:'Bread',count:1,slot:3},{id:1511,name:'Logs',count:13,slot:4},{id:995,name:'Coins',count:84,slot:5}];
    const trees=(west?[[3102,3242,1],[3081,3291,1],[3070,3253,3]]:[[3081,3291,2]]).map(([x,z,distance])=>({id:1281,name:'Oak',x,z,distance,optionsWithIndex:[{text:'Chop down',opIndex:1}]}));
    const chopped:{x:number;z:number}[]=[];
    const state=()=>({player:{worldX:3092,worldZ:3243,level:0,lifeId:1,respawnCount:0},equipment:[],inventory:inv,bank:{isOpen:open,items:bank},nearbyLocs:trees});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getSkill:(n:string)=>({level:n==='Hitpoints'?11:99,baseLevel:n==='Hitpoints'?11:99}),getSkillXp:()=>xp,
            sendInteractLoc:async(x:number,z:number)=>{chopped.push({x,z});if(!stalled){const row=inv.find(i=>i.id===1521);if(row)row.count++;else inv.push({id:1521,name:'Oak logs',count:1,slot:inv.length});xp+=937;}return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;inv.push({id:item.id,name:item.name,count:n,slot:inv.length});generation++;return{success:true};},
            depositItem:async(item:any)=>{let row=bank.find(i=>i.id===item.id);if(!row){row={...item,slot:bank.length,count:0};bank.push(row);}row.count+=item.count;inv.splice(inv.indexOf(item),1);generation++;return{success:true};}},
        direct:async()=>({success:true})};
    return{s:s as Session,inv,bank,chopped,dispose:()=>clearInterval(timer)};
}
test('prepare withdraws only owned axe and2foods then banks25NEWoak while preserving all kit assets',async()=>{
    const f=fixture();try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(true);expect(r.banked).toBe(25);expect(r.newLogs).toBe(25);expect(r.preserved).toBe(true);expect(f.inv.find(i=>i.id===1349).count).toBe(1);expect(f.bank.find(i=>i.id===1349).count).toBe(1);expect(f.bank.find(i=>i.id===1511).count).toBe(13);}finally{f.dispose();}
});
test('west opt-in uses only verified3070,3253Oak and northern waypoints both ways; default stays north',async()=>{
    expect(oakGrove().name).toBe('north');expect([...oakGrove().trees]).toEqual(['3081,3291','3082,3295']);expect(()=>oakGrove('nearest')).toThrow('unsupported OAK_GROVE');
    const f=fixture(false,true),walks:number[][]=[];
    try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,grove:'west',walk:async(x,z,tol)=>{walks.push([x,z,tol]);return true;}});
        expect(r.ok).toBe(true);expect(r.grove).toBe('west');expect(r.banked).toBe(25);expect(r.preserved).toBe(true);expect(r.plannedPathTiles).toBeNull();
        expect(walks).toEqual([[3092,3250,1],[3089,3266,1],[3070,3253,3],[3089,3266,1],[3092,3250,1],[3092,3243,2]]);
        expect(f.chopped).toHaveLength(25);expect(f.chopped.every(p=>p.x===3070&&p.z===3253)).toBe(true);
    }finally{f.dispose();}
});
test('west full expanded paths reject dark-wizard shortcut, eastern guard approach and unknown empty fallback',()=>{
    const bank={x:3092,z:3243};
    expect(westOakPathAllowed(bank,[{x:3092,z:3250},{x:3089,z:3266},{x:3073,z:3255}])).toBe(true);
    expect(westOakPathAllowed(bank,[{x:3089,z:3247},{x:3073,z:3255}])).toBe(false);
    expect(westOakPathAllowed(bank,[{x:3098,z:3250},{x:3073,z:3255}])).toBe(false);
    expect(westOakPathAllowed(bank,[])).toBe(false);
});
test('west guard permits the observed F88E northern fence detour3103,3271 only for its bank access leg',()=>{
    const south={x:3092,z:3250},north={x:3089,z:3266};
    // Retained native flwoodxf9801 frames t13..38 and reverse t278..295.
    const outward=[{x:3094,z:3250},{x:3096,z:3251},{x:3098,z:3252},{x:3100,z:3254},{x:3102,z:3255},{x:3103,z:3265},{x:3103,z:3271},{x:3095,z:3271},{x:3092,z:3269},north];
    const returning=[{x:3092,z:3269},{x:3096,z:3271},{x:3102,z:3271},{x:3103,z:3270},{x:3103,z:3256},{x:3101,z:3255},{x:3097,z:3252},{x:3095,z:3250},south];
    expect(westOakPathAllowed({x:3092,z:3242},[south])).toBe(true);
    expect(westOakPathAllowed(south,outward,north)).toBe(true);
    expect(westOakPathAllowed(north,returning,south)).toBe(true);
    expect(westOakPathAllowed(south,[{x:3104,z:3265},north],north)).toBe(false);
    expect(westOakPathAllowed(south,[{x:3103,z:3249},north],north)).toBe(false);
    expect(westOakPathAllowed(south,[{x:3089,z:3247},north],north)).toBe(false);
    expect(westOakPathAllowed(north,[{x:3103,z:3271},{x:3073,z:3255}])).toBe(false);
});
test('already held owned foods count toward preparation without withdrawing duplicate bank food',async()=>{
    const f=fixture();f.inv.push(...f.bank.splice(2,2).map((i:any,j:number)=>({...i,slot:j})));try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(true);expect(f.inv.filter(i=>i.id===315||i.id===2309).reduce((n,i)=>n+i.count,0)).toBe(2);expect(r.preserved).toBe(true);}finally{f.dispose();}
});
test('missing owned preparation food fails without chopping; stalled output remains bounded',async()=>{
    const missing=fixture();missing.bank.splice(2,2);try{const r=await runDraynorOak(missing.s,{cap:100,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(false);expect(r.newLogs).toBe(0);expect(r.failure).toContain('food');}finally{missing.dispose();}
    const stalled=fixture(true);try{const r=await runDraynorOak(stalled.s,{cap:100,maximum:25,prepare:true,noProgress:12,walk:async()=>true});expect(r.ok).toBe(false);expect(r.newLogs).toBe(0);expect(r.failure).toContain('no wood progress');}finally{stalled.dispose();}
});
