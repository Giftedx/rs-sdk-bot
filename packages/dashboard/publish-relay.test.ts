import {describe,expect,test} from 'bun:test';
import {controlView,publicView,trimState,withSides,MAIN_MARK,WHY_LIMIT,FINISHED_KEEP,stateWarm} from './publish-relay';
import {buildItemPrices} from './item-prices';
import {buildItemExamine,projectItemExamine} from './item-examine';
import {questPointObservation} from './goals';

const state=()=>({now:1,bots:[
  {name:'CoinCock',env:{target:null},sessionAttemptId:'1-2',workRevision:'abc',inputs:{},coordinatorRunId:null,bank:[{name:'Coins',count:5}],pos:{x:1,z:2},reserved:false},
  {name:MAIN_MARK,reserved:true,bank:[],env:{}},
 ],coordination:{available:true,tasks:[{id:'t1',why:'w'.repeat(1000),detail:'d'.repeat(1000),status:'pending'}]},
 sys:{freeGB:5,procs:[{pid:1,script:'swarm.ts'}]},viewerTimings:[{ms:1}],vault:{coins:9},collection:{items:[]},economy:{supplies:[{name:'Lobster',ask:100}],pricesAt:7,goldPerTick:3,farmers:[{name:'CoinCock'}],trend:[1]},mainPlan:{rows:[{board:'Overall',note:`${MAIN_MARK} first`}]},requests:{open:[{id:'1',request:'owner words'}]},race:{rows:[]},gates:{go:false},
 fleetSides:{at:1,sides:[{side:'cloud',at:1,late:false,accounts:[{name:'TossTheCaber',at:1,total:40,coins:900},{name:MAIN_MARK,at:1,total:1,coins:1}]}],orders:[{from:'BowBeforeMe',to:'Shaftsinker',item:'Air talisman',count:1}]},
 roster:[['Zezima',1,2,0,99],[MAIN_MARK,3,4,0,3]],rivals:[{board:'Attack',at:1,ours:{rank:2,name:MAIN_MARK},rows:[{rank:1,name:'Zezima'},{rank:2,name:MAIN_MARK}]}],
 contention:[{side:'local',resource:'knight:1,2',others:['Zezima',MAIN_MARK],ours:[MAIN_MARK]}],lookups:{zezima:{name:'Zezima'},[MAIN_MARK]:{name:MAIN_MARK}},
 farms:[{label:'Money ##',names:['Money 01',MAIN_MARK]}],overtake:[{board:'Attack',account:'CoinCock'},{board:'Magic',account:MAIN_MARK}]});
const meta={nonce:'secret-nonce',goals:['wealth'],roles:['supply'],paused:false,fleetPaused:false,capabilities:[],accountHolds:[{name:'AFKnight',owner:'other'}],requests:[{id:'r1',action:'plan',at:1,status:'plan-requested'}]};

describe('hosted views',()=>{
 test('trimState caps task texts and leaves the rest',()=>{
  const t=trimState(state());
  expect(t.coordination.tasks[0].why).toHaveLength(WHY_LIMIT);
  expect(t.coordination.available).toBe(true);
  expect(trimState({bots:[]})).toEqual({bots:[]});
  const many=Array.from({length:FINISHED_KEEP+50},(_,i)=>({id:'f'+i,status:i%2?'failed':'succeeded',finishedAt:i}));
  const kept=trimState({coordination:{tasks:[{id:'p',status:'pending'},...many,{id:'r',status:'running'}]}}).coordination.tasks;
  expect(kept).toHaveLength(FINISHED_KEEP+2);
  expect(kept.slice(0,2).map((t:any)=>t.id)).toEqual(['p','r']);
  expect(kept[2].id).toBe('f'+(FINISHED_KEEP+49));
 });
 test('control keeps every bot and holding, carries the operator metadata without its nonce, and the reveal name',()=>{
  const c=controlView(state(),meta);
  expect(c.mainPlan.rows[0].note).toBe(`${MAIN_MARK} first`);expect(c.requests.open[0].request).toBe('owner words');
  expect(c.bots).toHaveLength(2);
  expect(c.bots[0].bank[0].count).toBe(5);
  expect(c.control).toEqual({goals:['wealth'],roles:['supply'],paused:false,fleetPaused:false,capabilities:[],accountHolds:[{name:'AFKnight',owner:'other'}],requests:meta.requests});
  expect(JSON.stringify(c)).not.toContain('secret-nonce');
  expect(c.revealName).toBe('Haggis');
  expect(controlView(state(),null).control).toBeNull();
 });
 test('public drops the main account row, private bot fields, the process list and viewer timings; keeps the map data',()=>{
  const p=publicView(state());
  expect(p.bots.map((b:any)=>b.name)).toEqual(['CoinCock']);
  for(const f of ['env','sessionAttemptId','workRevision','inputs','coordinatorRunId','bank','bankAt'])expect(f in p.bots[0]).toBe(false);
  expect(p.bots[0].pos).toEqual({x:1,z:2});
  expect(p.economy).toEqual({supplies:[{name:'Lobster',ask:100}],pricesAt:7,itemValues:{},itemExamine:{},goldPerTick:0,farmers:[],trend:[]});
  // Everything outside the whitelist is absent: banks, the plan, host resources, scripts, pull requests.
  for(const k of ['vault','collection','sys','viewerTimings','mainPlan','race','gates','requests','objectives','gapHistory','scripts','prs','capacity','swarm','scoreboard','overtake','chain'])expect(k in p).toBe(false);
  expect(p.coordination.tasks).toEqual([]);expect(p.coordination.available).toBe(true);expect(JSON.stringify(p)).not.toContain('w'.repeat(50));
  expect(JSON.stringify(p)).not.toContain('owner words');
  expect(p.fleetSides.sides[0].accounts).toEqual([{name:'TossTheCaber',at:1,total:40}]);
  // Orders between our own accounts are the owner's logistics.
  expect('orders' in p.fleetSides).toBe(false);
  expect(p.roster).toEqual([['Zezima',1,2,0,99]]);expect(p.rivals[0].ours).toBeNull();expect(p.rivals[0].rows).toEqual([{rank:1,name:'Zezima'}]);
  expect(p.contention[0].others).toEqual(['Zezima']);expect(p.contention[0].ours).toEqual([]);expect(Object.keys(p.lookups)).toEqual(['zezima']);
  expect(p.farms[0].names).toEqual(['Money 01']);
  expect(p.hosted.kind).toBe('public');
 });
 test('a state that still names the main account is refused',()=>{
  expect(()=>publicView({bots:[{name:'CoinCock',goal:'give to Haggis'}]})).toThrow('nothing published');
  expect(()=>publicView({bots:[],roster:[['x',1,2,0,3]],farms:[{names:['n'],label:'haggis ##'}]})).toThrow('nothing published');
  // A field outside the whitelist cannot trip the check: it never reaches the public file.
  expect('mainPlan' in publicView({bots:[],mainPlan:{note:'haggis route'},objectives:{lanes:[{next:'haggis route'}]}})).toBe(false);
 });
 test('public collector failures retain dated data with a generic warning, without the private exception',()=>{
  const now=1_000_000,raw='Error reading C:\\private\\Haggis\\status.json: secret worker details';
  const s={now,stateError:raw,bots:[{name:'Worker',at:now-5000,skills:[{name:'Attack',level:40,xp:37_224}]}],
   world:{connected:true,tickAt:now-2000},roster:[['Worker',3200,3201,0,40]],lookups:{worker:{name:'Worker',at:now-3000,rows:[{board:'Overall',level:200}]}}};
  const p=publicView(s);
  expect(p.stateError).toBe('Fleet data could not be refreshed; showing the last snapshot.');
  expect([p.now,p.bots[0].at,p.world.tickAt,p.lookups.worker.at]).toEqual([now,now-5000,now-2000,now-3000]);
  expect(p.bots[0].skills).toEqual(s.bots[0].skills);expect(p.roster).toEqual(s.roster);expect(p.lookups.worker.rows).toEqual(s.lookups.worker.rows);
  expect(JSON.stringify(p)).not.toMatch(/private|Haggis|secret worker|status\.json/);
  expect(s.stateError).toBe(raw);
 });
 test('a recovered public collector drops its warning, and healthy falsey error states add no field',()=>{
  const s:any={now:1_000_000,bots:[],stateError:'read failed'};
  expect(publicView(s).stateError).toBeTruthy();
  for(const stateError of [undefined,null,false,0,'']){
   s.stateError=stateError;s.now+=1000;
   const p=publicView(s);expect(p).not.toHaveProperty('stateError');expect(p.now).toBe(s.now);
  }
 });
 test('public bots keep game-visible fields and lose run counters, banks and internal runtime fields',()=>{
  const b={name:'CoinCock',pos:{x:1,z:2},skills:[{name:'Attack',level:5,xp:400}],inventory:[{name:'Coins',count:9}],equipment:[],ranks:[],goal:'coins [task-1a2b] buy (607 short): 1630 bronze in the bank',currentGoal:'run-ranged-coincock-owned-band50',
   phase:'banked=15000 packCoins=5100',phaseShort:'banked 15.0K',result:'ok banked=15000',lastRes:{text:'ok banked=15000'},ledger:{coins:1},counters:{banked:15000},job:{script:'x'},planJob:{next:'y'},nativeProof:{ok:true},timeline:'xxi',role4:{coinsPerTick:3},bank:[{name:'Coins',count:1}],bankAt:1,env:{a:1}};
  const p=publicView({bots:[b],results:[{at:1,name:'CoinCock',ok:true,goal:'coins [task-9]',text:'ok banked=15000 packCoins=5100',counters:{banked:15000}}],events:[{at:1,name:'CoinCock',text:'banked 15.0K',full:'banked=15000'}]});
  expect(Object.keys(p.bots[0]).sort()).toEqual(['currentGoal','equipment','goal','inventory','name','pos','ranks','skills']);
  expect(p.bots[0].goal).toBe('coins buy');expect(p.bots[0].currentGoal).toBe('Ranged training');
  expect(p.results).toEqual([{at:1,name:'CoinCock',ok:true,text:'coins'}]);expect(p.events).toEqual([]);
  expect(JSON.stringify(p)).not.toMatch(/banked|packCoins|15000/);
 });
});

describe('withSides',()=>{
 test('each bot names its side; unlisted accounts are local; other state is untouched',()=>{
  const s=withSides({now:1,bots:[{name:'CoinCock'},{name:'CloudBot'}]},new Map([['cloudbot',{side:'cloud'}]]));
  expect(s.bots.map((b:any)=>b.side)).toEqual(['local','cloud']);
  expect(s.now).toBe(1);
  expect(withSides({bots:null},new Map())).toEqual({bots:null});
 });
 test('a remote row keeps its snapshot side when fleet/owners.json does not list it',()=>{
  const s=withSides({bots:[{name:'NewCloud',remote:true,side:'claude-cloud-3'},{name:'CoinCock',side:'cloud'}]},new Map());
  expect(s.bots.map((b:any)=>b.side)).toEqual(['claude-cloud-3','local']);
 });
});

test('public item values cover only what public bots carry or wear',()=>{
 const p=publicView({bots:[{name:'CoinCock',inventory:[{name:'Lobster',count:2}],equipment:[{name:'Bronze axe'}],bank:[{name:'Rune bar',count:9}]}],
  economy:{supplies:[],pricesAt:1,itemValues:{Lobster:150,'Bronze axe':16,'Rune bar':5000},itemExamine:{Lobster:'This looks tasty.','Rune bar':'A bar of rune.'}}});
 expect(p.economy.itemValues).toEqual({Lobster:150,'Bronze axe':16});expect(p.economy.itemExamine).toEqual({Lobster:'This looks tasty.'});
});

test('public examine facts retain exact carried IDs without selecting hidden same-name bank or main descriptions',()=>{
 const catalogue=new Map([[2399,{name:'Key',desc:'Wizard key.'}],[2400,{name:'Key',desc:'Captain key.'}],
  [2401,{name:'Key',desc:'Drain key.'}],[1,{name:'Safe',desc:'Shared description.'}],[2,{name:'Safe',desc:'Shared description.'}]]);
 const examines=projectItemExamine(buildItemExamine(catalogue),[2399,2400,2401,1,2].map(id=>({id,name:catalogue.get(id)!.name})));
 const p=publicView({bots:[{name:'Worker',inventory:[{id:2399,name:'Key'}],equipment:[{id:1,name:'Safe'}],bank:[{id:2400,name:'Key'},{id:2,name:'Safe'}]},
  {name:MAIN_MARK,inventory:[{id:2401,name:'Key'}]}],economy:{...examines}});
 expect(p.economy.itemExamineById).toEqual({2399:'Wizard key.',1:'Shared description.'});
 expect(p.economy.itemExamineByName).toEqual({safe:'Shared description.'});
 expect(JSON.stringify(p.economy)).not.toContain('Captain key.');expect(JSON.stringify(p.economy)).not.toContain('Drain key.');
 const unknown=publicView({bots:[{name:'Worker',inventory:[{id:999,baseId:2399,name:'Key (noted)'}]}],economy:examines});
 expect(unknown.economy.itemExamineById).toEqual({});expect(unknown.economy.itemExamineByName).toEqual({});
 const invalid=publicView({bots:[{name:'Worker',inventory:[{id:2399,name:'Key'}]}],economy:{itemExamineById:null,itemExamineByName:[]}});
 expect(invalid.economy.itemExamineById).toBeNull();expect(invalid.economy.itemExamineByName).toBeNull();
});

test('public exact prices follow visible base IDs and route supplies while aliases retain the full catalogue proof',()=>{
 const rows=[
  {id:1135,name:'Dragonhide body',basePrice:7800},{id:2503,name:'Dragonhide body',basePrice:13480},
  {id:1277,name:'Bronze sword',basePrice:26},{id:526,name:'Bones',basePrice:1},{id:561,name:'Nature rune',basePrice:180},
  {id:6,name:'Ring',basePrice:1000,ask:100,bid:90},{id:7,name:'Ring',basePrice:1000,ask:500,bid:90},
  {id:10,name:'Bank only',basePrice:10},{id:11,name:'Main only',basePrice:11},
  {id:12,name:'Practice only',basePrice:12},{id:13,name:'Reserved only',basePrice:13},
 ];
 const prices=buildItemPrices(rows,rows);
 const p=publicView({bots:[
  {name:'Worker',inventory:[{id:1136,baseId:1135,name:'Dragonhide body (noted)'},{id:6,name:'Ring'}],equipment:[{id:1277,name:'Bronze sword'}],ground:[[3200,3201,0,526,2]],bank:[{id:2503,name:'Dragonhide body'},{id:7,name:'Ring'},{id:10,name:'Bank only'}]},
  {name:MAIN_MARK,ground:[[3200,3201,0,11,1]]},
  {name:'Testworker',practice:true,ground:[[3200,3201,0,12,1]]},
  {name:'Heldworker',reserved:true,ground:[{id:13,name:'Reserved only'}]},
 ],economy:{supplies:[{id:561,name:'Nature rune'}],itemPricesById:prices.byId,itemPricesByName:prices.byName}});
 expect(Object.keys(p.economy.itemPricesById).sort()).toEqual(['1135','1277','526','561','6']);
 expect(p.economy.itemPricesById[1135]).toEqual({name:'Dragonhide body',value:7800,ask:null,bid:null});
 expect(p.economy.itemPricesById[1136]).toBeUndefined();
 expect(Object.keys(p.economy.itemPricesByName).sort()).toEqual(['bones','bronze sword','nature rune','ring']);
 expect(p.economy.itemPricesByName.ring).toEqual({name:'Ring',value:1000,ask:null,bid:90});
 expect(p.economy.itemPricesByName['dragonhide body']).toBeUndefined();
 for(const word of ['Bank only','Main only','Practice only','Reserved only'])expect(JSON.stringify(p)).not.toContain(word);
 expect(p.bots).toHaveLength(1);expect('bank'in p.bots[0]).toBe(false);
});

test('public ground tuples require valid observations and never infer note base IDs',()=>{
 const rows=[{id:954,name:'Rope',basePrice:18},{id:10,name:'Bank only',basePrice:10},{id:1135,name:'Dragonhide body',basePrice:7800}];
 const prices=buildItemPrices(rows,rows);
 const ground=[[3200,3201,0,955,1],[3200,3201,0,10,0],[3200,3201,0,10],[3200,3201,0,'10',1],[NaN,3201,0,10,1],{id:1136,baseId:1135,name:'Dragonhide body (noted)'}];
 const p=publicView({bots:[{name:'Worker',ground,bank:[{id:10,name:'Bank only'},{id:954,name:'Rope'}]}],economy:{itemPricesById:prices.byId,itemPricesByName:prices.byName}});
 expect(p.economy.itemPricesById).toEqual({1135:{name:'Dragonhide body',value:7800,ask:null,bid:null}});
 expect(p.economy.itemPricesByName).toEqual({'dragonhide body':{name:'Dragonhide body',value:7800,ask:null,bid:null}});
});

test('public price tables whitelist valid values and exact keys without deriving aliases',()=>{
 const row={name:'Visible',value:0,ask:25,bid:20,bankCount:9000,account:'private owner',futureField:{stock:12}};
 const p=publicView({bots:[{name:'Worker',inventory:[{id:1,name:'Visible'},{id:2,name:'Bad value'},{id:3,name:'Bad name'},{id:4,name:'Quotes'},{id:5,name:'Alias absent'},{id:6,name:'Miskeyed'}]}],economy:{
  itemPricesById:{1:row,2:{...row,value:Infinity},3:{...row,name:''},4:{...row,name:'Quotes',ask:'25',bid:-1},5:{...row,name:'Alias absent'},'06':{...row,name:'Miskeyed'}},
  itemPricesByName:{visible:row,'Bad value':{...row,name:'Bad value'},'bad name':{...row,name:'Bad name',value:-1},miskeyed:{...row,name:'Bank only'},quotes:{...row,name:'Quotes',value:2,ask:NaN,bid:1.5}},
 }});
 expect(p.economy.itemPricesById).toEqual({1:{name:'Visible',value:0,ask:25,bid:20},4:{name:'Quotes',value:0,ask:null,bid:null},5:{name:'Alias absent',value:0,ask:25,bid:20}});
 expect(p.economy.itemPricesByName).toEqual({visible:{name:'Visible',value:0,ask:25,bid:20},quotes:{name:'Quotes',value:2,ask:null,bid:null}});
 expect(JSON.stringify(p)).not.toMatch(/bankCount|private owner|futureField|Bank only/);
});

test('public omitted price maps stay omitted while explicit unknown and empty maps remain authoritative',()=>{
 const bots=[{name:'Worker',inventory:[{id:995,name:'Coins'},{id:1,name:'Visible'}]}],economy={itemValues:{Coins:1,Visible:2}};
 const old=publicView({bots,economy}).economy;
 expect(Object.hasOwn(old,'itemPricesById')).toBe(false);expect(Object.hasOwn(old,'itemPricesByName')).toBe(false);
 expect(old.itemValues).toEqual({Coins:1,Visible:2});
 for(const unknown of [null,undefined,'unknown',[]]){
  const current=publicView({bots,economy:{...economy,itemPricesById:unknown,itemPricesByName:unknown}}).economy;
  expect(Object.hasOwn(current,'itemPricesById')).toBe(true);expect(current.itemPricesById).toBeNull();
  expect(Object.hasOwn(current,'itemPricesByName')).toBe(true);expect(current.itemPricesByName).toBeNull();
 }
 const empty=publicView({bots,economy:{...economy,itemPricesById:{},itemPricesByName:{}}}).economy;
 expect(empty.itemPricesById).toEqual({});expect(empty.itemPricesByName).toEqual({});
 const one=publicView({bots,economy:{...economy,itemPricesById:null}}).economy;
 expect(one.itemPricesById).toBeNull();expect(Object.hasOwn(one,'itemPricesByName')).toBe(false);
});

test('public health and selected quest points keep source dates and drop raw guild facts and extra fields',()=>{
 const now=1_000_000,at=now-100,hpAt=now-1000;
 const bot:any={name:'Worker',server:'rs-sdk-demo.fly.dev',at,hpAt,hp:{now:0,max:20},guildFacts:{varps:{qp:0,privateFlag:999}},ranksAt:now-1000,ranks:[{board:'Quest Points',level:50,rank:3}],live:{seen:now},snapshotAt:now};
 bot.questPoints={...questPointObservation(bot,now),bankCount:9000,guildFacts:bot.guildFacts};
 const p=publicView({now,bots:[bot]});
 expect(p.bots[0].hp).toEqual({now:0,max:20});expect(p.bots[0].hpAt).toBe(hpAt);
 expect(p.bots[0].questPoints).toEqual({points:0,at,source:'status'});
 expect('guildFacts'in p.bots[0]).toBe(false);expect(JSON.stringify(p)).not.toMatch(/privateFlag|bankCount/);
 const newer={points:60,at:now-1,source:'hiscores',privateField:12};
 expect(publicView({now,bots:[{...bot,questPoints:newer}]}).bots[0].questPoints).toEqual({points:60,at:now-1,source:'hiscores'});
});

test('public explicit unknown health and quest points cannot borrow heartbeat dates or legacy observations',()=>{
 const now=1_000_000,at=now-100,bot={name:'Worker',at,hp:{now:1,max:20},live:{seen:now},snapshotAt:now,guildFacts:{varps:{qp:55}},ranksAt:now-1,ranks:[{board:'Quest Points',level:55}]};
 for(const hpAt of [null,undefined,0,-1,'999900',NaN,Infinity,at+1,now+1]){
  const row=publicView({now,bots:[{...bot,hpAt}]}).bots[0];
  expect(Object.hasOwn(row,'hpAt')).toBe(true);expect(row.hpAt).toBeNull();
 }
 for(const questPoints of [null,undefined,{points:-1,at,source:'status'},{points:1.5,at,source:'status'},
  {points:'55',at,source:'status'},{points:Number.MAX_SAFE_INTEGER+1,at,source:'status'},
  {points:55,at:null,source:'status'},{points:55,at:now+1,source:'status'},{points:55,at,source:'guild'}]){
  const row=publicView({now,bots:[{...bot,questPoints}]}).bots[0];
  expect(Object.hasOwn(row,'questPoints')).toBe(true);expect(row.questPoints).toBeNull();
 }
 const legacy=publicView({now,bots:[bot]}).bots[0];
 expect(Object.hasOwn(legacy,'hpAt')).toBe(false);expect(Object.hasOwn(legacy,'questPoints')).toBe(false);
});

test('a state is warm once the server has read the market and the board tops',()=>{
 expect(stateWarm({rivals:[],economy:{pricesAt:1}})).toBe(false);
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:null}})).toBe(false);
 // The server's value before its first market read.
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:0}})).toBe(false);
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:1}})).toBe(true);
});

test('practice bots and their runs stay with the owner; script file goals read as words',()=>{
 const p=publicView({bots:[{name:'CoinCock',goal:'magic-order.ts'},{name:'flmagexzky12',practice:true,goal:'magic-order.ts'}],
  results:[{at:1,name:'CoinCock',ok:true,goal:'smelt-bars.ts'},{at:2,name:'flmagexzky12',ok:false,practice:true,goal:'magic-order.ts'}]});
 expect(p.bots.map((b:any)=>b.name)).toEqual(['CoinCock']);expect(p.bots[0].goal).toBe('magic order');
 expect(p.results).toEqual([{at:1,name:'CoinCock',ok:true,text:'smelt bars'}]);
});

test('the public view keeps only the icons of items it shows, and a death without the run text',()=>{
 const s:any=state();
 s.bots[0].inventory=[{name:'Lobster',count:2}];s.bots[0].equipment=[{name:'Rune scimitar'}];s.bots[0].death={at:5,text:'fail died=true coins=900'};
 s.lookups.zezima.worn=[{name:'Dragon longsword'}];
 s.icons={Lobster:1,'Rune scimitar':2,'Dragon longsword':3,'Banked thing':4};
 const p=publicView(s);
 expect(Object.keys(p.icons).sort()).toEqual(['Dragon longsword','Lobster','Rune scimitar']);
 expect(p.bots[0].death).toEqual({at:5,text:'died'});
});

test('relay Views strip redundant defaults, raw collector blobs, unused vault tables and unreferenced icons while preserving UI contracts',()=>{
 const raw:any={
  now:100,
  bots:[{
   name:'CoinCock',pos:{x:1,z:2},
   skills:[{name:'Prayer',level:43,currentLevel:43,xp:51000}],
   inventory:[{id:379,baseId:379,name:'Lobster',count:2},{id:380,baseId:379,name:'Lobster',count:5}],
   equipment:[{id:1333,baseId:1333,name:'Rune scimitar',slot:3}],
   bank:[{id:995,baseId:995,name:'Coins',count:5000}],
   ranks:[{board:'Overall',rank:4,delta:0,since:null,hist:[10,4]}],
   equipmentObserved:true,practice:false,reserved:false,ground:[],spark:[],action:null,eta:null,flow:null,
   inputs:{huge:true},progression:{step:1},guildFacts:{varps:{}},workRevision:9,sessionAttemptId:'s1',coordinatorRunId:'r1',doorStates:{a:1},
   progressionContext:{target:{x:3200,z:3200,level:0},prayers:[true],varps:{huge:1},style:{currentStyle:1,known:true,styles:[{index:0,name:'Accurate'},{index:1,name:'Aggressive'}]}},
  }],
  boards:[{board:'Overall',best:{board:'Overall',rank:4,hist:[10,4]}}],
  vault:{coins:5000,value:5000,countsComplete:true,items:[{id:995}],holders:{h:1},log:[{at:1}],flow:[{from:'A',to:'B',items:[{name:'Coins',count:5}]}]},
  scoreboard:{available:true,version:1,at:99,skillLevels:100,skills99:1,quests:{live:2,total:3,remaining:['Q3']},items:{held:4,total:5},done:false,remaining:['Q3'],
   metrics:{heavy:1},goals:{version:1,at:99,main:{rank:2,rankAt:98,extra:1},specialists:{rank1s:[{board:'Cooking',at:99}],targets:{big:1}},quests:{complete:2,total:3,evidence:[]},collection:{missing:[{item:'Whip',need:1}],evidence:[]},army:{maxed:1,roster:[{name:'A'}],accounts:[{big:1}]}}},
  fleetSides:{at:99,sides:[{side:'local',accounts:[]}],orders:[{id:'o1',start:10,end:20,from:'A',to:'B',item:'Coins',count:100,state:'open',late:false}]},
  race:{supplies:[{item:'Shark',need:10}]},
  icons:{Lobster:379,'Rune scimitar':1333,Coins:995,Shark:385,Whip:4151,'Unused item':999},
 };
 const ctlMeta={goals:['wealth'],capabilities:[{id:'cap',goal:'wealth',entry:'scripts/cap.ts',consumer:'c',files:['a.ts'],checks:[{id:'unit',phase:'regression',command:['bun','test'],timeoutMs:5000}]}]};

 const pub=publicView(raw);
 expect(pub.bots[0].inventory).toEqual([{id:379,baseId:379,name:'Lobster',count:2},{id:380,baseId:379,name:'Lobster',count:5}]);
 expect(pub.bots[0].ranks).toEqual([{board:'Overall',rank:4}]);
 expect(pub.boards[0].best.hist).toEqual([10,4]);
 expect(pub.bots[0].skills[0].currentLevel).toBe(43);
 for(const omitted of ['equipmentObserved','practice','reserved','ground','spark','action','eta','flow'])expect(omitted in pub.bots[0]).toBe(false);

 const ctl=controlView(raw,ctlMeta);
 expect(ctl.bots[0].bank).toEqual([{id:995,name:'Coins',count:5000}]);
 expect(ctl.bots[0].ranks).toEqual([{board:'Overall',rank:4}]);
 for(const k of ['inputs','progression','guildFacts','workRevision','sessionAttemptId','coordinatorRunId','doorStates'])expect(k in ctl.bots[0]).toBe(false);
 expect(ctl.bots[0].progressionContext).toEqual({target:{x:3200,z:3200,level:0},prayers:[true],style:{currentStyle:1,known:true,styles:[{index:1,name:'Aggressive'}]}});
 expect(ctl.vault).toEqual({coins:5000,value:5000,countsComplete:true,flow:[{from:'A',to:'B',items:[{name:'Coins',count:5}]}]});
 expect('metrics'in ctl.scoreboard).toBe(false);expect('accounts'in ctl.scoreboard.goals.army).toBe(false);expect(ctl.scoreboard.goals.collection.missing).toHaveLength(1);
 expect(ctl.fleetSides.orders).toEqual([{end:20,from:'A',to:'B',item:'Coins',count:100,state:'open'}]);
 expect(ctl.control.capabilities[0].checks).toEqual([{id:'unit',phase:'regression',timeoutMs:5000}]);
 expect(Object.keys(ctl.icons).sort()).toEqual(['Coins','Lobster','Rune scimitar','Shark','Whip']);
});
