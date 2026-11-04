import {beforeAll,expect,test} from 'bun:test';
import {loadPathfinding} from '../src/pathcache';
import {createWorld,rsPathLength,type Account,type World} from '../src/world';
import routes from './fixtures/routes-golden.json';
let world:World;
beforeAll(async()=>{await loadPathfinding();world=createWorld({pathLength:await rsPathLength()});},120_000);
for(const [i,row]of routes.entries())test(`golden route ${i+1}: ${row.from.x},${row.from.z},${row.from.level} -> ${row.to.x},${row.to.z},${row.to.level}`,()=>{
    expect(world.route(row.from,row.to,row.account as Account)).toEqual(row.result as ReturnType<World['route']>);
},180_000);
