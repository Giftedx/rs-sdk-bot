import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
test('a new worker session resets XP, coin and food rate samples',()=>{
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(server.indexOf('const runStartCoins ='),server.indexOf('function goalSkillOf(')));
 const run=new Function(`const FILES={},NL=String.fromCharCode(10),tailJsonl=()=>[],coinsOf=s=>s.coins,foodOf=l=>l?.length??0,goalSkillOf=()=>null,append=()=>{},trackResult=()=>{};${code};return{track,rate,flowRate,spark};`)();
 const now=Date.now(),status=(started:number,tick:number,xp:number,coins:number)=>({name:'Worker',server:'rs-sdk-demo.fly.dev',started,at:now,tick,skills:[{name:'Mining',xp}],coins,bank:[],inventory:[]});
 run.track(status(1,10,100,10));run.track(status(1,20,200,20));
 expect(run.rate('Worker',null)).toBe(10);expect(run.flowRate('Worker','coins')).toBe(1);
 run.track(status(2,30,500,1000));
 expect(run.rate('Worker',null)).toBeNull();expect(run.flowRate('Worker','coins')).toBeNull();
 run.track(status(2,40,550,1010));
 expect(run.rate('Worker',null)).toBe(5);expect(run.flowRate('Worker','coins')).toBe(1);
 expect(run.spark.get('Worker')).toEqual([5]);
});
