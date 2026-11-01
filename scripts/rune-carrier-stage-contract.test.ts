import {test,expect} from 'bun:test';
import {runeStageRoster,runeCarrierShortfall,runeStageAuthenticate} from './rune-carrier-stage-contract';
test('a staging job owns its supplier and one to four carriers',()=>{
 expect(runeStageRoster(['Supplier','Carrier','--rune-carriers'])).toEqual({mode:'carriers',names:['Supplier','Carrier']});
 expect(runeStageRoster(['Supplier','A','B','C','D','--rune-carriers']).names).toHaveLength(5);
 for(const args of [['Supplier','--rune-carriers'],['S','A','B','C','D','E','--rune-carriers'],['S','s','--rune-carriers'],['S','Haggis','--rune-carriers']])expect(()=>runeStageRoster(args)).toThrow();
});
test('first login establishes authenticated ownership before staging can trade',async()=>{
 const owned=new Set<string>(),order:string[]=[];
 const result=await runeStageAuthenticate('Fresh',async()=>{order.push('login');owned.add('fresh');return {name:'Fresh'};},()=>{order.push('owned');return owned;});
 expect(result.name).toBe('Fresh');expect(order).toEqual(['login','owned']);
});
test('failed authentication and an unproved session cannot stage',async()=>{
 let checks=0;
 await expect(runeStageAuthenticate('Fresh',async()=>{throw Error('login refused');},()=>{checks++;return new Set(['fresh']);})).rejects.toThrow('login refused');expect(checks).toBe(0);
 await expect(runeStageAuthenticate('Fresh',async()=>({name:'Fresh'}),()=>new Set())).rejects.toThrow('authenticated owned');
});
test('opening preparation owns only the supplier',()=>{
 expect(runeStageRoster(['Supplier','--rune-opening'])).toEqual({mode:'opening',names:['Supplier']});
 expect(()=>runeStageRoster(['Supplier','Other','--rune-opening'])).toThrow();
});
test('banked stock reduces the exact kit shortfall and retained surplus is not spent',()=>{
 expect(runeCarrierShortfall([])).toEqual({essence:405,talismans:1});
 expect(runeCarrierShortfall([{id:1436,count:100},{id:1446,count:1}])).toEqual({essence:305,talismans:0});
 expect(runeCarrierShortfall([{id:1436,count:900},{id:1446,count:2}])).toEqual({essence:0,talismans:0});
 expect(()=>runeCarrierShortfall([{id:1436,count:NaN}])).toThrow();
});
