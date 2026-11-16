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

function queue(){
 const finished=(id:string,at:number)=>({spec:{id,account:'Worker',kind:'run',goal:'skills',why:id},status:'succeeded',createdAt:1,receipt:{at,output:{evidence:'native'}}});
 const records=[finished('finish-old-one',100),finished('finish-old-two',200),finished('finish-new-z',900),finished('finish-new-a',900),finished('finish-newest',1000),
  {spec:{id:'waiting-old',account:'Worker',kind:'run',goal:'skills',why:'Waiting for supplies'},status:'pending',createdAt:20},
  {spec:{id:'running-current',account:'Worker',kind:'run',goal:'skills',why:'Current useful work'},status:'running',createdAt:30,startedAt:1100},
  {spec:{id:'waiting-new',participants:['Worker'],kind:'run',goal:'skills',why:'Newest shared job'},status:'pending',createdAt:1200},
  {spec:{id:'unrelated',account:'Other',kind:'run',goal:'skills',why:'Another account'},status:'pending',createdAt:1300}];
 return {now:2000,bots:[{name:'Worker'}],coordination:coordinationView({version:1,tasks:records},2000,2000)};
}

test('Account linked jobs select the same open-first recent five from native and hosted task order',()=>{
 const native=queue(),original=native.coordination.tasks.map((task:{id:string})=>task.id),hosted=controlView(native,{});
 const expected=['waiting-new','running-current','waiting-old','finish-newest','finish-new-a'];
 expect(taskIds(accountHtml(native))).toEqual(expected);
 expect(taskIds(accountHtml(hosted))).toEqual(expected);
 expect(taskIds(accountHtml({...native,coordination:{...native.coordination,tasks:[...native.coordination.tasks].reverse()}}))).toEqual(expected);
 expect(native.coordination.tasks.map((task:{id:string})=>task.id)).toEqual(original);
 const publicHtml=accountHtml(hosted,{name:'Worker'},false);
 expect(publicHtml).not.toContain('Linked jobs');expect(taskIds(publicHtml)).toEqual([]);
});

test('Jobs distinguish waiting and unavailable observations from an observed empty queue',()=>{
 for(const state of [null,{}, {coordination:{}}]){
  const html=queueHtml(state);
  expect(html).toContain('Waiting for shared queue data');
  expect(html).not.toContain('No jobs in this view.');expect(html).not.toContain('data-op="job-filter"');
 }
 const unavailable=queueHtml({coordination:coordinationView(null,0,2000)});
 expect(unavailable).toContain('Shared queue data is unavailable');
 expect(unavailable).not.toContain('No jobs in this view.');expect(unavailable).not.toContain('data-op="job-filter"');
 expect(unavailable).toContain('Create a job');
 const empty=queueHtml({coordination:coordinationView({version:1,tasks:[]},2000,2000)});
 expect(empty).toContain('No jobs in this view.');expect(empty).toContain('All 0');
 expect(empty).not.toContain('Waiting for shared queue data');expect(empty).not.toContain('unavailable');
});

test('Stale available jobs retain their filter, rows and selected details with a queue warning',()=>{
 const state=queue();state.coordination.fresh=false;
 const rows=queueHtml(state,null,'pending');
 expect(rows).toContain('Shared queue data is out of date');
 expect(taskIds(rows)).toEqual(['unrelated','waiting-new','waiting-old']);
 expect(rows).toContain('data-value="pending" class="active"');
 const detail=queueHtml(state,'running-current');
 expect(detail).toContain('Shared queue data is out of date');
 expect(detail).toContain('Current useful work');expect(detail).toContain('data-op="task-back"');
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
