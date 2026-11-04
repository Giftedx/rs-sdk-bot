// The world feed's player appearance block (record key `ap`, base64 of the server's player_info appearance:
// vendor/rs-sdk/server/engine/src/engine/entity/Player.ts generateAppearance), and the server content tables that
// name what it carries. A worn item is written as 0x200 + its obj id in its wear slot (0-11); a body part as a
// smaller two-byte value; an empty slot as one 0 byte. The block ends with the base-37 username, the combat level
// and the total level (0 on this server, so it is not read).
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';

export const WEAR_SLOTS=['Head','Cape','Neck','Weapon','Body','Shield','Arms','Legs','Hair','Hands','Feet','Jaw'] as const;

// A content pack ("<id>=<config key>") joined with its configs ("[key]" blocks): id -> name, shown level and
// examine text.
type ContentEntry={name:string;level?:number;desc?:string};
export function configTable(pack:string,configs:string[]):Map<number,ContentEntry>{
 const byKey=new Map<string,{name?:string;level?:number;desc?:string}>();
 for(const text of configs){let cur:{name?:string;level?:number;desc?:string}|null=null;
  for(const line of text.split(/\r?\n/)){const head=/^\[([^\]]+)\]/.exec(line);if(head){cur={};byKey.set(head[1]!,cur);continue;}if(!cur)continue;
   const kv=/^(name|vislevel|desc)=(.*)$/.exec(line);if(!kv)continue;if(kv[1]==='name')cur.name=kv[2]!.trim();else if(kv[1]==='desc')cur.desc=kv[2]!.trim();else if(/^\d+$/.test(kv[2]!.trim()))cur.level=Number(kv[2]);}}
 const out=new Map<number,ContentEntry>();
 for(const line of pack.split(/\r?\n/)){const m=/^(\d+)=(.+)$/.exec(line.trim());const c=m&&byKey.get(m[2]!);if(m&&c?.name)out.set(Number(m[1]),{name:c.name,...(c.level?{level:c.level}:{}),...(c.desc?{desc:c.desc}:{})});}
 return out;
}
function files(dir:string,ext:string):string[]{return readdirSync(dir).flatMap(f=>{const p=join(dir,f);return statSync(p).isDirectory()?files(p,ext):p.endsWith(ext)?[p]:[];});}
// The pinned server content's table for one config type ('npc', 'obj'); empty when the content is not checked out.
export function loadContentTable(content:string,type:'npc'|'obj'){
 try{return configTable(readFileSync(join(content,'pack',type+'.pack'),'utf8'),files(join(content,'scripts'),'.'+type).map(f=>readFileSync(f,'utf8')));}
 catch{return new Map<number,ContentEntry>();}
}

const BASE37=' abcdefghijklmnopqrstuvwxyz0123456789';
function name37(v:bigint){let s='';while(v>0n){s=BASE37[Number(v%37n)]+s;v/=37n;}return s;}

export type Appearance={name:string;combat:number;worn:{slot:number;obj:number}[]};
export function decodeAppearance(b64:string):Appearance|null{
 let b:Uint8Array;try{b=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));}catch{return null;}
 let p=2;const worn:{slot:number;obj:number}[]=[];const u1=()=>b[p++]!,u2=()=>(b[p++]!<<8)|b[p++]!;
 if(b.length<2)return null;
 for(let slot=0;slot<12;slot++){
  if(p>=b.length)return null;
  if(b[p]===0){p++;continue;}
  const v=u2();
  if(v===0xffff){p+=2;break;} // an npc transform: no worn items follow
  if(v>=0x200)worn.push({slot,obj:v-0x200});
 }
 p+=5; // body colours
 p+=14; // seven animation ids
 if(p+9>b.length)return null;
 let v=0n;for(let i=0;i<8;i++)v=(v<<8n)|BigInt(u1());
 return {name:name37(v),combat:u1(),worn};
}

// Worn items of an online player: a short world feed subscription around them, until their appearance block
// arrives (6 s at most). It holds one of the feed's client slots (128 on the server) only for that time. The
// lookup's position can be 10 ticks old and a running player moves 2 tiles a tick, so the socket also reads the
// roster (every 10 ticks) and moves its 21x21 square to where the roster last saw the player.
export function readWorn(feed:string,name:string,seen:{x:number;z:number},objs:Map<number,{name:string}>,ms=6000):Promise<{slot:string;name:string}[]|null>{
 return new Promise(resolveWorn=>{
  let done=false;const ws=new WebSocket(feed),key=name.toLowerCase();let at={x:seen.x,z:seen.z};
  const finish=(v:{slot:string;name:string}[]|null)=>{if(done)return;done=true;clearTimeout(timer);try{ws.close();}catch{/* closed */}resolveWorn(v);};
  const timer=setTimeout(()=>finish(null),ms);
  const sub=()=>ws.send(JSON.stringify({t:'sub',x:at.x-10,z:at.z-10,w:21,h:21}));
  ws.onopen=()=>{sub();ws.send(JSON.stringify({t:'roster',on:true}));};
  ws.onmessage=e=>{try{const m=JSON.parse(String(e.data));
   if(m.t==='roster'){const p=(m.p??[]).find((r:any)=>Array.isArray(r)&&String(r[1]).toLowerCase()===key);if(p&&(Math.abs(p[2]-at.x)>6||Math.abs(p[3]-at.z)>6)){at={x:p[2],z:p[3]};sub();}return;}
   if(m.t!=='tick')return;for(const r of m.p??[]){if(typeof r.ap!=='string')continue;const a=decodeAppearance(r.ap);if(a&&a.name===key)finish(a.worn.map(w=>({slot:WEAR_SLOTS[w.slot]??String(w.slot),name:objs.get(w.obj)?.name??'item '+w.obj})));}}catch{/* next message */}};
  ws.onerror=()=>finish(null);
 });
}
