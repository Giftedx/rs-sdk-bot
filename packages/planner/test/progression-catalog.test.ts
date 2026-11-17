import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateSmeltOrder} from '../../../scripts/smelt-batch';
import {accountFromStatus,catalogCoverage,intentForEntry,matchingProgressionRoutes,progressionMethods,progressionStep,type ProgressionCatalog} from '../src/progression-catalog';
import {xpForLevel} from '../src/curve';

const now=10_000;
const status={name:'Example',at:now,server:'rs-sdk-demo.fly.dev',bankAt:9000,equipmentObserved:true,
 skills:[{name:'Ranged',level:50,xp:100000},{name:'Crafting',level:30,xp:30000}],
 inventory:[{id:892,baseId:892,count:20}],equipment:[{id:861,baseId:861,count:1}],bank:[{id:892,baseId:892,count:80}],
 quests:[{name:'Dwarf Cannon',state:'not started'},{name:'Rune Mysteries Quest',state:'complete'}]};

test('account observations keep independent bank age and known empty containers',()=>{
 const a=accountFromStatus('Example',status,now);
 expect(a.account).toBe('Example');
 expect(a.skills.ranged).toEqual({level:50,xp:100000});
 expect(a.bank?.at).toBe(9000);
 expect(a.bank?.value).toEqual({892:80});
 expect(a.inventory?.value).toEqual({892:20});
 expect(a.quests?.value['dwarf cannon']).toBe(false);
 expect(a.quests?.value['rune mysteries quest']).toBe(true);
 expect(accountFromStatus('Example',{...status,bank:[],inventory:[]},now).bank?.value).toEqual({});
});

test('unobserved, future and wrong-account facts cannot become usable stock',()=>{
 expect(()=>accountFromStatus('Elsewhere',status,now)).toThrow('identity');
 const a=accountFromStatus('Example',{...status,bankAt:now+1,equipmentObserved:false},now);
 expect(a.bank).toBeNull();
 expect(a.equipment).toBeNull();
 expect(accountFromStatus('Example',null,now).skills).toEqual({});
 expect(accountFromStatus('Example',null,now).bank).toBeNull();
});

test('invalid levels and unknown XP are not filled with a fresh-account guess',()=>{
 const a=accountFromStatus('Example',{...status,skills:[{name:'Ranged',level:100,xp:100},{name:'Magic',level:50},{name:'Prayer',level:30,xp:NaN}]},now);
 expect(a.skills).toEqual({});
});

test('an explicit item or quest consumer outranks incidental training targets',()=>{
 expect(intentForEntry('scripts/gather-combat.ts',['1500','giant'],{TRAIN_SKILL:'Ranged',TARGET_LEVEL:'99'},{bank:{536:20}})).toMatchObject({kind:'acquire',items:{536:20}});
 expect(intentForEntry('scripts/generated/quest-cook.ts',[],{TARGET_LEVEL:'99'},{quests:["Cook's Assistant"]})).toEqual({kind:'quest',quest:"Cook's Assistant"});
 expect(intentForEntry('scripts/ranged-train.ts',['85','20000'],{})).toEqual({kind:'train',skill:'ranged',targetLevel:85});
 expect(intentForEntry('scripts/gather-combat.ts',['1500','trooper'],{TRAIN_SKILL:'Ranged',TARGET_LEVEL:'90'})).toEqual({kind:'train',skill:'ranged',targetLevel:90});
});

test('unknown scripts and missing finite goals remain explicit',()=>{
 expect(intentForEntry('scripts/not-a-route.ts',[],{})).toBeNull();
 expect(intentForEntry('scripts/gather-combat.ts',['1500','trooper'],{})).toBeNull();
});

test('compound cannon stops retain every finite training target',()=>{
 const expected={kind:'train-all' as const,targets:{ranged:99,defence:99,hitpoints:99}};
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99,Hitpoints=99'})).toEqual(expected);
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99,Hitpoints=99',TRAIN_SKILL:'Ranged',TARGET_LEVEL:'99'})).toEqual(expected);
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99,Hitpoints=99'},{skills:{Ranged:99,Defence:99,Hitpoints:99}})).toEqual(expected);
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP_SKILL:'Defence',STOP_LEVEL:'85'})).toEqual({kind:'train',skill:'defence',targetLevel:85});
 expect(intentForEntry('scripts/cannon-fight.ts',[],{})).toEqual({kind:'train',skill:'ranged',targetLevel:99});
 expect(intentForEntry('scripts/gather-combat.ts',[],{TRAIN_SKILL:'Ranged',TARGET_LEVEL:'99'},{skills:{Ranged:99,Hitpoints:99}})).toEqual({kind:'train-all',targets:{ranged:99,hitpoints:99}});
});

test('compound cannon stop parsing refuses unknown, duplicate and conflicting targets',()=>{
 for(const STOP of ['', 'Ranged=100,Defence=99','Ranged=99,ranged=99','Nonsense=99','Ranged=99,Defence=0','Ranged=99,Defence=1.5','Ranged=99,'])
  expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP})).toBeNull();
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99'},{skills:{Ranged:99}})).toBeNull();
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99'},{skills:{Ranged:99,Defence:85}})).toBeNull();
 expect(intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99'},{skills:{Ranged:99,Nonsense:99}})).toBeNull();
});

test('compound cannon steps keep the full stop map and recovery modes retain exact item goals',()=>{
 const goal=intentForEntry('scripts/cannon-fight.ts',[],{STOP:'Ranged=99,Defence=99,Hitpoints=99'})!;
 const a=accountFromStatus('Example',{...status,skills:[...status.skills,{name:'Defence',level:40,xp:xpForLevel(40)},{name:'Hitpoints',level:40,xp:xpForLevel(40)}]},now);
 const method={...progressionMethods(goal,a).methods.find(method=>method.id==='ranged/cannon')!,effects:{xp:{ranged:1,defence:1,hitpoints:1}}};
 const step=progressionStep(method,xpForLevel(99)-xpForLevel(40),goal,a);
 expect(step.env.STOP).toBe('ranged=99,defence=99,hitpoints=99');
 expect(step.env.STOP_LEVEL).toBeUndefined();expect(step.env.STOP_SKILL).toBeUndefined();
 for(const MODE of ['buy','reclaim'])expect(intentForEntry('scripts/cannon-fight.ts',[],{MODE})).toEqual({kind:'acquire',items:{6:1,8:1,10:1,12:1},consumer:'scripts/cannon-fight.ts'});
 expect(intentForEntry('scripts/cannon-fight.ts',[],{MODE:'unknown'})).toBeNull();
});

test('catalog coverage counts executable mapping separately from rate and qualification',()=>{
 const c={version:1,generatedBy:'fixture',skills:['ranged'],routes:[{id:'fighter:ranged',category:'fighter',name:'ranged',script:'scripts/ranged-train.ts',args:[],env:{},intents:['train'],skills:['ranged'],description:'train'}],methods:[],quests:[],entries:[]} as ProgressionCatalog;
 expect(catalogCoverage(c)).toMatchObject({routes:1,classified:1,skills:['ranged'],methods:0,qualified:0});
});

test('catalog methods retain unknown setup and produce a finite measurement gap',()=>{
 const c={version:1,generatedBy:'fixture',skills:['crafting'],routes:[],quests:[],entries:[],methods:[{
  id:'crafting/cut-sapphire',routeId:'skiller:crafting:inventory',ladderIds:['crafting/sapphire_cutting'],
  step:{script:'scripts/microbot-production.ts',args:['cut-sapphire'],env:{}},effects:{xp:{crafting:1250},items:{1607:1}},
  inputs:{1623:1},requirements:{levels:{crafting:20},items:{1755:1}},rate:{unitsPerTick:1,basis:'model',evidence:'pinned timing'},
  costs:{setupTicks:null,travelTicks:null,acquisitionTicks:null,unlockTicks:0},source:'fixture',repeatable:true,
 }]} as ProgressionCatalog;
 const result=progressionMethods({kind:'train',skill:'crafting',targetLevel:40},accountFromStatus('Example',status,now),c);
 expect(result.methods).toHaveLength(1);
 expect(result.methods[0]?.costs.setupTicks).toBeNull();
 expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({method:'crafting/cut-sapphire',action:'measure'})]));
 expect(result.methods[0]?.qualification).toBeUndefined();
});

test('finite item consumers cannot select an unrelated XP method',()=>{
 const c={version:1,generatedBy:'fixture',skills:['ranged'],routes:[],quests:[],entries:[],methods:[{
  id:'ranged/chickens',routeId:'fighter:ranged',ladderIds:[],step:{script:'scripts/ranged-train.ts',args:['99'],env:{}},
  effects:{xp:{ranged:300}},rate:{unitsPerTick:1,basis:'model',evidence:'fixture'},
  costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},source:'fixture',repeatable:true,
 }]} as ProgressionCatalog;
 expect(progressionMethods({kind:'acquire',items:{536:10},consumer:'prayer'},accountFromStatus('Example',status,now),c).methods).toEqual([]);
});

test('a finite recipe binds its executable batch and chosen path units',()=>{
 const c={version:1,generatedBy:'fixture',skills:['fletching'],routes:[],quests:[],entries:[],methods:[{
  id:'tips',routeId:'native',ladderIds:[],step:{script:'scripts/aio-skiller.ts',args:[],env:{}},effects:{items:{43:15}},inputs:{2359:1},
  rate:{unitsPerTick:1,basis:'model',evidence:'fixture'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},source:'fixture',repeatable:true,
  maxBatch:2,execution:{bankJob:{family:'inventory',recipe:'tips',target:15,batch:13},outputPerUnit:15},
 }]} as ProgressionCatalog;
 const intent={kind:'produce' as const,items:{43:150},consumer:'arrows'},a=accountFromStatus('Example',status,now),method=progressionMethods(intent,a,c).methods[0]!;
 expect(method.maxUnits).toBe(2);
 const step=progressionStep(method,1,intent,a,c),job=JSON.parse(decodeURIComponent(step.args[1]!.slice(6)));
 expect(job.target).toBe(15);
 expect(()=>progressionStep(method,3,intent,a,c)).toThrow('executable batch');
});

test('target-level workers accept finite XP units beyond a recipe batch',()=>{
 const a=accountFromStatus('Example',status,now),intent={kind:'train' as const,skill:'ranged',targetLevel:85};
 const method={id:'ranged/troopers',routeId:'fighter:ranged',ladderIds:[],step:{script:'scripts/ranged-train.ts',args:['99','1500'],env:{TARGET_LEVEL:'99'}},
  effects:{xp:{ranged:1}},rate:{unitsPerTick:1,basis:'model' as const,evidence:'fixture'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},source:'fixture',repeatable:true,
  execution:{targetArg:0,targetEnv:['TARGET_LEVEL']}};
 const step=progressionStep(method,92377,intent,a);
 expect(step.args).toEqual(['85','1500']);
 expect(step.env.TARGET_LEVEL).toBe('85');
 expect(()=>progressionStep(method,Infinity,intent,a)).toThrow('executable batch');
 expect(()=>progressionStep(method,0,intent,a)).toThrow('executable batch');
});

test('the training kit producer remains the same bounded method during acquisition',()=>{
 const a=accountFromStatus('Example',status,now),intent={kind:'acquire' as const,items:{888:20},consumer:'Ranged band'};
 const m=progressionMethods(intent,a).methods.find(m=>m.id==='ranged/guild-buy-mithril');
 expect(m?.effects.items).toEqual({888:20});
 expect(m?.step.script).toBe('scripts/shop-buyer.ts');
 expect(m?.step.env.MAX_ITEMS).toBe('20');
 expect(m?.step.env.STOCK_TARGET).toBe('20');
 expect(m?.effects.xp).toBeUndefined();
});

test('trooper metadata requires the resolved target discriminator',()=>{
 const c={version:1,generatedBy:'fixture',skills:[],methods:[],quests:[],entries:[],routes:[
  {id:'fighter:trooper',category:'fighter',name:'trooper',script:'scripts/gather-combat.ts',args:[],env:{TARGET:'trooper'},intents:['train'],skills:['ranged'],description:'trooper',discriminator:{env:{TARGET:'trooper'}}},
  {id:'fighter:giant',category:'fighter',name:'giant',script:'scripts/gather-combat.ts',args:[],env:{TARGET:'giant'},intents:['train','acquire'],skills:['ranged'],description:'giant',discriminator:{env:{TARGET:'giant'}}},
 ]} as ProgressionCatalog;
 expect(matchingProgressionRoutes('scripts/gather-combat.ts',[],{},c)).toEqual([]);
 expect(matchingProgressionRoutes('scripts/gather-combat.ts',['1500','trooper'],{},c).map(r=>r.id)).toEqual(['fighter:trooper']);
});

test('noted inventory retains its native identity and qualification binds the current source',()=>{
 expect(accountFromStatus('Example',{...status,inventory:[{id:883,baseId:882,count:50}]},now).inventory?.value).toEqual({883:50});
 const c={version:1,generatedBy:'fixture',skills:['crafting'],routes:[],quests:[],entries:[],methods:[{id:'craft',routeId:'craft',ladderIds:[],
  step:{script:'scripts/craft.ts',args:[],env:{}},effects:{xp:{crafting:1}},rate:{unitsPerTick:1,basis:'model',evidence:'fixture'},
  costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},source:'old',qualification:{source:'old',bands:[{}]},repeatable:true,
 }]} as ProgressionCatalog;
 const a=accountFromStatus('Example',status,now),intent={kind:'train' as const,skill:'crafting',targetLevel:40};
 expect(progressionMethods(intent,a,c,{sources:{craft:'new'}}).methods[0]?.qualification).toBeUndefined();
 expect(progressionMethods(intent,a,c,{sources:{craft:'new'},qualifications:{craft:{source:'new',bands:[{levels:{crafting:{min:20,max:50}}}]}}}).methods[0]?.qualification?.source).toBe('new');
});

test('finite market and trade jobs preserve their exact consumer before login',()=>{
 expect(intentForEntry('scripts/buy-owned-ge-item.ts',[],{ITEM_ID:'849',QUANTITY:'1',EXPECTED_OWNED:'0'})).toMatchObject({kind:'acquire',items:{849:1}});
 expect(intentForEntry('scripts/shop-buyer.ts',['dargaud','1600'],{ITEMS:'mithril.arrow|steel.arrow',STOCK_TARGET:'500'})).toMatchObject({kind:'service'});
 expect(intentForEntry('scripts/shop-buyer.ts',['dargaud','1600'],{ITEMS:'mithril.arrow|steel.arrow'})).toBeNull();
 expect(intentForEntry('scripts/fleet-trade.ts',['.practice/orders/one.json'],{})).toMatchObject({kind:'service'});
 expect(intentForEntry('F:/repo/packages/core/src/session-recovery.ts',[],{})).toMatchObject({kind:'service'});
});

test('native finite recipes bind their concrete output identity',()=>{
 const c={version:1,generatedBy:'fixture',skills:['crafting'],routes:[],quests:[],entries:[{script:'scripts/microbot-production.ts',intents:['train','produce'],skills:['crafting'],routeIds:[]}],methods:[{
  id:'cut',routeId:'native',ladderIds:[],step:{script:'scripts/aio-skiller.ts',args:[],env:{}},effects:{items:{1607:1}},source:'fixture',
  rate:{unitsPerTick:null,basis:'unknown',evidence:'fixture'},costs:{setupTicks:null,travelTicks:null,acquisitionTicks:null,unlockTicks:null},
  execution:{bankJob:{family:'inventory',recipe:'cut-sapphire',target:1,batch:13}},
 }]} as ProgressionCatalog;
 expect(intentForEntry('scripts/microbot-production.ts',['cut-sapphire'],{MAX_MAKE:'10'},undefined,c)).toMatchObject({kind:'produce',items:{1607:10}});
});

test('a script-wide proof cannot qualify distinct native methods',()=>{
 const c={version:1,generatedBy:'fixture',skills:['crafting'],routes:[],quests:[],entries:[],methods:[{id:'craft',routeId:'craft',ladderIds:[],
  step:{script:'scripts/craft.ts',args:[],env:{}},effects:{xp:{crafting:1}},rate:{unitsPerTick:1,basis:'model',evidence:'fixture'},
  costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},source:'current',repeatable:true,
 }]} as ProgressionCatalog;
 const methods=progressionMethods({kind:'train',skill:'crafting',targetLevel:40},accountFromStatus('Example',status,now),c,{qualifications:{'scripts/craft.ts':{source:'current',bands:[{}]}}}).methods;
 expect(methods[0]?.qualification).toBeUndefined();
});

test('authored starter and inside-altar workers retain their actual finite defaults',()=>{
 expect(intentForEntry('scripts/ranged-starter.ts',[],{})).toEqual({kind:'train',skill:'ranged',targetLevel:5});
 expect(intentForEntry('scripts/ranged-starter.ts',['99'],{TARGET_LEVEL:'99'})).toEqual({kind:'train',skill:'ranged',targetLevel:5});
 expect(intentForEntry('scripts/generated/rcair.ts',[],{})).toEqual({kind:'service',objective:'craft current carried rune essence into air runes once',units:1});
 expect(intentForEntry('scripts/aio.ts',['skiller','runecraft','air'],{})).toEqual(intentForEntry('scripts/generated/rcair.ts',[],{}));
 expect(intentForEntry('scripts/ranged-starter.ts',[],{},{bank:{536:10}})).toMatchObject({kind:'acquire',items:{536:10}});
 expect(intentForEntry('scripts/generated/rcair.ts',[],{},{skills:{Runecraft:20}})).toEqual({kind:'train',skill:'runecraft',targetLevel:20});
 expect(intentForEntry('scripts/unknown-fixed-craft.ts',[],{})).toBeNull();
});

test('spawn acquisition follows positional item and quantity defaults with a finite tick cap',()=>{
 expect(intentForEntry('scripts/gather-spawn.ts',['554'],{})).toMatchObject({kind:'acquire',items:{554:27}});
 expect(intentForEntry('scripts/gather-spawn.ts',['554','3'],{TARGET:'99',ITEM_ID:'557',TICKS:'100'})).toMatchObject({kind:'acquire',items:{554:3}});
 for(const [args,env]of [[[],{}],[['0'],{}],[['NaN'],{}],[['554','0'],{}],[['554','Infinity'],{}],[['554'],{TICKS:'Infinity'}],[['554'],{TICKS:'0'}]] as const)
  expect(intentForEntry('scripts/gather-spawn.ts',args,env)).toBeNull();
});

test('jewellery TARGET is an item count and never the current Crafting level',()=>{
 expect(intentForEntry('scripts/microbot-jewellery-trip.ts',[],{RECIPE:'sapphire_ring',TARGET:'1',BATCH:'1'})).toMatchObject({kind:'produce',items:{1637:1}});
 expect(intentForEntry('scripts/aio.ts',['skiller','crafting','jewellery-trip','RECIPE=sapphire_ring','TARGET=1','BATCH=1'],{})).toMatchObject({kind:'produce',items:{1637:1}});
 expect(intentForEntry('scripts/microbot-jewellery-trip.ts',[],{RECIPE:'not-native',TARGET:'1'})).toBeNull();
 expect(intentForEntry('scripts/microbot-jewellery-trip.ts',[],{RECIPE:'sapphire_ring',TARGET:'Infinity'})).toBeNull();
});

test('trainer defaults and overrides match each authored worker contract',()=>{
 const rows=[
  {script:'scripts/generated/fishing30.ts',skill:'fishing',target:30,cap:3000},
  {script:'scripts/generated/thieving60.ts',skill:'thieving',target:60,cap:2500},
  {script:'scripts/generated/woodcutting.ts',skill:'woodcutting',target:45,cap:3000},
 ];
 for(const row of rows){
  const source=readFileSync(resolve(import.meta.dir,'../../..',row.script),'utf8');
  expect(source).toContain(`Number(process.env.TARGET ?? ${row.target})`);expect(source).toContain(`Number(process.env.CAP ?? ${row.cap})`);
  expect(intentForEntry(row.script,[],{})).toEqual({kind:'train',skill:row.skill,targetLevel:row.target});
  expect(intentForEntry(row.script,['99'],{TARGET:'55',CAP:'1000'})).toEqual({kind:'train',skill:row.skill,targetLevel:55});
  for(const env of [{TARGET:'Infinity'},{TARGET:'NaN'},{TARGET:'0'},{TARGET:'100'},{CAP:'Infinity'},{CAP:'0'}])expect(intentForEntry(row.script,[],env)).toBeNull();
 }
 const source=readFileSync(resolve(import.meta.dir,'../../../scripts/ranged-train.ts'),'utf8');
 expect(source).toContain('target:n(argv[3]??env.TARGET_LEVEL,10)');expect(source).toContain('cap:n(argv[4]??env.CAP,3000)');
 expect(intentForEntry('scripts/ranged-train.ts',[],{})).toEqual({kind:'train',skill:'ranged',targetLevel:10});
 expect(intentForEntry('scripts/ranged-train.ts',['50','800'],{TARGET_LEVEL:'99',CAP:'Infinity'})).toEqual({kind:'train',skill:'ranged',targetLevel:50});
 for(const env of [{TARGET_LEVEL:'Infinity'},{TARGET_LEVEL:'NaN'},{TARGET_LEVEL:'1'},{CAP:'Infinity'},{CAP:'799'}])expect(intentForEntry('scripts/ranged-train.ts',[],env)).toBeNull();
});

test('fixed quest entry aliases carry their exact named finite quest consumer',()=>{
 const rows=[['scripts/generated/dwarfcannon.ts','Dwarf Cannon'],['scripts/generated/waterfall.ts','Waterfall Quest']] as const;
 for(const[script,quest]of rows)expect(intentForEntry(script,[],{})).toEqual({kind:'quest',quest});
 const flags=readFileSync(resolve(import.meta.dir,'../../../vendor/rs-sdk/server/content/scripts/player/interfaces/questlist.if'),'utf8');
 for(const[id,name]of [['barcrawl',"Alfred Grimhand's Barcrawl"],['magearena','The Mage Arena']]){
  expect(flags).not.toContain('text='+name);
  expect(intentForEntry('scripts/generated/quest-'+id+'.ts',[],{})).toEqual({kind:'service',objective:'quester:quest:'+id});
 }
});

test('native cannonball quantities and bounds match the actual smelting order contract',()=>{
 expect(intentForEntry('scripts/microbot-a-cannonballs.ts',[],{})).toMatchObject({kind:'produce',items:{2:4}});
 expect(intentForEntry('scripts/microbot-a-cannonballs.ts',['27','1500'],{CANNON_XP_RATE:'25'})).toMatchObject({kind:'produce',items:{2:108}});
 expect(intentForEntry('scripts/aio.ts',['skiller','smithing','cannonballs','2','1500','CANNON_XP_RATE=25'],{})).toMatchObject({kind:'produce',items:{2:8}});
 for(const[bars,cap,xpRate,reserve]of [[0,1200,1,0],[100001,1200,1,0],[1,0,1,0],[1,10001,1,0],[1,1200,0,0],[1,1200,1001,0],[1,1200,1,-1],[1,Infinity,1,0]]){
  expect(()=>validateSmeltOrder({bar:'cannonballs',maximum:bars!,cap:cap!,xpRate:xpRate!,reserve:reserve!,mode:'exact'})).toThrow();
  expect(intentForEntry('scripts/microbot-a-cannonballs.ts',[String(bars),String(cap)],{CANNON_XP_RATE:String(xpRate),CANNON_RESERVE:String(reserve)})).toBeNull();
 }
});
