import {questDefinitions} from '../packages/core/src/quest-status';
import {requirements,type Requirement,type Truth} from '../packages/planner/src/requirements';

// Quest completion is shared; possession of its starting/reward item is not proof.
// Names match the pinned quest journal. These are unlocks, not whole-goal success.
export const UNLOCKS:Record<string,Requirement>={
 'rune-mysteries':{fact:'quest:Rune Mysteries Quest'},
 'rune-quest-credit':{ref:'rune-mysteries'},
 'essence-access':{ref:'rune-mysteries'},
 'essence-tools':{all:[{ref:'essence-access'},{any:[1265,1267,1269,1273,1271,1275].map(id=>({fact:'item:'+id}))}]},
 'heroes-gear-prerequisite':{fact:"quest:Hero's Quest"},
 'legends-gear-prerequisite':{fact:'quest:Legends Quest'},
};
export function goalReadiness(s:any,expectedName:string,now:number){
 const fresh=(at:any)=>Number.isFinite(at)&&at>0&&at<=now&&now-at<300000;
 const valid=s?.name?.toLowerCase()===expectedName.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.practice&&fresh(s.at);
 const questsAt=s&&Object.hasOwn(s,'questsAt')?s.questsAt:s?.at;
 const journal=valid&&fresh(questsAt)&&questsAt<=s.at&&Array.isArray(s.quests)?s.quests:[];
 const facts:Record<string,Truth>={};
 for(const q of questDefinitions()){
  const rows=journal.filter((v:any)=>v?.id===q.id);
  const state=rows.length===1&&rows[0].name===q.name?rows[0].state:'unknown';
  facts['quest:'+q.name]=state==='complete'?true:['started','not started'].includes(state)?false:null;
 }
 const rows=(v:any)=>Array.isArray(v)&&v.every(i=>Number.isSafeInteger(i?.baseId??i?.id)&&Number.isSafeInteger(i.count)&&i.count>0);
 const known=valid?[s.inventory,s.equipmentObserved===true?s.equipment:null,
  fresh(s.bankAt)&&s.bankAt<=s.at?s.bank:null].filter(rows):[];
 for(const id of [1265,1267,1269,1273,1271,1275]){
  // Bank tools support preparation only, not immediate execution at the mine.
  facts['item:'+id]=known.some(items=>items.some((i:any)=>(i.baseId??i.id)===id))?true:known.length===3?false:null;
 }
 return {account:expectedName,scope:'Preparation unlocks only; tools may require withdrawal, routes and staging remain separate.',goals:requirements(UNLOCKS,facts,Object.keys(UNLOCKS).filter(k=>k!=='rune-mysteries'))};
}
