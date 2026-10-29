import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {startStatus} from '../src/status';
const name=`JournalTest${process.pid}`,file=`.practice/status/${name}.json`,server='localhost:8888';
const flag={id:7333,name:"Cook's Assistant",state:'complete'};
const read=()=>JSON.parse(readFileSync(file,'utf8'));
function session(){
 const callbacks:(()=>void)[]=[];
 const s:any={name,client:{ingame:false,ifType:()=>({colour:0xff0000})},sdk:{getState:()=>({skills:[],inventory:[]})},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
 return {s,tick:()=>callbacks.forEach(cb=>cb())};
}
test('capture between writes survives logout, restart and pristine reconnect without rejuvenating age',()=>{
 const {s,tick}=session();let status=startStatus(s,server);
 try{
  expect(read().quests).toBeNull();
  s.client.ingame=true;s.client.ifType=(id:number)=>({colour:id===7333?0x00f800:0xff0000});tick();
  s.client.ingame=false;status.stop();
  const saved=read();expect(saved.quests.find((q:any)=>q.id===7333)).toEqual(flag);expect(saved.questsAt).toBeGreaterThan(0);
  const old=Date.now()-600000;writeFileSync(file,JSON.stringify({...saved,questsAt:old}));
  const next=session();status=startStatus(next.s,server);expect(read().questsAt).toBe(old);
  next.s.client.ingame=true;next.tick();status.stop();expect(read().questsAt).toBe(old);expect(read().quests).toEqual(saved.quests);
 }finally{status.stop();rmSync(file,{force:true});}
});
for(const kind of ['name','server','future','null-date','identity','duplicate','unknown','status-before-observation'])test(`prior journal rejects ${kind}`,()=>{
 const at=Date.now()-5000,prior:any={name,server,at,questsAt:at,quests:[flag]};
 if(kind==='name')prior.name='foreign';if(kind==='server')prior.server='foreign';if(kind==='future')prior.questsAt=Date.now()+100000;
 if(kind==='null-date')prior.questsAt=null;if(kind==='identity')prior.quests=[{...flag,name:'wrong'}];if(kind==='duplicate')prior.quests=[flag,flag];
 if(kind==='unknown')prior.quests=[{...flag,state:'unknown'}];if(kind==='status-before-observation')prior.at=at-1;
 writeFileSync(file,JSON.stringify(prior));const {s}=session(),status=startStatus(s,server);
 try{expect(read().quests).toBeNull();expect(read().questsAt).toBeNull();}finally{status.stop();rmSync(file,{force:true});}
});
test('legacy dated journal keeps its original date',()=>{
 const at=Date.now()-600000;writeFileSync(file,JSON.stringify({name,server,at,quests:[flag]}));const {s}=session(),status=startStatus(s,server);
 try{expect(read().quests).toEqual([flag]);expect(read().questsAt).toBe(at);}finally{status.stop();rmSync(file,{force:true});}
});
