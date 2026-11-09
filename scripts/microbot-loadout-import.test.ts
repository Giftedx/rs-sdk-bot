import {test,expect} from 'bun:test';
import {compileInventorySetup,type SetupBindings} from './microbot-loadout-import';
import {validateOwnedKit} from './microbot-owned-loadout';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const bindings=():SetupBindings=>({items:{'10001':1277,'10002':1171,'10003':385,'10004':563,'10005':1778},bank:{x:2655,z:3283,level:0},cap:600,maximumMoves:128,packPolicy:'exact-counts'});
const donor=()=>({name:'Mapped native kit',inv:[{id:10003,s:0},null,{id:10004,q:50,s:2},{id:10003,s:3}],eq:[null,null,null,{id:10001,s:3},null,{id:10002,s:5}],sb:0,rp:null,bp:null,qv:null,afi:{}});

test('compact and portable donor setups compile directly into existing finite owned-kit inputs',()=>{
 for(const source of [donor(),{setup:donor(),layout:[10003,-1,10004]}]){
  const kit=compileInventorySetup(source,bindings());
  expect(kit.pack).toEqual([{id:385,count:2},{id:563,count:50}]);expect(kit.wear).toEqual([{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}]);expect(validateOwnedKit(kit)).toEqual(kit);
 }
});
test('multi-setup portable exports require an exact unambiguous setup name',()=>{
 const first={setup:donor(),layout:[]},second={setup:{...donor(),name:'Second',inv:[{id:10004,q:7}]},layout:[]};
 expect(compileInventorySetup([first,second],{...bindings(),setupName:'Second'}).pack).toEqual([{id:563,count:7}]);
 for(const b of [bindings(),{...bindings(),setupName:'Missing'}])expect(()=>compileInventorySetup([first,second],b)).toThrow('setup name');
 expect(()=>compileInventorySetup([second,second],{...bindings(),setupName:'Second'})).toThrow('setup name');
});
test('native IDs are never inferred from matching donor IDs or display names',()=>{
 expect(()=>compileInventorySetup({...donor(),inv:[{id:385,name:'Shark'}]},bindings())).toThrow('explicit native binding');
 const b=bindings();b.items['10003']=99999999;expect(()=>compileInventorySetup(donor(),b)).toThrow();
});
test('defaults and null items follow donor serialization, notes retain native identity',()=>{
 const source={inv:[null,{id:-1,q:0}, {id:10005,q:100,s:-1}],eq:[],sb:4};
 expect(compileInventorySetup(source,bindings()).pack).toEqual([{id:1778,count:100}]);
});
test('fuzzy/inequality/locked and unsupported containers or spellbooks fail explicitly',()=>{
 for(const row of [{id:10003,f:true},{id:10003,sc:'Less_Than'},{id:10003,sc:'Greater_Than'},{id:10003,l:true}])expect(()=>compileInventorySetup({...donor(),inv:[row]},bindings())).toThrow();
 for(const extra of [{rp:[{id:10004,q:10}]},{bp:[{id:10004}]},{qv:[{id:10004}]},{afi:{10003:{id:10003}}},{sb:1},{sb:2},{sb:3}])expect(()=>compileInventorySetup({...donor(),...extra},bindings())).toThrow();
});
test('empty special containers and exact comparator do not invent extra pack items',()=>{
 expect(compileInventorySetup({...donor(),rp:[null,{id:-1,q:0}],inv:[{id:10003,sc:'Standard',f:false,l:false}]},bindings()).pack).toEqual([{id:385,count:1}]);
});
test('malformed rows, duplicate source slots, oversized pack and illegal native gear fail before output',()=>{
 for(const inv of [[{id:10003,q:0}],[{id:10003,q:1.1}],[{id:10003,s:28}],[{id:10003,s:0},{id:10004,s:0}],[{id:10003,q:29}],Array(29).fill(null)])expect(()=>compileInventorySetup({...donor(),inv},bindings())).toThrow();
 expect(()=>compileInventorySetup({...donor(),eq:[{id:10003}]},bindings())).toThrow();
 expect(()=>compileInventorySetup({...donor(),eq:[{id:10001},{id:10001}]},bindings())).toThrow();
 expect(()=>compileInventorySetup({...donor(),eq:[{id:10001,q:2}]},bindings())).toThrow();
});
test('a binding to a native two-handed sword cannot coexist with a shield',()=>{
 const b=bindings();b.items['10001']=1307;
 expect(()=>compileInventorySetup(donor(),b)).toThrow('conflicting');
});
test('invalid finite bindings and unknown executable row fields cannot silently produce a kit',()=>{
 for(const patch of [{cap:0},{maximumMoves:1000},{packPolicy:'slots'},{bank:{x:-1,z:1,level:0}}])expect(()=>compileInventorySetup(donor(),{...bindings(),...patch})).toThrow();
 expect(()=>compileInventorySetup({...donor(),inv:[{id:10003,charges:{left:3}}]},bindings())).toThrow('unsupported donor item field');
});
test('actual offline CLI emits loadout-consumable JSON and rejects an unmapped donor item',()=>{
 const folder=mkdtempSync(join(tmpdir(),'native-setup-')),source=join(folder,'source.json'),map=join(folder,'bindings.json');
 try{
  writeFileSync(source,JSON.stringify({setup:donor(),layout:[]}));writeFileSync(map,JSON.stringify(bindings()));
  const run=()=>spawnSync(process.execPath,[join(import.meta.dir,'microbot-loadout-import.ts'),source,map],{encoding:'utf8',windowsHide:true,timeout:10000});
  const ok=run();expect(ok.status).toBe(0);expect(validateOwnedKit(JSON.parse(ok.stdout))).toEqual(compileInventorySetup(donor(),bindings()));
  writeFileSync(source,JSON.stringify({...donor(),inv:[{id:385}]}));const refused=run();expect(refused.status).toBe(1);expect(refused.stdout).toBe('');expect(refused.stderr).toContain('explicit native binding');
 }finally{unlinkSync(source);unlinkSync(map);rmdirSync(folder);}
});
