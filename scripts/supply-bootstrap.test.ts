import {expect,test,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {bootstrapAccountServer,bootstrapPracticeServer,bootstrapSupplyActor} from './supply-bootstrap';
import * as starter from './rune-starter';
import {setEquipmentObserved} from '../packages/core/src/container-observation';

test('destructive bootstrap accepts isolated loopback engines on their own ports',()=>{
 for(const server of ['localhost:8888','127.0.0.1:21000','127.1.2.3:21010','[::1]:21100','::1','LOCALHOST:8888']){
  expect(bootstrapPracticeServer(`SERVER=${server}\r\nPASSWORD=fixture\r\n`)).toBe(server);
 }
 expect(bootstrapPracticeServer('PASSWORD=fixture\n')).toBe('localhost:8888');
});

test('public endpoints and loopback-looking domain names never admit destructive bootstrap',()=>{
 for(const server of ['rs-sdk-demo.fly.dev','example.com:8888','localhost.evil.test:8888','127.0.0.1.evil.test:8888','0.0.0.0:8888']){
  expect(()=>bootstrapPracticeServer(`SERVER=${server}\nDEMO_OK=1\n`)).toThrow('isolated loopback');
 }
 for(const name of ['','../Haggis','worker.env','toolongaccountname'])expect(()=>bootstrapAccountServer(name)).toThrow('valid practice account');
});

test('CLI refuses a public endpoint before opening a session even with the public-server override',()=>{
 const root=resolve(import.meta.dir,'..'),dir=mkdtempSync(join(root,'vendor/rs-sdk/bots','bp'));
 try{
  const name=basename(dir);
  writeFileSync(join(dir,'bot.env'),'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=fixture-never-authenticate\n');
  const result=Bun.spawnSync([process.execPath,'scripts/supply-bootstrap.ts',name],{
   cwd:root,env:{...process.env,ROLE:'producer',PHASE:'clean',DEMO_OK:'1'},stdout:'pipe',stderr:'pipe',timeout:15000,windowsHide:true,
  });
  const output=result.stdout.toString()+result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(output).toMatch(/^RESULT fail (?:Error: )?supply bootstrap: isolated loopback practice actor required/m);
  expect(output).not.toMatch(/^START /m);
  expect(output).not.toContain('BOOTSTRAP_DISCARD');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('practice bootstrap requires the observed tutorial grant before discarding or earning',async()=>{
 const root=resolve(import.meta.dir,'..'),dir=mkdtempSync(join(root,'vendor/rs-sdk/bots','bp')),name=basename(dir);
 writeFileSync(join(dir,'bot.env'),'SERVER=localhost:21000\nPASSWORD=fixture-never-authenticate\n');
 let tick=0,discarded=0,earned=0;const listeners=new Set<()=>void>(),client={};setEquipmentObserved(client,true);
 const state:any={player:{worldX:3094,worldZ:3106,level:0,lifeId:1,respawnCount:0},inventory:[],equipment:[],
  skills:[{name:'Hitpoints',baseLevel:10},...Array.from({length:20},(_,i)=>({name:'skill'+i,baseLevel:1}))]};
 const s:any={name,client,tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getState:()=>state,getInventory:()=>state.inventory,getEquipment:()=>state.equipment,getSkill:()=>({level:10,baseLevel:10}),sendDropItem:async()=>{discarded++;return{success:true};}},
  bot:{skipTutorial:async()=>{throw Error('legacy tutorial path');},pickpocketNpc:async()=>{earned++;return{success:true};}}};
 const bounded=spyOn(starter,'leaveRuneStarter').mockImplementation(async(session,stop)=>{expect(session).toBe(s);expect(stop()).toBe(false);throw Error('starter entry deadline: grant unobserved');});
 const timer=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},1);
 try{
  await expect(bootstrapSupplyActor(s,'producer',undefined,'clean')).rejects.toThrow('starter entry deadline');
  expect(bounded).toHaveBeenCalledTimes(1);expect(discarded).toBe(0);expect(earned).toBe(0);
 }finally{clearInterval(timer);bounded.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
