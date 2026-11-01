// Writes client-assets/npc-names.json: for each npc type id the world feed sends, the npc's name and its shown
// combat level (vislevel), from the pinned server content (vendor/rs-sdk/server/content, MIT, Lost City).
// The page names an account's opponent with it (Opponent information). Usage: bun packages/dashboard/tools/export-npc-names.ts
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dir,'..','..','..'),content=join(root,'vendor','rs-sdk','server','content');

// npc.pack: "<id>=<config key>"; the .npc configs: "[key]" blocks with name= and vislevel= lines.
export function npcNames(pack:string,configs:string[]):([string,number]|[string]|null)[]{
 const byKey=new Map<string,{name?:string;level?:number}>();
 for(const text of configs){let cur:{name?:string;level?:number}|null=null;
  for(const line of text.split(/\r?\n/)){const head=/^\[([^\]]+)\]/.exec(line);if(head){cur={};byKey.set(head[1]!,cur);continue;}if(!cur)continue;
   const kv=/^(name|vislevel)=(.*)$/.exec(line);if(!kv)continue;if(kv[1]==='name')cur.name=kv[2]!.trim();else if(/^\d+$/.test(kv[2]!.trim()))cur.level=Number(kv[2]);}}
 const out:([string,number]|[string]|null)[]=[];
 for(const line of pack.split(/\r?\n/)){const m=/^(\d+)=(.+)$/.exec(line.trim());if(!m)continue;const c=byKey.get(m[2]!);out[Number(m[1])]=c?.name?(c.level?[c.name,c.level]:[c.name]):null;}
 return Array.from(out,v=>v??null);
}
function files(dir:string,ext:string):string[]{return readdirSync(dir).flatMap(f=>{const p=join(dir,f);return statSync(p).isDirectory()?files(p,ext):p.endsWith(ext)?[p]:[];});}

if(import.meta.main){
 const table=npcNames(readFileSync(join(content,'pack','npc.pack'),'utf8'),files(join(content,'scripts'),'.npc').map(f=>readFileSync(f,'utf8')));
 writeFileSync(join(import.meta.dir,'..','client-assets','npc-names.json'),JSON.stringify(table));
 console.log(`npc-names.json: ${table.filter(Boolean).length} named of ${table.length} ids`);
}
