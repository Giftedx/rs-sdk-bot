import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateSmeltOrder} from '../../../scripts/smelt-batch';
import {parseCoins} from '../../workers/src/logistics';
import {accountFromStatus,catalogCoverage,intentForEntry,loadProgressionCatalog,matchingProgressionRoutes,progressionMethods,progressionStep,type ProgressionCatalog} from '../src/progression-catalog';
import {preflightProgressionWork} from '../../core/src/progression-session';
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

test('the finite Prayer trainer keeps its matching skill goal above retained bone postconditions',()=>{
 const env={BONE_ID:'536',MAX_BURY:'105',BONE_RESERVE:'6',CAP:'1500'};
 const accept={skills:{Prayer:99},bank:{536:6}};
 expect(intentForEntry('scripts/train-prayer.ts',['99'],env,accept)).toEqual({kind:'train',skill:'prayer',targetLevel:99});
 expect(intentForEntry('scripts/train-prayer.ts',['96'],{...env,BONE_ID:'526',MAX_BURY:'469'},{skills:{Prayer:96},bank:{526:44,536:6}})).toEqual({kind:'train',skill:'prayer',targetLevel:96});
 expect(intentForEntry('scripts/train-prayer.ts',[],{TARGET_LEVEL:'60',BONE_RESERVE:'384'},{skills:{prayer:60},bank:{526:384}})).toEqual({kind:'train',skill:'prayer',targetLevel:60});
 for(const [args,changed,goal] of [
  [['98'],{},accept], [['99'],{BONE_ID:'999'},accept], [['99'],{BONE_RESERVE:'5'},accept],
  [['99'],{BONE_RESERVE:'7'},accept], [['99'],{BURY_HELD:'1'},accept], [['99'],{CAP:'0'},accept],
  [['99'],{MAX_BURY:'0'},accept], [['99','extra'],{},accept], [['99'],{},{skills:{Ranged:99},bank:{536:6}}],
  [['99'],{},{skills:{Prayer:99,prayer:99},bank:{536:6}}], [['99'],{},{skills:{Prayer:99},bank:{526:6}}],
 ] as const)expect(intentForEntry('scripts/train-prayer.ts',args,{...env,...changed},goal)).toMatchObject({kind:'acquire'});
 expect(intentForEntry('scripts/train-prayer.ts',['99'],env,{bank:{536:6}})).toMatchObject({kind:'acquire'});
 expect(intentForEntry('scripts/gather-combat.ts',['1500','giant'],{TRAIN_SKILL:'Prayer',TARGET_LEVEL:'99'},accept)).toMatchObject({kind:'acquire',items:{536:6}});
});

test('unknown scripts and missing finite goals remain explicit',()=>{
 expect(intentForEntry('scripts/not-a-route.ts',[],{})).toBeNull();
 expect(intentForEntry('scripts/gather-combat.ts',['1500','trooper'],{})).toBeNull();
});

test('coin courier binds both normalized participants to one exact finite transfer without wealth credit',()=>{
 const env={COORDINATOR_PARTICIPANTS:'["Donor","Receiver"]'},options=['--reserve=5000','--bank-x=3185','--bank-z=3436','--timeout-ms=60000'];
 const expected={kind:'service' as const,objective:'finite owned coin transfer Donor -> Receiver: 45000 coins; donor bank reserve 5000'};
 for(const args of [['Receiver','45000',...options],['Donor','Receiver','45000',...options]]){
  expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier',...args],env)).toEqual(expected);
  expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier',...args],env,{bank:{995:45000}})).toEqual(expected);
 }
 expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier','Donor','Receiver','1'],{})).toEqual({kind:'service',objective:'finite owned coin transfer Donor -> Receiver: 1 coins; donor bank reserve 0'});
 for(const args of [[],['Receiver','45000'],['Other','Receiver','45000'],['Donor','Other','45000'],['Donor','Donor','1'],['Haggis','Receiver','1'],['Donor','Receiver','0'],['Donor','Receiver','2147483648'],['Donor','Receiver','1.5'],['Donor','Receiver','NaN'],['Donor','Receiver','1','--reserve=-1'],['Donor','Receiver','1','--reserve=2147483648'],['Donor','Receiver','1','--reserve=1','--reserve=2'],['Donor','Receiver','1','--unknown=1'],['Donor','Receiver','1','--notes'],['Donor','Receiver','1','--keep=Coins'],['Donor','Receiver','1','--bank-x=16384'],['Donor','Receiver','1','--request-ms=60001'],['Donor','Receiver','1','--request-ms=60000','--timeout-ms=59999'],['Donor','Receiver','1','--timeout-ms=600001'],['Donor','Receiver','1','--grace-ms=0'],['Donor','Receiver','1','--approach-ms=999']]){
  expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier',...args],args.length===2?{}:env,{bank:{995:1}})).toBeNull();
 }
 for(const participants of ['bad','["Donor"]','["Donor","Donor"]','["Donor","Receiver","Other"]'])expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier','Receiver','45000'],{COORDINATOR_PARTICIPANTS:participants})).toBeNull();
 for(const amount of ['1','2147483647'])for(const flags of [[],['--reserve=2147483647'],['--bank-x=1','--bank-z=16383','--approach-ms=1800000','--request-ms=60000','--timeout-ms=600000','--grace-ms=1000']]){
  const parsed=parseCoins(['Donor','Receiver',amount,...flags]);
  const expected={kind:'service' as const,objective:`finite owned coin transfer Donor -> Receiver: ${parsed.amount} coins; donor bank reserve ${parsed.reserve}`};
  expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier','Donor','Receiver',amount,...flags],env)).toEqual(expected);
  expect(intentForEntry('scripts/aio-logistics.ts',['coin-courier','Receiver',amount,...flags],env)).toEqual(expected);
 }
});

test('the finite Prayer trainer keeps its matching skill goal above retained bone postconditions',()=>{
 const env={BONE_ID:'536',MAX_BURY:'105',BONE_RESERVE:'6',CAP:'1500'};
 const accept={skills:{Prayer:99},bank:{536:6}};
 expect(intentForEntry('scripts/train-prayer.ts',['99'],env,accept)).toEqual({kind:'train',skill:'prayer',targetLevel:99});
 expect(intentForEntry('scripts/train-prayer.ts',['96'],{...env,BONE_ID:'526',MAX_BURY:'469'},{skills:{Prayer:96},bank:{526:44,536:6}})).toEqual({kind:'train',skill:'prayer',targetLevel:96});
 expect(intentForEntry('scripts/train-prayer.ts',[],{TARGET_LEVEL:'60',BONE_RESERVE:'384'},{skills:{prayer:60},bank:{526:384}})).toEqual({kind:'train',skill:'prayer',targetLevel:60});
 for(const [args,changed,goal] of [
  [['98'],{},accept], [['99'],{BONE_ID:'999'},accept], [['99'],{BONE_RESERVE:'5'},accept],
  [['99'],{BONE_RESERVE:'7'},accept], [['99'],{BURY_HELD:'1'},accept], [['99'],{CAP:'0'},accept],
  [['99'],{MAX_BURY:'0'},accept], [['99','extra'],{},accept], [['99'],{},{skills:{Ranged:99},bank:{536:6}}],
  [['99'],{},{skills:{Prayer:99,prayer:99},bank:{536:6}}], [['99'],{},{skills:{Prayer:99},bank:{526:6}}],
 ] as const)expect(intentForEntry('scripts/train-prayer.ts',args,{...env,...changed},goal)).toMatchObject({kind:'acquire'});
 expect(intentForEntry('scripts/train-prayer.ts',['99'],env,{bank:{536:6}})).toMatchObject({kind:'acquire'});
 expect(intentForEntry('scripts/gather-combat.ts',['1500','giant'],{TRAIN_SKILL:'Prayer',TARGET_LEVEL:'99'},accept)).toMatchObject({kind:'acquire',items:{536:6}});
});

test('bounded earth shop refill and splash training preserve finite intents',()=>{
 expect(intentForEntry('scripts/aio-market.ts',['earth-shop','betty','16000','2000'],{STOCK_TARGET:'53',MAX_ITEMS:'50',MAX_SPEND:'2000',COIN_RESERVE:'30000',EARTH_SEED_USED:'0'})).toMatchObject({kind:'acquire',items:{557:53}});
 expect(intentForEntry('scripts/aio-market.ts',['earth-shop','aubury','1600','STOCK_TARGET=53','MAX_ITEMS=50','MAX_SPEND=2000','COIN_RESERVE=30000'],{})).toMatchObject({kind:'acquire',items:{557:53}});
 expect(intentForEntry('scripts/aio-market.ts',['earth-shop','catherby','1600'],{STOCK_TARGET:'53',MAX_ITEMS:'50',MAX_SPEND:'2000',COIN_RESERVE:'30000'})).toBeNull();
 expect(intentForEntry('scripts/splash-train.ts',['66','6000'],{})).toEqual({kind:'train',skill:'magic',targetLevel:66});
});

const geFixtureEntry='packages/practice/src/ge-bulk-order-proof.ts';
test('native GE seller has a truthful finite offer intent through its actual helper entry',()=>{
 const intent=intentForEntry(geFixtureEntry,['--sell','flgesell1','2357','2','4900']);
 expect(intent).toMatchObject({kind:'service',units:1});
 for(const value of ['2','2357','4900'])expect(intent?.kind==='service'&&intent.objective).toContain(value);
});
test('native snapshot is an observation instead of a claimed purchase or sale',()=>{
 expect(intentForEntry(geFixtureEntry,['--snapshot','flgebuy1'])).toMatchObject({kind:'observe',units:1});
});
test('helper intent never authorizes the practice-only program on the live server',()=>{
 const c=loadProgressionCatalog();
 for(const args of [['--sell','flgesell1','2357','2','4900'],['--snapshot','flgebuy1']]){
  const work={script:geFixtureEntry,args,env:{}};
  expect(()=>preflightProgressionWork(work,'rs-sdk-demo.fly.dev',c,args[1])).toThrow('local practice only');
  expect(()=>preflightProgressionWork(work,'127.0.0.1:28888',c,args[1])).not.toThrow();
 }
});
test('malformed or unbounded seller and snapshot arguments stay unsupported',()=>{
 for(const args of [[],['--sell'],['--sell','flgesell1','2357','0','4900'],['--sell','flgesell1','2357','2','0'],
  ['--sell','flgesell1','995','2','4900'],['--sell','flgesell1','2357','1.5','4900'],
  ['--sell','flgesell1','2357','2','2147483647'],['--sell','flgesell1','2147483648','1','1'],
  ['--sell','flgesell1','2357','2','4900','extra'],['--sell','bad/name','2357','2','4900'],
  ['--snapshot'],['--snapshot','flgebuy1','extra'],['--snapshot','bad/name'],['--unknown','flgebuy1']])
  expect(intentForEntry(geFixtureEntry,args)).toBeNull();
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
 expect(m?.step.script).toBe('scripts/aio-market.ts');
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
 expect(intentForEntry('scripts/aio-market.ts',['ge-buy'],{ITEM_ID:'849',QUANTITY:'1',EXPECTED_OWNED:'0'})).toMatchObject({kind:'acquire',items:{849:1}});
 expect(intentForEntry('scripts/aio-market.ts',['shop-buy','dargaud','1600'],{ITEMS:'mithril.arrow|steel.arrow',STOCK_TARGET:'500'})).toMatchObject({kind:'service'});
 expect(intentForEntry('scripts/aio-market.ts',['shop-buy','dargaud','1600'],{ITEMS:'mithril.arrow|steel.arrow'})).toBeNull();
 expect(intentForEntry('scripts/aio-logistics.ts',['fleet-trade','.practice/orders/one.json'],{})).toMatchObject({kind:'service'});
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

test('PvP kit staging retains its exact two-cheese consumer and bounded cap',()=>{
 expect(intentForEntry('scripts/pvp-kit-stage.ts',[],{})).toEqual({kind:'acquire',items:{1985:2},consumer:'scripts/pvp-kit-stage.ts'});
 expect(intentForEntry('scripts/pvp-kit-stage.ts',['2000'],{CONSUMER:'starter PvP kit'})).toEqual({kind:'acquire',items:{1985:2},consumer:'starter PvP kit'});
 expect(intentForEntry('scripts/aio-pvp.ts',['stage-kit','2000','STALL_TICKS=6000'],{})).toEqual(intentForEntry('scripts/pvp-kit-stage.ts',['2000'],{}));
 for(const cap of ['0','2001','1.5','NaN','Infinity']) expect(intentForEntry('scripts/pvp-kit-stage.ts',[cap],{})).toBeNull();
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
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','foraging','spawn','554'],{})).toMatchObject({kind:'acquire',items:{554:27}});
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','foraging','spawn','554','3'],{TARGET:'99',ITEM_ID:'557',TICKS:'100'})).toMatchObject({kind:'acquire',items:{554:3}});
 for(const [args,env]of [[[],{}],[['0'],{}],[['NaN'],{}],[['554','0'],{}],[['554','Infinity'],{}],[['554'],{TICKS:'Infinity'}],[['554'],{TICKS:'0'}]] as const)
  expect(intentForEntry('scripts/aio-skiller.ts',['gather','foraging','spawn',...args],env)).toBeNull();
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

test('owned earth production retains its finite acquisition intent and bounds',()=>{
 expect(intentForEntry('scripts/earth-production.ts',['talismans','20000'],{STOCK_TARGET:'103',COIN_RESERVE:'30000',HUNT_KILLS_PER_TARGET:'1'})).toMatchObject({kind:'acquire',items:{557:103}});
 expect(intentForEntry('scripts/earth-production.ts',['craft','20000'],{STOCK_TARGET:'103',COIN_RESERVE:'30000'})).toMatchObject({kind:'acquire',items:{557:103}});
 expect(intentForEntry('scripts/aio-skiller.ts',['magic','earth-production','craft','1400','STOCK_TARGET=1','COIN_RESERVE=0'],{})).toMatchObject({kind:'acquire',items:{557:1}});
 for(const [args,env]of [[['bad','20000'],{STOCK_TARGET:'103',COIN_RESERVE:'30000'}],[['talismans','0'],{STOCK_TARGET:'103',COIN_RESERVE:'30000'}],[['craft','20001'],{STOCK_TARGET:'103',COIN_RESERVE:'30000'}],[['craft','2000'],{STOCK_TARGET:'0',COIN_RESERVE:'30000'}],[['talismans','2000'],{STOCK_TARGET:'103',COIN_RESERVE:'30000',HUNT_KILLS_PER_TARGET:'4'}]] as const)
  expect(intentForEntry('scripts/earth-production.ts',args,env)).toBeNull();
});

test('edgeville woodcutting, magic-items, smelt-bars, staged runes and bounded service scripts enforce finite bounds',()=>{
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','woodcutting','edgeville','3000'],{STALL_TICKS:'0'})).toEqual({kind:'train',skill:'woodcutting',targetLevel:36});
 for(const stall of ['-1','1.5','NaN','Infinity'])expect(intentForEntry('scripts/aio-skiller.ts',['gather','woodcutting','edgeville','3000'],{STALL_TICKS:stall})).toBeNull();
 expect(intentForEntry('scripts/microbot-magic-items.ts',['enchant:sapphire_ring','-','3','200'],{})).toEqual({kind:'service',objective:'magic-items:enchant:sapphire_ring:3',units:1});
 expect(intentForEntry('scripts/microbot-magic-items.ts',['superheat:mithril','-','10','400'],{})).toEqual({kind:'service',objective:'magic-items:superheat:mithril:10',units:1});
 for(const args of [['bad-mode','-','3','200'],['high-alch','-','0','200'],['high-alch','-','10001','200'],['high-alch','-','1','0'],['high-alch','-','1','100001']])
  expect(intentForEntry('scripts/microbot-magic-items.ts',args,{})).toBeNull();
 expect(intentForEntry('scripts/smelt-bars.ts',[],{ORDER_ACTION:'smith',PRODUCT_ID:'1119',MAX_MAKE:'1'})).toMatchObject({kind:'service'});
 expect(intentForEntry('scripts/rune-bank-craft.ts',['--staged=/tmp/run.json'],{})).toEqual({kind:'service',objective:'rune-carriers',units:1});
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','mining','progressive','job.json'],{})).toEqual({kind:'service',objective:'scripts/aio-skiller.ts:job.json',units:1});
 expect(intentForEntry('scripts/gather-combat.ts',['1500','giant'],{})).toEqual({kind:'service',objective:'gather-combat:giant',units:1});
 expect(intentForEntry('scripts/gather-combat.ts',['1500','trooper'],{})).toBeNull();
 expect(intentForEntry('scripts/fletch-arrows.ts',['bronze','10'],{CAP:'600'})).toEqual({kind:'service',objective:'fletch-arrows:bronze',units:1});
 expect(intentForEntry('scripts/fletch-arrows.ts',['bronze','10'],{CAP:'Infinity'})).toBeNull();
});

test('an entry with a missing order file, an unknown recipe, a bad count or no stated bound has no finite goal',()=>{
 const c=loadProgressionCatalog(),job=(o:unknown)=>['bank-job','--job='+encodeURIComponent(JSON.stringify(o))];
 const known=c.methods.find(m=>m.execution?.bankJob&&Object.keys(m.effects.items??{}).length===1&&!m.effects.xp)!.execution!.bankJob!;
 expect(intentForEntry('scripts/aio-skiller.ts',['bank-job','no-such-order.json'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',job({family:'nope',recipe:'nope'}),{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',job({family:'nope',recipe:'nope',target:5}),{},undefined,c)).toBeNull();
 for(const target of [-5,0,1.5,undefined])expect(intentForEntry('scripts/aio-skiller.ts',job({family:known.family,recipe:known.recipe,target}),{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',job({family:known.family,recipe:known.recipe,target:5}),{},undefined,c)).toMatchObject({kind:'produce'});
 expect(intentForEntry('scripts/microbot-jewellery-trip.ts',['no-such-order.json'],{},undefined,c)).toBeNull();
 for(const entry of ['sell-owned-ge-item','buy-owned-sword','alch-train','splash-train','quest-order'])
  expect(intentForEntry(`scripts/${entry}.ts`,[],{},undefined,c),entry).toBeNull();
 expect(intentForEntry('scripts/aio-logistics.ts',['food-courier'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','thieving','knights-stable'],{},undefined,c),'goldfarm-stable').toBeNull();
 expect(intentForEntry('scripts/fletch-arrows.ts',['0','bronze'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','thieving','knights-stable'],{TICKS:'0'},undefined,c)).toBeNull();
 // A stated bound keeps the entry, and the workers with their own default tick cap run bare.
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','thieving','knights-stable'],{TICKS:'9000'},undefined,c)).toMatchObject({kind:'service'});
 expect(intentForEntry('scripts/fletch-arrows.ts',['600','shafts'],{MAX_MAKE:'1'},undefined,c)).toMatchObject({kind:'service'});
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','mining','ore'],{},undefined,c)).toMatchObject({kind:'service'});
});

test('a smelt order with a bar count keeps its produce intent; a smelt order with only a tick cap is a service',()=>{
 const c=loadProgressionCatalog();
 expect(intentForEntry('scripts/smelt-bars.ts',['1500','steel'],{MAX_MAKE:'28'},undefined,c)).toEqual({kind:'produce',items:{2353:28},consumer:'scripts/smelt-bars.ts'});
 expect(intentForEntry('scripts/smelt-bars.ts',['600','steel'],{},undefined,c)).toEqual({kind:'service',objective:'smelt:steel',units:1});
 expect(intentForEntry('scripts/smelt-bars.ts',['0','steel'],{},undefined,c)).toBeNull();
});

test('a time limit in a flag is a stated bound: quest-order with --timeout-ms has a finite goal, without it or with a bad value it has none',()=>{
 const c=loadProgressionCatalog(),order=(...rest:string[])=>intentForEntry('scripts/quest-order.ts',['cook',...rest],{},undefined,c);
 expect(order('--save=out.sav','--timeout-ms=300000')).toEqual({kind:'service',objective:'quest-order:cook',units:1});
 for(const bad of [[],['--save=out.sav'],['--timeout-ms=0'],['--timeout-ms=-5'],['--timeout-ms=1.5'],['--timeout-ms='],['--timeout-ms=abc']])expect(order(...bad),bad.join(' ')).toBeNull();
 // The flag states a bound for the entries that need one and changes none that did not.
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','thieving','knights-stable'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-skiller.ts',['gather','thieving','knights-stable','--timeout-ms=1000'],{},undefined,c)).toMatchObject({kind:'service'});
});

test('bounded bank-to-GE and shop-to-bid market routes admit valid finite requests and reject malformed inputs',()=>{
 const c=loadProgressionCatalog();
 expect(intentForEntry('scripts/aio-market.ts',['ge-sell'],{FROM_BANK:'1',ITEM_ID:'861',QUANTITY:'17',SELL_PRICE:'95000',FLOOR_PRICE:'95000',ORDER_MS:'60000'},undefined,c)).toEqual({kind:'service',objective:'sell-owned-ge-item:861:17:95000',units:1});
 expect(intentForEntry('scripts/aio-market.ts',['ge-sell'],{ITEM_ID:'995',QUANTITY:'17',SELL_PRICE:'1',FLOOR_PRICE:'1'},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-market.ts',['ge-sell'],{ITEM_ID:'861',QUANTITY:'17',SELL_PRICE:'90000',FLOOR_PRICE:'95000'},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-market.ts',['shop-to-bid','sarim','313'],{LOTS:'1',UNITS:'5000',MIN_NET:'50'},undefined,c)).toEqual({kind:'service',objective:'shop-to-bid:sarim:313',units:1});
 expect(intentForEntry('scripts/aio-market.ts',['shop-to-bid','--scan'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-market.ts',['shop-to-bid','sarim','0'],{},undefined,c)).toBeNull();
 expect(intentForEntry('scripts/aio-market.ts',['shop-to-bid','sarim','313'],{LOTS:'0'},undefined,c)).toBeNull();
 const dir=mkdtempSync(join(tmpdir(),'ge-cat-'));
 try{
  const tripFile=join(dir,'trip.json'),sellerFile=join(dir,'seller.json');
  writeFileSync(tripFile,JSON.stringify({actor:'YewFirst',server:'rs-sdk-demo.fly.dev',goal:'bid-861',item:861,quantity:17,price:95000,floor:95000,reserve:0,deadline:Date.now()+60000,fillWait:40,cap:1200}));
  writeFileSync(sellerFile,JSON.stringify({actor:'Ballspinner',server:'rs-sdk-demo.fly.dev',goal:'flax-bid',allTradeable:true,protect:[],reserves:{},maxItems:1,maxUnits:24,perItem:24,discount:0,floor:1,unitCap:100,fillWait:40,deadline:Date.now()+60000,cap:1500,childCap:1200}));
  expect(intentForEntry('scripts/aio-market.ts',['ge-trip',tripFile],{},undefined,c)).toEqual({kind:'service',objective:'ge-trip:861:17:95000',units:1});
  expect(intentForEntry('scripts/aio-market.ts',['ge-trip',join(dir,'missing.json')],{},undefined,c)).toBeNull();
  expect(intentForEntry('scripts/aio-market.ts',['bank-seller',sellerFile],{},undefined,c)).toEqual({kind:'service',objective:'bank-seller:flax-bid:1:24',units:1});
  writeFileSync(sellerFile,JSON.stringify({actor:'Ballspinner',server:'rs-sdk-demo.fly.dev',goal:'bad',allTradeable:false}));
  expect(intentForEntry('scripts/aio-market.ts',['bank-seller',sellerFile],{},undefined,c)).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('unified skiller gather routes retain escorted lava-maze pvp intent and bare grapes default cap',()=>{
 const c=loadProgressionCatalog();
 expect(intentForEntry('scripts/aio-skiller.ts',['mining','lava-maze','Buddy','CAP=1800','MAX_ORE=1','EXPECTED_BANK_ORE=0'],{},undefined,c)).toEqual({kind:'pvp',objective:'skiller:mining:lava-maze'});
 expect(intentForEntry('scripts/aio-skiller.ts',['foraging','grapes'],{},undefined,c)).toEqual({kind:'service',objective:'grapes:skiller:foraging:grapes',units:1});
});
