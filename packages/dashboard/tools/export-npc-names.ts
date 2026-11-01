// Writes client-assets/npc-names.json: for each npc type id the world feed sends, the npc's name and its shown
// combat level (vislevel), from the pinned server content (vendor/rs-sdk/server/content, MIT, Lost City).
// The page names an account's opponent with it (Opponent information). Usage: bun packages/dashboard/tools/export-npc-names.ts
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {configTable,loadContentTable} from '../appearance';

// One entry per id: [name, level], [name] when the level is hidden, null for an id with no named config.
export function npcNames(table:Map<number,{name:string;level?:number}>,size:number):([string,number]|[string]|null)[]{
 return Array.from({length:size},(_,id)=>{const c=table.get(id);return c?(c.level?[c.name,c.level]:[c.name]):null;});
}
// The table size is the pack's highest id + 1, so the ids line up with the feed's npc types.
const packSize=(pack:string)=>Math.max(-1,...pack.split(/\r?\n/).map(l=>Number(/^(\d+)=/.exec(l.trim())?.[1]??-1)))+1;
export const npcNamesFrom=(pack:string,configs:string[])=>npcNames(configTable(pack,configs),packSize(pack));

if(import.meta.main){
 const content=join(resolve(import.meta.dir,'..','..','..'),'vendor','rs-sdk','server','content');
 const out=npcNames(loadContentTable(content,'npc'),packSize(readFileSync(join(content,'pack','npc.pack'),'utf8')));
 writeFileSync(join(import.meta.dir,'..','client-assets','npc-names.json'),JSON.stringify(out));
 console.log(`npc-names.json: ${out.filter(Boolean).length} named of ${out.length} ids`);
}
