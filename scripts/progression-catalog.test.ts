import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {aioRoutes} from './script-index';
import {planProgressiveSkiller,progressiveSkillerAlternatives} from './aio-skiller';
import {buildProgressionCatalog} from './progression-catalog';
import {aioRouteKeys} from './measure/aio-bench-cases';
import {catalogue} from '../packages/planner/src/autopilot';
import {intentForEntry} from '../packages/planner/src/progression-catalog';
import {parseStep} from '../packages/core/src/chain-step';
import {resolveAioStep} from './aio';

test('every AIO route and all nineteen skills have a progression classification',()=>{
 const c=buildProgressionCatalog();
 expect(c.skills).toHaveLength(19);
 for(const route of aioRoutes())expect(c.routes.find(r=>r.id===(route.category==='quester'?`quester:mode:${route.name}`:`${route.category}:${route.name}`))?.intents.length).toBeGreaterThan(0);
 expect(c.routes.map(r=>r.id).sort()).toEqual(aioRouteKeys().sort());
 expect(c.routes.filter(r=>!r.intents.length)).toEqual([]);
});

test('fixed quest aliases have named quest metadata rather than a filename guess',()=>{
 const c=buildProgressionCatalog();
 for(const[id,name]of [['dwarfcannon','Dwarf Cannon'],['waterfall','Waterfall Quest']])expect(c.quests.find(q=>q.id===id)?.name).toBe(name);
 for(const[id,name]of [['barcrawl',"Alfred Grimhand's Barcrawl"],['magearena','The Mage Arena']]){
  expect(c.quests.find(q=>q.id===id)).toBeUndefined();expect(c.routes.find(r=>r.id==='quester:quest:'+id)).toMatchObject({description:name,intents:['service']});
 }
});

test('generated runtime metadata matches its real catalog source',()=>{
 const root=resolve(import.meta.dir,'..');
 expect(JSON.parse(readFileSync(resolve(root,'packages/planner/data/progression-routes.json'),'utf8'))).toEqual(buildProgressionCatalog(root));
 const runtime=readFileSync(resolve(root,'packages/planner/src/progression-catalog.ts'),'utf8');
 expect(runtime).not.toMatch(/from\s+['"][^'"]*(?:scripts\/aio|scripts\/microbot|scripts\/gather)/);
});

test('native GE fixture modes are classified only for local practice without a live route',()=>{
 const c=buildProgressionCatalog(),script='packages/practice/src/ge-bulk-order-proof.ts';
 expect(c.entries.find(e=>e.script===script)).toEqual({script,intents:['service','observe'],skills:[],routeIds:[],practiceOnly:true});
 expect(c.routes.some(r=>r.script===script)).toBe(false);
 expect(c.methods.some(m=>m.step.script===script)).toBe(false);
});

test('skiller alternatives retain lower unlocked methods and finite targets',()=>{
 const alternatives=progressiveSkillerAlternatives('firemaking',80,90);
 expect(alternatives.map(r=>r.unlockLevel)).toEqual([1,15,30,45,60,75]);
 expect(alternatives.every(r=>r.toLevel===90&&r.unitsNeeded>0&&r.step.env.TARGET_LEVEL==='90')).toBe(true);
 expect(progressiveSkillerAlternatives('herblore',1,20)).toEqual([]);
});

test('source substring mappings are never promoted to qualified executable methods',()=>{
 const c=buildProgressionCatalog();
 expect(c.methods.some(m=>Object.keys(m.effects.xp??{}).length>0)).toBe(true);
 expect(c.methods.every(m=>m.qualification===undefined)).toBe(true);
 expect(c.methods.every(m=>!!m.step.script&&m.source.length>0)).toBe(true);
});

test('shipped trainer and quest templates preserve their declared consumer through actual worker entries',()=>{
 const c=buildProgressionCatalog();
 const workers=(script:string,args:readonly string[],env:Record<string,string>):{script:string;args:string[];env:Record<string,string>}[]=>{
  if(script==='scripts/chain.ts')return args.flatMap(text=>{const step=parseStep(text);return workers(step.script,step.args,{...env,...step.env});});
  if(script==='scripts/aio.ts'){const step=resolveAioStep(args[0]!,args.slice(1));return workers(step.script,step.args,{...env,...step.env});}
  return[{script,args:[...args],env}];
 };
 let checked=0;
 for(const template of catalogue()){
  const accept=template.quest?{quests:[template.quest.name]}:template.trains?{skills:{[template.trains.skill]:template.trains.to}}:undefined;
  if(!accept)continue;
  for(const worker of workers(template.script,template.args??[],template.env??{})){
   expect(c.entries.some(e=>e.script===worker.script),template.id+' '+worker.script).toBe(true);
   expect(intentForEntry(worker.script,worker.args,worker.env,accept,c),template.id).not.toBeNull();checked++;
  }
 }
 expect(checked).toBeGreaterThan(30);
 for(const work of [{script:'scripts/aio-market.ts',args:['shop-buy','dargaud','1600'],env:{ITEMS:'mithril.arrow|bronze.arrow',STOCK_TARGET:'500'}},
  {script:'scripts/fleet-trade.ts',args:['.practice/fleet-data/fleet/orders/one.json'],env:{}},
  {script:'scripts/microbot-production.ts',args:['cut-sapphire'],env:{MAX_MAKE:'10'}}])expect(intentForEntry(work.script,work.args,work.env,undefined,c)).not.toBeNull();
});

test('progressive skiller covers smithing anvil, thieving sub-55, magic splash, runecraft early, agility barb XP, and prayer dragon bones',()=>{
 // Each smelt and each anvil action takes 5 ticks (knowledge/ladders.json), so a platebody gives more XP in a tick than
 // each bar that the level smelts. With no stock known the plan smelts the bars and then smiths them.
 const smith=(...a:Parameters<typeof planProgressiveSkiller>)=>planProgressiveSkiller(...a).map(b=>`${b.fromLevel}-${b.toLevel} ${b.method} ${b.step.env.PRODUCT_ID??b.step.args[1]} x${b.unitsNeeded}`);
 expect(smith('smithing',1,99)).toEqual(['1-15 smelt bronze x12','15-30 smelt iron x18','30-33 smelt steel x5','33-48 anvil 1115 x3','42-48 smelt iron x11','44-48 anvil 1115 x2',
  '48-68 anvil 1119 x1','50-68 smelt steel x61','58-68 anvil 1119 x12','68-88 smelt mithril x175','78-88 anvil 1121 x35','88-99 smelt adamantite x215','93-99 anvil 1123 x43']);
 // An account that holds the bars of the route's supply bill (research/supply-logistics.md, Smithing row) and a hammer
 // smiths them and smelts nothing.
 expect(smith('smithing',33,99,25,{2351:35,2353:95,2359:280,2361:345,2347:1})).toEqual(['33-48 anvil 1115 x7','48-68 anvil 1119 x19','68-88 anvil 1121 x56','88-99 anvil 1123 x69']);
 expect(planProgressiveSkiller('thieving',1,55).map(b=>b.unlockLevel)).toEqual([1,5,40]);
 expect(planProgressiveSkiller('magic',1,21).map(b=>`${b.method}:${b.step.args[0]??'-'}`)).toEqual(['order:-','splash:11','splash:19','splash:21']);
 expect(planProgressiveSkiller('runecraft',1,44).map(b=>b.unlockLevel)).toEqual([1,2,5,9,14,20]);
 expect(planProgressiveSkiller('agility',35,52,1)[0]!.xpPerUnit).toBe(114.5);
 expect(planProgressiveSkiller('prayer',44,99)[0]!.step.env.BONE_ID).toBe('536');
});

test('catalog maps smithing anvil, magic, runecraft F2P altars, fletching, woodcutting, and pickpocket rungs',()=>{
 const c=buildProgressionCatalog();
 expect((c.unmapped??[]).length).toBeLessThan(160);
 expect(c.methods.length).toBeGreaterThan(700);
 const coveredIds=new Set(c.methods.flatMap(m=>[m.id,...(m.ladderIds??[])]));
 for(const id of ['smithing/anvil-steel-platebody','magic/high-alch','magic/npc-wind-strike','runecraft/nature','fletching/arrows-rune','woodcutting/yew','thieving/pickpocket-knight-of-ardougne','prayer/bury-dragon_bones'])
  expect(coveredIds.has(id),id).toBe(true);
});

test('the registration script of the practice proofs is an observe entry, so the session does not hand it off',()=>{
 const c=buildProgressionCatalog(),script='packages/practice/src/register-proof-account.ts';
 expect(c.entries.find(e=>e.script===script)).toEqual({script,intents:['observe'],skills:[],routeIds:[],practiceOnly:true});
 expect(c.routes.some(r=>r.script===script)).toBe(false);
 expect(c.methods.some(m=>m.step.script===script)).toBe(false);
 // A script that the catalog does not name gets no intent: the session ends it as unmapped (the refusal that stopped
 // the registration of every practice fixture account).
 expect(intentForEntry(script,['aiobfxfixture'],{},undefined,c)?.kind).toBe('observe');
 expect(intentForEntry('packages/practice/src/not-in-the-catalog.ts',['aiobfxfixture'],{},undefined,c)).toBeNull();
});
