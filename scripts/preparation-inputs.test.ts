import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {readPreparationInputs,reconcilePreparation,preparationGear} from './preparation-report';
import {questDefinitions} from '../packages/core/src/quest-status';
import {snapshot} from './fleet-sync';
import {observedRouteResources} from './preparation-route-state';

const server='rs-sdk-demo.fly.dev',now=1_000_000;
const quest=questDefinitions().find(q=>q.name==='Rune Mysteries Quest')!;
function fixture(run:(base:string,write:(path:string,value:unknown)=>void)=>void){
 const base=mkdtempSync(join(tmpdir(),'preparation-inputs-'));
 const write=(path:string,value:unknown)=>{const file=join(base,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
 try{run(base,write);}finally{rmSync(base,{recursive:true,force:true});}
}
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');

test('fresh preparation uses registered shared stock, full journals and the current coordinator assignment',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet');
 write('swarm.json',{maxBots:3,jobs:[{account:'Worker',script:'scripts/goldfarm.ts',role:'thieving'},{account:'Haggis',role:'main'}]});
 write('.practice/coordinator/jobs.json',{jobs:[{account:'Worker',script:'scripts/gather-combat.ts',env:{TARGET:'cow'},coordinatorOwner:'coordinator'}]});
 write('fleet/owners.json',{accounts:{Worker:{side:'cloud',server},Donor:{side:'local',server},Haggis:{side:'local',server},Foreign:{side:'cloud',server:'foreign'}}});
 const worker={name:'Worker',server,at:now-100,bankAt:now-200,questsAt:now-300,questJournal:[{...quest,state:'complete'}],quests:['Rune Mysteries Quest'],
  inventory:[],equipment:[],equipmentObserved:true,skills:[{name:'Attack',level:30}],bank:[{id:1277,name:'Bronze sword',count:1},{id:1171,name:'Wooden shield',count:1},{id:333,name:'Trout',count:2},{id:1267,name:'Iron pickaxe',count:1}]};
 write('fleet/snapshots/cloud.json',{side:'cloud',at:now,accounts:[{...worker,server:server.toUpperCase()}]});
 write('fleet/snapshots/local.json',{side:'local',at:now,accounts:[{name:'Donor',server,at:now-100,bankAt:now-200,bank:[{id:333,name:'Trout',count:10}]},{name:'Haggis',server,at:now-100,bankAt:now-200,bank:[{id:333,name:'Trout',count:999}]}]});
 const input=readPreparationInputs({base,fleetDir,side:'cloud',planFile:join(base,'swarm.json'),fallbackAccounts:[]});
 expect(input.names.slice().sort()).toEqual(['Donor','Worker']);
 expect(input.plan.jobs.map((j:any)=>j.script)).toEqual(['scripts/gather-combat.ts']);
 expect(input.issues).toEqual([]);
 const report=reconcilePreparation([{item:'Trout',count:12}],input.statuses,input.names,now);
 expect(report.items[0]).toMatchObject({required:12,recentBanked:12,shortfall:0,state:'covered'});
 expect(report.readiness.find(r=>r.account==='Worker')?.goals['essence-tools']?.state).toBe(true);
 expect(preparationGear(input.plan.jobs,input.statuses,input.names,now).kits[0]?.loadout.state).toBe('ready');
 expect(input.statuses.find(s=>s.name==='Worker')).toMatchObject({server,at:worker.at,bankAt:worker.bankAt,questsAt:worker.questsAt});
 expect(input.sources.Worker).toBe(digest(join(fleetDir,'snapshots/cloud.json')));
 expect(input.observationSources.Worker).toMatchObject({path:join(fleetDir,'snapshots/cloud.json'),kind:'snapshot',side:'cloud',ownerSide:'cloud'});
 expect(input.inputSources.owners).toEqual({path:join(fleetDir,'owners.json'),sha256:digest(join(fleetDir,'owners.json'))});
 expect(input.inputSources.coordinatorJobs).toEqual({path:join(base,'.practice/coordinator/jobs.json'),sha256:digest(join(base,'.practice/coordinator/jobs.json'))});
}));

test('preparation picks current-owner stock and adoption fallback while binding local file identity and server',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet');
 write('swarm.json',{maxBots:3,jobs:[]});
 write('fleet/owners.json',{accounts:{Mover:{side:'other',server},Adopted:{side:'cloud',server},Practice:{side:'cloud',server},Wrong:{side:'cloud',server},Victim:{side:'cloud',server},Missing:{side:'cloud',server}}});
 const row=(name:string,at:number,count:number)=>({name,server,at,bankAt:now-500,bank:[{id:333,name:'Trout',count}]});
 write('.practice/status/Mover.json',row('Mover',now-1,999));
 write('.practice/status/Practice.json',{...row('Practice',now-1,999),practice:true});
 write('.practice/status/Wrong.json',{...row('Wrong',now-1,999),server:'localhost:8888'});
 write('.practice/status/Imposter.json',row('Victim',now-1,999));
 write('fleet/snapshots/other.json',{side:'other',accounts:[row('Mover',now-400,2),row('Adopted',now-300,3)]});
 write('fleet/snapshots/cloud.json',{side:'cloud',accounts:[row('Mover',now-1,888),row('Practice',now-300,4),row('Wrong',now-300,5),row('Victim',now-300,6)]});
 const input=readPreparationInputs({base,fleetDir,side:'cloud',planFile:join(base,'swarm.json'),fallbackAccounts:[]});
 const counts=Object.fromEntries(input.statuses.map(s=>[s.name,s.bank[0].count]));
 expect(counts).toEqual({Practice:4,Wrong:5,Victim:6,Mover:2,Adopted:3});
 expect(input.observationSources.Adopted).toMatchObject({kind:'snapshot',side:'other',ownerSide:'cloud'});
 expect(input.observationSources.Mover).toMatchObject({kind:'snapshot',side:'other',ownerSide:'other'});
 expect(input.issues.filter(i=>i.includes('missing live observation'))).toEqual(['Missing: missing live observation']);
 expect(input.issues).toContain('Imposter.json: local status identity mismatch');
}));

test('matching fresher local observations replace old publications without refreshing unknown bank ages',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet');
 write('swarm.json',{maxBots:3,jobs:[{account:'Local',script:'scripts/gather-ranged.ts'}]});
 write('fleet/owners.json',{accounts:{Local:{side:'cloud',server},Unknown:{side:'cloud',server}}});
 write('fleet/snapshots/cloud.json',{side:'cloud',at:now,accounts:[{name:'Local',server,at:now-100,bankAt:now-200,bank:[{id:333,name:'Trout',count:10}]},{name:'Unknown',server,at:now-100,inventory:null,equipment:null,bank:null,bankAt:null}]});
 const local={name:'Local',server,at:now-1,bank:[{id:333,name:'Trout',count:3}],questsAt:null,questJournal:null};
 write('.practice/status/Local.json',local);
 const input=readPreparationInputs({base,fleetDir,side:'cloud',planFile:join(base,'swarm.json'),fallbackAccounts:[]});
 expect(input.statuses.find(s=>s.name==='Local')).toMatchObject(local);
 expect(input.statuses.find(s=>s.name==='Local')?.bankAt).toBeUndefined();
 expect(input.statuses.find(s=>s.name==='Unknown')).toMatchObject({inventory:null,equipment:null,bank:null,bankAt:null});
 expect(input.observationSources.Local).toMatchObject({kind:'status',path:join(base,'.practice/status/Local.json'),side:'cloud',ownerSide:'cloud'});
 expect(input.sources.Local).toBe(digest(join(base,'.practice/status/Local.json')));
 const report=reconcilePreparation([{item:'Trout',count:1}],input.statuses,input.names,now);
 expect(report.items[0]).toMatchObject({recentBanked:0,state:'unknown'});
}));

test('preparation follows the configured cloud plan and its coordinator overlay, binding their actual sources',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet'),planFile=join(base,'.practice/cloud-handoff/swarm.json'),prior=process.env.SWARM_PLAN;
 write('swarm.json',{maxBots:1,jobs:[{account:'Default',script:'scripts/goldfarm.ts'}]});
 write('.practice/cloud-handoff/swarm.json',{maxBots:2,jobs:[{account:'Worker',script:'scripts/goldfarm.ts'}]});
 write('.practice/coordinator/jobs.json',{jobs:[{account:'Worker',script:'scripts/gather-ranged.ts',coordinatorOwner:'coordinator'}]});
 write('fleet/owners.json',{accounts:{Worker:{side:'cloud',server}}});
 process.env.SWARM_PLAN=planFile;
 try{
  const input=readPreparationInputs({base,fleetDir,side:'cloud',fallbackAccounts:[]});
  expect(input.names).toEqual(['Worker']);
  expect(input.plan.jobs.map(j=>j.script)).toEqual(['scripts/gather-ranged.ts']);
  expect(input.inputSources.ownerPlan).toEqual({path:planFile,sha256:digest(planFile)});
 }finally{if(prior===undefined)delete process.env.SWARM_PLAN;else process.env.SWARM_PLAN=prior;}
}));

test('actual shared pack projection preserves raw note identity for equipment and carried-route requirements',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet'),side='cloud',owners=new Map([['worker',{side,server}]]);
 const job={account:'Worker',script:'scripts/gather-fire-combat.ts'};
 write('swarm.json',{maxBots:1,jobs:[job]});
 write('fleet/owners.json',{accounts:{Worker:{side,server}}});
 const inventory=(notedWeapon:boolean,notedRope=notedWeapon)=>[{id:notedWeapon?1332:1331,baseId:1331,name:'Adamant scimitar',count:1},{id:1171,baseId:1171,name:'Wooden shield',count:1},
  {id:295,baseId:295,name:'Glarials amulet',count:1},{id:notedRope?955:954,baseId:954,name:'Rope',count:2},{id:329,baseId:329,name:'Salmon',count:16}];
 const source=(notedWeapon:boolean,notedRope=notedWeapon)=>({name:'Worker',server,at:now-100,bankAt:now-200,bank:[],inventory:inventory(notedWeapon,notedRope),equipment:[],equipmentObserved:true,skills:[{name:'Attack',level:30}]});
 for(const[notedWeapon,notedRope]of [[true,false],[false,true],[false,false]] as const){
  const published=snapshot([source(notedWeapon,notedRope)],side,owners,now);
  write('fleet/snapshots/cloud.json',published);
  const input=readPreparationInputs({base,fleetDir,side,planFile:join(base,'swarm.json'),fallbackAccounts:[]});
  expect(input.statuses[0]!.inventoryIds).toBe('raw');
  expect(input.statuses[0]!.inventory.find((i:any)=>i.baseId===1331)?.id).toBe(notedWeapon?1332:1331);
  const gear=preparationGear(input.plan.jobs,input.statuses,input.names,now);
  expect(gear.kits[0]?.loadout.state).toBe(notedWeapon||notedRope?'missing':'ready');
  const report=reconcilePreparation([],input.statuses,input.names,now),actor=report.routeActors.find(a=>a.name==='Worker');
  const carried=observedRouteResources(actor,'Worker',server,now,['item:rope']);
  // Unknown noted IDs make the whole carried resource view unknown; only a fully resolved raw pack proves a rope.
  expect(carried.resources.held?.rope??0).toBe(notedWeapon||notedRope?0:2);
  if(notedWeapon||notedRope)expect(carried.resources.held).toBeNull();
  expect(input.sources.Worker).toBe(digest(join(fleetDir,'snapshots/cloud.json')));
 }
 const published=snapshot([source(true)],side,owners,now),row=published.accounts[0]!;
 const {inventoryIds:_,...legacy}=row;
 write('fleet/snapshots/cloud.json',{...published,accounts:[{...legacy,inventory:inventory(true).map(({id,baseId,...i})=>({...i,id:baseId}))}]});
 const input=readPreparationInputs({base,fleetDir,side,planFile:join(base,'swarm.json'),fallbackAccounts:[]});
 expect(input.statuses[0]!.inventory).toBeNull();expect(input.statuses[0]!.bank).toEqual([]);
 expect(preparationGear(input.plan.jobs,input.statuses,input.names,now).kits[0]?.loadout.state).toBe('unknown');
 const actor=reconcilePreparation([],input.statuses,input.names,now).routeActors.find(a=>a.name==='Worker');
 expect(observedRouteResources(actor,'Worker',server,now,['item:rope']).resources.held).toBeNull();
}));

test('legacy empty packs stay known and local raw packs need no shared schema marker',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet'),side='cloud';
 write('swarm.json',{maxBots:1,jobs:[]});write('fleet/owners.json',{accounts:{Worker:{side,server}}});
 const row={name:'Worker',server,at:now-100,bankAt:now-200,bank:[],inventory:[],equipment:[],equipmentObserved:true,skills:[]};
 write('fleet/snapshots/cloud.json',{side,accounts:[row]});
 const options={base,fleetDir,side,planFile:join(base,'swarm.json'),fallbackAccounts:[]};
 expect(readPreparationInputs(options).statuses[0]!.inventory).toEqual([]);
 const raw=[{id:955,baseId:954,name:'Rope',count:2}];
 write('.practice/status/Worker.json',{...row,at:now-1,inventory:raw});
 const input=readPreparationInputs(options);
 expect(input.statuses[0]!.inventory).toEqual(raw);expect(input.observationSources.Worker?.kind).toBe('status');
 const actor=reconcilePreparation([],input.statuses,input.names,now).routeActors[0];
 expect(observedRouteResources(actor,'Worker',server,now,['item:rope']).resources.held?.rope??0).toBe(0);
}));

test('unregistered legacy jobs belong to local while their observed stock remains visible to every side',()=>fixture((base,write)=>{
 const fleetDir=join(base,'fleet'),job={account:'Legacy',script:'scripts/gather-combat.ts',env:{TARGET:'cow'}};
 write('swarm.json',{maxBots:1,jobs:[job]});write('fleet/owners.json',{accounts:{}});
 write('fleet/snapshots/local.json',{side:'local',accounts:[{name:'Legacy',server,at:now-100,bankAt:now-200,bank:[{id:333,name:'Trout',count:2}]}]});
 for(const side of ['local','cloud']){
  const input=readPreparationInputs({base,fleetDir,side,planFile:join(base,'swarm.json'),fallbackAccounts:[]});
  expect(input.plan.jobs).toEqual(side==='local'?[job]:[]);
  expect(input.names).toEqual(['Legacy']);expect(input.issues).toEqual([]);
  const stock=reconcilePreparation([{item:'Trout',count:2}],input.statuses,input.names,now);
  expect(stock.items[0]).toMatchObject({recentBanked:2,shortfall:0,state:'covered'});
 }
}));
