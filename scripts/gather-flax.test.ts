import {test, expect} from 'bun:test';
import type {Session} from '../packages/core/src/inprocess';
import {runFlax} from './gather-flax';

function fixture(o:{visible?:boolean;walkFails?:boolean;firstWalkFails?:boolean;capOnFirstReturn?:boolean;depositFails?:boolean;stale?:boolean;stopOnReturn?:boolean;dieOnReturn?:boolean;endOnReturn?:boolean;exhaust?:boolean;cargoLeftover?:boolean;cargoTransfer?:boolean}={}){
    let tick=0,x=o.visible?2735:2744,z=o.visible?3483:3445,open=false,generation=0,banked=10,stopped=false,dead=false;
    let openCalls=0,autoWalks=0,cargoCalls=0;const walks:{remaining:number;stopped:boolean}[]=[];
    const inv:any[]=[{id:995,name:'Coins',count:80,slot:0},{id:333,name:'Trout',count:2,slot:1}];
    const listeners=new Set<()=>void>();let end!:()=>void;
    const ended=new Promise<any>(r=>{end=()=>r({reason:'test ended'});});
    const state=()=>({inventory:inv,player:{worldX:x,worldZ:z,level:0,lifeId:1,respawnCount:0,isDead:dead},bank:{isOpen:open,items:[{id:1779,name:'Flax',count:banked}]}});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended,
        bankObservation:()=>open&&!o.stale?{generation,at:tick+1000,items:state().bank.items}:null,
        sdk:{getState:state,getSkill:()=>({level:10}),getInventory:()=>inv,findNearbyLoc:()=>({id:2646,name:'Flax'})},
        bot:{dismissBlockingUI:async()=>{},interactLoc:async()=>{await new Promise<void>(r=>{const once=()=>{listeners.delete(once);r();};listeners.add(once);});inv.push({id:1779,name:'Flax',count:1,slot:2});return{success:true};},
            openBank:async()=>{openCalls++;const distance=Math.max(Math.abs(x-2727),Math.abs(z-3492));
                // Model the traced SDK recovery: visible bank auto-walks; field47tiles has no target.
                if(distance>15)return{success:false,message:'No banker NPC or bank booth found nearby'};
                if(distance>2){autoWalks++;x=2727;z=3492;}open=true;generation++;return{success:true};},
            depositItem:async()=>{if(o.depositFails)return{success:true};const i=inv.findIndex(i=>i.id===1779);if(i>=0){banked+=inv[i].count;inv.splice(i,1);}generation++;return{success:true};},
            closeInterface:async()=>{open=false;return{success:true};}}};
    const walk=async(a:number,b:number,_tol:number,stop:()=>boolean,remaining:number)=>{
        // Put a pick at CAP, in either source-verified SDK bank-visibility state.
        if(a===2744&&b===3445){x=2744;z=3445;return true;}
        walks.push({remaining,stopped:stop()});
        if(o.capOnFirstReturn&&walks.length===1){tick=2;return false;}
        if(o.stopOnReturn)stopped=true;if(o.dieOnReturn){dead=true;for(const f of [...listeners])f();}
        if(o.endOnReturn){end();await Promise.resolve();}
        if(o.exhaust){tick+=remaining;return false;}
        if(stop()||o.walkFails||o.firstWalkFails&&walks.length===1)return false;x=a;z=b;return true;
    };
    x=2744;z=3445;
    return{s:s as Session,inv,walk,stop:()=>stopped,walks,cargo:async()=>{cargoCalls++;if(o.cargoLeftover)inv.push({id:1780,name:'Flax',count:1,slot:2});if(o.cargoTransfer){banked=0;generation++;}},
        directSdkBankAtVisible:async()=>{x=2735;z=3483;return s.bot.openBank();},
        stats:()=>({banked,openCalls,autoWalks,cargoCalls}),dispose:()=>clearInterval(timer)};
}

test('CAP at field with no bank visible still returns within separate budget and proves deposit/held0',async()=>{
    const f=fixture();try{const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false});
        expect(r).toMatchObject({ok:true,picks:1,banked:1,held:0,finalBankConfirmed:true});expect(r.ticks).toBeGreaterThanOrEqual(1);
        expect(f.walks).toEqual([{remaining:240,stopped:false}]);expect(f.stats()).toMatchObject({banked:11,openCalls:1,autoWalks:0,cargoCalls:1});
        expect(f.inv.map(i=>[i.id,i.count])).toEqual([[995,80],[333,2]]);
    }finally{f.dispose();}
});
test('visible-bank SDK auto-walk remains available; bounded final return also proves nearby-bank case',async()=>{
    const f=fixture();try{expect((await f.directSdkBankAtVisible()).success).toBe(true);expect(f.stats().autoWalks).toBe(1);
        const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false});expect(r.ok).toBe(true);expect(r.held).toBe(0);
    }finally{f.dispose();}
});
test('failed return never opens distant SDK bank or reports held flax as successful',async()=>{
    const f=fixture({walkFails:true});try{const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false});expect(r.ok).toBe(false);expect(r.held).toBe(1);expect(r.finalBankConfirmed).toBe(false);expect(f.stats().openCalls).toBe(0);}finally{f.dispose();}
});
test('first unconfirmed production bank stops gathering and allows only one final salvage attempt',async()=>{
    const f=fixture({walkFails:true});try{const r=await runFlax(f.s,{cap:15000,bankAt:1,walk:f.walk,cargo:f.cargo,waiting:()=>false});
        expect(r.ok).toBe(false);expect(r.failure).toBe('no flax progress: production bank unconfirmed');
        expect(r.picks).toBe(1);expect(r.held).toBe(1);expect(f.walks.length).toBe(2);expect(r.ticks).toBeLessThan(10);
    }finally{f.dispose();}
});
test('successful final salvage cannot turn an earlier production bank failure into success',async()=>{
    const f=fixture({firstWalkFails:true});try{const r=await runFlax(f.s,{cap:15000,bankAt:1,walk:f.walk,cargo:f.cargo,waiting:()=>false});
        expect(r.ok).toBe(false);expect(r.finalBankConfirmed).toBe(true);expect(r.held).toBe(0);expect(r.banked).toBe(1);
        expect(r.failure).toBe('no flax progress: production bank unconfirmed');expect(f.walks.length).toBe(2);
    }finally{f.dispose();}
});
test('production CAP reached during a bank return proceeds to final cleanup without inventing a bank error',async()=>{
    const f=fixture({capOnFirstReturn:true});try{const r=await runFlax(f.s,{cap:2,bankAt:1,walk:f.walk,cargo:f.cargo,waiting:()=>false});
        expect(r.ok).toBe(true);expect(r.failure).toBe('');expect(r.held).toBe(0);expect(r.finalBankConfirmed).toBe(true);expect(f.walks.length).toBe(2);
    }finally{f.dispose();}
});
test('confirmed owned courier transfer may lower final bank stock without invalidating deposited output',async()=>{
    const f=fixture({cargoTransfer:true});try{const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false});
        expect(r.ok).toBe(true);expect(r.banked).toBe(1);expect(r.held).toBe(0);expect(r.finalBankConfirmed).toBe(true);expect(f.stats().banked).toBe(0);
    }finally{f.dispose();}
});
test('dispatch success without real deposit, unknown bank data or leftover courier notes cannot claim completion',async()=>{
    for(const option of [{depositFails:true},{stale:true},{cargoLeftover:true}]){const f=fixture(option);try{const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false});expect(r.ok).toBe(false);expect(r.finalBankConfirmed).toBe(false);}finally{f.dispose();}}
});
test('cleanup honors user stop, death, ended session and own deadline without opening bank',async()=>{
    for(const option of [{stopOnReturn:true},{dieOnReturn:true},{endOnReturn:true},{exhaust:true}]){const f=fixture(option);try{const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false,stop:f.stop});expect(r.ok).toBe(false);expect(r.held).toBe(1);expect(f.stats().openCalls).toBe(0);expect(r.ticks).toBeLessThanOrEqual(241);}finally{f.dispose();}}
});
test('a start on another floor goes to the field with the shared walker first, and a failed approach ends with its cause',async()=>{
    const upstairs=(f:ReturnType<typeof fixture>,until:()=>boolean)=>{const real=f.s.sdk.getState.bind(f.s.sdk);
        (f.s.sdk as any).getState=()=>{const st=real()!;return until()?st:{...st,player:{...st.player,worldX:2575,worldZ:3269,level:1}};};};
    const f=fixture();try{let arrived=false,calls=0;upstairs(f,()=>arrived);
        const r=await runFlax(f.s,{cap:1,bankAt:28,walk:f.walk,cargo:f.cargo,waiting:()=>false,approach:async()=>{calls++;arrived=true;return true;}});
        expect(calls).toBe(1);expect(r.ok).toBe(true);expect(r.picks).toBe(1);expect(r.held).toBe(0);
    }finally{f.dispose();}
    const g=fixture();try{upstairs(g,()=>false);
        const r=await runFlax(g.s,{cap:50,bankAt:28,walk:g.walk,cargo:g.cargo,waiting:()=>false,approach:async()=>false});
        expect(r.ok).toBe(false);expect(r.picks).toBe(0);expect(r.failure).toBe('no flax progress: no route to the flax field');
    }finally{g.dispose();}
});
