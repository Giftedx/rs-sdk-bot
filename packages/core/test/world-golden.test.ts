import {beforeAll,expect,test} from 'bun:test';
import {loadPathfinding} from '../src/pathcache';
import {createWorld,rsPathLength,type Account,type World} from '../src/world';
import routes from './fixtures/routes-golden.json';
let world:World;
beforeAll(async()=>{await loadPathfinding();world=createWorld({pathLength:await rsPathLength()});},120_000);
// A route is judged by its cost, its transport and travel legs and where it ends: the split of the walk between them into
// waypoint legs differs between machines at the same cost (route 20's last walk from the Ardougne dock to Catherby came as
// one leg here and as three on the hosted runner), so the exact leg list is not compared.
type R=ReturnType<World['route']>;
const shape=(r:R)=>r.ok?{ok:true,cost:r.cost,steps:r.legs.filter(l=>l.kind!=='walk').map(l=>({kind:l.kind,at:l.at,to:l.to,name:l.kind==='travel'?l.travel.name:l.loc})),end:r.legs[r.legs.length-1]?.to}:r;
for(const [i,row]of routes.entries())test(`golden route ${i+1}: ${row.from.x},${row.from.z},${row.from.level} -> ${row.to.x},${row.to.z},${row.to.level}`,()=>{
    expect(shape(world.route(row.from,row.to,row.account as Account))).toEqual(shape(row.result as R));
},180_000);
