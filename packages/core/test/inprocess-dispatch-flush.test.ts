import {test,expect} from 'bun:test';
import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';
import {createShim} from '../src/inprocess';

function fixture(){
 const client={
  out:[10],sent:[] as number[][],
  collectBotState:(tick:number)=>({tick,inGame:true,player:{worldX:1,worldZ:1,level:0},skills:[],inventory:[],gameMessages:[]}),
  executeBotAction:(_action:unknown):unknown=>{client.out.push(20);return{success:true,phase:'dispatch'};},
  setOnGameTickCallback:(_cb:(()=>void)|null)=>{},
  flush(){this.sent.push([...this.out]);this.out.length=0;},
 };
 const sdk=new BotSDK({botUsername:'flushfixture',password:'fixture',autoLaunchBrowser:false,autoReconnect:false} as any);
 return{client,sdk};
}

test('a direct dispatch transmits ordered bytes before its promise continuation or session pump',async()=>{
 const {client,sdk}=fixture(),shim=createShim(client,sdk);shim.start();
 try{
  const result=shim.direct({type:'closeModal'});
  expect(client.sent).toEqual([[10,20]]);
  expect(client.out).toEqual([]);
  expect(await result).toMatchObject({success:true,phase:'dispatch'});
  expect(shim.tick()).toBe(0);
 }finally{shim.stop('fixture-ended');}
});

test('queued SDK dispatch transmits before its action result is observed',async()=>{
 const {client,sdk}=fixture(),shim=createShim(client,sdk);shim.start();
 try{
  const result=sdk.sendClickComponent(3420);
  expect(client.sent).toEqual([[10,20]]);
  expect(await result).toMatchObject({success:true,phase:'dispatch'});
 }finally{shim.stop('fixture-ended');}
});

test('an asynchronous dispatch flushes bytes after it finishes writing',async()=>{
 const {client,sdk}=fixture();let complete!:(v:unknown)=>void;
 client.executeBotAction=()=>new Promise(resolve=>{complete=resolve;});
 const shim=createShim(client,sdk);shim.start();
 try{
  const result=shim.direct({type:'closeModal'});
  expect(client.sent).toEqual([]);
  client.out.push(30);complete({success:true,phase:'dispatch'});
  await result;expect(client.sent).toEqual([[10,30]]);
 }finally{shim.stop('fixture-ended');}
});

test('queries, refused actions and stopped sessions do not flush',async()=>{
 const {client,sdk}=fixture();client.executeBotAction=()=>({success:true,data:[]});
 const shim=createShim(client,sdk,action=>(action as any).type==='refused'?'unowned partner':null);shim.start();
 await shim.direct({type:'scanGroundItems'});
 expect(await shim.direct({type:'refused'})).toMatchObject({success:false});
 shim.stop('fixture-ended');await shim.direct({type:'closeModal'});
 expect(client.sent).toEqual([]);
});

test('a failed transport flush cannot report successful direct dispatch',async()=>{
 const {client,sdk}=fixture();client.flush=()=>{throw Error('socket closed');};
 const shim=createShim(client,sdk);shim.start();
 try{await expect(shim.direct({type:'closeModal'})).rejects.toThrow('socket closed');}
 finally{shim.stop('fixture-ended');}
});
