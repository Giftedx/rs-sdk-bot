// The two files the hosted dashboard (rs-fleet-command) reads, from the local dashboard server's own state
// (server.ts /api/state, already masked: every string has the main account's name replaced by ⟦MAIN⟧) and its
// operator metadata (/api/control). control.json is for the signed-in owner; public.json is the same page's data
// without the main account's row, the per-bot env, session ids and work revisions, and this PC's process list.
export const MAIN_ACCOUNT='Haggis';
export const MAIN_MARK='⟦MAIN⟧';
export const WHY_LIMIT=400,DETAIL_LIMIT=300,FINISHED_KEEP=200;
const BOT_PRIVATE=['env','sessionAttemptId','workRevision','inputs','coordinatorRunId'] as const;

// Coordinator tasks are the bulk of the state (a review spec can run to kilobytes; hundreds of tasks are finished).
// The page shows a line per task: texts are capped, and only the newest FINISHED_KEEP finished tasks travel.
export function trimState(state:any){
 if(!Array.isArray(state?.coordination?.tasks))return state;
 const all=state.coordination.tasks.map((t:any)=>({...t,why:String(t.why??'').slice(0,WHY_LIMIT),detail:String(t.detail??'').slice(0,DETAIL_LIMIT)}));
 const open=all.filter((t:any)=>t.status==='running'||t.status==='pending');
 const finished=all.filter((t:any)=>t.status!=='running'&&t.status!=='pending').sort((a:any,b:any)=>(b.finishedAt??b.createdAt??0)-(a.finishedAt??a.createdAt??0)).slice(0,FINISHED_KEEP);
 return {...state,coordination:{...state.coordination,tasks:[...open,...finished]}};
}
// Each bot row names its fleet side (fleet/owners.json; an unlisted account is local), so the page can show worlds.
export function withSides(state:any,owners:ReadonlyMap<string,{side:string}>){
 if(!Array.isArray(state?.bots))return state;
 return {...state,bots:state.bots.map((b:any)=>({...b,side:owners.get(String(b?.name??'').toLowerCase())?.side??'local'}))};
}
export function controlView(state:any,controlMeta:any,main=MAIN_ACCOUNT){
 const {nonce:_nonce,...meta}=controlMeta??{};
 return {...trimState(state),control:controlMeta?meta:null,revealName:main,hosted:{at:Date.now(),kind:'control'}};
}
export function publicView(state:any,main=MAIN_ACCOUNT){
 const s=trimState(state);
 const bots=(s.bots??[]).filter((b:any)=>b?.name!==MAIN_MARK&&!b?.reserved&&String(b?.name??'').toLowerCase()!==main.toLowerCase()).map((b:any)=>{const copy={...b};for(const f of BOT_PRIVATE)delete copy[f];return copy;});
 // The owner's request ledger and the main run's plan, race and launch gates are the owner's: control only.
 const {viewerTimings:_timings,requests:_requests,mainPlan:_plan,race:_race,gates:_gates,...rest}=s;
 // The queue's task texts are the agents' working notes: counts and agents stay, the tasks do not.
 const coordination=s.coordination&&typeof s.coordination==='object'?{...s.coordination,tasks:[]}:s.coordination;
 const out={...rest,bots,coordination,sys:s.sys?{...s.sys,procs:[]}:s.sys,requests:{},mainPlan:null,race:null,gates:null,hosted:{at:Date.now(),kind:'public'}};
 const text=JSON.stringify(out);
 if(new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(text))throw Error('public view still names the main account; nothing published');
 return out;
}
