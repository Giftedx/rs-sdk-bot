import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {questSweepProofAccountEnv,questSweepProofEndpoints,questSweepChecks,questSweepChildConfiguration,questSweepElenaPreset,runQuestSweepProofCase,selectFreshQuestSweepProofName,selectQuestSweepProofCases,QUEST_SWEEP_PROOF_CASE_IDS} from '../src/quest-sweep-proof';
import {converseDialogue,createBurstPageRecorder,dialogueTransition,liveDialoguePage,type ConverseIO} from '../../../scripts/generated/quest-lib';
import {needs,plan,presetFor,shopCoinTake} from '../../../scripts/quest-sweep';
import {castable} from '../../../scripts/teleport-runes';

test('the Seer conversation waits through an observed closure or pending continue and fails a refused live page',async()=>{
 // seer.rs2 seer_looking_glass: "Let me look into my looking glass.", if_close, three mes + p_delay(3), then the hint pages.
 // Each frame is one tick: the SDK page (snap) and the client page (live), which can be a tick ahead.
 type Opt={text:string;componentId:number;buttonType:number};
 type Page={opts:Opt[];waiting?:boolean}|null;
 const cont=(text:string):{text:string;opts:Opt[]}=>({text,opts:[{text:'Click here to continue',componentId:1,buttonType:6}]});
 const choice={text:'Many greetings.',opts:['I need to locate some scorpions.','Your friend Thormac sent me to speak to you.','I seek knowledge and power!'].map((text,i)=>({text,componentId:2471+i,buttonType:1}))};
 const right=cont('Well you have come to the right place.'),glass=cont('Let me look into my looking glass.');
 const hint=cont('I can see a scorpion that you seek.'),last=cont("Well see if you can find that scorpion then, and I'll try and get you some information on the others.");
 const seer:{snap:{text:string;opts:Opt[]}|null;live:Page;refuse?:boolean}[]=[
  {snap:choice,live:choice},
  // A continue still waits for its next page in the client while the SDK shows the page open.
  {snap:right,live:{...right,waiting:true}},{snap:right,live:right},
  // The server closed the chat; the SDK still shows the last page.
  {snap:glass,live:null},{snap:null,live:null},{snap:null,live:null},{snap:null,live:null},
  {snap:hint,live:hint},{snap:last,live:last},{snap:null,live:null}];
 const run=async(frames:typeof seer)=>{
  let tick=0;const clicks:string[]=[],log:string[]=[],seen:string[]=[];
  const frame=()=>frames[Math.min(tick,frames.length-1)]!;
  const client=()=>{const l=frame().live;return{chatModalId:l?4882:-1,resumedPauseButton:!!l?.waiting,getDialogOptions:()=>l?.opts??[]};};
  const io:ConverseIO={tick:()=>tick,stopped:()=>false,guard:async()=>{},
   dialog:()=>{const p=frame().snap;if(p)seen.push(p.text);return p?{isOpen:true,isWaiting:false,options:p.opts}:{isOpen:false,isWaiting:false,options:[]};},
   live:()=>liveDialoguePage(client()),
   click:async opt=>{
    const l=frame().live;
    if(frame().refuse||!l||l.waiting||(opt?!l.opts.some(o=>o.text===opt.text):l.opts.some(o=>o.buttonType!==6)))
     return{success:false,message:opt?'visible option was not on the current page':'Failed to click dialog option'};
    clicks.push(opt?.text??'continue');return{success:true};
   },
   wait:async()=>{tick++;},fail:async why=>{throw Error(why);},log:line=>{log.push(line);},planGrace:()=>false};
  const done=await converseDialogue(io,[/i need to locate some scorpions/i],()=>seen.some(t=>/information on the others/.test(t))&&!frame().snap,60);
  return{done,clicks,log,tick};
 };
 const ok=await run(seer);
 expect(ok.done).toBe(true);
 expect(ok.clicks).toEqual(['I need to locate some scorpions.','continue','continue','continue']);
 expect(ok.log).toEqual([
  'NOTE dialogue continue refused (Failed to click dialog option): live page waiting, wait 1/6',
  'NOTE dialogue continue refused (Failed to click dialog option): live page closed, wait 2/6']);
 // The same actionable page refused in the client fails at once and names the option and the live flags.
 const stuck=Array.from({length:20},()=>({snap:choice,live:choice,refuse:true}));
 await expect(run(stuck)).rejects.toThrow('dialogue click refused: visible option was not on the current page (option "I need to locate some scorpions."; options ["I need to locate some scorpions.","Your friend Thormac sent me to speak to you.","I seek knowledge and power!"]; live open=true waiting=false same page)');
 expect(dialogueTransition({isOpen:true,isWaiting:false,options:choice.opts},{isOpen:true,isWaiting:false,options:choice.opts.slice(1)})).toBe('new page');
 // A client that refuses while the SDK page never moves on fails after the bounded waits.
 await expect(run(Array.from({length:20},()=>({snap:glass,live:null})))).rejects.toThrow('live open=false waiting=false closed after 6 waits');
});

test('fresh proof account selection skips an occupied candidate and refuses after its bounded candidates',()=>{
 const candidates=['qswxused0','qswxfresh1','qswxunused2'],checked:string[]=[];
 const selected=selectFreshQuestSweepProofName(4,name=>{checked.push(name);return name==='qswxused0';},attempt=>candidates[attempt]!,3);
 expect(selected).toBe('qswxfresh1');
 expect(checked).toEqual(['qswxused0','qswxfresh1']);
 expect(()=>selectFreshQuestSweepProofName(4,()=>true,attempt=>candidates[attempt]!,3)).toThrow('fresh quest-sweep practice account unavailable after 3 candidates');
});

test('a required case child that exits nonzero writes its log and snapshot, then rejects before any later case',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qsw-nonzero-')),save=join(dir,'live.sav');
 try{
  writeFileSync(save,'after');
  const stream=(text:string,open=false)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(text));if(!open)c.close();}});
  const child=(id:string,exit:number,open=false)=>({id,exit:-1,timedOut:false,saveMatched:false,seconds:0,
   spawn:()=>({pid:1,stdout:stream('START 2947 3368 0\nRESULT fail quest-sweep ball\n',open),stderr:stream(''),exited:Promise.resolve(exit)})});
  let retained=0,killed=0;
  const run=(c:ReturnType<typeof child>)=>{const {spawn,...record}=c;return{record,done:runQuestSweepProofCase({dir,record,save,timeoutMs:60000,drainMs:50,spawn,
   matched:async()=>false,retain:()=>{retained++;},kill:async()=>{killed++;}})};};
  // The native.json record: ball-worn-kit is required to exit 0. Its stdout stays open after exit, as a held pipe would.
  const ball=run(child('ball-worn-kit',255,true));
  await expect(ball.done).rejects.toThrow('quest-sweep proof case ball-worn-kit failed: exit=255 expected=0 timedOut=false saveMatched=false');
  expect(ball.record).toMatchObject({exit:255,timedOut:false,saveMatched:false});
  expect(readFileSync(join(dir,'ball-worn-kit.log'),'utf8')).toContain('RESULT fail quest-sweep ball');
  expect(readFileSync(join(dir,'ball-worn-kit-after.sav'),'utf8')).toBe('after');
  expect([retained,killed]).toEqual([1,0]);
  // A refusal case owns exit 1 and continues; exit 0 there is the unexpected path.
  await expect(run(child('ball-missing-gloves',1)).done).resolves.toMatchObject({exit:1});
  await expect(run(child('doric-no-cash',0)).done).rejects.toThrow('expected=1');
  // A spawn failure still leaves the log and snapshot and rejects.
  const record={id:'imp-surplus-beads',exit:-1,timedOut:false,saveMatched:false,seconds:0};
  await expect(runQuestSweepProofCase({dir,record,save,timeoutMs:60000,spawn:()=>{throw Error('spawn ENOENT');},matched:async()=>false,retain:()=>{}})).rejects.toThrow('spawn ENOENT');
  expect(readFileSync(join(dir,'imp-surplus-beads.log'),'utf8')).toContain('spawn ENOENT');
  expect(existsSync(join(dir,'imp-surplus-beads-after.sav'))).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a newly created Windows local bot gets both owned endpoints even when SDK newline replacement omitted the gateway',()=>{
 const p=questSweepProofEndpoints({engine:22100,gateway:22101,management:22102,tcp:22103},'quest-sweep-12345678901234567890');
 const env=questSweepProofAccountEnv('SERVER=localhost\r\nTELEMETRY=false\r\n',p);
 expect(env).toContain('SERVER=127.0.0.1:22100');expect(env).toContain('GATEWAY_URL=ws://127.0.0.1:22101');
 for(const text of ['SERVER=rs-sdk-demo.fly.dev\n','SERVER=localhost:8910\n','SERVER=localhost\nGATEWAY_URL=ws://example.com\n'])expect(()=>questSweepProofAccountEnv(text,p)).toThrow('new practice account required');
});

test('the started Totem fixture credits the completed Clock Tower before the server recounts quest points',()=>{
 const source=readFileSync(new URL('../src/quest-sweep-proof.ts',import.meta.url),'utf8');
 expect(source).toContain('varps:{200:1,10:8,101:1}');
});

const doricSave=(coins:number):Parameters<typeof questSweepChecks>[1]=>({version:10,position:{x:2965,z:3380,level:0},vars:{31:0,101:0},
 inventories:{93:[...(coins?[{slot:0,id:995,count:coins}]:[]),{slot:1,id:1351,count:1}]},
 skills:Array.from({length:21},(_,index)=>({index,rawExperience:index===3?9800:0,xp:index===3?980:0,level:index===3?10:1}))});
test('Elena upstairs funding includes the live teleport inputs and keeps bank coins out of the staging withdrawal',()=>{
 const preset=questSweepElenaPreset(),pack=preset.inventory!,bank=preset.bank!;
 const held=(id:number)=>pack.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 expect(held(995)).toBe(82904);
 expect(bank.find(i=>i.id===995)?.count).toBe(1680);
 expect([held(563),held(556),held(555)]).toEqual([1,4,2]);
 expect(preset.skills?.Magic).toBe(99);
 expect(castable('magic:falador_teleport',held,[],preset.skills?.Magic)).toBe(true);
 // Coins alone cannot supply the spell. Four Air runes also cannot fund Camelot Teleport.
 expect(castable('magic:falador_teleport',held,[],1)).toBe(false);
 expect(castable('magic:falador_teleport',id=>id===995?82904:0,[],99)).toBe(false);
 expect(castable('magic:camelot_teleport',held,[],99)).toBe(false);
 expect(plan(needs(presetFor('elena'),false,'elena'),pack,bank)).toEqual({
  withdraw:[{id:1929,count:4}],missing:[{id:1975,count:1}]});
 expect(shopCoinTake(106,held(995),0,0)).toBe(0);
});
test('Elena upstairs fixture and checks agree on descent, staged water and the observed Heckel route',()=>{
 const preset=questSweepElenaPreset();
 expect(preset).toEqual({position:{x:2529,z:3162,level:1},skills:{Attack:99,Defence:99,Strength:99,Hitpoints:99,Ranged:99,Prayer:99,Magic:99},
  inventory:[{id:995,count:82904},{id:563,count:1},{id:556,count:4},{id:555,count:2},...[2126,952,954,1927,231].map(id=>({id,count:1}))],
  bank:[{id:995,count:1680},{id:1929,count:4}]});
 expect(readFileSync(new URL('../src/quest-sweep-proof.ts',import.meta.url),'utf8')).toContain(':elena?questSweepElenaPreset()');
 const before=doricSave(0);before.position={x:2529,z:3162,level:1};before.vars={165:0,101:0};
 for(const i of [0,1,2,3,4,5,6])before.skills[i]!.level=99;
 before.position={...preset.position!,level:preset.position!.level!};
 before.inventories={93:preset.inventory!.map((i,slot)=>({...i,slot})),95:preset.bank!.map((i,slot)=>({...i,slot}))};
 const after=structuredClone(before);after.position={x:2567,z:3336,level:0};after.vars={165:29,101:1};after.skills[14]!.rawExperience=606250;
 after.skills[6]!.rawExperience+=12000;
 after.inventories={93:[{id:995,slot:0,count:82902},{id:952,slot:1,count:1},{id:1925,slot:2,count:4},{id:1505,slot:6,count:1},
  {id:556,slot:7,count:1},{id:555,slot:8,count:1}],94:[{id:1506,slot:0,count:1}],95:[{id:995,slot:0,count:1680}]};
 const log=`START 2529 3162 1
QUEST_SWEEP_DOWN {"from":{"x":2529,"z":3162,"level":1},"to":{"x":2525,"z":3162,"level":0}}
QUEST_SWEEP_BANK {"from":{"x":2525,"z":3162,"level":0},"to":{"x":2809,"z":3441,"level":0}}
QUEST_SWEEP_SPELL {"from":{"x":2525,"z":3162,"level":0},"to":{"x":2809,"z":3441,"level":0},"planned":true,"spell":"Falador teleport"}
QUEST_SWEEP_BANK_WALK {"at":{"x":2809,"z":3441,"level":0},"to":{"x":2809,"z":3441,"level":0},"outcome":{"ok":true}}
QUEST_SWEEP_WITHDRAW {"id":1929,"count":4,"before":0,"after":4,"bankBefore":4,"bankAfter":0,"observed":true}
QUEST_SWEEP_BANK_DONE {"at":{"x":2809,"z":3441,"level":0},"buys":[],"gathers":[]}
QUEST_SWEEP_HECKEL_APPROACH {"from":{"x":2809,"z":3441,"level":0},"to":{"x":2461,"z":3382,"level":0},"at":{"x":2461,"z":3382,"level":0},"observed":true}
AGILITY_ENTRY_GATE {"at":"2461,3385,0","tick":200,"opens":2}
QUEST_SWEEP_CORRIDOR {"to":{"x":2493,"z":3488},"try":1,"ok":true,"at":{"x":2491,"z":3488,"level":0}}
QUEST_SWEEP_HECKEL {"item":1975,"before":0,"after":1,"coinsBefore":82904,"coins":82902,"observed":true}
QUEST_SWEEP_TREE_EXIT {"ok":true,"at":{"x":2466,"z":3491,"level":0}}
QUEST_SWEEP_GATE {"ok":true,"at":{"x":2461,"z":3382,"level":0}}
MILESTONE quest-sweep elena staged at {"x":2572,"z":3333,"level":0}
QUEST_SWEEP_FLAG {"name":"Plague City","state":"complete"}
RESULT ok qp=1 eats=0 died=false
LOGOUT logged-out
`;
 const record={id:'elena-heckel-dust',exit:0,timedOut:false,saveMatched:true,seconds:223};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log.replace(/^QUEST_SWEEP_DOWN .*\n/m,''))).toMatchObject({descent:false});
 expect(check(log.replace('"from":{"x":2809,"z":3441','"from":{"x":2529,"z":3162'))).toMatchObject({approach:false});
 expect(check(log.replace('"at":"2461,3385,0"','"at":"2461,3384,0"'))).toMatchObject({gate:false});
 expect(check(log.replace(/^AGILITY_ENTRY_GATE .*\n/m,''))).toMatchObject({gate:false,route:false});
 expect(check(log.replace('"x":2491,"z":3488','"x":2490,"z":3488'))).toMatchObject({ground:false});
 expect(check(log.replace('"x":2491,"z":3488,"level":0','"x":2491,"z":3488,"level":1'))).toMatchObject({ground:false});
 expect(check(log.replace('"try":1','"try":4'))).toMatchObject({ground:false});
 expect(check(log.replace(/^QUEST_SWEEP_CORRIDOR .*\n/m,''))).toMatchObject({ground:false});
 expect(check(log.replace(/^QUEST_SWEEP_HECKEL (.*)\nQUEST_SWEEP_TREE_EXIT (.*)$/m,'QUEST_SWEEP_TREE_EXIT $2\nQUEST_SWEEP_HECKEL $1'))).toMatchObject({route:false});
 expect(check(log.replace('"coins":82902','"coins":82901'))).toMatchObject({bought:false,budget:false});
 expect(check(log.replace(/^QUEST_SWEEP_SPELL .*\n/m,''))).toMatchObject({travel:false});
 expect(check(log.replace('Falador teleport','Camelot teleport'))).toMatchObject({travel:false});
 const spell=log.split('\n').find(line=>line.startsWith('QUEST_SWEEP_SPELL '))!;
 expect(check(log.replace(spell,spell.replace('"x":2525','"x":2526')))).toMatchObject({travel:false});
 expect(check(log.replace(spell,spell.replace('"x":2809','"x":2810')))).toMatchObject({travel:false});
 expect(check(log.replace(spell+'\n','')+spell+'\n')).toMatchObject({travel:false});
 expect(check(log.replace(spell,spell+'\n'+spell))).toMatchObject({travel:false});
 expect(check(log.replace('"bankAfter":0,"observed":true','"bankAfter":1,"observed":true'))).toMatchObject({staged:false});
 expect(check(log.replace(/^QUEST_SWEEP_TREE_EXIT .*\n/m,''))).toMatchObject({treeExit:false});
 expect(check(log.replace('"ok":true,"at":{"x":2461,"z":3382','"ok":true,"at":{"x":2461,"z":3381'))).toMatchObject({staged:false});
 expect(check(log.replace('LOGOUT logged-out',''))).toMatchObject({logout:false});
 expect(check(log.replace('"state":"complete"','"state":"started"'))).toMatchObject({questList:false});
 after.vars[165]=28;expect(check().quest).toBe(false);after.vars[165]=29;
 after.inventories[93]![0]!.count--;expect(check().assets).toBe(false);after.inventories[93]![0]!.count++;
 after.skills[14]!.rawExperience--;expect(check().reward).toBe(false);after.skills[14]!.rawExperience++;
 after.skills[6]!.rawExperience--;expect(check().travel).toBe(false);after.skills[6]!.rawExperience++;
 after.inventories[93]!.find(i=>i.id===556)!.count++;expect(check().assets).toBe(false);after.inventories[93]!.find(i=>i.id===556)!.count--;
 after.inventories[95]![0]!.count--;expect(check()).toMatchObject({assets:false,staged:false});after.inventories[95]![0]!.count++;
 before.inventories[93]!.find(i=>i.id===995)!.count=0;expect(check().entry).toBe(false);before.inventories[93]!.find(i=>i.id===995)!.count=82904;
 before.skills[6]!.level=1;expect(check().entry).toBe(false);before.skills[6]!.level=99;
 before.position={x:2615,z:3332,level:0};expect(check().entry).toBe(false);
});

test('Elena normal acquisition accepts ground-floor bucket sellers and its observed water-gathering exit',()=>{
 const before=doricSave(0);before.position={x:2615,z:3332,level:0};before.vars={165:0,101:0};before.skills[3]!.level=40;
 before.inventories={93:[2126,952,954,1927,231].map((id,slot)=>({id,slot,count:1})),95:[{id:995,slot:0,count:230}]};
 const after=structuredClone(before);after.vars={165:29,101:1};after.skills[14]!.rawExperience=606250;
 after.inventories={93:[{id:995,slot:0,count:220},{id:952,slot:1,count:1},{id:1925,slot:2,count:4},{id:1505,slot:6,count:1}],
  94:[{id:1506,slot:0,count:1}],95:[]};
 const log=`START 2615 3332 0
QUEST_SWEEP_BUY {"item":1925,"npc":"Shop keeper","before":0,"after":3,"coinsBefore":230,"coins":224}
QUEST_SWEEP_BUY {"item":1925,"npc":"Shop keeper","before":3,"after":4,"coinsBefore":224,"coins":222}
QUEST_SWEEP_HECKEL_APPROACH {"from":{"x":2657,"z":3153,"level":0},"to":{"x":2461,"z":3382,"level":0},"at":{"x":2461,"z":3382,"level":0},"observed":true}
QUEST_SWEEP_HECKEL {"item":1975,"before":0,"after":1,"coinsBefore":222,"coins":220,"observed":true}
${[1,2,3,4].map(held=>'QUEST_SWEEP_USE '+JSON.stringify({item:1929,at:{x:2639,z:3369,level:0},held,target:4})).join('\n')}
MILESTONE quest-sweep elena staged at {"x":2572,"z":3333,"level":0}
QUEST_SWEEP_FLAG {"name":"Plague City","state":"complete"}
RESULT ok qp=1 eats=0 died=false
LOGOUT logged-out
`;
 const record={id:'elena-heckel-dust',exit:0,timedOut:false,saveMatched:true,seconds:223};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log.replace(/^QUEST_SWEEP_USE .*\n/gm,''))).toMatchObject({treeExit:false,staged:false});
 expect(check(log.replace('"coins":222','"coins":221')).budget).toBe(false);
 expect(check(log.replace('"held":4','"held":3')).staged).toBe(false);
});

test('Imp saved effects require one debit per colour, carried surplus, banked extras, exact rewards and logout',()=>{
 const beads=[1470,1472,1474,1476],before=doricSave(91);
 before.position={x:3104,z:3163,level:2};before.vars={160:0,101:0};before.skills[3]!.level=40;
 before.inventories={93:[1470,1470,1472,1472,1474,1474,1476,1476,995,433,1351].map((id,slot)=>({id,slot,count:id===995?91:1})),
  95:[...beads.map((id,slot)=>({id,slot,count:3})),{id:995,slot:4,count:723},{id:1478,slot:5,count:1}]};
 const after=structuredClone(before);after.vars={160:2,101:1};
 after.inventories[93]=[1470,1472,1474,1476,1478,995,433,1351].map((id,slot)=>({id,slot,count:id===995?91:1}));
 after.skills[6]={index:6,rawExperience:218750,xp:21875,level:44};
 const log='START 3104 3163 2\nQUEST_SWEEP_FLAG {"name":"Imp Catcher","state":"complete"}\nRESULT ok qp=1 eats=0 died=false\nLOGOUT logged-out\n';
 const record={id:'imp-surplus-beads',exit:0,timedOut:false,saveMatched:true,seconds:1};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 // A zero debit or an extra debit of any colour must fail, even with a saved completion flag.
 for(const id of beads)for(const debit of [0,2]){
  const held=before.inventories[93]!.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
  const pack=after.inventories[93]!;
  after.inventories[93]=[...pack.filter(i=>i.id!==id),...(held>debit?[{id,slot:20,count:held-debit}]:[])];
  expect(check()).toMatchObject({beads:false,assets:false});after.inventories[93]=pack;
 }
 // Bank depletion cannot disguise an absent carried debit or removal of the carried surplus.
 after.inventories[93]!.push({id:1472,slot:20,count:1});after.inventories[95]!.find(i=>i.id===1472)!.count--;
 expect(check()).toMatchObject({assets:true,beads:false});after.inventories[93]!.pop();after.inventories[95]!.find(i=>i.id===1472)!.count++;
 after.inventories[93]![0]!.id=1472;after.inventories[95]!.find(i=>i.id===1470)!.count++;after.inventories[95]!.find(i=>i.id===1472)!.count--;
 expect(check()).toMatchObject({assets:true,beads:false});after.inventories=structuredClone(before.inventories);
 after.inventories[93]=[1470,1472,1474,1476,1478,995,433,1351].map((id,slot)=>({id,slot,count:id===995?91:1}));
 for(const id of [1478,433,995,1351]){
  const row=after.inventories[93]!.find(i=>i.id===id)!;row.count--;
  expect(check().assets).toBe(false);if(id===1478)expect(check().reward).toBe(false);row.count++;
 }
 after.skills[6]!.rawExperience--;expect(check().reward).toBe(false);after.skills[6]!.rawExperience++;
 after.skills[0]!.rawExperience++;expect(check().unrelatedXp).toBe(false);after.skills[0]!.rawExperience--;
 after.vars[160]=1;expect(check().quest).toBe(false);after.vars[160]=2;
 after.vars[101]=2;expect(check().quest).toBe(false);after.vars[101]=1;
 expect(check(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 expect(check(log.replace('died=false','died=true')).alive).toBe(false);
 after.skills[3]!.level=0;expect(check().alive).toBe(false);after.skills[3]!.level=40;
 // The fixture enters with Hitpoints 40 to survive the Draynor bank trip without food.
 before.skills[3]!.level=10;expect(check()).toMatchObject({entry:false,entryHp:false});before.skills[3]!.level=40;
 record.exit=1;expect(check().child).toBe(false);record.exit=0;
 record.timedOut=true;expect(check().child).toBe(false);record.timedOut=false;
 record.saveMatched=false;expect(check().saved).toBe(false);record.saveMatched=true;
 expect(check(log.replace('"complete"','"started"')).questList).toBe(false);
 expect(check(log.replace('RESULT ok','RESULT fail')).result).toBe(false);
 after.position.level=1;expect(check().location).toBe(false);after.position.level=2;
 expect(Object.values(check()).every(Boolean)).toBe(true);
});
test('Doric self-supply replay requires the bought pickaxe, exact mined ores, their handover, the reward and logout',()=>{
 const before=doricSave(362),after=structuredClone(before);
 after.position={x:2951,z:3450,level:0};after.vars[31]=100;after.vars[101]=1;
 after.inventories={93:[{slot:0,id:995,count:541},{slot:1,id:1351,count:1},{slot:2,id:1265,count:1}],94:[],95:[]};
 after.skills[14]={index:14,rawExperience:367500,xp:36750,level:51};
 const mined=[[434,6],[436,4],[440,2]].map(([item,n])=>`QUEST_SWEEP_GATHER ${JSON.stringify({item,how:'mine',count:n,held:n,target:n})}\n`).join('');
 const log='START 2965 3380 0\nQUEST_SWEEP_GATHER_PLAN {"gathers":[{"id":434,"count":6,"how":"mine"}],"still":[],"tools":[{"id":1265,"count":1}],"coins":0}\n'
  +'QUEST_SWEEP_SHOP_PLAN {"buys":[{"id":1265,"count":1,"name":"Bronze pickaxe","npc":"Arhein"}],"coins":103}\n'
  +'QUEST_SWEEP_BUY {"item":1265,"name":"Bronze pickaxe","count":1,"npc":"Bob","before":0,"after":1,"coinsBefore":362,"coins":361}\n'+mined
  +'MILESTONE quest-sweep doric staged at {"x":2949,"z":3449,"level":0}\nQUEST_SWEEP_FLAG {"id":7336,"name":"Doric\'s Quest","state":"complete"}\nMILESTONE 100 16\nLOGOUT logged-out\n'
  +'RESULT ok qp=1  xp=mining=32500 at=2951,3450,0 ticks=16 hpMin=10 eats=0 died=false msgs=You hand the Clay, Copper and Iron to Doric. / Doric hands you 180 coins.\n';
 const check=(text=log,exit=0):Record<string,boolean>=>questSweepChecks('doric-self-supply',before,after,text,{id:'doric-self-supply',exit,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log,1).child).toBe(false);
 expect(check(log.replace('"held":2,"target":2','"held":1,"target":2')).gathered).toBe(false);
 expect(check(log.replace('"coins":361','"coins":360')).bought).toBe(false);
 after.inventories[93]![0]!.count--;expect(check().assets).toBe(false);after.inventories[93]![0]!.count++;
 for(const id of [1617,1619,1621,1623]){
  after.inventories[93]!.push({slot:3,id,count:1});expect(check().assets).toBe(true);after.inventories[93]!.pop();
 }
 after.inventories[93]!.push({slot:3,id:1623,count:2});before.inventories[93]!.push({slot:2,id:1623,count:1});
 expect(check().assets).toBe(true);after.inventories[93]!.find(i=>i.id===1623)!.count=0;expect(check().assets).toBe(false);
 before.inventories[93]!.pop();after.inventories[93]!.pop();
 after.inventories[93]!.push({slot:3,id:1511,count:1});expect(check().assets).toBe(false);after.inventories[93]!.pop();
 expect(check(log.replace('LOGOUT logged-out\n',''))).toMatchObject({logout:false});
 expect(check(log.replace('died=false','died=true')).alive).toBe(false);
 after.inventories[93]!.push({slot:3,id:440,count:1});expect(check()).toMatchObject({used:false,assets:false});after.inventories[93]!.pop();
 after.skills[14]!.rawExperience-=1250;expect(check().reward).toBe(false);after.skills[14]!.rawExperience+=1250;
 after.skills[3]!.rawExperience+=40;expect(check().unrelatedXp).toBe(false);after.skills[3]!.rawExperience-=40;
 after.vars[31]=10;expect(check().quest).toBe(false);after.vars[31]=100;
 expect(Object.values(questSweepChecks('doric-self-supply',doricSave(0),after,log,{id:'doric-self-supply',exit:0,timedOut:false,saveMatched:true,seconds:1})).every(Boolean)).toBe(false);
});
test('Doric no-cash replay refuses at the bank before any purchase, gather or handover and logs out',()=>{
 const before=doricSave(0),after=structuredClone(before);
 after.position={x:2946,z:3368,level:0};after.inventories[94]=[];after.inventories[95]=[];
 const log='START 2965 3380 0\nQUEST_SWEEP_GATHER_PLAN {"gathers":[{"id":434,"count":6,"how":"mine"}],"still":[],"tools":[{"id":1265,"count":1}],"coins":0}\n'
  +'LOGOUT logged-out\nRESULT fail quest-sweep doric missing 995:103 to buy 1265\n';
 const check=(text=log,exit=1):Record<string,boolean>=>questSweepChecks('doric-no-cash',before,after,text,{id:'doric-no-cash',exit,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log,0).child).toBe(false);
 expect(check(log.replace('missing 995:103','missing 434:6,436:4,440:2')).result).toBe(false);
 expect(check(log+'QUEST_SWEEP_BUY {"item":1265,"count":1,"before":0,"after":1,"coinsBefore":1,"coins":0}\n').noQuestTravel).toBe(false);
 expect(check(log+'MILESTONE quest-sweep doric staged at {}\n').noQuestTravel).toBe(false);
 expect(check(log.replace('LOGOUT logged-out\n',''))).toMatchObject({logout:false});
 after.vars[31]=10;expect(check().questUnchanged).toBe(false);after.vars[31]=0;
 after.inventories[93]!.push({slot:2,id:1265,count:1});expect(check().assets).toBe(false);after.inventories[93]!.pop();
 after.position={x:2951,z:3450,level:0};expect(check().atBank).toBe(false);after.position={x:2946,z:3368,level:0};
 const cash=(questSweepChecks('doric-no-cash',doricSave(362),after,log,{id:'doric-no-cash',exit:1,timedOut:false,saveMatched:true,seconds:1}) as Record<string,boolean>);
 expect(cash.entry).toBe(false);
});


// Scorpion fixture: Varrock entry, worn gear, a staged bank, then varp 76=6, 77=2, one QP, the keys, 28 arrows
// in the worn ammunition slot, one lobster eaten and one observed antipoison dose.
const WORN=[[0,1169],[2,552],[3,861],[4,1131],[7,1097],[9,1063]].map(([slot,id])=>({slot:slot!,id:id!,count:1}));
const scorpionSave=():Parameters<typeof questSweepChecks>[1]=>({version:10,position:{x:3185,z:3436,level:0},vars:{76:0,77:0,101:0},
 inventories:{93:[],94:structuredClone(WORN),95:[[995,268],[563,8],[556,31],[555,5],[554,1],[882,40],[379,4],[175,1]].map(([id,count],slot)=>({slot,id:id!,count:count!}))},
 skills:Array.from({length:21},(_,index)=>({index,rawExperience:index===3?400000:0,xp:index===3?40000:0,level:index===3?69:1}))});
const SCORPION_WITHDRAW_ANTIPOISON='QUEST_SWEEP_WITHDRAW {"id":175,"count":1,"before":0,"after":1,"bankBefore":1,"bankAfter":0,"observed":true}\n';
const SCORPION_DOSE='SCORP_ANTIPOISON {"item":175,"next":177,"slot":6,"observed":true}\n';
const SCORPION_LOG='START 3185 3436 0\n'
 +'QUEST_SWEEP_WITHDRAW {"id":563,"count":3,"before":0,"after":3,"bankBefore":8,"bankAfter":5,"observed":true}\n'
 +'QUEST_SWEEP_WITHDRAW {"id":563,"count":5,"before":3,"after":8,"bankBefore":5,"bankAfter":0,"observed":true}\n'
 +SCORPION_WITHDRAW_ANTIPOISON
 +'MILESTONE complete 2153\nMILESTONE scorpion b 2160\n'
 +'SCORP_JAILER {"ok":true,"methods":["ranged"],"ticks":34}\nMILESTONE jail key 2500\n'
 +SCORPION_DOSE+'MILESTONE scorpion a 2650\nMILESTONE scorpion c 2720\n'
 +'QUEST_SWEEP_FLAG {"id":7373,"name":"Scorpion Catcher","state":"complete"}\nLOGOUT logged-out\n'
 +'RESULT ok qp=1 questMsg=true  xp=strength=165625 ticks=2771 hpMin=48 eats=1 died=false\n';
test('Scorpion saved effects use pinned completion 6, eight staged Law runes and reconciled pack, bank and worn ammunition',()=>{
 const before=scorpionSave(),after=structuredClone(before);
 after.position={x:2699,z:3403,level:3};after.vars={76:6,77:2,101:1};
 after.inventories={93:[[379,3],[555,2],[556,9],[563,2],[1590,1],[1591,1],[177,1]].map(([id,count],slot)=>({slot,id:id!,count:count!})),94:[...structuredClone(WORN),{slot:13,id:882,count:28}],95:[]};
 for(const [i,d] of [[2,1656250],[3,15525],[4,47000],[6,72500]] as const)after.skills[i]!.rawExperience+=d;
 const record={id:'scorpion-ranged-barcrawl',exit:0,timedOut:false,saveMatched:true,seconds:1};
 const check=(text=SCORPION_LOG):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(SCORPION_LOG.replace('["ranged"]','["melee"]')).jailer).toBe(false);
 expect(check(SCORPION_LOG.replace(SCORPION_WITHDRAW_ANTIPOISON,''))).toMatchObject({antipoison:false,assets:true});
 for(const text of [
  SCORPION_LOG.replace(SCORPION_DOSE,''),
  SCORPION_LOG.replace('"item":175,"next":177','"item":175,"next":179'),
  SCORPION_LOG.replace('"slot":6,"observed":true','"slot":6,"observed":false'),
  SCORPION_LOG.replace('"slot":6,"observed":true','"slot":28,"observed":true'),
  SCORPION_LOG.replace('"item":175,"next":177','"item":2448,"next":181'),
  SCORPION_LOG.replace(SCORPION_DOSE,SCORPION_DOSE+SCORPION_DOSE),
 ])expect(check(text)).toMatchObject({antipoison:false,assets:false});
 for(const k of ['a','b','c'])expect(check(SCORPION_LOG.replace(new RegExp(`^MILESTONE scorpion ${k} .*\\n`,'m'),'' )).catches).toBe(false);
 before.vars[102]=-5;expect(check().entry).toBe(false);before.vars[102]=0;
 const potion=after.inventories[93]!.find(i=>i.id===177)!;
 const full=SCORPION_LOG.replace(SCORPION_DOSE,SCORPION_DOSE+'SCORP_ANTIPOISON {"item":177,"next":179,"slot":6,"observed":true}\nSCORP_ANTIPOISON {"item":179,"next":229,"slot":6,"observed":true}\n');
 potion.id=229;expect(Object.values(check(full)).every(Boolean)).toBe(true);
 expect(check(full.replace('"item":177,"next":179,"slot":6','"item":177,"next":179,"slot":7'))).toMatchObject({antipoison:false,assets:false});
 potion.count=2;expect(check(full).assets).toBe(false);potion.count=1;potion.id=177;
 // Varp 100 is not the pinned completion; a missing QP fails.
 after.vars[76]=100;expect(check().quest).toBe(false);after.vars[76]=6;
 after.vars[101]=0;expect(check().quest).toBe(false);after.vars[101]=1;
 // A single 8-rune withdrawal and the observed 3+5 both stage eight; seven do not.
 expect(check(SCORPION_LOG.replace('"count":5,"before":3,"after":8','"count":4,"before":3,"after":7')).staged).toBe(false);
 // Any combat consumption inside the staged supply passes; a gain, an unreported meal or a lost gear row fails.
 const ammo=after.inventories[94]!.find(i=>i.slot===13)!;
 ammo.count=40;expect(check().assets).toBe(true);ammo.count=41;expect(check().assets).toBe(false);ammo.count=28;
 after.inventories[93]!.find(i=>i.id===379)!.count=2;expect(check().assets).toBe(false);
 expect(check(SCORPION_LOG.replace('eats=1','eats=2')).assets).toBe(true);after.inventories[93]!.find(i=>i.id===379)!.count=3;
 after.inventories[94]=after.inventories[94]!.filter(i=>i.id!==1169);expect(check().assets).toBe(false);after.inventories[94]!.unshift({slot:0,id:1169,count:1});
 after.inventories[93]!.push({slot:9,id:456,count:1});expect(check().assets).toBe(false);after.inventories[93]!.pop();
 after.inventories[93]!.find(i=>i.id===563)!.count=3;expect(check().assets).toBe(true);
 after.inventories[93]!.find(i=>i.id===563)!.count=9;expect(check().assets).toBe(false);after.inventories[93]!.find(i=>i.id===563)!.count=2;
 after.inventories[93]!.push({slot:10,id:995,count:1});expect(check().assets).toBe(false);after.inventories[93]!.pop();
 // The reward and combat XP stay; an unrelated skill change or a short reward fails.
 after.skills[2]!.rawExperience-=1;expect(check().reward).toBe(false);after.skills[2]!.rawExperience+=1;
 after.skills[10]!.rawExperience+=10;expect(check().unrelatedXp).toBe(false);after.skills[10]!.rawExperience-=10;
 before.skills[3]!.level=10;expect(check().entryHp).toBe(false);before.skills[3]!.level=69;
 expect(Object.values(check()).every(Boolean)).toBe(true);
});
test('selected Scorpion melee proof requires only the blade kit, a melee Jailer drop, combat XP and the useful quest effect',()=>{
 const before=scorpionSave();
 before.position={x:2655,z:3283,level:0};
 before.skills[2]!.level=65;
 before.inventories[94]!.find(i=>i.slot===3)!.id=1333;
 before.inventories[95]=before.inventories[95]!.filter(i=>i.id!==882&&i.id!==175);
 before.inventories[95]!.find(i=>i.id===995)!.count=1292;
 const after=structuredClone(before);
 after.position={x:2699,z:3403,level:3};after.vars={76:6,77:2,101:1};
 after.inventories={93:[[379,3],[555,2],[556,9],[563,2],[1590,1],[1591,1],[177,1]].map(([id,count],slot)=>({slot,id:id!,count:count!})),94:structuredClone(before.inventories[94]!),95:[]};
 for(const [i,d] of [[0,47000],[2,1656250],[3,15525],[6,72500]] as const)after.skills[i]!.rawExperience+=d;
 const buy='QUEST_SWEEP_BUY {"item":175,"name":"Antipoison(3)","count":1,"npc":"Jiminua","before":0,"after":1,"coinsBefore":1292,"coins":328}\n';
 const travel='QUEST_SWEEP_TRAVEL_COST {"phase":"shop","item":175,"coinsBefore":328,"coins":298,"observed":true}\n'
  +'QUEST_SWEEP_TRAVEL_COST {"phase":"start","coinsBefore":298,"coins":268,"observed":true}\n';
 const boats='QUEST_SWEEP_BOAT {"id":"npc:captain_barnaby:brimhaven@2679,3275","coins":30}\n'
  +'QUEST_SWEEP_BOAT {"id":"npc:customs_officer:ardougne@2772,3231","coins":30}\n';
 const log=SCORPION_LOG.replace('START 3185 3436 0','START 2655 3283 0').replace('["ranged"]','["melee"]').replace(SCORPION_WITHDRAW_ANTIPOISON,buy+travel+boats);
 const record={id:'scorpion-barcrawl',exit:0,timedOut:false,saveMatched:true,seconds:1};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 for(const text of [
  log.replace(buy,''),
  log.replace('"coinsBefore":1292,"coins":328','"coinsBefore":1292,"coins":1292'),
  log.replace('"coinsBefore":1292,"coins":328','"coinsBefore":1292,"coins":327'),
  log.replace('"before":0,"after":1,"coinsBefore":1292','"before":0,"after":2,"coinsBefore":1292'),
  log.replace(buy,buy+buy),
  log.replace('"phase":"shop","item":175','"phase":"shop","item":177'),
  log.replace('"phase":"start","coinsBefore":298,"coins":268','"phase":"start","coinsBefore":298,"coins":267'),
  log.replace(travel,travel+travel),
 ])expect(check(text)).toMatchObject({antipoison:false,assets:false});
 // Explicit boat records and snapshots describe the same debit, and each path reconciles it once.
 expect(Object.values(check(log.replace(travel,''))).every(Boolean)).toBe(true);
 expect(Object.values(check(log.replace(boats,''))).every(Boolean)).toBe(true);
 expect(check(log.replace(travel,'').replace(boats,''))).toMatchObject({antipoison:true,assets:false});
 expect(check(log.replace('"coins":30','"coins":31'))).toMatchObject({antipoison:false,assets:false});
 expect(check(log.replace('npc:captain_barnaby:brimhaven@2679,3275','npc:unknown'))).toMatchObject({antipoison:false,assets:false});
 // A bow, any ammunition, a strike rune, a staff or a noted blade must not supply an alternate method.
 for(const id of [861,882,884,558,562,1387,1334]){
  before.inventories[93]!.push({slot:0,id,count:1});
  expect(check().kit).toBe(false);before.inventories[93]!.pop();
 }
 const weapon=after.inventories[94]!.find(i=>i.slot===3)!;
 weapon.id=1334;expect(check()).toMatchObject({kit:false,assets:false});weapon.id=1333;
 weapon.slot=5;expect(check().kit).toBe(false);weapon.slot=3;
 const key=after.inventories[93]!.find(i=>i.id===1591)!;
 key.count=0;expect(check().jailer).toBe(false);key.count=1;
 for(const text of [
  log.replace(/^SCORP_JAILER .*\n/m,''),
  log.replace('"ok":true,"methods"','"ok":false,"methods"'),
  log.replace('["melee"]','["ranged"]'),
  log.replace('["melee"]','["magic"]'),
  log.replace('["melee"]','["melee","ranged"]'),
  log.replace(/^MILESTONE jail key .*\n/m,''),
  log+'SCORP_JAILER {"ok":true,"methods":["melee"],"ticks":34}\n',
 ])expect(check(text).jailer).toBe(false);
 after.skills[0]!.rawExperience-=47000;expect(check().combatXp).toBe(false);after.skills[0]!.rawExperience+=47000;
 after.skills[4]!.rawExperience++;expect(check().combatXp).toBe(false);after.skills[4]!.rawExperience--;
 after.vars[76]=100;expect(check().quest).toBe(false);after.vars[76]=6;
 after.vars[101]=0;expect(check().quest).toBe(false);after.vars[101]=1;
 expect(check(log.replace('LOGOUT logged-out\n','')).logout).toBe(false);
 expect(Object.values(check()).every(Boolean)).toBe(true);
});
test('a completed Scorpion entry refuses before the bank and keeps the save unchanged',()=>{
 const before=scorpionSave();before.vars={76:6,77:0,101:1};before.inventories[95]=[];
 const after=structuredClone(before);
 const log='START 3185 3436 0\nLOGOUT logged-out\nRESULT fail quest-sweep scorpion invalid entry: Scorpion Catcher is complete\n';
 const record={id:'scorpion-complete-refusal',exit:1,timedOut:false,saveMatched:true,seconds:1};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 // A bank walk or a missing-supply result means the guard staged before it refused.
 expect(check(log.replace('LOGOUT','QUEST_SWEEP_BANK {"from":{}}\nLOGOUT')).noInput).toBe(false);
 expect(check(log.replace('LOGOUT',SCORPION_DOSE+'LOGOUT')).noInput).toBe(false);
 expect(check(log.replace('Scorpion Catcher is complete','missing 995:592 to buy 563,556')).result).toBe(false);
 before.vars[76]=100;expect(check().entry).toBe(false);
});
test('explicit --case selection picks named cases, keeps the full default and refuses unknown selections',()=>{
 expect(selectQuestSweepProofCases([])).toEqual([...QUEST_SWEEP_PROOF_CASE_IDS]);
 expect(selectQuestSweepProofCases(['--verify'])).toEqual([...QUEST_SWEEP_PROOF_CASE_IDS]);
 expect(selectQuestSweepProofCases(['--verify','--case=scorpion-complete-refusal','--case=scorpion-barcrawl'])).toEqual(['scorpion-barcrawl','scorpion-ranged-barcrawl','scorpion-complete-refusal']);
 expect(selectQuestSweepProofCases(['--case=scorpion-barcrawl'])).toEqual(['scorpion-barcrawl','scorpion-ranged-barcrawl']);
 expect(selectQuestSweepProofCases(['--case=scorpion-ranged-barcrawl'])).toEqual(['scorpion-ranged-barcrawl']);
 expect(selectQuestSweepProofCases(['--case=scorpion-barcrawl','--case=scorpion-ranged-barcrawl'])).toEqual(['scorpion-barcrawl','scorpion-ranged-barcrawl']);
 expect(()=>selectQuestSweepProofCases(['--case=scorpion'])).toThrow('unknown quest-sweep proof case scorpion');
 expect(()=>selectQuestSweepProofCases(['--case='])).toThrow('unknown quest-sweep proof case (empty)');
 expect(()=>selectQuestSweepProofCases(['--case','scorpion-barcrawl'])).toThrow('must be --case=<id>');
 expect(()=>selectQuestSweepProofCases(['--case=scorpion-barcrawl','--case=scorpion-barcrawl'])).toThrow('repeated');
 const source=readFileSync(new URL('../src/quest-sweep-proof.ts',import.meta.url),'utf8');
 expect(source).toContain('.filter(c=>selected.includes(c.id))');
 expect(source).toContain('missing retained evidence');
});

test('the proof keeps the current cases and real parameterized CLI without the archived suite',()=>{
 const ids:string[]=[...QUEST_SWEEP_PROOF_CASE_IDS];
 expect(ids.sort()).toEqual(['scorpion-barcrawl','scorpion-ranged-barcrawl','scorpion-complete-refusal','ball-worn-kit','ball-missing-gloves','bank-stage','doric-self-supply','doric-no-cash','retained-ghost','banked-ghost','fishing-stage','clock-stage','ernest-fortress','vampire-started','totem-started-cakes','hunt-crowded','rj-pirate-letter','rj-pirate-started','elena-heckel-dust','blackknight-finish','imp-surplus-beads','fluffs-yard-exit'].sort());
 expect(new Set(QUEST_SWEEP_PROOF_CASE_IDS).size).toBe(22);
 const p=questSweepProofEndpoints({engine:22100,gateway:22101,management:22102,tcp:22103},'quest-sweep-12345678901234567890');
 const child=questSweepChildConfiguration('ordinary','rj',p,{CAP:'6000'});
 expect(child.cmd).toEqual(['bun','scripts/quest-sweep.ts','ordinary','rj']);
 expect(child.env).toMatchObject({CAP:'6000',RANDOM_EVENTS:'0',GATEWAY_URL:p.gateway});
 expect(child.windowsHide).toBe(true);
 // Exact asset checks exclude incidental pickup even when the parent enables loot.
 const looted=questSweepChildConfiguration('ordinary','scorpion',p,{CAP:'6000',LOOT_WATCH:'1',RANDOM_EVENTS:'1'});
 expect(looted.env).toMatchObject({CAP:'6000',LOOT_WATCH:'0',RANDOM_EVENTS:'0'});
 const source=readFileSync(new URL('../src/quest-sweep-proof.ts',import.meta.url),'utf8');
 expect(source).toContain("...(doricRefused?[]:[{id:995,count:362}])");
 expect(source).toContain('scorpion&&!scorpionRefused||fluffs||ball||rj||hunt?5400000');
 expect(source).toContain("long=scorpion||fluffs||");
 expect(source).toContain("{id:'fluffs-yard-exit',quest:'fluffs',bank:[]}");
 expect(source).toContain("{id:'scorpion-barcrawl',quest:'scorpion'");
 expect(source).toContain("{id:'scorpion-ranged-barcrawl',quest:'scorpion'");
 expect(source).not.toContain("quest:'prince'");
});

test('Gertrude\'s Cat yard exit requires the varp-5 entry, the fence exit, completion, exact rewards and logout',()=>{
 const before=doricSave(25);before.position={x:3296,z:3497,level:0};before.vars={180:5,101:0};
 before.inventories={93:[{slot:0,id:995,count:25}]};
 const after=structuredClone(before);after.position={x:3151,z:3411,level:0};after.vars={180:6,101:1};
 after.inventories={93:[{slot:0,id:995,count:25},{slot:1,id:1897,count:1},{slot:2,id:2003,count:1}]};
 after.skills[7]={index:7,rawExperience:381250,xp:38125,level:50};
 const log=`START 3296 3497 0
QUEST_SWEEP_FLUFFS_RESUME {"state":"started","position":{"x":3296,"z":3497,"level":0}}
MILESTONE 5 3
QUEST_FLUFFS_YARD_EXIT {"fence":{"id":2618,"x":3305,"z":3493},"from":{"x":3296,"z":3497,"level":0},"at":{"x":3305,"z":3492,"level":0}}
QUEST_TELEPORT_WALK {"label":"varrock teleport","to":{"x":3212,"z":3424},"ok":true}
QUEST_SWEEP_FLAG {"name":"Gertrude's Cat","state":"complete"}
MILESTONE 6 300
RESULT ok qp=1  xp=cooking=38125 eats=0 died=false
LOGOUT logged-out
`;
 const record={id:'fluffs-yard-exit',exit:0,timedOut:false,saveMatched:true,seconds:1};
 const check=(text=log):Record<string,boolean>=>questSweepChecks(record.id,before,after,text,record);
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log.replace('"z":3492','"z":3493')).yardExit).toBe(false);
 expect(check(log.replace(/^QUEST_FLUFFS_YARD_EXIT .*\n/m,'')).yardExit).toBe(false);
 expect(check(log.replace('MILESTONE 5 3','MILESTONE 1 3')).resumed).toBe(false);
 expect(check(log.replace(/^QUEST_SWEEP_FLUFFS_RESUME .*\n/m,'')).resumed).toBe(false);
 expect(check(log+'QUEST_SWEEP_BANK {}\n').budget).toBe(false);
 expect(check(log.replace('"complete"','"started"')).questList).toBe(false);
 expect(check(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 expect(check(log.replace('RESULT ok','RESULT fail')).result).toBe(false);
 after.vars[180]=5;expect(check().quest).toBe(false);after.vars[180]=6;
 after.vars[101]=0;expect(check().quest).toBe(false);after.vars[101]=1;
 after.inventories[93]!.pop();expect(check().assets).toBe(false);after.inventories[93]!.push({slot:2,id:2003,count:1});
 after.inventories[93]![0]!.count--;expect(check().assets).toBe(false);after.inventories[93]![0]!.count++;
 after.skills[7]!.rawExperience--;expect(check().reward).toBe(false);after.skills[7]!.rawExperience++;
 after.skills[6]!.rawExperience++;expect(check().unrelatedXp).toBe(false);after.skills[6]!.rawExperience--;
 after.position.x=3296;after.position.z=3497;expect(check().location).toBe(false);after.position.x=3151;after.position.z=3411;
 before.vars[180]=4;expect(check().entry).toBe(false);before.vars[180]=5;
 before.skills[6]!.level=25;expect(check().entry).toBe(false);before.skills[6]!.level=1;
 record.exit=1;expect(check().child).toBe(false);record.exit=0;
 expect(Object.values(check()).every(Boolean)).toBe(true);
});

test('Black Knight accepts the observed level-2 room tile and rejects wrong floors, distance, rewards and logout',()=>{
 const before=doricSave(490);before.position={x:3016,z:3512,level:0};before.vars={130:3,101:12};
 const after=structuredClone(before);after.position={x:2961,z:3340,level:2};after.vars={130:4,101:15};after.inventories[93]![0]!.count+=2500;
 const log=`START 3016 3512 0
QUEST_SWEEP_FLAG {"name":"Black Knight's Fortress","state":"complete"}
LOGOUT logged-out
RESULT ok quest-sweep blackknight quest complete qp=3
`;
 const check=(text=log):Record<string,boolean>=>questSweepChecks('blackknight-finish',before,after,text,{id:'blackknight-finish',exit:0,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 after.position.level=1;expect(check().location).toBe(false);after.position.level=2;
 after.position.z=3341;expect(check().location).toBe(false);after.position.z=3340;
 after.inventories[93]![0]!.count--;expect(check()).toMatchObject({assets:false,reward:false});after.inventories[93]![0]!.count++;
 after.vars[101]=14;expect(check().quest).toBe(false);after.vars[101]=15;
 after.vars[130]=3;expect(check().quest).toBe(false);after.vars[130]=4;
 expect(check(log.replace('LOGOUT logged-out','')).logout).toBe(false);
});

test('Pirate plantation proof reconciles banked bananas, 24 cake bites and exact reward assets',()=>{
 const before=doricSave(402);before.position={x:2907,z:3147,level:0};before.vars={71:0,101:2};
 before.skills[0]!.level=55;before.skills[3]!.level=40;
 const pack=[{id:995,count:402},{id:1925,count:1},{id:555,count:2},...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},...Array.from({length:2},()=>({id:1895,count:1})),...Array.from({length:5},()=>({id:373,count:1})),{id:952,count:1},{id:556,count:6},...Array.from({length:7},()=>({id:1963,count:1}))];
 before.inventories={93:pack.map((row,slot)=>({...row,slot})),95:[{slot:0,id:995,count:183752},{slot:1,id:1891,count:7}]};
 const after=structuredClone(before);after.position={x:2999,z:3383,level:0};after.vars={71:4,101:4};
 after.inventories={93:[995,433,555,1635,1605,952,556].map((id,slot)=>({id,slot,count:id===995?760:id===555?2:id===556?6:1})),94:[{slot:4,id:1005,count:1}],95:[...structuredClone(before.inventories[95]!),...[1925,1893,1895,373,1963].map((id,i)=>({id,slot:i+2,count:id===1895?2:id===373?5:id===1963?7:1}))]};
 const milestones=['job','karamja','rum','bananas','shipped','sarim','rum back'].map(step=>`MILESTONE ${step} 1`).join('\n');
 const log=`START 2907 3147 0
QUEST_SWEEP_DEPOSIT {"id":1963,"count":7,"success":true}
QUEST_SWEEP_BANK_PASS {"withdraw":[],"slots":16,"free":16}
QUEST_SWEEP_CAPACITY {"required":1,"free":16}
QUEST_SWEEP_BUY {"item":1005,"npc":"Thessalia","count":1,"before":0,"after":1,"coinsBefore":372,"coins":370}
${milestones}
QUEST_SWEEP_FLAG {"name":"Pirate's Treasure","state":"complete"}
RESULT ok qp=2 eats=24
LOGOUT logged-out
`;
 const check=(text=log):Record<string,boolean>=>questSweepChecks('hunt-crowded',before,after,text,{id:'hunt-crowded',exit:0,timedOut:false,saveMatched:true,seconds:1});
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 for(const item of [995,1891,1963,433,1635,1605]){
  const row=Object.values(after.inventories).flat().find(row=>row.id===item)!;
  row.count--;expect(check().assets).toBe(false);row.count++;
 }
 expect(check(log.replace('eats=24','eats=23'))).toMatchObject({budget:true,assets:false});
 expect(check(log.replace('eats=24','eats=25'))).toMatchObject({budget:false,assets:false});
 expect(check(log.replace('eats=24','eats=0'))).toMatchObject({budget:true,assets:false});
 expect(check(log.replace('MILESTONE bananas 1','')).bananas).toBe(false);
 expect(check(log+'QUEST_SWEEP_BUY {"item":1963}\n').bananas).toBe(false);
 expect(check(log.replace('"free":16','"free":11')).capacity).toBe(false);
 expect(check(log.replace('LOGOUT logged-out','')).logout).toBe(false);
 after.inventories[93]!.push({id:1963,slot:7,count:1});after.inventories[95]!.find(i=>i.id===1963)!.count--;
 expect(check()).toMatchObject({assets:true,questItems:false});
 after.inventories[94]![0]!.id=1007;expect(check().assets).toBe(false);
 after.inventories[94]![0]!.id=1005;after.inventories[93]!.pop();after.inventories[95]!.find(i=>i.id===1963)!.count++;
 expect(Object.entries(check()).filter(([,ok])=>!ok)).toEqual([]);
 // Less damage: 16 bites eaten leave one cake (3), two 2/3 cakes (4) and one slice (1) from the eight carried cakes.
 const leftover=[1891,1893,1893,1895].map((id,i)=>({id,slot:7+i,count:1}));
 after.inventories[93]!.push(...leftover);
 const ate16=log.replace('eats=24','eats=16');
 expect(Object.entries(check(ate16)).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(log.replace('eats=24','eats=15')).assets).toBe(false);
 expect(check(log.replace('eats=24','eats=17')).assets).toBe(false);
 expect(check()).toMatchObject({budget:true,assets:false});
 leftover[3]!.id=1893;expect(check(log.replace('eats=24','eats=15')).assets).toBe(true);
 leftover[3]!.id=1895;leftover[3]!.count=6;expect(check(log.replace('eats=24','eats=11')).assets).toBe(false);
 leftover[3]!.count=1;leftover[0]!.count=2;expect(check(log.replace('eats=24','eats=13')).assets).toBe(true);
 leftover[0]!.count=1;leftover[1]!.id=995;expect(check(ate16).assets).toBe(false);
 // No damage: zero bites eaten leave all eight carried cakes, and the proof passes.
 after.inventories[93]!.splice(-leftover.length);
 after.inventories[93]!.push(...Array.from({length:8},(_,i)=>({id:1891,slot:7+i,count:1})));
 const ate0=log.replace('eats=24','eats=0');
 expect(Object.entries(check(ate0)).filter(([,ok])=>!ok)).toEqual([]);
 expect(check(ate0.replace('RESULT ok','QUEST_SWEEP_FARE {"coins":30}\nRESULT ok')).budget).toBe(false);
 expect(check(log.replace('eats=24','eats=25'))).toMatchObject({budget:false,assets:false});
 expect(check(log.replace('eats=24','eats=1')).assets).toBe(false);
});

test('burst page recorder joins multi-line chat pages across components, resets on repeat or layer switch, and skips non-chat layers',()=>{
 const pages:string[]=[];
 const record=createBurstPageRecorder(new Set([4882,4887]),text=>pages.push(text));
 record(1,9999,'Side panel text');
 expect(pages).toEqual([]);
 record(4884,4882,'Father Urhney');
 record(4885,4882,'is an expert');
 expect(pages.some(p=>/father urhney is an expert/i.test(p))).toBe(true);
 // Repeating a component id on the same chat layer starts a fresh page instead of concatenating onto the old page.
 record(4884,4882,'I can go and knock some sense');
 record(4885,4882,'into them before a full blown war breaks out.');
 expect(pages[pages.length-1]).toBe('I can go and knock some sense into them before a full blown war breaks out.');
 expect(pages.some(p=>/knock some sense.*full blown war/i.test(p))).toBe(true);
 expect(pages[pages.length-1]).not.toContain('Father Urhney');
 // Switching chat layers also starts a fresh page.
 record(4889,4887,'Another chat root line');
 expect(pages[pages.length-1]).toBe('Another chat root line');
});
