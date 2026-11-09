import { openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import { componentId } from '../packages/core/src/logout';
import {watchProductionLife} from './microbot-c-lifetime';

// Native tanner.rs2 uses IF_BUTTON, not the donor's modern widget IDs.
export const tanningRecipes = {
 soft: { input:1739, output:1741, cost:1, button:'tanner:com_96' },
 hard: { input:1739, output:1743, cost:3, button:'tanner:com_101' },
 green:{ input:1753, output:1745, cost:20, button:'tanner:com_106' },
 blue: { input:1751, output:2505, cost:20, button:'tanner:com_111' },
 red:  { input:1749, output:2507, cost:20, button:'tanner:com_116' },
 black:{ input:1747, output:2509, cost:20, button:'tanner:com_121' },
} as const;
export type TanKind = keyof typeof tanningRecipes;
type Assets={input:number;output:number;coins:number};
export function tanningEffect(before:Assets,after:Assets,cost:number):boolean {
 return before.input-after.input===1 && after.output-before.output===1 && before.coins-after.coins===cost;
}

// Finite staged-inventory consumer: start beside the Al Kharid Tanner with
// unnoted hides and coins. Preserve all other carried assets. No bank sweep.
export async function tanInventory(s:Session,kind:TanKind,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Object.hasOwn(tanningRecipes,kind)||!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid tanning order');
 const r=tanningRecipes[kind],start=s.tick();
 const count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const assets=():Assets=>({input:count(r.input),output:count(r.output),coins:count(995)});
 const initial=assets(),protectedItems=new Map<number,number>();
 for(const i of s.sdk.getInventory())if(![r.input,r.output,995].includes(i.id))protectedItems.set(i.id,count(i.id));
 const life=watchProductionLife(s,stop),over=()=>life.stopped()||s.tick()-start>=cap;
 let made=0,detail='';
 try{
  if(initial.input<maximum||initial.coins<maximum*r.cost)throw Error('staged tanning supplies short');
  while(made<maximum&&!over()){
   const npc=s.sdk.getState()?.nearbyNpcs.find(n=>/^Tanner$/i.test(n.name));
   if(!npc)throw Error('Al Kharid Tanner must be nearby');
   const before=assets();
   const traded=await s.sdk.sendInteractNpc(npc.index,3);
   if(!traded.success)throw Error('tanner trade refused');
   if(!await waitUntil(s,()=>!!s.sdk.getState()?.interface?.isOpen||over(),{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-start)))}))throw Error('tanning interface timeout');
   if(over())break;
   await s.sdk.sendClickComponent(componentId(r.button));
   await waitUntil(s,()=>tanningEffect(before,assets(),r.cost)||over(),{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-start)))});
   if(!tanningEffect(before,assets(),r.cost))throw Error('tanning item/coin reconciliation failed');
   made++;
  }
  if(made!==maximum)throw Error('tanning budget or stop');
 }catch(error){detail=String(error);}
 const final=assets(),preserved=[...protectedItems].every(([id,n])=>count(id)===n);
 const conserved=initial.input-final.input===made&&final.output-initial.output===made&&initial.coins-final.coins===made*r.cost;
 detail ||= life.reason();return{ok:!detail&&made===maximum&&preserved&&conserved,made,coinsSpent:initial.coins-final.coins,preserved,conserved,ticks:s.tick()-start,detail};
}
if(import.meta.main){
 const name=process.argv[2]??'',kind=process.argv[3] as TanKind,maximum=Number(process.argv[4]??1),cap=Number(process.argv[5]??80);
 if(!name||!Object.hasOwn(tanningRecipes,kind)||!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-tanner.ts <account> <soft|hard|green|blue|red|black> [quantity] [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const s=await openBot(name);let ok=false;
 try{const result=await tanInventory(s,kind,maximum,cap,()=>stopped);console.log('TANNING_RESULT '+JSON.stringify(result));ok=result.ok;}
 finally{ok=await settle([s],ok,'finite tanning order');}process.exitCode=ok?0:1;
}
