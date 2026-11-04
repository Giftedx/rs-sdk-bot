import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');

test('a full world roster removes departed players without waiting for the stale-data timeout',()=>{
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(server.indexOf('const roster ='),server.indexOf('const serverTick =')));
 let socket:any;class Socket{onmessage:any;constructor(){socket=this;}send(){}close(){}}
 const state=new Function('WebSocket','setTimeout',`${code};return {roster,firstSeen,world};`)(Socket,()=>{});
 const send=(p:any)=>socket.onmessage({data:JSON.stringify({t:'roster',k:10,p})});
 send([[1,'Worker',3200,3200,0,10],[2,'Other',3201,3200,0,10]]);
 expect(state.roster.size).toBe(2);
 send([[2,'Other',3201,3200,0,10]]);
 expect(state.roster.has('worker')).toBe(false);expect(state.firstSeen.has('worker')).toBe(true);
 expect(state.world.players).toBe(1);
 send([null]);expect(state.roster.has('other')).toBe(true);expect(state.world.players).toBe(1);
 send([]);expect(state.roster.size).toBe(0);expect(state.world.players).toBe(0);
});
