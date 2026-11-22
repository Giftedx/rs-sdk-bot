import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {coordinationView} from './coordination';
import {controlView} from './publish-relay';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const accountSource=operations.slice(operations.indexOf(' function account(){'),operations.indexOf(' function raw(){'));
const jobsSource=operations.slice(operations.indexOf(' function jobs(){'),operations.indexOf(' // The registered scripts,'));
const jobButtonSource=operations.slice(operations.indexOf(' const jobButton='),operations.indexOf(' function issues(){'));
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const button=(label:string,op:string,value='')=>'<button data-op="'+escape(op)+'" data-value="'+escape(value)+'">'+escape(label)+'</button>';
const badge=(status:string,label=status)=>'<span>'+escape(label)+'</span>';
const taskIds=(html:string)=>[...html.matchAll(/data-op="task" data-value="([^"]*)"/g)].map(match=>match[1]);

function accountHtml(state:any,bot:any={name:'Worker'},owner=true){
 const env:any={bots:()=>[bot],sel:bot.name,meta:null,tasks:()=>state?.coordination?.tasks||[],window:{atlasOperator:()=>owner},page:String,title:()=>'',button,badge,issues:()=>[],E:escape,safeName:String,nf:String,gp:String,age:String,resultSummary:String};
 return new Function(...Object.keys(env),jobButtonSource+accountSource+';return account();')(...Object.values(env)) as string;
}

function queueHtml(state:any,selected:string|null=null,filter='all'){
 const env:any={S:state,tasks:()=>state?.coordination?.tasks||[],taskId:selected,taskFilter:filter,taskFilterPicked:true,window:{atlasOperator:()=>true},page:String,title:()=>'<h2>Agents & jobs</h2>',button,badge,E:escape,nf:String,age:String};
 return new Function(...Object.keys(env),jobButtonSource+jobsSource+';return jobs();')(...Object.values(env)) as string;
}

const emptyAcct={side:'local',role:'helper',protectedClock:false,lifecycle:'idle',skills:{},quests:{},pos:null,inventory:{},equipment:{},bank:{coins:0,items:{},observedAt:0,trusted:false}};
function fleetStateFixture(over:Record<string,unknown>={}){
 return {
  schemaVersion:1,emittedAt:2000,side:'local',server:'localhost:8888',maxBots:4,
  accounts:{
   Worker:{...emptyAcct,name:'Worker',lifecycle:'running',activeJob:{activityId:'skill_fishing_shrimp',demandId:'g-run',startedAt:1100}},
   Queued:{...emptyAcct,name:'Queued'},
   Other:{...emptyAcct,name:'Other'},
  },
  activeChains:{
   Queued:{account:'Queued',demandId:'g-wait',scorePerHour:80,steps:[{stepKind:'acquire',source:'own_bank',itemId:303,quantity:1,estimatedTicks:5,estimatedCoinCost:0,coinFloatPreserved:1000}]},
   Worker:{account:'Worker',demandId:'g-run',scorePerHour:150,steps:[{stepKind:'work',activityId:'skill_fishing_shrimp',demandId:'g-run',workerId:'skiller',batchUnits:10,estimatedTicks:40,expectedValuePerHour:150,config:{}}]},
   Other:{account:'Other',demandId:'g-other',scorePerHour:90,steps:[{stepKind:'acquire',source:'ge',itemId:995,quantity:1,estimatedTicks:5,estimatedCoinCost:0,coinFloatPreserved:1000}]},
  },
  idleReasons:{},
  goals:[
   {id:'g-run',goalKind:'specialist_prep',valueScore:100,target:{kind:'skill',account:'Worker',skill:'Fishing',targetLevel:20},fulfilled:0,remaining:1,priorityWeight:1,active:true},
   {id:'g-wait',goalKind:'coin_fund',valueScore:50,target:{kind:'coins',amount:5000},fulfilled:0,remaining:1,priorityWeight:1,active:true},
   {id:'g-other',goalKind:'coin_fund',valueScore:40,target:{kind:'coins',amount:5000},fulfilled:0,remaining:1,priorityWeight:1,active:true},
  ],
  campaigns:[],missions:[],pendingTransfers:[],
  quarantinedDefects:[
   {id:'def-old',activityId:'bank_deposit',faultSignature:'bank closed',outcomeKind:'worker_defect',account:'Worker',observedAt:100,quarantinedAt:200,quarantined:true,logPath:'a.log',detail:'closed',count:1},
   {id:'def-new',activityId:'ge_buy',faultSignature:'no offer',outcomeKind:'worker_defect',account:'Worker',observedAt:800,quarantinedAt:900,quarantined:true,logPath:'b.log',detail:'missing offer',count:2},
  ],
  ...over,
 };
}

function queue(){
 return {now:2000,bots:[{name:'Worker'}],coordination:coordinationView(fleetStateFixture(),2000,2000)};
}

test('Account linked chains select the same open-first recent entries from native and hosted state order',()=>{
 const native=queue(),original=native.coordination.tasks.map((task:{id:string})=>task.id),hosted=controlView(native,{});
 const expected=['chain:Worker:g-run','def-new','def-old'];
 expect(taskIds(accountHtml(native))).toEqual(expected);
 expect(taskIds(accountHtml(hosted))).toEqual(expected);
 expect(taskIds(accountHtml({...native,coordination:{...native.coordination,tasks:[...native.coordination.tasks].reverse()}}))).toEqual(expected);
 expect(native.coordination.tasks.map((task:{id:string})=>task.id)).toEqual(original);
 const publicHtml=accountHtml(hosted,{name:'Worker'},false);
 expect(publicHtml).not.toContain('Linked chains');expect(taskIds(publicHtml)).toEqual([]);
});

test('Jobs distinguish waiting and unavailable observations from an observed empty FleetState',()=>{
 for(const state of [null,{}, {coordination:{}}]){
  const html=queueHtml(state);
  expect(html).toContain('Waiting for shared queue data');
  expect(html).not.toContain('No jobs in this view.');expect(html).not.toContain('data-op="job-filter"');
 }
 const unavailable=queueHtml({coordination:coordinationView(null,0,2000)});
 expect(unavailable).toContain('Shared queue data is unavailable');
 expect(unavailable).not.toContain('No jobs in this view.');expect(unavailable).not.toContain('data-op="job-filter"');
 expect(unavailable).toContain('Operator desk');
 const empty=queueHtml({coordination:coordinationView(fleetStateFixture({accounts:{},activeChains:{},goals:[],quarantinedDefects:[]}),2000,2000)});
 expect(empty).toContain('No jobs in this view.');expect(empty).toContain('All 0');
 expect(empty).not.toContain('Waiting for shared queue data');expect(empty).not.toContain('unavailable');
});

test('Stale available FleetState retains its filter, rows and selected details with a warning',()=>{
 const state=queue();state.coordination.fresh=false;
 const rows=queueHtml(state,null,'pending');
 expect(rows).toContain('Shared queue data is out of date');
 expect(taskIds(rows)).toEqual(['chain:Queued:g-wait','chain:Other:g-other']);
 expect(rows).toContain('data-value="pending" class="active"');
 const detail=queueHtml(state,'chain:Worker:g-run');
 expect(detail).toContain('Shared queue data is out of date');
 expect(detail).toContain('skill_fishing_shrimp');expect(detail).toContain('data-op="task-back"');
 expect(detail).not.toContain('No jobs in this view.');
});

test('Account total level stays unknown without eligible skill observations and preserves reported sums',()=>{
 for(const skills of [undefined,[],[{name:'Overall',level:2000}],[{name:'Stat0',level:99},{name:'Overall',level:2000}]]){
  expect(accountHtml(null,{name:'Worker',at:0,skills})).toContain('<b>—</b><span>reported total level</span>');
  expect(accountHtml(null,{name:'Worker',at:0,skills},false)).toContain('<b>—</b><span>total level</span>');
 }
 const skills=[{name:'Attack',level:40},{name:'Runecraft',level:1},{name:'Overall',level:2000},{name:'Stat23',level:99}];
 expect(accountHtml(null,{name:'Worker',skills})).toContain('<b>41</b><span>reported total level</span>');
 expect(accountHtml(null,{name:'Worker',skills},false)).toContain('<b>41</b><span>total level</span>');
});
