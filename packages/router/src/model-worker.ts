import {existsSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {runClaude} from './author';
import {projectRoot,coordinationDir} from './coordinator-store';
import {killTree} from '../../practice/src/proc';
export type ModelWorker='codex'|'claude';
// The receipts a review prompt carries: the task's own dependencies and this capability's history, newest first, within
// a size the model accepts. The whole coordinator history ran past Codex's 1,048,576-character input limit.
export const REVIEW_INPUT_MAX_CHARS=400000;
export function reviewDependencies(dependencies:Record<string,any>,capability:string,dependsOn:readonly string[],maxChars=REVIEW_INPUT_MAX_CHARS):Record<string,any>{
 const relevant=Object.entries(dependencies).filter(([id,d])=>dependsOn.includes(id)||d?._task?.capability===capability||d?.delivery?.id===capability)
  .sort((a,b)=>(dependsOn.includes(b[0])?1:0)-(dependsOn.includes(a[0])?1:0)||(b[1]?._task?.at??0)-(a[1]?._task?.at??0));
 const out:Record<string,any>={};let size=0;
 for(const [id,d] of relevant){const text=JSON.stringify(d);if(size+text.length>maxChars)break;out[id]=d;size+=text.length;}
 return out;
}
// A verdict exists only when the model answered. A failed or expired call is a failed review task, never a rejection.
export function reviewVerdict(review:{ok:boolean;text:string},parse:(text:string)=>any):{approved:boolean;reason:string}{
 if(!review.ok)throw Error('review model unavailable: '+String(review.text).slice(0,300));
 const verdict=parse(review.text);
 if(typeof verdict?.approved!=='boolean')throw Error('review verdict malformed');
 return {approved:verdict.approved,reason:String(verdict.reason??'')};
}
export function rejectedReview(dependencies:Record<string,any>,capability:string,source:string){
 const latest=Object.values(dependencies).filter(d=>d?.evidence==='source-review'&&d._task?.capability===capability&&d.source===source).sort((a,b)=>b._task.at-a._task.at)[0];
 return latest?.review?.approved===false?String(latest.review.reason):null;
}
export function codexArgs(output:string,readOnly:boolean){
 // Build workspaces (build-workspace.ts) have no .git; Codex refuses them without --skip-git-repo-check.
 return ['exec','--skip-git-repo-check','--json','--ephemeral','--color','never','--sandbox',readOnly?'read-only':'danger-full-access','-c','approval_policy="never"','-c','forced_login_method="chatgpt"',
  // A disabled shadow needs a valid transport, even when that server is not
  // in user config. These placeholders are never launched.
  ...['blender','node_repl','cua_repl'].flatMap(name=>['-c',`mcp_servers.${name}={command="cmd.exe",enabled=false}`]),
  '-c','plugins."unified-computer-use@openai-bundled".enabled=false','-c','plugins."computer-use@openai-bundled".enabled=false',
  '--output-last-message',output,'-'];
}
export function codexCommand(){
 const executable=Bun.which('codex');if(!executable)throw Error('Codex CLI unavailable');
 if(/\.(cmd|ps1)$/i.test(executable)||!executable.endsWith('.exe')&&process.platform==='win32'){
  const script=join(dirname(executable),'node_modules/@openai/codex/bin/codex.js');
  if(!existsSync(script))throw Error('Codex npm entry unavailable');return[Bun.which('node')??process.execPath,script];
 }
 return[executable];
}
export function modelFailure(events:string,stderr:string,expired:boolean){
 let failure='';for(const line of events.split(/\r?\n/))try{const r=JSON.parse(line);if(r.type==='turn.failed')failure=String(r.error?.message??r.error??'');else if(r.type==='error')failure=String(r.message??'');}catch{}
 return expired?'model deadline exceeded':failure||stderr.slice(-1200)||'model ended without an answer';
}
export async function runModel(worker:ModelWorker,prompt:string,timeoutMs:number,readOnly:boolean){
 if(worker==='claude')return runClaude(prompt,timeoutMs,readOnly);
 mkdirSync(join(coordinationDir,'models'),{recursive:true});const dir=mkdtempSync(join(coordinationDir,'models','codex-'));
 const output=join(dir,'answer.txt'),env={...process.env};delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
 const child=Bun.spawn([...codexCommand(),...codexArgs(output,readOnly)],{cwd:projectRoot,env,stdin:'pipe',stdout:Bun.file(join(dir,'events.jsonl')),stderr:Bun.file(join(dir,'stderr.log')),windowsHide:true});
 child.stdin.write(prompt);child.stdin.end();let expired=false,termination:Promise<void>|undefined;
 const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},timeoutMs);
 const exit=await child.exited;clearTimeout(timer);await termination;
 const text=existsSync(output)?readFileSync(output,'utf8'):modelFailure(readFileSync(join(dir,'events.jsonl'),'utf8'),readFileSync(join(dir,'stderr.log'),'utf8'),expired);
 return{ok:exit===0&&!expired&&!!text.trim(),text,costUsd:0,evidence:dir};
}
export function assignedWorker(kind:string,records:{spec:{kind:string};agent?:ModelWorker}[],requested?:ModelWorker):ModelWorker{
 if(requested)return requested;
 if(kind!=='build')return'codex';
 const counts=(agent:ModelWorker)=>records.filter(r=>r.spec.kind==='build'&&(r.agent??'claude')===agent).length;
 return counts('codex')<=counts('claude')?'codex':'claude';
}
