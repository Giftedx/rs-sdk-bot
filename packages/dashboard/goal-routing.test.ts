import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {goalPlan} from './goals';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
test('each goal card uses its own plan target and next action when lane order differs',()=>{
 const plan=goalPlan(readFileSync(new URL('../../docs/plans/joined-plan.md',import.meta.url),'utf8'));
 const titles=['Fleet & wealth','Collection & gear','Quests · unlocks · 99s','Specialist hiscores','Main Overall','Tick efficiency'];
 const expected=['Wealth / logistics / GE','Gear / collection','Coverage','Specialist hiscores','Main Overall','Efficiency / visibility'];
 const start=html.indexOf('function goalPlanFor(');
 const code=html.slice(start<0?html.indexOf('function goalMetrics(){'):start,html.indexOf('function goalCards()'));
 const run=new Function('S',`${code};return goalMetrics();`);
 for(const lanes of [plan.lanes,[...plan.lanes].reverse()]){
  const cards=run({objectives:{...plan,lanes,progress:titles.map(title=>({title,next:'Fallback'}))}});
  cards.forEach((g:any,i:number)=>{const lane=plan.lanes.find(l=>l.title===expected[i])!;expect(g.next).toBe(lane.next);expect(g.plan?.target).toBe(lane.target);});
 }
});
