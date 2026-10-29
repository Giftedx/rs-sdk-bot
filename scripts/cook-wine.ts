import {openBot,settle} from '../packages/core/src/bot';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';

type Options={target:number;cap:number};
type StageResult={ok:boolean;targetMet:boolean;level:number;ticks:number;banked:number;detail:string};
export type WineStage=(name:string,options:Options,phase:'starter'|'finish')=>Promise<StageResult>;
export function starterConsumed(stock:{bankRaw:number;heldRaw:number}|null):boolean{
 return stock!==null&&stock.bankRaw===0&&stock.heldRaw===0;
}

// A staged bank entry contains raw starter wine and noted bulk in the pack.
// Ferment the starter, bank the bulk, and relog using the existing session owner.
const playStage:WineStage=async(name,options,phase)=>{
 const s=await openBot(name),start=s.tick();
 const level=()=>s.sdk.getSkill('Cooking')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Cooking')??0;
 let banked=0,detail='',ok=false;
 try{
  if(level()<options.target){
   if(phase==='starter'){
    const xp0=xp();
    // The staged starter ferments on login. Opening a modal bank before that
    // delays the normal timer. Observe the effect before opening the bulk bank.
    if(!await waitUntil(s,()=>level()>=options.target||xp()>xp0,{timeoutTicks:Math.min(options.cap,25)})){
     // All starter batches can become bad wine. Inspect the item outcome before
     // failing a no-XP result or leaving usable bulk untouched.
     if(!(await s.bot.openBank()).success)throw Error('starter outcome bank refused');
     if(!await waitUntil(s,()=>!!s.bankObservation?.(),{timeoutTicks:10}))throw Error('starter outcome unknown');
     const bank=s.bankObservation?.();
     const bankRaw=bank?.items.filter(i=>i.id===1995).reduce((n,i)=>n+i.count,0)??NaN;
     const heldRaw=s.sdk.getInventory().filter(i=>i.id===1995).reduce((n,i)=>n+i.count,0);
     if(!starterConsumed(bank?{bankRaw,heldRaw}:null))throw Error('starter wine has not settled');
    }
    if(level()<options.target){
     const notes=s.sdk.getInventory().find(i=>i.id===1996);
     if(!notes||notes.count<1)throw Error('wine order needs more owned bulk stock');
     const amount=notes.count;
     if(!s.sdk.getState()?.bank.isOpen&&!(await s.bot.openBank()).success)throw Error('wine bulk bank refused');
     banked=await depositObserved(s,notes);
     if(banked!==amount)throw Error('wine bulk credit mismatch');
    }
   }else if(!await waitUntil(s,()=>level()>=options.target,{timeoutTicks:options.cap}))throw Error('wine order short of target; acquire more stock');
  }
  ok=phase==='starter'?(level()>=options.target||banked>0):level()>=options.target;
  detail=`phase=${phase} level=${level()} target=${options.target} banked=${banked} ticks=${s.tick()-start}`;
 }catch(error){detail=String(error);}
 const result={ok,targetMet:level()>=options.target,level:level(),ticks:s.tick()-start,banked,detail};
 // Confirm logout before the next login. No dropped-connection relog or fixed sleep.
 result.ok=await settle([s],ok,detail);return result;
};

export async function runWineOrder(name:string,options:Options,stage:WineStage=playStage){
 if(!name||!Number.isSafeInteger(options.target)||options.target<1||options.target>99||!Number.isSafeInteger(options.cap)||options.cap<1)throw Error('invalid wine order');
 let ticks=0;const stages:StageResult[]=[];
 for(const phase of ['starter','finish'] as const){
  const result=await stage(name,options,phase);stages.push(result);ticks+=result.ticks;
  if(!result.ok)return{ok:false,targetMet:false,level:result.level,ticks,stages};
  if(result.targetMet&&result.level>=options.target)return{ok:true,targetMet:true,level:result.level,ticks,stages};
 }
 return{ok:false,targetMet:false,level:stages.at(-1)?.level??0,ticks,stages};
}

if(import.meta.main){
 try{
  const result=await runWineOrder(process.argv[2]??'',{target:Number(process.argv[3]??99),cap:Number(process.argv[4]??80)});
  console.log('WINE_ORDER_RESULT '+JSON.stringify(result));process.exit(result.ok?0:1);
 }catch(error){console.error(String(error));process.exit(1);}
}
