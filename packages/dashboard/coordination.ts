// Read-only projection. The dashboard never writes the queue or takes a lease.
export function coordinationView(state:any,at:number,now:number,paused=false){
 if(!state||state.version!==1||!Array.isArray(state.tasks))return{available:false,at:null,fresh:false,tasks:[],agents:[],counts:{} as Record<string,number>};
 const tasks=state.tasks.filter((r:any)=>r?.spec&&r.status!=='superseded').map((r:any)=>{
  const capability=r.spec.capability??null,agent=r.agent??r.spec.agent??(r.spec.kind==='build'?'claude':null),account=r.spec.account??null;
  const participants=Array.isArray(r.spec.participants)&&r.spec.participants.length?r.spec.participants:null;
  const evidence=r.receipt?.output?.evidence??null,detail=r.receipt?.error??r.receipt?.output?.error??r.receipt?.output?.review?.reason??r.receipt?.output?.delivery?.reason??'';
  return {
   id:r.spec.id,goal:r.spec.goal,kind:r.spec.kind,status:r.status,why:r.spec.why,dependsOn:r.spec.dependsOn??[],attempts:r.attempts??0,
   ...(capability!==null?{capability}:{}),...(agent!==null?{agent}:{}),...(account!==null?{account}:{}),...(participants?{participants}:{}),
   ...(r.startedAt!=null?{startedAt:r.startedAt}:{}),...(r.receipt?.at!=null?{finishedAt:r.receipt.at}:{}),...(evidence!==null?{evidence}:{}),
   ...(r.createdAt!=null?{createdAt:r.createdAt}:{}),...(r.spec.priority!=null?{priority:r.spec.priority}:{}),...(detail?{detail}:{}),
  };
 });
 const fresh=Number.isFinite(at)&&now>=at&&now-at<10000;
 const agents=['codex','claude'].map(agent=>({name:agent,tasks:tasks.filter((r:any)=>r.status==='running'&&r.agent===agent).map((r:any)=>r.id),
  planning:state.planner?.agent===agent||(agent==='claude'&&state.planner&&!state.planner.agent),
  fresh,paused}));
 return{available:true,at,fresh,paused,agents,tasks,planner:state.planner?{agent:state.planner.agent??'claude',startedAt:state.planner.startedAt}:null,
  counts:Object.fromEntries(['running','pending','succeeded','failed'].map(status=>[status,tasks.filter((r:any)=>r.status===status).length]))};
}
