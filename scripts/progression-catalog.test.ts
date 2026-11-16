import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {aioRoutes} from './script-index';
import {progressiveSkillerAlternatives} from './aio-skiller';
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

test('generated runtime metadata matches its real catalog source',()=>{
 const root=resolve(import.meta.dir,'..');
 expect(JSON.parse(readFileSync(resolve(root,'packages/planner/data/progression-routes.json'),'utf8'))).toEqual(buildProgressionCatalog(root));
 const runtime=readFileSync(resolve(root,'packages/planner/src/progression-catalog.ts'),'utf8');
 expect(runtime).not.toMatch(/from\s+['"][^'"]*(?:scripts\/aio|scripts\/microbot|scripts\/gather)/);
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
 for(const work of [{script:'scripts/shop-buyer.ts',args:['dargaud','1600'],env:{ITEMS:'mithril.arrow|bronze.arrow',STOCK_TARGET:'500'}},
  {script:'scripts/fleet-trade.ts',args:['.practice/fleet-data/fleet/orders/one.json'],env:{}},
  {script:'scripts/microbot-production.ts',args:['cut-sapphire'],env:{MAX_MAKE:'10'}}])expect(intentForEntry(work.script,work.args,work.env,undefined,c)).not.toBeNull();
});
