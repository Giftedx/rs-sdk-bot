// Offline navigation audit. No credentials, game connection or account mutation.
// Usage: bun scripts/route-audit.ts [--list] [--limit=N] [--offset=N] [--output=directory]
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import ts from 'typescript';
import {PRESETS} from '../packages/practice/src/presets';
import {objSpawns} from '../packages/core/src/spawn-index';
import {shopSellers} from '../packages/core/src/shop-index';
import {loadPathfinding} from '../packages/core/src/pathcache';
import {createWorld,rsPathLength,transportAllowed,type Account,type Tile,type World} from '../packages/core/src/world';
import {deadlyTo,loadHunters} from '../packages/core/src/danger';
import {mapAreas} from '../packages/core/src/components';
import {travelAllowed} from '../packages/core/src/travel';
import {reachableComponents,labelledNeighbours,directedAreas,type ComponentEdge} from './route-audit-components';

export type AuditTarget=Tile&{sources:string[]};
export const AUDIT_PROFILES:Record<string,Account>={
 weak:{skills:{attack:1,strength:1,defence:1,hitpoints:10},coins:30,varps:{},items:[],worn:[],unlocks:[],questStages:{}},
 strong:{skills:{attack:70,strength:70,defence:70,hitpoints:70},coins:20000,varps:{},items:[],worn:[],unlocks:[],questStages:{}},
};
const root=resolve(import.meta.dir,'..'),key=(t:Tile)=>`${t.level},${t.x},${t.z}`;
const valid=(t:Tile)=>[t.x,t.z,t.level].every(Number.isSafeInteger)&&t.x>=0&&t.x<16384&&t.z>=0&&t.z<16384&&t.level>=0&&t.level<4;

// Parse literals without importing entry scripts, including scripts with unguarded top-level gameplay.
export function fixedTiles(text:string,file:string):AuditTarget[]{
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),out:AuditTarget[]=[];
 const literal=(n:ts.Node|undefined):number|undefined=>n&&ts.isNumericLiteral(n)?Number(n.text):undefined;
 const add=(x:number|undefined,z:number|undefined,level=0,pos=0)=>{
  if(x===undefined||z===undefined)return;
  const tile={x,z,level};if(valid(tile))out.push({...tile,sources:[`${file}:${source.getLineAndCharacterOfPosition(pos).line+1}`]});
 };
 const visit=(n:ts.Node)=>{
  if(ts.isObjectLiteralExpression(n)){
   const fields=new Map(n.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(source),p.initializer]));
   add(literal(fields.get('x')),literal(fields.get('z')),literal(fields.get('level'))??0,n.pos);
  }
  if(ts.isArrayLiteralExpression(n)&&(n.elements.length===2||n.elements.length===3)){
   const x=literal(n.elements[0]),z=literal(n.elements[1]),level=n.elements.length===3?literal(n.elements[2]):0;
   if(x!==undefined&&z!==undefined&&x>=1024&&z>=1024&&level!==undefined)add(x,z,level,n.pos);
  }
  if(ts.isCallExpression(n)&&/^(walk|go|walkTo)$/.test(n.expression.getText(source)))
   add(literal(n.arguments[0]),literal(n.arguments[1]),0,n.pos);
  ts.forEachChild(n,visit);
 };
 visit(source);
 // Spawn alternatives documented beside configurable coordinates are literal targets too.
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.Standard,text);
 for(let token=scanner.scan();token!==ts.SyntaxKind.EndOfFileToken;token=scanner.scan())if(token===ts.SyntaxKind.SingleLineCommentTrivia||token===ts.SyntaxKind.MultiLineCommentTrivia){
  const comment=scanner.getTokenText();for(const m of comment.matchAll(/\b(\d{4,5})\s*,\s*(\d{4,5})\b/g))add(Number(m[1]),Number(m[2]),0,scanner.getTokenPos());
 }
 return out;
}

export function auditStarts(base=root):Record<string,Tile>{
 const banks=JSON.parse(readFileSync(join(base,'packages/planner/src/haggis-travel.json'),'utf8')).banks as Record<string,Tile>;
 const out:Record<string,Tile>={lumbridge:{x:3222,z:3218,level:0}};
 for(const [name,t]of Object.entries(banks)){if(!valid(t))throw Error('invalid bank '+name);out[name]={x:t.x,z:t.z,level:t.level};}
 return out;
}
export function auditTargets(base=root):AuditTarget[]{
 const targets=new Map<string,AuditTarget>();
 const add=(t:Tile,source:string)=>{
  if(!valid(t))throw Error('invalid target '+source);
  const k=key(t),row=targets.get(k);if(row){if(!row.sources.includes(source))row.sources.push(source);}else targets.set(k,{x:t.x,z:t.z,level:t.level,sources:[source]});
 };
 for(const [name,p]of Object.entries(PRESETS))if(p.position)add({...p.position,level:p.position.level??0},'preset:'+name);
 for(const sellers of shopSellers().values())for(const s of sellers)for(const t of s.spawns)add(t,`seller:${s.shop}:${s.npc}`);
 for(const [id,spawns]of objSpawns())for(const t of spawns)add(t,'object-spawn:'+id);
 const npcs=JSON.parse(readFileSync(join(base,'knowledge/npcs.json'),'utf8')) as {id:number;name:string;spawns?:Tile[]}[];
 for(const n of npcs)for(const t of n.spawns??[])add(t,`npc-spawn:${n.id}:${n.name}`);
 for(const file of ['goldfarm.ts','smelt-batch.ts','shop-buyer.ts','gather-fish.ts','cook-food.ts','gather-feathers.ts'])
  for(const t of fixedTiles(readFileSync(join(base,'scripts',file),'utf8'),'scripts/'+file))for(const s of t.sources)add(t,s);
 return [...targets.values()].sort((a,b)=>a.level-b.level||a.x-b.x||a.z-b.z);
}
export type AuditRow={profile:string;start:string;from:Tile;target:AuditTarget;reachable:boolean;cost:number|null;fare?:number;cause:string[]};
export function auditOne(world:World,profile:string,start:string,from:Tile,target:AuditTarget,account:Account,explain:(from:Tile,to:Tile,acct:Account)=>string[]):AuditRow{
 const r=world.route(from,target,account);
 return {profile,start,from,target,reachable:r.ok,cost:r.ok?r.cost:null,cause:r.ok?[]:explain(from,target,account)};
}
export const unreachableFirst=(rows:AuditRow[])=>rows.sort((a,b)=>Number(a.reachable)-Number(b.reachable)||a.profile.localeCompare(b.profile)||a.start.localeCompare(b.start)||key(a.target).localeCompare(key(b.target)));

if(import.meta.main){
 const option=(name:string,fallback:string)=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
 const offset=Number(option('offset','0')),limit=Number(option('limit','Infinity'));
 if(!Number.isSafeInteger(offset)||offset<0||!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0))throw Error('invalid audit range');
 const output=resolve(option('output','.practice/route-audit')),targets=auditTargets(),starts=auditStarts();
 const total=targets.length*Object.keys(starts).length*Object.keys(AUDIT_PROFILES).length;
 mkdirSync(output,{recursive:true});
 writeFileSync(join(output,'manifest.json'),JSON.stringify({profiles:AUDIT_PROFILES,starts,targets,total},null,2)+'\n');
 if(process.argv.includes('--list')){console.log(JSON.stringify({targets:targets.length,starts:Object.keys(starts).length,total}));process.exit(0);}
 await loadPathfinding();const path=await rsPathLength(),world=createWorld({pathLength:path,goalTolerance:0});
 const explain=(from:Tile,to:Tile,a:Account)=>{
  const reasons=[`no route under account policy; area labels ${path.areaOf?.(from)} -> ${path.areaOf?.(to)}`];
  for(const h of loadHunters())if(deadlyTo(h,a.skills)&&h.spawns.some(s=>s.level===to.level&&Math.max(Math.abs(s.x-to.x),Math.abs(s.z-to.z))<=h.reach+1))reasons.push('target danger rule: '+h.name);
  for(const d of world.blockedDoors(a))if(d.level===to.level&&Math.max(Math.abs(d.x-to.x),Math.abs(d.z-to.z))<=4)reasons.push(`nearby blocked door ${d.x},${d.z},${d.level}`);
  return reasons;
 };
 const pf=await import('../vendor/rs-sdk/sdk/pathfinding'),grid=await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
 const baseLabels=mapAreas(pf,grid,root),zones=[...baseLabels.zones.keys()].map(k=>[(k>>>28)&3,((k>>>14)&0x3fff)*8,(k&0x3fff)*8] as [number,number,number]);
 const graph=world.navigationGraph!(),rows:AuditRow[]=[];let index=0;
 const report=join(output,`report-${offset}.json`);
 const save=(complete:boolean)=>writeFileSync(report,JSON.stringify({method:'policy-masked collision components and directed portals; minimum total fare, not route time',complete,total,offset,checked:rows.length,unreachable:rows.filter(r=>!r.reachable).length,rows:unreachableFirst(rows.slice())},null,2)+'\n');
 for(const [profile,account]of Object.entries(AUDIT_PROFILES))for(const [start,from]of Object.entries(starts)){
  const first=index;index+=targets.length;
  const selected=targets.filter((_t,i)=>first+i>=offset&&first+i<offset+limit);
  if(!selected.length)continue;
  const blocked=world.blockedDoors(account);
  const query=()=>{
   const walking=directedAreas(zones,(l,x,z)=>pf.isTileWalkable(l,x,z),(l,x,z,dx,dz)=>grid.canTravel(l,x,z,dx,dz,1,0,grid.CollisionType.NORMAL));
   const labels=walking.labels;
   const canStep=(a:Tile,b:Tile)=>grid.canTravel(a.level,a.x,a.z,b.x-a.x,b.z-a.z,1,0,grid.CollisionType.NORMAL);
   const exits=(t:Tile)=>labelledNeighbours(labels,t,canStep);
   const exact=(t:Tile)=>{const a=labels.area(t.level,t.x,t.z);return a>=0?[a]:[];};
   const edges:ComponentEdge[]=[...walking.edges];
   for(const t of graph.transports){
    if(!transportAllowed(t,account))continue;
    const q=t.interaction,entry=t.entry??t.from,sources=new Set<number>();
    if(t.entry||!q)exact(entry).forEach(a=>sources.add(a));
    else{
     const r=Math.max(2,q.width,q.height);
     for(let x=t.from.x-r;x<=t.from.x+q.width-1+r;x++)for(let z=t.from.z-r;z<=t.from.z+q.height-1+r;z++){
      const a=labels.area(t.from.level,x,z);
      if(a>=0&&grid.reached(t.from.level,x,z,t.from.x,t.from.z,q.width,q.height,1,q.angle,q.shape,q.blockAccessFlags))sources.add(a);
     }
    }
    edges.push({from:[...sources],to:exits(t.to),fare:0,allowed:()=>true});
   }
   const rootAreas=exits(from);
   for(const t of graph.travel)edges.push({from:t.from?exact(t.from):rootAreas,to:exits(t.to),fare:t.coins,allowed:coins=>travelAllowed(t,{...account,coins})});
   const reached=reachableComponents(rootAreas,edges,account.coins??0),unlimited=reachableComponents(rootAreas,edges,Number.MAX_SAFE_INTEGER);
   for(const target of selected){
    let areas=exact(target);
    // The route policy opens its final target. Restore only a danger-added
    // floor flag for this endpoint probe; intrinsic blocked tiles stay closed.
    if(!areas.length&&baseLabels.area(target.level,target.x,target.z)>=0&&grid.isFlagged(target.x,target.z,target.level,2097152)){
     grid.changeFloor(target.x,target.z,target.level,false);
     try{
      areas=[];
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)if(dx||dz){
       const t={x:target.x+dx,z:target.z+dz,level:target.level},a=labels.area(t.level,t.x,t.z);
       if(a>=0&&canStep(t,target))areas.push(a);
      }
     }finally{grid.changeFloor(target.x,target.z,target.level,true);}
    }
    const fares=areas.flatMap(a=>reached.has(a)?[reached.get(a)!]:[]),reachable=fares.length>0;
    const cause=reachable?[]:explain(from,target,account);
    if(!reachable){
     cause[0]=`no route under account policy; masked area labels ${rootAreas.join(',')} -> ${areas.join(',')||labels.area(target.level,target.x,target.z)}`;
     const needed=areas.flatMap(a=>unlimited.has(a)?[unlimited.get(a)!]:[]);
     if(needed.length)cause.push(`fare budget: requires ${Math.min(...needed)} coins; holds ${account.coins??0}`);
    }
    rows.push({profile,start,from,target,reachable,cost:null,...(reachable?{fare:Math.min(...fares)}:{}),cause});
   }
  };
  const policed=()=>path.withPolicy?path.withPolicy(blocked,query):query();
  if(path.withDanger)path.withDanger(account,from,from,policed);else policed();
  save(false);console.log('AUDIT',rows.length,'/',total,profile,start);await Bun.sleep(0);
 }
 const complete=offset===0&&rows.length===total;save(complete);
 console.log(`RESULT ok route-audit complete=${complete} checked=${rows.length}/${total} report=${report}`);
}
