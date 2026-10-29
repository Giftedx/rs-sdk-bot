import type {CachedPathLeg,Place} from './travel';
import type {RouteGate} from './transport-requirements';

export type WorldGate={loc:string;tile:{x:number;z:number;level:number};requires?:string[][];source?:string};
export type MinedDoor={loc:string;x:number;z:number;level:number;angle?:number;shape?:number;kind:string;trigger:string;need?:{skill?:string;level?:number;worn?:string;varp?:string;minimum?:number;whenAxis?:boolean;team?:0|1}};
type IndexedGate=RouteGate&{crossing?:{x:number;z:number;nx:number;nz:number;whenAxis:boolean}};
const key=(level:number,x:number,z:number)=>`${level},${x},${z}`;
const TOLL_TICKS=10; // Existing model estimate; not measured route timing.

// World rows may describe separate operations on the same placed loc. Preserve
// those as alternatives, rather than letting Map.set silently discard one.
export function worldGateIndex(rows:WorldGate[],doors:MinedDoor[]=[]):Map<string,IndexedGate>{
    const grouped=new Map<string,WorldGate[]>();
    for(const row of rows){const k=key(row.tile.level,row.tile.x,row.tile.z);grouped.set(k,[...grouped.get(k)??[],row]);}
    const result=new Map<string,IndexedGate>();
    for(const [at,group] of grouped){
        const names=[...new Set(group.map(g=>g.loc))],sources=[...new Set(group.map(g=>g.source??'unparsed source'))];
        let requires=group.flatMap(g=>g.loc==='monasteryladder'&&g.source==='areas/monastery/scripts/prayer_guild.rs2:6'?[['unlock:prayer-guild']]:g.requires?.length?g.requires.map(a=>a.map(token=>{
            // Prayer31 permits joining; only an observed membership admits the ladder.
            return g.loc==='monasteryladder'&&g.source==='areas/monastery/scripts/prayer_guild.rs2:6'&&token==='skill:prayer:31'
                ?'unlock:prayer-guild':token;
        })):[['other:unparsed prerequisites '+g.loc]]);
        if(names.length!==1)requires=[['other:ambiguous gate state at '+at]];
        if(requires.some(a=>a.length===0))continue;
        requires=[...new Map(requires.map(a=>[JSON.stringify(a),a])).values()];
        // Pinned border_gate.rs2:pass_toll_gate opens both adjacent leaves for
        // one inv_del(coins,10), not two independent fares.
        const border=group.every(g=>g.loc==='border_gate_toll_left'||g.loc==='border_gate_toll_right')
            &&group.every(g=>g.tile.level===0&&g.tile.x===3268&&(g.tile.z===3227||g.tile.z===3228));
        result.set(at,{id:border?'border_gate_toll@0,3268,3227':names.join('/')+'@'+at,source:sources.join('; '),requires});
    }
    // Exact mined rev289 guards supersede broad foreign-index quest/gear summaries.
    for(const d of doors){
        const n=d.need;let requires:string[][]|undefined;
        if(d.kind==='skill'&&n?.skill&&n.level!==undefined)requires=[[`skill:${n.skill}:${n.level}`,...(n.worn?[`item:${n.worn}:worn`]:[])]];
        if(d.kind==='quest'&&n?.varp&&n.minimum!==undefined)requires=[[n.varp==='qp'?`questpoints:${n.minimum}`:`quest:${n.varp}:${n.minimum}`]];
        if(d.kind==='team'&&n?.team!==undefined)requires=[[`cw:team:${n.team}`],[`door-open:${d.level}:${d.x}:${d.z}`]];
        if(!requires)continue;
        const gate:IndexedGate={id:d.loc+'@'+key(d.level,d.x,d.z),source:d.trigger,requires};
        if(n?.whenAxis!==undefined&&d.shape===0&&Number.isInteger(d.angle)){
            const delta=[[-1,0],[0,1],[1,0],[0,-1]][d.angle!]!;
            gate.crossing={x:d.x,z:d.z,nx:d.x+delta[0]!,nz:d.z+delta[1]!,whenAxis:n.whenAxis};
            result.set(key(d.level,gate.crossing.nx,gate.crossing.nz),gate);
        }
        result.set(key(d.level,d.x,d.z),gate);
    }
    return result;
}

// Pure half of travel-gen: no SDK initialization and no native movement. A
// partial path or wrong floor cannot acquire gate/arrival evidence accidentally.
export function cachedPath(a:Place,b:Place,corners:{x:number;z:number;level?:number}[],index:Map<string,IndexedGate>):CachedPathLeg|null {
    const level=a.level??0;
    if(level!==(b.level??0)||![a.x,a.z,b.x,b.z,level].every(Number.isSafeInteger))return null;
    if(corners.some(c=>![c.x,c.z].every(Number.isSafeInteger)||c.level!==undefined&&c.level!==level))return null;
    if(!corners.length)return a.x===b.x&&a.z===b.z?{tiles:0,runTicks:0}:null;
    const end=corners[corners.length-1]!;
    if(Math.max(Math.abs(end.x-b.x),Math.abs(end.z-b.z))>2)return null;
    let x=a.x,z=a.z,tiles=0,toll=0;
    const gates=new Map<string,RouteGate>(),locked=new Set<string>();
    for(const corner of corners)while(x!==corner.x||z!==corner.z){
        const px=x,pz=z;x+=Math.sign(corner.x-x);z+=Math.sign(corner.z-z);tiles++;
        const gate=index.get(key(level,x,z));
        if(!gate||gates.has(gate.id))continue;
        if(gate.crossing){const c=gate.crossing;const ownerToNeighbor=px===c.x&&pz===c.z&&x===c.nx&&z===c.nz;const neighborToOwner=px===c.nx&&pz===c.nz&&x===c.x&&z===c.z;if(c.whenAxis?!ownerToNeighbor:!neighborToOwner)continue;}
        gates.set(gate.id,gate);
        if(gate.requires.some(a=>a.length>0&&a.every(t=>/^coins:\d+$/.test(t))))toll+=TOLL_TICKS;
        else locked.add(gate.id);
    }
    return {tiles,runTicks:tiles/2+toll,...(toll?{toll}:{}),...(locked.size?{locked:[...locked].sort()}:{}),...(gates.size?{gates:[...gates.values()]}:{})};
}
