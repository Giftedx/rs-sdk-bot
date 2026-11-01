import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
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
