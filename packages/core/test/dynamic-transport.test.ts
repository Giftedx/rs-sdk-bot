import {test,expect} from 'bun:test';
import {createWorld,transportAllowed,type Transport} from '../src/world';
import {accountForSdk,registerRouteActor} from '../src/door-policy';
const at={x:2561,z:3222,level:0},to={x:2561,z:9621,level:0},loc={id:1765,...at};
const t:any={locName:'wildymirrorladdertop1',from:at,to,option:'op1',exact:true,src:'case:1',toSrc:'case:2',handler:'op:1',requires:{visibleLoc:loc}};
test('dynamic transport requires current own-client exact loc and invalidates held actor snapshots',()=>{
 const state:any={inGame:true,player:{worldX:2562,worldZ:3222,level:0},skills:[],inventory:[],equipment:[],nearbyLocs:[loc]},sdk={getState:()=>state},client={ingame:true};registerRouteActor(sdk,client);const actor=accountForSdk(sdk);
 expect(transportAllowed(t,actor)).toBe(true);state.nearbyLocs=[];expect(transportAllowed(t,actor)).toBe(false);
 const foreign={getState:()=>({...state,nearbyLocs:[loc]})};expect(transportAllowed(t,accountForSdk(foreign))).toBe(false);
 state.nearbyLocs=[loc];(client as any).isInGame=()=>false;expect(transportAllowed(t,actor)).toBe(false);delete (client as any).isInGame;client.ingame=false;expect(transportAllowed(t,actor)).toBe(false);client.ingame=true;
 for(const patch of [{id:999},{x:2562},{z:3223},{level:1}]){state.nearbyLocs=[{...loc,...patch}];expect(transportAllowed(t,actor)).toBe(false);}
 state.nearbyLocs=[loc];state.player.level=1;expect(transportAllowed(t,actor)).toBe(false);
});
test('world does not turn an absent dynamic ladder into a teleport',()=>{
 const state:any={player:{worldX:2562,worldZ:3222,level:0},skills:[],inventory:[],nearbyLocs:[]},sdk={getState:()=>state};registerRouteActor(sdk,{ingame:true});const w=createWorld({transports:[t],doors:[],goalTolerance:0,pathLength:(a,b)=>a.level===b.level&&Math.abs(a.z-b.z)<3200?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):null});
 expect(w.route(at,to,accountForSdk(sdk))).toEqual({ok:false,reason:'no_route'});state.nearbyLocs=[loc];expect(w.route(at,to,accountForSdk(sdk)).ok).toBe(true);
});
test('alias-only transport set resolves to exact canonical physical identity, rejects mismatched destination/id',()=>{
 const from={x:2897,z:3566,level:0},to={x:2897,z:3569,level:1};const canonical={id:4626,locName:'board_game_stairs_grey_base',option:'op1',from,to,exact:true,src:'map:1',toSrc:'canonical:2',handler:'canonical:1',interaction:{id:4626,shape:10,angle:0,width:2,height:3,blockAccessFlags:11,src:'map:1',configSrc:'loc:1'}};
 const legacy:any={locName:'stairs',option:'op1',from,to,exact:true,src:'legacy:1',toSrc:'legacy:2',handler:'legacy:1',unplaced:true,canonical};
 const make=(t:Transport)=>createWorld({transports:[t],doors:[],goalTolerance:0,pathLength:(a,b)=>a.level===b.level?0:null}).route(from,to,{skills:{},varps:{},items:[]});
 const r=make(legacy);expect(r.ok).toBe(true);if(r.ok)expect(r.legs).toMatchObject([{kind:'transport',loc:canonical.locName,interaction:{id:4626}}]);
 expect(make({...legacy,canonical:{...canonical,to:{...to,x:2898}}}).ok).toBe(false);
 expect(make({...legacy,canonical:{...canonical,interaction:{...canonical.interaction,id:999}}}).ok).toBe(false);
});

test('legacy literal leg dispatches canonical placed ID and rejects an unrelated destination',async()=>{
 const {canonicalTransportLeg}=await import('../src/world');
 const from={x:2897,z:3566,level:0},to={x:2897,z:3569,level:1};
 const old:any={kind:'transport',loc:'stairs',option:'op1',at:from,to,exact:true};
 expect(canonicalTransportLeg(old)).toMatchObject({loc:'board_game_stairs_grey_base',interaction:{id:4626},at:from,to});
 expect(canonicalTransportLeg({...old,to:{...to,z:3570}})).toBeNull();
});

test('canonical legacy leg preserves caller restrictions and fails closed on incompatible guards',async()=>{
 const {canonicalTransportLeg}=await import('../src/world'),{walkRoute}=await import('../src/walk'),{fakeGame}=await import('./fakegame');
 const old:any={kind:'transport',loc:'stairs',option:'op1',at:{x:2897,z:3566,level:0},to:{x:2897,z:3569,level:1},exact:true,requires:{unlock:'caller-hold'}};
 expect(canonicalTransportLeg(old)?.requires).toEqual(old.requires);
 const rows=await Bun.file(new URL('../../../knowledge/transports.json',import.meta.url)).json(),row=rows.find((r:any)=>r.locName==='stairs'&&r.from.x===2897&&r.from.z===3566);
 expect(canonicalTransportLeg(old,[{...row,canonical:{...row.canonical,requires:{skill:{name:'mining',level:60}}}}])).toBeNull();
 const g=fakeGame({x:2897,z:3565,level:0,nearbyLocs:[{id:4626,x:2897,z:3566,level:0}]});let sent=0;(g.sdk as any).sendInteractLoc=async()=>{sent++;return{success:true};};
 try{expect(await walkRoute(g as any,[old],{maxRetriesPerLeg:1,legTimeoutTicks:3})).toMatchObject({ok:false,reason:'precondition'});expect(sent).toBe(0);}finally{g.stop();}
});
