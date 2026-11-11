import {test,expect} from 'bun:test';
import {runPrayer,planPrayer,prayerOptions,prayerBank,BONE_XP} from './train-prayer';
import {levelForXp,xpForLevel} from '../packages/planner/src/curve';
import type {Session} from '../packages/core/src/inprocess';

function fixture(options:{position?:{worldX:number;worldZ:number;level:number};bones?:number;rawXp?:number;rate?:number;missingOption?:boolean;stalled?:boolean;stopAfter?:number;offFails?:boolean;queuedStopLateUi?:boolean;queuedStopAt?:number}={}){
    let tick=0,rawXp=options.rawXp??0,generation=0,open=false,active=false,burials=0,requests=0,toggles=0,stopRequested=false,inFlight=false,lateUi=false,uiAt=Infinity,applyAt=Infinity,applyPending:(()=>void)|undefined,uiDismissals=0,blockedBankAttempts=0;
    const listeners=new Set<()=>void>(),queued:(()=>void)[]=[];
    const inventory:any[]=[{id:995,name:'Coins',count:178,slot:0},{id:333,name:'Trout',count:1,slot:1},{id:333,name:'Trout',count:1,slot:2},{id:946,name:'Knife',count:1,slot:3}];
    const equipment:any[]=[{id:1277,name:'Bronze sword',count:1,slot:3},{id:1171,name:'Wooden shield',count:1,slot:5}];
    const bank:any[]=[{id:526,name:'Bones',count:options.bones??222,slot:0},{id:527,name:'Bones',count:100,slot:1},{id:329,name:'Salmon',count:378,slot:2}];
    const player={worldX:2655,worldZ:3283,level:0,...options.position,lifeId:1,respawnCount:0};
    const state=()=>({player,bank:{isOpen:open,items:bank},dialog:{isOpen:lateUi,options:lateUi?[{index:1,text:'Continue'}]:[]},interface:{isOpen:open||lateUi},inventory,equipment,prayers:{activePrayers:Array.from({length:15},(_,i)=>i===14&&active),prayerPoints:Math.max(1,levelForXp(rawXp/10)),prayerLevel:levelForXp(rawXp/10)}});
    const timer=setInterval(()=>{tick++;if(tick>=applyAt){applyPending?.();applyAt=Infinity;inFlight=false;uiAt=tick+1;}if(tick>=uiAt){lateUi=true;uiAt=Infinity;}for(const q of queued.splice(0))q();for(const cb of listeners)cb();},1);
    const s={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
        bankObservation:()=>open?{generation,at:tick,items:bank}:null,
        sdk:{getState:state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkillXp:()=>Math.floor(rawXp/10),getSkill:(name:string)=>({level:name==='Hitpoints'?70:levelForXp(rawXp/10),baseLevel:name==='Hitpoints'?70:levelForXp(rawXp/10)}),
            sendUseItem:async(slot:number,op:number)=>{requests++;const item=inventory.find(i=>i.slot===slot);expect(open).toBe(false);expect(item.id).toBe(526);expect(op).toBe(1);const apply=()=>{if(options.stalled)return;inventory.splice(inventory.indexOf(item),1);rawXp+=options.rate??1125;burials++;};if(options.queuedStopLateUi&&requests===(options.queuedStopAt??1)){stopRequested=true;inFlight=true;applyPending=apply;applyAt=tick+3;}else queued.push(apply);return{success:true};}},
        direct:async(action:any)=>{expect(action.type).toBe('togglePrayer');expect(action.prayerIndex).toBe(14);toggles++;queued.push(()=>{if(active&&options.offFails)return;active=!active;});return{success:true};},
        bot:{openBank:async()=>{if(inFlight||lateUi||uiAt!==Infinity){blockedBankAttempts++;return{success:true,message:'dispatch or unrelated modal'};}open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},dismissBlockingUI:async()=>{if(lateUi){lateUi=false;uiDismissals++;}},
            withdrawItem:async(item:any,n:number)=>{expect(item.id).toBe(526);item.count-=n;for(let i=0;i<n;i++)inventory.push({id:526,name:'Bones',count:1,slot:Math.max(...inventory.map(i=>i.slot),-1)+1,optionsWithIndex:options.missingOption?[]:[{text:'Bury',opIndex:1}]});generation++;return{success:true};},
            depositItem:async(item:any)=>{expect(item.id).toBe(526);const n=inventory.filter(i=>i.id===526).length;bank[0].count+=n;for(let i=inventory.length-1;i>=0;i--)if(inventory[i].id===526)inventory.splice(i,1);generation++;return{success:true};}}
    } as unknown as Session;
    return{s,player,inventory,bank,equipment,rawXp:()=>rawXp,burials:()=>burials,toggles:()=>toggles,uiDismissals:()=>uiDismissals,blockedBankAttempts:()=>blockedBankAttempts,dispose:()=>clearInterval(timer),stop:()=>stopRequested||options.stopAfter!==undefined&&burials>=options.stopAfter};
}
const options={cap:1500,maximum:175,reserve:6};
test('CLI target is optional and existing43 callers retain their defaults',()=>{
    expect(prayerOptions(['bun','script','any'],{})).toEqual({target:43,cap:1500,maximum:175,reserve:6});
    expect(prayerOptions(['bun','script','Bigchopper','60'],{CAP:'5000',MAX_BURY:'600',BONE_RESERVE:'384'})).toEqual({target:60,cap:5000,maximum:600,reserve:384});
    expect(prayerOptions(['bun','script','any'],{TARGET_LEVEL:'60'}).target).toBe(60);
    expect(prayerBank({worldX:3237,worldZ:3296,level:0})).toEqual({x:3092,z:3243});
    expect(()=>prayerBank({worldX:3237,worldZ:3296,level:1})).toThrow('unsupported ordinary bank entry');
});
test('ordinary entry uses bounded travel and requires observed bank arrival before spending',async()=>{
    const f=fixture({rawXp:196000,position:{worldX:3237,worldZ:3296,level:0}});
    try{let calls=0;const r=await runPrayer(f.s,options,async(s,points,cap,stop)=>{
        calls++;expect(s).toBe(f.s);expect(cap).toBe(400);expect(stop()).toBe(false);expect(f.burials()).toBe(0);
        expect(points.at(-1)).toEqual({x:3092,z:3243,tol:1});f.player.worldX=3092;f.player.worldZ=3243;return true;
    });expect(calls).toBe(1);expect(r).toMatchObject({ok:true,buried:1,preserved:true});}finally{f.dispose();}
});
test('a travel success reply without arrival refuses with zero consumption',async()=>{
    const f=fixture({position:{worldX:3237,worldZ:3296,level:0}});
    try{const r=await runPrayer(f.s,options,async()=>true);expect(r.ok).toBe(false);expect(r.attempts).toBe(0);expect(r.failure).toContain('ordinary bank travel failed');}finally{f.dispose();}
});
test('Prayer60 demand uses the server curve and retains384 of973 owned bones',()=>{
    expect(planPrayer(973,0,600,384,60)).toBe(589);
    expect(planPrayer(973,xpForLevel(60),600,384,60)).toBe(0);
});
test('owned973bones reach60 with589 exact debits and384reserved',async()=>{
    const f=fixture({bones:973});try{const r=await runPrayer(f.s,{target:60,cap:5000,maximum:600,reserve:384});expect(r).toMatchObject({ok:true,buried:589,consumed:589,boneBank:384,finalLevel:60,finalXp:66262,xpGain:66262,preserved:true,toggledOn:true,toggledOff:true});}finally{f.dispose();}
},20_000); // 589 simulated burials: about 5 s on the Windows PC, past bun's 5 s default
test('insufficient stock refuses before the first burial',async()=>{
    const f=fixture({bones:972});try{const r=await runPrayer(f.s,{target:60,cap:5000,maximum:600,reserve:384});expect(r.ok).toBe(false);expect(r.buried).toBe(0);expect(r.preserved).toBe(true);expect(r.failure).toBe('no prayer progress: insufficient owned bones: need 589, available 588');}finally{f.dispose();}
});
test('stop during fourth queued Bury settles450XP, clears later Continue and banks all leftovers without a fifth Bury',async()=>{
    const f=fixture({queuedStopLateUi:true,queuedStopAt:4});try{const r=await runPrayer(f.s,{...options,stop:f.stop});expect(r).toMatchObject({ok:false,targetMet:false,buried:4,attempts:4,consumed:4,boneBank:218,heldBones:0,xpGain:450,preserved:true,stop:'stop-file'});expect(f.burials()).toBe(4);expect(f.rawXp()).toBe(4500);expect(f.uiDismissals()).toBe(1);expect(f.blockedBankAttempts()).toBe(1);}finally{f.dispose();}
});
test('server curve and half-XP planning require175 owned bones for Prayer43',()=>{
    expect(xpForLevel(43)).toBe(19684);expect(planPrayer(222,0)).toBe(175);expect(planPrayer(180,0)).toBe(174);expect(planPrayer(222,19684)).toBe(0);
});
test('175actual Bury1 debits reach43 with112/113 XP alternation,47bank and observed PFM ON then OFF',async()=>{
    const f=fixture();try{const r=await runPrayer(f.s,options);expect(r).toMatchObject({ok:true,targetMet:true,buried:175,consumed:175,attempts:175,initialBones:222,boneBank:47,heldBones:0,finalLevel:43,finalXp:19687,xpGain:19687,firstBoneXp:112,rateVerified:true,toggledOn:true,toggledOff:true,preserved:true,hpMin:70,stop:'target-level'});expect(f.rawXp()).toBe(196875);expect(f.toggles()).toBe(2);expect(f.bank.find(i=>i.id===527).count).toBe(100);expect(f.inventory.map(i=>[i.id,i.count])).toEqual([[995,178],[333,1],[333,1],[946,1]]);}finally{f.dispose();}
});
test('unexpected first bone rate consumes only one, banks every remainder and never toggles protection',async()=>{
    const f=fixture({rate:45});try{const r=await runPrayer(f.s,options);expect(r).toMatchObject({ok:false,buried:1,consumed:1,attempts:1,boneBank:221,preserved:true,firstBoneXp:4,targetMet:false});expect(r.failure).toContain('unexpected first bone XP');expect(f.toggles()).toBe(0);}finally{f.dispose();}
});
test('already43 never buries another bone and still proves protection ON/OFF',async()=>{
    const f=fixture({rawXp:196875});try{expect(await runPrayer(f.s,options)).toMatchObject({ok:true,buried:0,consumed:0,boneBank:222,toggledOn:true,toggledOff:true});expect(f.burials()).toBe(0);}finally{f.dispose();}
});
test('near43 stops on actual XP goal after one bone and returns unused batch; no extra burial',async()=>{
    const f=fixture({rawXp:196000});try{expect(await runPrayer(f.s,options)).toMatchObject({ok:true,buried:1,attempts:1,boneBank:221,finalLevel:43});}finally{f.dispose();}
});
test('stop request cleans up raw bones without touching notes, food, cash or equipment',async()=>{
    const f=fixture({stopAfter:2});try{expect(await runPrayer(f.s,{...options,stop:f.stop})).toMatchObject({ok:false,buried:2,consumed:2,boneBank:220,heldBones:0,preserved:true,stop:'stop-file'});}finally{f.dispose();}
});
test('missing observed Bury option and unchanged input each stop without repeated blind dispatch',async()=>{
    for(const missingOption of [true,false]){const f=fixture({missingOption,stalled:!missingOption});try{const r=await runPrayer(f.s,options);expect(r.ok).toBe(false);expect(r.buried).toBe(0);expect(r.attempts).toBe(missingOption?0:1);expect(r.boneBank).toBe(222);expect(r.preserved).toBe(true);}finally{f.dispose();}}
});
test('failure to observe protection OFF cannot report goal fulfilled',async()=>{
    const f=fixture({rawXp:196875,offFails:true});try{const r=await runPrayer(f.s,options);expect(r.ok).toBe(false);expect(r.toggledOn).toBe(true);expect(r.toggledOff).toBe(false);expect(r.failure).toContain('OFF unobserved');}finally{f.dispose();}
});
test('BONE_ID=532 plans owned big bones at375XP and banks at Varrock West',()=>{
    expect(prayerOptions(['bun','script','any','90'],{BONE_ID:'532',MAX_BURY:'1500'})).toEqual({target:90,cap:1500,maximum:1500,reserve:6,bone:532});
    expect(BONE_XP[532]).toBe(375);expect(BONE_XP[536]).toBe(1800);
    expect(planPrayer(1400,xpForLevel(74),1500,6,90,375)).toBe(Math.ceil((xpForLevel(90)-xpForLevel(74))/375));
    expect(prayerBank({worldX:3186,worldZ:3437,level:0})).toEqual({x:3185,z:3436});
    expect(prayerBank({worldX:2620,worldZ:3330,level:0})).toEqual({x:2619,z:3332});
});
test('an unknown bone id refuses before any bank work',async()=>{
    const f=fixture({});try{await expect(runPrayer(f.s,{...options,bone:999})).rejects.toThrow('unsupported bone id');expect(f.burials()).toBe(0);}finally{f.dispose();}
});
test('BURY_HELD buries the held bones above the reserve and is ok when they run out, with or without a level',async()=>{
    expect(prayerOptions(['bun','script','any','99'],{BURY_HELD:'1'})).toEqual({target:99,cap:1500,maximum:1000000,reserve:6,held:true});
    const f=fixture({bones:60,rawXp:196875});
    try{const r=await runPrayer(f.s,{target:99,cap:5000,maximum:1000000,reserve:6,held:true});
        expect(r).toMatchObject({ok:true,targetMet:false,buried:54,boneBank:6,heldBones:0,preserved:true,stop:'input-insufficient',failure:'-'});
        expect(r.gained).toBeGreaterThan(0);}finally{f.dispose();}
    const g=fixture({bones:60,rawXp:196875});
    try{expect(await runPrayer(g.s,{target:99,cap:5000,maximum:1000000,reserve:6})).toMatchObject({ok:false,buried:0});}finally{g.dispose();}
    // At Prayer 97 the 54 bones are 6,075 XP, far short of a level: still ok, every bury's XP was checked.
    const h=fixture({bones:60,rawXp:xpForLevel(97)*10});
    try{expect(await runPrayer(h.s,{target:99,cap:5000,maximum:1000000,reserve:6,held:true})).toMatchObject({ok:true,gained:0,buried:54,boneBank:6,xpGain:6075,stop:'input-insufficient',failure:'-'});}finally{h.dispose();}
    // With nothing above the reserve there is nothing to prove.
    const e=fixture({bones:6,rawXp:196875});
    try{expect(await runPrayer(e.s,{target:99,cap:5000,maximum:1000000,reserve:6,held:true})).toMatchObject({ok:false,buried:0});}finally{e.dispose();}
});
test('the market knights, the cow field and the Gnome battlefield walk to the Ardougne north bank; the south bank stays its own entry',()=>{
    expect(prayerBank({worldX:2654,worldZ:3304,level:0})).toEqual({x:2619,z:3332});
    expect(prayerBank({worldX:2655,worldZ:3284,level:0})).toEqual({x:2655,z:3283});
    expect(prayerBank({worldX:2525,worldZ:3242,level:0})).toEqual({x:2619,z:3332});
    expect(()=>prayerBank({worldX:2800,worldZ:3440,level:0})).toThrow('unsupported ordinary bank entry');
});
