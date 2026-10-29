// Local practice only. Each mode runs one bot at a time and keeps raw outputs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { startStack } from '../../packages/practice/src/stack';
import { proveInProcess, realInProcessDeps } from '../../packages/practice/src/prove';
import { applyPreset, type SaveConfig } from '../../packages/practice/src/presets';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import { createBot } from '../../packages/practice/src/bots';
const mode=process.argv[2]??'ore', runs=Number(process.argv[3]??3);
const oakMode=mode==='wood-oak';
const bigchopper=oakMode?JSON.parse(readFileSync('.practice/status/Bigchopper.json','utf8')):null;
const waterfallMode=mode.startsWith('waterfall');
const mighty=waterfallMode?JSON.parse(readFileSync('.practice/status/Mightyrod.json','utf8')):null;
const cowMode=mode.startsWith('cow');
const toolMode=mode==='ore-tools';
const toolOrder=[1265,1271,1271,1265,1265,1271];let toolIndex=0;
const woolMode=mode.startsWith('wool');
const flaxMode=mode.startsWith('flax');
const headlessMode=mode.startsWith('headless');
const steelMode=mode==='steel';
const oakBowsMode=mode==='oak-bows';
const buyerPlans:Record<string,{names:string[];target:number;maxItems:number;required?:Record<string,number>;float?:number;maxSpend?:number}>= {
 aubury:{names:['Chaos rune','Death rune','Air rune','Fire rune','Water rune','Earth rune','Mind rune','Body rune'],target:20,maxItems:160,float:15000,maxSpend:10000},
 zeke:{names:['Mithril scimitar','Steel scimitar','Iron scimitar','Bronze scimitar'],target:1,maxItems:4,float:15000,maxSpend:10000},
 betty:{names:['Fire rune','Chaos rune','Death rune','Eye of newt','Air rune','Water rune','Earth rune','Mind rune','Body rune'],target:20,maxItems:180},
 catherby:{names:['Steel arrowtips','Mithril arrowtips','Adamant arrowtips','Rune arrowtips'],target:20,maxItems:80},
 sarim:{names:['Feather','Fishing bait','Harpoon','Lobster pot'],target:500,maxItems:1004,required:{Harpoon:2,'Lobster pot':2}},
};
const profileKey=mode==='aubury-shop'?'aubury':mode==='zeke-shop'?'zeke':mode==='betty-met'?'betty':mode==='catherby-bank'?'catherby':mode;
const buyerPlan=buyerPlans[profileKey];
// Actual post-shears-purchase Ballspinner kit, including the otherwise-wasted coin slot.
const starterKit=[[1351,1],[590,1],[303,1],[315,1],[1925,1],[1931,1],[2309,1],[1265,1],[1205,1],[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[555,6],[557,4],[559,2],[995,5],[1735,1]].map(([id,count])=>({id:id!,count:count!}));
const magic=mode==='aubury-entry'?JSON.parse(readFileSync('.practice/status/Abracadickra.json','utf8')):null;
const relocated=mode==='aubury-shop'?JSON.parse(readFileSync('.practice/fleet-proof/aubury-entry-flaubuxabk01-snapshot.json','utf8')).result:null;
const presets: Record<string, SaveConfig> = {
 'aubury-shop': {position:{x:3253,z:3420,level:0},inventory:relocated?.inventory??[],bank:relocated?.bank??[]},
 'zeke-entry': {position:{x:3092,z:3243,level:0},coins:19028,inventory:[{id:315,count:1},{id:2309,count:1}]},
 'zeke-shop': {position:{x:3269,z:3167,level:0},coins:19028,inventory:[{id:315,count:1},{id:2309,count:1}]},
 'aubury-entry': {position:{x:3092,z:3243,level:0},inventory:magic?.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))??[],bank:magic?.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count}))??[]},
 'ore-regression': {position:{x:3286,z:3368,level:0},inventory:[{id:1265,count:1},{id:315,count:1},{id:2309,count:1},{id:436,count:1},{id:436,count:1},{id:436,count:1},{id:438,count:1},{id:438,count:1}]},
 ore: {position:{x:3286,z:3368,level:0}, inventory:[{id:1265,count:1}]},
 'wool-starter': {position:{x:3209,z:3220,level:2},skills:{Thieving:5},inventory:starterKit},
 wool: {position:{x:3207,z:3218,level:2},inventory:[{id:1735,count:1}]},
 catherby: {position:{x:2613,z:3294,level:0},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:20000}]},
 sarim: {position:{x:3092,z:3243,level:0},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:20000}]},
 'wood-oak': {position:{x:3092,z:3242,level:0},skills:oakMode?Object.fromEntries(bigchopper.skills.map((s:{name:string;level:number})=>[s.name,s.level])):{},inventory:oakMode?bigchopper.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})):[],bank:oakMode?bigchopper.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count})):[]},
 'waterfall-hudon': {position:{x:2519,z:3427,level:1},skills:waterfallMode?Object.fromEntries(mighty.skills.map((s:{name:string;level:number})=>[s.name,s.level])):{},inventory:waterfallMode?mighty.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})):[],bank:waterfallMode?mighty.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count})):[],varps:{65:1}},
 'waterfall-mighty': {position:{x:2654,z:3283,level:0},skills:waterfallMode?Object.fromEntries(mighty.skills.map((s:{name:string;level:number})=>[s.name,s.level])):{},inventory:waterfallMode?mighty.inventory.map((i:{id:number;count:number})=>({id:i.id,count:i.count})):[],bank:waterfallMode?[...mighty.bank.map((i:{id:number;count:number})=>({id:i.id,count:i.count})),{id:954,count:2},{id:556,count:6},{id:557,count:6},{id:555,count:6}]:[],varps:{65:0}},
 'ore-tools': {position:{x:3286,z:3368,level:0},skills:{Mining:31,Hitpoints:10},coins:200,inventory:[{id:1265,count:1},{id:315,count:1},{id:2309,count:1}]},
 clay: {position:{x:3185,z:3436,level:0},skills:{Mining:1,Hitpoints:10},coins:200,inventory:[{id:1265,count:1},{id:1925,count:1},{id:315,count:1},{id:2309,count:1}]},
 cow: {position:{x:2654,z:3283,level:0},skills:{Attack:1,Defence:1,Strength:1,Hitpoints:10},coins:200,inventory:[{id:1277,count:1},{id:1171,count:1},{id:333,count:1},{id:333,count:1}],bank:[{id:333,count:5}]},
 'smelt-bronze': {position:{x:3269,z:3167,level:0},skills:{Smithing:1},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:436,count:10},{id:438,count:9}]},
 'payout-notes': {position:{x:2727,z:3492,level:0},inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1779,count:750}]},
 'oak-bows': {position:{x:3092,z:3243,level:0},skills:{Fletching:25},coins:200,inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1521,count:50},{id:1777,count:556},{id:845,count:7}]},
 steel: {position:{x:2654,z:3283,level:0},skills:{Fletching:32},coins:200,inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:53,count:390},{id:41,count:20}]},
 'headless-one': {position:{x:2654,z:3283,level:0},skills:{Fletching:1},coins:200,inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:52,count:720},{id:314,count:500}]},
 headless: {position:{x:2654,z:3283,level:0},skills:{Fletching:32},coins:200,inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:52,count:720},{id:314,count:500}]},
 'cook-badpoint': {position:{x:3099,z:3256,level:0},skills:{Cooking:99},coins:200,inventory:[{id:309,count:1},{id:946,count:1},{id:1511,count:1},{id:1511,count:1},{id:314,count:100},{id:2140,count:1},{id:2140,count:1}],bank:[{id:335,count:80},{id:331,count:80},{id:2140,count:133}]},
 'seers-entry': {position:{x:2654,z:3283,level:0},skills:{Crafting:13},inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1737,count:40},{id:1759,count:25}]},
 homeward: {position:{x:3092,z:3243,level:0},skills:{Crafting:13},coins:200,inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:30},{id:1737,count:40},{id:1759,count:25}]},
 outbound: {position:{x:2654,z:3283,level:0},coins:20380,inventory:[{id:315,count:1},{id:2309,count:1}]},
 'betty-met': {position:{x:3092,z:3243,level:0},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:20000},...[554,555,556,557,558,559,560,562,221].map(id=>({id,count:20}))]},
 'catherby-bank': {position:{x:2809,z:3441,level:0},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:20000}]},
 betty: {position:{x:3092,z:3243,level:0},inventory:[{id:946,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:995,count:20000}]},
 'flax-notes': {position:{x:2727,z:3492,level:0},skills:{Crafting:13},inventory:[{id:1780,count:106},{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1737,count:40},{id:1759,count:25},{id:995,count:170}]},
 flax: {position:{x:2727,z:3492,level:0},skills:{Crafting:13},inventory:[{id:1735,count:1},{id:315,count:1},{id:2309,count:1}],bank:[{id:1779,count:106},{id:1737,count:40},{id:1759,count:25},{id:995,count:5}]},
 recovery: {position:{x:3222,z:3218,level:0},bank:[{id:995,count:25}]},
 wood: {position:{x:3092,z:3243,level:0},skills:{Woodcutting:99,Hitpoints:11},inventory:[{id:1349,count:1},{id:2309,count:1},{id:315,count:1}]},
 freshore: {position:{x:3222,z:3218,level:0},inventory:[{id:1265,count:1},{id:315,count:1},{id:2309,count:1}]},
};
let preset=mode==='cow-diag'?presets.cow:mode==='ore-no-iron'?presets.ore:presets[mode];
if(mode!=='fresh' && mode!=='entry' && !preset) throw new Error('unknown mode');
const dir=resolve('.practice/fleet-proof'); mkdirSync(dir,{recursive:true});
const script=waterfallMode?'generated/waterfall':cowMode?'gather-combat':mode==='smelt-bronze'?'smelt-bars':mode==='payout-notes'?'measure/fleet-payout-notes':mode==='seers-entry'?'measure/fleet-seers-entry':mode==='zeke-entry'?'measure/fleet-al-kharid-entry':mode==='aubury-entry'?'measure/fleet-relocate':headlessMode||steelMode||oakBowsMode?'fletch-arrows':mode==='cook-badpoint'?'cook-stock':mode==='entry'?'arrive-draynor':(mode==='outbound'||mode==='homeward')?'foodcourier':buyerPlan?'shop-buyer':woolMode?'collect-wool':flaxMode?'spin-bowstrings':mode==='wood'||oakMode?'gather-yews':'gather-ore';
const stack=process.env.REUSE_STACK==='1'?null:await startStack();
try {
 const report=await proveInProcess({bot:'fl'+mode.slice(0,5),script:resolve('scripts',script+'.ts'),runs,timeoutMs:oakBowsMode?450000:oakMode?600000:mode==='waterfall-hudon'?720000:waterfallMode?360000:woolMode?360000:240000,pass:t=>/^RESULT ok/m.test(t) && (buyerPlan || oakMode || waterfallMode || toolMode || mode==='clay' || cowMode || mode==='smelt-bronze' || mode==='payout-notes' || mode==='ore-regression' || flaxMode || mode==='wool-starter' || mode==='entry' || (mode==='outbound'||mode==='homeward') || mode==='cook-badpoint' || headlessMode || steelMode || oakBowsMode || mode==='aubury-entry' || mode==='zeke-entry' || mode==='seers-entry' ? /PROOF_GATE.*ok=true/.test(t) : mode==='wool' ? /gathered=54 spun=27 rawBanked=27 trips=3 died=false/.test(t) : flaxMode ? /spunTotal=28\b/.test(t) : mode==='wood' ? /banked=2[5-8]\b/.test(t) && /hpMin=11\b/.test(t) : /banked=2[5-8]\b/.test(t))}, {
  ...realInProcessDeps,
  async prepare(name){
   const mon=JSON.parse(readFileSync('.practice/monitor.json','utf8'));
   if(mon.practiceBots>=6 || mon.freeGB<8) throw new Error('practice load gate');
   const startFloor=Number(process.env.PRACTICE_START_FLOOR_GB??9);if(!Number.isFinite(startFloor)||startFloor<9)throw new Error('invalid practice start floor');
   const free=Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{stdout:'pipe',stderr:'pipe',windowsHide:true}).stdout.toString().trim());
   if(!Number.isFinite(free) || free<startFloor)throw new Error(`practice freeRAM ${free}GB below${startFloor}GB startfloor`);
   console.log(`PROOF_RESOURCE bot=${name} freeGB=${free.toFixed(2)} reuseStack=${process.env.REUSE_STACK==='1'}`);
   if(toolMode){preset={...presets['ore-tools'],inventory:[{id:toolOrder[toolIndex++]!,count:1},{id:315,count:1},{id:2309,count:1}]};console.log(`PROOF_TOOL run=${toolIndex} pickaxe=${preset.inventory![0]!.id}`);}
   await createBot(name); if(mode!=='fresh' && mode!=='entry') {const path=await applyPreset(name,preset!);if(oakBowsMode)writeFileSync(resolve(dir,`${mode}-${name}-initial-save.json`),JSON.stringify(readPracticeSave(path),null,2));if(oakMode){setPracticeSkills(path,bigchopper.skills);writeFileSync(resolve(dir,`${mode}-${name}-initial-save.json`),JSON.stringify(readPracticeSave(path),null,2));}
   if(waterfallMode){setPracticeSkills(path,mighty.skills);const checked=readPracticeSave(path);if(!checked.skills.every((s,i)=>s.level===mighty.skills[i].level&&s.xp===mighty.skills[i].xp))throw new Error('generated exact skill save mismatch');writeFileSync(resolve(dir,`${mode}-${name}-initial-save.json`),JSON.stringify(readPracticeSave(path),null,2));}}
  },
  async run(script,bot,timeoutMs){
   if(mode==='ore-no-iron') {
    const original=readFileSync(script,'utf8');
    const injected=original.replace('[2092,2093]','[-1,-2]').replaceAll('../packages/',resolve('packages').replaceAll('\\','/')+'/');
    if(injected===original) throw new Error('iron fault injection not applied');
    script=resolve(dir,'ore-no-iron-injected.ts');
    writeFileSync(script,injected);
   }
   const proc=Bun.spawn(buyerPlan || oakMode || waterfallMode || toolMode || mode==='clay' || cowMode || mode==='smelt-bronze' || mode==='payout-notes' || mode==='ore-regression' || flaxMode || mode==='wool-starter' || mode==='entry' || (mode==='outbound'||mode==='homeward') || mode==='cook-badpoint' || headlessMode || steelMode || oakBowsMode || mode==='aubury-entry' || mode==='zeke-entry' || mode==='seers-entry'?['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),script,bot]:['bun',script,bot],{stdout:'pipe',stderr:'pipe',env:{...process.env,DEMO_OK:'',...(buyerPlan?{PROFILE:profileKey,STOCK_TARGET:String(buyerPlan.target),BANK_AT:'0',FLOAT:String(buyerPlan.float??20000),COIN_RESERVE:'5000',MAX_SPEND:String(buyerPlan.maxSpend??15000),MAX_ITEMS:String(buyerPlan.maxItems),STOP_AT_TARGET:'1',NO_BUY_TICKS:'25'}:{}),...((mode==='outbound'||mode==='homeward')?{OUTBOUND_ONLY:mode==='outbound'?'1':'',HOME_ONLY:mode==='homeward'?'1':'',START:'',FROM:'',FARMERS:'',FEATHERS:'0'}:{}),...(oakBowsMode?{MODE:'oak-bows',MAX_MAKE:'25',LOG_RESERVE:'25',STRING_RESERVE:'500'}:{}),...(steelMode?{MODE:'steel',MAX_MAKE:'15',HEADLESS_RESERVE:'200',TIP_RESERVE:'5',OUTPUT_RESERVE:'15'}:{}),...(headlessMode?{MODE:'headless',MAX_MAKE:'390',SHAFT_RESERVE:'200',FEATHER_RESERVE:'100'}:{}),...(mode==='cook-badpoint'?{COOK_ROUTE:'near',RAW_RESERVE:'50',MAX_COOK:'60',RANDOM_EVENTS:'0'}:{}),...(flaxMode?{MAX_MAKE:'56',RAW_RESERVE:'50'}:{}),...(oakMode?{PROOF_EXPECT_SKILLS:JSON.stringify(bigchopper.skills),REGION:'draynor',TREE:'oak',PREPARE:'1',MAX_MAKE:'25',PROOF_TRACE_PATH:'1',RANDOM_EVENTS:'0'}:{}),...(waterfallMode?{PROOF_EXPECT_SKILLS:JSON.stringify(mighty.skills),WF_RESUME_HUDON:mode==='waterfall-hudon'?'1':undefined,WF_MIGHTY:'1',WF_FOOD:'salmon',WF_EAT_AT:'30',WF_FOOD_COUNT:'16',WF_TRACE:'1'}:{}),...(mode==='clay'?{ORE_PROFILE:'clay',SOFTEN_CLAY:'1',BANK_AT:'20',NO_ORE_TICKS:'120',MAX_MAKE:'20',RAW_RESERVE:'0'}:{}),...(cowMode?{TARGET:'cow',MAX_KILLS:mode==='cow-diag'?'1':'5',TRAIN_SKILL:'Attack',TARGET_LEVEL:undefined}:{}),...(mode==='smelt-bronze'?{BAR_TYPE:'bronze',MAX_MAKE:'8',ORE_RESERVE:'1'}:{}),...(toolMode?{ORE_PROFILE:'mixed',SOFTEN_CLAY:'',BANK_AT:'5',NO_ORE_TICKS:'120'}:{}),...(mode==='ore-regression'?{BANK_AT:'5',NO_ORE_TICKS:'120'}:{}),...(mode==='wood'?{REGION:'draynor',TREE:'normal'}:{}),CAP:oakBowsMode?'1000':oakMode?'1500':mode==='cow-diag'?'600':mode==='clay'?'800':toolMode?'500':headlessMode||steelMode||mode==='ore-regression'||mode==='smelt-bronze'?'500':woolMode?'2200':cowMode||mode==='catherby' || mode==='cook-badpoint'?'1500':buyerPlan || (mode==='outbound'||mode==='homeward')?'1200':'1250',MAX_TRIPS:woolMode?'3':flaxMode?'4':'1'},windowsHide:true});
   let damageStopped=false;const damageWatch=mode==='clay'?setInterval(()=>{try{const st=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));if(st.hp?.now>0&&st.hp.now<10&&!damageStopped){damageStopped=true;writeFileSync(resolve('.practice',`stop-${bot}`),'practice fresh-route HP loss');console.log(`PROOF_DAMAGE_STOP bot=${bot} tick=${st.tick} hp=${st.hp.now}`);}}catch{}},100):null;
   const timer=setTimeout(()=>proc.kill(),timeoutMs);
   const read=async(stream:ReadableStream<Uint8Array>,channel:'stdout'|'stderr')=>{const reader=stream.getReader(),decoder=new TextDecoder();let text='',pending='';while(true){const chunk=await reader.read();if(chunk.done)break;const part=decoder.decode(chunk.value,{stream:true});text+=part;pending+=part;const lines=pending.split(/\r?\n/);pending=lines.pop()??'';for(const line of lines)if(/^(PROOF_DAMAGE|PROOF_STALL|PROOF_REPLY|WARN|WALK fail)/.test(line))console.log(line);writeFileSync(resolve(dir,`${mode}-${bot}-${channel}-stream.log`),text);if(channel==='stdout')writeFileSync(resolve(dir,`${mode}-${bot}-stream.log`),text);}return text+decoder.decode();};
   const [out,err]=await Promise.all([read(proc.stdout as ReadableStream<Uint8Array>,'stdout'),read(proc.stderr as ReadableStream<Uint8Array>,'stderr')]);
   const exitCode=await proc.exited;clearTimeout(timer);if(damageWatch)clearInterval(damageWatch);
   let stdout=(out+err).replace(/^.*PASSWORD.*$/gm,'[redacted]');
   // Retain the production output even when a required snapshot is absent or malformed.
   writeFileSync(resolve(dir,`${mode}-${bot}.log`),stdout);
   if(mode==='homeward'){
    const inspect=Bun.spawn(['bun',resolve('scripts/measure/fleet-bank-inspect.ts'),bot],{stdout:'pipe',stderr:'pipe',env:{...process.env,DEMO_OK:''},windowsHide:true});
    const timer=setTimeout(()=>inspect.kill(),20000);const [a,b]=await Promise.all([new Response(inspect.stdout).text(),new Response(inspect.stderr).text()]);await inspect.exited;clearTimeout(timer);
    writeFileSync(resolve(dir,`${mode}-${bot}-endpoint.log`),a+b);
    stdout+='\n'+a+b;
   }
   try {
   if(buyerPlan) {
    const cargo=JSON.parse(readFileSync(resolve('.practice/cargo',bot+'.json'),'utf8'));
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const names=buyerPlan.names;
    const required=(name:string)=>buyerPlan.required?.[name]??buyerPlan.target;
    const counts=Object.fromEntries(names.map(n=>[n,cargo.items.filter((i:{name:string})=>i.name.toLowerCase()===n.toLowerCase()).reduce((a:number,i:{count:number})=>a+i.count,0)]));
    const protectedKit=(preset!.inventory??[]).filter(i=>i.id!==995).every(item=>status.inventory.filter((i:{id:number})=>i.id===item.id).reduce((a:number,i:{count:number})=>a+i.count,0)===item.count);
    const bankCash=(status.bank??[]).filter((i:{id:number})=>i.id===995).reduce((n:number,i:{count:number})=>n+i.count,0);
    const initialCash=Number(preset!.coins??0)+(preset!.inventory??[]).filter(i=>i.id===995).reduce((n,i)=>n+i.count,0)+(preset!.bank??[]).filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
    const wallet=Number(stdout.match(/coinsLeft=(\d+)/)?.[1]??NaN), spent=Number(stdout.match(/spentTotal=(\d+)/)?.[1]??NaN);
    const survival=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const metGate=mode!=='betty-met' || /boughtTotal=0\b/.test(stdout) && /shopTrips=0\b/.test(stdout) && /stop=stock-target targetMet=1/.test(stdout) && spent===0;
    const ok=metGate && Object.entries(counts).every(([name,n])=>Number(n)>=required(name)) && wallet>=5000 && spent<=(buyerPlan.maxSpend??15000) && wallet+bankCash+spent===initialCash && protectedKit && survival;
    const hashes=Object.fromEntries(['scripts/shop-buyer.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,counts,wallet,bankCash,initialCash,spent,protectedKit,survival,cargo,inventory:status.inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=${mode} bankTypes=${Object.entries(counts).filter(([name,n])=>Number(n)>=required(name)).length} banked=${Object.values(counts).reduce((a,n)=>a+Number(n),0)} coins=${wallet} spent=${spent} protected=${protectedKit} survival=${survival} ok=${ok}\n`;
   }
   if(mode==='wool-starter') {
    const cargo=JSON.parse(readFileSync(resolve('.practice/cargo',bot+'.json'),'utf8'));
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const bank=status.bank??[], inventory=status.inventory;
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);
    const kitPreserved=starterKit.every(i=>count(bank,i.id)+count(inventory,i.id)===i.count);
    const foodsAndShears=[315,2309,1735].every(id=>count(inventory,id)===1);
    const raw=count(cargo.items,1737), balls=count(cargo.items,1759), bankCoins=count(bank,995), heldCoins=count(inventory,995);
    const survival=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const ok=/RESULT ok.*gathered=50 spun=25 rawBanked=25 trips=3 died=false/.test(stdout) && raw===25 && balls===25 && bankCoins===5 && heldCoins===0 && kitPreserved && foodsAndShears && survival;
    const hashes=Object.fromEntries(['scripts/collect-wool.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,raw,balls,bankCoins,heldCoins,kitPreserved,foodsAndShears,survival,cargo,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=wool-starter raw=${raw} balls=${balls} bankCoins=${bankCoins} heldCoins=${heldCoins} kit=${kitPreserved} foodsAndShears=${foodsAndShears} survival=${survival} ok=${ok}\n`;
   }
   if(mode==='entry' || (mode==='outbound'||mode==='homeward')) {
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const entry=mode==='entry'?JSON.parse(stdout.match(/^ENTRY (.+)$/m)?.[1]??'null'):null;
    const bank=entry?.bank??(mode==='homeward'?status.bank??[]:[]), inventory=status.inventory;
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);
    const wallet=count(inventory,995), bankCoins=count(bank,995);
    const freshKit=starterKit.filter(i=>![995,1735].includes(i.id));
    const protectedKit=mode==='entry'?freshKit.every(i=>count(bank,i.id)+count(inventory,i.id)===i.count):[315,2309].every(id=>count(inventory,id)===1);
    const foods=[315,2309].every(id=>count(inventory,id)===1);
    const atBank=status.pos.level===0 && Math.max(Math.abs(status.pos.x-(mode==='homeward'?2654:3092)),Math.abs(status.pos.z-(mode==='homeward'?3283:3243)))<=4;
    const survival=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const modeGate=mode==='homeward'?wallet===140&&bankCoins===30 && /died=false/.test(stdout):mode==='entry' ? wallet+bankCoins===25 && !!entry && /^START 3094 310[67] 0/m.test(stdout) : wallet===20320 && /^RESULT ok outboundOnly=true.*received=0 handed=0 fishNotes=0/m.test(stdout) && /waitTicks=0 giveTicks=0/m.test(stdout) && /feathersBought=0/m.test(stdout);
    const modeKit=mode!=='homeward'||[1735,315,2309].every(id=>count(inventory,id)===1)&&count(status.bank??[],1737)===40&&count(status.bank??[],1759)===25;
    const ok=modeKit && modeGate && atBank && protectedKit && foods && survival;
    const hashes=Object.fromEntries([mode==='entry'?'scripts/arrive-draynor.ts':'scripts/foodcourier.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,wallet,bankCoins,protectedKit,foods,survival,pos:status.pos,entry,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=${mode} wallet=${wallet} bankCoins=${bankCoins} protected=${protectedKit} foods=${foods} atBank=${atBank} survival=${survival} ok=${ok}\n`;
   }
   if(mode==='cook-badpoint') {
    const cargo=JSON.parse(readFileSync(resolve('.practice/cargo',bot+'.json'),'utf8'));
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const bank=status.bank??[], inventory=status.inventory;
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);
    const protectedKit=[[309,1],[946,1],[1511,2],[314,100],[2140,2],[995,200]].every(([id,n])=>count(inventory,id!)===n);
    const cooked=cargo.items.filter((i:{name:string})=>/^(trout|salmon)$/i.test(i.name)).reduce((a:number,i:{count:number})=>a+i.count,0);
    const rawTrout=count(bank,335),rawSalmon=count(bank,331);
    const atBank=status.pos.level===0 && Math.max(Math.abs(status.pos.x-3092),Math.abs(status.pos.z-3243))<=4;
    const survival=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const ok=/^RESULT ok route=near.*processed=60 banked=60 burntBanked=0/m.test(stdout) && cooked===60 && rawTrout===50 && rawSalmon===50 && count(bank,2140)===133 && protectedKit && atBank && survival;
    const hashes=Object.fromEntries(['scripts/cook-stock.ts','packages/core/src/walk.ts','knowledge/doors.json','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,cooked,rawTrout,rawSalmon,protectedKit,atBank,survival,cargo,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=cook-badpoint cooked=${cooked} rawTrout=${rawTrout} rawSalmon=${rawSalmon} kit=${protectedKit} atBank=${atBank} survival=${survival} ok=${ok}\n`;
   }
   if(flaxMode) {
    const result=JSON.parse(stdout.match(/^SPIN_BANK (.+)$/m)?.[1]??'null');
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const stockPreserved=(preset!.bank??[]).filter(i=>i.id!==1779&&i.id!==1777).every(i=>result?.bank.filter((j:{id:number})=>j.id===i.id).reduce((n:number,j:{count:number})=>n+j.count,0)===i.count);
    const ok=stockPreserved&&result?.ok && result.made===56 && result.spunTotal===56 && result.rawBank===50 && result.stringsBank===56 && result.xpGain>0 && result.preserved && life && (!mode.endsWith('notes') || /SPIN_NOTES deposited=106 rawBank=106/.test(stdout));
    const hashes=Object.fromEntries(['scripts/spin-bowstrings.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,stockPreserved,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=flax made=${result?.made} raw=${result?.rawBank} preserved=${result?.preserved} survival=${life} ok=${ok}\n`;
   }
   if(oakMode){
    const initial=JSON.parse(readFileSync(resolve(dir,`${mode}-${bot}-initial-save.json`),'utf8'));
    const savePath=resolve('vendor/rs-sdk/server/engine/data/players/main',`${bot.toLowerCase()}.sav`);
    const baseOak=(initial.inventories[95]??[]).filter((i:{id:number})=>i.id===1521).reduce((n:number,i:{count:number})=>n+i.count,0);
    const publication=await waitPracticeSave(savePath,c=>(c.inventories[95]??[]).filter(i=>i.id===1521).reduce((n,i)=>n+i.count,0)===baseOak+25,{timeoutMs:/^RESULT ok/m.test(stdout)?6000:1000});
    const final=publication.save;writeFileSync(resolve(dir,`${mode}-${bot}-first-final-save.json`),JSON.stringify(publication.first,null,2));
    const totals=(inventories:Record<string,{id:number;count:number}[]>)=>{const m=new Map<number,number>();for(const items of Object.values(inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const before=totals(initial.inventories),after=totals(final.inventories);
    const preserved=[...before].every(([id,n])=>(after.get(id)??0)===n),oak=countBank(final.inventories[95]??[],1521)-(before.get(1521)??0);
    function countBank(items:{id:number;count:number}[],id:number){return items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);}
    const life=/PROOF_SURVIVAL started=true died=false hpMin=11 finalHp=11/.test(stdout);
    const ok=publication.matched&&oak===25&&preserved&&life&&final.skills[8]!.xp>initial.skills[8].xp&&/LOGOUT logged-out/.test(stdout);
    const hashes=Object.fromEntries(['scripts/gather-yews.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,publication:{matched:publication.matched,reads:publication.reads,lastError:publication.lastError},oak,preserved,life,initial,final,sourceStatusAt:bigchopper.at,actualWorkingFoods:bigchopper.inventory.filter((i:{id:number})=>[315,2309,333,329].includes(i.id)),hashes},null,2));
    stdout+=`\nPROOF_GATE profile=wood-oak oak=${oak} preserved=${preserved} life=${life} ok=${ok}\n`;
   }
   if(waterfallMode){
    const result=JSON.parse(stdout.match(/^WATERFALL_BANK (.+)$/m)?.[1]??'null');
    const initial=JSON.parse(readFileSync(resolve(dir,`${mode}-${bot}-initial-save.json`),'utf8'));
    const savePath=resolve('vendor/rs-sdk/server/engine/data/players/main',`${bot.toLowerCase()}.sav`);
    const publication=await waitPracticeSave(savePath,c=>c.vars[65]===10&&(c.inventories[93]??[]).length===0&&c.skills[0]!.xp-initial.skills[0].xp===343750&&c.skills[2]!.xp-initial.skills[2].xp===343750&&c.position.level===0&&Math.max(Math.abs(c.position.x-2654),Math.abs(c.position.z-3283))<=4,{timeoutMs:/^RESULT ok/m.test(stdout)?6000:1000});
    const final=publication.save;writeFileSync(resolve(dir,`${mode}-${bot}-first-final-save.json`),JSON.stringify(publication.first,null,2));
    const totals=(inventories:Record<string,{id:number;count:number}[]>)=>{const m=new Map<number,number>();for(const items of Object.values(inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const before=totals(initial.inventories),after=totals(final.inventories),eaten=Number(result?.eaten??NaN);
    const conserved=[...before].every(([id,n])=>(after.get(id)??0)===n-([556,557,555].includes(id)?6:id===329?eaten:0));
    const rewards=[{id:1601,n:2},{id:2357,n:2},{id:299,n:40}].every(({id,n})=>(after.get(id)??0)-(before.get(id)??0)===n);
    const rewardsSavedInBank=[{id:1601,n:2},{id:2357,n:2},{id:299,n:40}].every(({id,n})=>(final.inventories[95]??[]).filter(i=>i.id===id).reduce((sum,i)=>sum+i.count,0)-(before.get(id)??0)===n)&&(final.inventories[93]??[]).length===0;
    const xpExact=final.skills[0]!.xp-initial.skills[0].xp===343750&&final.skills[2]!.xp-initial.skills[2].xp===343750;
    const life=/PROOF_SURVIVAL started=true died=false/.test(stdout)&&Number(stdout.match(/PROOF_SURVIVAL.*hpMin=(\d+)/)?.[1]??0)>11;
    const atBank=final.position.level===0&&Math.max(Math.abs(final.position.x-2654),Math.abs(final.position.z-3283))<=4;
    const ok=publication.matched&&!!result?.preserved&&result.rewardsBanked&&conserved&&rewards&&rewardsSavedInBank&&xpExact&&final.vars[65]===10&&atBank&&life&&/LOGOUT logged-out/.test(stdout);
    const hashes=Object.fromEntries(['scripts/generated/waterfall.ts','scripts/measure/fleet-player-save.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,publication:{matched:publication.matched,reads:publication.reads,lastError:publication.lastError},result,conserved,rewards,rewardsSavedInBank,xpExact,life,atBank,initial,final,sourceMightyStatusAt:mighty.at,stagedSupplies:mode==='waterfall-hudon'?{questVarp65:1,qualification:'explicit inferred-public-state hypothesis; held/bank copied from actual Mighty snapshot'}:{rope:2,air:6,earth:6,water:6,questVarp65:0},hashes},null,2));
    stdout+=`\nPROOF_GATE profile=waterfall-mighty quest=${final.vars[65]} xpExact=${xpExact} rewards=${rewards} conserved=${conserved} atBank=${atBank} life=${life} ok=${ok}\n`;
   }
   if(toolMode){
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const bank=status.bank??[],inventory=status.inventory;
    const tool=preset!.inventory![0]!.id,ores=[436,438,440].map(id=>count(bank,id));
    const skills=JSON.parse(stdout.match(/^PROOF_SKILLS (.+)$/m)?.[1]??'null'),mining=skills?.find((s:{name:string})=>s.name.toLowerCase()==='mining');
    const ticks=Number(stdout.match(/RESULT ok ticks=(\d+)/)?.[1]??NaN),xpGain=Number(stdout.match(/xpGain=(\d+)/)?.[1]??NaN),walkTicks=Number(stdout.match(/walkTicks=(\d+)/)?.[1]??NaN);
    const preserved=count(inventory,tool)===1&&count(inventory,315)===1&&count(inventory,2309)===1&&count(inventory,995)+count(bank,995)===200;
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const ok=/mined=5 banked=5 held=0/.test(stdout)&&ores.join('/')==='2/2/1'&&mining?.level===31&&xpGain===2625&&preserved&&life;
    const hashes=Object.fromEntries(['scripts/gather-ore.ts','scripts/soften-clay.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,run:toolIndex,tool,ticks,walkTicks,xpGain,mining,ores,preserved,life,bank,inventory,preset,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=ore-tools run=${toolIndex} tool=${tool} ticks=${ticks} ores=${ores.join('/')} xp=${xpGain} protected=${preserved} survival=${life} ok=${ok}\n`;
   }
   if(mode==='clay'){
    const result=JSON.parse(stdout.match(/^SOFT_CLAY_BANK (.+)$/m)?.[1]??'null');
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const all=[...status.inventory,...(status.bank??[])];
    const count=(id:number)=>all.filter((i:{id:number})=>i.id===id).reduce((n:number,i:{count:number})=>n+i.count,0);
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const preserved=[1265,315,2309].every(id=>count(id)===1)&&count(995)===200&&count(1925)+count(1929)===1;
    const ok=result?.ok&&result.made===20&&result.banked===20&&count(1761)===20&&count(434)===0&&result.targetMet&&preserved&&life&&!damageStopped;
    const hashes=Object.fromEntries(['scripts/gather-ore.ts','scripts/soften-clay.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,preserved,life,damageStopped,bank:status.bank,inventory:status.inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=clay made=${result?.made} banked=${result?.banked} preserved=${preserved} survival=${life} damageStopped=${damageStopped} ok=${ok}\n`;
   }
   if(cowMode){
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const bank=status.bank??[],inventory=status.inventory;
    const eaten=Number(stdout.match(/eaten=(\d+)/)?.[1]??NaN),attackXp=Number(stdout.match(/attackXp=(\d+)/)?.[1]??NaN);
    const minHp=Number(stdout.match(/PROOF_SURVIVAL.*hpMin=(\d+)/)?.[1]??0);
    const life=/PROOF_SURVIVAL started=true died=false/.test(stdout)&&minHp>0;
    const drops=[1739,526,2132].map(id=>count(bank,id));
    const food=count(inventory,333)===2&&count(bank,333)===5-eaten;
    const goal=mode==='cow-diag'?1:5;
    const ok=new RegExp(`RESULT ok mode=cow.*creditedKills=${goal}`).test(stdout)&&drops.every(n=>n===goal)&&attackXp>0&&/preserved=true/.test(stdout)&&count(inventory,995)===200&&food&&life&&/LOGOUT logged-out/.test(stdout);
    const hashes=Object.fromEntries(['scripts/gather-combat.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,tickMs:mode==='cow-diag'?400:150,drops,eaten,food,attackXp,minHp,life,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=cow drops=${drops.join('/')} food=${food} hpMin=${minHp} survival=${life} ok=${ok}\n`;
   }
   if(mode==='smelt-bronze'){
    const result=JSON.parse(stdout.match(/^BRONZE_RESULT (.+)$/m)?.[1]??'null');
    const stock=JSON.parse(stdout.match(/^BRONZE_BANK (.+)$/m)?.[1]??'null');
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const stockPreserved=(preset!.bank??[]).filter(i=>i.id!==1779&&i.id!==1777).every(i=>result?.bank.filter((j:{id:number})=>j.id===i.id).reduce((n:number,j:{count:number})=>n+j.count,0)===i.count);
    const ok=stockPreserved&&result?.ok&&result.made===8&&result.banked===8&&result.finalCopper===2&&result.finalTin===1&&result.xpGain>0&&result.preserved&&life;
    const hashes=Object.fromEntries(['scripts/smelt-bars.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,stock,life,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=smelt-bronze made=${result?.made} banked=${result?.banked} raw=${result?.finalCopper}/${result?.finalTin} survival=${life} ok=${ok}\n`;
   }
   if(mode==='payout-notes'){
    const result=JSON.parse(stdout.match(/^PAYOUT_PROOF (.+)$/m)?.[1]??'null');
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout),ok=result?.ok&&life;
    const hashes=Object.fromEntries(['scripts/banker.ts','scripts/measure/fleet-payout-notes.ts','packages/core/src/walk.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,life,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=payout-notes notes=${result?.notes} restored=${result?.restored} survival=${life} ok=${ok}\n`;
   }
   if(mode==='ore-regression') {
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const bank=status.bank??[],inventory=status.inventory;
    const total=count(bank,436)+count(bank,438)+count(bank,440);
    const protectedKit=[1265,315,2309].every(id=>count(inventory,id)===1);
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const ok=/mined=5 banked=10 held=0/.test(stdout)&&/initialOre=5 recovered=10 xpGain=/.test(stdout)&&total===10&&protectedKit&&life;
    const hashes=Object.fromEntries(['scripts/gather-ore.ts','packages/core/src/walk.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,total,protectedKit,life,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=ore-regression new=5 recovered=${total} protected=${protectedKit} survival=${life} ok=${ok}\n`;
   }
   if(steelMode) {
    const result=JSON.parse(stdout.match(/^STEEL_BANK (.+)$/m)?.[1]??'null');
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const stockPreserved=(preset!.bank??[]).filter(i=>i.id!==1779&&i.id!==1777).every(i=>result?.bank.filter((j:{id:number})=>j.id===i.id).reduce((n:number,j:{count:number})=>n+j.count,0)===i.count);
    const ok=stockPreserved&&result?.ok && result.made===15 && result.banked===15 && result.actions===1 && result.xpGain===1875 && result.reserveMet && result.outputReserveMet && result.preserved && life && (!mode.endsWith('notes') || /SPIN_NOTES deposited=106 rawBank=106/.test(stdout));
    const hashes=Object.fromEntries(['scripts/fletch-arrows.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,stockPreserved,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=steel made=${result?.made} banked=${result?.banked} survival=${life} ok=${ok}\n`;
   }
   if(oakBowsMode){
    const result=JSON.parse(stdout.match(/^OAK_BOW_BANK (.+)$/m)?.[1]??'null');
    const initial=JSON.parse(readFileSync(resolve(dir,`${mode}-${bot}-initial-save.json`),'utf8'));
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const publication=await waitPracticeSave(resolve('vendor/rs-sdk/server/engine/data/players/main',`${bot.toLowerCase()}.sav`),s=>count(s.inventories[95]??[],845)===32&&s.skills[9]!.xp===36113,{timeoutMs:/^RESULT ok/m.test(stdout)?6000:1000});
    const final=publication.save;
    const totals=(inventories:Record<string,{id:number;count:number}[]>)=>{const m=new Map<number,number>();for(const items of Object.values(inventories))for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const before=totals(initial.inventories),after=totals(final.inventories);
    const conserved=[...before].every(([id,n])=>(after.get(id)??0)===n+(id===845?25:[1521,1777].includes(id)?-25:0));
    const life=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const bank=final.inventories[95]??[],held=final.inventories[93]??[];
    const exactInputs=initial.skills[9].xp===4863&&count(bank,1521)===25&&count(bank,1777)===531&&count(bank,845)===32&&count(held,845)===0&&count(held,56)===0;
    const ok=publication.matched&&result?.ok&&result.made===25&&result.banked===25&&result.shapeXp===15625&&result.stringXp===15625&&conserved&&exactInputs&&life&&/LOGOUT logged-out/.test(stdout);
    const hashes=Object.fromEntries(['scripts/fletch-arrows.ts','scripts/measure/fleet-player-save.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,publication:{matched:publication.matched,reads:publication.reads,lastError:publication.lastError},conserved,exactInputs,life,initial,final,hashes},null,2));
    writeFileSync(resolve(dir,`${mode}-${bot}-first-final-save.json`),JSON.stringify(publication.first,null,2));
    stdout+=`\nPROOF_GATE profile=oak-bows made=${result?.made} banked=${result?.banked} exactInputs=${exactInputs} conserved=${conserved} life=${life} ok=${ok}\n`;
   }
   if(headlessMode) {
    const result=JSON.parse(stdout.match(/^HEADLESS_BANK (.+)$/m)?.[1]??'null');
    const status=JSON.parse(readFileSync(resolve('.practice/status',bot+'.json'),'utf8'));
    const bank=status.bank??[], inventory=status.inventory;
    const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);
    const kit=[[946,1],[315,1],[2309,1],[995,200]].every(([id,n])=>count(inventory,id!)===n);
    const survival=/PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(stdout);
    const ok=result?.ok && result.made===390 && result.banked===390 && result.xpGain>0 && count(bank,53)===390 && count(bank,52)===330 && count(bank,314)===110 && count(inventory,53)===0 && kit && survival;
    const hashes=Object.fromEntries(['scripts/fletch-arrows.ts','packages/core/src/walk.ts','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,kit,survival,bank,inventory,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=headless made=${result?.made} banked=${count(bank,53)} shafts=${count(bank,52)} feathers=${count(bank,314)} heldProduct=${count(inventory,53)} xpGain=${result?.xpGain} kit=${kit} survival=${survival} ok=${ok}\n`;
   }
   if(mode==='aubury-entry' || mode==='zeke-entry' || mode==='seers-entry') {
    const result=JSON.parse(stdout.match((mode==='zeke-entry'?/^TOLL_ENTRY (.+)$/m:/^RELOCATION (.+)$/m))?.[1]??'null');
    const initialCash=Number(preset!.coins??0)+(preset!.inventory??[]).filter(i=>i.id===995).reduce((n,i)=>n+i.count,0)+(preset!.bank??[]).filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
    const life=/PROOF_SURVIVAL started=true died=false/.test(stdout);
    const ok=result?.preserved && result.atBank && result.hpMin>=7 && !result.died && result.secured===initialCash && (mode==='zeke-entry'?result.fee===10:result.heldCoins===0) && life;
    const hashes=Object.fromEntries([mode==='seers-entry'?'scripts/measure/fleet-seers-entry.ts':mode==='zeke-entry'?'scripts/measure/fleet-al-kharid-entry.ts':'scripts/measure/fleet-relocate.ts','packages/core/src/walk.ts','knowledge/doors.json','scripts/measure/fleet-observe.ts'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    writeFileSync(resolve(dir,`${mode}-${bot}-snapshot.json`),JSON.stringify({ok,result,initialCash,preset,hashes},null,2));
    stdout+=`\nPROOF_GATE profile=${mode} bankCash=${result?.secured} heldCoins=${result?.heldCoins} hpMin=${result?.hpMin} preserved=${result?.preserved} nodeath=${!result?.died} ok=${ok}\n`;
   }
   } catch(e) {
    stdout+=`\nPROOF_GATE profile=${mode} evidenceError=${JSON.stringify(String(e))} ok=false\n`;
   }
   writeFileSync(resolve(dir,`${mode}-${bot}.log`),stdout);
   console.log(stdout.split(/\r?\n/).filter(l=>/^(START|RESULT|MILESTONE|LEDGER|WARN|PROOF_)/.test(l)).join('\n'));
   return {stdout,exitCode};
  },
 });
 writeFileSync(resolve(dir,`${mode}-report.json`),JSON.stringify({...report,mode,...(toolMode?{toolOrder,seedControl:false}:{}),...(mode==='payout-notes'?{bankerSourceSha256:createHash('sha256').update(readFileSync('scripts/banker.ts')).digest('hex')}:{}),source:script,sourceSha256:createHash('sha256').update(readFileSync(resolve('scripts',script+'.ts'))).digest('hex'),preset:mode==='fresh' || mode==='entry'?null:preset,faultInjection:mode==='ore-no-iron'?'iron candidate ids replaced with nonexistent ids':null},null,2));
 console.log(JSON.stringify(report));
 process.exitCode=report.passes===report.runs?0:1;
} finally {await stack?.stop();}
