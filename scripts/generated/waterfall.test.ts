import { expect, test } from 'bun:test';
import { waterfallFood, prepareWaterfallPack, waterfallConserved, waterfallDialogue, waterfallResumeAtBookcase } from './waterfall';
import type { Session } from '../../packages/core/src/inprocess';
test('old lobster thresholds remain6/9; owned fish30HP retains more than two max11hits', () => {
    expect(waterfallFood()).toMatchObject({ id: 379, heal: 12, eatAt: 6, crossAt: 9 });
    expect(waterfallFood('salmon')).toMatchObject({ id: 329, heal: 9, eatAt: 30, crossAt: 30, count: 16 });
    expect(waterfallFood('trout')).toMatchObject({ id: 333, heal: 7, eatAt: 30 });
    expect(() => waterfallFood('salmon', 20)).toThrow('margin'); expect(() => waterfallFood('salmon',30,18)).toThrow('food/count');
});
function fixture(short = false) {
    type Item = { id:number;count:number;slot:number;name:string };
    const inv:Item[] = [{id:309,count:1,slot:0,name:'Fly fishing rod'},{id:314,count:29,slot:1,name:'Feather'},{id:946,count:1,slot:2,name:'Knife'},{id:52,count:30,slot:3,name:'Arrow shaft'},{id:995,count:13,slot:4,name:'Coins'}];
    const equipment:Item[]=[{id:1277,count:1,slot:3,name:'Bronze sword'}];
    const bank:Item[]=[[954,2],[556,6],[557,6],[555,6],[329,381],[333,558],[995,25]].map(([id,count],slot)=>({id:id!,count:count!,slot,name:String(id)}));
    const listeners = new Set<()=>void>(); const timer=setInterval(()=>{for(const cb of [...listeners])cb();},1);
    const add=(items:Item[],id:number,count:number)=>{const i=items.find(i=>i.id===id);if(i)i.count+=count;else items.push({id,count,name:String(id),slot:items.length});};
    const s={sdk:{getState:()=>({player:{worldX:2654,worldZ:3283,level:0},bank:{items:bank}}),getInventory:()=>inv,getEquipment:()=>equipment},
        onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},bot:{openBank:async()=>({success:true}),closeBank:async()=>({success:true}),
        depositItem:async(item:Item)=>{const amount=inv.filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);add(bank,item.id,amount);for(let i=inv.length-1;i>=0;i--)if(inv[i]!.id===item.id)inv.splice(i,1);return{success:true};},
        unequipItem:async(item:Item)=>{equipment.splice(equipment.indexOf(item),1);add(inv,item.id,item.count);return{success:true};},
        withdrawItem:async(item:Item,count:number)=>{const amount=short?1:count;item.count-=amount;if(item.id===954||item.id===329){for(let i=0;i<amount;i++)inv.push({id:item.id,count:1,slot:inv.length,name:item.name});}else add(inv,item.id,amount);return{success:true};}}
    } as unknown as Session;
    return{s,inv,bank,equipment,close:()=>clearInterval(timer)};
}
test('Mighty preparation stores knife/shafts/coins/wornweapon and loads only23ownedquest slots',async()=>{
    const f=fixture();try{const original=await prepareWaterfallPack(f.s,waterfallFood('salmon'));
        expect(original.get(995)).toBe(38);expect(original.get(1277)).toBe(1);expect(f.equipment).toEqual([]);
        for(const id of [309,314,946,52,995,1277])expect(f.bank.some(i=>i.id===id&&i.count>0)).toBe(true);
        expect(f.inv.length).toBe(21);expect(f.inv.filter(i=>i.id===329).length).toBe(16);expect(f.inv.some(i=>[946,52,995,1277].includes(i.id))).toBe(false);
    }finally{f.close();}
});
test('partial preparation withdrawal banks the actual leftovers before failing',async()=>{
    const f=fixture(true);try{await expect(prepareWaterfallPack(f.s,waterfallFood('salmon'))).rejects.toThrow('withdrawal shortfall');expect(f.inv).toEqual([]);expect(f.bank.find(i=>i.id===954)?.count).toBe(2);}finally{f.close();}
});
test('final asset proof allows only six consumed runes and actual confirmed food, not lost kit',()=>{
    const start=new Map([[329,381],[556,6],[557,6],[555,6],[946,1],[52,30],[995,38]]);
    const final=new Map([[329,375],[946,1],[52,30],[995,38]]);
    expect(waterfallConserved(start,final,329,6)).toBe(true);final.set(946,0);expect(waterfallConserved(start,final,329,6)).toBe(false);
});

function dialogueFixture(pages: any[]) {
    let tick=0; const clicks:number[]=[]; const listeners=new Set<()=>void>();
    const timer=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},1);
    const s={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{
        getDialog:()=>pages[Math.min(tick,pages.length-1)],getState:()=>({player:{worldX:2512,worldZ:3481,level:0},gameMessages:[]}),
        sendClickDialog:async(index:number)=>{clicks.push(index);return{success:true};}
    }} as unknown as Session;
    return{s,clicks,close:()=>clearInterval(timer)};
}
test('mandatory dialogue needs positive proof; closed pages alone never complete it',async()=>{
    const f=dialogueFixture([{isOpen:true,allComponents:[{text:'Hello son'}],options:[]},{isOpen:false}]);
    try{const r=await waterfallDialogue(f.s,{proof:/fine alone/i,maxTicks:6});expect(r.ok).toBe(false);expect(r.proofSeen).toBe(false);expect(r.trace.length).toBeGreaterThan(0);}finally{f.close();}
});
test('mandatory dialogue captures component-only delayed proof then waits for closure',async()=>{
    const f=dialogueFixture([{isOpen:false},{isOpen:false},{isOpen:true,isWaiting:true,allComponents:[{text:"I'm fine alone."}]},{isOpen:true,allComponents:[{text:"Ok, I'll leave you to it."}],options:[]},{isOpen:false}]);
    try{const r=await waterfallDialogue(f.s,{proof:/fine alone/i,maxTicks:8});expect(r.ok).toBe(true);expect(r.proofSeen).toBe(true);expect(f.clicks).toEqual([0]);}finally{f.close();}
});
test('stage2 repeat dialogue is valid proof; unexpected choices stop without bare continue',async()=>{
    const f=dialogueFixture([{isOpen:true,allComponents:[{text:"I'll find that treasure soon"}],options:[{index:1,text:'Continue',buttonType:6}]},{isOpen:false}]);
    try{expect((await waterfallDialogue(f.s,{proof:/find that treasure soon/i,maxTicks:5})).ok).toBe(true);}finally{f.close();}
    const g=dialogueFixture([{isOpen:true,options:[{index:1,text:'Go away',buttonType:1}]}]);
    try{const r=await waterfallDialogue(g.s,{proof:/fine alone/i,maxTicks:5});expect(r.ok).toBe(false);expect(r.reason).toBe('unexpected choice');expect(g.clicks).toEqual([]);}finally{g.close();}
});
test('bookcase resume is explicit and restricted to the observed upstairs location',()=>{
    expect(waterfallResumeAtBookcase({worldX:2519,worldZ:3427,level:1})).toBe(true);
    expect(waterfallResumeAtBookcase({worldX:2519,worldZ:3427,level:0})).toBe(false);
    expect(waterfallResumeAtBookcase({worldX:2654,worldZ:3283,level:1})).toBe(false);
});
test('proof published during an awaited click is retained with its page diagnostics',async()=>{
    const f=dialogueFixture([{isOpen:true,allComponents:[{text:'Hello son'}],options:[]},
        {isOpen:true,isWaiting:true,pageId:42,allComponents:[{text:"I'm fine alone."}]}, {isOpen:false}]);
    f.s.sdk.sendClickDialog=async()=>{await new Promise<void>(resolve=>{let n=0;const off=f.s.onTick(()=>{if(++n===3){off();resolve();}});});return{success:true} as any;};
    try{const r=await waterfallDialogue(f.s,{proof:/fine alone/i,maxTicks:8});expect(r.ok).toBe(true);expect(JSON.stringify(r.trace)).toContain('fine alone');expect(JSON.stringify(r.trace)).toContain('42');}finally{f.close();}
});
test('a proved line still needs the final page to close; an ended guard stops further input',async()=>{
    const f=dialogueFixture([{isOpen:true,isWaiting:true,allComponents:[{text:"I'm fine alone."}]}]);
    try{const r=await waterfallDialogue(f.s,{proof:/fine alone/i,maxTicks:3});expect(r.ok).toBe(false);expect(r.proofSeen).toBe(true);expect(f.clicks).toEqual([]);
        expect((await waterfallDialogue(f.s,{proof:/fine alone/i,maxTicks:3,stop:()=>true})).reason).toBe('stopped');}finally{f.close();}
});
