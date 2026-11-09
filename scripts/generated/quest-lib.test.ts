import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('quest handoff belongs only to its matching named or explicit session',()=>{
 const root=resolve(import.meta.dir,'../..');
 const bot=pathToFileURL(resolve(root,'packages/core/src/bot.ts')).href;
 const library=pathToFileURL(resolve(root,'scripts/generated/quest-lib.ts')).href;
 const code=`import {mock} from 'bun:test';import assert from 'node:assert/strict';
 const botUrl=${JSON.stringify(bot)},libraryUrl=${JSON.stringify(library)};
 const actual=await import(botUrl);let opened=[];let tick=0;const callbacks=new Set();
 const make=name=>({name,tick:()=>tick,ended:new Promise(()=>{}),onTick:cb=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getState:()=>({player:{lifeId:1,respawnCount:0,worldX:2548,worldZ:3119,level:0},inventory:[],recentDialogs:[],gameMessages:[]}),getInventory:()=>[],getDialog:()=>({isOpen:false}),getSkill:()=>({level:99,baseLevel:99}),getSkillXp:()=>0},direct:async()=>{throw Error('first-owned-direct:'+name);}});
 const main=make('Main'),helper=make('Helper');
 mock.module(botUrl,()=>({...actual,openBot:async name=>{opened.push(name);assert.equal(name,'Helper');return helper;}}));
 const {openQuest}=await import(libraryUrl);
 const cases=[{options:{session:helper},selected:'Helper',acks:0,opened:[]},{options:{name:'Helper'},selected:'Helper',acks:0,opened:['Helper']},{options:{name:'main'},selected:'Main',acks:1,opened:[]},{options:{session:main},selected:'Main',acks:1,opened:[]},{options:{},selected:'Main',acks:1,opened:[]}];
 const timer=setInterval(()=>{tick++;for(const cb of callbacks)cb();},1);
 try{for(const c of cases){let acks=0;opened=[];globalThis.QUEST_SESSION=main;globalThis.QUEST_SESSION_TAKEN=()=>{acks++;delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;};await assert.rejects(openQuest(c.options),new RegExp('first-owned-direct:'+c.selected));assert.equal(acks,c.acks);assert.deepEqual(opened,c.opened);if(!c.acks)assert.equal(globalThis.QUEST_SESSION,main);delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;}opened=[];await assert.rejects(openQuest({name:'Helper'}),/first-owned-direct:Helper/);assert.deepEqual(opened,['Helper']);console.log('QUEST_HANDOFF_OWNER_SIX_CASES');}finally{clearInterval(timer);delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;}`;
 const result=Bun.spawnSync(['bun','-e',code],{cwd:root,env:{...process.env,Q_BURST:'0'},stdout:'pipe',stderr:'pipe',timeout:30000,windowsHide:true});
 if(result.exitCode!==0)throw Error(result.stderr.toString()||result.stdout.toString());
 expect(result.exitCode).toBe(0);expect(result.stdout.toString()).toContain('QUEST_HANDOFF_OWNER_SIX_CASES');
});
