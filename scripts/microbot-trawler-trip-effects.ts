import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
export type TrawlerMode='net'|'leak'|'bail';
const xp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Crafting')?.experience??0;
export function insideLegacyTrawler(s:BotWorldState){const p=s.player;return !!p&&[0,1].includes(p.level)&&Math.floor(p.worldZ/64)===75&&[29,31].includes(Math.floor(p.worldX/64));}
export function trawlerEffect(before:BotWorldState,after:BotWorldState,mode:TrawlerMode,phase:'fill'|'empty'='fill'){
 const delta=new Map<number,number>();for(const i of before.inventory)delta.set(i.id,(delta.get(i.id)??0)-i.count);for(const i of after.inventory)delta.set(i.id,(delta.get(i.id)??0)+i.count);
 const expected=mode==='net'?new Map([[954,-1]]):mode==='leak'?new Map([[1941,-1]]):phase==='fill'?new Map([[583,-1],[585,1]]):new Map([[585,-1],[583,1]]);
 const keys=new Set([...delta.keys(),...expected.keys()]);
 const noChange=[...delta.values()].every(n=>n===0)&&xp(after)===xp(before);
 if(noChange)return false;
 if(![...keys].every(id=>(delta.get(id)??0)===(expected.get(id)??0))||mode==='net'&&xp(after)<=xp(before)||mode!=='net'&&xp(after)!==xp(before))throw Error('trawler asset or XP effect does not reconcile');
 return true;
}
export function trawlerInterruption(before:BotWorldState,after:BotWorldState){
 if(after.dialog?.isOpen&&(after.dialog.text==='The net has ripped!'||after.dialog.allComponents?.some(c=>c.text==='The net has ripped!')))return 'net-rip' as const;
 if(insideLegacyTrawler(before)&&insideLegacyTrawler(after)&&Math.floor(before.player!.worldX/64)!==Math.floor(after.player!.worldX/64))return 'flood-form' as const;
 return null;
}
