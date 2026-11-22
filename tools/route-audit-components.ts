// Reachability is a graph of collision components, not one shortest-path search
// per destination. Directed portals retain account requirements and total fares.
import {labelAreas,type Labels} from '../packages/core/src/components';
import type {Tile} from '../packages/core/src/world';
export type ComponentEdge={from:readonly number[];to:readonly number[];fare:number;allowed:(coins:number)=>boolean};
export function reachableComponents(starts:readonly number[],edges:readonly ComponentEdge[],coins:number):Map<number,number>{
 const outgoing=new Map<number,ComponentEdge[]>();for(const e of edges)for(const a of e.from){const list=outgoing.get(a)??[];list.push(e);outgoing.set(a,list);}
 const best=new Map<number,number>(),queue:{area:number;fare:number}[]=[];
 const add=(area:number,fare:number)=>{if(area<0||fare>coins||fare>=(best.get(area)??Infinity))return;best.set(area,fare);queue.push({area,fare});};
 starts.forEach(a=>add(a,0));
 for(let head=0;head<queue.length;head++){
  const row=queue[head]!;if(best.get(row.area)!==row.fare)continue;
  for(const e of outgoing.get(row.area)??[])if(e.allowed(coins-row.fare))for(const a of e.to)add(a,row.fare+e.fare);
 }
 return best;
}
export function labelledNeighbours(labels:Labels,tile:Tile,canStep:(from:Tile,to:Tile)=>boolean):number[]{
 const own=labels.area(tile.level,tile.x,tile.z);if(own>=0)return[own];
 const found=new Set<number>();
 for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)if(dx||dz){const t={x:tile.x+dx,z:tile.z+dz,level:tile.level},a=labels.area(t.level,t.x,t.z);if(a>=0&&canStep(tile,t))found.add(a);}
 return[...found];
}

// Directional doors cannot be collapsed into an undirected flood label.
export function directedAreas(zones:Iterable<[number,number,number]>,walkable:(l:number,x:number,z:number)=>boolean,step:(l:number,x:number,z:number,dx:number,dz:number)=>boolean):{labels:Labels;edges:ComponentEdge[]}{
 const boundaries:{l:number;x:number;z:number;dx:number;dz:number;forward:boolean;reverse:boolean}[]=[];
 const labels=labelAreas(zones,walkable,(l,x,z,dx,dz)=>{
  const forward=step(l,x,z,dx,dz),reverse=step(l,x+dx,z+dz,-dx,-dz);
  if(forward!==reverse)boundaries.push({l,x,z,dx,dz,forward,reverse});
  return forward&&reverse;
 });
 const edges:ComponentEdge[]=[],seen=new Set<string>();
 const add=(a:number,b:number)=>{const k=a+'>'+b;if(a>=0&&b>=0&&a!==b&&!seen.has(k)){seen.add(k);edges.push({from:[a],to:[b],fare:0,allowed:()=>true});}};
 for(const b of boundaries){const a=labels.area(b.l,b.x,b.z),next=labels.area(b.l,b.x+b.dx,b.z+b.dz);if(b.forward)add(a,next);if(b.reverse)add(next,a);}
 return{labels,edges};
}
