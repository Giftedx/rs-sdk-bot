// Quest journals travel as one shared list plus, for each bot, the ids of its finished and started quests. A bot row
// that held all 68 quest objects (about 4 KB) now holds two short id lists. The page expands them back in `receive`
// (index.html expandQuests, the same rule as expandQuests below; quest-pack.test.ts compares the two).
// A bot whose journal does not match the shared list keeps its full `quests` array.
export type QuestRow={id:number;name:string;state:string};
const sig=(rows:QuestRow[])=>rows.map(q=>q.id+':'+q.name).join('|');

export function packQuests<T extends {quests?:unknown}>(bots:T[]):{bots:any[];questList:{id:number;name:string}[]}{
 const first=bots.find(b=>Array.isArray(b.quests)&&(b.quests as QuestRow[]).length>0);
 const list=first?(first.quests as QuestRow[]).map(q=>({id:q.id,name:q.name})):[];
 const key=sig(list as QuestRow[]);
 const out=bots.map((b:any)=>{
  if(!Array.isArray(b.quests)||!b.quests.length||sig(b.quests)!==key)return b;
  const {quests,...rest}=b,pick=(state:string)=>quests.filter((q:QuestRow)=>q.state===state).map((q:QuestRow)=>q.id);
  const done=pick('complete'),started=pick('started'),unknown=pick('unknown');
  return {...rest,questsDone:done,...(started.length?{questsStarted:started}:{}),...(unknown.length?{questsUnknown:unknown}:{})};
 });
 return {bots:out,questList:list};
}

export function expandQuests(state:any){
 if(!Array.isArray(state?.bots)||!Array.isArray(state.questList))return state;
 const list=state.questList;
 for(const b of state.bots){
  if(!Array.isArray(b?.questsDone))continue;
  const done=new Set(b.questsDone),started=new Set(b.questsStarted??[]),unknown=new Set(b.questsUnknown??[]);
  b.quests=list.map((q:any)=>({id:q.id,name:q.name,state:done.has(q.id)?'complete':started.has(q.id)?'started':unknown.has(q.id)?'unknown':'not started'}));
  delete b.questsDone;delete b.questsStarted;delete b.questsUnknown;
 }
 return state;
}
