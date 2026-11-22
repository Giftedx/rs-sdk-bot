import {expect,test} from 'bun:test';
import {foodSupplyDemand,foodSupplyServer,type Job} from './swarm';
import {formatStep} from '../packages/core/src/chain-step';

const now=100000,server='127.0.0.1:21000',owned=new Set(['farm','cook','courier','other']);
const base:Job={account:'Courier',script:'scripts/aio-logistics.ts',args:['food-courier'],enabled:true,whenFoodLowFrom:['Farm'],foodSourceAccount:'Cook'};
const farm={name:'Farm',server,at:now,bankAt:now-1,bank:[],inventory:[]};
const cook={name:'Cook',server,at:now,bankAt:now-1,bank:[{id:385,count:100}]};
const courier=(name='Courier')=>({name,server,at:now-60000,result:'ok retained',pos:{x:2654,z:3283,level:0},inventory:[{id:386,count:115}]});
const demand=(job=base,statuses:any[]=[farm,cook],ownership:ReadonlySet<string>=owned)=>foodSupplyDemand(job,statuses,ownership,now,server);

test('food demand binds the configured endpoint, fresh owned cook and every shared cooked-fish type',()=>{
 expect(demand()).toBe(true);
 expect(foodSupplyDemand(base,[farm,cook],owned,now)).toBe(false);
 for(const id of[329,333,379,385])expect(demand(base,[farm,{...cook,bank:[{id,count:100}]}])).toBe(true);
 for(const change of[{server:'rs-sdk-demo.fly.dev'},{server:'127.0.0.1:21010'},{at:now-30000},{at:now+1},{result:'fail stopped'},{bank:[{id:386,count:1000}]}])
  expect(demand(base,[farm,{...cook,...change}])).toBe(false);
 for(const change of[{server:'rs-sdk-demo.fly.dev'},{at:now-30000},{at:now+1},{inventory:[{id:386,count:80}]},{bank:[{id:385,count:80}]}])
  expect(demand(base,[{...farm,...change},cook])).toBe(false);
 expect(demand(base,[farm,cook],new Set(['farm']))).toBe(false);
 expect(demand(base,[farm,cook],new Set(['cook']))).toBe(false);
});

test('AIO logistics, master dispatch, generated chains and pipelines share courier admission',()=>{
 const routes:Pick<Job,'script'|'args'>[]=[
  {script:'scripts/aio-logistics.ts',args:['food-courier','CAP=1200']},
  {script:'scripts/aio-logistics.ts',args:['--role=food-courier']},
  {script:'scripts/aio.ts',args:['--category=logistics','food-courier']},
  {script:'scripts/chain.ts',args:[formatStep({script:'scripts/aio-logistics.ts',args:['food-courier'],env:{FROM:'Cook'}})]},
  {script:'scripts/chain.ts',args:[formatStep({script:'scripts/aio.ts',args:['logistics','food-courier'],env:{}})]},
  {script:'scripts/aio.ts',args:['pipeline','logistics:food-courier CAP=1200']},
  {script:'scripts/aio.ts',args:['pipeline','logistics food-courier CAP=1200']},
 ];
 for(const route of routes)expect(demand({...base,...route})).toBe(true);
 for(const route of[
  {script:'scripts/aio-logistics.ts',args:['food-chain']},
  {script:'scripts/aio.ts',args:['skiller','food-courier']},
  {script:'scripts/chain.ts',args:['scripts/aio-logistics.ts "unterminated']},
 ])expect(demand({...base,...route})).toBe(false);
});

test('retained shark notes resume delivery without a cook, and hosted workers must each be ready',()=>{
 expect(demand(base,[farm,courier()])).toBe(true);
 for(const change of[{server:'rs-sdk-demo.fly.dev'},{at:now+1},{inventory:[{id:385,count:115}]},{pos:{x:3222,z:3218,level:0}}])
  expect(demand(base,[farm,{...courier(),...change}])).toBe(false);
 const host:Job={...base,account:undefined,host:true,accounts:['Courier','Other']};
 expect(demand(host,[farm,courier()])).toBe(false);
 expect(demand(host,[farm,courier(),courier('Other')])).toBe(true);
 expect(demand(host,[farm,cook])).toBe(true);
 expect(demand({...host,orchestrate:true})).toBe(false);
 expect(demand({...host,account:'Courier'})).toBe(false);
});

test('production endpoint selection reads each actual account configuration and refuses unresolved or mixed hosts',()=>{
 const lookedUp:string[]=[];
 expect(foodSupplyServer(base,name=>{lookedUp.push(name);return server;})).toBe(server);
 expect(lookedUp).toEqual(['Courier']);
 const host:Job={...base,account:undefined,host:true,accounts:['Courier','Other']};
 expect(foodSupplyServer(host,()=>server)).toBe(server);
 expect(foodSupplyServer(host,name=>name==='Courier'?server:'127.0.0.1:21010')).toBeNull();
 expect(foodSupplyServer(base,()=>{throw Error('missing account config');})).toBeNull();
 expect(foodSupplyServer({...host,accounts:['Courier','courier']},()=>server)).toBeNull();
 expect(foodSupplyDemand(base,[farm,cook],owned,now,null)).toBe(false);
});
