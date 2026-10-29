import {test,expect} from 'bun:test';
import {questProgress} from './goal-details';
import {goalReadiness} from '../../scripts/goal-readiness';
import {questDefinitions} from '../core/src/quest-status';
const now=1_000_000,b={name:'Worker',at:now-1,quests:[{id:7333,name:"Cook's Assistant",state:'complete'}]};
test('fresh status does not refresh old journal evidence',()=>{
 const q=questProgress([{...b,questsAt:now-400000}],now);
 expect(q.completed).toBe(1);expect(q.rows.find(r=>r.label==='Worker')?.value).toContain('old');
 expect(q.rows.find(r=>r.label==='Worker')?.at).toBe(now-400000);
 expect(q.rows.find(r=>r.label.startsWith('Worker ·'))?.at).toBe(now-400000);
});
test('invalid explicit journal dates cannot fall back to fresh status; legacy may',()=>{
 for(const questsAt of [null,undefined,0,now+1,'999999',NaN])expect(questProgress([{...b,questsAt}],now).observed).toBe(0);
 expect(questProgress([b],now).completed).toBe(1);
});
test('old retained flags cannot authorize a fresh unlock',()=>{
 const q=questDefinitions().find(q=>q.name==='Rune Mysteries Quest')!;
 const status={name:'Worker',server:'rs-sdk-demo.fly.dev',at:now-1,quests:[{...q,state:'complete'}]};
 for(const questsAt of [null,0,now+1,now-300001])expect(goalReadiness({...status,questsAt},'Worker',now).goals['essence-access']?.state).toBeNull();
 expect(goalReadiness({...status,questsAt:now-2},'Worker',now).goals['essence-access']?.state).toBe(true);
});
