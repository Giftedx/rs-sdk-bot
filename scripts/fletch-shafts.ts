import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';

const LOG=1511,SHAFT=52,KNIFE=946;
export async function runShafts(s:Session,o:{cap:number;maximum:number;reserve:number;bankKnife?:boolean;stop?:()=>boolean;pause?:()=>boolean}){
    if(![o.cap,o.maximum,o.reserve].every(Number.isSafeInteger)||o.cap<1||o.maximum<1||o.maximum>25||o.reserve<0)
        throw Error('shafts requires positive CAP, MAX_MAKE1..25 logs and nonnegative LOG_RESERVE');
    if(!await waitUntil(s,()=>!!s.sdk.getState()?.player&&(s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15}))throw Error('shafts skill sync failed');
    const start=s.tick(),first=s.sdk.getState()!.player!,initialXp=s.sdk.getSkillXp('Fletching')??0;
    const inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
    const initialHp=hp();let hpMin=initialHp,ended=false,died=false,damaged=false;
    void s.ended.then(()=>{ended=true;});
    const off=s.onTick(()=>{const p=s.sdk.getState()?.player;const now=hp();hpMin=Math.min(hpMin,now);damaged||=now<initialHp;
        died||=now<=0||!!p&&(p.isDead||p.lifeId!==first.lifeId||(p.respawnCount??0)>(first.respawnCount??0));});
    const over=()=>ended||died||damaged||!!o.stop?.()||!!o.pause?.()||s.tick()-start>=o.cap;
    // `stop` ends crafting and still banks partial work. `pause` (an owner stop) permits no further bank action at all,
    // including the cleanup deposit, so it is checked before every withdrawal and deposit.
    const hold=()=>{if(o.pause?.())throw Error('shafts owner pause');};
    let snapshot:{id:number;count:number}[]=[],known=false,initial:Map<number,number>|undefined;
    let planned=0,logsUsed=0,made=0,actions=0,bankTrips=0,failure='',stop='input-insufficient';
    const capture=()=>{const b=s.bankObservation?.();if(!b)throw Error('shafts bank observation missing');snapshot=b.items.map(i=>({id:i.id,count:i.count}));known=true;};
    const bankCount=(id:number)=>snapshot.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
    const totals=()=>{const m=new Map<number,number>();for(const i of [...inv(),...s.sdk.getEquipment(),...snapshot])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
    const open=async()=>{
        if(!s.sdk.getState()?.bank.isOpen){const generation=s.bankObservation?.()?.generation??0;
            if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:10}))throw Error('shafts bank unavailable');
            bankTrips++;
        }capture();
    };
    const deposit=async()=>{for(const id of [LOG,SHAFT])if(held(id)){hold();
        if(!(await s.bot.depositItem(inv().find(i=>i.id===id)!,-1)).success||!await waitUntil(s,()=>held(id)===0,{timeoutTicks:5}))throw Error('shafts deposit incomplete');
    }await waitTicks(s,1);capture();};
    try{
        // The SDK selects logs by name. Prevent it from spending a different held species or a certificate.
        if(inv().some(i=>/logs/i.test(i.name)&&i.id!==LOG))throw Error('shafts unrelated held logs or notes');
        await open();initial=totals();await deposit();
        planned=Math.max(0,Math.min(o.maximum,bankCount(LOG)-o.reserve));
        if(planned>0){
            if(!held(KNIFE)){hold();
                const knife=s.sdk.getState()!.bank.items.find(i=>i.id===KNIFE);
                if(!knife||!(await s.bot.withdrawItem(knife,1,{asNote:false})).success||!await waitUntil(s,()=>held(KNIFE)===1,{timeoutTicks:5}))throw Error('shafts owned knife required');
            }
            while(logsUsed<planned&&!over()){
                const batch=Math.min(planned-logsUsed,27-inv().length); // Leave a slot for the shaft stack.
                if(batch<1)throw Error('shafts kit leaves no input slots');
                hold();const logs=s.sdk.getState()!.bank.items.find(i=>i.id===LOG);
                if(!logs||!(await s.bot.withdrawItem(logs,batch,{asNote:false})).success||!await waitUntil(s,()=>held(LOG)===batch,{timeoutTicks:5}))throw Error('shafts withdrawal incomplete');
                await s.bot.closeBank();
                for(let n=0;n<batch&&!over();n++){
                    let misses=0;
                    while(!over()){
                        const before=held(SHAFT),raw=held(LOG),xp=s.sdk.getSkillXp('Fletching')??0;
                        await s.bot.fletchLogs('Arrow Shafts');actions++;
                        await waitUntil(s,()=>held(SHAFT)!==before||held(LOG)!==raw||over(),{timeoutTicks:6});
                        const debit=raw-held(LOG),gain=held(SHAFT)-before;
                        if(debit||gain){
                            if(debit!==1||gain!==15||(s.sdk.getSkillXp('Fletching')??0)<=xp)throw Error('shafts crafting accounting/XP mismatch');
                            logsUsed++;made+=gain;break;
                        }
                        if(++misses>=3)throw Error('no fletching progress: shafts unchanged after three calls');
                    }
                }
                if(o.pause?.())break;
                await open();await deposit();
            }
            stop=logsUsed===o.maximum?'max-make':over()?(o.stop?.()||o.pause?.()?'stopped':'cap'):'input-insufficient';
        }
    }catch(e){failure=String(e);}
    finally{
        if(!ended&&!died&&known&&!o.pause?.())try{
            await open();await deposit();
            if(o.bankKnife&&held(KNIFE)){hold();
                if(!(await s.bot.depositItem(inv().find(i=>i.id===KNIFE)!,-1)).success||!await waitUntil(s,()=>held(KNIFE)===0,{timeoutTicks:5}))throw Error('shafts knife return incomplete');
                await waitTicks(s,1);capture();
            }
            await s.bot.closeBank();
        }catch(e){failure||=String(e);}
        off();
    }
    const final=totals(),changes=new Map([[LOG,-logsUsed],[SHAFT,made]]);
    const preserved=!!initial&&[...new Set([...initial.keys(),...final.keys(),...changes.keys()])].every(id=>(final.get(id)??0)===(initial!.get(id)??0)+(changes.get(id)??0));
    const banked=initial?bankCount(SHAFT)-(initial.get(SHAFT)??0):0,targetMet=logsUsed===o.maximum&&banked===o.maximum*15&&held(LOG)===0&&held(SHAFT)===0;
    const knifeStored=held(KNIFE)===0&&bankCount(KNIFE)>=1;
    return{ok:!failure&&!ended&&!died&&!damaged&&!o.stop?.()&&!o.pause?.()&&preserved&&targetMet&&(!o.bankKnife||knifeStored),ticks:s.tick()-start,planned,logsUsed,made,banked,actions,bankTrips,
        xpGain:(s.sdk.getSkillXp('Fletching')??0)-initialXp,hpMin,died,damaged,preserved,targetMet,knifeStored,stop,failure:failure||'-'};
}
