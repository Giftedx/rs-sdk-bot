// Inventory only. A filename match never proves behaviour or local compatibility.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const analogues:Record<string,string[]>={
 bonestobananas:['scripts/microbot-bones.ts'],mining:['scripts/gather-ore.ts'],
 autofishing:['scripts/fishcook.ts'],woodcutting:['scripts/wc-loop.ts'],
 smelting:['scripts/smelt-batch.ts'],varrockanvil:['scripts/smith-batch.ts'],
 crafting:['scripts/spin-bowstrings.ts'],cooking:['scripts/cook-stock.ts'],
 natewinemaker:['scripts/cook-wine.ts'],thieving:['scripts/goldfarm.ts'],
 agility:['scripts/agility-order.ts'],fletching:['scripts/fletching-order.ts'],
 autoessencemining:['scripts/mine-essence.ts'],aiomagic:['scripts/magic-order.ts'],
};
export type PortDecision={name:string;decision:string;behaviour:string;localConsumers:string[];sourceEvidence:{path:string;line:number;claim:string}[];serverEvidence:{path:string;line:number;claim:string}[];blockers:string[];scriptDecisions:{path:string;decision:string;consumer:unknown;gap:string}[];proof:unknown;[key:string]:unknown};
export function reviewCoverage(modules:{name:string;scripts:string[]}[],reviews:PortDecision[]){
 const errors:string[]=[],names=new Set<string>();
 for(const review of reviews){
  if(names.has(review.name))errors.push('duplicate decision '+review.name);names.add(review.name);
  const module=modules.find(m=>m.name===review.name);if(!module){errors.push('unknown module '+review.name);continue;}
  if(!['reuse','port','partial','blocked','client-only'].includes(review.decision))errors.push('invalid decision '+review.name);
  if(!review.behaviour||!review.sourceEvidence?.length)errors.push('missing source evidence '+review.name);
  if(['blocked','partial'].includes(review.decision)&&!review.blockers?.length)errors.push('missing exact blockers '+review.name);
  if(['reuse','port'].includes(review.decision)&&!review.localConsumers?.length)errors.push('missing consumer '+review.name);
  for(const path of module.scripts)if(!review.scriptDecisions?.some(d=>d.path===path))errors.push('missing script decision '+path);
  for(const d of review.scriptDecisions??[])if(!module.scripts.includes(d.path))errors.push('unknown script decision '+d.path);
 }
 for(const module of modules)if(!names.has(module.name))errors.push('missing module decision '+module.name);
 return errors;
}
export function catalog(repo:string,tree:{sha:string;truncated:boolean;paths:string[]},root:string){
 if(tree.truncated)throw Error('Microbot tree is incomplete');
 if(!/^[0-9a-f]{40}$/.test(tree.sha))throw Error('Microbot tree revision invalid');
 const prefix=repo.endsWith('-Hub')?'src/main/java/net/runelite/client/plugins/microbot/':
  'runelite-client/src/main/java/net/runelite/client/plugins/microbot/';
 const java=tree.paths.filter(p=>p.startsWith(prefix)&&p.endsWith('.java')).sort();
 const modules=[...new Set(java.map(p=>p.slice(prefix.length).split('/')[0]!))].sort();
 return {repository:repo,revision:tree.sha,license:'BSD-2-Clause',treeComplete:true,
  javaFiles:java.length,modules:modules.map(name=>{
   const files=java.filter(p=>p.startsWith(prefix+name+'/')||p===prefix+name);
   const localCandidates=(analogues[name]??[]).filter(p=>existsSync(resolve(root,p)));
   const reviewed=repo==='chsami/Microbot-Hub'&&tree.sha==='cd648f48d536c01c58aa82aa4d353fb31ce6e102'&&name==='bonestobananas';
   return {name,status:reviewed?'rewrite-available':'unreviewed',
    compatibility:reviewed?'server-source-confirmed':'unknown',localCandidates,
    scripts:files.filter(p=>p.endsWith('Script.java')),plugins:files.filter(p=>p.endsWith('Plugin.java')),
    files,sourceUrl:`https://github.com/${repo}/tree/${tree.sha}/${prefix}${name}`,
    gap:reviewed?'SDK adapter and native practice execution unverified. Live release not qualified.':
     'Read behaviour and dependencies. Check server content, IDs, actions and local worker before porting.'};
  })};
}
if(import.meta.main){
 if(['--summary','--show','--blocked','--remaining'].includes(process.argv[2]??'')){
  const data=JSON.parse(readFileSync(resolve(import.meta.dir,'../research/microbot-ports.json'),'utf8'));
  const rows=data.repositories.flatMap((repo:any)=>repo.modules.map((module:any)=>({repository:repo.repository,...module})));
  if(process.argv[2]==='--summary'){
   console.log(JSON.stringify({modules:rows.length,scripts:rows.reduce((n:number,r:any)=>n+r.scripts.length,0),reviewed:rows.filter((r:any)=>r.status==='source-reviewed').length,decisions:rows.reduce((a:Record<string,number>,r:any)=>{const key=r.review?.decision??'unreviewed';a[key]=(a[key]??0)+1;return a;},{})},null,2));
  }else{
   const matches=rows.filter((r:any)=>process.argv[2]==='--show'?r.name.toLowerCase()===(process.argv[3]??'').toLowerCase():process.argv[2]==='--blocked'?r.review?.decision==='blocked':r.review?.decision==='partial');
   if(!matches.length)throw Error('no catalog entries match');
   for(const row of matches)console.log(JSON.stringify({repository:row.repository,name:row.name,sourceUrl:row.sourceUrl,...row.review},null,2));
  }
  process.exit(0);
 }
 const [core,hub,out]=process.argv.slice(2);
 if(!core||!hub||!out)throw Error('usage: microbot-catalog.ts core-tree.json hub-tree.json output.json');
 const root=resolve(import.meta.dir,'..');
 const repositories=[catalog('chsami/Microbot',JSON.parse(readFileSync(core,'utf8')),root),
  catalog('chsami/Microbot-Hub',JSON.parse(readFileSync(hub,'utf8')),root)];
 const files=['core','a','b','c'].map(part=>resolve(root,'research/microbot-decisions-'+part+'.json'));
 if(files.every(existsSync)){
  const parts=files.map(f=>JSON.parse(readFileSync(f,'utf8')) as PortDecision[]);
  for(const [index,repo] of repositories.entries()){
   const reviews=index===0?parts[0]!:parts.slice(1).flat();
   const errors=reviewCoverage(repo.modules,reviews);if(errors.length)throw Error(errors.join('\n'));
   for(const module of repo.modules){const review=reviews.find(d=>d.name===module.name)!;
    Object.assign(module,{status:'source-reviewed',compatibility:review.decision==='blocked'?'blocked-as-described':'native-subset-or-client-service',gap:review.blockers.join(' '),review});
   }
  }
 }else if(process.argv.includes('--require-reviewed'))throw Error('all four decision files required');
 writeFileSync(out,JSON.stringify({schema:2,scope:'All Java files under both pinned Microbot production namespaces. Tests, resources and non-Microbot RuneLite plugins excluded. Script/plugin suffixes are discovery hints only. Source-reviewed decisions are not native or live qualification.',repositories},null,2)+'\n');
 console.log(JSON.stringify(repositories.map(r=>({repository:r.repository,revision:r.revision,modules:r.modules.length,javaFiles:r.javaFiles,scripts:r.modules.reduce((n,m)=>n+m.scripts.length,0),reviewed:r.modules.filter(m=>m.status!=='unreviewed').length}))));
}
