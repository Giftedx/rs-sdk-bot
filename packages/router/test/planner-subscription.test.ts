import {test,expect} from 'bun:test';
import {runPlannerModel} from '../src/coordinator-planner';
import {reviewSource} from '../src/coordinator-worker';
import type {ModelWorker} from '../src/model-worker';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const limited={ok:false,text:"You've hit your weekly limit · resets Nov 3, 11pm (Europe/London)",costUsd:0};
const answer={ok:true,text:'{"reason":"finite work","tasks":[],"capabilities":[]}',costUsd:0};
test('the source review caller keeps its full primary deadline and inherited effort',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'subscription-review-')),calls:unknown[]=[];
 try{
  const verdict=await reviewSource('codex','source review',300000,directory,{run:async(agent,prompt,timeout,readOnly,options)=>{
   calls.push({agent,prompt,timeout,readOnly,options});return{ok:true,text:'{"approved":true,"reason":"checked source"}',costUsd:0};
  }});
  expect(calls).toEqual([{agent:'codex',prompt:'source review',timeout:300000,readOnly:true,options:{}}]);
  expect(verdict).toEqual({approved:true,reason:'checked source'});
  expect(JSON.parse(readFileSync(join(directory,'review-model.json'),'utf8')).attempts).toHaveLength(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('the source review caller keeps quota-only fallback with the remaining deadline',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'subscription-review-quota-')),calls:unknown[]=[];let now=0;
 try{
  const verdict=await reviewSource('claude','source review',300000,directory,{now:()=>now,run:async(agent,_prompt,timeout,readOnly,options)=>{
   calls.push({agent,timeout,readOnly,options});now+=1000;
   return agent==='claude'?limited:{ok:true,text:'{"approved":false,"reason":"concrete defect"}',costUsd:0};
  }});
  expect(calls).toEqual([{agent:'claude',timeout:300000,readOnly:true,options:{}},{agent:'codex',timeout:299000,readOnly:true,options:{}}]);
  expect(verdict).toEqual({approved:false,reason:'concrete defect'});
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('the source review caller cannot trade half its deadline for a timeout retry',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'subscription-review-timeout-')),calls:unknown[]=[];let now=0;
 try{
  await expect(reviewSource('codex','source review',300000,directory,{now:()=>now,run:async(agent,_prompt,timeout,readOnly,options)=>{
   calls.push({agent,timeout,readOnly,options});now+=timeout;return{ok:false,text:'model deadline exceeded',costUsd:0};
  }})).rejects.toThrow('review model unavailable');
  expect(calls).toEqual([{agent:'codex',timeout:300000,readOnly:true,options:{}}]);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('a subscription limit uses the other bounded read-only planner within the original deadline',async()=>{
 let now=100;const calls:unknown[]=[];
 const result=await runPlannerModel('claude','observed world',10000,async(agent,prompt,timeout,readOnly,options)=>{
  calls.push({agent,prompt,timeout,readOnly,options});now+=500;return agent==='claude'?limited:answer;
 },()=>now);
 expect(calls).toEqual([{agent:'claude',prompt:'observed world',timeout:5000,readOnly:true,options:{purpose:'planner'}},{agent:'codex',prompt:'observed world',timeout:9500,readOnly:true,options:{purpose:'planner'}}]);
 expect(result.ok).toBe(true);expect(result.text).toBe(answer.text);
 expect(result.attempts.map(a=>[a.agent,a.ok,a.text])).toEqual([['claude',false,limited.text],['codex',true,answer.text]]);
});
test('an available planner is used once',async()=>{
 const calls:ModelWorker[]=[];const result=await runPlannerModel('codex','plan',10000,async agent=>{calls.push(agent);return answer;});
 expect(calls).toEqual(['codex']);expect(result.ok).toBe(true);
});
test('an ordinary failure does not trigger a model retry',async()=>{
 const calls:ModelWorker[]=[];const failure={ok:false,text:'invalid model request',costUsd:0};
 const result=await runPlannerModel('claude','plan',10000,async agent=>{calls.push(agent);return failure;});
 expect(calls).toEqual(['claude']);expect(result.ok).toBe(false);expect(result.text).toBe(failure.text);
});
test.each(['codex','claude'] as const)('a stalled %s planner reserves time for the other subscription',async first=>{
 let now=0;const calls:unknown[]=[];
 const result=await runPlannerModel(first,'finite work',600000,async(agent,prompt,timeout,readOnly,options)=>{
  calls.push({agent,timeout,readOnly,options});
  if(agent===first){now+=timeout;return{ok:false,text:'model deadline exceeded',costUsd:0};}
  now+=1000;return answer;
 },()=>now);
 expect(calls).toEqual([{agent:first,timeout:300000,readOnly:true,options:{purpose:'planner'}},{agent:first==='codex'?'claude':'codex',timeout:300000,readOnly:true,options:{purpose:'planner'}}]);
 expect(result.ok).toBe(true);expect(result.attempts).toHaveLength(2);expect(now).toBe(301000);
});
test('two stalled subscriptions stop at the original planner deadline with both receipts',async()=>{
 let now=0;const calls:number[]=[];
 const result=await runPlannerModel('codex','finite work',600000,async(_agent,_prompt,timeout)=>{
  calls.push(timeout);now+=timeout;return{ok:false,text:'model deadline exceeded',costUsd:0};
 },()=>now);
 expect(calls).toEqual([300000,300000]);expect(now).toBe(600000);expect(result.ok).toBe(false);expect(result.attempts).toHaveLength(2);
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
