// Collect one owned 25-log load, then cut and bank375 shafts. Each child closes its client before the next opens.
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Session} from '../packages/core/src/inprocess';
type Run={exit:number;output:string};
export type WoodProcessingJob={tree:'normal'|'oak'|'willow'|'maple'|'yew'|'magic';product:'shortbow'|'longbow'|'burn';string:boolean;finish:'bank'|'drop';maximum:number;minimumHP:number;cap:number;reserve:number};
type WoodRunner={run:(script:string,env:Record<string,string>,args?:string[])=>Promise<Run>;stopped:()=>boolean};
export function validateWoodProcessingJob(j:WoodProcessingJob){
 if(!j||!['normal','oak','willow','maple','yew','magic'].includes(j.tree)||!['shortbow','longbow','burn'].includes(j.product)||typeof j.string!=='boolean'||!['bank','drop'].includes(j.finish)||j.product==='burn'&&(j.string||j.finish==='drop')||!Number.isSafeInteger(j.maximum)||j.maximum<1||j.maximum>24||!Number.isSafeInteger(j.minimumHP)||j.minimumHP<10||j.minimumHP>99||!Number.isSafeInteger(j.cap)||j.cap<1000||j.cap>20000||!Number.isSafeInteger(j.reserve)||j.reserve<0)throw Error('invalid finite gathered wood processing');return j;
}
export async function waitWoodChild(child:{pid:number;exited:Promise<number>},o:{stop:()=>boolean;kill:(pid:number)=>Promise<unknown>;timeoutMs:number}){
 let interrupted=false,termination:Promise<unknown>|undefined;
 const cancel=()=>{if(!termination){interrupted=true;termination=o.kill(child.pid);}};
 const monitor=setInterval(()=>{if(o.stop())cancel();},50),deadline=setTimeout(cancel,o.timeoutMs);
 try{if(o.stop())cancel();const exit=await child.exited;await termination;return interrupted?1:exit;}finally{clearInterval(monitor);clearTimeout(deadline);await termination;}
}
export async function runWoodProcessingCycle(d:WoodRunner,value:WoodProcessingJob){
 const j=validateWoodProcessingJob(value),{inventoryRecipes}=await import('./microbot-production'),recipes=inventoryRecipes(),stem=(j.tree==='normal'?'':j.tree+'_')+j.product;
 const cut=j.product==='burn'?undefined:recipes.find(r=>r.name==='cut-bow:unstrung_'+stem),strung=j.string?recipes.find(r=>r.name==='bow-string:'+stem):undefined;
 if(j.product!=='burn'&&!cut||j.string&&!strung)throw Error('selected native bow recipe absent');
 let used=0,logsBanked=0,processed=0,stage='gather',failure='';const receipts:unknown[]=[];
 const call=async(script:string,env:Record<string,string>,args:string[]=[],reserve=0)=>{if(d.stopped()||j.cap-used-reserve<100)throw Error('wood composition stopped or stage budget absent');const result=await d.run(script,{...env,CAP:String(j.cap-used-reserve)},args);if(result.exit!==0||!/^RESULT ok\b/m.test(result.output)||!/^LOGOUT logged-out\s*$/m.test(result.output))throw Error('wood child failed '+script+' '+result.output.slice(-500));return result.output;};
 const credit=(r:any)=>{if(!Number.isSafeInteger(r?.ticks)||r.ticks<0||used+r.ticks>j.cap)throw Error('wood child tick receipt absent or exceeded');used+=r.ticks;receipts.push(r);};
 try{
  const text=await call('scripts/gather-yews.ts',{REGION:['normal','oak'].includes(j.tree)?'draynor':'seers',TREE:j.tree,...!['normal','oak'].includes(j.tree)?{WOOD_GROVE:'native-processing'}:{},MAX_TRIPS:'1',BANK_AT:String(j.maximum),MAX_MAKE:String(j.maximum)},[],600);
  const line=text.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)??'',n=Number(line.match(/\bbanked=(\d+)/)?.[1]),hp=Number(line.match(/\bhpMin=(\d+)/)?.[1]),ticks=Number(line.match(/\bticks=(\d+)/)?.[1]);
  if(n!==j.maximum||hp<j.minimumHP||!Number.isFinite(hp)||!line.includes('died=false'))throw Error('gathered banked count/HP receipt differs');credit({stage:'gather',ticks,banked:n,hpMin:hp});logsBanked=n;
  if(j.product==='burn'){stage='burn';const text=await call('scripts/firemaking-order.ts',{LOG:j.tree,BURN_ONLY:'1',PROGRESSIVE:'0',TARGET_LEVEL:'99',MAX_LOGS:String(j.maximum),TOOL_BUDGET:'0',CASH_RESERVE:'0'});const r=JSON.parse(text.match(/^FIREMAKING_ORDER_RESULT (.+)$/m)?.[1]??'null');if(!r?.ok||r.logsBurnt!==j.maximum)throw Error('gathered burn receipt incomplete');credit(r);processed=j.maximum;}
  else{
   for(const recipe of[cut!,...strung?[strung]:[]]){stage=recipe.name;const text=await call('scripts/microbot-production.ts',{MAX_MAKE:String(j.maximum),MAX_ATTEMPTS:String(j.maximum),RAW_RESERVE:String(j.reserve),INPUT_RESERVES:JSON.stringify(recipe===strung?{[cut!.product]:0}:{}),MEMBERS:'1'},[recipe.name],j.finish==='drop'?120:0);const r=JSON.parse(text.match(/^MICROBOT_PRODUCTION (.+)$/m)?.[1]??'null');if(!r?.ok||r.recipe!==recipe.name||r.attempts!==j.maximum||r.made!==j.maximum||r.banked!==j.maximum||r.losses!==0)throw Error('gathered bow exact production receipt incomplete');credit(r);}
   processed=j.maximum;
   if(j.finish==='drop'){stage='drop';const id=(strung??cut)!.product,text=await call('scripts/fletch-worker.ts',{},['--drop-product',String(id),String(j.maximum)]),r=JSON.parse(text.match(/^WOOD_PRODUCT_DROP (.+)$/m)?.[1]??'null');if(!r?.ok||!r.preserved||r.id!==id||r.dropped!==j.maximum)throw Error('declared produced bow drop unconfirmed');credit(r);}
  }
 }catch(e){failure=String(e);}
 return{ok:!failure&&!d.stopped(),stage,logsBanked,processed,finish:j.finish,ticks:used,receipts,failure,scope:'finite existing gather route followed by native bow/string/bank-or-drop or owned-line burn; no campfire or automatic tree-route discovery'};
}
export async function runWoodProductDrop(original:Session,id:number,amount:number,cap:number,stop:()=>boolean=()=>false){
 const [{BotActions},{waitUntil},{productionStopRequested}]=await Promise.all([import('../vendor/rs-sdk/sdk/actions'),import('../packages/core/src/ticks'),import('./microbot-c-lifetime')]);
 if(![id,amount,cap].every(Number.isSafeInteger)||id<0||amount<1||amount>24||cap<40||cap>20000)throw Error('invalid finite produced-item drop');
 const client=original.client as any,executor=client.executeBotAction,first=original.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,hp=original.sdk.getSkill('Hitpoints')?.level,plane=first?.level,started=original.tick();let ended=false,lost=false;void original.ended.then(()=>{ended=true;});
 const view=()=>original.sdk.getState(),pack=()=>original.sdk.getInventory(),count=()=>pack().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),gear0=JSON.stringify(original.sdk.getEquipment()),xp0=JSON.stringify(view()?.skills.map(k=>[k.name,k.experience]));
 const guard=()=>{const p=view()?.player;if(original.client!==client||client.executeBotAction!==executor)lost=true;if(lost||typeof executor!=='function'||ended||!first||!p||!Number.isSafeInteger(life)||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.isDead||p.level!==plane||!Number.isFinite(hp)||!(hp!>0)||original.sdk.getSkill('Hitpoints')?.level!==hp||original.sdk.getStateAge()>5000||original.tick()-started>=cap||productionStopRequested(original.name,stop)||JSON.stringify(original.sdk.getEquipment())!==gear0||JSON.stringify(view()?.skills.map(k=>[k.name,k.experience]))!==xp0)throw Error('produced-drop original life/owner/HP/XP/stop/cap changed');};
 const sdk=new Proxy(original.sdk,{get(t,k,r){const v=Reflect.get(t,k,r);return typeof v==='function'?function(...a:unknown[]){if(typeof k==='string'&&k.startsWith('send'))guard();return v.apply(r,a);}:v;}}),s={...original,sdk,bot:new BotActions(sdk)}as Session;
 const totals=(rows:readonly{id:number;count:number}[])=>{const out:Record<number,number>={};for(const i of rows)out[i.id]=(out[i.id]??0)+i.count;return out;},effect=(a:Record<number,number>,b:Record<number,number>,n:number)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>(b[+k]??0)-(a[+k]??0)===(+k===id?-n:0));
 const open=async()=>{guard();const generation=s.bankObservation?.()?.generation??-1;await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>{guard();return !view()?.bank.isOpen&&!view()?.interface.isOpen&&!view()?.dialog.isOpen;},{timeoutTicks:8}))throw Error('produced-drop modal closure unconfirmed');await s.bot.openBank();if(!await waitUntil(s,()=>{guard();return !!view()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation;},{timeoutTicks:12}))throw Error('produced-drop fresh bank absent');};
 const assets=()=>{const b=s.bankObservation?.();if(!view()?.bank.isOpen||!b)throw Error('produced-drop bank unknown');return totals([...pack(),...original.sdk.getEquipment(),...b.items]);};let dropped=0,uncertain=false,failure='',preserved=false;
 try{
  guard();if(count()!==0)throw Error('produced-drop requires target absent from starting pack');const native=client.objType?.(id);if(!native||native.certtemplate!==-1||native.stackable!==false)throw Error('produced-drop native unnoted bow identity absent');await open();const before=assets(),row=view()!.bank.items.find(i=>i.id===id);if(!row||row.count<amount||28-pack().length<amount)throw Error('produced-drop owned bank stock/space absent');const held=totals(pack()),stored=row.count,g=s.bankObservation!()!.generation;
  uncertain=true;await s.bot.withdrawItem(row,amount,{asNote:false});if(!await waitUntil(s,()=>{guard();return count()===amount&&(s.bankObservation?.()?.generation??-1)>g&&(s.bankObservation?.()?.items.find(i=>i.id===id)?.count??0)===stored-amount;},{timeoutTicks:10}))throw Error('produced-drop withdrawal unknown');if(!effect(held,totals(pack()),-amount)||!effect(before,assets(),0))throw Error('produced-drop withdrawal changed other assets');uncertain=false;
  await s.bot.closeBank();if(!await waitUntil(s,()=>{guard();return !view()?.bank.isOpen&&!view()?.interface.isOpen&&!view()?.dialog.isOpen;},{timeoutTicks:8}))throw Error('produced-drop inventory not ready');
  for(let n=0;n<amount;n++){guard();const item=pack().find(i=>i.id===id),custom=item?.optionsWithIndex?.filter(o=>o.opIndex===5)??[];if(!item||item.count!==1||custom.length>1||custom.some(o=>!/^drop$/i.test(o.text)))throw Error('produced-drop exact native slot absent');const prior=totals(pack());uncertain=true;try{await s.sdk.sendDropItem(item.slot);}catch{}if(!await waitUntil(s,()=>{guard();return effect(prior,totals(pack()),1);},{timeoutTicks:8}))throw Error('produced-drop exact effect unknown; no retry');uncertain=false;dropped++;}
  await open();preserved=effect(before,assets(),amount);if(!preserved)throw Error('produced-drop final whole-assets differ');await s.bot.closeBank();guard();
 }catch(e){failure=String(e);}
 return{ok:!failure&&!uncertain&&preserved&&dropped===amount,id,dropped,uncertain,preserved,ticks:original.tick()-started,failure};
}
export async function runFletchingCycle(d:{run:(script:string,env:Record<string,string>)=>Promise<Run>;stopped:()=>boolean;minimumHP:number}){
    const failure=(stage:string,detail:string)=>({ok:false,stage:/^RESULT fail (?:session ended:|login(?::| ))/.test(detail)?'disconnected':stage,logsBanked:0,shaftsBanked:0,detail});
    if(!Number.isSafeInteger(d.minimumHP)||d.minimumHP<10)return failure('prerequisite','known HP maximum required');
    if(d.stopped())return failure('stopped','stop file');
    const last=(r:Run)=>r.output.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).pop()??'no RESULT';
    const collect=await d.run('scripts/gather-yews.ts',{REGION:'draynor',TREE:'normal',MAX_TRIPS:'1',BANK_AT:'25',CAP:'1800',MAX_MAKE:'25'});
    const summary=last(collect),banked=Number(summary.match(/\bbanked=(\d+)/)?.[1]),hp=Number(summary.match(/\bhpMin=(\d+)/)?.[1]);
    if(collect.exit!==0||!/^RESULT ok\b/.test(summary)||!summary.includes('died=false')||banked!==25||!(hp>=d.minimumHP))
        return failure('gather',summary);
    if(d.stopped())return{...failure('stopped','stop file'),logsBanked:25};
    const craft=await d.run('scripts/fletch-arrows.ts',{MODE:'shafts',MAX_MAKE:'25',LOG_RESERVE:'0',BANK_KNIFE:'1',CAP:'600'});
    let report:any;try{report=JSON.parse(craft.output.match(/^SHAFT_BANK (.+)$/m)?.[1]??'null');}catch{}
    if(craft.exit!==0||!/^RESULT ok\b/.test(last(craft))||report?.ok!==true||report.logsUsed!==25||report.made!==375||report.banked!==375||report.preserved!==true||report.died!==false||report.damaged!==false||report.targetMet!==true||report.knifeStored!==true||!(report.hpMin>=d.minimumHP))
        return{...failure('shafts',last(craft)),logsBanked:25};
    return{ok:true,stage:'done',logsBanked:25,shaftsBanked:375,detail:'died=false'};
}

if(import.meta.main){
    const actor=process.argv[2]!;
    if(!/^[A-Za-z0-9_ -]{1,12}$/.test(actor??''))throw Error('invalid fletching account');
    const root=resolve(import.meta.dir,'..'),stopped=()=>existsSync(join(root,`.practice/stop-${actor}`));
    if(process.argv[3]==='--wood-job'||process.argv[3]==='--drop-product'){
        const {productionStopRequested}=await import('./microbot-c-lifetime');let signalled=false;process.once('SIGINT',()=>{signalled=true;});process.once('SIGTERM',()=>{signalled=true;});const stop=()=>productionStopRequested(actor,()=>signalled);
        try{
            if(process.argv[3]==='--drop-product'){
                const id=Number(process.argv[4]),amount=Number(process.argv[5]),cap=Number(process.env.CAP??200),{inventoryRecipes}=await import('./microbot-production');
                if(!inventoryRecipes().some(r=>(r.name.startsWith('cut-bow:')||r.name.startsWith('bow-string:'))&&r.product===id))throw Error('drop must name a canonical native bow product');
                const {openBot,settle}=await import('../packages/core/src/bot');const s=await openBot(actor,{onStop:async()=>{signalled=true;}});
                try{const r=await runWoodProductDrop(s,id,amount,cap,stop);console.log('WOOD_PRODUCT_DROP '+JSON.stringify(r));if(!await settle([s],r.ok,JSON.stringify(r)))process.exitCode=1;}catch(e){await settle([s],false,String(e));process.exitCode=1;}
            }else{
                const job=validateWoodProcessingJob(JSON.parse(readFileSync(resolve(process.argv[4]??''),'utf8'))),{killTree}=await import('../packages/practice/src/proc');
                const r=await runWoodProcessingCycle({stopped:stop,run:async(script,env,args=[])=>{
                    if(stop())return{exit:1,output:'RESULT fail stop file'};
                    const child=Bun.spawn(['bun',script,actor,...args],{cwd:root,env:{...process.env,...env},stdout:'pipe',stderr:'pipe',windowsHide:true});let output='';
                    const completion=waitWoodChild(child,{stop,kill:killTree,timeoutMs:Math.min(1500000,Number(env.CAP)*650+90000)});
                    const pump=async(stream:ReadableStream<Uint8Array>,error=false)=>{for await(const b of stream){const text=new TextDecoder().decode(b);if(!error)output+=text;(error?process.stderr:process.stdout).write(text);}};
                    const [exit]=await Promise.all([completion,pump(child.stdout),pump(child.stderr,true)]);return{exit,output};
                }},job);console.log('WOOD_PROCESSING '+JSON.stringify(r));console.log('RESULT '+(r.ok?'ok':'fail')+' '+JSON.stringify(r));process.exitCode=r.ok?0:1;
            }
        }catch(e){console.log('RESULT fail gathered wood '+String(e));process.exitCode=1;}
    }else try{
        const status=JSON.parse(readFileSync(join(root,`.practice/status/${actor}.json`),'utf8'));
        const result=await runFletchingCycle({minimumHP:status.hp?.max,stopped,run:async(script,env)=>{
            const p=Bun.spawn(['bun',script,actor],{cwd:root,env:{...process.env,...env},stdout:'pipe',stderr:'pipe',windowsHide:true});
            let output='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill();},script.includes('gather')?800000:280000);
            const pump=async(stream:ReadableStream<Uint8Array>,error=false)=>{for await(const b of stream){const text=new TextDecoder().decode(b);if(!error)output+=text;(error?process.stderr:process.stdout).write(text);}};
            await Promise.all([pump(p.stdout),pump(p.stderr,true)]);const exit=await p.exited;clearTimeout(timer);
            return{exit:timedOut?1:exit,output:output+(timedOut?'\nRESULT fail no fletching progress: child deadline':'')};
        }});
        console.log(`RESULT ${result.ok?'ok':result.stage==='stopped'?'fail stop file':result.stage==='disconnected'?'fail session ended:':'fail no fletching progress:'} cycle ${JSON.stringify(result)}`);
        process.exitCode=result.ok?0:1;
    }catch(e){console.log('RESULT fail no fletching progress: cycle '+String(e));process.exitCode=1;}
}
