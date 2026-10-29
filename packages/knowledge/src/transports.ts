import type { LocSpawn } from './jm2';
import { cleanLines } from './text';

type Coord = { x: number; z: number; level: number };
type Offset = { dx: number; dlevel: number; dz: number; line: number;loc?:true };
export interface InteractionTarget {id:number;shape:number;angle:number;width:number;height:number;blockAccessFlags:number;src:string;configSrc:string}
export interface TransportRequirements {unlock?:string;skill?:{name:string;level:number};notOwnBanner?:{team:0|1;item:string};visibleLoc?:Coord&{id:number}}
export interface CanonicalTransport {id:number;locName:string;option:string;from:Coord;to:Coord;exact:boolean;src:string;toSrc:string;handler:string;interaction:InteractionTarget;requires?:TransportRequirements}
export interface DynamicTransportSpawn extends LocSpawn {activationSrc:string[];duration:number;conditionSrc:string}
export interface TransportMeta {requires?:TransportRequirements;canonical?:CanonicalTransport;dynamic?:{spawnSrc:string;activationSrc:string[];duration:number};entry?:Coord;landing?:{minX:number;maxX:number;minZ:number;maxZ:number;level:number};requireSrc?:string;interaction?:InteractionTarget;unplaced?:true}
type Destination = { to: Coord; line: number } | { offset: Offset };
type TableCase = {from:Coord;line:number;toLine?:number;spawn?:true}&TransportMeta&({to:Coord}|{offset:Offset});

export type Handler = (
    | { locName: string; option: string; handler: string; file: string; kind: 'offset'; offset: Offset }
    | { locName: string; option: string; handler: string; file: string; kind: 'angled'; byAngle: Record<number, Offset> }
    | { locName: string; option: string; handler: string; file: string; kind: 'absolute'; to: Coord; line: number }
    | { locName: string; option: string; handler: string; file: string; kind: 'coordinate'; cases: ({ from: Coord; destination: Destination }&TransportMeta)[]; fallback?: Destination }
    | { locName: string; option: string; handler: string; file: string; kind: 'table'; cases: TableCase[] })&TransportMeta;

export interface Edge extends TransportMeta {
    locName: string;
    option: string;
    from: Coord;
    to: Coord;
    // true: `to` is written in the script. false: `to` = loc tile + a player-relative offset, so it is
    // within about one tile of the real arrival tile (movecoord(coord, ...) is relative to the player).
    exact: boolean;
    src: string; // line that proves `from` (loc spawn line, or the switch_coord case line)
    toSrc: string; // line that proves `to`
    handler: string; // line of the [oploc] trigger
}

const MOVE = /movecoord\((?:loc_coord|coord(?:\(\))?),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
const ABS = /\b(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\b/;
const CASE_ANGLE = /case\s+(\d+)\s*:.*?movecoord\((?:loc_coord|coord(?:\(\))?),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
const CASE_COORD = /^case\s+\d+_\d+_\d+_\d+_\d+\s*:/;
const COORD_LITERAL = '(\\d+_\\d+_\\d+_\\d+_\\d+)';
const COORD_IF = new RegExp('^\\s*if\\s*\\(\\s*(loc_coord(?:\\(\\))?|\\$coord)\\s*=\\s*'+COORD_LITERAL+'\\s*\\)\\s*\\{\\s*$');
const ABS_MOVE = new RegExp('^\\s*(?:~climb_ladder|p_teleport|p_telejump)\\s*\\(\\s*'+COORD_LITERAL);
const MOVEMENT = /^\s*(?:~climb_ladder|p_teleport|p_telejump)\s*\(/;
export interface TransportContext {triggers:Map<string,{body:string;src:string}>}
export interface ClassifiedHandler {locName:string;handler:string;kind:'menu-covered'|'no-movement';reason:string}
const metaOf=(m:TransportMeta):TransportMeta=>({...m.requires?{requires:m.requires}:{},...m.entry?{entry:m.entry}:{},...m.landing?{landing:m.landing}:{},...m.requireSrc?{requireSrc:m.requireSrc}:{}});
// ServerOps.MOVECOORD -> CoordGrid.packCoord masks the three packed fields.
const moved=(from:Coord,o:Offset):Coord=>({x:(from.x+o.dx)&0x3fff,z:(from.z+o.dz)&0x3fff,level:(from.level+o.dlevel)&3});

// Small adapters for the pinned dynamic handlers. Every adapter validates the
// defining source shape; unknown helpers/conditions remain unsupported.
function special(base:{locName:string;option:string;handler:string;file:string},body:{text:string;line:number}[],text:string,ctx?:TransportContext):{handler?:Handler;classification?:ClassifiedHandler}|null{
 const joined=body.map(b=>b.text).join('\n'),name=base.locName;
 if(base.option!=='op1')return null;
 if(name==='ranging_guild_door'&&/stat\(ranged\) < 40/.test(joined)&&/forcemove\(movecoord\(loc_coord, 1, 0, -1\)/.test(joined)&&/p_teleport\(movecoord\(coord, -2, 0, 2\)/.test(joined)&&/p_teleport\(movecoord\(coord, 2, 0, -2\)/.test(joined)){
  const from={x:2658,z:3438,level:0};const out={x:2657,z:3439,level:0},inside={x:2659,z:3437,level:0};
  const first=body.find(b=>/p_teleport/.test(b.text))!,last=body.filter(b=>/p_teleport/.test(b.text)).at(-1)!;
  return {handler:{...base,kind:'table',cases:[{from,to:inside,entry:out,line:last.line,spawn:true,requires:{skill:{name:'ranged',level:40}},requireSrc:base.handler},{from,to:out,entry:inside,line:first.line,spawn:true}]}};
 }
 if(name==='miningguildladder'&&/stat\(mining\) < 60/.test(joined)&&/climb_ladder\(movecoord\(coord, 0, 0, 6400\)/.test(joined)){
  const row=body.find(b=>/climb_ladder/.test(b.text))!;
  return {handler:{...base,kind:'offset',offset:{dx:0,dlevel:0,dz:6400,line:row.line},requires:{skill:{name:'mining',level:60}},requireSrc:base.handler}};
 }
 if(name==='monasteryladder'&&/%prayer_guild < 1/.test(joined)&&/climb_ladder\(movecoord\(coord, 0, 1, 0\)/.test(joined)){
  const row=body.find(b=>/climb_ladder/.test(b.text))!;
  return {handler:{...base,kind:'offset',offset:{dx:0,dlevel:1,dz:0,line:row.line},requires:{unlock:'prayer-guild'},requireSrc:base.handler}};
 }
 if(['board_game_stairs_top2','board_game_stairs_base2','castlewars_topstair_linked'].includes(name)&&/@unhandled_stairs\(loc_coord\)/.test(joined)&&!/(?:p_tele|climb_ladder|stair_options)/.test(joined))return {classification:{locName:name,handler:base.handler,kind:'no-movement',reason:'Pinned handler only emits unhandled_stairs messages; no movement implementation.'}};
 if(['spiralstairsmiddle','spiralstairsmiddle_wooden'].includes(name)&&/@stair_options\(/.test(joined)&&[2,3].every(op=>text.includes(`[oploc${op},${name}]`)))return {classification:{locName:name,handler:base.handler,kind:'menu-covered',reason:'The same source publishes direct Climb-up op2 and Climb-down op3; use those instead of menu op1.'}};
 if(name==='laddertop_directional'){
  const moves=body.flatMap(b=>{const d=destination(b.text,b.line);return d?[d]:[];});
  if(moves.length===2&&moves.every(d=>'offset'in d&&d.offset.dx===0&&d.offset.dlevel===-1&&d.offset.dz===0)&&/@?~?black_knights_aggro\(/.test(joined))return {handler:{...base,kind:'offset',offset:(moves[0] as {offset:Offset}).offset}};
 }
 if(name==='ladder'){
  const helper=ctx?.triggers.get('label,ladder_to_dwarf_remains');
  if(helper&&/%mcannon\s*<\s*\^mcannon_tasked_with_checking_guard_tower/.test(helper.body)&&/climb_ladder\(movecoord\(coord\(\), 0, 1, 0\)/.test(helper.body)){
   const row=body.find(b=>/@ladder_to_dwarf_remains/.test(b.text)),fallback=body.find(b=>/case default/.test(b.text));
   const origin=row?.text.match(ABS)?.[0],offset=fallback?.text.match(MOVE);
   if(row&&origin&&fallback&&offset)return {handler:{...base,kind:'coordinate',cases:[{from:parseCoord(origin),destination:{offset:{dx:0,dlevel:1,dz:0,line:row.line}},requires:{unlock:'dwarf-tower'},requireSrc:helper.src}],fallback:{offset:{dx:Number(offset[1]),dlevel:Number(offset[2]),dz:Number(offset[3]),line:fallback.line}}}};
  }
 }
 if(name==='laddertop'){
  const row=body.find(b=>/^case\s+2_47_54_17_57\s*:/.test(b.text)),fallback=body.find(b=>/^case default/.test(b.text));
  const move=fallback?.text.match(MOVE),absolute=row?.text.match(/climb_ladder\((1_47_54_17_58),/);
  if(row&&fallback&&move&&absolute&&Number(move[1])===0&&Number(move[2])===-1&&Number(move[3])===0)return {handler:{...base,kind:'coordinate',cases:[{from:parseCoord('2_47_54_17_57'),destination:{to:parseCoord(absolute[1]!),line:row.line}}],fallback:{offset:{dx:0,dlevel:-1,dz:0,line:fallback.line}}}};
 }
 if(['board_game_stairs_grey_all','board_game_stairs_grey_base2'].includes(name)&&/\$randomZ = random\(2\)/.test(joined)&&/\$randomX = ~random_range\(-1, 1\)/.test(joined)){
  const row=body.find(b=>CASE_COORD.test(b.text)),move=body.find(b=>/p_telejump\(movecoord\(/.test(b.text));
  const from=row?.text.match(ABS)?.[0],match=move?.text.match(new RegExp('movecoord\\('+COORD_LITERAL+', \\$randomX, 0, \\$randomZ\\)'));
  if(row&&move&&from&&match){const to=parseCoord(match[1]!);return {handler:{...base,kind:'table',cases:[{from:parseCoord(from),to,line:row.line,toLine:move.line,landing:{minX:to.x-1,maxX:to.x+1,minZ:to.z,maxZ:to.z+1,level:to.level}}]}};}
 }
 if(name==='castlewars_topstair'){
  const cases:TableCase[]=[];
  for(const row of body){
   const m=row.text.match(new RegExp('^case\\s+'+COORD_LITERAL+'\\s*:\\s*@castlewars_topstair_check(saradomin|zamorak)\\('+COORD_LITERAL+'\\)'));
   if(!m)continue;
   // COORD_LITERAL has no inner captures; team is group2.
   const helper=ctx?.triggers.get('label,castlewars_topstair_check'+m[2]);
   if(!helper||!helper.body.includes('inv_total(worn, castlewars_'+m[2]+'_banner) > 0')||!helper.body.includes('p_teleport($dest)'))return null;
   cases.push({from:parseCoord(m[1]!),to:parseCoord(m[3]!),line:row.line,requires:{notOwnBanner:{team:m[2]==='saradomin'?0:1,item:'castlewars_'+m[2]+'_banner'}},requireSrc:helper.src});
  }
  if(cases.length===6)return {handler:{...base,kind:'table',cases}};
 }
 if(['castlewars_outsidestairs_saradomin_linked','castlewars_outsidestairs_zamorak_linked'].includes(name)){
  const row=body.find(b=>CASE_COORD.test(b.text)),origin=row?.text.match(ABS)?.[0];
  const moves=body.flatMap(b=>{const m=b.text.match(ABS_MOVE);return m?[{to:parseCoord(m[1]!),line:b.line}]:[];});
  const sar=name.includes('saradomin'),team=sar?0:1,item=`castlewars_${sar?'saradomin':'zamorak'}_banner`;
  if(row&&origin&&moves.length===2&&joined.includes(`inv_total(worn, ${item}) > 0`)&&joined.includes(sar?'coordx(coord) < coordx(loc_coord)':'coordx(coord) > coordx(loc_coord)')){
   const from=parseCoord(origin),downX=from.x+(sar?-1:1),upX=from.x+(sar?1:-1);
   return {handler:{...base,kind:'table',cases:[{from,to:moves[0]!.to,line:row.line,toLine:moves[0]!.line,entry:{...from,x:downX}},{from,to:moves[1]!.to,line:row.line,toLine:moves[1]!.line,entry:{...from,x:upX},requires:{notOwnBanner:{team,item}},requireSrc:`${base.file}:${body.find(b=>b.text.includes('%castlewars_team'))!.line}`}]}};
  }
 }
 return null;
}

function destination(text: string, line: number): Destination | null {
    const absolute=text.match(ABS_MOVE);
    if(absolute)return {to:parseCoord(absolute[1]!),line};
    if(!MOVEMENT.test(text))return null;
    const move=text.match(MOVE);
    return move ? {offset:{dx:Number(move[1]),dlevel:Number(move[2]),dz:Number(move[3]),line,...(/movecoord\(loc_coord/.test(text)?{loc:true as const}:{})}} : null;
}

// Bind each source selector to its own landing, as rs2b0t's ladder/direction
// regression fixtures do. Only this small, explicit grammar is understood.
// Unknown branches are skipped; finding a default movecoord is not enough.
function coordinateCases(body: {text:string;line:number}[]): {cases:{from:Coord;destination:Destination}[];fallback?:Destination}|null {
    const joined=body.map(b=>b.text).join('\n');
    const alias=/def_coord\s+\$coord\s*=\s*loc_coord(?:\(\))?\s*;/.test(joined);
    const cases:{from:Coord;destination:Destination}[]=[];
    const fallbacks:Destination[]=[];
    let allTerminate=true,unmatchedStop=false;
    for(let i=0;i<body.length;i++){
        const b=body[i]!,condition=b.text.match(COORD_IF);
        if(/\bif\s*\(/.test(b.text)&&!condition)return null;
        if(condition){
            if(condition[1]==='$coord'&&!alias)return null;
            let depth=1,j=i+1;
            let terminates=false,inElse=false;
            const targets:Destination[]=[];
            for(;j<body.length&&depth>0;j++){
                const row=body[j]!;
                if(/\bif\s*\(/.test(row.text))return null;
                if(/^\}\s*else\b/.test(row.text))inElse=true;
                const target=destination(row.text,row.line);
                if(MOVEMENT.test(row.text)&&!target)return null;
                if(target)targets.push(target);
                if(/^\s*return\s*;\s*$/.test(row.text)){if(inElse)unmatchedStop=true;else terminates=true;}
                depth+=(row.text.match(/\{/g)??[]).length-(row.text.match(/\}/g)??[]).length;
            }
            if(depth!==0||targets.length!==1)return null;
            cases.push({from:parseCoord(condition[2]!),destination:targets[0]!});
            allTerminate&&=terminates;
            i=j-1;
        }else{
            const target=destination(b.text,b.line);
            if(MOVEMENT.test(b.text)&&!target)return null;
            if(target)fallbacks.push(target);
        }
    }
    if(!cases.length||fallbacks.length>1||fallbacks.length&&(!allTerminate||unmatchedStop)||unmatchedStop&&cases.length>1)return null;
    return {cases,...(fallbacks[0]?{fallback:fallbacks[0]}:{})};
}

// RuneScript coord literal level_mx_mz_lx_lz.
export function parseCoord(s: string): Coord {
    const [lv, mx, mz, lx, lz] = s.split('_').map(Number) as [number, number, number, number, number];
    return { x: mx * 64 + lx, z: mz * 64 + lz, level: lv };
}

export function coordString(c: Coord): string {
    return `${c.level}_${c.x >> 6}_${c.z >> 6}_${c.x & 63}_${c.z & 63}`;
}

// Reads [oplocN,name] triggers from ladders+stairs scripts. Understood shapes: a switch_coord table,
// a switch_int(loc_angle) offset table, one movecoord offset, one absolute destination. Anything else
// is returned in `skipped`, never guessed. A switch_coord default case is not used: it applies only to
// locs no case lists, and its offset is player-relative.
export function parseTransportHandlers(text: string, file: string,context?:TransportContext): { handlers: Handler[]; skipped: { locName: string; handler: string }[];classified:ClassifiedHandler[] } {
    const lines = cleanLines(text);
    const handlers: Handler[] = [];
    const skipped: { locName: string; handler: string }[] = [];
    const classified:ClassifiedHandler[]=[];
    const starts: number[] = [];
    lines.forEach((l, i) => { if (/^\[\w+,[^\]]+\]/.test(l)) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
        const i = starts[s]!;
        if(!/^\[oploc\d,[^\]]+\]$/.test(lines[i]!))continue;
        const [, op, locName] = lines[i]!.match(/^\[oploc(\d),([^\]]+)\]$/)!;
        const end = starts[s + 1] ?? lines.length;
        const body = lines.slice(i + 1, end).map((text, k) => ({ text, line: i + 2 + k }));
        const base = { locName: locName!, option: `op${op}`, handler: `${file}:${i + 1}`, file };
        const joined = body.map(b => b.text).join('\n');
        const adapted=special(base,body,text,context);
        if(adapted){if(adapted.handler)handlers.push(adapted.handler);if(adapted.classification)classified.push(adapted.classification);continue;}

        if (/switch_coord\s*\(/.test(joined)) {
            const selector=joined.match(/switch_coord\s*\(\s*(loc_coord(?:\(\))?|\$coord)\s*\)/);
            const alias=/def_coord\s+\$coord\s*=\s*loc_coord(?:\(\))?\s*;/.test(joined);
            if(!selector||(selector[1]==='$coord'&&!alias)){
                skipped.push({locName:base.locName,handler:base.handler});continue;
            }
            const cases: TableCase[] = [];
            const starts=body.flatMap((b,i)=>/^case\b/.test(b.text)?[i]:[]);
            let unsupported=false;
            for(let n=0;n<starts.length;n++){
                const first=body[starts[n]!]!;
                if(!CASE_COORD.test(first.text))continue;
                const origin=first.text.match(ABS)![0];
                const rows=body.slice(starts[n]!,starts[n+1]??body.length).map((b,i)=>({...b,text:i===0?b.text.replace(/^case\s+[^:]+:\s*/,''):b.text}));
                const targets=rows.flatMap(b=>{const d=destination(b.text,b.line);return d?[d]:[];});
                if(rows.some(b=>/\bif\s*\(/.test(b.text)||MOVEMENT.test(b.text)&&!destination(b.text,b.line))||targets.length!==1){unsupported=true;continue;}
                const target=targets[0]!;
                if('to'in target)cases.push({from:parseCoord(origin),to:target.to,line:first.line,...(target.line!==first.line?{toLine:target.line}:{})});
                else cases.push({from:parseCoord(origin),offset:target.offset,line:first.line});
            }
            if (cases.length > 0) handlers.push({ ...base, kind: 'table', cases });
            if(!cases.length||unsupported)skipped.push({ locName: base.locName, handler: base.handler });
            continue;
        }
        if (/switch_int\s*\(loc_angle\)/.test(joined)) {
            const byAngle: Record<number, Offset> = {};
            for (const b of body) {
                const m = b.text.match(CASE_ANGLE);
                if (m) byAngle[Number(m[1])] = { dx: Number(m[2]), dlevel: Number(m[3]), dz: Number(m[4]), line: b.line,...(/movecoord\(loc_coord/.test(b.text)?{loc:true as const}:{}) };
            }
            if (Object.keys(byAngle).length > 0) { handlers.push({ ...base, kind: 'angled', byAngle }); continue; }
        }
        if(/\bif\s*\([^\n]*(?:loc_coord|\$coord)/.test(joined)){
            const selection=coordinateCases(body);
            if(selection)handlers.push({...base,kind:'coordinate',...selection});
            else skipped.push({locName:base.locName,handler:base.handler});
            continue;
        }
        const mv = body.find(b => MOVE.test(b.text));
        if (mv) {
            const m = mv.text.match(MOVE)!;
            handlers.push({ ...base, kind: 'offset', offset: { dx: Number(m[1]), dlevel: Number(m[2]), dz: Number(m[3]), line: mv.line } });
            continue;
        }
        const ab = body.find(b => ABS_MOVE.test(b.text));
        if (ab) {
            handlers.push({ ...base, kind: 'absolute', to: parseCoord(ab.text.match(ABS_MOVE)![1]!), line: ab.line });
            continue;
        }
        skipped.push({ locName: base.locName, handler: base.handler });
    }
    return { handlers, skipped,classified };
}

// Narrow extraction of the pinned Monk's Friend timer. A changed condition or
// spawn form remains unsupported instead of granting a guessed world object.
export function monkLadderSpawn(ctx:TransportContext,constants:{text:string;file:string},locPack:Map<number,string>):DynamicTransportSpawn[] {
 const timer=ctx.triggers.get('timer,blanket_ladder'),active=ctx.triggers.get('proc,drunkmonk_ladder_active'),start=ctx.triggers.get('label,omad_help');
 const lines=cleanLines(constants.text),index=lines.findIndex(l=>/^\^blanket_ladder_coord\s*=\s*\d+_\d+_\d+_\d+_\d+$/.test(l));
 const literal=index>=0?lines[index]!.split('=')[1]!.trim():undefined,id=[...locPack].find(([,name])=>name==='wildymirrorladdertop1')?.[0];
 if(!timer||!active||!start||!literal||id===undefined)return [];
 if(!/distance\(\^blanket_ladder_coord,\s*coord\)\s*<=\s*2\s*&\s*~drunkmonk_ladder_active\s*=\s*false/.test(timer.body)||!/loc_find\(\^blanket_ladder_coord,\s*wildymirrorladdertop1\)\s*=\s*true/.test(active.body)||!/%drunkmonkquest\s*=\s*\^drunkmonk_spoken_to_omad;\s*settimer\(blanket_ladder,\s*1\);/.test(start.body))return [];
 const body=timer.body.split('\n'),spawn=body.findIndex(l=>/^\s*loc_add\(\^blanket_ladder_coord,\s*wildymirrorladdertop1,\s*1,\s*centrepiece_straight,\s*200\);\s*$/.test(l));if(spawn<0)return [];
 const file=timer.src.replace(/:\d+$/,''),line=Number(timer.src.match(/:(\d+)$/)?.[1])+spawn+1;
 return [{id,...parseCoord(literal),shape:10,angle:1,src:`${file}:${line}`,conditionSrc:timer.src,duration:200,activationSrc:[start.src,`${constants.file}:${index+1}`,active.src]}];
}

export function buildTransports(handlers: Handler[], locs: LocSpawn[], locPack: Map<number, string>,configs?:Map<string,{props:Record<string,string[]>;file:string;line:number}>,dynamicSpawns:DynamicTransportSpawn[]=[]): { edges: Edge[]; unmatchedAngles: number } {
    const edges: Edge[] = [];
    const byName = new Map<string, Handler[]>();
    for (const h of handlers) {
        if (h.kind === 'table') {
            for (const c of h.cases) {
                const spawn=c.spawn?locs.find(l=>locPack.get(l.id)===h.locName&&l.x===c.from.x&&l.z===c.from.z&&l.level===c.from.level):undefined;
                if(c.spawn&&!spawn)continue;
                const src = spawn?.src??`${h.file}:${c.line}`;
                const absolute='to'in c;
                const to=absolute?c.to:moved(c.from,c.offset);
                edges.push({ locName: h.locName, option: h.option, from: c.from, to, exact: absolute?!c.landing:!!c.offset.loc, src, toSrc: `${h.file}:${absolute?c.toLine??c.line:c.offset.line}`, handler: h.handler,...metaOf(c) });
            }
            continue;
        }
        byName.set(h.locName, [...(byName.get(h.locName) ?? []), h]);
    }
    let unmatchedAngles = 0;
    for (const loc of locs) {
        const name = locPack.get(loc.id);
        if (!name) continue;
        for (const h of byName.get(name) ?? []) {
            const from = { x: loc.x, z: loc.z, level: loc.level };
            if(h.kind==='coordinate'){
                const branch=h.cases.find(c=>c.from.x===loc.x&&c.from.z===loc.z&&c.from.level===loc.level);
                const selected=branch?.destination??h.fallback;
                if(!selected)continue;
                const absolute='to' in selected;
                const to=absolute?selected.to:moved(from,selected.offset);
                edges.push({locName:name,option:h.option,from,to,exact:absolute||!absolute&&!!selected.offset.loc,src:loc.src,toSrc:`${h.file}:${absolute?selected.line:selected.offset.line}`,handler:h.handler,...(branch?metaOf(branch):{})});
                continue;
            }
            if (h.kind === 'absolute') {
                edges.push({ locName: name, option: h.option, from, to: h.to, exact: true, src: loc.src, toSrc: `${h.file}:${h.line}`, handler: h.handler });
                continue;
            }
            if (h.kind === 'table') continue;
            const o = h.kind === 'offset' ? h.offset : h.byAngle[loc.angle];
            if (!o) { unmatchedAngles++; continue; }
            edges.push({
                locName: name, option: h.option, from,
                to: moved(from,o),
                exact: !!o.loc, src: loc.src, toSrc: `${h.file}:${o.line}`, handler: h.handler,...metaOf(h),
            });
        }
    }
    if(configs){
        const placed=new Map<string,LocSpawn[]>();for(const l of [...locs,...dynamicSpawns]){const k=`${l.level},${l.x},${l.z}`;placed.set(k,[...placed.get(k)??[],l]);}
        for(const e of edges){const l=placed.get(`${e.from.level},${e.from.x},${e.from.z}`)?.find(p=>locPack.get(p.id)===e.locName),c=configs.get(e.locName);if(!l||!c){e.unplaced=true;continue;}
            const width=Number(c.props.width?.[0]??1),height=Number(c.props.length?.[0]??1);if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)continue;
            const force=c.props.forceapproach?.[0],bit=({north:1,east:2,south:4,west:8} as Record<string,number>)[force??''];
            // GameMap.reachedLoc passes raw dimensions/angle/shape. RSMod
            // rotates the rectangle and forceapproach bits internally.
            e.interaction={id:l.id,shape:l.shape,angle:l.angle,width,height,blockAccessFlags:force===undefined?0:15&~(bit??0),src:l.src,configSrc:`${c.file}:${c.line}`};
            const dynamic=dynamicSpawns.find(d=>d===l);
            if(dynamic){e.requires={...e.requires,visibleLoc:{id:l.id,x:l.x,z:l.z,level:l.level}};e.requireSrc=dynamic.conditionSrc;e.dynamic={spawnSrc:dynamic.src,activationSrc:dynamic.activationSrc,duration:dynamic.duration};}

        }
    }
    // Legacy script literals share coordinates with newer board-game locs.
    // Resolve only the named source pair, identical operation and destination,
    // and a real placed canonical ID/geometry; preserve the old literal row.
    for(const e of edges.filter(e=>e.unplaced)){
        const name=({stairs:'board_game_stairs_grey_base',stairstop:'board_game_stairs_grey_top'} as Record<string,string>)[e.locName];
        if(!name)continue;
        const c=edges.find(c=>c.locName===name&&!c.unplaced&&c.interaction&&c.option===e.option&&c.exact===e.exact&&JSON.stringify(c.from)===JSON.stringify(e.from)&&JSON.stringify(c.to)===JSON.stringify(e.to));
        if(c?.interaction)e.canonical={id:c.interaction.id,locName:c.locName,option:c.option,from:c.from,to:c.to,exact:c.exact,src:c.src,toSrc:c.toSrc,handler:c.handler,interaction:c.interaction,...(c.requires?{requires:c.requires}:{})};
    }
    return { edges, unmatchedAngles };
}
