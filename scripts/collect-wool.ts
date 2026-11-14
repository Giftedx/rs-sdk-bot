// Collect wool, keep a raw reserve, and spin the rest. Uses owned storage only.
import { openBot, finish, getWorld, accountOf, countItems } from '../packages/core/src/bot';
import { goTo, walkPath, sessionWalker } from '../packages/core/src/walk';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { bankCargo } from '../packages/core/src/cargo';

const s = await openBot(process.argv[2]!);
try {
    const CAP = Number(process.env.CAP ?? 15000);
    const first = s.sdk.getState()?.player;
    if (first && first.worldX < 3160 && first.worldZ < 3130) {
        await waitUntil(s, st => (st?.nearbyNpcs?.length ?? 0) > 0, { timeoutTicks: 30 });
        const tut = await s.bot.skipTutorial();
        if (!tut.success) throw new Error(`tutorial: ${tut.message}`);
    }
    await waitTicks(s, 3);
    const t0 = s.tick();
    let ended = false, died = false, gathered = 0, spun = 0, trips = 0, rawBanked = 0;
    const initial = s.sdk.getState()?.player;
    void s.ended.then(()=>{ ended=true; });
    const over = () => ended || died || s.tick()-t0 >= CAP;
    const off = s.onTick(()=>{
        const p=s.sdk.getState()?.player;
        if (p?.isDead || (p?.respawnCount??0)>(initial?.respawnCount??0) || (initial?.lifeId !== undefined && (p?.lifeId ?? initial.lifeId) !== initial.lifeId)) died=true;
    });
    const inv = () => s.sdk.getInventory();
    const cnt = (re: RegExp) => countItems(s,re);
    const walk = async (x:number,z:number,level=0) => {
        if(over()) throw new Error('worker ended or cap');
        const p=s.sdk.getState()?.player;
        if(p?.level!==level) {
            const r=await goTo(s,await getWorld(),{x,z,level},accountOf(s),{legTimeoutTicks:100});
            if(!r.ok) throw new Error(`route ${x},${z},${level}: ${r.detail}`);
        } else {
            const r=await walkPath(await sessionWalker(s),[{x,z,tol:2}],{stop:over});
            if(!r.ok) throw new Error(`walk: ${r.detail}`);
        }
    };
    const bank = async () => {
        // Avoid the dark wizards south of Draynor. Rev 289 has no castle bank.
        if(s.sdk.getState()?.player?.level !== 0) await walk(3218,3256,0);
        const px=s.sdk.getState()?.player?.worldX??0;
        if(px>3150) for(const [x,z] of [[3218,3256],[3180,3258],[3140,3270],[3100,3270],[3089,3266],[3092,3250]]) await walk(x!,z!);
        await walk(3092,3243);
        const b=await s.bot.openBank();
        if(!b.success) throw new Error(`bank: ${b.message}`);
        for(const id of new Set(inv().filter(i=>!/^(shears|bread|shrimps)$/i.test(i.name)).map(i=>i.id))) {
            const item=inv().find(i=>i.id===id);
            if(item) await s.bot.depositItem(item,-1);
        }
        await waitTicks(s,1);
        rawBanked=s.sdk.getState()?.bank?.items.find(i=>/^wool$/i.test(i.name))?.count??0;
        await bankCargo(s,[/^wool$/i,/^ball of wool$/i]);
        await s.bot.closeBank();
        trips++;
        console.log(`MILESTONE wool bank gathered=${gathered} spun=${spun} rawBanked=${rawBanked} trips=${trips}`);
    };
    if(!inv().some(i=>/^shears$/i.test(i.name))) {
        // The initial tool trip must use the same northern corridor as later wool trips.
        // Direct Draynor -> Lumbridge crosses the southern threat area.
        if((s.sdk.getState()?.player?.worldX??0)<3150)
            for(const [x,z] of [[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258],[3218,3256]]) await walk(x!,z!);
        await walk(3222,3218);
        for(let i=0;i<8 && cnt(/^coins$/i)<5;i++) {
            if((s.sdk.getSkill('Hitpoints')?.level??0)<5) throw new Error('low HP during tool bootstrap');
            await s.bot.pickpocketNpc(/^man$/i);
            await waitTicks(s,2);
        }
        await walk(3211,3247);
        const shop=await s.bot.openShop(/^shop keeper$/i);
        if(!shop.success) throw new Error(`tool shop: ${shop.message}`);
        const buy=await s.bot.buyFromShop(/^shears$/i,1);
        await s.bot.closeShop();
        if(!buy.success) throw new Error(`shears: ${buy.message}`);
    }
    await bank();
    while(!over() && trips < Number(process.env.MAX_TRIPS ?? Infinity)) {
        if((s.sdk.getState()?.player?.worldX??0)<3150)
            for(const [x,z] of [[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258]]) await walk(x!,z!);
        await walk(3200,3270,0);
        let misses=0;
        while(inv().length<28 && !over()) {
            const sheep=s.sdk.getState()?.nearbyNpcs.filter(n=>n.id===43).sort((a,b)=>a.distance-b.distance)[0];
            const shears=inv().find(i=>/^shears$/i.test(i.name));
            if(!shears) throw new Error('missing shears');
            if(!sheep) {
                // Shorn sheep regain wool after 100 ticks. Allow one full regrowth.
                const woolly=await waitUntil(s,st=>st.nearbyNpcs.some((n:{id:number})=>n.id===43),{timeoutTicks:120});
                if(!woolly) throw new Error('no woolly sheep within 120 ticks');
                continue;
            }
            const before=cnt(/^wool$/i);
            if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen)
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            const messageTick=s.sdk.getState()?.gameMessages.at(-1)?.tick??-1;
            await s.sdk.sendUseItemOnNpc(shears.slot,sheep.index);
            await waitUntil(s,st=>cnt(/^wool$/i)>before || st.gameMessages.some((m:{tick:number;text:string})=>
                m.tick>messageTick && /sheep manages to get away|already been shorn/i.test(m.text)),{timeoutTicks:12});
            const got=cnt(/^wool$/i)>before;
            if(got) { gathered++; misses=0; } else if(++misses>20) throw new Error('shearing made no progress');
        }
        console.log(`MILESTONE shear t=${s.tick()-t0} gathered=${gathered} held=${cnt(/^wool$/i)}`);
        if(rawBanked<25) { await bank(); continue; }
        await walk(3209,3213,1);
        let failed=0;
        while(cnt(/^wool$/i)>0 && !over()) {
            const wheel=s.sdk.findNearbyLoc(/^spinning wheel$/i);
            const wool=inv().find(i=>/^wool$/i.test(i.name));
            if(!wheel||!wool) throw new Error('missing wheel or wool');
            const before=cnt(/^ball of wool$/i);
            if (s.sdk.getState()?.dialog?.isOpen || s.sdk.getState()?.modalOpen)
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            await s.sdk.sendUseItemOnLoc(wool.slot,wheel.x,wheel.z,wheel.id);
            const made=await waitUntil(s,()=>cnt(/^ball of wool$/i)>before,{timeoutTicks:8});
            // The wheel holds the player for 3 ticks after the ball appears (p_delay(2), spinning.rs2). Wool sent in that time is refused with no
            // message, and the wait above then ran its whole 8 ticks: 9 ticks for each ball.
            if(made) { spun++; failed=0; await waitTicks(s,3); } else if(++failed>4) throw new Error('spinning made no progress');
        }
        console.log(`MILESTONE spin t=${s.tick()-t0} spun=${spun}`);
        await bank();
    }
    off();
    await finish([s],gathered>0&&spun>0&&!died&&!ended,`ticks=${s.tick()-t0} gathered=${gathered} spun=${spun} rawBanked=${rawBanked} trips=${trips} died=${died}`);
} catch(e) { await finish([s],false,String(e)); }
