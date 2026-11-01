import {test,expect} from 'bun:test';
import {runeStageRoster,runeCarrierShortfall} from './rune-carrier-stage-contract';
test('a staging job owns its supplier and one to four carriers',()=>{
 expect(runeStageRoster(['Supplier','Carrier','--rune-carriers'])).toEqual({mode:'carriers',names:['Supplier','Carrier']});
 expect(runeStageRoster(['Supplier','A','B','C','D','--rune-carriers']).names).toHaveLength(5);
 for(const args of [['Supplier','--rune-carriers'],['S','A','B','C','D','E','--rune-carriers'],['S','s','--rune-carriers'],['S','Haggis','--rune-carriers']])expect(()=>runeStageRoster(args)).toThrow();
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
