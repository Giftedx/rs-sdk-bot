import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fleetStateFile} from '../packages/core/src/practice-paths';
import {checkTransferAccounts,transferOrderKey} from './transfer-admission';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'transfer-admission-'));
 mkdirSync(join(root,'.practice/live'),{recursive:true});mkdirSync(join(root,'.practice/status'));
 writeFileSync(join(root,'swarm.json'),JSON.stringify({maxBots:4,jobs:[]}));
 writeFileSync(fleetStateFile(root),JSON.stringify({schemaVersion:1,accounts:{}}));
 writeFileSync(join(root,'.practice/status/Donor.json'),JSON.stringify({name:'Donor',goal:'host job',at:Date.now()}));
 const servers:string[]=[],io={owned:(server:string)=>{servers.push(server);return new Set(['donor','receiver']);},logoutState:()=> 'confirmed'};
 return{root,io,servers,clear:()=>rmSync(root,{recursive:true,force:true})};
}

test('confirmed endpoint logout admits hosted producers without a status RESULT while unknown ownership remains refused',()=>{
 const f=fixture();try{
  expect(()=>checkTransferAccounts(f.root,['Donor','Receiver'],'127.0.0.1:21000',[],'',f.io)).not.toThrow();
  expect(f.servers).toEqual(['127.0.0.1:21000']);
  expect(()=>checkTransferAccounts(f.root,['Donor'],'127.0.0.1:21000',[],'',{...f.io,logoutState:()=> 'unknown'})).toThrow('session ownership unsettled');
  expect(()=>checkTransferAccounts(f.root,['Donor'],'127.0.0.1:21000',[],'',{...f.io,owned:()=>new Set()})).toThrow('not authenticated owned');
  expect(()=>checkTransferAccounts(f.root,['Donor'],'127.0.0.1:21000',[{name:'DONOR'}],'',{...f.io,logoutState:()=>{throw Error('open account proof reread');}})).not.toThrow();
 }finally{f.clear();}
});

test('swarm assignments and owner pauses remain authoritative before transfer login',()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'swarm.json'),JSON.stringify({maxBots:4,jobs:[{account:'Donor',enabled:true,goal:'other [run-other]'}]}));
  expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'run-mine',f.io)).toThrow('account lease conflict');
  expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'run-other',f.io)).not.toThrow();
  const stop=join(f.root,'.practice/stop-swarm');writeFileSync(stop,'owner pause');
  expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'run-other',f.io)).toThrow('preserve owner pause');
  expect(existsSync(stop)).toBe(true);
 }finally{f.clear();}
});

test('missing fleet state or swarm metadata refuses instead of assuming no assignments',()=>{
 const f=fixture();try{
  rmSync(fleetStateFile(f.root));
  expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'',f.io)).toThrow('ownership unavailable');
  writeFileSync(fleetStateFile(f.root),JSON.stringify({schemaVersion:1,accounts:{}}));
  rmSync(join(f.root,'swarm.json'));
  expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'',f.io)).toThrow('ownership unavailable');
 }finally{f.clear();}
});

test('a held or corrupt newest lifecycle attempt cannot borrow an older status result or a missing status',()=>{
 const f=fixture();try{
  for(const status of [{name:'Donor',result:'RESULT ok old job'},null]){
   const file=join(f.root,'.practice/status/Donor.json');
   if(status)writeFileSync(file,JSON.stringify(status));else rmSync(file);
   for(const state of ['held','invalid'])expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'',{...f.io,logoutState:()=>state})).toThrow('ownership unsettled');
   expect(()=>checkTransferAccounts(f.root,['Donor'],'localhost:8888',[],'',{...f.io,logoutState:()=> 'none'})).not.toThrow();
  }
 }finally{f.clear();}
});

test('transfer journal keys cannot escape their own order directory',()=>{
 expect(transferOrderKey('task-abc123','COIN_ORDER')).toBe('task-abc123');
 for(const key of ['', '../other','a/b','a\\b','a\nb','a'.repeat(81)])expect(()=>transferOrderKey(key,'ITEM_ORDER')).toThrow('invalid ITEM_ORDER');
});
