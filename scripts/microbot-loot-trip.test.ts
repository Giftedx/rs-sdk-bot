import{test,expect}from'bun:test';
import{lootTripOutputs,fetchLootQuotes,lootQuoteDefinition,donorLootEligible,type LootTripJob}from'./microbot-loot-trip';
import{selectGroundLoot}from'./microbot-b-mining-loot';
const base:LootTripJob['policy']={mode:'list',ids:[563],names:[],minimumValue:100,maximumValue:500,radius:4,idleTicks:40};
const definition=(id:number)=>id===563?{name:'Law rune',cost:240,stackable:true}:id===556?{name:'Air rune',cost:4,stackable:true}:id===995?{name:'Coins',cost:1,stackable:true}:undefined;
test('bank-loot output declaration covers exact list names and finite static-value pile candidates',()=>{
 expect(lootTripOutputs(base,definition)).toEqual([563]);expect(lootTripOutputs({...base,ids:[],names:['lAw RuNe']},definition)).toEqual([563]);
 // Two low-value units may meet a whole-pile minimum; the existing selector checks that actual pile.
 expect(lootTripOutputs({...base,mode:'value',ids:[]},definition)).toEqual([556,563,995]);
 expect(lootTripOutputs({...base,mode:'mixed',minimumValue:0,maximumValue:10},definition)).toEqual([556,563,995]);
});
test('unknown names, invalid native IDs and invalid policy fail before any bank action',()=>{
 expect(()=>lootTripOutputs({...base,names:['not an item']},definition)).toThrow('unresolved');expect(()=>lootTripOutputs({...base,ids:[999999]},definition)).toThrow('policy');expect(()=>lootTripOutputs({...base,ids:[]},definition)).toThrow('policy');expect(()=>lootTripOutputs({...base,radius:13},definition)).toThrow('policy');expect(()=>lootTripOutputs({...base,maximumValue:50},definition)).toThrow('policy');
});
test('native GE snapshot changes actual whole-pile selection without using static fallback',async()=>{
 const snapshot=await fetchLootQuotes('http://localhost:19081',[563],()=>false,{item:async(id:number)=>({id,lastPrice:10,lastTradeAt:100})} as any,()=>1000);
 const quote=lootQuoteDefinition(snapshot,'http://localhost:19081',definition,()=>1001),state:any={inventory:[],nearbyPlayers:[],groundItems:[{id:563,name:'Law rune',count:1,x:1,z:1,distance:1}]},policy={...base,mode:'value' as const,maximumUnits:1,cap:10};
 expect(selectGroundLoot(state,policy,definition)?.item.id).toBe(563);expect(selectGroundLoot(state,policy,quote)).toBeUndefined();expect(quote(556)).toBeUndefined();expect(snapshot.prices[563]).toEqual({price:10,lastTradeAt:100});
});
test('quote scope, stop, absent trade, stale admission and wrong origin fail closed',async()=>{
 await expect(fetchLootQuotes('http://localhost:19081',[],()=>false,{} as any)).rejects.toThrow('scope');
 await expect(fetchLootQuotes('http://localhost:19081',[563],()=>true,{} as any)).rejects.toThrow('stopped');
 let calls=0;await expect(fetchLootQuotes('http://localhost:19081',[563],()=>false,{item:async()=>{calls++;return{id:563,lastPrice:null,lastTradeAt:null};}} as any)).rejects.toThrow('trade');expect(calls).toBe(1);
 const snapshot=await fetchLootQuotes('http://localhost:19081',[563],()=>false,{item:async()=>({id:563,lastPrice:10,lastTradeAt:100})} as any,()=>1000);
 expect(()=>lootQuoteDefinition(snapshot,'http://localhost:19082',definition,()=>1001)).toThrow('origin');expect(()=>lootQuoteDefinition(snapshot,'http://localhost:19081',definition,()=>62000)).toThrow('stale');
});
test('optional donor bounds use strict pile minimum and strict unit maximum',()=>{const policy={...base,mode:'value' as const,minimumValue:10,maximumValue:5};const item={id:556,name:'Air rune',count:10};expect(donorLootEligible(item,policy,definition)).toBe(true);expect(lootTripOutputs(policy,definition,true)).toEqual([556,995]);expect(donorLootEligible({...item,count:2},{...policy,minimumValue:8},definition)).toBe(false);expect(donorLootEligible(item,{...policy,maximumValue:4},definition)).toBe(false);expect(donorLootEligible(item,{...policy,mode:'mixed',ids:[556],maximumValue:4},definition)).toBe(true);});
test('mixed and list modes retain unquoted explicit bones but never unquoted unlisted coins',async()=>{
 const snapshot=await fetchLootQuotes('http://localhost:19081',[563],()=>false,{item:async()=>({id:563,lastPrice:10,lastTradeAt:100})}as any,()=>1000),native=(id:number)=>id===526?{name:'Bones',cost:1,stackable:false}:definition(id);
 for(const mode of ['mixed','list']as const){const policy={...base,mode,ids:[526],minimumValue:100,maximumValue:500},quoted=lootQuoteDefinition(snapshot,'http://localhost:19081',native,()=>1001,policy),state:any={inventory:[],nearbyPlayers:[],groundItems:[{id:526,name:'Bones',count:1,x:1,z:1,distance:1},{id:995,name:'Coins',count:200,x:1,z:2,distance:1}]};expect(selectGroundLoot(state,{...policy,maximumUnits:200,cap:10},quoted)?.item.id).toBe(526);expect(quoted(995)).toBeUndefined();expect(lootTripOutputs(policy,quoted)).toContain(526);expect(donorLootEligible(state.groundItems[0],policy,quoted)).toBe(true);}
 const named={...base,mode:'mixed' as const,ids:[],names:['bOnEs']};expect(lootQuoteDefinition(snapshot,'http://localhost:19081',native,()=>1001,named)(526)?.cost).toBe(1);
});
