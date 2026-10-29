// Read-only projection. The dashboard never writes the queue or takes a lease.
export function coordinationView(state:any,at:number,now:number,paused=false){
 if(!state||state.version!==1||!Array.isArray(state.tasks))return{available:false,at:null,fresh:false,tasks:[],agents:[],counts:{}};
 const tasks=state.tasks.filter((r:any)=>r?.spec&&r.status!=='superseded').map((r:any)=>({
  id:r.spec.id,goal:r.spec.goal,kind:r.spec.kind,capability:r.spec.capability??null,status:r.status,
  agent:r.agent??r.spec.agent??(r.spec.kind==='build'?'claude':null),account:r.spec.account??null,participants:r.spec.participants??[],
  why:r.spec.why,dependsOn:r.spec.dependsOn??[],startedAt:r.startedAt??null,finishedAt:r.receipt?.at??null,
  evidence:r.receipt?.output?.evidence??null,
  createdAt:r.createdAt??null,attempts:r.attempts??0,priority:r.spec.priority??null,timeoutMs:r.spec.timeoutMs??null,
  detail:r.receipt?.error??r.receipt?.output?.error??r.receipt?.output?.review?.reason??r.receipt?.output?.delivery?.reason??'',
 }));
 const fresh=Number.isFinite(at)&&now>=at&&now-at<10000;
 const agents=['codex','claude'].map(agent=>({name:agent,tasks:tasks.filter((r:any)=>r.status==='running'&&r.agent===agent).map((r:any)=>r.id),
  planning:state.planner?.agent===agent||(agent==='claude'&&state.planner&&!state.planner.agent),
  fresh,paused}));
 return{available:true,at,fresh,paused,agents,tasks,planner:state.planner?{agent:state.planner.agent??'claude',startedAt:state.planner.startedAt}:null,
  counts:Object.fromEntries(['running','pending','succeeded','failed'].map(status=>[status,tasks.filter((r:any)=>r.status===status).length]))};
}
