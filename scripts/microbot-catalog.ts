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
 const [core,hub,out]=process.argv.slice(2);
 if(!core||!hub||!out)throw Error('usage: microbot-catalog.ts core-tree.json hub-tree.json output.json');
 const root=resolve(import.meta.dir,'..');
 const repositories=[catalog('chsami/Microbot',JSON.parse(readFileSync(core,'utf8')),root),
  catalog('chsami/Microbot-Hub',JSON.parse(readFileSync(hub,'utf8')),root)];
 writeFileSync(out,JSON.stringify({schema:1,scope:'All Java files under both pinned Microbot production namespaces. Tests, resources and non-Microbot RuneLite plugins excluded. Script/plugin suffixes are discovery hints only.',repositories},null,2)+'\n');
 console.log(JSON.stringify(repositories.map(r=>({repository:r.repository,revision:r.revision,modules:r.modules.length,javaFiles:r.javaFiles,scripts:r.modules.reduce((n,m)=>n+m.scripts.length,0),reviewed:r.modules.filter(m=>m.status!=='unreviewed').length}))));
}
