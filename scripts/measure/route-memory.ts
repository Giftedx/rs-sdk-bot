// Offline: RSS, heap and time after each load step a bot process takes, then two long route searches and one
// route-worker plan. No login. Baseline on Windows: ~288 MB after path load, ~1.3-1.5 GB after the routes.
// Usage: bun scripts/measure/route-memory.ts
const mb=()=>{const m=process.memoryUsage();return `rss=${Math.round(m.rss/2**20)} heap=${Math.round(m.heapUsed/2**20)} ext=${Math.round(m.external/2**20)} ab=${Math.round(m.arrayBuffers/2**20)}`;};
const step=async(l:string,f:()=>unknown)=>{const t=performance.now();await f();Bun.gc(true);console.log(l.padEnd(26),mb(),Math.round(performance.now()-t)+'ms');};
await step('base',()=>0);
await step('import bot+walk',async()=>{await import('../../packages/core/src/bot');await import('../../packages/core/src/walk');});
await step('loadPathfinding',async()=>{const {loadPathfinding}=await import('../../packages/core/src/pathcache');await loadPathfinding();});
let w:any;
await step('createWorld',async()=>{const {createWorld,rsPathLength}=await import('../../packages/core/src/world');w=createWorld({pathLength:await rsPathLength()});});
await step('mapAreas',async()=>{const pf:any=await import('../../vendor/rs-sdk/sdk/pathfinding.ts');const g=await import('../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');const {mapAreas}=await import('../../packages/core/src/components');mapAreas(pf,g,process.cwd());});
const acct={skills:{hitpoints:10},coins:20000,varps:{},items:[],worn:[],unlocks:[],questStages:{}} as any;
await step('route Ardougne-Varrock',()=>w.route({x:2655,z:3283,level:0},{x:3185,z:3436,level:0},acct));
await step('route Lumbridge-Catherby',()=>w.route({x:3222,z:3218,level:0},{x:2809,z:3441,level:0},acct));
await step('spawn index',async()=>{const {objSpawns}=await import('../../packages/core/src/spawn-index');objSpawns();});
await step('shop index',async()=>{const {shopSellers}=await import('../../packages/core/src/shop-index');shopSellers();});
await step('route worker plan',async()=>{const {planTripOffThread}=await import('../../packages/core/src/route-plan') as any; if(planTripOffThread) await planTripOffThread({x:3222,z:3218,level:0},{x:2809,z:3441,level:0},acct).catch((e:any)=>console.log('worker err',String(e).slice(0,120)));});
process.exit(0);
