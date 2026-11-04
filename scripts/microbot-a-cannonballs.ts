// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite Al Kharid furnace supply: bun scripts/microbot-a-cannonballs.ts <account> [steel-bars=1] [cap=1200].
// Native cannonballs.rs2 consumes one steel bar and makes four balls, requires Smithing35 and ammo_mould.
import {existsSync} from 'node:fs';
import {openBot} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {runSmeltBatch,validateSmeltOrder,type SmeltLocalRoute} from './smelt-batch';
import {actionSessionOwner,finishActionSession} from './microbot-a-actions';
export const CANNON={bar:2353,ball:2,mould:4,level:35,perBar:4,bank:{x:3269,z:3167},furnace:{x:3274,z:3186}} as const;
type Stock=readonly{id:number;count:number}[];
const count=(rows:Stock,id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function cannonballEffect(before:Stock,after:Stock,xp0:number,xp1:number){
 const ids=new Set([...before,...after].map(i=>i.id));
 if([...ids].every(id=>count(before,id)===count(after,id))&&xp0===xp1)return 'none';
 return xp1>xp0&&[...ids].every(id=>count(after,id)-count(before,id)===(id===CANNON.bar?-1:id===CANNON.ball?4:0))?'made':'invalid';
}
export type CannonballOrder={bars:number;cap:number;stop?:()=>boolean;xpRate?:number;reserve?:number;route?:SmeltLocalRoute;nearest?:boolean};
export async function runCannonballs(s:Session,o:CannonballOrder,io?:Parameters<typeof runSmeltBatch>[2]){
 if(!Number.isSafeInteger(o.bars)||o.bars<1||o.bars>100000||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>10000)throw Error('invalid cannonball batch');
 const p=s.sdk.getState()?.player;
 if(!p)throw Error('stage cannonballs with observed player');
 const r=await runSmeltBatch(s,{bar:'cannonballs',maximum:o.bars,cap:o.cap,mode:'exact',reserve:o.reserve??0,xpRate:o.xpRate??1,route:o.route,nearest:o.nearest,stop:o.stop},io);
 return{...r,bars:r.made,balls:r.made*CANNON.perBar,xp:r.xpGain};
}
if(import.meta.main){
 const[account,bars,cap]=process.argv.slice(2);if(!account)throw Error('account required');
 const route=process.env.CANNON_ROUTE_JSON?JSON.parse(process.env.CANNON_ROUTE_JSON)as SmeltLocalRoute:undefined,nearest=process.env.CANNON_NEAREST==='1';
 if(process.env.CANNON_NEAREST!==undefined&&!['0','1'].includes(process.env.CANNON_NEAREST))throw Error('invalid CANNON_NEAREST');
 const order:CannonballOrder={bars:Number(bars??1),cap:Number(cap??1200),xpRate:Number(process.env.CANNON_XP_RATE??1),reserve:Number(process.env.CANNON_RESERVE??0),route,nearest};
 validateSmeltOrder({bar:'cannonballs',maximum:order.bars,cap:order.cap,reserve:order.reserve!,xpRate:order.xpRate,mode:'exact',route,nearest});
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const stop=()=>stopped||existsSync('.practice/stop-microbot-cannonballs'),s=await openBot(account,{onStop:async()=>{stopped=true;}}),owner=actionSessionOwner(s,stop);
 try{const r=await runCannonballs(s,{...order,stop});console.log('CANNONBALL_RESULT '+JSON.stringify(r));await finishActionSession(owner,r.ok,JSON.stringify(r));}catch(e){await finishActionSession(owner,false,String(e));}
}
