import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./operations.js',import.meta.url),'utf8');

test('the running-jobs card opens running claims and a stale queue cannot imply current work',()=>{
 const code=source.slice(source.indexOf(' function operations(){'),source.indexOf(' function jobs(){'));
 const button=source.slice(source.indexOf(' const button='),source.indexOf(' const tasks='));
 const run=new Function('S','meta',`const E=String,age=()=>'1m',page=x=>x,title=()=>'',bots=()=>[],issues=()=>[],badge=(_s,label)=>label;let metaError='',message='';${button}${code};return operations();`);
 const html=run({coordination:{available:true,fresh:false,counts:{running:2,pending:3},agents:[]}},{paused:false,coordinatorRunning:true});
 expect(html).toMatch(/data-op="jobs-open" data-value="running"/);
 expect(html).not.toContain('AI jobs working');expect(html).toContain('Running');
 expect(html).not.toContain('No planner running');
 expect(run({coordination:{}},{paused:false})).toContain('Unknown');
});
test('the controllers tile counts a down fleet agent or autopilot and is marked bad only then',()=>{
 const code=source.slice(source.indexOf(' function operations(){'),source.indexOf(' function jobs(){'));
 const button=source.slice(source.indexOf(' const button='),source.indexOf(' const tasks='));
 const run=new Function('S','meta',`const E=String,age=()=>'9h',page=x=>x,title=()=>'',bots=()=>[],issues=()=>[],badge=(_s,label)=>label;let metaError='',message='';${button}${code};return operations();`);
 const tile=(meta:any)=>/<button class="op-kpi[^"]*"[^>]*><b>[^<]*<\/b><span>controllers down<\/span><small>[^<]*<\/small><\/button>/.exec(run({coordination:{}},meta))?.[0]??'';
 const down=tile({paused:false,controllers:[{name:'fleet-agent',label:'Fleet agent',state:'down',seenAt:1},{name:'autopilot',label:'Autopilot',state:'running',seenAt:2}]});
 expect(down).toContain('class="op-kpi op-kpi-bad"');expect(down).toContain('<b>1</b>');
 expect(down).toContain('Fleet agent down, seen 9h ago · Autopilot running');
 const calm=tile({paused:false,controllers:[{name:'fleet-agent',label:'Fleet agent',state:'stopped',seenAt:1},{name:'autopilot',label:'Autopilot',state:'never',seenAt:null}]});
 expect(calm).toContain('class="op-kpi"');expect(calm).toContain('<b>0</b>');
 expect(calm).toContain('Fleet agent stopped by owner · Autopilot not used here');
 // No metadata yet, or metadata from a server that does not send the list: the tile says so and is not bad.
 for(const meta of [null,{paused:false}]){const t=tile(meta);expect(t).toContain('class="op-kpi"');expect(t).toContain('<b>—</b>');expect(t).toContain('checking');}
});
const commandSource=source.slice(source.indexOf(' async function command('),source.indexOf(' function draftFromForm()'));
function commandHarness(rotates=true){
 const calls:any[]=[];const fetch=async(_url:string,input:any)=>{calls.push(input);return calls.length===1?Response.json({error:'Reload the local dashboard'},{status:403}):Response.json({status:'plan-requested'});};
 const command=new Function('fetch','rotates','crypto',`let meta={nonce:'old-session'},message='';const toast=()=>{};const loadMeta=async()=>{if(rotates)meta={nonce:'new-session'};};${commandSource};return command;`)(fetch,rotates,crypto);
 return{calls,command};
}
test('session renewal retries the same command identity and body exactly once',async()=>{
 const h=commandHarness();await h.command('plan');expect(h.calls).toHaveLength(2);
 expect(h.calls[0].body).toBe(h.calls[1].body);expect(h.calls[0].headers['x-atlas-control']).toBe('old-session');expect(h.calls[1].headers['x-atlas-control']).toBe('new-session');
});
test('an unrelated403 is not retried when the command session did not change',async()=>{
 const h=commandHarness(false);await expect(h.command('plan')).rejects.toThrow('Reload the local dashboard');expect(h.calls).toHaveLength(1);
});
const prepareSource=source.slice(source.indexOf(' function prepareDraft('),source.indexOf(' function enhanceRows('));
function prepare(context:any){const open:string[]=[];return new Function('context','open',`let draft={kind:'run',capability:'unrelated',account:'OldWorker',why:'old intent',goal:'wealth'},sel='Selected';const tasks=()=>context.tasks||[],caps=()=>context.caps||[],draftFromForm=()=>{},save=()=>{},api={openPlugin:id=>open.push(id)};${prepareSource};prepareDraft(context.input);return draft;`)(context,open);}
test('failed jobs prepare a repair and keep the real capability and goal',()=>{
 const result=prepare({input:{task:{id:'failed-order',capability:'wine-order',goal:'skills',status:'failed',detail:'bank settlement failed'}}});
 expect(result.kind).toBe('build');expect(result.capability).toBe('wine-order');expect(result.goal).toBe('skills');expect(result.why).toContain('bank settlement failed');
});
test('account preparation clears an unrelated capability and qualified scripts bind a real dependency',()=>{
 const account=prepare({input:{account:'NewWorker',kind:'run'}});expect(account.capability).toBe('');expect(account.account).toBe('NewWorker');
 const script=prepare({input:{capability:'wine-order'},tasks:[{id:'proof-wine',capability:'wine-order',status:'succeeded',evidence:'native',finishedAt:100}]});expect(script.kind).toBe('run');expect(script.dependency).toBe('proof-wine');
});

test('a later failed qualification prevents automatic live-run preparation',()=>{const draft=prepare({input:{capability:'wine-order'},tasks:[{id:'old-pass',capability:'wine-order',status:'succeeded',evidence:'native',finishedAt:100},{id:'new-failure',capability:'wine-order',status:'failed',evidence:'native',finishedAt:200}]});expect(draft.kind).toBe('qualify');expect(draft.dependency).toBe('');});

test('the activity journal badges a public result by its ok flag, not its text',()=>{
 const code=source.slice(source.indexOf(' function activity(){'),source.indexOf(' function dispatch(){'));
 const run=new Function('S','window',`const activityFilter='live',page=x=>x,title=()=>'',E=String,safeName=String,age=()=>'1m',resultSummary=String,badge=(_c,t)=>'['+t+']';${code};return activity();`);
 const html=run({results:[{at:1,name:'A',ok:true,text:'Train Mining'},{at:2,name:'B',ok:false,text:'Train Fishing'}]},{atlasOperator:()=>false});
 expect(html).toContain('[finished]');expect(html).toContain('[stopped]');
 expect(run({results:[{at:1,name:'A',text:'ok mode=x'}]},{})).toContain('[finished]');
});
