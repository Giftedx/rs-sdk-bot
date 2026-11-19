import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {xpForLevel} from '../../planner/src/curve';
import fixture from '../../practice/src/ranged-progression-entry.json';
import {parseRangedEntry,rangedSupportedMethods,type RangedComparisonEntry} from '../../practice/src/ranged-progression-case';
import {verifyRegisteredRangedProof} from '../src/progression-qualification-native';

const producer='packages/practice/src/ranged-progression-case.ts',source='a'.repeat(64),roots:string[]=[];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

// Unit fixture bytes use the local save layout and CRC. No engine or account produces them.
function nativeSave(entry:RangedComparisonEntry){
 const head=Buffer.alloc(135);head.writeUInt16BE(0x2004);head.writeUInt16BE(10,2);head.writeUInt16BE(entry.pos.x,4);head.writeUInt16BE(entry.pos.z,6);head.writeUInt8(entry.pos.level,8);
 entry.skills.forEach((s,i)=>{head.writeInt32BE(s.xp*10,28+i*5);head.writeUInt8(s.currentLevel,32+i*5);});
 const chunks=[head,Buffer.from([3])];
 for(const [type,rows]of [[93,entry.inventory.map((i,slot)=>({...i,slot}))],[94,entry.equipment],[95,entry.bank.map((i,slot)=>({...i,slot}))]]as const){
  const size=Math.max(-1,...rows.map(i=>i.slot))+1,header=Buffer.alloc(4);header.writeUInt16BE(type);header.writeUInt16BE(size,2);chunks.push(header);
  for(let slot=0;slot<size;slot++){
   const item=rows.find(i=>i.slot===slot),bytes=Buffer.alloc(!item?2:item.count>=255?7:3);bytes.writeUInt16BE(item?item.id+1:0);
   if(item)bytes.writeUInt8(Math.min(item.count,255),2);if(item&&item.count>=255)bytes.writeInt32BE(item.count,3);chunks.push(bytes);
  }
 }
 const body=Buffer.concat(chunks),crc=Buffer.alloc(4);crc.writeUInt32BE(Bun.hash.crc32(body)>>>0);return Buffer.concat([body,crc]);
}
function setup(){
 const base=mkdtempSync(join(tmpdir(),'progression-native-verifier-'));roots.push(base);
 const folder=join(base,'.practice/progression-ranged/unit-fixture');mkdirSync(folder,{recursive:true});
 const producerBytes=readFileSync(resolve(import.meta.dir,'../../practice/src/ranged-progression-case.ts'));
 mkdirSync(dirname(join(base,producer)),{recursive:true});writeFileSync(join(base,producer),producerBytes);
 const entryBytes=Buffer.from(JSON.stringify(structuredClone(fixture))),entry=parseRangedEntry(entryBytes).entry,after=structuredClone(entry),target=83;
 after.pos={x:3253,z:3421,level:0};after.skills[4]={...after.skills[4]!,level:target,currentLevel:target,xp:xpForLevel(target)};after.bank.find(i=>i.id===882)!.count-=2;
 const result={method:'ranged/troopers',bow:841,arrow:882,ok:true,targetMet:true,finalLevel:target,xpGain:after.skills[4]!.xp-entry.skills[4]!.xp,arrowsSpent:2,coinsSpent:0,accounting:true,preserved:true,died:false};
 const proof={code:0,source,proofSource:hash(producerBytes),entrySha256:hash(entryBytes),target,supportedMethods:rangedSupportedMethods(entry,result,source,target),result};
 const log=(value:typeof result=result)=>'RANGED_TRAIN_RESULT '+JSON.stringify(value)+'\nLOGOUT logged-out\n';
 writeFileSync(join(folder,'entry.json'),entryBytes);writeFileSync(join(folder,'before.sav'),nativeSave(entry));writeFileSync(join(folder,'after.sav'),nativeSave(after));writeFileSync(join(folder,'worker.log'),log());
 return{base,folder,proof,result,log};
}

test('the real saved-proof verifier accepts matching unit entry, CRC saves, raw result and derived bands',()=>{
 const f=setup(),verified=verifyRegisteredRangedProof(f.folder,f.proof,f.base);
 expect(verified.checks).toEqual({exit:true,result:true,exactEntry:true,xp:true,bank:true,assets:true,arrows:true,coins:true,accounting:true,health:true,logout:true,supportedMethods:true,rawResult:true,proofSource:true});
});

test('the real saved-proof verifier rejects corrupt saves, changed raw output, detached entry and widened bands',()=>{
 for(const mutation of ['save','raw-result','entry','band']as const){
  const f=setup();
  if(mutation==='save'){
   const path=join(f.folder,'after.sav'),bytes=readFileSync(path);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;writeFileSync(path,bytes);
   expect(()=>verifyRegisteredRangedProof(f.folder,f.proof,f.base)).toThrow('local player save CRC mismatch');
  }else if(mutation==='entry'){
   const path=join(f.folder,'entry.json');writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n')]));
   expect(()=>verifyRegisteredRangedProof(f.folder,f.proof,f.base)).toThrow('frozen Ranged entry SHA-256 differs');
  }else if(mutation==='raw-result'){
   writeFileSync(join(f.folder,'worker.log'),f.log({...f.result,xpGain:f.result.xpGain+1}));
   const verified=verifyRegisteredRangedProof(f.folder,f.proof,f.base);expect(verified.checks.rawResult).toBe(false);expect(verified.checks.xp).toBe(false);
  }else{
   // A band that admits a weaker account than the entry (a lower minimum) is not the band of this proof.
   f.proof.supportedMethods[0]!.bands[0]!.levels.Ranged={min:1};
   expect(verifyRegisteredRangedProof(f.folder,f.proof,f.base).checks.supportedMethods).toBe(false);
  }
 }
});

test('the real saved-proof verifier detects producer SHA drift without changing saved game checks',()=>{
 const f=setup(),path=join(f.base,producer);writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from('\n')]));
 const verified=verifyRegisteredRangedProof(f.folder,f.proof,f.base);
 expect(verified.checks.proofSource).toBe(false);
 expect(Object.entries(verified.checks).filter(([,passed])=>!passed).map(([name])=>name)).toEqual(['proofSource']);
});
