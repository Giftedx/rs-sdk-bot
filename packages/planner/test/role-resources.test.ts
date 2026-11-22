import {expect,test} from 'bun:test';
import {formatStep} from '../../core/src/chain-step';
import {resolveAioStep,planProgressiveSkiller} from '../../../scripts/aio';
import {readBankJobArgument} from '../../../scripts/aio-skiller';
import {AIO_PLACES,BLACK_CAVE,CAPACITY,COW_FIELD,TROOPER_FIELD,SPLASH_FENCE,STRIKE_TILE,
    catalogue,claimFor,jobFor,jobResources,plan,reservedResources,type Acct} from '../src/autopilot';

const command = (category:string,args:string[],env:Record<string,string>={}) => ({script:'scripts/aio.ts',args:[category,...args],env});

test('raw, standalone AIO, master AIO and chain spellings claim the same actual worker location',()=>{
 const routes: {category:string;args:string[];expected:string[]}[] = [
  {category:'fighter',args:['trooper'],expected:[TROOPER_FIELD]},
  {category:'fighter',args:['cow','COW_BANK_PROFILE=north'],expected:[COW_FIELD]},
  {category:'fighter',args:['cow'],expected:[COW_FIELD]},
  {category:'fighter',args:['chicken'],expected:['pen:3229,3298']},
  {category:'fighter',args:['chicken','TRAIN_BANK=ardougne'],expected:['pen:2691,3277']},
  {category:'fighter',args:['ranged'],expected:['pen:3229,3298',TROOPER_FIELD]},
  {category:'fighter',args:['ranged','PROGRESSION_METHOD=ranged/chickens'],expected:['pen:3229,3298']},
  {category:'fighter',args:['ranged','PROGRESSION_METHOD=ranged/troopers'],expected:[TROOPER_FIELD]},
  {category:'fighter',args:['ranged','PROGRESSION_METHOD=ranged/guild-willow-mithril'],expected:[TROOPER_FIELD]},
  {category:'fighter',args:['ranged','PROGRESSION_METHOD=unknown'],expected:['pen:3229,3298',TROOPER_FIELD]},
  {category:'boss',args:['black-dragon'],expected:[BLACK_CAVE]},
  {category:'market',args:['shop-buy','harry','CAP=500'],expected:['shop:harry']},
  {category:'market',args:['shop-buy'],expected:['shop:catherby']},
  {category:'skiller',args:['fishing','cage','CAP=500'],expected:['catherby:lobster']},
  {category:'skiller',args:['fishing','cage','METHOD=harpoon'],expected:['catherby:lobster']},
  {category:'skiller',args:['fishing','harpoon'],expected:[]},
  {category:'skiller',args:['woodcutting'],expected:[AIO_PLACES.yews]},
  {category:'skiller',args:['foraging'],expected:[AIO_PLACES.flax]},
  {category:'skiller',args:['foraging','feathers','PEN=3017,3288'],expected:['pen:3017,3288']},
  {category:'skiller',args:['foraging','feathers','PEN=invalid'],expected:['pen:3229,3298']},
  {category:'skiller',args:['foraging','feathers','PEN=03017,03288'],expected:['pen:3017,3288']},
  {category:'skiller',args:['mining'],expected:[AIO_PLACES.ore]},
  {category:'skiller',args:['mining','ore','ORE_PROFILE=clay'],expected:[]},
  {category:'skiller',args:['mining','essence'],expected:[AIO_PLACES.essence]},
  {category:'skiller',args:['runecraft','air'],expected:[AIO_PLACES.air]},
  {category:'skiller',args:['runecraft','bank-craft','99','RUNE_ALTAR=air','ESSENCE_TARGET=28'],expected:[AIO_PLACES.air]},
  {category:'skiller',args:['runecraft'],expected:[]},
  {category:'skiller',args:['thieving','KNIGHT_SPOT=2671,3313'],expected:['knight:2671,3313']},
  {category:'skiller',args:['thieving','blood-chest'],expected:[AIO_PLACES.blood]},
  {category:'skiller',args:['magic','splash'],expected:[SPLASH_FENCE]},
  {category:'skiller',args:['magic','splash-coop'],expected:['pen:3229,3298']},
  {category:'skiller',args:['magic','alch-train','21','1500'],expected:[STRIKE_TILE]},
  {category:'skiller',args:['magic','alch-train','99','1500'],expected:[STRIKE_TILE]},
  {category:'skiller',args:['woodcutting','yews','REGION=draynor'],expected:[]},
  {category:'skiller',args:['woodcutting','yews','REGION=lumbridge'],expected:[]},
  {category:'skiller',args:['woodcutting','yews','WOOD_GROVE=native-processing','TREE=willow'],expected:[]},
  {category:'skiller',args:['woodcutting','yews','WOOD_GROVE=native-processing','TREE=magic'],expected:[]},
  {category:'skiller',args:['woodcutting','yews','WOOD_GROVE=native-processing','TREE=maple'],expected:[AIO_PLACES.yews]},
 ];
 for(const {category,args,expected} of routes){
  const actual=resolveAioStep(category,args);
  expect(jobResources(actual),category+':'+args.join(' ')).toEqual(expected);
  expect(jobResources(command(category,args))).toEqual(expected);
  expect(jobResources({script:`scripts/aio-${category}.ts`,args})).toEqual(expected);
  expect(jobResources({script:'scripts/chain.ts',args:[formatStep({script:'scripts/aio.ts',args:[category,...args],env:{}})]})).toEqual(expected);
 }
});

test('dispatch defaults and explicit options preserve worker precedence without mixing separate sites',()=>{
 expect(jobResources(command('fighter',['cow'],{TARGET:'trooper'}))).toEqual([COW_FIELD]);
 expect(jobResources(command('fighter',['cow','TARGET=trooper']))).toEqual([TROOPER_FIELD]);
 expect(jobResources(command('fighter',['cow','1500','trooper']))).toEqual([TROOPER_FIELD]);
 expect(jobResources(command('fighter',['chicken'],{TRAIN_BANK:'ardougne'}))).toEqual(['pen:3229,3298']);
 expect(jobResources(command('skiller',['magic','splash-coop'],{SPLASH_SITE:'ardougne'}))).toEqual(['pen:3229,3298']);
 expect(jobResources(command('skiller',['magic','splash-coop','SPLASH_SITE=ardougne']))).toEqual([SPLASH_FENCE]);
 const pipeline=['fighter:trooper TARGET_LEVEL=70','skiller:foraging:feathers PEN=3017,3288','market:shop-buy "harry" CAP=500'];
 expect(jobResources({script:'scripts/aio.ts',args:['pipeline',...pipeline]})).toEqual([TROOPER_FIELD,'pen:3017,3288','shop:harry']);
 expect(jobResources({script:'scripts/black-dragon-camp.ts',resources:[]})).toEqual([]);
 expect(jobResources({script:'scripts/aio-skiller.ts',args:['gather','fishing','harpoon'],env:{METHOD:'harpoon'}})).toEqual([]);
 expect(jobResources({script:'scripts/aio-skiller.ts',args:['gather','fishing','cage','CAGE']})).toEqual(['catherby:lobster']);
});

test('named selectors, default positional arguments and worker aliases match the actual dispatcher',()=>{
 const routes:[string,string[],string[]][]=[
  ['fighter',['--target=COW'],[COW_FIELD]],
  ['boss',['--boss=BLACK-DRAGON'],[BLACK_CAVE]],
  ['market',['--mode=SHOP-BUY','harry'],['shop:harry']],
  ['market',['--type=shop-buy','harry'],['shop:harry']],
  ['skiller',['--skill=FORAGING','--method=FEATHERS','PEN=3017,3288'],['pen:3017,3288']],
  ['skiller',['woodcutting','3000'],[AIO_PLACES.yews]],
  ['skiller',['foraging','1800','28'],[AIO_PLACES.flax]],
  ['skiller',['fishing','gather-fish','CAP=500'],['catherby:lobster']],
  ['skiller',['woodcutting','gather-yews'],[AIO_PLACES.yews]],
  ['skiller',['foraging','gather-flax'],[AIO_PLACES.flax]],
  ['skiller',['foraging','gather-feathers'],['pen:3229,3298']],
  ['skiller',['mining','gather-ore'],[AIO_PLACES.ore]],
  ['skiller',['mining','gather-essence'],[AIO_PLACES.essence]],
  ['skiller',['runecraft','rcair'],[AIO_PLACES.air]],
  ['skiller',['runecraft','rune-bank-craft','RUNE_ALTAR=air'],[AIO_PLACES.air]],
  ['skiller',['thieving','goldfarm'],['knight:2653,3300']],
  ['skiller',['magic','splash-train'],[SPLASH_FENCE]],
  ['skiller',['magic','train','21'],[STRIKE_TILE]],
 ];
 for(const [category,args,expected] of routes){
  const actual=resolveAioStep(`--category=${category}`,args);
  expect(jobResources(actual),category+':'+args.join(' ')).toEqual(expected);
  expect(jobResources(command(`--category=${category}`,args))).toEqual(expected);
  expect(jobResources({script:`scripts/aio-${category}.ts`,args})).toEqual(expected);
  expect(jobResources({script:'scripts/chain.ts',args:[formatStep({script:'scripts/aio.ts',args:[category,...args],env:{}})]})).toEqual(expected);
 }
 const explicit=resolveAioStep('skiller',['--skill=foraging','--method=feathers','PEN=3017,3288']);
 expect(explicit).toEqual({script:'scripts/aio-skiller.ts',args:['gather','foraging','feathers'],env:{PEN:'3017,3288'}});
});

test('hosted workers reserve and publish each account with its own environment and active state',()=>{
 const host={host:true,accounts:['First','Second','Third'],script:'scripts/aio.ts',args:['skiller','thieving','knights'],env:{KNIGHT_SPOT:'2652,3318'},
  envByAccount:{Second:{KNIGHT_SPOT:'2671,3313'}},enabled:true};
 expect(jobResources(host)).toEqual(['knight:2652,3318','knight:2671,3313','knight:2652,3318']);
 expect(reservedResources([host],'cloud',new Set())).toEqual({'knight:2652,3318':2,'knight:2671,3313':1});
 expect(claimFor([host],'cloud',()=> 'cloud',1000,name=>name!=='Second').resources).toEqual(['knight:2652,3318','knight:2652,3318']);
 expect(claimFor([host],'cloud',()=> 'cloud',1000,()=>false).resources).toEqual([]);
 // The swarm refuses a whole host whose participants belong to different sides.
 expect(claimFor([host],'cloud',name=>name==='Second'?'local':'cloud',1000).resources).toEqual([]);
 const marked={...host,autopilot:'cloud'};
 expect(reservedResources([marked],'cloud',new Set())).toEqual({});
 // One paused participant keeps the whole existing host mission in mergeJobs.
 expect(reservedResources([marked],'cloud',new Set(['first']))).toEqual({'knight:2652,3318':2,'knight:2671,3313':1});
});

test('explicit resource overrides remain per host worker and cooperative orchestrators count once',()=>{
 const resources=[TROOPER_FIELD],host={host:true,accounts:['First','Second'],script:'scripts/gather-combat.ts',resources,enabled:true};
 expect(jobResources(host)).toEqual([TROOPER_FIELD,TROOPER_FIELD]);
 const order={...host,host:false,orchestrate:true};
 expect(jobResources(order)).toEqual([TROOPER_FIELD]);
 expect(claimFor([order],'cloud',()=> 'cloud',1000,name=>name==='Second').resources).toEqual([TROOPER_FIELD]);
 expect(reservedResources([{...host,enabled:false}],'cloud',new Set())).toEqual({});
});

test('production planning counts six held cows and fourteen held troopers before assigning another army worker',()=>{
 const templates=catalogue();
 for(const [mode,field,count] of [['cow',COW_FIELD,6],['trooper',TROOPER_FIELD,14]] as const){
  const template=templates.find(t=>t.script==='scripts/gather-combat.ts'&&t.args?.[1]===mode&&t.trains?.skill==='Strength'&&t.trains.to===(mode==='cow'?45:99))!;
  expect(template).toBeDefined();
  const actor:Acct={name:'Candidate',side:'cloud',skills:{Attack:60,Strength:mode==='cow'?1:60,Defence:60,Hitpoints:60},items:{'bronze sword':1,'wooden shield':1,trout:100}};
  const make=(taken:Record<string,number>)=>plan({side:'cloud',accounts:[actor],owners:new Map([['candidate',{side:'cloud'}]]),bill:[],templates:[template],prices:{},army:new Set(['candidate']),capacity:CAPACITY,taken});
  expect(make({})[0]!.template?.id).toBe(template.id);
  const hand={script:'scripts/gather-combat.ts',args:['1500',mode],env:{COW_BANK_PROFILE:'north'},host:true,accounts:Array.from({length:count},(_,i)=>`Holder${i}`),enabled:true};
  const taken=reservedResources([hand],'cloud',new Set());
  expect(taken).toEqual({[field]:count});
  expect(make(taken)[0]!.template).toBeUndefined();
 }
});

test('the air-rune supply template requests a finite forced air batch even for a level-99 crafter',()=>{
 const template=catalogue().find(t=>t.id==='aio-air-runes')!;
 const actual=resolveAioStep(template.args![0]!,template.args!.slice(1));
 expect(actual.env).toMatchObject({RUNE_ALTAR:'air',ESSENCE_TARGET:'28'});
 expect(template.needs?.items?.['rune essence']).toBe(28);
 expect(jobResources({script:template.script,args:template.args})).toEqual([AIO_PLACES.air]);
});

test('qualified production alchemists retain their explicit empty resource claim',()=>{
 const template=catalogue().find(t=>t.id==='army-alch-magic-99')!;
 expect(template.needs?.skills?.Magic).toBe(21);
 expect(template.resources).toEqual([]);
 const actor:Acct={name:'Qualified',side:'cloud',skills:{Magic:21},items:{'nature rune':50,feather:50,'fire rune':250}};
 const assignment=plan({side:'cloud',accounts:[actor],owners:new Map([['qualified',{side:'cloud'}]]),bill:[],templates:[template],prices:{},army:new Set(['qualified'])})[0]!;
 expect(assignment.template?.id).toBe(template.id);
 expect(jobResources(jobFor(assignment,'cloud'))).toEqual([]);
});

test('generated inline mining jobs claim only the registered ore site without reading job files',()=>{
 const bands=planProgressiveSkiller('mining',1,20);
 expect(bands.length).toBe(2);
 for(const {step} of bands){
  expect(readBankJobArgument(step.args[1]!)).toMatchObject({family:'mining',site:{x:3286,z:3368,level:0}});
  expect(jobResources(step)).toEqual([AIO_PLACES.ore]);
  expect(jobResources(command('skiller',step.args))).toEqual([AIO_PLACES.ore]);
  expect(jobResources({script:'scripts/chain.ts',args:[formatStep(step)]})).toEqual([AIO_PLACES.ore]);
 }
 const profile=readBankJobArgument(bands[0]!.step.args[1]!);
 const unknown=`--job=${encodeURIComponent(JSON.stringify({...profile,site:{x:3220,z:3147,level:0}}))}`;
 expect(jobResources(command('skiller',['bank-job',unknown]))).toEqual([]);
 expect(jobResources(command('skiller',['bank-job','missing-profile.json']))).toEqual([]);
 const malformed='--job=%7B';
 expect(()=>readBankJobArgument(malformed)).toThrow();
 expect(()=>jobResources(command('skiller',['bank-job',malformed]))).toThrow();
 const invalid=`--job=${encodeURIComponent(JSON.stringify({...profile,target:0}))}`;
 expect(()=>readBankJobArgument(invalid)).toThrow();
 expect(()=>jobResources(command('skiller',['bank-job',invalid]))).toThrow();
});
