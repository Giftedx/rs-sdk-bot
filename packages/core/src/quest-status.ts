import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfigs } from '../../knowledge/src/config';

export type QuestFlag = { id:number; name:string; state:'not started'|'started'|'complete'|'unknown' };
export const QUEST_SOURCE='vendor/rs-sdk/server/content/scripts/player/interfaces/questlist.if';
let definitions:{id:number;name:string;key:string}[]|undefined;
export function questDefinitions(){
 if(definitions)return definitions;
 const root=resolve(import.meta.dir,'../../..');
 const pack=new Map(readFileSync(resolve(root,'vendor/rs-sdk/server/content/pack/interface.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(questlist:.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 definitions=parseConfigs(readFileSync(resolve(root,QUEST_SOURCE),'utf8'),QUEST_SOURCE).filter(b=>b.props.buttontype?.[0]==='normal'&&b.props.text?.[0]).flatMap(b=>{const id=pack.get('questlist:'+b.name);return id===undefined?[]:[{id,name:b.props.text![0]!,key:b.name}];});
 return definitions;
}

// Read only the account's own component table. Server IF_SETCOLOUR expands 5-bit
// colours to f8, unlike the pristine ff defaults; an untouched red is UNKNOWN.
// Quest varps are not generally transmitted. Never interpret their zero defaults.
export function questFlags(client:any,definitions?:readonly {id:number;name:string}[]):QuestFlag[]|null{
 if(client?.ingame!==true||typeof client.ifType!=='function')return null;
 try{return (definitions??questDefinitions()).map(q=>{const colour=client.ifType(q.id)?.colour;const state=colour===0x00f800?'complete':colour===0xf8f800?'started':colour===0xf80000?'not started':'unknown';return {id:q.id,name:q.name,state};});}
 catch{return null;} // Optional telemetry must not interrupt a worker.
}
