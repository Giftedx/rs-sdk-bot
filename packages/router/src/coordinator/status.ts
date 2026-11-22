import type {CoordTask} from './types';

type LiveStatusContext={account:string;goal:string;source:string;startedAt:number;now:number;runId?:string};

function matchesLiveStatus(s:any,ctx:LiveStatusContext):boolean{
 return typeof s?.name==='string'&&s.name.toLowerCase()===ctx.account.toLowerCase()
  &&s.server==='rs-sdk-demo.fly.dev'&&!s.practice
  &&(ctx.runId?s.coordinatorRunId===ctx.runId:s.goal===ctx.goal)&&s.workRevision===ctx.source
  &&Number.isFinite(s.at)&&s.at>=ctx.startedAt&&s.at<=ctx.now&&ctx.now-s.at<=300000
  &&Number.isFinite(s.started)&&s.started>=ctx.startedAt;
}

export function boundedWorkerEndMessage(end:{at:number;reason:string},status:any,ctx:LiveStatusContext):string{
 const message='bounded worker ended: '+end.reason;
 if(!ctx.runId||!matchesLiveStatus(status,ctx)||status.at>end.at||typeof status.result!=='string')return message;
 const result=status.result.split(/\r?\n/,1)[0]!.slice(0,160);
 return /^(?:ok|fail)(?:\s|$)/.test(result)?message+' | worker result: '+result:message;
}

export function acceptStatus(task:CoordTask,s:any,ctx:LiveStatusContext):boolean{
 if(!matchesLiveStatus(s,ctx)||!/^ok(?:\s|$)/.test(s.result??''))return false;
 for(const [name,n]of Object.entries(task.accept?.skills??{}))if(!s.skills?.some((v:any)=>v.name===name&&Number.isFinite(v.level)&&v.level>=n))return false;
 for(const [id,n]of Object.entries(task.accept?.bank??{})){
  if(!Number.isFinite(s.bankAt)||s.bankAt<ctx.startedAt||s.bankAt>s.at||!Array.isArray(s.bank))return false;
  if(s.bank.filter((v:any)=>(v.baseId??v.id)===Number(id)&&Number.isFinite(v.count)).reduce((v:number,i:any)=>v+i.count,0)<n)return false;
 }
 for(const [key,n]of Object.entries(task.accept?.counters??{}))if(!Number.isFinite(s.counters?.[key])||s.counters[key]<n)return false;
 for(const name of task.accept?.quests??[])if(!s.quests?.some((q:any)=>q.name===name&&q.state==='complete'))return false;
 return true;
}
