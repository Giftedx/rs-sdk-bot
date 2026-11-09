import{test,expect}from'bun:test';
import{ClientProt}from'../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import items from'../knowledge/items.json';
import{bankDonorKey,bankNameSimilarity}from'./microbot-bank-sort';
import{sortBankRows,bankMove,runFlatBankSort,dispatchBankDrag,type BankSortDriver}from'./microbot-bank-sort';
const rows=[{slot:0,id:10,name:'Zinc',count:8},{slot:3,id:20,name:'Apple',count:2},{slot:7,id:30,name:'Apple',count:9}];
function fixture(mode:0|1=0,effect='ok'){
 let tick=0,generation=1,current=structuredClone(rows),calls=0,halt=false;
 const d:BankSortDriver={tick:()=>tick,unsafe:()=>halt?'stop':'',observe:()=>({generation,mode,rows:structuredClone(current)}),drag:async(from,to,before)=>{calls++;if(effect==='none')return false;current=bankMove(before,from,to,mode);if(effect==='foreign')current[0]!.count++;if(effect!=='stale')generation++;if(effect==='stop')halt=true;if(effect==='throw')throw Error('lost reply');return true;},wait:async predicate=>{tick++;return predicate();}};
 return{d,stats:()=>({current,calls}),stop:()=>{halt=true;}};
}
test('native name ordering is stable for equal names and compacts sparse slots',async()=>{
 expect(sortBankRows(rows).map(i=>i.id)).toEqual([20,30,10]);
 for(const mode of[0,1]as const){const f=fixture(mode),r=await runFlatBankSort(f.d,{cap:50,maxMoves:10});expect(r.moves).toBeGreaterThan(0);expect(f.stats().current.map(i=>[i.slot,i.id,i.count])).toEqual([[0,20,2],[1,30,9],[2,10,8]]);}
});
test('unknown, stale, foreign and lost replies never repeat a drag',async()=>{
 for(const effect of['none','stale','foreign','throw','stop']){const f=fixture(0,effect);await expect(runFlatBankSort(f.d,{cap:50,maxMoves:10})).rejects.toThrow();expect(f.stats().calls).toBe(1);}
 const f=fixture();f.stop();await expect(runFlatBankSort(f.d,{cap:50,maxMoves:10})).rejects.toThrow('stop');expect(f.stats().calls).toBe(0);
});
test('bounded budget and invalid duplicate slots refuse before input',async()=>{
 const f=fixture();await expect(runFlatBankSort(f.d,{cap:50,maxMoves:1})).rejects.toThrow('budget');expect(f.stats().calls).toBe(1);
 expect(()=>sortBankRows([...rows,rows[0]!])).toThrow();
});
test('bridge uses native INV_BUTTOND field order and never changes client bank optimistically',()=>{
 const packet:number[]=[],com={linkObjType:[11,21],linkObjNumber:[8,2]},c:any={mainModalId:5292,var:{304:0},ifType:()=>com,writeOpcode:(n:number)=>packet.push(n),out:{p2:(n:number)=>packet.push(n),p1:(n:number)=>packet.push(n)}};
 const before=[rows[0]!,{...rows[1]!,slot:1}];expect(dispatchBankDrag(c,0,1,0,before).success).toBe(true);expect(packet).toEqual([ClientProt.INV_BUTTOND,5382,0,1,0]);expect(ClientProt.INV_BUTTOND).toBe(253);expect(com.linkObjType).toEqual([11,21]);
 expect(()=>dispatchBankDrag(c,0,1,1,before)).toThrow();expect(packet).toHaveLength(5);
});
const nativeRows=(ids:number[])=>ids.map((id,slot)=>({slot,id,count:slot+1,name:items.find(i=>i.id===id)!.name}));
test('native potion recipe IDs keep generic names and quest mixtures distinct',()=>{
 for(const[id,level,stage]of [[91,3,2],[3002,34,2],[3004,63,2],[3406,15,2],[3408,15,4],[3414,15,4],[2428,3,4]])expect(bankDonorKey(nativeRows([id!])[0]!)).toMatchObject({category:'Potions',level,stage});
 expect(sortBankRows(nativeRows([3004,3406,91]),'donor').map(i=>i.id)).toEqual([91,3406,3004]);
 expect(bankDonorKey(nativeRows([2511])[0]!).level).toBe(bankDonorKey(nativeRows([1511])[0]!).level);
 expect(()=>bankDonorKey({id:92,name:'Unfinished potion',slot:0,count:1})).toThrow('native item metadata');
});
test('donor workflow uses native unidentified herb IDs and production levels/stages',()=>{
 const sorted=sortBankRows(nativeRows([2351,249,995,438,440,199,2349]),'donor');
 expect(sorted.map(i=>i.id)).toEqual([995,438,2349,199,249,440,2351]);
 expect(bankDonorKey(nativeRows([199])[0]!)).toMatchObject({category:'Skilling-Resource-Herb',level:3,stage:0});
 expect(bankDonorKey(nativeRows([249])[0]!)).toMatchObject({category:'Skilling-Resource-Herb',level:3,stage:1});
});
test('donor categories, rune order, descending tools/gear tiers and doses differ from name order',()=>{
 const rows=nativeRows([1155,1265,560,1163,1275,556,141,139,379,995]);
 expect(sortBankRows(rows,'donor').map(i=>i.id)).toEqual([995,139,141,379,556,560,1163,1155,1275,1265]);
 expect(sortBankRows(nativeRows([121,2428]),'donor').map(i=>i.id)).toEqual([2428,121]);
 expect(sortBankRows(rows).map(i=>i.id)).not.toEqual(sortBankRows(rows,'donor').map(i=>i.id));
});
test('donor fuzzy grouping is deterministic and equal native names retain original order',()=>{
 expect(bankNameSimilarity('crystal key','crystal keys')).toBeGreaterThan(.95);
 expect(bankNameSimilarity('logs','potion')).toBeLessThan(.7);
 const rows=nativeRows([2511,1511,590,2347]);expect(sortBankRows(rows,'donor').filter(i=>i.name==='Logs').map(i=>i.id)).toEqual([2511,1511]);
 expect(sortBankRows(rows,'donor')).toEqual(sortBankRows(rows,'donor'));
 const notes=nativeRows([757,715,624,1509,714]);expect(sortBankRows(notes,'donor').map(i=>i.id)).toEqual([624,715,714,757,1509]);expect(sortBankRows(notes).map(i=>i.id)).toEqual([624,757,1509,715,714]);
 expect(sortBankRows(nativeRows([24,273,1931]),'donor').map(i=>i.id)).toEqual([273,1931,24]);
});
test('finite actual sorting loop executes donor-selected order with exact native receipts',async()=>{
 let tick=0,generation=1,current=nativeRows([440,249,995,438,199]),moves=0;
 const d:BankSortDriver={tick:()=>tick,unsafe:()=>'',observe:()=>({generation,mode:1,rows:current}),drag:async(from,to,before)=>{current=bankMove(before,from,to,1);generation++;moves++;return true;},wait:async p=>{tick++;return p();}};
 const r=await runFlatBankSort(d,{cap:100,maxMoves:20,policy:'donor'});expect(r.policy).toBe('donor');expect(current.map(i=>i.id)).toEqual([995,438,199,249,440]);expect(r.moves).toBe(moves);
});
test('native weapon, armour, tools, clue and cosmetic categories remain distinct',()=>{
 const expected:Record<number,string>={1289:'Weapon-Melee',861:'Weapon-Ranged',1381:'Weapon-Magic',1127:'Armour-Body',1079:'Armour-Legs',1201:'Armour-Shield',1725:'Armour-Amulet',1061:'Armour-Boots',1059:'Armour-Gloves',1635:'Armour-Ring',1007:'Armour-Cape',1038:'Cosmetic/Holiday',2677:'Clue-Scrolls',983:'Quest-Items',52:'Ammunition',313:'Tool-Fishing',3438:'Skilling-Resource-Log',735:'Skilling-Resource-Seed'};
 for(const[id,category]of Object.entries(expected))expect(bankDonorKey(nativeRows([Number(id)])[0]!).category).toBe(category);
});
