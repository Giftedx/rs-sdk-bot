import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {gearProgress,questProgress,batchCosts} from './goal-details';
const now=1_000_000;
test('gear target uses exact real IDs, observes age and cannot count invisible necklace',()=>{
 const items=JSON.parse(readFileSync(new URL('../../knowledge/items.json',import.meta.url),'utf8'));
 let g=gearProgress([{name:'Worker',at:now-1,bankAt:now-1,bank:[{id:1672,count:1}],equipment:[{id:1377,count:1}]}],items,now);
 expect(g.value).toBe(1_366_450);expect(g.total).toBe(10);expect(g.held).toBe(1);
 g=gearProgress([{name:'Worker',bankAt:now-300001,bank:[{id:1664,count:1}]}],items,now);expect(g.held).toBe(0);expect(g.rows.find(r=>r.label.startsWith('Neck'))?.value).toContain('old stock');
 expect(gearProgress([{name:'Future',bankAt:now+1,bank:[{id:1664,count:1}]}],items,now).held).toBe(0);
});
test('quest flags require known component identity, valid state and account timestamp',()=>{
 const b={name:'Worker',at:now-1,quests:[{id:7333,name:"Cook's Assistant",state:'complete'},{id:7333,name:"Cook's Assistant",state:'complete'},{id:7334,name:'wrong',state:'complete'},null]};
 let q=questProgress([b],now);expect(q.total).toBe(68);expect(q.completed).toBe(1);expect(q.observed).toBe(1);
 q=questProgress([{...b,at:now+1},{name:'Old client',at:now-1}],now);expect(q.completed).toBe(0);expect(q.observed).toBe(0);
});
test('batch accounting keeps consumed food separate and rejects missing or failed ledgers',()=>{
 const counters:Record<string,number>={coinsGained:46200,eaten:14,ticks:3044};
 const c=(k:string)=>counters[k]??null;
 let b=batchCosts(c,true);expect(b.known).toBe(true);expect(b.rows[0]!.value).toBe('+46,200 coins / −14 food');expect(b.rows.find(r=>r.label==='Break-even allowance')?.value).toContain('3300.00');
 expect(b.rows.find(r=>r.label==='Unallocated costs')?.value).toContain('no matched chain receipt');expect(batchCosts(c,false).known).toBe(false);delete counters.eaten;expect(batchCosts(c,true).known).toBe(false);
});

test('raw and enchanted dragonstone rings satisfy one score target without an enchantment gate',()=>{
 const items=JSON.parse(readFileSync(new URL('../../knowledge/items.json',import.meta.url),'utf8'));
 for(const bank of [[{id:1645,count:1}],[{id:2572,count:1}],[{id:1645,count:1},{id:2572,count:1}]]){
  const g=gearProgress([{name:'Worker',bankAt:now-1,bank}],items,now);expect(g.held).toBe(1);expect(g.value).toBe(1366450);
  expect(g.rows.find(r=>r.label.startsWith('Ring'))?.value).not.toContain('Magic 68');
 }
 expect(gearProgress([{name:'Old',bankAt:now-300001,bank:[{id:2572,count:1}]}],items,now).held).toBe(0);
 expect(gearProgress([{name:'Wrong',bankAt:now-1,bank:[{id:1635,count:1}]}],items,now).held).toBe(0);
});
