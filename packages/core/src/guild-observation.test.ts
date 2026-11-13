import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {guildActorFacts,journalGuildStage,refreshGuildEvidence} from './guild-observation';

function fixture(){
 const table:Record<number,any>={}; let tick=0;
 const c:any={ingame:true,varServ:[],var:[],mainModalId:-1,mainOverlayId:-1,ifType:(id:number)=>table[id],collectBotState:()=>({player:{worldX:2400,worldZ:3100,level:0}})};
 const s:any={client:c,tick:()=>tick,sdk:{getState:()=>({player:{level:0}}),getDialog:()=>null},onTick:()=>()=>{},direct:async(a:any)=>{if(a.type==='closeModal')c.mainModalId=-1;return{success:true};}};
 return {c,s,table};
}
test('private defaults, client mutations and pristine colours grant nothing',()=>{
 const {c,table}=fixture(); c.var[101]=200;c.var[0]=11;c.var[376]=0;table[7363]={colour:0x00ff00};
 expect(guildActorFacts(c)).toEqual({varps:{},questStages:{},unlocks:[]});
 c.varServ[101]=32;table[7363]={colour:0x00f800};table[7366]={colour:0x00f800};
 expect(guildActorFacts(c).varps).toEqual({qp:32});expect(guildActorFacts(c).questStages).toEqual({heroquest:15,legendsquest:75});
});
test('published started colour proves stage1 only; higher journal lower bounds are retained',async()=>{
 const {c,s,table}=fixture();table[7366]={colour:0xf8f800};table[7363]={colour:0xf8f800};table[7356]={colour:0xf8f800};
 expect(guildActorFacts(c).questStages).toEqual({legendsquest:1,heroquest:1,mcannon:1});
 table[8144]={text:'The Legends Quest'};table[8145]={text:'Radimus asked me to join him inside the Legends Guild to discuss my reward.'};
 s.direct=async(a:any)=>{c.mainModalId=a.type==='closeModal'?-1:8134;return{success:true};};
 expect((await refreshGuildEvidence(s,['legendsquest'])).questStages.legendsquest).toBe(50);
 expect(guildActorFacts(c).questStages.legendsquest).toBe(50);
 table[7366]={colour:0x00f800};expect(guildActorFacts(c).questStages.legendsquest).toBe(75);
});
test('team requires actual team overlay and game region, excluding waiting room',()=>{
 const {c}=fixture();c.mainOverlayId=11146;expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBe(0);
 c.mainOverlayId=11344;expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBe(1);
 c.collectBotState=()=>({player:{worldX:2370,worldZ:9475,level:0}});expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBeUndefined();
 c.collectBotState=()=>({player:{worldX:2400,worldZ:9500,level:1}});expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBeUndefined();
 c.collectBotState=()=>({player:{worldX:2400,worldZ:9500,level:0}});expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBe(1);
 c.collectBotState=()=>({player:{worldX:3200,worldZ:3200,level:0}});expect(guildActorFacts(c,c.collectBotState()).castlewarsTeam).toBeUndefined();
});
test('Legends first admission chooses exact owned menus and requires no invented stage or unlock',async()=>{
 for(const branch of ['cross','refuse','no-effect']){
  const {c,s}=fixture();let tick=0,n=0,opened=false,pending:number|null=null,due=0;const selected:number[]=[];
  const p={level:0,worldX:2729,worldZ:3348};
  const pages=[{text:'Yes sir, how can I help you?',options:[{index:0,text:'Click here to continue'}]},
   {text:'',options:[{index:3,text:'What is this place?'},{index:1,text:"It's ok thanks."}]},
   {text:'This is the Legends Guild!',options:[{index:0,text:'Click here to continue'}]},
   {text:'',options:[{index:2,text:'Can I go on the quest?'}]},
   {text:'The guard gets out a scroll.',options:[{index:0,text:'Click here to continue'}]},
   branch==='refuse'?{text:"I'm very sorry but you need to complete more quests before you can go on this quest.",options:[{index:1,text:'Which quests do I need to complete?'}]}:
    {text:'',options:[{index:4,text:"Yes, I'd like to talk to Grand Vizier Erkle."}]},
   {text:'The guard unlocks the gate and pushes it open for you.',options:[{index:0,text:'Click here to continue'}]}];
  s.sdk.getState=()=>({player:p,nearbyLocs:[{id:2392,x:2729,z:3349,level:0,distance:1}]});
  s.sdk.getDialog=()=>opened&&n<pages.length?{isOpen:true,...pages[n]}:null;
  s.direct=async(a:any)=>{expect(a.type).toBe('interactLoc');opened=true;return{success:true};};
  s.sdk.sendClickDialog=async(i:number)=>{selected.push(i);if([1,3,5].includes(n)&&branch!=='refuse'){pending=n+1;due=tick+3;}else n++;if(n===pages.length&&branch==='cross')p.worldZ=3350;return{success:true};};
  s.tick=()=>tick;s.onTick=(cb:()=>void)=>{let active=true;const pulse=()=>{if(active){tick++;if(pending!==null&&tick>=due){n=pending;pending=null;}cb();if(active)queueMicrotask(pulse);}};queueMicrotask(pulse);return()=>{active=false;};};
  const facts=await refreshGuildEvidence(s,['legends-entry']);
  expect(p.worldZ).toBe(branch==='cross'?3350:3348);expect(facts.questStages).toEqual({});expect(facts.unlocks).toEqual([]);
  expect(selected).toEqual(branch==='refuse'?[0,3,0,2,0]:[0,3,0,2,0,4,0]);
  expect(tick<=60).toBe(true);expect(facts.admission?.legendsEntry).toBe(branch==='cross'?'crossed':branch==='refuse'?'refused':'unknown');expect('admission' in guildActorFacts(c)).toBe(false);
 }
 const {s}=fixture();let sent=false;s.direct=async()=>{sent=true;return{success:true};};s.sdk.getDialog=()=>({isOpen:true});
 await refreshGuildEvidence(s,['legends-entry']);expect(sent).toBe(false);
});
test('journal lower bounds distinguish repaired rails from tower permission and exact title',()=>{
 expect(journalGuildStage('Dwarf Cannon','I have repaired all the broken railings, I should report back to the Commander.')).toBeNull();
 const text='The Commander has asked me to check up on his guards at @dre@the watchtower@dbl@ to the South of his camp.';
 expect(journalGuildStage('Dwarf Cannon',text)).toEqual({key:'mcannon',lowerBound:2});
 expect(journalGuildStage('Other',text)).toBeNull();
 expect(journalGuildStage('The Legends Quest','Radimus asked me to join him inside the Legends Guild to discuss my reward.')).toEqual({key:'legendsquest',lowerBound:50});
});
test('every pinned Dwarf Cannon journal stage and both conditional branches retain correct tower admission',()=>{
 const root='../../../vendor/rs-sdk/server/content/scripts/';
 const read=(path:string)=>readFileSync(new URL(root+path,import.meta.url),'utf8');
 const constants=read('quests/quest_mcannon/configs/quest_mcannon.constant')+'\n'+read('general/configs/quest.constant');
 const stages=new Map([...constants.matchAll(/\^(\w+)\s*=\s*(\d+)/g)].map(m=>[m[1]!,Number(m[2])]));
 const source=read('quests/quest_mcannon/scripts/mcannon_journal.rs2'),seen=new Set<number>();let variants=0;
 for(const match of source.matchAll(/^\s*case \^(\w+)\s*:\s*([\s\S]*?)(?=^\s*case \^|\n\})/gm)){
  const stage=stages.get(match[1]!)!;seen.add(stage);
  const lines=[...match[2]!.matchAll(/"([^\"]*)"/g)].map(m=>m[1]!);
  const bodies=stage===1||stage===2?lines.slice(1).map(line=>lines[0]+' '+line):[lines.join(' ')];
  for(const body of bodies){variants++;const found=journalGuildStage('Dwarf Cannon',body);expect(found).toEqual(stage<2?null:{key:'mcannon',lowerBound:2});}
 }
 expect([...seen].sort((a,b)=>a-b)).toEqual(Array.from({length:12},(_,i)=>i));expect(variants).toBe(14);
 const {c,table}=fixture();table[7356]={colour:0x00f800};expect(guildActorFacts(c).questStages.mcannon).toBe(11);
});
test('fresh requested own journal caches only on its client; foreign modal preserved',async()=>{
 const {c,s,table}=fixture();table[8144]={text:'Dwarf Cannon'};table[8145]={text:'The Commander has asked me to check up on his guards at the watchtower to the South of his camp.'};
 const actions:any[]=[];s.direct=async(a:any)=>{actions.push(a);if(a.type==='closeModal')c.mainModalId=-1;else c.mainModalId=8134;return{success:true};};
 c.mainModalId=5292;await refreshGuildEvidence(s,['dwarf-tower']);expect(actions).toHaveLength(0);expect(guildActorFacts(c).unlocks).toEqual([]);
 c.mainModalId=8134;const facts=await refreshGuildEvidence(s,['dwarf-tower']);
 expect(actions.map(a=>a.type)).toEqual(['closeModal','clickComponent','closeModal']);expect(facts.unlocks).toContain('dwarf-tower');
 expect(guildActorFacts(fixture().c).unlocks).toEqual([]);
});
test('prayer joins through fresh ladder dialogue; refusal and stale acknowledgement grant nothing',async()=>{
 for(const allow of [true,false]){
  const {c,s}=fixture();let n=0,tick=0;const listeners=new Set<()=>void>();
  const pages=[{text:'Only members of our order can go up there.',options:[{index:0,text:'Click here to continue'}]},
   {text:'',options:[{index:1,text:'Well can I join your order?'},{index:2,text:'Oh, sorry.'}]},
   {text:'Well can I join your order?',options:[{index:0,text:'Click here to continue'}]},
   {text:allow?'Ok, I see you are someone suitable for our order. You may join.':'No. I am sorry, but I feel you are not devout enough.',options:[]}];
  s.sdk.getState=()=>({player:{level:0,worldX:3046,worldZ:3482},nearbyLocs:[{id:2641,x:3046,z:3483,level:0,distance:1}]});
  let opened=false;s.sdk.getDialog=()=>opened&&n<4?{isOpen:true,...pages[Math.min(n,3)]}:null;
  s.sdk.sendClickDialog=async(i:number)=>{if(n===1)expect(i).toBe(1);n++;return{success:true};};
  s.direct=async()=>{opened=true;return{success:true};};s.tick=()=>tick;
  s.onTick=(cb:()=>void)=>{listeners.add(cb);queueMicrotask(()=>{tick++;for(const f of [...listeners])f();});return()=>listeners.delete(cb);};
  const facts=await refreshGuildEvidence(s,['prayer-guild']);expect(facts.unlocks.includes('prayer-guild')).toBe(allow);
 }
 const {c,s}=fixture();s.sdk.getDialog=()=>({isOpen:true,text:'Ok, I see you are someone suitable for our order. You may join.'});
 expect((await refreshGuildEvidence(s,['prayer-guild'])).unlocks).toEqual([]);
});
test('actual Monk referral approaches the observed Abbot and selects monastery admission, never healing',async()=>{
 for(const eligible of [true,false]){
  const {s,c}=fixture();let tick=0,mode='none',page=0,pending:number|null=null,due=0;const picked:string[]=[],walked:any[]=[];
  const p={level:0,worldX:3045,worldZ:3483},abbot={id:801,index:523,x:3057,z:3484,level:0,distance:14,reachable:true};
  const pages=[{text:'Greetings traveller.',options:[{index:1,text:'Click here to continue'}]},
   {text:'',options:[{index:1,text:"Can you heal me? I'm injured."},{index:3,text:'How do I get further into the monastery?'}]},
   {text:'How do I get further into the monastery?',options:[{index:1,text:'Click here to continue'}]},
   {text:"I'm sorry but only members of our order are allowed in the second level of the monastery.",options:[{index:1,text:'Click here to continue'}]},
   {text:'',options:[{index:1,text:'Well can I join your order?'},{index:2,text:'Oh, sorry.'}]},
   {text:'Well can I join your order?',options:[{index:1,text:'Click here to continue'}]},
   {text:eligible?'Ok, I see you are someone suitable for our order. You may join.':'No. I am sorry, but I feel you are not devout enough.',options:[{index:1,text:'Click here to continue'}]}];
  s.sdk.getState=()=>({player:p,nearbyLocs:[{id:2641,x:3046,z:3483,level:0,distance:1}],nearbyNpcs:[abbot,{id:803,index:516,x:3046,z:3484,level:0,distance:1}]});
  s.sdk.getDialog=()=>mode==='monk'?{isOpen:true,text:"You'll need to talk to Abbot Langley about that. He's usually to be found walking the halls of the monastery.",options:[{index:1,text:'Click here to continue'}]}:mode==='abbot'&&page<pages.length?{isOpen:true,pageId:String(page),...pages[page]}:null;
  s.bot={walkTo:async(x:number,z:number)=>{walked.push({x,z});p.worldX=x;p.worldZ=z;abbot.distance=0;return{success:true};}};
  s.direct=async(a:any)=>{if(a.type==='interactLoc')mode='monk';else{expect(a).toMatchObject({type:'interactNpc',npcIndex:523,optionIndex:1});mode='abbot';page=0;}return{success:true};};
  s.sdk.sendClickDialog=async(index:number)=>{if(mode==='monk'){mode='none';return{success:true};}const option=pages[page]!.options.find(o=>o.index===index);if(index!==0)picked.push(option?.text??'UNKNOWN');pending=page+1;due=tick+3;return{success:true};};
  s.tick=()=>tick;s.onTick=(cb:()=>void)=>{let active=true;const pulse=()=>{if(active){tick++;if(pending!==null&&tick>=due){page=pending;pending=null;}cb();if(active)queueMicrotask(pulse);}};queueMicrotask(pulse);return()=>{active=false;};};
  const facts=await refreshGuildEvidence(s,['prayer-guild']);
  expect(facts.unlocks.includes('prayer-guild')).toBe(eligible);expect(walked).toEqual([{x:3057,z:3484}]);
  expect(picked.filter(t=>!/Click here/.test(t))).toEqual(['How do I get further into the monastery?','Well can I join your order?']);expect(tick<80).toBe(true);
 }
});


import {questDefinitions} from './quest-status';
import {questFolder,questFinals,completedQuestUnlocks} from './guild-observation';
test('a green questlist entry adds complete:<varp>, never an exact stage; the spirit tree need is met',()=>{
 const {c,table}=fixture();
 const tree=questDefinitions().find(q=>q.key==='tree')!,fortress=questDefinitions().find(q=>q.key==='fortress')!;
 table[tree.id]={colour:0x00f800};table[fortress.id]={colour:0xf8f800};
 expect(guildActorFacts(c).questStages).toEqual({});expect(guildActorFacts(c).unlocks).toEqual([]);expect(completedQuestUnlocks(c)).toEqual(['complete:treequest']);
 table[fortress.id]={colour:0x00f800};
 expect(completedQuestUnlocks(c)).toContain('complete:spy');
 const missing=questDefinitions().filter(q=>!questFinals().has(questFolder(q.key))).map(q=>q.key);
 expect(missing.length).toBeLessThan(12);
});
import {travelAllowed,questCompleteValue,type Travel} from './travel';
test('travel that needs a finished quest takes the completion unlock only for that exact value and an unknown stage',()=>{
 const tree={id:'spirit_tree:stronghold_ent:Gnome stronghold',kind:'spirit_tree',name:'t',from:null,to:{x:0,z:0,level:0},coins:0,needs:[{varp:'treequest',op:'=',value:9}],runes:[],run:{how:'loc',loc:'stronghold_ent',op:1,option:null},cost:1} as unknown as Travel;
 const acct=(o:any)=>({skills:{},varps:{},items:[],...o});
 expect(questCompleteValue('treequest')).toBe(9);
 expect(travelAllowed(tree,acct({unlocks:['complete:treequest']}))).toBe(true);
 expect(travelAllowed(tree,acct({}))).toBe(false);
 expect(travelAllowed(tree,acct({unlocks:['complete:treequest'],questStages:{treequest:5}}))).toBe(false);
 expect(travelAllowed({...tree,needs:[{varp:'treequest',op:'=',value:5}]} as Travel,acct({unlocks:['complete:treequest']}))).toBe(false);
});
