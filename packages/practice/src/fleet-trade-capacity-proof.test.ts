import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fleetTradeCapacityRecord} from './fleet-trade-capacity-proof';
import {intentForEntry} from '../../planner/src/progression-catalog';
import type {Order} from '../../../scripts/fleet-trade-settlement';
const order:Order={id:'native-helper-1',server:'127.0.0.1:21000',from:'Giver',to:'Taker',item:'Fire rune',count:250,start:1,end:60001,meet:[{x:3183,z:3436,level:0},{x:3184,z:3436,level:0}]};
test('helper transfer records its exact finite order, participants and roles without inherited training claims',()=>{
 const directory=mkdtempSync(join(tmpdir(),'capacity-record-')),file=join(directory,'order.json');
 try{
  writeFileSync(file,JSON.stringify(order));
  for(const account of ['Giver','Taker']){
   const record=fleetTradeCapacityRecord(file,order,account,{PROGRESSION_CONSUMER:'{"skills":{"Ranged":99}}',PROGRESSION_METHOD:'ranged/troopers',PROGRESSION_SOURCE:'unrelated',CAP:'123'});
   expect(record.script).toBe('scripts/aio-logistics.ts');expect(record.argv).toEqual([account,'fleet-trade',file]);
   expect(record.env).toMatchObject({COORDINATOR_PARTICIPANTS:'["Giver","Taker"]',CAP:'123'});
   expect(record.env?.PROGRESSION_CONSUMER).toBeUndefined();expect(record.env?.PROGRESSION_METHOD).toBeUndefined();expect(record.env?.PROGRESSION_SOURCE).toBeUndefined();
   expect(intentForEntry(record.script,record.argv.slice(1),record.env)).toEqual({kind:'service',objective:'finite owned order '+file});
   expect(JSON.parse(readFileSync(file,'utf8'))).toEqual(order);
  }
  expect(()=>fleetTradeCapacityRecord(file,order,'Other')).toThrow();
  expect(()=>fleetTradeCapacityRecord(file,{...order,count:0},'Giver')).toThrow();
  expect(()=>fleetTradeCapacityRecord(file,{...order,item:'Air rune'},'Giver')).toThrow();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
