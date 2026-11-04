import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const page=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const cut=(s:string,from:string,to:string)=>{const a=s.indexOf(from),b=s.indexOf(to,a);if(a<0||b<0)throw new Error('missing '+from);return s.slice(a,b);};

const procSource=cut(page,'function procGroups(','\n');
const procGroups=new Function(procSource+';return procGroups;')();
const centre=cut(source,' function operations(){',' function jobs(){');
const helpers=cut(source,' const button=',' const tasks=');
const summary=cut(source,' const word=',' // One row per cause');
function command(S:any,meta:any={paused:false,coordinatorRunning:true}){
 return new Function('S','meta','procGroups',`const window={};const E=s=>String(s).replace(/[<>"&]/g,c=>'&#'+c.charCodeAt(0)+';'),age=()=>'1m',page=x=>x,title=()=>'',safeName=String,KV=/(?:^|\\s)(([A-Za-z]+)=(\\S+))/g,readable=E;
  const tasks=()=>S?.coordination?.tasks||[],bots=()=>S?.bots||[];function issues(){return bots().filter(b=>['blocked','failed','died','active-stale','unobserved'].includes(b.operation));}
  const badge=(s,label=s)=>'<span class="op-badge '+s+'">'+label+'</span>';let metaError='',message='';${helpers}${summary}${centre};return {html:operations(),incidents:incidents()};`)(S,meta,procGroups);
}
const fail=(name:string,extra:any={})=>({name,operation:'failed',workEntry:'scripts/rune-bank-craft.ts',goal:'run-rune185-confirm-observed-2 [task-70d45e83]',at:1000,
 result:`fail Error: carrier walk {"p":{"x":3094,"z":3491},"r":{"ok":false,"ticks":33,"detail":"tick stream stalled"},"position":{"name":"${name}"}}`,...extra});

test('host processes group by script, largest total first',()=>{
 const g=procGroups([{pid:1,script:'app.ts',mb:1380},{pid:2,script:'coordinator-cli.ts',mb:217},{pid:3,script:'coordinator-cli.ts',mb:216},{pid:4,script:'coordinator-cli.ts',mb:1000}]);
 expect(g.map((x:any)=>[x.script,x.n,x.mb])).toEqual([['coordinator-cli.ts',3,1433],['app.ts',1,1380]]);
 expect(g[0].pids).toEqual([2,3,4]);
 expect(procGroups(undefined)).toEqual([]);
});

test('accounts stopped by one cause are one incident, with their job and open recovery jobs',()=>{
 const S={bots:[fail('FullLoad'),fail('Heavyload',{at:2000}),fail('Packhorse',{result:'fail Error: bank closed'}),{name:'UnderMyKilt',operation:'active-stale',side:'claude-cloud',result:'ok old run'},{name:'Idle',operation:'offline'}],
  coordination:{tasks:[{id:'run-rune185-confirm-observed-2',status:'failed'},{id:'recover-fullload',account:'FullLoad',status:'running'},{id:'recover-heavyload',account:'heavyload',status:'pending'},{id:'old',account:'Packhorse',status:'failed'}]}};
 const {html,incidents}=command(S);
 expect(incidents.map((g:any)=>[g.bots.map((b:any)=>b.name),g.recovering])).toEqual([[['FullLoad','Heavyload'],2],[['Packhorse'],0],[['UnderMyKilt'],0]]);
 expect(incidents[0].job).toBe('run-rune185-confirm-observed-2');expect(incidents[0].at).toBe(2000);
 expect(html).toContain('2 accounts · stopped');expect(html).toContain('2 recovery jobs');expect(html).toContain('No recovery job');
 expect(html).toContain('data-op="task" data-value="run-rune185-confirm-observed-2"');
 expect(html).toContain('1 account · no status while running');expect(html).toContain('claude-cloud side');
 expect(html).toContain('3 causes');
});

test('the start-blocked line names the RAM shortfall and the largest process group, and never acts on the swarm',()=>{
 const cap={fresh:true,active:1,cap:18,queued:2,freeGB:5.5,floorGB:8,pendingReserveGB:1,headroomGB:-3.5};
 const {html}=command({capacity:cap,sys:{procs:[{pid:1,script:'coordinator-cli.ts',mb:1536},{pid:2,script:'coordinator-cli.ts',mb:1536},{pid:3,script:'app.ts',mb:2000}]}});
 expect(html).toContain('2 accounts wait for RAM. 5.5 GiB free, floor 8.0 GiB plus 1.0 GiB startup reserve: 3.5 GiB short. Largest use: coordinator-cli.ts ×2, 3.0 GiB.');
 expect(html).toMatch(/class="op-block" data-op="open" data-value="machine"/);
 expect(command({capacity:{...cap,headroomGB:0.5}}).html).not.toContain('op-block');
 expect(command({capacity:{...cap,fresh:false}}).html).not.toContain('op-block');
 expect(command({capacity:{...cap,headroomGB:2,active:18}}).html).toContain('All 18 bot slots are in use. 2 accounts wait for a slot.');
 const paused=command({capacity:{...cap,headroomGB:2}},{paused:false,fleetPaused:true}).html;
 expect(paused).toContain('The swarm stop file is set.');expect(paused).not.toMatch(/op-block" data-op="swarm-/);
});

const activitySource=cut(source,' function activity(){',' function dispatch(){');
function activity(results:any[]){
 return new Function('S',`const window={};const E=String,age=()=>'1m',page=x=>x,title=()=>'',safeName=String,badge=(_s,l)=>l,resultSummary=String;let activityFilter='live';${activitySource};return activity();`)({results});
}
test('the activity journal merges one cause on several accounts within two minutes, and keeps other causes apart',()=>{
 const html=activity([{name:'A',text:'fail walk A x 3094',at:100_000},{name:'B',text:'fail walk B x 3095',at:99_000},{name:'C',text:'fail walk C x 3094',at:98_000},{name:'D',text:'fail bank closed',at:97_000},{name:'E',text:'fail walk E x 1',at:-50_000}]);
 expect(html).toContain('3 accounts · A, B +1');
 expect((html.match(/class="op-task"/g)||[]).length).toBe(3);
 expect(html).toContain('<strong>D</strong>');expect(html).toContain('<strong>E</strong>');
});
