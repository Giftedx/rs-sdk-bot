import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {noteCourierOwned,noteCourierPreflight} from './note-courier';

test('a fresh courier can authenticate after a same-server owned banker passes preflight',()=>{
 const server='127.0.0.1:21000',owned=new Set(['banker']),seen:string[]=[];
 const lookup=(endpoint:string)=>{seen.push(endpoint);return owned;};
 const config=noteCourierPreflight(['FreshCourier','Banker','300'],{MAX_DELIVERIES:'1'}, {serverOf:()=>server,owned:lookup});
 expect(config).toMatchObject({courierName:'FreshCourier',bankerName:'Banker',cap:300,maxDeliveries:1,server});
 expect(seen).toEqual([server]);
 expect(()=>noteCourierOwned(config.courierName,config.bankerName,server,server,lookup)).toThrow('authenticated owned');
 owned.add('freshcourier');
 expect(noteCourierOwned(config.courierName,config.bankerName,server,server,lookup)).toBe(owned);
 expect(()=>noteCourierOwned(config.courierName,config.bankerName,server,'127.0.0.1:21010',lookup)).toThrow('endpoint mismatch');
});

test('invalid targets and a foreign or unverified banker fail before courier authentication',()=>{
 const deps={serverOf:()=> '127.0.0.1:21000',owned:()=>new Set(['banker'])};
 for(const cap of ['0','-1','NaN','Infinity','1.5'])expect(()=>noteCourierPreflight(['Courier','Banker',cap],{},deps)).toThrow('positive safe integers');
 for(const max of ['0','-1','NaN','Infinity','1.5'])expect(()=>noteCourierPreflight(['Courier','Banker'],{MAX_DELIVERIES:max},deps)).toThrow('positive safe integers');
 expect(()=>noteCourierPreflight(['Courier','Courier'],{},deps)).toThrow('distinct valid');
 expect(()=>noteCourierPreflight(['../Courier','Banker'],{},deps)).toThrow('distinct valid');
 expect(()=>noteCourierPreflight(['Courier','Banker'],{}, {...deps,owned:()=>new Set()})).toThrow('banker must be an authenticated');
 expect(()=>noteCourierPreflight(['Courier','Banker'],{}, {...deps,serverOf:name=>name==='Banker'?'127.0.0.1:21010':'127.0.0.1:21000'})).toThrow('same server');
});

test('actual main authenticates a fresh courier, refreshes ownership and ends after its finite delivery',()=>{
 const code=`
 import {mock} from 'bun:test';import {resolve} from 'node:path';
 const server='127.0.0.1:21000',owned=new Set(['banker']),events=[];let inventory=[{id:1780,name:'Flax',count:28}],finished;
 const session={name:'FreshCourier',lifecycle:{server},tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
  sdk:{getState:()=>({player:{worldX:2654,worldZ:3283,level:0,lifeId:1,respawnCount:0}}),getInventory:()=>inventory,
   findNearbyPlayer:()=>({name:'Banker'})},bot:{trade:async()=>{events.push('trade');const gave=inventory;inventory=[];return{success:true,gave,received:[]};}}};
 mock.module(resolve('packages/core/src/bot.ts'),()=>({openBot:async()=>{events.push('login');owned.add('freshcourier');return session;},
  finish:async(_sessions,ok,detail)=>{events.push('finish');finished={ok,detail};},countItems:()=>0}));
 mock.module(resolve('packages/core/src/tradeguard.ts'),()=>({ownedAccounts:endpoint=>{if(endpoint!==server)throw Error('foreign lookup');events.push('owned:'+owned.has('freshcourier'));return new Set(owned);}}));
 mock.module(resolve('packages/core/src/cargo.ts'),()=>({cargoDir:'.practice/not-read-after-finite-delivery',cargoAccountServer:()=>server,
  exactItem:name=>new RegExp('^'+name+'$','i')}));
 mock.module(resolve('packages/core/src/ticks.ts'),()=>({waitTicks:async()=>{},waitUntil:async(_s,p)=>p()}));
 mock.module(resolve('packages/core/src/walk.ts'),()=>({walkPath:async()=>{throw Error('unexpected walking');},sessionWalker:async()=>{throw Error('unexpected walking');}}));
 process.env.MAX_DELIVERIES='1';console.log=()=>{};
 const {noteCourierMain}=await import('./scripts/note-courier');await noteCourierMain(['FreshCourier','Banker','300']);
 process.stdout.write(JSON.stringify({events,finished,inventory}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:10000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());
 const result=JSON.parse(child.stdout.toString());
 expect(result.events[0]).toBe('owned:false');
 expect(result.events.indexOf('login')).toBeLessThan(result.events.indexOf('owned:true'));
 expect(result.events.filter((event:string)=>event==='trade')).toHaveLength(1);
 expect(result.finished).toMatchObject({ok:true});expect(result.finished.detail).toContain('deliveries=1');expect(result.inventory).toEqual([]);
});
