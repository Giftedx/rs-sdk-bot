import {test,expect} from 'bun:test';
import {combatKitTotals,BLUE_KIT,KBD_KIT,combatAssetIssues,combatTrip,validateCombatKit,leaveKbdEntrancePit,combatTeleportAllowed} from './microbot-combat-trip';
test('every staged kit item exists in native pack and wield handlers have no quest gate',()=>{
 expect(validateCombatKit(BLUE_KIT)).toEqual([{skill:'Ranged',level:1}]);
 expect(validateCombatKit(KBD_KIT)).toEqual([{skill:'Attack',level:40},{skill:'Defence',level:40},{skill:'Defence',level:40}]);
 expect(()=>validateCombatKit([{id:4151,count:1,slot:3}])).toThrow('invalid native');
 expect(()=>validateCombatKit([{id:1127,native:'rune_platebody',count:1,slot:4}])).toThrow('unsupported');
 expect(()=>validateCombatKit([{id:838,native:'crossbow',count:1,slot:3}])).toThrow('invalid native');
});
test('finite combat kits reserve escape and refill from owned bank stock',()=>{
 const blue=combatKitTotals(BLUE_KIT),kbd=combatKitTotals(KBD_KIT);
 expect(blue[877]).toBe(500);expect(blue[1590]).toBe(1);expect(blue[385]).toBe(6);expect(kbd[385]).toBe(12);
 for(const kit of [blue,kbd]){expect(kit[563]).toBe(1);expect(kit[556]).toBe(3);expect(kit[554]).toBe(1);expect(kit[1540]).toBe(1);}
});
test('conservation rejects gear loss, missing dose containers and excess rune costs',()=>{
 const b={4151:1,2448:2,563:3,556:9,554:3},a={4151:1,2448:1,181:1,563:2,556:6,554:2},d={2448:-1,181:1,563:-1,556:-3,554:-1};
 expect(combatAssetIssues(b,a,d)).toEqual([]);
 expect(combatAssetIssues(b,{...a,4151:0},d).map(i=>i.id)).toContain(4151);
 expect(combatAssetIssues(b,{...a,181:0},d).map(i=>i.id)).toContain(181);
 expect(combatAssetIssues(b,{...a,563:1},d).map(i=>i.id)).toContain(563);
});
test('trip rejects unbounded limits before session access',async()=>{await expect(combatTrip({} as any,'kbd',async()=>({ok:true,failure:''}),{cap:Infinity,stop:()=>false})).rejects.toThrow('invalid');});

test('native high Wilderness pit exits by observed lever even after job stop',async()=>{
 let p={worldX:3067,worldZ:10253,level:0};const acts:number[]=[];
 expect(combatTeleportAllowed(p)).toBe(false);
 await leaveKbdEntrancePit({position:()=>p,locs:()=>[{id:1816,x:3067,z:10253,optionsWithIndex:[{text:'Pull',opIndex:1}]}],interact:async(_x,_z,id)=>{acts.push(id);p={worldX:2717,worldZ:9802,level:0};return true;},wait:async(test,ticks)=>{expect(ticks).toBe(20);return test();}});
 expect(acts).toEqual([1816]);expect(combatTeleportAllowed(p)).toBe(true);
});
test('unavailable pit lever falls back to observed climb-out, not blocked teleport',async()=>{
 let p={worldX:3069,worldZ:10255,level:0};const acts:number[]=[];
 await leaveKbdEntrancePit({position:()=>p,locs:()=>[{id:1766,x:3069,z:10256,optionsWithIndex:[{text:'Climb-up',opIndex:1}]}],interact:async(_x,_z,id)=>{acts.push(id);p={worldX:3017,worldZ:3849,level:0};return true;},wait:async test=>test()});
 expect(acts).toEqual([1766]);expect(combatTeleportAllowed(p)).toBe(false);
 expect(combatTeleportAllowed({worldX:3094,worldZ:3535,level:0})).toBe(true);
});


test('bank staging changes retaliation only after close and keeps fresh bank observations',async()=>{
 let stopped=false,withdrawals=0,dismissWhileBanked=0,gen=1;const clicks:number[]=[];
 const items=Object.entries(combatKitTotals(BLUE_KIT)).map(([id,count])=>({id:Number(id),count}));
 const current:any={player:{worldX:3185,worldZ:3436,level:0,lifeId:1,isDead:false},autoRetaliateEnabled:true,bank:{isOpen:true,items},prayers:{prayerLevel:99,prayerPoints:99,activePrayers:[]},nearbyLocs:[{id:2213,x:3186,z:3438,name:'Bank booth',distance:1,optionsWithIndex:[{text:'Bank',opIndex:1}]}]};
 let observation:any={generation:gen,items};
 const session:any={client:{},tick:()=>0,ended:new Promise(()=>{}),bankObservation:()=>observation,sdk:{getState:()=>current,getInventory:()=>[],getEquipment:()=>[],getSkill:()=>({level:99}),sendInteractLoc:async()=>{current.bank.isOpen=true;observation={generation:++gen,items};return{success:true};}},bot:{dismissBlockingUI:async()=>{if(current.bank.isOpen){dismissWhileBanked++;observation=null;}return{success:true};},closeBank:async()=>{current.bank.isOpen=false;observation=null;return{success:true};},withdrawItem:async()=>{withdrawals++;return{success:true};}},direct:async(action:any)=>{if(current.bank.isOpen)throw Error('combat component closes a valid bank observation');clicks.push(action.componentId);current.autoRetaliateEnabled=action.componentId===150;if(action.componentId===151)stopped=true;return{success:true};}};
 const result=await combatTrip(session,'blue',async()=>{throw Error('stopped actor must not fight');},{cap:100,stop:()=>stopped});
 expect(result.ok).toBe(false);expect(result.banked).toBe(true);expect(result.assets).toEqual([]);
 expect(withdrawals).toBe(0);expect(dismissWhileBanked).toBe(0);expect(clicks).toEqual([151,150]);expect(current.autoRetaliateEnabled).toBe(true);
});

test('extracted Blue entry preserves exact waypoints, key transition predicate and settle boundary',async()=>{const{blueDungeonEntry}=await import('./microbot-combat-trip');let p={worldX:0,worldZ:0,level:0};const trace:any[]=[];await blueDungeonEntry({position:()=>p,walk:async(x,z)=>{trace.push([x,z]);p={...p,worldX:x,worldZ:z};},interact:async(id,x,z,arrived,key)=>{trace.push({id,x,z,key});expect(arrived()).toBe(false);p={...p,worldX:id===1759?2884:2923,worldZ:id===1759?9797:9803};expect(arrived()).toBe(true);},settle:async()=>{trace.push('settle3');}});expect(trace).toEqual([[2884,3397],{id:1759,x:2884,z:3397,key:undefined},[2886,9817],[2889,9831],[2910,9830],[2924,9803],{id:2623,x:2924,z:9803,key:1590},'settle3',[2904,9803],[2895,9792]]);});
