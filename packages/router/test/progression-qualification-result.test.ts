import {expect,test} from 'bun:test';
import {completeProgressionQualification} from '../src/progression-qualification-native';
import type {DeliveryTask,DeliveryResult} from '../src/delivery';
const task:DeliveryTask={id:'ranged-train',goal:'Finite Ranged',entry:'scripts/ranged-train.ts',files:['scripts/ranged-train.ts'],consumer:'Ranged85',checks:[]};
const delivery:DeliveryResult={ok:true,stage:'delivered',evidence:'native',consumer:task.consumer,reason:'native consumer verified',source:'a'.repeat(64),checks:[]};
test('accepted native qualification keeps its full evidence when optional registration must retry',async()=>{
 const before=JSON.stringify(delivery),result=await completeProgressionQualification(task,delivery,'/root',async()=>{throw Error('index temporarily held');});
 expect(result).toMatchObject({ok:true,evidence:'native',delivery,progressionRegistration:{ok:false,retry:true}});expect(JSON.stringify(delivery)).toBe(before);
});
test('native failure never attempts proof publication',async()=>{
 let calls=0;const failed={...delivery,ok:false,stage:'failed' as const};
 const result=await completeProgressionQualification(task,failed,'/root',async()=>{calls++;return{registered:0,index:''};});expect(result.ok).toBe(false);expect(result.delivery).toBe(failed);expect(calls).toBe(0);
});
test('successful publication metadata stays separate from native acceptance',async()=>{
 const result=await completeProgressionQualification(task,delivery,'/root',async()=>({registered:1,index:'/index',proof:{path:'/proof',sha256:'b'.repeat(64)}}));
 expect(result).toMatchObject({ok:true,delivery,progressionRegistration:{ok:true,registered:1,index:'/index'}});
});
