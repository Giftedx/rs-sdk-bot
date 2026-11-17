import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {xpForLevel} from '../../planner/src/curve';
import fixture from '../../practice/src/ranged-progression-entry.json';
import {parseRangedEntry,rangedSupportedMethods} from '../../practice/src/ranged-progression-case';
import {publishProgressionProof,readProgressionDeliveries,type ProgressionProofDelivery} from '../src/progression-proof-publish';

const producer='packages/practice/src/ranged-progression-case.ts',source='a'.repeat(64),roots:string[]=[];
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const json=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function nativeSave(entry:ReturnType<typeof parseRangedEntry>['entry']){
 const head=Buffer.alloc(135);head.writeUInt16BE(0x2004);head.writeUInt16BE(10,2);head.writeUInt16BE(entry.pos.x,4);head.writeUInt16BE(entry.pos.z,6);head.writeUInt8(entry.pos.level,8);
 entry.skills.forEach((s,i)=>{head.writeInt32BE(s.xp*10,28+i*5);head.writeUInt8(s.currentLevel,32+i*5);});
 const chunks=[head,Buffer.from([3])];
 for(const [type,rows] of [[93,entry.inventory.map((i,slot)=>({...i,slot}))],[94,entry.equipment],[95,entry.bank.map((i,slot)=>({...i,slot}))]] as const){
  const size=Math.max(-1,...rows.map(i=>i.slot))+1,header=Buffer.alloc(4);header.writeUInt16BE(type);header.writeUInt16BE(size,2);chunks.push(header);
  for(let slot=0;slot<size;slot++){const item=rows.find(i=>i.slot===slot),b=Buffer.alloc(!item?2:item.count>=255?7:3);b.writeUInt16BE(item?item.id+1:0);if(item)b.writeUInt8(Math.min(item.count,255),2);if(item&&item.count>=255)b.writeInt32BE(item.count,3);chunks.push(b);}
 }
 const body=Buffer.concat(chunks),crc=Buffer.alloc(4);crc.writeUInt32BE(Bun.hash.crc32(body)>>>0);return Buffer.concat([body,crc]);
}
function setup(prayer=95,root=mkdtempSync(join(tmpdir(),'progression-publish-'))){
 if(!roots.includes(root))roots.push(root);
 const directory=join(root,'.practice/deliveries',`ranged-train-${1794870000000+prayer}-fixture`),folder=join(root,'.practice/progression-ranged',`adaptive-${prayer}`),index=join(root,'.practice/progression-system/qualifications.json');
 const producerBytes=readFileSync(resolve(import.meta.dir,'../../practice/src/ranged-progression-case.ts'));mkdirSync(dirname(join(root,producer)),{recursive:true});writeFileSync(join(root,producer),producerBytes);
 const input=structuredClone(fixture);input.skills[5]={...input.skills[5]!,level:prayer,currentLevel:53,xp:xpForLevel(prayer)};
 const entryBytes=Buffer.from(JSON.stringify(input)),entry=parseRangedEntry(entryBytes).entry,after=structuredClone(entry),target=83;
 after.pos={x:3253,z:3421,level:0};after.skills[4]={...after.skills[4]!,level:target,currentLevel:target,xp:xpForLevel(target)};after.bank.find(i=>i.id===882)!.count-=2;
 const result={method:'ranged/troopers',bow:841,arrow:882,ok:true,targetMet:true,finalLevel:target,xpGain:after.skills[4]!.xp-entry.skills[4]!.xp,arrowsSpent:2,coinsSpent:0,accounting:true,preserved:true,died:false};
 const checks=Object.fromEntries(['exit','result','exactEntry','xp','bank','assets','arrows','coins','accounting','health','logout','persisted','timeout','source'].map(k=>[k,true]));
 const proof={ok:true,at:Date.now(),code:0,source,proofSource:hash(producerBytes),entrySha256:hash(entryBytes),target,supportedMethods:rangedSupportedMethods(entry,result,source,target),checks,result};
 json(join(folder,'proof.json'),proof);writeFileSync(join(folder,'entry.json'),entryBytes);writeFileSync(join(folder,'before.sav'),nativeSave(entry));writeFileSync(join(folder,'after.sav'),nativeSave(after));writeFileSync(join(folder,'worker.log'),'RANGED_TRAIN_RESULT '+JSON.stringify(result)+'\nLOGOUT logged-out\n');
 json(join(directory,'ranged-adaptive-proof.json'),{folder});
 const delivery:ProgressionProofDelivery={id:'ranged-train',goal:'finite ranged target',ok:true,stage:'delivered',evidence:'native',consumer:'finite ranged target',reason:'verified',source:'b'.repeat(64),checks:['regression','practice','consumer'].map(phase=>({id:phase,phase:phase as 'regression'|'practice'|'consumer',exitCode:0,timedOut:false,detail:'saved output'})),at:proof.at+1000,directory,runtimeRevision:source,files:[{path:producer,sha256:hash(producerBytes)}]};
 json(join(directory,'report.json'),delivery);
 const options={root,currentRevision:()=>source,currentFingerprint:()=>'b'.repeat(64)};
 return{root,directory,folder,index,delivery,proof,options};
}

test('publishes verified95 and96 native entries without replacing other references or index metadata',()=>{
 const a=setup(),old={path:'retained-other-account.json',sha256:'c'.repeat(64)};json(a.index,{schema:1,proofs:[old]});
 expect(publishProgressionProof(a.delivery,a.options)).toMatchObject({status:'published'});
 const b=setup(96,a.root);expect(publishProgressionProof(b.delivery,b.options).changed).toBe(true);
 const index=JSON.parse(readFileSync(a.index,'utf8'));expect(index.schema).toBe(1);expect(index.proofs).toHaveLength(3);expect(index.proofs[0]).toEqual(old);
 expect(index.proofs.slice(1).map((p:any)=>JSON.parse(readFileSync(p.path,'utf8')).supportedMethods[0].bands[0].levels.Prayer.min)).toEqual([95,96]);
 expect(index.proofs[1].sha256).toBe(hash(readFileSync(join(a.folder,'proof.json'))));
});
test('publication is idempotent and does not rewrite an unchanged index',()=>{
 const f=setup();expect(publishProgressionProof(f.delivery,f.options).changed).toBe(true);
 const mtime=statSync(f.index).mtimeMs;let writes=0;
 const result=publishProgressionProof(f.delivery,{...f.options,write:()=>{writes++;return true;}});
 expect(result.status).toBe('unchanged');expect(writes).toBe(0);expect(statSync(f.index).mtimeMs).toBe(mtime);
});
test('held source, helper or delivery checks leave an existing index untouched',()=>{
 for(const mutation of ['source','fingerprint','helper','phase','receipt'] as const){
  const f=setup();json(f.index,{proofs:[],keep:mutation});const before=readFileSync(f.index,'utf8');
  if(mutation==='source')f.options.currentRevision=()=>'d'.repeat(64);
  if(mutation==='fingerprint')f.options.currentFingerprint=()=>'d'.repeat(64);
  if(mutation==='helper')writeFileSync(join(f.root,producer),'changed producer');
  if(mutation==='phase'){f.delivery.ok=false;f.delivery.stage='failed';}
  if(mutation==='receipt')json(join(f.directory,'report.json'),{...f.delivery,consumer:'a different receipt'});
  expect(publishProgressionProof(f.delivery,f.options).status).toBe('held');expect(readFileSync(f.index,'utf8')).toBe(before);
 }
});
test('the known native protocol and canonical receipt bind capability ID and goal',()=>{
 for(const field of ['id','goal'] as const){
  const f=setup();f.delivery[field]='other-capability';
  expect(publishProgressionProof(f.delivery,f.options).status).toBe('held');
 }
 const f=setup();f.delivery.id='other-capability';json(join(f.directory,'report.json'),f.delivery);
 expect(publishProgressionProof(f.delivery,f.options).status).toBe('held');
});
test('retained proofs remain publishable when fresh at delivery, while stale-at-delivery evidence is held',()=>{
 for(const gap of [1000,900001]){
  const f=setup();f.proof.at=Date.now()-3600000;f.delivery.at=f.proof.at+gap;
  json(join(f.folder,'proof.json'),f.proof);json(join(f.directory,'report.json'),f.delivery);
  expect(publishProgressionProof(f.delivery,f.options).status).toBe(gap===1000?'published':'held');
 }
});
test('refuses raw checks, frozen entry or supported bands that detach from the native run',()=>{
 for(const mutation of ['checks','entry','bands','result','save','unknown'] as const){
  const f=setup();
  if(mutation==='checks')f.proof.checks.exactEntry=false;
  if(mutation==='entry')writeFileSync(join(f.folder,'entry.json'),'{}');
  if(mutation==='bands')f.proof.supportedMethods[0]!.bands[0]!.levels.Prayer={min:1,max:99};
  if(mutation==='result')f.proof.result.xpGain++;
  if(mutation==='save')writeFileSync(join(f.folder,'after.sav'),'not a native save');
  if(mutation==='unknown')f.proof.supportedMethods[0]!.id='future/unverified';
  json(join(f.folder,'proof.json'),f.proof);
  expect(publishProgressionProof(f.delivery,f.options).status).toBe('held');
 }
});
test('rejects an escaped receipt, proof pointer and symlinked evidence or output directory',()=>{
 const outside=mkdtempSync(join(tmpdir(),'progression-outside-'));roots.push(outside);
 for(const mutation of ['receipt','pointer','proof-link','index-link'] as const){
  const f=setup();
  if(mutation==='receipt')f.delivery.directory=outside;
  if(mutation==='pointer')json(join(f.directory,'ranged-adaptive-proof.json'),{folder:outside});
  if(mutation==='proof-link'){writeFileSync(join(outside,'proof.json'),readFileSync(join(f.folder,'proof.json')));rmSync(f.folder,{recursive:true});symlinkSync(outside,f.folder,'junction');}
  if(mutation==='index-link')symlinkSync(outside,join(f.root,'.practice/progression-system'),'junction');
  expect(publishProgressionProof(f.delivery,f.options).status).toBe('held');
 }
});
test('optional writer failure is retryable and preserves the delivered receipt and index',()=>{
 const f=setup();json(f.index,{proofs:[],keep:true});const before=readFileSync(f.index,'utf8'),receipt=readFileSync(join(f.directory,'report.json'),'utf8');
 const result=publishProgressionProof(f.delivery,{...f.options,write:()=>{throw Error('disk unavailable');}});
 expect(result.status).toBe('retry');expect(result.changed).toBe(false);expect(readFileSync(f.index,'utf8')).toBe(before);expect(readFileSync(join(f.directory,'report.json'),'utf8')).toBe(receipt);
});
test('delivery discovery reads known successful receipts and skips partial, malformed, unsupported and linked data',()=>{
 const f=setup(),outside=mkdtempSync(join(tmpdir(),'progression-discovery-'));roots.push(outside);
 const dir=(suffix:string)=>join(f.root,'.practice/deliveries','ranged-train-1794870100000-'+suffix);
 mkdirSync(dir('partial'));mkdirSync(dir('malformed'));writeFileSync(join(dir('malformed'),'report.json'),'{');
 json(join(dir('other'),'report.json'),{...f.delivery,id:'other',directory:dir('other')});
 json(join(dir('failed'),'report.json'),{...f.delivery,ok:false,stage:'failed',directory:dir('failed')});
 json(join(f.root,'.practice/deliveries/unrelated/report.json'),f.delivery);
 mkdirSync(dir('oversized'));writeFileSync(join(dir('oversized'),'report.json'),' '.repeat(1024*1024+1));
 json(join(outside,'report.json'),{...f.delivery,directory:dir('linked')});symlinkSync(outside,dir('linked'),'junction');
 mkdirSync(dir('linked-report'));symlinkSync(outside,join(dir('linked-report'),'report.json'),'junction');
 // A supported receipt cannot redirect the reader to another directory's report.
 json(join(dir('redirect'),'report.json'),{...f.delivery,directory:f.directory});
 expect(readProgressionDeliveries(f.root).map(r=>r.directory)).toEqual([f.directory]);
 expect(readProgressionDeliveries(join(f.root,'missing'))).toEqual([]);
});
test('delivery discovery bounds report reads to the newest64 known immediate directories',()=>{
 const f=setup(),base=1794880000000;
 for(let i=1;i<=70;i++){const directory=join(f.root,'.practice/deliveries',`ranged-train-${base+i}-fixture`);json(join(directory,'report.json'),{...f.delivery,directory});}
 const rows=readProgressionDeliveries(f.root);
 expect(rows).toHaveLength(64);expect(rows[0]!.directory).toContain(String(base+70));expect(rows.at(-1)!.directory).toContain(String(base+7));
});
