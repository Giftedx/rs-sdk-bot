// Stage a fresh owned supplier at Draynor with its starter kit safely banked.
import { openBot, finish } from '../packages/core/src/bot';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';

const s=await openBot(process.argv[2]!);
try {
    const start=s.tick();
    const first=s.sdk.getState()?.player;
    if(first && first.worldX<3160 && first.worldZ<3130) {
        await waitUntil(s,st=>(st?.nearbyNpcs?.length??0)>0,{timeoutTicks:30});
        const r=await s.bot.skipTutorial();
        if(!r.success) throw new Error(`tutorial: ${r.message}`);
    }
    await waitTicks(s,3);
    const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    let hpMin=hp();
    const off=s.onTick(()=>{hpMin=Math.min(hpMin,hp());});
    try {
        const p=s.sdk.getState()?.player;
        if(!p || p.level!==0 || p.worldX<3000 || p.worldX>3280 || p.worldZ<3180 || p.worldZ>3300)
            throw new Error('requires Lumbridge/Draynor ground-floor start');
        await s.direct({type:'closeModal',reason:'SDK'});
        const points=p.worldX>3150 ? [
            {x:3218,z:3256,tol:2},{x:3180,z:3258,tol:3},{x:3140,z:3270,tol:2},
            {x:3100,z:3270,tol:2},{x:3089,z:3266,tol:2},{x:3092,z:3250,tol:1},{x:3092,z:3243,tol:2}
        ] : [{x:3092,z:3250,tol:1},{x:3092,z:3243,tol:2}];
        const r=await walkPath(await sessionWalker(s),points,{maxTicks:600,stop:()=>hp()<7});
        if(!r.ok) throw new Error(`entry ${r.detail}; hpMin=${hpMin}`);
        if(!(await s.bot.openBank()).success) throw new Error('entry bank failed');
        const ids=new Set(s.sdk.getInventory().filter(i=>!/^(coins|bread|shrimps)$/i.test(i.name)).map(i=>i.id));
        for(const id of ids) {
            const item=s.sdk.getInventory().find(i=>i.id===id);
            if(item) await s.bot.depositItem(item,-1);
        }
        await waitTicks(s,1);
        const bank=s.sdk.getState()?.bank?.items??[];
        const remaining=s.sdk.getInventory();
        if(remaining.some(i=>!/^(coins|bread|shrimps)$/i.test(i.name))) throw new Error('starter kit deposit incomplete');
        console.log('ENTRY '+JSON.stringify({ticks:s.tick()-start,hpMin,held:remaining.map(i=>({id:i.id,name:i.name,count:i.count})),bank:bank.map(i=>({id:i.id,name:i.name,count:i.count}))}));
        await s.bot.closeBank();
        await finish([s],hpMin>=7,`supplier staged ticks=${s.tick()-start} hpMin=${hpMin}`);
    } finally {off();}
} catch(e) {await finish([s],false,String(e));}
