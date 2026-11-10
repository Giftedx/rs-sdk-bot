import {test,expect} from 'bun:test';
import {stageTrooperFood,trooperCookPlan,RAW_BEEF,COOKED_MEAT,BURNT_MEAT,TROOPER_RANGE,TROOPER_COOK_TILE,TROOPER_COOK_WANT,TROOPER_COOK_PACKS} from './trooper-food';
import {TROOPER_SITE} from './gather-combat';
import type {Session} from '../packages/core/src/inprocess';

test('the cook plan: nothing while owned trooper food covers the want, else packs of the banked raw beef',()=>{
    const beef=(n:number)=>[{id:RAW_BEEF,count:n}];
    expect(TROOPER_SITE.foods).toContain(COOKED_MEAT);
    expect(trooperCookPlan([],beef(300))).toBe(TROOPER_COOK_PACKS*28);
    expect(trooperCookPlan([],beef(40))).toBe(40);
    expect(trooperCookPlan([],[])).toBe(0);
    // Pack and bank food of every trooper kind count; cake does not.
    expect(trooperCookPlan([{id:385,count:5}],[...beef(300),{id:COOKED_MEAT,count:TROOPER_COOK_WANT-5}])).toBe(0);
    expect(trooperCookPlan([{id:385,count:5}],[...beef(300),{id:COOKED_MEAT,count:TROOPER_COOK_WANT-6}])).toBe(TROOPER_COOK_PACKS*28);
    expect(trooperCookPlan([{id:1891,count:20}],beef(300),20,1)).toBe(28);
});

// A bank, a pack and the range: a cook turns one raw beef into cooked meat, the first of each pack into burnt meat.
function fixture(o:{beef:number;food?:number;range?:boolean}){
    let tick=0,open=false,generation=0,pos={x:2619,z:3332};const walks:string[]=[];
    const listeners=new Set<()=>void>();
    const inv:any[]=[{id:1895,name:'Slice of cake',count:1,slot:0},{id:1895,name:'Slice of cake',count:1,slot:1},{id:995,name:'Coins',count:7750,slot:2}];
    const bank:any[]=[{id:RAW_BEEF,name:'Raw beef',count:o.beef,slot:0},...(o.food?[{id:COOKED_MEAT,name:'Cooked meat',count:o.food,slot:1}]:[])];
    const add=(rows:any[],id:number,name:string,n:number,stack:boolean)=>{const row=stack?rows.find(r=>r.id===id):undefined;if(row)row.count+=n;else if(stack)rows.push({id,name,count:n,slot:rows.length});else for(let k=0;k<n;k++)rows.push({id,name,count:1,slot:rows.length});};
    const state=()=>({player:{worldX:pos.x,worldZ:pos.z,level:0},inventory:inv,bank:{isOpen:open,items:bank},
        nearbyLocs:o.range===false?[]:[{id:2728,name:'Range',x:TROOPER_RANGE.x,z:TROOPER_RANGE.z,level:0}]});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    let cooks=0;
    const session:any={name:'cook-fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),
        bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,
            sendUseItemOnLoc:async(slot:number,x:number,z:number,id:number)=>{
                const i=inv.findIndex(r=>r.slot===slot&&r.id===RAW_BEEF);
                if(i<0||id!==2728||x!==TROOPER_RANGE.x||z!==TROOPER_RANGE.z||pos.x!==TROOPER_COOK_TILE.x||pos.z!==TROOPER_COOK_TILE.z)return{success:false};
                const burn=cooks++%28===0;inv[i]={...inv[i],id:burn?BURNT_MEAT:COOKED_MEAT,name:burn?'Burnt meat':'Cooked meat'};return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},dismissBlockingUI:async()=>({success:true}),
            depositItem:async(item:any)=>{for(const i of inv.filter(i=>i.id===item.id)){add(bank,i.id,i.name,i.count,true);inv.splice(inv.indexOf(i),1);}generation++;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;add(inv,item.id,item.name,n,false);generation++;return{success:true};}}};
    const walk=async(x:number,z:number)=>{walks.push(`${x},${z}`);pos={x,z};return true;};
    const banked=(id:number)=>bank.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
    return {session:session as Session,inv,bank,walk,walks,banked,dispose:()=>clearInterval(timer)};
}

test('an account short of trooper food cooks its banked raw beef at the range and banks the meat',async()=>{
    const f=fixture({beef:40});try{
        const r=await stageTrooperFood(f.session,{walk:f.walk});
        // Two packs: 28 and 12, the first cook of each burnt.
        expect(r).toMatchObject({cooked:38,burnt:2,trips:2});
        expect(f.banked(RAW_BEEF)).toBe(0);expect(f.banked(COOKED_MEAT)).toBe(38);expect(f.banked(BURNT_MEAT)).toBe(2);
        // The pack it arrived with is banked too, and nothing stays in the pack.
        expect(f.banked(995)).toBe(7750);expect(f.banked(1895)).toBe(2);expect(f.inv).toEqual([]);
        const tile=`${TROOPER_COOK_TILE.x},${TROOPER_COOK_TILE.z}`,bank=`${TROOPER_SITE.bank.x},${TROOPER_SITE.bank.z}`;
        expect(f.walks).toEqual([tile,bank,tile,bank]);
    }finally{f.dispose();}
});

test('it cooks at most the packs asked, and nothing when the food is there or no beef is banked',async()=>{
    const many=fixture({beef:300});try{
        expect(await stageTrooperFood(many.session,{walk:many.walk,packs:1})).toMatchObject({cooked:27,burnt:1,trips:1});
        expect(many.banked(RAW_BEEF)).toBe(272);
    }finally{many.dispose();}
    const fed=fixture({beef:300,food:TROOPER_COOK_WANT});try{
        expect(await stageTrooperFood(fed.session,{walk:fed.walk})).toMatchObject({cooked:0,burnt:0,trips:0});
        expect(fed.walks).toEqual([]);expect(fed.banked(RAW_BEEF)).toBe(300);expect(fed.inv).toHaveLength(3);
    }finally{fed.dispose();}
    const none=fixture({beef:0});try{
        expect(await stageTrooperFood(none.session,{walk:none.walk})).toMatchObject({cooked:0,trips:0});
        expect(none.walks).toEqual([]);
    }finally{none.dispose();}
});

test('a stop request or a missing range ends the stage with an error; the pack is never dropped',async()=>{
    const stopped=fixture({beef:40});try{
        await expect(stageTrooperFood(stopped.session,{walk:stopped.walk,stop:()=>true})).rejects.toThrow('trooper food: stop requested');
        expect(stopped.banked(RAW_BEEF)).toBe(40);
    }finally{stopped.dispose();}
    const blind=fixture({beef:40,range:false});try{
        await expect(stageTrooperFood(blind.session,{walk:blind.walk})).rejects.toThrow('trooper food: range unobserved');
        expect(blind.inv.filter(i=>i.id===RAW_BEEF)).toHaveLength(28);
    }finally{blind.dispose();}
});
