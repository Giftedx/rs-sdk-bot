import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const SCRIPT_ALIAS: Record<string, string> = {
    quest_romeojuliet: 'quest-rj.ts',
    quest_scorpcatcher: 'quest-scorpion.ts',
    quest_blackarmgang: 'quest-arrav.ts',
    quest_arthur: 'quest-merlin.ts',
    quest_mcannon: 'dwarfcannon.ts',
    quest_itexam: 'quest-dig.ts',
    quest_waterfall: 'waterfall.ts',
    quest_elemental_workshop: 'quest-elemental.ts',
};

export const questScript = (folder: string): string =>
    SCRIPT_ALIAS[folder] ?? 'quest-' + folder.replace(/^quest_/, '').replace(/_/g, '') + '.ts';

export const QP_FALLBACK: Record<string, number> = {
    quest_cog: 1,
    quest_elemental_workshop: 1,
    quest_mm: 3,
    quest_troll_love: 2,
};

export const VARP_FOLDER: Record<string, string> = {
    goblinquest: 'quest_gobdip',
    elenaquest: 'quest_elena',
    waterfall_quest: 'quest_waterfall',
    horrorquest: 'quest_horror',
};

const defaultQuestRoot = resolve(import.meta.dir, '../../..');

// Journal labels are the names emitted by questFlags, not varps or script names.
export function questJournalNames(root = defaultQuestRoot): Map<string, string> {
    return new Map(
        parseConfigs(readFileSync(join(root, QUEST_SOURCE), 'utf8'), QUEST_SOURCE)
            .filter(b => b.props.buttontype?.[0] === 'normal' && b.props.text?.[0])
            .map(b => [b.name === 'fortress' ? 'quest_blackknight' : `quest_${b.name}`, b.props.text![0]!]),
    );
}
