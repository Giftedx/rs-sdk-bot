import {test,expect} from 'bun:test';
import {validateSupplies,validateRehearsals,gateProblem,GATE_NAMES} from '../src/launch-evidence';
const now=10000000, context='a'.repeat(64);
const refs=new Map<string,any>();
const read=(r:any)=>{if(!refs.has(r.path))throw Error('missing evidence');return refs.get(r.path)};
const bank={name:'Holder',server:'rs-sdk-demo.fly.dev',bankAt:now-1000,bank:[{id:314,count:100}]};
const delivery={before:[],after:[{id:314,count:100}],ok:true,observed:true,server:'rs-sdk-demo.fly.dev',from:'Worker',to:'Holder',at:now-2000,items:[{id:314,count:100}]};
function supplies(){refs.clear();refs.set('bank',bank);refs.set('delivery',delivery);return {version:2,context,at:now-1000,allocations:[{item:'Feathers',itemId:314,count:100,holder:'Holder',recipient:'haggis',bank:{path:'bank'},delivery:{path:'delivery'}}]};}
const requirements=[{item:'Feathers',count:100}], catalog=[{id:314,name:'Feather'}],owned=['Worker','Holder'];
test('staging requires observed bank stock and delivered quantities, not a flag',()=>{
 expect(()=>validateSupplies(supplies(),context,requirements,catalog,owned,now,read)).not.toThrow();
 expect(()=>validateSupplies({staged:true,at:now},context,requirements,catalog,owned,now,read)).toThrow();
 const s=supplies();s.allocations.push({...s.allocations[0]!});
 expect(()=>validateSupplies(s,context,requirements,catalog,owned,now,read)).toThrow();
});
test('staging reserves the total when noted and plain requirements draw from the same base stock', () => {
 const wine=[{item:'Unfermented wine',count:600},{item:'Unfermented wine (noted)',count:600}];
 const wineCatalog=[{id:1995,name:'Unfermented wine'}];
 const manifest=(count:number)=>{
  const s=supplies();
  const stock=[{id:1995,count}];
  refs.set('bank',{...bank,bank:stock});
  refs.set('delivery',{...delivery,after:stock,items:stock});
  s.allocations=[{...s.allocations[0]!,item:'Unfermented wine',itemId:1995,count}];
  return s;
 };
 expect(()=>validateSupplies(manifest(600),context,wine,wineCatalog,owned,now,read)).toThrow('Missing or excess reservation');
 expect(()=>validateSupplies(manifest(1200),context,wine,wineCatalog,owned,now,read)).not.toThrow();
 expect(()=>validateSupplies(manifest(1201),context,wine,wineCatalog,owned,now,read)).toThrow('Missing or excess reservation');
});
test('staging rejects stale/future stock, wrong owner, short delivery and context drift',()=>{
 for(const patch of [{bankAt:now+1},{bankAt:now-3600001},{name:'Stranger'},{bank:[{id:314,count:99}]}]){
  const s=supplies();refs.set('bank',{...bank,...patch});expect(()=>validateSupplies(s,context,requirements,catalog,owned,now,read)).toThrow();
 }
 const s=supplies();refs.set('delivery',{...delivery,items:[{id:314,count:99}]});expect(()=>validateSupplies(s,context,requirements,catalog,owned,now,read)).toThrow();
 expect(()=>validateSupplies(s,'b'.repeat(64),requirements,catalog,owned,now,read)).toThrow();
});
function rehearsal(i:number){return {version:2,context,runId:String(i),actor:'practice'+i,server:'localhost:8888',at:now-i*1000,startPlaytime:0,endPlaytime:100,planTicks:100,ok:true,died:false,logout:'logged-out',boardTicks:{overall:100},log:{path:'log'+i}};}
test('rehearsals require three distinct full-clock runs and matching raw logs',()=>{
 const runs=[1,2,3].map(i=>{const r=rehearsal(i);refs.set('log'+i,'REHEARSAL '+JSON.stringify(r)+'\nRESULT ok');return r});
 expect(()=>validateRehearsals(runs,context,{overall:100},now,read)).not.toThrow();
 expect(()=>validateRehearsals([runs[0],runs[0],runs[0]],context,{overall:100},now,read)).toThrow();
 expect(()=>validateRehearsals(runs.map(r=>({...r,startPlaytime:25})),context,{overall:100},now,read)).toThrow();
 expect(()=>validateRehearsals(runs,context,{overall:90},now,read)).toThrow();
});
test('login receipt rejects legacy, missing gates, future and expired authorizations',()=>{
 const g={version:2,go:true,at:now,expiresAt:now+60000,context,gates:GATE_NAMES.map(name=>({name,pass:true})),bindings:[{path:'source',sha256:context}]};
 expect(gateProblem(g,now)).toBeNull();
 for(const bad of [{...g,version:1},{...g,gates:[]},{...g,at:now+1},{...g,expiresAt:now-1},{...g,go:false}])expect(gateProblem(bad,now)).not.toBeNull();
});

test('delivery failures and unobserved transfers fail; receipt age bounds permission',()=>{
 for(const patch of [{ok:false},{after:[{id:314,count:99}]},{observed:false},{server:'localhost:8888'}]){
  const s=supplies();refs.set('delivery',{...delivery,...patch});expect(()=>validateSupplies(s,context,requirements,catalog,owned,now,read)).toThrow();
 }
 const s=supplies();refs.set('delivery',{...delivery,at:now-3600000+1});
 expect(validateSupplies(s,context,requirements,catalog,owned,now,read)).toBe(now+1);
});
