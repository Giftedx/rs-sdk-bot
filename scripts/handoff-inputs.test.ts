import { expect, test } from 'bun:test';
import { handoffCommands, parseHandoff, runHandoff, assertHandoffOwnership, assertAccountOwnership, acquireAccountLeases, assertRecoverableStatus, type HandoffChild, type HandoffDeps } from './handoff-inputs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

test('shared account lease API excludes overlapping orders and unwinds partial acquisition',()=>{
 const base=mkdtempSync(join(tmpdir(),'account-leases-'));
 try{
  const release=acquireAccountLeases(['Receiver'],'first',base);
  expect(()=>acquireAccountLeases(['Donor','receiver'],'second',base)).toThrow('lease conflict');
  expect(existsSync(join(base,'donor.lock'))).toBe(false);
  release();release();
  acquireAccountLeases(['RECEIVER'],'next',base)();
  expect(()=>assertAccountOwnership(['Receiver'],{version:1,tasks:[]},[],()=>false,'mine')).not.toThrow();
 }finally{rmSync(base,{recursive:true,force:true});}
});

// These subprocesses enter main(), using disk-backed fake sessions only. No
// game server, credentials, production state or real openBot is used.
const entryFixture=String.raw`
import {main} from ENTRY;
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.FIXTURE_ROOT,stage=process.env.FIXTURE_STAGE;
process.argv=['bun','handoff-inputs.ts','Donor','Receiver','90:Iron arrowtips','--bank-x=3253','--bank-z=3421'];
const file=join(root,'holdings.json');
const load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=x=>writeFileSync(file,JSON.stringify(x));
const hold=async point=>{if(stage===point){console.log('HOLD '+point);await new Promise(()=>{});}};
// Keep a blocked login alive until the parent kills it, with a hard deadline.
const deadline=setTimeout(()=>process.exit(9),8000);
await main({root,ownedAccounts:()=>new Set(['donor','receiver']),
 openBot:async name=>{
  console.log('LOGIN '+name);
  const status=join(root,'.practice/status',name+'.json');
  writeFileSync(status,JSON.stringify({name,goal:process.env.BOT_GOAL,at:Date.now()}));
  await hold('login');
  let opened=false,generation=0;
  const role=name==='Donor'?'donor':'receiver';
  const items=n=>n?[{id:40,name:'Iron arrowtips',count:n,slot:0}]:[];
  const s={name,tick:()=>0,onTick:()=>()=>{},
   bankObservation:()=>opened?{generation,at:Date.now(),items:items(load()[role].bank)}:null,
   sdk:{getInventory:()=>items(load()[role].pack),getState:()=>({player:{worldX:3253,worldZ:3421,level:0},bank:{isOpen:opened},inventory:items(load()[role].pack)})},
   bot:{walkTo:async()=>{await hold('bank-entry');return {success:true};},
    openBank:async()=>{opened=true;generation++;return {success:true};},closeBank:async()=>{opened=false;return {success:true};},
    withdrawItem:async(_,count)=>{const x=load();x[role].bank-=count;x[role].pack+=count;save(x);generation++;return {success:true};},
    serveTrades:async()=>{const x=load();x.donor.pack-=90;x.receiver.pack+=90;x.sends++;save(x);await hold('after-send');return {success:true};},
    trade:async()=>({success:true}),
    depositItem:async()=>{const x=load();x[role].bank+=x[role].pack;x[role].pack=0;save(x);generation++;return {success:true};}}
  };return s;
 },settle:async(sessions,ok)=>{for(const s of sessions){writeFileSync(join(root,'.practice/status',s.name+'.json'),JSON.stringify({name:s.name,result:'ended'}));console.log('LOGOUT '+s.name);}return ok;}
});
clearTimeout(deadline);
`.replace('ENTRY',JSON.stringify(resolve(import.meta.dir,'handoff-inputs.ts')));

function cliFixture(){
 const root=mkdtempSync(join(tmpdir(),'handoff-main-'));
 for(const name of ['Donor','Receiver']){const dir=join(root,'vendor/rs-sdk/bots',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'bot.env'),'SERVER=localhost:8888\n');}
 mkdirSync(join(root,'.practice/status'),{recursive:true});mkdirSync(join(root,'.practice/coordinator'),{recursive:true});
 writeFileSync(join(root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[]}));
 writeFileSync(join(root,'swarm.json'),JSON.stringify({jobs:[]}));
 writeFileSync(join(root,'holdings.json'),JSON.stringify({donor:{bank:90,pack:0},receiver:{bank:0,pack:0},sends:0}));
 const children:{p:ReturnType<typeof spawn>;done:Promise<number|null>}[]=[];
 const start=(stage='')=>{
  const p=spawn(process.execPath,['--eval',entryFixture],{windowsHide:true,env:{...process.env,HANDOFF_ORDER:'cli-order',BOT_GOAL:'fixture',FIXTURE_ROOT:root,FIXTURE_STAGE:stage},stdio:['ignore','pipe','pipe']});
  let output='';p.stdout!.on('data',b=>{output+=b;});p.stderr!.on('data',b=>{output+=b;});
  const done=new Promise<number|null>((yes,no)=>{p.once('error',no);p.once('close',yes);});
  children.push({p,done});
  return {p,done,output:()=>output,hold:()=>new Promise<void>((yes,no)=>{
   const timeout=setTimeout(()=>no(Error('child did not reach hold: '+output)),4000);
   const check=()=>{if(output.includes('HOLD ')){clearTimeout(timeout);yes();}};
   p.stdout!.on('data',check);check();
  })};
 };
 return {root,start,async cleanup(){for(const {p} of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');await Promise.all(children.map(c=>c.done));rmSync(root,{recursive:true,force:true});}};
}

for(const prior of ['fresh','dead-owner'])test('main concurrent '+prior+' starts elect one login owner and refuse the loser before login',async()=>{
 const f=cliFixture();try{
  if(prior==='dead-owner'){const old=f.start('login');await old.hold();old.p.kill('SIGKILL');await old.done;}
  const a=f.start('login'),b=f.start('login');
  const first=await Promise.race([a.done.then(code=>({loser:a,code,winner:b})),b.done.then(code=>({loser:b,code,winner:a}))]);
  expect(first.code).toBe(1);expect(first.loser.output()).not.toContain('LOGIN ');
  await first.winner.hold();expect(first.winner.output().match(/LOGIN /g)?.length).toBe(1);
 }finally{await f.cleanup();}
},10000);

for(const stage of ['login','bank-entry','after-send'])test('main kill during '+stage+' resumes and sends exactly once',async()=>{
 const f=cliFixture();try{
  const a=f.start(stage);await a.hold();
  const journal=join(f.root,'.practice/item-handoffs/cli-order/donor-receiver.json');
  expect(JSON.parse(readFileSync(journal,'utf8')).owner.pid).toBe(a.p.pid);
  a.p.kill('SIGKILL');await a.done;
  const b=f.start();expect(await b.done).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root,'holdings.json'),'utf8'))).toEqual({donor:{bank:0,pack:0},receiver:{bank:90,pack:0},sends:1});
  expect(b.output().match(/LOGOUT /g)?.length).toBe(2);
  expect(existsSync(join(f.root,'.practice/account-leases/donor.lock'))).toBe(false);
  expect(existsSync(join(f.root,'.practice/account-leases/receiver.lock'))).toBe(false);
  const duplicate=f.start();expect(await duplicate.done).toBe(1);expect(duplicate.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

for(const conflict of ['coordinator','swarm','stop'])test('main refuses '+conflict+' account conflict before login',async()=>{
 const f=cliFixture();try{
  if(conflict==='coordinator')writeFileSync(join(f.root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[{status:'running',runId:'other',spec:{id:'other',participants:['Receiver']}}]}));
  if(conflict==='swarm')writeFileSync(join(f.root,'swarm.json'),JSON.stringify({jobs:[{enabled:true,account:'Receiver',id:'other'}]}));
  if(conflict==='stop')writeFileSync(join(f.root,'.practice/stop-Receiver'),'');
  const p=f.start();expect(await p.done).toBe(1);expect(p.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

test('main refuses a live recorded order owner even with no account locks',async()=>{
 const f=cliFixture();try{
  const a=f.start('login');await a.hold();
  // Isolate the journal owner check from the account lease check.
  rmSync(join(f.root,'.practice/account-leases'),{recursive:true,force:true});
  const b=f.start();expect(await b.done).toBe(1);expect(b.output()).toContain('order owner still alive');expect(b.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

test('crash resume permits only the matching dead order owner; stale or live foreign owners still refuse',()=>{
 const status={name:'Donor',goal:'exact attempt one',at:1},owner={pid:123,goal:status.goal};
 expect(()=>assertRecoverableStatus(status,owner,()=>false)).not.toThrow();
 expect(()=>assertRecoverableStatus(status,owner,()=>true)).toThrow('unsettled');
 expect(()=>assertRecoverableStatus(status,{...owner,goal:'different'},()=>false)).toThrow('unsettled');
 expect(()=>assertRecoverableStatus(status,undefined,()=>false)).toThrow('unsettled');
});

test('both account leases and global stops refuse before opening either session',()=>{
 const c=parseHandoff(['Donor','Receiver','90:Iron arrowtips']);
 const state={version:1,tasks:[{status:'running',runId:'other',spec:{id:'other-job',participants:['Receiver']}}]};
 expect(()=>assertHandoffOwnership(c,state,[],()=>false,'mine')).toThrow('Receiver');
 state.tasks[0]!.spec.participants=['Donor'];
 expect(()=>assertHandoffOwnership(c,state,[],()=>false,'mine')).toThrow('Donor');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[{account:'Receiver',enabled:true,id:'worker'}],()=>false,'mine')).toThrow('Receiver');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[],n=>n==='swarm','mine')).toThrow('stop-swarm');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[],()=>false,'mine')).not.toThrow();
});

function fixture(mode='ok') {
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|trout|salmon','--bank-x=2725','--bank-z=3493','--request-ms=1000','--timeout-ms=2000','--grace-ms=1000']);
    let now=1000, request:any=mode==='stale'?{at:100,items:c.items}:undefined;
    const events:string[]=[], stops:string[]=[], children=new Map<string,{code:number|null;text:string}>();
    let started=0, transferAt=0;
    const d:HandoffDeps={server:'localhost:8888',owned:new Set(['pocketrocket','ballspinner']),now:()=>now,
        pause:async ms=>{
            now+=ms;
            if(children.has('receiver')&&!request&&mode!=='missing'&&mode!=='early') request={at:now,items:mode==='wrong'?[{name:'Flax',count:152}]:c.items};
            if(mode==='early'&&children.has('receiver'))children.get('receiver')!.code=1;
            if(transferAt&&now-transferAt>=400&&mode!=='timeout') {
                children.set('receiver',{code:0,text:`START 2725 3493 0\nRESULT ok got ${mode==='zero'?'0':'153'} Flax`});
                children.set('donor',{code:0,text:'START 2725 3493 0\nMILESTONE paid Ballspinner 153 Flax\nRESULT ok waiting offline for owned cargo trades=0'});
            }
            for(const name of stops) {const role=name==='Ballspinner'?'receiver':'donor';const p=children.get(role);if(p)p.code=1;}
        },
        status:name=>({name,server:'localhost:8888',at:now,started:mode==='old-session'?1:started,
            result:!children.has('receiver')||name==='Pocketrocket'?(mode==='active'?'':'ok old'):'',pos:{x:2725,z:3493,level:0}}),
        request:()=>request,otherRequests:()=>mode==='other'?['Other.json']:[],stopped:()=>false,
        spawn:role=>{events.push(role);if(role==='receiver')started=now;else{expect(request?.items).toEqual(c.items);expect(request.at).toBeGreaterThanOrEqual(started);transferAt=now;}
            const p={code:role==='donor'&&mode==='early-donor'?0:null,text:role==='donor'&&mode==='early-donor'?'RESULT ok waiting offline for owned cargo':'START 2725 3493 0'} as {code:number|null;text:string};children.set(role,p);
            return {code:()=>children.get(role)!.code,output:()=>children.get(role)!.text} satisfies HandoffChild;},
        stop:name=>{stops.push(name);events.push('stop:'+name);}
    };
    return{c,d,events,stops};
}
test('one receiver starts, fresh authenticated exact request then starts donor; exact receipt and payout required',async()=>{
    const f=fixture();const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(true);expect(r.phase).toBe('done');expect(f.events).toEqual(['receiver','donor']);expect(f.stops).toEqual([]);
});
test('unowned, fresh active and preexisting stop accounts never launch or stop a child',async()=>{
    const f=fixture();f.d.owned=new Set(['ballspinner']);expect((await runHandoff(f.c,f.d)).reason).toContain('not authenticated');expect(f.events).toEqual([]);
    const g=fixture('active');expect((await runHandoff(g.c,g.d)).reason).toContain('account active');expect(g.events).toEqual([]);
    const h=fixture();h.d.stopped=()=>true;expect((await runHandoff(h.c,h.d)).reason).toContain('existing stop');expect(h.events).toEqual([]);
});
test('stale or wrong requests cannot start donor, and cleanup only stops this receiver',async()=>{
    for(const mode of ['stale','wrong','missing','old-session']){const f=fixture(mode);const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(f.events.filter(e=>e==='donor')).toEqual([]);expect(f.stops).toEqual(['Ballspinner']);expect(r.cleanupPending).toEqual([]);}
});
test('early receiver exit and malformed request terminate without donor or login retries',async()=>{
    const f=fixture('early');expect((await runHandoff(f.c,f.d)).reason).toContain('receiver exited before donor');expect(f.events).toEqual(['receiver']);
    const g=fixture();let read=0;g.d.request=()=>{if(++read>1)throw new Error('malformed JSON');return undefined;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('malformed');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('bounded transfer timeout gracefully stops both own children once; no retry',async()=>{
    const f=fixture('timeout');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('handoff timeout');expect(f.events.slice(0,2)).toEqual(['receiver','donor']);expect(f.stops).toEqual(['Ballspinner','Pocketrocket']);expect(r.cleanupPending).toEqual([]);
});
test('successful exits alone cannot claim actual exact transfer',async()=>{
    const f=fixture('zero');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('exact receipt not proved');
});
test('another pending payout never launches children; donor becoming active during receiver startup is preserved',async()=>{
    const f=fixture('other');expect((await runHandoff(f.c,f.d)).reason).toContain('other payout');expect(f.events).toEqual([]);
    const g=fixture();const status=g.d.status;g.d.status=n=>{const s=status(n);if(g.events.length&&n==='Pocketrocket')s.result='';return s;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('became active');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('CLI validates bounds, protected overlap and structured arguments without shell expansion',()=>{
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|bread','--bank-x=2725','--bank-z=3493']);
    const cmd=handoffCommands(c,'F:/repo');expect(cmd.receiver.slice(-3)).toEqual(['Ballspinner','153:Flax','--banker=Pocketrocket']);expect(cmd.env).toMatchObject({PAYOUT_NOTES:'1',ON_DEMAND:'1',COURIERS:'',KEEP:'knife|bread',BANK_X:'2725'});
    for(const args of [['Main','Ballspinner','1:Flax'],['Pocketrocket','Pocketrocket','1:Flax'],['../x','Ballspinner','1:Flax'],['Pocketrocket','Ballspinner','0:Flax'],['Pocketrocket','Ballspinner','1:Flax','--keep=flax'],['Pocketrocket','Ballspinner','1:Flax','--bank-x=NaN'],['Pocketrocket','Ballspinner','1:Flax','--whatever=1']])expect(()=>parseHandoff(args)).toThrow();
});
test('fresh file cannot authenticate an unrelated session or future timestamp',async()=>{
    const f=fixture();const spawn=f.d.spawn;f.d.spawn=role=>({...spawn(role),goal:'my child'});
    expect((await runHandoff(f.c,f.d)).ok).toBe(false);expect(f.events.includes('donor')).toBe(false);
    const g=fixture();g.d.request=()=>({at:999_999,items:g.c.items});
    expect((await runHandoff(g.c,g.d)).ok).toBe(false);expect(g.events.includes('donor')).toBe(false);
});
test('failed graceful cleanup remains an explicit failure, and never retries or deletes state',async()=>{
    const f=fixture('missing');f.d.stop=()=>{throw new Error('different job active; refuse stop');};
    const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('stop failed');expect(r.cleanupPending).toEqual(['Ballspinner']);expect(f.events).toEqual(['receiver']);
});
test('donor exiting cleanly without payout stops the receiver at once instead of burning its wait',async()=>{
    const f=fixture('early-donor');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('donor exited without exact payout');expect(f.stops).toEqual(['Ballspinner']);expect(r.elapsedMs).toBeLessThan(f.c.timeoutMs);
});
