import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import { DAEMONS, importClosure, reloadsFor } from '../fleet/src/live-update';

const root=resolve(import.meta.dir,'../..');

test('dashboard source changes reload its collector or publisher without a fleet rollout',()=>{
 const closures=Object.fromEntries(Object.entries(DAEMONS).map(([name,entries])=>[name,importClosure(entries,root)]));
 expect(reloadsFor(['packages/dashboard/goals.ts'],closures)).toEqual(['dashboard']);
 expect(reloadsFor(['packages/dashboard/publish.ts'],closures)).toEqual(['dashboard-publish']);
 // The local command handler imports relay account identity too.
 expect(reloadsFor(['packages/dashboard/publish-relay.ts'],closures)).toEqual(['dashboard','dashboard-publish']);
 expect(reloadsFor(['packages/dashboard/client-shell.js'],closures)).toEqual([]);
});

test('the collector releases its listener before starting the replacement from its source checkout',async()=>{
 const source=readFileSync(join(root,'packages/dashboard/server.ts'),'utf8');
 const code=source.slice(source.indexOf('const reloadTimer = setInterval('),source.indexOf('// The listening host'));
 let tick!:()=>Promise<void>,due=false;
 const calls:string[]=[];
 new Function('setInterval','clearInterval','reloadDue','sourceRoot','startedAt','dashboardServer','clients','respawnDaemon','join','process','console',code)(
  (fn:()=>Promise<void>)=>{tick=fn;return 7;},(id:number)=>calls.push('clear '+id),
  (dir:string,name:string,at:number)=>{expect([dir,name,at]).toEqual(['source','dashboard',10]);return due;},
  'source',10,{stop:async(force?:boolean)=>{expect(force).not.toBe(true);calls.push('stop');}},new Set([{close:()=>calls.push('close stream')}]),
  (dir:string,args:string[],log:string)=>{expect(dir).toBe('source');expect(args).toEqual([join('source','packages/dashboard/server.ts'),'--arg']);expect(log).toBe(join('source','.practice/dashboard.out.log'));calls.push('spawn');return 100;},join,
  {argv:['bun','server.ts','--arg'],exit:(code:number)=>calls.push('exit '+code)},{log:()=>{}},
 );
 await tick();expect(calls).toEqual([]);
 due=true;await tick();expect(calls).toEqual(['clear 7','stop','close stream','spawn','exit 0']);
});

test('the publisher releases its lock before restarting and keeps finite runs finite',()=>{
 const source=readFileSync(join(root,'packages/dashboard/publish.ts'),'utf8');
 const code=source.slice(source.indexOf('  if(!once&&reloadDue('),source.indexOf('  try{await cycle();}'));
 const run=(once:boolean,due:boolean)=>{
  const calls:string[]=[];
  new Function('once','reloadDue','root','startedAt','release','respawnDaemon','join','prac','process','console',code)(
   once,()=>due,'source',10,()=>calls.push('release'),
   (_dir:string,args:string[])=>{expect(args).toEqual([join('source','packages/dashboard/publish.ts')]);calls.push('spawn');return 100;},join,join('source','.practice'),
   {argv:['bun','publish.ts'],exit:(code:number)=>calls.push('exit '+code)},{log:()=>{}},
  );
  return calls;
 };
 expect(run(false,false)).toEqual([]);expect(run(true,true)).toEqual([]);
 expect(run(false,true)).toEqual(['release','spawn','exit 0']);
});
