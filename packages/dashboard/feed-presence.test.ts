import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {RosterFeed} from '../core/src/roster-feed';
const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');

test('a full world roster removes departed players without waiting for the stale-data timeout',()=>{
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(server.indexOf('const roster ='),server.indexOf('const serverTick =')));
 let socket:any;class Socket{onmessage:any;constructor(){socket=this;}send(){}close(){}}
 const state=new Function('WebSocket','setTimeout','RosterFeed',`${code};return {roster,firstSeen,world};`)(Socket,()=>{},RosterFeed);
 const send=(p:any)=>socket.onmessage({data:JSON.stringify({t:'roster',k:10,p})});
 send([[1,'Worker',3200,3200,0,10],[2,'Other',3201,3200,0,10]]);
 // A change frame: slot 1 leaves, slot 3 joins, slot 2 moves.
 socket.onmessage({data:JSON.stringify({t:'roster',k:20,d:1,lv:[1],j:[[3,'Third',3100,3100,0,5]],m:[[2,3300,3301,1]]})});
 expect([...state.roster.keys()].sort()).toEqual(['other','third']);expect(state.roster.get('other')).toMatchObject({x:3300,z:3301,level:1,combat:10});
 expect(state.world.players).toBe(2);expect(state.world.tick).toBe(20);
 send([[1,'Worker',3200,3200,0,10],[2,'Other',3201,3200,0,10]]);
 expect(state.roster.size).toBe(2);
 send([[2,'Other',3201,3200,0,10]]);
 expect(state.roster.has('worker')).toBe(false);expect(state.firstSeen.has('worker')).toBe(true);
 expect(state.world.players).toBe(1);
 send([null]);expect(state.roster.has('other')).toBe(true);expect(state.world.players).toBe(1);
 send([]);expect(state.roster.size).toBe(0);expect(state.world.players).toBe(0);
});
