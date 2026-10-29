import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cachedPath,worldGateIndex,type WorldGate} from '../src/travel-cache';
import {leg,type TravelModel} from '../src/travel';
import {allocateTransport} from '../src/transport-requirements';

const gate=(requires:string[][],loc='gate',x=1,z=0,source='content.rs2:1'):WorldGate=>({loc,tile:{level:0,x,z},requires,source});

test('two operations on one placed gate preserve both alternatives and sources',()=>{
 const index=worldGateIndex([gate([['item:key:held']]),gate([['quest:gate>=2']],'gate',1,0,'content.rs2:7')]);
 expect(index.get('0,1,0')).toMatchObject({requires:[['item:key:held'],['quest:gate>=2']],source:'content.rs2:1; content.rs2:7'});
});

test('membership and skill prerequisites are retained rather than assumed from missing actor state',()=>{
 const index=worldGateIndex([gate([['members']]),gate([['skill:mining:1']],'other',2)]);
 expect(index.get('0,1,0')?.requires).toEqual([['members']]);
 expect(index.get('0,2,0')?.requires).toEqual([['skill:mining:1']]);
});

test('unknown or ambiguous gate states cannot become free paths',()=>{
 const index=worldGateIndex([gate([]),gate([['coins:1']],'first',2),gate([['item:key:held']],'second',2)]);
 expect(index.get('0,1,0')?.requires[0]?.[0]).toContain('unparsed');
 expect(index.get('0,2,0')?.requires[0]?.[0]).toContain('ambiguous');
});

test('partial, wrong-floor and non-integer paths produce no cached route',()=>{
 const a={x:0,z:0},b={x:10,z:0},index=worldGateIndex([]);
 expect(cachedPath(a,b,[{x:7,z:0}],index)).toBeNull();
 expect(cachedPath(a,b,[{x:10,z:0,level:1}],index)).toBeNull();
 expect(cachedPath(a,b,[{x:10.5,z:0}],index)).toBeNull();
 expect(cachedPath(a,{...b,level:1},[{x:10,z:0}],index)).toBeNull();
 expect(cachedPath(a,b,[],index)).toBeNull();
});

test('the two pinned Al-Kharid toll leaves represent one fee per crossing',()=>{
 const world=JSON.parse(readFileSync(join(import.meta.dir,'../../../knowledge/ubermouse/world.json'),'utf8')) as {gates:WorldGate[]};
 const index=worldGateIndex(world.gates);
 const path=cachedPath({x:3268,z:3226},{x:3268,z:3229},[{x:3268,z:3229}],index);
 expect(path?.gates).toHaveLength(1);
 expect(path?.gates?.[0]?.requires).toEqual([['coins:10'],['quest:prince>=100']]);
 expect(path?.toll).toBe(10);
});

test('ordered caches retain reverse-specific cost and gate metadata',()=>{
 const m:TravelModel={places:{a:{x:0,z:0},b:{x:10,z:0}},cache:{directed:true,nearestBank:{},banks:{},legs:{
  'a>b':{runTicks:5,tiles:10,gates:[{id:'enter',source:'pinned.rs2:1',requires:[['consume:rope:1']]}]},
  'b>a':{runTicks:8,tiles:16},
 }}};
 expect(leg(m,'a','b')).toMatchObject({ticks:7,gates:[{id:'enter'}]});
 expect(leg(m,'b','a')).toEqual({ticks:10,method:'path'});
});

test('pinned monastery requires observed membership, not mere joining skill',()=>{
 const world=JSON.parse(readFileSync(join(import.meta.dir,'../../../knowledge/ubermouse/world.json'),'utf8')) as {gates:WorldGate[]};
 const requires=worldGateIndex(world.gates).get('0,3046,3483')!.requires.flat();
 expect(requires).toEqual(['unlock:prayer-guild']);
 expect(requires.some(t=>t.startsWith('base-skill:')||t.startsWith('other:'))).toBe(false);
});

test('mined compound entry guards replace summaries and do not charge the permitted exit',()=>{
 const index=worldGateIndex([{loc:'crafting_guild_door',tile:{x:10,z:10,level:0},source:'old summary',requires:[['skill:crafting:40']]}],[{loc:'crafting_guild_door',x:10,z:10,level:0,angle:0,shape:0,kind:'skill',trigger:'crafting_guild.rs2:1',need:{skill:'crafting',level:40,worn:'brown_apron',whenAxis:true}}]);
 const enter=cachedPath({x:11,z:10},{x:8,z:10},[{x:8,z:10}],index),exit=cachedPath({x:8,z:10},{x:11,z:10},[{x:11,z:10}],index);
 expect(enter?.gates?.[0]?.requires).toEqual([['skill:crafting:40','item:brown_apron:worn']]);
 expect(exit?.gates).toBeUndefined();
});
test('mined Heroes and Legends thresholds replace lossy quest aliases',()=>{
 const index=worldGateIndex([{loc:'herodoor_l',tile:{x:10,z:10,level:0},requires:[['quest:hero']]}],[{loc:'herodoor_l',x:10,z:10,level:0,kind:'quest',trigger:'heroes_entrance.rs2:5',need:{varp:'heroquest',minimum:15}}]);
 expect(index.get('0,10,10')?.requires).toEqual([['quest:heroquest:15']]);
});
test('Castle Wars entry needs own observed team OR current open-door witness, while exit stays free',()=>{
 const index=worldGateIndex([],[{loc:'castlewars_saradomin_maindoorr',x:10,z:10,level:0,kind:'team',angle:3,shape:0,trigger:'castlewars_maindoor.rs2:22',need:{team:0,whenAxis:true}}]);
 const enter=cachedPath({x:10,z:11},{x:10,z:8},[{x:10,z:8}],index),exit=cachedPath({x:10,z:8},{x:10,z:11},[{x:10,z:11}],index),gates=enter!.gates!;
 expect(gates[0]!.requires).toEqual([['cw:team:0'],['door-open:0:10:10']]);expect(exit?.gates).toBeUndefined();
 for(const [own,open,expected] of [[true,false,true],[false,true,true],[false,false,false],[null,null,null]] as const)expect(allocateTransport(gates,0,{held:{},facts:{'cw:team:0':own,'door-open:0:10:10':open}}).state).toBe(expected);
});
