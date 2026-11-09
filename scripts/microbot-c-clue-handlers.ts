import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {listConfigFiles} from '../packages/knowledge/src/config';
export type ClueNpcHandler={clue:string;npc:string;source:string;line:number;challenge?:string;kind:'talk'|'challenge';guards:string[]};
type Section={type:string;name:string;body:string;line:number};
function sections(text:string):Section[]{
 const headers=[...text.matchAll(/^\[(\w+),([^\]\n]+)\][^\n]*/gm)];
 return headers.map((m,i)=>({type:m[1]!,name:m[2]!,line:text.slice(0,m.index).split('\n').length,body:text.slice(m.index!+m[0].length,headers[i+1]?.index??text.length)}));
}
// Only explicit native opnpc1 -> literal progress or one direct label hop.
// Puzzle/key/challenge branches are kept out of ordinary continue-only talk.
export function discoverNativeClueNpcHandlers():ClueNpcHandler[]{
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),out:ClueNpcHandler[]=[];
 for(const source of listConfigFiles('.rs2')){
  const text=readFileSync(resolve(content,source),'utf8');if(!text.includes('~progress_clue_')&&!text.includes('@trail_challengenpc_prompt('))continue;
  const blocks=sections(text),entries=blocks.filter(b=>b.type==='opnpc1');
  const entryFor=(part:Section,clue:string)=>part.type==='opnpc1'?[part]:part.type==='label'?entries.filter(e=>e.body.includes('@'+part.name+';')&&e.body.includes(clue)):[];
  const make=(part:Section,entry:Section,clue:string,prefix:string,kind:'talk'|'challenge',challenge?:string)=>{
   let npc=entry.name;if(npc.startsWith('_')){npc=prefix.match(/npc_type\s*=\s*(\w+)/)?.[1]??'';}if(!npc||npc.startsWith('_'))return;
   out.push({clue,npc,kind,challenge,source:'vendor/rs-sdk/server/content/'+source,line:part.line,guards:prefix.split(/\r?\n/).filter(l=>/^\s*if\s*\(/.test(l)).map(l=>l.trim())});
  };
  for(const part of blocks){
   for(const m of part.body.matchAll(/~progress_clue_(?:easy|medium|hard)\((trail_clue_\w+)\s*,/g)){
    const prefix=part.body.slice(0,m.index);if(/trail_puzzle_complete|inv_del\(|p_countdialog|p_choice/.test(prefix))continue;
    for(const entry of entryFor(part,m[1]!)){if(!entry.body.includes(m[1]!))continue;make(part,entry,m[1]!,entry===part?prefix:entry.body,'talk');}
   }
   for(const m of part.body.matchAll(/@trail_challengenpc_prompt\([\s\S]*?,\s*(trail_clue_\w+),\s*(trail_clue_\w+_challenge)\s*\)/g)){
    for(const entry of entryFor(part,m[1]!))make(part,entry,m[1]!,entry.body,'challenge',m[2]!);
   }
  }
 }
 return out.filter((v,i)=>out.findIndex(w=>w.clue===v.clue&&w.npc===v.npc&&w.kind===v.kind)===i);
}
export function nativeSpecialClueSearchHandlers(){
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
 const rows=[
  {clue:'trail_clue_easy_vague003',coord:'1_40_51_14_62',label:'riddle_loc_easy_exp008',route:'scripts/general_use/scripts/drawers.rs2',effect:'scripts/minigames/game_trail/scripts/easy/trail_clue_easy.rs2'},
  ...[[1,'0_50_54_56_31','chests'],[2,'1_40_51_14_62','drawers'],[3,'1_40_51_51_60','drawers'],[4,'0_42_54_21_22','drawers'],[5,'1_40_48_33_36','chests'],[7,'1_43_49_57_29','drawers'],[8,'0_45_55_41_57','drawers']].map(([n,coord,type])=>({clue:'trail_clue_medium_riddle'+String(n).padStart(3,'0'),coord:String(coord),label:'riddle_loc_medium_exp'+String(n).padStart(3,'0'),route:'scripts/general_use/scripts/'+type+'.rs2',effect:'scripts/minigames/game_trail/scripts/medium/trail_clue_medium.rs2'})),
 ];
 return rows.map(r=>{
  const route=readFileSync(resolve(content,r.route),'utf8'),effect=readFileSync(resolve(content,r.effect),'utf8');
  if(!route.includes(r.coord)||!route.includes('@'+r.label+';')||!effect.includes('[label,'+r.label+']')||!effect.includes(r.clue))throw Error('native special clue search source changed: '+r.clue);
  const block=sections(effect).find(s=>s.type==='label'&&s.name===r.label)!;
  const key=block.body.match(/inv_del\(inv,\s*(trail_clue_\w+_key),\s*1\)/)?.[1];
  return{...r,key,source:'vendor/rs-sdk/server/content/'+r.effect,line:block.line};
 });
}
