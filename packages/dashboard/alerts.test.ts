import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {snapshot} from '../../scripts/fleet-sync';
import {productionReview} from './collection';
import {dashboardStatuses,remoteBots} from './fleet-view';

const server=readFileSync(new URL('./server/state/views.ts',import.meta.url),'utf8');
const start=server.indexOf('function alerts('),end=server.indexOf('// ---------- role-aware row data',start);
if(start<0||end<start)throw Error('Missing dashboard alerts consumer');
const code=new Bun.Transpiler({loader:'ts'}).transformSync(server.slice(start,end));
const alerts=(bots:any[],now:number)=>new Function('productionReview',`
 const results=[],productionReviews=new Map(),practiceNames=()=>new Set();
 ${code};return alerts;
`)(productionReview)(bots,now) as {name:string;at:number;kind:string;text:string;practice:boolean}[];

test('a fresh remote bank snapshot with a disabled plan is offline without a stuck alert',()=>{
 const at=1794855715119,now=at+805_000,name='FullLoad',server='rs-sdk-demo.fly.dev';
 const owners=new Map([['fullload',{side:'cloud',server}]]);
 const shared=snapshot([{name,server,at,bank:[],bankAt:1794855712917,result:'ok bank observed'}],'cloud',owners,now);
 const plans=[{side:'cloud',at:now-1,jobs:[{account:name,enabled:false,script:'scripts/chain.ts',goal:'finite bank entry and fresh holdings'}]}];
 const [row]=remoteBots([shared],new Set(),new Map(),new Map(),now,'local',plans,()=> 'cloud');
 expect(row).toMatchObject({remote:true,operation:'offline',fresh:false,inWorld:false,bankAt:1794855712917,planJob:{enabled:false}});
 expect(row.job).toBeUndefined();expect(row.result).toBeUndefined();
 expect(alerts([row],now)).toEqual([]);
});

test('remote world presence and own-side stock snapshots do not claim a stalled worker',()=>{
 const at=1_000_000,now=at+120_000,name='Worker',server='rs-sdk-demo.fly.dev';
 const shared={side:'cloud',at:now,accounts:[{name,server,at}]};
 const [remote]=remoteBots([shared],new Set(),new Map([['worker',{x:1,z:2,level:0,combat:3,seen:now}]]),new Map(),now);
 expect(remote).toMatchObject({remote:true,operation:'observed',inWorld:true,fresh:true});
 expect(alerts([remote],now)).toEqual([]);
 const own=dashboardStatuses(new Map(),[{...shared,side:'local'}],()=> 'local','local',now).get(name);
 expect(own.snapshotOnly).toBe(true);
 expect(alerts([own],now)).toEqual([]);
});

test('local controller jobs still alert when their status stops for more than a minute',()=>{
 const now=1_000_000,at=now-120_000;
 for(const state of ['running','starting','external']){
  expect(alerts([{name:'Worker',at,operation:'active-stale',processActive:true,job:{state}}],now))
   .toEqual([{name:'Worker',at,kind:'stuck',text:'no status for 120 s while running',practice:false}]);
 }
});

test('local manual status keeps its finite stall window and completed or disabled jobs stay quiet',()=>{
 const now=1_000_000,b={name:'Worker',at:now-120_000};
 expect(alerts([b],now)).toEqual([{name:'Worker',at:b.at,kind:'stuck',text:'no status for 120 s while running',practice:false}]);
 for(const change of [{at:now-60_000},{at:now-900_000},{result:'ok done'},{job:{state:'disabled'}},{job:{state:'ended'}}])
  expect(alerts([{...b,...change}],now)).toEqual([]);
});

test('live tickStats alerts catch standing-still, dialog, open-window, move, and high-waste stalls without false combat alerts',()=>{
 const now=1_000_000,at=now-2000;
 // Active combat idle (currentStandStill=0, currentIdle=30) must NOT alert.
 expect(alerts([{name:'Fighter',at,fresh:true,tickStats:{ticks:100,currentIdle:30,currentStandStill:0,windowTicks:100,windowStandStillPct:10,standStillPct:10,currentDialogTicks:0,currentWindowTicks:0,currentMoveStreak:0}}],now)).toEqual([]);
 // Standing still > 20 ticks alerts with reason and tile.
 expect(alerts([{name:'Stuck',at,fresh:true,tickStats:{ticks:100,currentStandStill:35,currentStandStillWhy:'after:interactLoc',currentStandStillAt:'3200,3200',windowTicks:100,windowStandStillPct:35}}],now))
  .toEqual([{name:'Stuck',at,kind:'idle',text:'standing still 35 ticks (after:interactLoc @ 3200,3200)',practice:false}]);
 // Dialog stall > 20 ticks alerts.
 expect(alerts([{name:'Chatter',at,fresh:true,tickStats:{ticks:100,currentStandStill:0,currentDialogTicks:25,windowTicks:100,windowStandStillPct:0}}],now))
  .toEqual([{name:'Chatter',at,kind:'idle',text:'dialog open 25 ticks',practice:false}]);
 // Open bank/shop window > 20 ticks alerts.
 expect(alerts([{name:'Shopper',at,fresh:true,tickStats:{ticks:100,currentStandStill:0,currentDialogTicks:0,currentWindowTicks:28,currentWindowKind:'shop',windowTicks:100,windowStandStillPct:0}}],now))
  .toEqual([{name:'Shopper',at,kind:'idle',text:'shop open 28 ticks',practice:false}]);
 // High rolling standing-still % with interleaved actions alerts.
 expect(alerts([{name:'Drifter',at,fresh:true,tickStats:{ticks:150,currentStandStill:5,windowTicks:120,windowStandStillPct:72,standStillPct:70,topIdleBy:[['bank',60]]}}],now))
  .toEqual([{name:'Drifter',at,kind:'efficiency',text:'high standing-still 72% over 120t (bank)',practice:false}]);
 // Legacy timeline without tickStats alerts on trailing d+ and high idle %.
 expect(alerts([{name:'LegacyDlg',at,fresh:true,timeline:'xx'+'d'.repeat(25)}],now))
  .toEqual([{name:'LegacyDlg',at,kind:'idle',text:'dialog open 25 ticks',practice:false}]);
 expect(alerts([{name:'LegacyHigh',at,fresh:true,timeline:('iiix').repeat(30)}],now))
  .toEqual([{name:'LegacyHigh',at,kind:'efficiency',text:'high idle 75% over 120t',practice:false}]);
});
