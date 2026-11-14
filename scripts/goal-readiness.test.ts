import {expect,test} from 'bun:test';
import {goalReadiness} from './goal-readiness';
import {questDefinitions} from '../packages/core/src/quest-status';
const now=1_000_000;
const q=questDefinitions().find(q=>q.name==='Rune Mysteries Quest')!;
const status=()=>({name:'worker',server:'rs-sdk-demo.fly.dev',at:now-1,bankAt:now-1,quests:[{...q,state:'complete'}],inventory:[],equipment:[],bank:[{id:1267,count:1}]});
test('one observed unlock serves quest credit and essence; an alternative bank pick supports preparation',()=>{
 const r=goalReadiness(status(),'worker',now);
 expect(r.goals['rune-quest-credit']?.state).toBe(true);expect(r.goals['essence-access']?.state).toBe(true);expect(r.goals['essence-tools']?.state).toBe(true);
 expect(r.goals['heroes-gear-prerequisite']?.state).toBeNull();
});
test('wrong account, server, stale state and duplicate flags stay unknown',()=>{
 for(const change of [(s:any)=>s.name='other',(s:any)=>s.server='localhost',(s:any)=>s.at=now-300001,(s:any)=>s.quests.push({...q,state:'not started'})]){
  const s=status();change(s);expect(goalReadiness(s,'worker',now).goals['essence-access']?.state).toBeNull();
 }
 const s=status();s.quests[0]!.state='started';expect(goalReadiness(s,'worker',now).goals['essence-access']?.state).toBe(false);
});

test('full shared journals keep their identity, date and explicit unknown states authoritative',()=>{
 const shared={...status(),quests:['Rune Mysteries Quest'],questJournal:[{...q,state:'complete'}],questsAt:now-10};
 expect(goalReadiness(shared,'worker',now).goals['essence-tools']?.state).toBe(true);
 for(const state of ['started','not started','unknown']){
  const result=goalReadiness({...shared,questJournal:[{...q,state}]},'worker',now);
  expect(result.goals['essence-access']?.state).toBe(state==='unknown'?null:false);
 }
 for(const questJournal of [null,undefined,'complete',[],[{...q,name:'wrong'}],[{...q,state:'complete'},{...q,state:'complete'}]])
  expect(goalReadiness({...shared,questJournal},'worker',now).goals['essence-access']?.state).toBeNull();
 for(const questsAt of [undefined,null,now-300001,now+1,shared.at+1])
  expect(goalReadiness({...shared,questsAt},'worker',now).goals['essence-access']?.state).toBeNull();
 const {questsAt:_,...undated}=shared;
 expect(goalReadiness(undated,'worker',now).goals['essence-access']?.state).toBeNull();
 expect(goalReadiness({...status(),quests:['Rune Mysteries Quest']},'worker',now).goals['essence-access']?.state).toBeNull();
});
