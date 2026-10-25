import {test,expect} from 'bun:test';
import {runPrayer,planPrayer} from './train-prayer';
import {levelForXp,xpForLevel} from '../packages/planner/src/curve';
import type {Session} from '../packages/core/src/inprocess';

function fixture(options:{bones?:number;rawXp?:number;rate?:number;missingOption?:boolean;stalled?:boolean;stopAfter?:number;offFails?:boolean;queuedStopLateUi?:boolean;queuedStopAt?:number}={}){
    let tick=0,rawXp=options.rawXp??0,generation=0,open=false,active=false,burials=0,requests=0,toggles=0,stopRequested=false,inFlight=false,lateUi=false,uiAt=Infinity,applyAt=Infinity,applyPending:(()=>void)|undefined,uiDismissals=0,blockedBankAttempts=0;
    const listeners=new Set<()=>void>(),queued:(()=>void)[]=[];
    const inventory:any[]=[{id:995,name:'Coins',count:178,slot:0},{id:333,name:'Trout',count:1,slot:1},{id:333,name:'Trout',count:1,slot:2},{id:946,name:'Knife',count:1,slot:3}];
    const equipment:any[]=[{id:1277,name:'Bronze sword',count:1,slot:3},{id:1171,name:'Wooden shield',count:1,slot:5}];
    const bank:any[]=[{id:526,name:'Bones',count:options.bones??222,slot:0},{id:527,name:'Bones',count:100,slot:1},{id:329,name:'Salmon',count:378,slot:2}];
    const state=()=>({player:{worldX:2655,worldZ:3283,level:0,lifeId:1,respawnCount:0},bank:{isOpen:open,items:bank},dialog:{isOpen:lateUi,options:lateUi?[{index:1,text:'Continue'}]:[]},interface:{isOpen:open||lateUi},inventory,equipment,prayers:{activePrayers:Array.from({length:15},(_,i)=>i===14&&active),prayerPoints:Math.max(1,levelForXp(rawXp/10)),prayerLevel:levelForXp(rawXp/10)}});
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
    return{s,inventory,bank,equipment,rawXp:()=>rawXp,burials:()=>burials,toggles:()=>toggles,uiDismissals:()=>uiDismissals,blockedBankAttempts:()=>blockedBankAttempts,dispose:()=>clearInterval(timer),stop:()=>stopRequested||options.stopAfter!==undefined&&burials>=options.stopAfter};
}
const options={cap:1500,maximum:175,reserve:6};
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
