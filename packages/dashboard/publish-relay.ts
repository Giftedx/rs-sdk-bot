// The two files the hosted dashboard (rs-fleet-command) reads, from the local dashboard server's own state
// (server.ts /api/state, already masked: every string has the main account's name replaced by ⟦MAIN⟧) and its
// operator metadata (/api/control). control.json is for the signed-in owner; public.json is a whitelist of the
// same data without the main account (see publicView).
export const MAIN_ACCOUNT='Haggis';
export const MAIN_MARK='⟦MAIN⟧';
export const WHY_LIMIT=400,DETAIL_LIMIT=300,FINISHED_KEEP=200;

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
// The public page is open to anyone with its link, rival players included. It carries a whitelist, so a new state
// field stays private until it is added here: what any player could learn in the game or on the public hiscores
// (where each bot stands, its levels, quests, worn items and ranks, other players), plus each bot's pack and goal,
// which the spectator view shows. Banks, coins and income, the plan and its strategy, scripts, jobs, pull requests of
// the private repository and this PC's resources stay with the owner (control.json).
const PUBLIC_BOT=['name','server','side','remote','practice','reserved','at','started','fresh','inWorld','operation','pos','live','hp','combat',
 'skills','quests','questsAt','equipment','equipmentObserved','inventory','ranks','ranksAt','role','goal','currentGoal','goalSkill','goalLevel',
 'goalNow','goalXp','xpPerTick','xpPerHour','xpLeft','eta','rateSkill','spark','uptime','action','death','seenInFeed','lastSeen','outcome','training','snapshotAt'] as const;
const PUBLIC_KEYS=['now','world','worldPlayers','boards','roster','rivals','contention','lookups','farms','icons','map','pageVersion','snapshotAt','liveTopsAt','liveTops'] as const;
// Goal texts can carry a coordinator task id ("run-x [task-1a2b]") and, after a colon or in brackets, stock counts
// ("Smithing from banked ore: 1630 bronze and 571 iron", "cooked lobsters (607 short)"): the public keeps the headline.
const publicGoal=(g:any)=>typeof g==='string'?g.replace(/\s*\[task-[^\]]*\]/g,'').split(':')[0]!.replace(/\s*\([^)]*\)/g,'').trim():g;
export function publicView(state:any,main=MAIN_ACCOUNT){
 const s=trimState(state);
 const isMain=(n:any)=>n===MAIN_MARK||String(n??'').toLowerCase()===main.toLowerCase();
 const pick=(o:any,keys:readonly string[])=>Object.fromEntries(keys.filter(k=>o&&k in o).map(k=>[k,o[k]]));
 const bots=(s.bots??[]).filter((b:any)=>!isMain(b?.name)&&!b?.reserved).map((b:any)=>{const copy:any=pick(b,PUBLIC_BOT);for(const k of ['goal','currentGoal'])if(k in copy)copy[k]=publicGoal(copy[k]);return copy;});
 const out:any=pick(s,PUBLIC_KEYS);
 out.bots=bots;
 // A finished or stopped run, by its goal: the run's counters (coins banked, items bought) are the owner's.
 out.results=(s.results??[]).filter((r:any)=>!isMain(r?.name)).map((r:any)=>({at:r.at,name:r.name,ok:r.ok,practice:r.practice,text:publicGoal(r.goal)??''}));
 out.events=[];out.alerts=[];
 // Market prices are public; the fleet's income and its farmers are the owner's.
 out.economy=s.economy&&typeof s.economy==='object'?{supplies:s.economy.supplies??[],pricesAt:s.economy.pricesAt??null,goldPerTick:0,farmers:[],trend:[]}:null;
 // The queue's counts and agents stay; the task texts are the agents' working notes.
 out.coordination=s.coordination&&typeof s.coordination==='object'?{available:s.coordination.available,fresh:s.coordination.fresh,paused:s.coordination.paused,counts:s.coordination.counts,agents:s.coordination.agents,tasks:[]}:null;
 // Other sides' accounts and sync times are public; their coins are bank stock.
 out.fleetSides=s.fleetSides&&Array.isArray(s.fleetSides.sides)?{...s.fleetSides,sides:s.fleetSides.sides.map((side:any)=>({...side,accounts:(side.accounts??[]).filter((a:any)=>!isMain(a?.name)).map(({coins:_coins,...a}:any)=>a)}))}:null;
 // Other players are public game data (world feed, hiscores); the main account leaves every list.
 if(Array.isArray(out.roster))out.roster=out.roster.filter((r:any)=>!isMain(r?.[0]));
 if(Array.isArray(out.rivals))out.rivals=out.rivals.map((b:any)=>({...b,ours:isMain(b?.ours?.name)?null:b?.ours??null,rows:(b.rows??[]).filter((r:any)=>!isMain(r?.name))}));
 if(Array.isArray(out.contention))out.contention=out.contention.map((c:any)=>({...c,others:(c.others??[]).filter((n:any)=>!isMain(n)),ours:(c.ours??[]).filter((n:any)=>!isMain(n))}));
 if(out.lookups&&typeof out.lookups==='object')out.lookups=Object.fromEntries(Object.entries(out.lookups).filter(([k,v]:any)=>!isMain(k)&&!isMain(v?.name)));
 if(Array.isArray(out.farms))out.farms=out.farms.map((g:any)=>({...g,names:(g.names??[]).filter((n:any)=>!isMain(n))}));
 out.hosted={at:Date.now(),kind:'public'};
 const text=JSON.stringify(out);
 if(new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(text))throw Error('public view still names the main account; nothing published');
 return out;
}
