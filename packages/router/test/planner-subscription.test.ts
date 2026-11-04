import {test,expect} from 'bun:test';
import {runPlannerModel} from '../src/coordinator-planner';
import type {ModelWorker} from '../src/model-worker';
const limited={ok:false,text:"You've hit your weekly limit · resets Nov 3, 11pm (Europe/London)",costUsd:0};
const answer={ok:true,text:'{"reason":"finite work","tasks":[],"capabilities":[]}',costUsd:0};
test('a subscription limit uses the other read-only planner within the original deadline',async()=>{
 let now=100;const calls:unknown[]=[];
 const result=await runPlannerModel('claude','observed world',10000,async(agent,prompt,timeout,readOnly)=>{
  calls.push({agent,prompt,timeout,readOnly});now+=500;return agent==='claude'?limited:answer;
 },()=>now);
 expect(calls).toEqual([{agent:'claude',prompt:'observed world',timeout:10000,readOnly:true},{agent:'codex',prompt:'observed world',timeout:9500,readOnly:true}]);
 expect(result.ok).toBe(true);expect(result.text).toBe(answer.text);
 expect(result.attempts.map(a=>[a.agent,a.ok,a.text])).toEqual([['claude',false,limited.text],['codex',true,answer.text]]);
});
test('an available planner is used once',async()=>{
 const calls:ModelWorker[]=[];const result=await runPlannerModel('codex','plan',10000,async agent=>{calls.push(agent);return answer;});
 expect(calls).toEqual(['codex']);expect(result.ok).toBe(true);
});
test('an ordinary failure does not trigger a model retry',async()=>{
 const calls:ModelWorker[]=[];const failure={ok:false,text:'model deadline exceeded',costUsd:0};
 const result=await runPlannerModel('claude','plan',10000,async agent=>{calls.push(agent);return failure;});
 expect(calls).toEqual(['claude']);expect(result.ok).toBe(false);expect(result.text).toBe(failure.text);
});
test('an exhausted deadline does not start a second planner',async()=>{
 let now=0,calls=0;const result=await runPlannerModel('claude','plan',1000,async()=>{calls++;now=1000;return limited;},()=>now);
 expect(calls).toBe(1);expect(result.ok).toBe(false);
});
test('both unavailable subscriptions retain both failures and stop after one fallback',async()=>{
 const calls:ModelWorker[]=[];const result=await runPlannerModel('codex','plan',10000,async agent=>{calls.push(agent);return limited;});
 expect(calls).toEqual(['codex','claude']);expect(result.ok).toBe(false);expect(result.attempts).toHaveLength(2);
});
test('fallback startup exceptions preserve the subscription receipt and the startup cause',async()=>{
 const result=await runPlannerModel('claude','plan',10000,async agent=>{if(agent==='claude')return limited;throw Error('Codex CLI unavailable');});
 expect(result.ok).toBe(false);expect(result.attempts).toHaveLength(2);
 expect(result.attempts[0]!.text).toBe(limited.text);expect(result.attempts[1]!.text).toContain('Codex CLI unavailable');
 expect(result.text).toContain('Codex CLI unavailable');
});
