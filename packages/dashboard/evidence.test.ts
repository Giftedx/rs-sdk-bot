import {test,expect} from 'bun:test';
import {requestEvidence,gateView} from './evidence';
import {GATE_NAMES} from '../core/src/launch-evidence';
test('touching historical request text cannot make its status current',()=>{
 const r=requestEvidence('> Historical request ledger, last audited 2026-10-23.\n| 1 | DONE |',Date.parse('2026-10-23T01:00Z'));
 expect(r.current).toBe(false);expect(r.historical).toBe(true);
 expect(requestEvidence('no audit date').current).toBe(false);
});
test('expired, future, legacy and missing gate receipts never render passing gates',()=>{
 const now=1000000,g={version:2,go:true,at:now,expiresAt:now+1000,context:'a'.repeat(64),bindings:[{path:'source',sha256:'a'.repeat(64)}],gates:GATE_NAMES.map(name=>({name,pass:true}))};
 expect(gateView(g,now).go).toBe(true);
 expect(gateView({...g,go:false},now).state).toBe('Not authorized');
 for(const v of [null,{...g,version:1},{...g,at:now+1},{...g,expiresAt:now-1}]){
  expect(gateView(v,now).go).toBe(false);expect(gateView(v,now).gates.some((x:any)=>x.pass)).toBe(false);
 }
});

test('fresh no-go preserves individual results and reasons',()=>{
 const now=1000000,g={version:2,go:false,at:now,expiresAt:now+1000,context:'a'.repeat(64),bindings:[{path:'source',sha256:'a'.repeat(64)}],gates:GATE_NAMES.map((name,i)=>({name,pass:i!==0,detail:i===0?'route too slow':'proved'}))};
 const v=gateView(g,now);expect(v.valid).toBe(true);expect(v.go).toBe(false);expect(v.gates.filter((x:any)=>x.pass)).toHaveLength(4);expect(v.gates[0].detail).toBe('route too slow');
});
