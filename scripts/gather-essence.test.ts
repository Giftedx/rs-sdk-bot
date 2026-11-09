import { test, expect, spyOn } from 'bun:test';
import * as walking from '../packages/core/src/walk';
import { isEssence, dist, essenceTeleportProblem, runEssenceGatherer, mineEssenceBatch, upgradeOwnedEssencePick, essencePickWieldLevel } from './gather-essence';

for(const mode of ['stalled','productive','stopped','event-stalled','last-tick']) test(`essence output budget: ${mode}`,async()=>{
    let tick=0,held=0,output=0,clicks=0;
    const callbacks=new Set<()=>void>();
    const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
    const timer=setInterval(()=>{tick++;if(mode==='productive'&&tick%20===0||mode==='last-tick'&&tick===10)held+=3;for(const cb of [...callbacks])cb();},1);
    try{
        const run=mineEssenceBatch(s,{count:()=>held,full:()=>held>=12,stop:()=>['stopped','last-tick'].includes(mode)&&tick>=10,
            busy:()=>mode==='event-stalled',click:async()=>{clicks++;return {success:true};},gain:n=>{output+=n;}});
        if(mode.includes('stalled')){await expect(run).rejects.toThrow('no observed output');expect(tick).toBeLessThanOrEqual(62);expect(output).toBe(0);}
        else{await run;expect(output).toBe(mode==='productive'?12:mode==='last-tick'?3:0);}
        expect(clicks).toBeLessThan(10);
    }finally{clearInterval(timer);}
},2000);

test('isEssence identifies Rune essence and Pure essence IDs', () => {
    expect(isEssence(1436)).toBe(true); // Rune essence
    expect(isEssence(7936)).toBe(true); // Pure essence
    expect(isEssence(995)).toBe(false);  // Coins
    expect(isEssence(1265)).toBe(false); // Bronze pickaxe
});

test('dist calculates Chebyshev tile distance accurately', () => {
    expect(dist({ x: 3253, z: 3420 }, { worldX: 3253, worldZ: 3402 })).toBe(18);
    expect(dist({ x: 2891, z: 4847 }, { x: 2885, z: 4850 })).toBe(6);
});

test('arrival in the mine wins over stale or unrelated Rune Mysteries chat', () => {
    const refusal={text:'You need to have completed the Rune Mysteries Quest to use this feature.',tick:100,observationId:20};
    expect(essenceTeleportProblem(true,[refusal],10)).toBeNull();
    expect(essenceTeleportProblem(false,[refusal],20)).toBe('Teleport to essence mine timed out');
    expect(essenceTeleportProblem(false,[{...refusal,text:'You need to complete the Rune Mysteries quest to choose that option.'}],10)).toBe('Teleport to essence mine timed out');
});

test('only a new actual Aubury refusal reports the quest prerequisite', () => {
    const refusal={text:'You need to have completed the Rune Mysteries Quest to use this feature.',tick:100,observationId:20};
    expect(essenceTeleportProblem(false,[refusal],19)).toBe('Rune Mysteries quest required: Aubury refused teleport');
    expect(essenceTeleportProblem(false,[{text:'Quest complete: Rune Mysteries',tick:100,observationId:20}],19)).toBe('Teleport to essence mine timed out');
});

test('an operator stop is not reported as a completed essence run', async () => {
    const s:any={tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},sdk:{
        getState:()=>({player:{worldX:3253,worldZ:3420,level:0}}),getInventory:()=>[],
        getEquipment:()=>[{id:1265,count:1}],getSkill:(name:string)=>({level:name==='Hitpoints'?10:91}),getSkillXp:()=>1000,
    }};
    expect((await runEssenceGatherer(s,{cap:100,bankAt:28,stop:()=>true})).ok).toBe(false);
});

function bankModel(mode:'rejected'|'stale'|'observed') {
    let tick=0,generation=1;
    const state:any={player:{worldX:3253,worldZ:3420,level:0},bank:{isOpen:true,items:[{id:1436,name:'Rune essence',count:100}]}};
    let inventory:any[]=Array.from({length:28},(_,slot)=>({id:1436,name:'Rune essence',count:1,slot}));
    const s:any={tick:()=>tick,ended:new Promise(()=>{}),
        onTick:(fn:()=>void)=>{const timer=setInterval(()=>{tick++;fn();},1);return()=>clearInterval(timer);},
        bankObservation:()=>({generation,at:tick,items:state.bank.items}),
        sdk:{getState:()=>state,getInventory:()=>inventory,getEquipment:()=>[{id:1265,count:1}],getSkill:(name:string)=>({level:name==='Hitpoints'?10:1}),getSkillXp:()=>0},
        bot:{dismissBlockingUI:async()=>{},depositItem:async()=>{if(mode==='rejected')return{success:false};inventory=[];if(mode==='observed'){state.bank.items[0].count+=28;generation++;}return{success:true};},closeBank:async()=>{state.bank.isOpen=false;tick++;}},
    };
    return s;
}

test('a rejected deposit cannot turn the carried essence count into claimed bank output',async()=>{
    const r=await runEssenceGatherer(bankModel('rejected'),{cap:1,bankAt:28});
    expect(r.ok).toBe(false);expect(r.totalBanked).toBe(0);expect(r.failure).toMatch(/deposit/i);
});
test('inventory disappearance without the matching bank receipt is not a banked load',async()=>{
    const r=await runEssenceGatherer(bankModel('stale'),{cap:1,bankAt:28});
    expect(r.ok).toBe(false);expect(r.totalBanked).toBe(0);expect(r.failure).toMatch(/deposit/i);
});
test('an observed inventory debit and matching fresh bank credit count the real load',async()=>{
    const r=await runEssenceGatherer(bankModel('observed'),{cap:1,bankAt:28});
    expect(r.ok).toBe(true);expect(r.totalBanked).toBe(28);expect(r.trips).toBe(1);
});

test('one trip includes an initial retained load and returns without another teleport',async()=>{
    const s=bankModel('observed');
    const walker=spyOn(walking,'sessionWalker').mockImplementation(async()=>{throw Error('unexpected second trip');});
    let r;try{r=await runEssenceGatherer(s,{cap:100,bankAt:28,maxTrips:1});}finally{walker.mockRestore();}
    expect(r.ok).toBe(true);expect(r.trips).toBe(1);expect(r.totalBanked).toBe(28);
    expect(r.totalMined).toBe(0);expect(r.held).toBe(0);
});

test('cancellation while waiting for a bank receipt does not dispatch a deposit',async()=>{
    const s=bankModel('observed');let deposits=0;
    s.bankObservation=(()=>undefined) as any;
    s.bot.depositItem=async()=>{deposits++;return{success:true};};
    const r=await runEssenceGatherer(s,{cap:100,bankAt:28,maxTrips:1,stop:()=>s.tick()>=2});
    expect(r.ok).toBe(false);expect(deposits).toBe(0);expect(r.totalBanked).toBe(0);
    expect(s.tick()).toBeLessThan(5);
});

for(const cancel of [false,true])test(`a full retained mine load returns once, or preserves cancellation on the return route: ${cancel}`,async()=>{
    const s=bankModel('observed'),state=s.sdk.getState();let stopped=false,teleports=0;
    state.player={worldX:2891,worldZ:4847,level:0};
    state.nearbyLocs=[{id:2492,name:'Portal',x:2885,z:4850,optionsWithIndex:[{text:'Use',opIndex:1}]}];
    s.sdk.sendInteractLoc=async()=>{teleports++;state.player={worldX:3253,worldZ:3402,level:0};return{success:true};};
    const spies=[spyOn(walking,'sessionWalker').mockResolvedValue({} as any),spyOn(walking,'walkPath').mockImplementation(async(_w,points)=>{
        if(cancel){stopped=true;return{ok:false,detail:'stopped'} as any;}
        const p=points.at(-1)!;state.player={worldX:p.x,worldZ:p.z,level:0};return{ok:true} as any;
    })];
    try{
        const r=await runEssenceGatherer(s,{cap:100,bankAt:28,maxTrips:1,stop:()=>stopped});
        expect(r.ok).toBe(!cancel);expect(r.totalMined).toBe(0);expect(r.trips).toBe(cancel?0:1);
        expect(r.totalBanked).toBe(cancel?0:28);expect(r.held).toBe(cancel?28:0);expect(teleports).toBe(cancel?0:1);
    }finally{for(const spy of spies)spy.mockRestore();}
});

test('cancellation after a matched bank credit preserves that receipt and does no tool action',async()=>{
    const s=bankModel('observed');let stopped=false,equips=0;
    const close=s.bot.closeBank;s.bot.closeBank=async()=>{await close();stopped=true;};
    s.bot.equipItem=async()=>{equips++;return{success:true};};
    const r=await runEssenceGatherer(s,{cap:100,bankAt:28,maxTrips:1,stop:()=>stopped});
    expect(r.ok).toBe(false);expect(r.totalBanked).toBe(28);expect(r.held).toBe(0);expect(equips).toBe(0);
});

function ownedPickBank(mode:'observed'|'stale-withdraw'|'no-wield'|'stop-after-withdraw',mining=99,attack=99){
 let tick=0,generation=1,withdrawals=0,equips=0,nullOnEquip=false;const bank:any[]=[{id:1275,name:"Rune pickaxe",count:1,slot:0},{id:995,name:"Coins",count:77,slot:1},{id:2357,name:"Gold bar",count:1,slot:2}],inventory:any[]=[],equipment:any[]=[{id:1265,name:"Bronze pickaxe",count:1,slot:3}];
 const player={worldX:3253,worldZ:3420,level:0,lifeId:1,respawnCount:0,isDead:false},state:any={player,bank:{isOpen:true,items:bank},inventory,equipment,skills:[{name:'Mining',level:mining},{name:'Hitpoints',level:99}]};const listeners=new Set<()=>void>();
 const s:any={tick:()=>tick,onTick:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)},bankObservation:()=>state.bank.isOpen?{generation,items:bank}:null,sdk:{getState:()=>state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkill:(name:string)=>({level:name==='Mining'?mining:99,baseLevel:name==='Attack'?attack:99})},bot:{closeBank:async()=>{state.bank.isOpen=false;return{success:true};},withdrawItem:async(item:any,n:number)=>{withdrawals++;item.count-=n;inventory.push({id:item.id,name:item.name,count:n,slot:0});if(mode!=='stale-withdraw')generation++;return{success:true};},equipItem:async(item:any)=>{equips++;state.bank.isOpen=false;nullOnEquip=s.bankObservation()===null;if(mode==='no-wield')return{success:false};const old=equipment.pop();inventory.splice(inventory.indexOf(item),1);equipment.push({...item,slot:3});if(old)inventory.push({...old,slot:0});return{success:true};},depositItem:async(item:any)=>{const i=inventory.indexOf(item);inventory.splice(i,1);const row=bank.find(v=>v.id===item.id);if(row)row.count+=item.count;else bank.push({...item,slot:bank.length});generation++;return{success:true};}}};
 const timer=setInterval(()=>{tick++;for(const fn of listeners)fn();},1);return{s,bank,inventory,equipment,withdrawals:()=>withdrawals,equips:()=>equips,nullOnEquip:()=>nullOnEquip,open:async()=>{state.bank.isOpen=true;generation++;},stop:()=>mode==='stop-after-withdraw'&&withdrawals>0,done:()=>clearInterval(timer)};
}

test('owned bank upgrade replaces an eligible inferior pick without spending or losing either tool',async()=>{
 const f=ownedPickBank('observed');try{const r=await upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop});expect(r).toEqual({id:1275,worn:true,preserved:true});expect(f.equipment[0].id).toBe(1275);expect(f.bank.find(i=>i.id===1265)?.count).toBe(1);expect(f.bank.find(i=>i.id===995)?.count).toBe(77);expect(f.bank.find(i=>i.id===2357)?.count).toBe(1);expect(f.withdrawals()).toBe(1);expect(f.nullOnEquip()).toBe(true);await upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop});expect(f.withdrawals()).toBe(1);}finally{f.done();}
});
test('native Mining eligibility skips an unusable bank upgrade and a wield refusal keeps both tools',async()=>{
 for(const [mode,level,id,worn]of [['observed',1,1265,true],['no-wield',99,1275,false]]as const){const f=ownedPickBank(mode,level);try{const r=await upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop});expect(r.id).toBe(id);expect(r.worn).toBe(worn);expect(f.equipment[0].id).toBe(1265);expect(f.withdrawals()).toBe(level===1?0:1);if(!worn)expect(f.inventory.some(i=>i.id===1275)).toBe(true);if(!worn){await upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop});expect(f.equips()).toBe(1);expect(f.nullOnEquip()).toBe(true);}}finally{f.done();}}
});
test('stale withdrawal or operator stop cannot authorize a later wield/deposit',async()=>{
 for(const mode of ['stale-withdraw','stop-after-withdraw']as const){const f=ownedPickBank(mode);try{await expect(upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop})).rejects.toThrow();expect(f.equipment[0].id).toBe(1265);expect(f.inventory.some(i=>i.id===1275)).toBe(true);expect(f.withdrawals()).toBe(1);expect(f.bank.find(i=>i.id===995)?.count).toBe(77);}finally{f.done();}}
});
test('native base Attack requirement avoids a known Rune wield refusal across repeated bank visits',async()=>{
 expect(essencePickWieldLevel(1275)).toBe(40);expect(essencePickWieldLevel(1269)).toBe(5);const f=ownedPickBank('observed',99,1);try{for(let i=0;i<2;i++){const r=await upgradeOwnedEssencePick(f.s,{openBank:f.open,stop:f.stop});expect(r.id).toBe(1275);expect(r.worn).toBe(false);}expect(f.equips()).toBe(0);expect(f.withdrawals()).toBe(1);expect(f.equipment[0].id).toBe(1265);expect(f.inventory.some(i=>i.id===1275)).toBe(true);}finally{f.done();}
});