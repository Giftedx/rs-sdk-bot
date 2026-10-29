import {test,expect} from 'bun:test';
import {agilityOptions,agilityPreflight,resumeStep,runAgility,onCourse,wildernessStarted,gnomeEntry,draynorFunds,buyEntryFood,travelAgilityEntry,needsCourseApproach,gnomeApproachRoute,crossStrongholdGate,STRONGHOLD_GATE,DRAYNOR_ENTRY,EAT_DELAY_TICKS,eatReady,type Course} from './agility-order';
import type {Session} from '../packages/core/src/inprocess';
import type {PathDeps} from '../packages/core/src/walk';

function travelFixture({reject=false,short=false,empty=false,damage=false,heal=true,cancel=false,frozen=false,closedDoor=false}={}){
 let ticks=0,hp=10,eats=0,walks=0,ended=false,plans=0;
 const player={x:2494,z:3437,level:0},callbacks=new Set<()=>void>();
 const messages=[{text:'You cannot reach that.',tick:0}];
 const walker:PathDeps={pos:()=>({...player}),tick:()=>ticks,onTick:cb=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};},
  plan:(_level,_from,to)=>{plans++;return empty?[]:short?[{x:2494,z:3437}]:[to];},
  walk:(x,z)=>{walks++;if(cancel)ended=true;if(damage&&eats===0)hp=3;
   if(!reject&&!short&&!damage)Object.assign(player,{x,z});
   if(!reject&&!short&&damage&&eats>0)Object.assign(player,{x,z});
   return reject?{success:false,reason:'unreachable',message:'recorded rejection'}:{success:true};},
  interactLoc:()=>{},locs:()=>[{id:190,name:'Gate',x:closedDoor?2480:2461,z:closedDoor?3437:3382,optionsWithIndex:[{text:'Open',opIndex:1}]}],messages:()=>messages};
 const controls={left:()=>{if(ticks>=20)throw Error('entry tick budget exhausted');},
  live:()=>{if(ended)throw Error('session interrupted');},interrupted:()=>ended,low:()=>hp<8,heals:()=>eats,
  // Windows timers can fire 15ms apart; only the frozen stream may hit the stall bound.
  health:async()=>{if(hp<8){if(!heal)throw Error('food effect unobserved');hp=10;eats++;}},idleMs:frozen?5:250};
 const timer=frozen?undefined:setInterval(()=>{ticks++;for(const cb of [...callbacks])cb();},1);
 return{walker,controls,walks:()=>walks,plans:()=>plans,eats:()=>eats,stop:()=>clearInterval(timer),callbacks};
}
const entryGoal=[{x:2474,z:3437,tol:1}];
test('entry retains the first rejected walk and never starts an unchanged retry',async()=>{
 const f=travelFixture({reject:true});try{
  const e=await travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls).catch((e:Error)=>e);
  expect(e).toBeInstanceOf(Error);if(!(e instanceof Error))throw Error('entry unexpectedly passed');
  expect(e.message).toContain('walk rejected 3 times');expect(e.message).toContain('recorded rejection');
  expect(e.message).toContain('"goal":{"x":2474,"z":3437,"tol":1}');expect(e.message).toContain('"x":2494');
  for(const key of ['ticks','next','clicks','repaths','doors','nearby','messages','first'])expect(e.message).toContain('"'+key+'"');
  expect(f.walks()).toBe(3);expect(f.eats()).toBe(0);expect(f.callbacks.size).toBe(0);
 }finally{f.stop();}
});
test('a planner endpoint short of the entry refuses without an outer retry',async()=>{
 const f=travelFixture({short:true});try{
  await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',6,f.controls)).rejects.toThrow('no path to 2474,3437');
  expect(f.plans()).toBe(1);expect(f.walks()).toBe(0);expect(f.eats()).toBe(0);
 }finally{f.stop();}
});
test('the retained empty plan preserves rejection from the shared straight-path fallback',async()=>{
 const f=travelFixture({empty:true,reject:true});try{
  await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls)).rejects.toThrow('walk rejected 3 times');
  expect(f.walks()).toBe(3);expect(f.plans()).toBe(2);expect(f.eats()).toBe(0);
 }finally{f.stop();}
});
test('only an observed low-HP stop and food effect can resume entry',async()=>{
 const f=travelFixture({damage:true});try{await travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls);expect(f.eats()).toBe(1);expect(f.walks()).toBe(2);}finally{f.stop();}
});
test('a low-HP stop without healing retains the walk and food causes',async()=>{
 const f=travelFixture({damage:true,heal:false});try{await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls)).rejects.toThrow('food effect unobserved');expect(f.walks()).toBe(1);}finally{f.stop();}
});
test('cancellation preserves the first stopped result and prevents healing or retry',async()=>{
 const f=travelFixture({cancel:true,damage:true});try{await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls)).rejects.toThrow('session interrupted');expect(f.walks()).toBe(1);expect(f.eats()).toBe(0);}finally{f.stop();}
});
test('a frozen entry tick stream retains the original stall and unsubscribes',async()=>{
 const f=travelFixture({frozen:true,reject:true});try{await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',20,f.controls)).rejects.toThrow('tick stream stalled');expect(f.walks()).toBe(1);expect(f.callbacks.size).toBe(0);}finally{f.stop();}
});
test('a closed door keeps its original refusal and does not trigger a new walk',async()=>{
 const f=travelFixture({closedDoor:true});try{
  await expect(travelAgilityEntry(f.walker,entryGoal,'course approach',30,f.controls)).rejects.toThrow('stayed closed after 3 Open attempts');
  expect(f.plans()).toBe(1);expect(f.walks()).toBe(0);expect(f.eats()).toBe(0);
 }finally{f.stop();}
});
// Recorded cause (agility-order-1793222518098-ehs7bv + pinned collision): every plan from outside the
// Stronghold to 2474,3437 ends at the 2494,3437 strip. The fake planner reproduces those endpoints.
function strongholdPlanner(){
 const outside=(p:{x:number;z:number})=>p.z<3385||p.x>=2493&&p.z<=3438;
 return (from:{x:number;z:number},to:{x:number;z:number})=>outside(from)!==outside(to)?[{x:2494,z:3437}]:[to];
}
test('the eastern strip plan endpoint never counts as a direct course approach',()=>{
 const plan=strongholdPlanner();
 expect(gnomeApproachRoute(plan,{x:2494,z:3437})).toBe('gate');
 expect(gnomeApproachRoute(plan,{x:2461,z:3382})).toBe('gate');
 expect(gnomeApproachRoute(plan,{x:2683,z:3270})).toBe('gate');
 expect(gnomeApproachRoute(plan,{x:2460,z:3445})).toBe('direct');
 expect(gnomeApproachRoute(plan,{x:2474,z:3437})).toBe('direct');
});
test('an unreachable gate or course start has no supported route',()=>{
 expect(gnomeApproachRoute(()=>[{x:2494,z:3437}],{x:2494,z:3437})).toBeNull();
 expect(gnomeApproachRoute(()=>[],{x:2600,z:3300})).toBeNull();
 // Gate south reachable but the north side cannot reach the course start.
 expect(gnomeApproachRoute((_f,to)=>to.x===2474?[{x:2470,z:3400}]:[to],{x:2494,z:3437})).toBeNull();
});
test('the gate waypoints come from gnome_gate.rs2 relative to loc 190',()=>{
 const G=STRONGHOLD_GATE;
 expect([G.id,G.x,G.z]).toEqual([190,2459,3383]);
 expect(G.south).toEqual({x:G.x+2,z:G.z-1});expect(G.north).toEqual({x:G.x+2,z:G.z+2});
});
// The fake follows gnome_gate.rs2 and femi.rs2: with femi_help 0 the first Open starts Femi's dialogue
// and does not cross. Only "OK then." sets 2. A later Open force-moves the player to the north entrance.
function gateFixture({femi=true,crosses=true,cancel=false,choice='OK then.',retireTicks=0,duplicate=false,reject=false,stuck=false,intermediate=false,cancelChoice=false,complete=true,componentsOnly=false}={}){
 let tick=0,ended=false,femiHelp=femi?0:2,crossAt=0,page=-1,retireAt=0,clickTick=0;
 const events:string[]=[],callbacks=new Set<()=>void>(),player={worldX:2461,worldZ:3382,level:0};
 const closed={isOpen:false,isWaiting:false,options:[] as {index:number;text:string}[],text:''};let dialog:any=closed;
 const pages=[{text:'Hello there.',options:[]},{text:'Hi!',options:[]},
  {text:'Could you help me lift these boxes?|They are really heavy!',options:[{index:1,text:"Sorry, I'm a bit busy."},{index:2,text:choice}]},
  {text:'Thanks again friend!',options:[]}];
 const show=()=>{dialog=page<0||page>=pages.length?closed:{isOpen:true,isWaiting:false,pageId:`page-${page}`,allComponents:[{id:100+page,text:pages[page]!.text}],...pages[page]!,options:pages[page]!.options.map(o=>({...o,componentId:200+o.index}))};if(componentsOnly&&dialog.isOpen){delete dialog.text;if(page!==2)dialog.options=[{index:1,text:'Click here to continue',componentId:210}];}if(page>=pages.length)page=-1;};
 const click=async(i:number)=>{events.push(`click:${i}`);clickTick=tick;
  if(page===2){if(cancelChoice)ended=true;if(reject)return{success:false,reason:'stale_dialog'};
   femiHelp=i===2?2:1;if(stuck)return{success:true};if(retireTicks){retireAt=tick+retireTicks;return{success:true};}}
  page++;show();return{success:true};};
 const s={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),
  sdk:{getState:()=>({tick,player,dialog,gameMessages:[],nearbyNpcs:[{id:676,name:'Femi',x:2459,z:3382}],nearbyLocs:[{id:190,name:'Gate',x:2459,z:3383}]}),
   sendClickDialog:click,clickDialogByText:async()=>click(2)},
  direct:async(a:{type:string;locId?:number})=>{events.push(`${a.type}:${a.locId}`);if(cancel)ended=true;
   if(femiHelp===0){page=0;show();}else if(crosses)crossAt=tick+2;},
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;
  if(retireAt&&tick>=retireAt){retireAt=0;page++;show();}
  if(duplicate&&page===2&&clickTick){show();dialog.pageId=`duplicate-${tick}`;dialog.isWaiting=tick%2===0;}
  if(!complete&&page===3)dialog=closed;
  if(crossAt&&tick===crossAt-1)player.worldZ=3384;
  if(crossAt&&tick>=crossAt){player.worldZ=intermediate?3384:3385;crossAt=0;}
  for(const cb of [...callbacks])cb();},1);
 let heals=0;
 const deps={left:()=>{if(ended)throw Error('session interrupted');if(tick>5000)throw Error('entry tick budget exhausted');},
  live:()=>{if(ended)throw Error('session interrupted');},health:async()=>{heals++;}};
 return{s:s as unknown as Session,deps,events,player,femi:()=>femiHelp,heals:()=>heals,stop:()=>clearInterval(timer)};
}
test('public entry answers Femi, reopens the gate and observes the north entrance',async()=>{
 const f=gateFixture();
 try{const r=await crossStrongholdGate(f.s,f.deps);
  expect(r).toMatchObject({opens:2,femi:1,at:'2461,3385,0'});expect(f.femi()).toBe(2);
  expect(f.events.filter(e=>e==='interactLoc:190')).toHaveLength(2);expect(f.events).toContain('click:2');expect(f.events).not.toContain('click:1');
  expect(f.heals()).toBe(2);
 }finally{f.stop();}
});
test('an account that already answered Femi crosses on the first Open',async()=>{
 const f=gateFixture({femi:false});
 try{expect(await crossStrongholdGate(f.s,f.deps)).toMatchObject({opens:1,femi:0,at:'2461,3385,0'});expect(f.events.some(e=>e.startsWith('click'))).toBe(false);}finally{f.stop();}
});

test('delayed retirement and duplicate option publications dispatch the supported choice once',async()=>{
 const f=gateFixture({retireTicks:5,duplicate:true});
 try{const r=await crossStrongholdGate(f.s,f.deps);
  expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
  expect(r).toMatchObject({femi:1,choiceAttempts:1,at:'2461,3385,0'});
 }finally{f.stop();}
});

test('native component text and published Continue options prove the final help page',async()=>{
 const f=gateFixture({componentsOnly:true,retireTicks:3});
 try{const r=await crossStrongholdGate(f.s,f.deps);
  expect(r.femi).toBe(1);expect(r.choices[0]!.reply.success).toBe(true);
  expect(r.choices[0]!.advanced!.tick).toBeGreaterThan(r.choices[0]!.tick);
  expect(r.choices[0]!.completed!.page.text).toContain('Thanks again friend!');
  expect(r.at).toBe('2461,3385,0');expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
 }finally{f.stop();}
});

test('a rejected supported choice stops with the reply and never earns a completion',async()=>{
 const f=gateFixture({reject:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('stale_dialog');
  expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
  expect(f.events.filter(e=>e==='interactLoc:190')).toHaveLength(1);
 }finally{f.stop();}
});

test('an unresolved accepted option page expires without another dispatch or Open',async()=>{
 const f=gateFixture({stuck:true,duplicate:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('dialogue advancement unobserved');
  expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
  expect(f.events.filter(e=>e==='interactLoc:190')).toHaveLength(1);
 }finally{f.stop();}
});

test('choice dispatch followed by cancellation cannot reopen the gate',async()=>{
 const f=gateFixture({cancelChoice:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('session interrupted');
  expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
  expect(f.events.filter(e=>e==='interactLoc:190')).toHaveLength(1);
 }finally{f.stop();}
});

test('an intermediate force-move tile is not completed public crossing',async()=>{
 const f=gateFixture({femi:false,intermediate:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('north entrance unobserved');
  expect(f.player.worldZ).toBe(3384);
 }finally{f.stop();}
});

test('a closed dialogue without the source-backed final thanks is not Femi completion',async()=>{
 const f=gateFixture({complete:false});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('Femi completion unobserved');}
 finally{f.stop();}
});
// Replays the retained agixavn07 order (ticks 51-72) and femi.rs2 grandtree_femi_boxes: each click retires
// its page 2 ticks later. "Thanks traveller!" closes UI, force-walks south to 2461,3380, animates, and only
// after `settle` ticks sets femi_help=2 and opens "Thanks again friend!". A later Open crosses north.
function femiNativeFixture({settle=9,final=true,rejectFinal=false,cancelSettle=false,intermediate=false}={}){
 let tick=50,ended=false,femiHelp=0,page=-1,openAt=0,turnAt=0,closeAt=0,finalAt=0,walk:number[]=[];
 const events:string[]=[],callbacks=new Set<()=>void>(),player={worldX:2461,worldZ:3382,level:0,animId:-1};
 const closed={isOpen:false,isWaiting:false,options:[] as {index:number;text:string}[],text:''};let dialog:any=closed;
 const cont=[{index:1,text:'Click here to continue',componentId:972}];
 const pages=[{text:'Femi|Hello there.',options:cont},{text:'Agixavn07|Hi!',options:cont},
  {text:"Select an Option|Sorry, I'm a bit busy.|OK then.",options:[{index:1,text:"Sorry, I'm a bit busy.",componentId:2461},{index:2,text:'OK then.',componentId:2462}]},
  {text:'Agixavn07|OK then.',options:cont},{text:'Femi|Thanks traveller!',options:cont},{text:'Femi|Thanks again friend!',options:cont}];
 const show=()=>{dialog=page<0?closed:{isOpen:true,isWaiting:false,pageId:`p${page}`,allComponents:[],...pages[page]!};};
 const click=async(i:number)=>{events.push(`click:${i}`);
  if(page===5&&rejectFinal)return{success:false,reason:'stale_dialog'};
  turnAt=tick+2;return{success:true};};
 const s={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),
  sdk:{getState:()=>({tick,player,dialog,gameMessages:[],nearbyNpcs:[{id:676,name:'Femi',x:2460,z:3382}],nearbyLocs:[{id:190,name:'Gate',x:2459,z:3383}]}),
   sendClickDialog:click,clickDialogByText:async()=>click(2)},
  direct:async(a:{type:string;locId?:number})=>{events.push(`${a.type}:${a.locId}@${tick}`);
   if(femiHelp===0){if(page<0&&!closeAt)openAt=tick+2;return{success:true};}
   walk=[tick+1,tick+2,tick+3];return{success:true};},
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;
  if(openAt&&tick>=openAt){openAt=0;page=0;show();}
  if(turnAt&&tick>=turnAt){turnAt=0;
   if(page===4){page=-1;show();closeAt=tick;finalAt=tick+settle;}
   else if(page===5){page=-1;show();}
   else{page++;show();}}
  if(closeAt&&tick===closeAt+1){player.worldZ=3381;}
  if(closeAt&&tick===closeAt+2){player.worldZ=3380;}
  if(closeAt&&tick>=closeAt+3&&tick<closeAt+settle)player.animId=tick%3===0?827:-1;
  if(cancelSettle&&closeAt&&tick===closeAt+4)ended=true;
  if(final&&finalAt&&tick>=finalAt){finalAt=0;femiHelp=2;player.animId=-1;page=5;show();}
  if(walk.length&&tick>=walk[0]!){const step=walk.length;walk.shift();player.worldZ=step===3?3382:step===2?3384:intermediate?3384:3385;}
  for(const cb of [...callbacks])cb();},1);
 const deps={left:()=>{if(ended)throw Error('session interrupted');if(tick>5000)throw Error('entry tick budget exhausted');},
  live:()=>{if(ended)throw Error('session interrupted');},health:async()=>{}};
 return{s:s as unknown as Session,deps,events,player,femi:()=>femiHelp,stop:()=>clearInterval(timer)};
}
const opens=(e:string[])=>e.filter(x=>x.startsWith('interactLoc:190'));
test('Femi box settlement with UI closed past the quiet bound completes, then the next Open crosses',async()=>{
 const f=femiNativeFixture();
 try{const r=await crossStrongholdGate(f.s,f.deps);
  expect(r).toMatchObject({opens:2,femi:1,choiceAttempts:1,at:'2461,3385,0'});
  expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
  const c=r.choices[0]!,st=c.settle!;
  expect(c.accepted!.page.text).toContain('Thanks traveller!');expect(c.completed!.page.text).toContain('Thanks again friend!');
  expect(st.end!-st.start).toBeGreaterThanOrEqual(STRONGHOLD_GATE.quietTicks);
  expect(st.marks.map(m=>m.at)).toContain('2461,3380,0');expect(st.marks.some(m=>m.anim===827)).toBe(true);
  expect(st.marks.every(m=>!m.open)).toBe(true);
  // The second Open follows the final continuation, never the closed action phase.
  const second=Number(opens(f.events)[1]!.split('@')[1]);
  expect(second).toBeGreaterThan(c.completed!.tick);
  expect(f.events.indexOf(opens(f.events)[1]!)).toBeGreaterThan(f.events.lastIndexOf('click:0'));
 }finally{f.stop();}
});
test('a final thanks that never arrives fails as unresolved settlement without another Open',async()=>{
 const f=femiNativeFixture({final:false});
 try{const e=await crossStrongholdGate(f.s,f.deps).then(()=>null,(x:Error)=>x);
  expect(e?.message).toContain('Femi settlement unresolved');expect(e?.message).toContain('"at":"2461,3380,0"');
  expect(opens(f.events)).toHaveLength(1);expect(f.events.filter(e=>e==='click:2')).toHaveLength(1);
 }finally{f.stop();}
});
test('settlement one tick past the source bound fails explicitly',async()=>{
 const f=femiNativeFixture({settle:STRONGHOLD_GATE.femiSettle.ticks+1});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('Femi settlement unresolved');expect(opens(f.events)).toHaveLength(1);}
 finally{f.stop();}
});
test('a rejected final continuation stops without a crossing receipt or another Open',async()=>{
 const f=femiNativeFixture({rejectFinal:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('stale_dialog');expect(opens(f.events)).toHaveLength(1);}
 finally{f.stop();}
});
test('cancellation during the box action stops without another Open or click',async()=>{
 const f=femiNativeFixture({cancelSettle:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('session interrupted');
  expect(opens(f.events)).toHaveLength(1);expect(f.events.filter(e=>e.startsWith('click')).length).toBe(5);
 }finally{f.stop();}
});
test('an intermediate force-move tile after Femi help is refused as crossing',async()=>{
 const f=femiNativeFixture({intermediate:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('north entrance unobserved');expect(f.player.worldZ).toBe(3384);}
 finally{f.stop();}
});
test('an unknown dialogue choice fails with its text and is never answered',async()=>{
 const f=gateFixture({choice:'Maybe later.'});
 try{const e=await crossStrongholdGate(f.s,f.deps).then(()=>null,(x:Error)=>x);
  expect(e?.message).toContain('unexpected dialogue choice');expect(e?.message).toContain('Maybe later.');expect(e?.message).toContain('"at":"2461,3382,0"');
  expect(f.events).toEqual(['interactLoc:190','click:0','click:0']);expect(f.femi()).toBe(0);
 }finally{f.stop();}
});
test('a gate that never opens fails after the bounded attempts with position and nearby evidence',async()=>{
 const f=gateFixture({femi:false,crosses:false});
 try{const e=await crossStrongholdGate(f.s,f.deps).then(()=>null,(x:Error)=>x);
  expect(e?.message).toContain('north entrance unobserved');expect(e?.message).toContain('"opens":4');expect(e?.message).toContain('Femi');expect(e?.message).toContain('"id":190');
  expect(f.events.filter(x=>x==='interactLoc:190')).toHaveLength(STRONGHOLD_GATE.attempts);
 }finally{f.stop();}
});
test('cancellation during the gate stops without another Open or dialogue click',async()=>{
 const f=gateFixture({cancel:true});
 try{await expect(crossStrongholdGate(f.s,f.deps)).rejects.toThrow('session interrupted');expect(f.events).toEqual(['interactLoc:190']);expect(f.player.worldZ).toBe(3382);}finally{f.stop();}
});
test('the retained tile inside the broad rectangle still needs a starting-obstacle approach',()=>{
 expect(onCourse('gnome',{worldX:2494,worldZ:3437,level:0})).toBe(true);
 expect(needsCourseApproach('gnome',{worldX:2494,worldZ:3437,level:0})).toBe(true);
 expect(needsCourseApproach('gnome',{worldX:2474,worldZ:3437,level:0})).toBe(false);
 expect(needsCourseApproach('gnome',{worldX:2473,worldZ:3423,level:1})).toBe(false);
 expect(needsCourseApproach('gnome',{worldX:2484,worldZ:3428,level:0})).toBe(false);
});

test('finite validated budgets and exact course names',()=>{
 for(const target of ['0','100','NaN','1.2'])expect(()=>agilityOptions('gnome',target,{})).toThrow();
 for(const course of ['__proto__','constructor','arena'])expect(()=>agilityOptions(course,'10',{})).toThrow();
 expect(()=>agilityOptions('gnome','10',{AGI_MAX_TICKS:'Infinity'})).toThrow();
 expect(agilityOptions('gnome','10',{}).maxTicks).toBe(10000);
});
test('entry rejects target reruns and unavailable course prerequisites',()=>{
 const g=agilityOptions('gnome','10',{});expect(agilityPreflight(g,10,10)).toBe('already at target');
 const w=agilityOptions('wilderness','60',{});expect(agilityPreflight(w,49,49)).toContain('52');
 expect(agilityPreflight({...w,potion:true},49,49)).toBeNull();
 const b=agilityOptions('barbarian','60',{});expect(agilityPreflight(b,35,35)).toContain('Barcrawl');
 expect(agilityPreflight({...b,barcrawl:2},35,35)).toBeNull();
});
test('restart uses landing planes and sides instead of resetting the lap',()=>{
 const step=(c:Course,x:number,z:number,level=0)=>resumeStep(c,{worldX:x,worldZ:z,level});
 expect(step('gnome',2473,3423,1)).toBe(2);expect(step('gnome',2484,3420,2)).toBe(4);
 expect(step('gnome',2484,3428)).toBe(6);expect(step('gnome',2474,3428)).toBe(1);
 expect(step('wilderness',3005,3962)).toBe(2);expect(step('wilderness',2996,3960)).toBe(3);
 expect(step('wilderness',2994,3945)).toBe(4);expect(step('barbarian',2532,3545,1)).toBe(4);
});
test('entry and early clicks cannot stand in for a completed obstacle',()=>{
 expect(onCourse('barbarian',{worldX:2552,worldZ:3561,level:0})).toBe(false);
 expect(onCourse('wilderness',{worldX:3004,worldZ:3937,level:1})).toBe(false);
 expect(wildernessStarted('pipe',{worldX:3004,worldZ:3940,level:0})).toBe(true);
 expect(wildernessStarted('pipe',{worldX:3004,worldZ:3937,level:0})).toBe(false);
 expect(wildernessStarted('log',{worldX:2998,worldZ:10360,level:0})).toBe(false);
});
// The fake emits actual effects separately from action dispatch. A successful click alone never passes.
function fixture({level=1,effect=true,disconnect=false,lowHp=false,at={worldX:2474,worldZ:3437,level:0},inventory=[] as {id:number;name:string;count:number;slot:number}[]}={}){
 let tick=0,xp=0,current=level,actions=0,resolveEnd!:(r:{reason:string})=>void;
 const callbacks=new Set<()=>void>(),ended=new Promise<{reason:string}>(r=>{resolveEnd=r;});
 const p={...at};
 const act=async()=>{actions++;return{success:true};};
 const s={name:'fixture',tick:()=>tick,ended,
  sdk:{getState:()=>({player:p,inventory,gameMessages:[]}),getInventory:()=>inventory,getSkillXp:()=>xp,
   getSkill:(name:string)=>name==='Agility'?{level:current,baseLevel:current}:{level:lowHp?3:10,baseLevel:10}},
  bot:{walkTo:act,talkTo:act,openShop:act,interactLoc:act},direct:act,
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;if(disconnect){clearInterval(timer);resolveEnd({reason:'connection lost'});return;}
  if(effect&&actions){xp+=100;current=2;}for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,actions:()=>actions,stop:()=>clearInterval(timer)};
}
test('target rerun refuses without an action',async()=>{const f=fixture({level:2});try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('already at target');expect(f.actions()).toBe(0);}finally{f.stop();}});
test('worker records the account and client projection before its first game action',async()=>{
 const f=fixture(),original=console.log,records:{line:string;actions:number}[]=[];
 const state=f.s.sdk.getState.bind(f.s.sdk),skills=Array.from({length:21},(_,i)=>({name:String(i),experience:i,level:1,baseLevel:1}));
 f.s.sdk.getState=(()=>({...state(),skills,equipment:[{slot:3,id:1351,count:1}]})) as typeof f.s.sdk.getState;
 console.log=(...args:unknown[])=>{records.push({line:args.join(' '),actions:f.actions()});};
 try{
  await runAgility(f.s,agilityOptions('gnome','2',{}));
  const initial=records.filter(r=>r.line.startsWith('AGILITY_INITIAL '));expect(initial).toHaveLength(1);expect(initial[0]!.actions).toBe(0);
  expect(JSON.parse(initial[0]!.line.slice('AGILITY_INITIAL '.length))).toMatchObject({name:'fixture',course:'gnome',target:2,state:{
   position:{x:2474,z:3437,level:0},skills:skills.map(({experience,level,baseLevel})=>({experience,level,baseLevel})),
   inventory:[],equipment:[{slot:3,id:1351,count:1}]}});
 }finally{console.log=original;f.stop();}
});
test('observed level and XP effect meet the order',async()=>{const f=fixture();try{const r=await runAgility(f.s,agilityOptions('gnome','2',{}));expect(r.level).toBe(2);expect(r.xpGained).toBeGreaterThan(0);}finally{f.stop();}});
test('SDK success without an effect expires',async()=>{const f=fixture({effect:false});try{await expect(runAgility(f.s,agilityOptions('gnome','2',{AGI_PROGRESS_TICKS:'4'}))).rejects.toThrow('no observed progress');}finally{f.stop();}});
test('disconnect ends waits instead of looping with a frozen tick',async()=>{const f=fixture({disconnect:true});try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('session interrupted');}finally{f.stop();}});
test('low HP with no food refuses before any obstacle',async()=>{const f=fixture({lowHp:true});try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('no owned food');expect(f.actions()).toBe(0);}finally{f.stop();}});
test('total tick budget propagates failure even without a progress timeout',async()=>{const f=fixture({effect:false});try{await expect(runAgility(f.s,agilityOptions('gnome','2',{AGI_MAX_TICKS:'3'}))).rejects.toThrow('tick budget exhausted');}finally{f.stop();}});

test('gnome entry sails from Draynor and never walks over White Wolf Mountain',()=>{
 const at=(worldX:number,worldZ:number,level=0)=>gnomeEntry({worldX,worldZ,level});
 expect(at(3092,3242)).toBe('draynor');expect(at(3029,3217)).toBe('draynor');
 expect(at(2683,3270)).toBe('walk');expect(at(2460,3445)).toBe('walk');
 // Falador, Taverley and Catherby are east of the mountain pass but not on the sailing lane.
 expect(at(2964,3378)).toBeNull();expect(at(2895,3440)).toBeNull();expect(at(2810,3437)).toBeNull();
 expect(at(3092,3242,1)).toBeNull();
 expect(draynorFunds(440,0)).toBeNull();expect(draynorFunds(60,3)).toBeNull();
 expect(draynorFunds(60,0)).toContain('72');expect(draynorFunds(59,3)).toContain('60');
});
test('an unfunded Draynor start refuses before any action',async()=>{
 const f=fixture({at:{worldX:3092,worldZ:3242,level:0},inventory:[{id:995,name:'Coins',count:40,slot:0}]});
 try{await expect(runAgility(f.s,agilityOptions('gnome','10',{}))).rejects.toThrow('needs 72 carried coins');expect(f.actions()).toBe(0);}finally{f.stop();}
});
test('a start with no safe Gnome route refuses before any action',async()=>{
 const f=fixture({at:{worldX:2895,worldZ:3440,level:0}});
 try{await expect(runAgility(f.s,agilityOptions('gnome','10',{}))).rejects.toThrow('unsupported gnome entry region');expect(f.actions()).toBe(0);}finally{f.stop();}
});
test('a Draynor start with low HP and no food refuses before any action',async()=>{
 const f=fixture({lowHp:true,at:{worldX:3092,worldZ:3242,level:0},inventory:[{id:995,name:'Coins',count:440,slot:0}]});
 try{await expect(runAgility(f.s,agilityOptions('gnome','10',{}))).rejects.toThrow('no owned food');expect(f.actions()).toBe(0);}finally{f.stop();}
});

// Recorded failure (agility-order-1793220902759-A5gNoq): the dock tile 3029,3217 did not observe Wydin and
// openShop returned 'Shopkeeper not found'. The fake shows Wydin only after the approach reaches the shop.
function shopFixture({coins=440,appear=true,trade=true,reach=true,price=2}={}){
 let tick=0,ended=false;const events:string[]=[],callbacks=new Set<()=>void>();
 const player={worldX:3029,worldZ:3217,level:0};
 const inventory:{id:number;name:string;count:number;slot:number}[]=[{id:995,name:'Coins',count:coins,slot:0}];
 const seaman={id:3644,index:2,name:'Seaman Lorris',x:3027,z:3218,optionsWithIndex:[{text:'Talk-to',opIndex:1}]};
 const wydin={id:557,index:7,name:'Wydin',x:3014,z:3204,optionsWithIndex:[{text:'Talk-to',opIndex:1},...(trade?[{text:'Trade',opIndex:3}]:[])]};
 const shop={isOpen:false,title:"Wydin's Food Store",shopItems:[{slot:0,id:1963,name:'Banana',count:3,buyPrice:price},{slot:1,id:1985,name:'Cheese',count:3,buyPrice:price*2}]};
 const npcs=()=>appear&&Math.abs(player.worldX-3015)<=2&&Math.abs(player.worldZ-3206)<=2?[seaman,wydin]:[seaman];
 const s={name:'fixture',tick:()=>tick,
  sdk:{getState:()=>({tick,player,inventory,nearbyNpcs:npcs(),shop}),getInventory:()=>inventory},
  bot:{openShop:async(n:{id:number})=>{events.push(`open:${n.id}`);shop.isOpen=true;return{success:true,message:'Opened'};},
   closeShop:async()=>{events.push('close');shop.isOpen=false;return{success:true};},
   buyFromShop:async(line:{id:number;name:string;buyPrice:number},n:number)=>{events.push(`buy:${line.name}`);const c=inventory[0]!;c.count-=line.buyPrice*n;
    const held=inventory.find(i=>i.id===line.id);if(held)held.count+=n;else inventory.push({id:line.id,name:line.name,count:n,slot:inventory.length});
    shop.shopItems.find(x=>x.id===line.id)!.count-=n;return{success:true};}},
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 const coinCount=()=>inventory.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
 const owned=()=>inventory.filter(i=>/^(banana|cheese)$/i.test(i.name)).reduce((n,i)=>n+i.count,0);
 const deps={approach:async(points:{x:number;z:number}[],label:string)=>{events.push(`approach:${label}:${points[0]!.x},${points[0]!.z}`);if(!reach)throw Error(`${label} unobserved`);Object.assign(player,{worldX:points[0]!.x,worldZ:points[0]!.z});},
  left:()=>{if(ended)throw Error('session interrupted');},live:()=>{if(ended)throw Error('session interrupted');},coins:coinCount,owned,deadline:1000};
 return{s:s as unknown as Session,deps,events,player,coins:coinCount,owned,end:()=>{ended=true;},stop:()=>clearInterval(timer)};
}
test('a dock entry without Wydin in view approaches the public shop before opening it',async()=>{
 const f=shopFixture();
 try{const r=await buyEntryFood(f.s,f.deps);
  expect(f.events[0]).toBe('approach:walk to Wydin:3015,3206');expect(f.events[1]).toBe('open:557');
  expect(r).toEqual({bought:6,spent:18});expect(f.owned()).toBe(6);expect(f.coins()).toBe(422);expect(f.events.at(-1)).toBe('close');
 }finally{f.stop();}
});
test('the shop waypoint never targets the employee door or back room',()=>{
 expect(DRAYNOR_ENTRY.shop.x-DRAYNOR_ENTRY.shop.tol).toBeGreaterThan(3012);
});
test('Wydin unobserved at the shop refuses with position and nearby NPC diagnostics',async()=>{
 const f=shopFixture({appear:false});
 try{const e=await buyEntryFood(f.s,f.deps).then(()=>null,(x:Error)=>x);
  expect(e?.message).toContain('Wydin unobserved');expect(e?.message).toContain('3015,3206,0');expect(e?.message).toContain('Seaman Lorris');
  expect(f.events.some(x=>x.startsWith('open'))).toBe(false);expect(f.coins()).toBe(440);
 }finally{f.stop();}
});
test('Wydin without a Trade option refuses before opening',async()=>{
 const f=shopFixture({trade:false});
 try{await expect(buyEntryFood(f.s,f.deps)).rejects.toThrow('Trade option unobserved');expect(f.events.some(x=>x.startsWith('open'))).toBe(false);}finally{f.stop();}
});
test('an unreachable shop propagates the walk failure without opening',async()=>{
 const f=shopFixture({reach:false});
 try{await expect(buyEntryFood(f.s,f.deps)).rejects.toThrow('walk to Wydin unobserved');expect(f.events).toEqual(['approach:walk to Wydin:3015,3206']);}finally{f.stop();}
});
test('purchases stop at the two-fare reserve',async()=>{
 const f=shopFixture({coins:64});
 try{const r=await buyEntryFood(f.s,f.deps);expect(r).toEqual({bought:2,spent:4});expect(f.coins()).toBe(60);}finally{f.stop();}
});
test('a fare reserve with no spare coins refuses without a purchase',async()=>{
 const f=shopFixture({coins:61});
 try{await expect(buyEntryFood(f.s,f.deps)).rejects.toThrow('food purchase effect unobserved');expect(f.coins()).toBe(61);expect(f.events.at(-1)).toBe('close');}finally{f.stop();}
});
test('a cancelled session closes the shop and propagates the interruption',async()=>{
 const f=shopFixture();const open=f.s.bot.openShop.bind(f.s.bot);
 (f.s.bot as any).openShop=async(n:any)=>{const r=await open(n);f.end();return r;};
 try{await expect(buyEntryFood(f.s,f.deps)).rejects.toThrow('session interrupted');expect(f.events.some(x=>x.startsWith('buy'))).toBe(false);expect(f.events.at(-1)).toBe('close');}finally{f.stop();}
});
test('missing XP observation refuses before acting',async()=>{
 const f=fixture({effect:false});f.s.sdk.getSkillXp=()=>undefined as any;
 try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('entry state unobserved');expect(f.actions()).toBe(0);}finally{f.stop();}
});

test('an observed fall recovers from the pit and earns XP after recovery',async()=>{
 let ticks=0,xp=42000,base=52,action=0,fell=false;
 const callbacks=new Set<()=>void>(),player={worldX:3005,worldZ:3950,level:0};
 const gameMessages:{observationId:number;tick:number;text:string}[]=[];
 const s={name:'fixture',tick:()=>ticks,ended:new Promise(()=>{}),
  sdk:{getState:()=>({player,inventory:[],gameMessages}),getInventory:()=>[],getSkillXp:()=>xp,
   getSkill:(name:string)=>name==='Agility'?{level:base,baseLevel:base}:{level:fell?58:70,baseLevel:70}},
  direct:async(a:{locId?:number})=>{action=a.locId??0;},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{ticks++;
  if(action===2283&&!fell){fell=true;player.worldZ=10357;gameMessages.push({observationId:1,tick:ticks,text:'You slip and fall to the pit below.'});action=0;}
  else if(action===1755){player.worldZ=3962;action=0;}
  else if(action===2311){xp+=500;base=53;player.worldX=2996;player.worldZ=3960;action=0;}
  for(const cb of [...callbacks])cb();},1);
 try{const r=await runAgility(s as unknown as Session,agilityOptions('wilderness','53',{}));expect(r.falls).toBe(1);expect(r.pitExits).toBe(1);expect(r.xpGained).toBe(500);}finally{clearInterval(timer);}
});
test('a recovered pit landing continues training without owning cleanup',async()=>{
 let ticks=0,xp=42000,base=52,action=0,closes=0;
 const callbacks=new Set<()=>void>(),player={worldX:3005,worldZ:10363,level:0};
 const s={name:'fixture',tick:()=>ticks,ended:new Promise(()=>{}),close:async()=>{closes++;},
  sdk:{getState:()=>({player,inventory:[],gameMessages:[]}),getInventory:()=>[],getSkillXp:()=>xp,
   getSkill:(name:string)=>name==='Agility'?{level:base,baseLevel:base}:{level:70,baseLevel:70}},
  direct:async(a:{locId?:number})=>{action=a.locId??0;},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{ticks++;if(action===1755){player.worldZ=3962;action=0;}
  else if(action===2311){xp+=500;base=53;action=0;}for(const cb of [...callbacks])cb();},1);
 try{const result=await runAgility(s as unknown as Session,agilityOptions('wilderness','53',{}));expect(result.pitExits).toBe(1);expect(result.xpGained).toBe(500);expect(closes).toBe(0);}finally{clearInterval(timer);}
});

// Server model of consume.rs2 player_consume_item: an accepted eat sets eatDelay=tick+2 and any
// eat while eatDelay>=tick is discarded silently. Delivery 1793228337659-LzzYtU fall-1 ended at
// HP 34/70 after two lobsters with 'food effect unobserved': the low-HP re-eat landed in that delay.
function eatFixture({hp=10,base=70,lobsters=15,heal=12,refuse=false,applyAfter=1,never=false,endOnEat=false}={}){
 let tick=0,xp=0,level=1,pending=false,eatAt=-1,eatDelay=-1,discarded=0,eats=0,resolveEnd!:(r:{reason:string})=>void;
 const callbacks=new Set<()=>void>(),ended=new Promise<{reason:string}>(r=>{resolveEnd=r;});
 const player={worldX:2474,worldZ:3437,level:0,animId:-1};
 const inventory=Array.from({length:lobsters},(_,slot)=>({id:379,name:'Lobster',count:1,slot}));
 const state={hp};
 const s={name:'fixture',tick:()=>tick,ended,
  sdk:{getState:()=>({player,inventory,gameMessages:[],dialog:{isOpen:false},opFeedback:{opRejectedCount:0}}),getInventory:()=>inventory,getSkillXp:()=>xp,
   getSkill:(name:string)=>name==='Agility'?{level,baseLevel:level}:{level:state.hp,baseLevel:base}},
  direct:async(a:{type:string;slot?:number})=>{
   if(a.type!=='useInventoryItem'){pending=true;return{success:true};}
   if(refuse)return{success:false,message:'component not visible'};
   if(endOnEat)resolveEnd({reason:'connection lost'});
   eatAt=tick+applyAfter;return{success:true};
  },
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;
  if(eatAt>=0&&tick>=eatAt&&!never){eatAt=-1;
   if(eatDelay>=tick)discarded++;
   else{eatDelay=tick+EAT_DELAY_TICKS;const i=inventory.findIndex(x=>x.id===379);inventory.splice(i,1);state.hp=Math.min(base,state.hp+heal);eats++;}}
  if(pending){pending=false;xp+=100;level=2;}
  for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,state,inventory,discarded:()=>discarded,eats:()=>eats,stop:()=>clearInterval(timer)};
}
test('eat readiness follows the pinned two-tick eat delay',()=>{
 expect(eatReady(-Infinity,0)).toBe(true);expect(eatReady(10,11)).toBe(false);expect(eatReady(10,12)).toBe(false);expect(eatReady(10,13)).toBe(true);
});
test('a low-HP re-eat waits out the eat delay instead of sending a discarded op',async()=>{
 const f=eatFixture();
 const lines:string[]=[],log=console.log;console.log=(...v:unknown[])=>{lines.push(v.join(' '));};
 try{const r=await runAgility(f.s,agilityOptions('gnome','2',{}));
  expect(f.discarded()).toBe(0);expect(r.eats).toBe(3);expect(f.eats()).toBe(3);expect(f.state.hp).toBe(46);expect(f.inventory.length).toBe(12);
  const trace=lines.filter(l=>l.startsWith('AGILITY_FOOD ')).map(l=>JSON.parse(l.slice('AGILITY_FOOD '.length)));
  const dispatch=trace.filter(e=>e.event==='dispatch'),effects=trace.filter(e=>e.event==='effect');
  expect(dispatch.map(e=>[e.sequence,e.slot,e.id,e.held,e.hp])).toEqual([[1,0,379,15,10],[2,1,379,14,22],[3,2,379,13,34]]);
  expect(effects.map(e=>[e.hp,e.count])).toEqual([[22,14],[34,13],[46,12]]);
  expect(trace.filter(e=>e.event==='reply').every(e=>e.reply.success)).toBe(true);
  expect(trace.filter(e=>e.event==='cooldown')).toHaveLength(2);
  for(let i=0;i<3;i++){
   expect(effects[i].hpTick).toBe(effects[i].tick);expect(effects[i].inventoryTick).toBe(effects[i].tick);
   expect(effects[i].tick-dispatch[i].tick).toBeLessThanOrEqual(8);
   if(i)expect(dispatch[i].tick).toBeGreaterThan(effects[i-1].tick+2);
  }
 }finally{console.log=log;f.stop();}
});
test('a refused food dispatch fails with its reply and no debit',async()=>{
 const f=eatFixture({refuse:true});
 try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('food dispatch refused');expect(f.inventory.length).toBe(15);}finally{f.stop();}
});
test('a delayed supported food effect inside the bound is accepted once',async()=>{
 const f=eatFixture({hp:30,applyAfter:5});
 try{const r=await runAgility(f.s,agilityOptions('gnome','2',{}));expect(r.eats).toBe(1);expect(f.inventory.length).toBe(14);expect(f.state.hp).toBe(42);}finally{f.stop();}
});
test('a session ended during the food wait reports interruption, not a food result',async()=>{
 const f=eatFixture({endOnEat:true,never:true});
 try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('session interrupted');}finally{f.stop();}
});
test('food depleted below the HP floor refuses before any obstacle',async()=>{
 const f=eatFixture({lobsters:1});
 try{await expect(runAgility(f.s,agilityOptions('gnome','2',{}))).rejects.toThrow('low HP: no owned food');expect(f.eats()).toBe(1);expect(f.state.hp).toBe(22);}finally{f.stop();}
});
test('an unresolved food effect fails with dispatch, HP, item and UI diagnostics',async()=>{
 const f=eatFixture({never:true});
 try{const e=await runAgility(f.s,agilityOptions('gnome','2',{})).then(()=>null,(x:Error)=>x);
  expect(e?.message).toStartWith('food effect unobserved: ');
  const d=JSON.parse(e!.message.slice('food effect unobserved: '.length));
  expect(d).toMatchObject({oldHp:10,hp:10,slot:0,id:379,held:15,count:15,anim:-1,dialog:false,rejected:0,messages:[]});
  expect(d.tick-d.sentAt).toBe(8);expect(f.inventory.length).toBe(15);
 }finally{f.stop();}
});
test('a restart with retained stock eats from that stock and debits exactly once per eat',async()=>{
 const first=eatFixture({hp:30,lobsters:3});
 let left=0;
 try{const r=await runAgility(first.s,agilityOptions('gnome','2',{}));expect(r.eats).toBe(1);left=first.inventory.length;expect(left).toBe(2);}finally{first.stop();}
 const again=eatFixture({hp:30,lobsters:left});
 try{const r=await runAgility(again.s,agilityOptions('gnome','2',{}));expect(r.eats).toBe(1);expect(again.inventory.length).toBe(1);expect(again.discarded()).toBe(0);}finally{again.stop();}
});

// Server model of the recorded fall-1 550-558 trace. wilderness_stepping_stone: p_arrivedelay, then six
// agility_exactmove jumps (anim 741, p_exactmove -> UNSET_MAP_FLAG, p_delay(1)). While delayed, OpHeld is
// dropped with no feedback (OpHeldHandler) and OpLoc gets UNSET_MAP_FLAG (OpLocHandler). Published HP
// trails the earlier fall damage: 36 at dispatch, 33 from the third script tick. Retained stock: slots 1..14.
function stonesFixture({forever=false,onStones=false,endAfter=-1,hp0=36,hpLow=33}={}){
 let tick=0,xp=112166,level=52,anim=-1,rejected=0,script=-1,eatAt=-1,eatDelay=-1,dropped=0,eats=0,resolveEnd!:(r:{reason:string})=>void;
 const callbacks=new Set<()=>void>(),ended=new Promise<{reason:string}>(r=>{resolveEnd=r;});
 const player={worldX:3005,worldZ:3962,level:0,animId:-1};
 const inventory=Array.from({length:14},(_,i)=>({id:379,name:'Lobster',count:1,slot:i+1}));
 const state={hp:hp0},sent:{tick:number;type:string;locId?:number;slot?:number;delayed:boolean}[]=[];
 const delayed=()=>script>=0;
 const s={name:'fixture',tick:()=>tick,ended,
  sdk:{getState:()=>({player:{...player,animId:anim},inventory,gameMessages:[],dialog:{isOpen:false},opFeedback:{opRejectedCount:rejected,mapFlagUnsetCount:rejected}}),
   getInventory:()=>inventory,getSkillXp:()=>xp,
   getSkill:(name:string)=>name==='Agility'?{level,baseLevel:level}:{level:state.hp,baseLevel:70}},
  direct:async(a:{type:string;locId?:number;slot?:number})=>{
   sent.push({tick,type:a.type,locId:a.locId,slot:a.slot,delayed:delayed()});
   if(a.type==='useInventoryItem'){if(delayed())dropped++;else eatAt=tick+1;return{success:true,message:`Using inventory slot ${a.slot}`,phase:'dispatch'};}
   if(delayed()){rejected++;return{success:true};}
   if(a.locId===2311)script=0;
   return{success:true};
  },
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};}};
 const timer=setInterval(()=>{tick++;
  if(endAfter>=0&&tick>=endAfter)resolveEnd({reason:'connection lost'});
  if(script>=0){script++;
   if(script===1)Object.assign(player,onStones?{worldX:3001,worldZ:3960}:{worldX:3002,worldZ:3960});
   if(script===3)state.hp=hpLow;
   const jump=script-2;
   if(jump>=0&&(forever||jump<12)){anim=jump%2===0?741:-1;if(jump%2===0)rejected++;}
   else if(!forever&&jump>=12){anim=-1;xp+=500;level=53;Object.assign(player,{worldX:2996,worldZ:3960});script=-1;}
  }
  if(eatAt>=0&&tick>=eatAt){eatAt=-1;
   if(eatDelay>=tick)dropped++;
   else{eatDelay=tick+EAT_DELAY_TICKS;const i=inventory.findIndex(x=>x.id===379);inventory.splice(i,1);state.hp=Math.min(70,state.hp+12);eats++;}}
  for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,state,inventory,sent,dropped:()=>dropped,eats:()=>eats,rejected:()=>rejected,stop:()=>clearInterval(timer)};
}
const captureFood=()=>{const lines:string[]=[],log=console.log;console.log=(...v:unknown[])=>{lines.push(v.join(' '));};
 return{events:()=>lines.filter(l=>l.startsWith('AGILITY_FOOD ')).map(l=>JSON.parse(l.slice('AGILITY_FOOD '.length))),lines,restore:()=>{console.log=log;}};};
test('the recorded 550-558 stones trace settles the obstacle before one exact heal and debit',async()=>{
 const f=stonesFixture(),c=captureFood();
 try{const r=await runAgility(f.s,agilityOptions('wilderness','53',{}));
  const ev=c.events(),settle=ev.filter(e=>e.event==='settle'),dispatch=ev.filter(e=>e.event==='dispatch'),effect=ev.filter(e=>e.event==='effect');
  expect(f.dropped()).toBe(0);expect(f.eats()).toBe(1);expect(r.eats).toBe(1);
  expect(settle).toHaveLength(1);expect(settle[0]).toMatchObject({sequence:1,step:'stones',settled:true,opsWhileSettling:0});
  expect(settle[0].xpTick).toBeGreaterThan(settle[0].dispatchTick);
  expect(settle[0].marks.some((m:any)=>m.anim===741)).toBe(true);
  expect(dispatch).toHaveLength(1);expect(dispatch[0].tick).toBe(settle[0].tick);expect(dispatch[0].tick-settle[0].xpTick).toBeGreaterThanOrEqual(6);
  expect(dispatch[0]).toMatchObject({slot:1,id:379,held:14,hp:33,count:14,anim:-1,rejected:0});
  expect(effect).toHaveLength(1);expect(effect[0]).toMatchObject({hp:45,count:13,rejected:0,ops:1});
  expect(effect[0].tick-dispatch[0].tick).toBeLessThanOrEqual(8);
  expect(f.inventory.map(i=>i.slot)).toEqual(Array.from({length:13},(_,i)=>i+2));
  expect(r.level).toBe(53);expect(r.xpGained).toBe(500);
 }finally{c.restore();f.stop();}
});
test('a pending obstacle is not an eat cooldown: no cooldown wait, no eat sent into the script',async()=>{
 const f=stonesFixture(),c=captureFood();
 try{await runAgility(f.s,agilityOptions('wilderness','53',{}));
  expect(c.events().filter(e=>e.event==='cooldown')).toHaveLength(0);
  expect(f.sent.filter(x=>x.type==='useInventoryItem').map(x=>x.delayed)).toEqual([false]);
 }finally{c.restore();f.stop();}
});
test('every opRejected rise during settlement is attributed to the script, not a worker packet',async()=>{
 const f=stonesFixture(),c=captureFood();
 try{await runAgility(f.s,agilityOptions('wilderness','53',{}));
  const settle=c.events().find(e=>e.event==='settle');
  const rejectedLocs=f.sent.filter(x=>x.type==='interactLoc'&&x.delayed).length;
  // Six exactmove unsets plus any obstacle click the server refused before health was due.
  expect(f.rejected()).toBe(6+rejectedLocs);
  expect(settle.opsWhileSettling).toBe(0);expect(f.sent.filter(x=>x.type==='useInventoryItem'&&x.delayed)).toHaveLength(0);
 }finally{c.restore();f.stop();}
});
test('alternating animation without settlement fails explicitly with original HP and stock',async()=>{
 const f=stonesFixture({forever:true}),c=captureFood();
 try{const e=await runAgility(f.s,agilityOptions('wilderness','53',{})).then(()=>null,(x:Error)=>x);
  expect(e?.message).toStartWith('obstacle settlement unresolved before food: ');
  const d=JSON.parse(e!.message.slice('obstacle settlement unresolved before food: '.length));
  expect(d).toMatchObject({step:'stones',settled:false,opsWhileSettling:0});expect(d.tick-d.start).toBe(40);
  expect(d.marks.filter((m:any)=>m.anim===-1).length).toBeGreaterThan(5);
  expect(f.sent.filter(x=>x.type==='useInventoryItem')).toHaveLength(0);
  expect(f.state.hp).toBe(33);expect(f.inventory).toHaveLength(14);
 }finally{c.restore();f.stop();}
});
test('no obstacle is dispatched while health recovery is due, including the speculative next click',async()=>{
 const f=stonesFixture({onStones:true}),c=captureFood();
 try{await runAgility(f.s,agilityOptions('wilderness','53',{}));
  const effect=c.events().find(e=>e.event==='effect');
  expect(f.sent.filter(x=>x.type==='interactLoc'&&x.tick>=3&&x.tick<=effect.tick)).toHaveLength(0);
  // The speculative path ran while HP was 36 (not low), then stopped once published HP fell to 33.
  expect(f.sent.filter(x=>x.locId===2297).every(x=>x.tick<3)).toBe(true);
  expect(f.sent.some(x=>x.locId===2297&&x.tick<3)).toBe(true);
 }finally{c.restore();f.stop();}
});

test('a speculative log packet retains the original observed stones dispatch and every settlement tick',async()=>{
 const f=stonesFixture({onStones:true}),c=captureFood();
 try{await runAgility(f.s,agilityOptions('wilderness','53',{}));
  const actions=c.lines.filter(l=>l.startsWith('AGILITY_ACTION ')).map(l=>JSON.parse(l.slice(15)));
  const stones=actions.find(a=>a.event==='dispatch'&&a.step==='stones'),log=actions.filter(a=>a.event==='dispatch'&&a.step==='log');
  const settle=c.events().find(e=>e.event==='settle');
  expect(log).toHaveLength(1);expect(log[0].speculative).toBe(true);expect(log[0].actionId).toBe(stones.actionId);
  expect(settle).toMatchObject({step:'stones',actionId:stones.actionId,dispatchTick:stones.tick,dispatchAt:stones.at,opsSinceDispatch:1});
  expect(settle.marks.map((m:any)=>m.tick)).toEqual(Array.from({length:settle.tick-settle.start+1},(_,i)=>settle.start+i));
  expect(settle.marks.slice(-7).every((m:any)=>m.anim===-1&&m.at===settle.marks.at(-1).at)).toBe(true);
  expect(f.dropped()).toBe(0);
 }finally{c.restore();f.stop();}
});
test('cancellation during settlement stops without an eat or another click',async()=>{
 const f=stonesFixture({forever:true,endAfter:10});
 try{await expect(runAgility(f.s,agilityOptions('wilderness','53',{}))).rejects.toThrow('session interrupted');
  expect(f.sent.filter(x=>x.type==='useInventoryItem')).toHaveLength(0);expect(f.sent.filter(x=>x.tick>=3)).toHaveLength(0);
  expect(f.inventory).toHaveLength(14);
 }finally{f.stop();}
});
test('an action with no published state yet is not settled by one quiet tick',async()=>{
 const f=stonesFixture(),c=captureFood();
 try{await runAgility(f.s,agilityOptions('wilderness','53',{}));
  const settle=c.events().find(e=>e.event==='settle');
  expect(settle.quiet).toBe(6);expect(settle.tick-settle.dispatchTick).toBeGreaterThan(14);
 }finally{c.restore();f.stop();}
});
