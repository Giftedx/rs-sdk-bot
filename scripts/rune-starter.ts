import type {Session} from '../packages/core/src/inprocess';
import {getWorld,accountOf} from '../packages/core/src/bot';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {questFlags} from '../packages/core/src/quest-status';

export function runeSupplyAssets(items:readonly {id:number;count:number}[]){
 const totals:Record<number,number>={};for(const i of items)totals[i.id]=(totals[i.id]??0)+i.count;return totals;
}
export async function leaveRuneStarter(s:Session,stop:()=>boolean){
 const pos=()=>s.sdk.getState()?.player;
 if(!await waitUntil(s,()=>stop()||!!pos(),{timeoutTicks:30}))throw Error('starter position unobserved');
 if(stop())throw Error('stopped during starter exit');
 const p=pos()!;
 if(p.worldX>=3080&&p.worldX<=3105&&p.worldZ>=3080&&p.worldZ<=3125){
  // Pinned rs-sdk b565f2d: actions.ts skipTutorial handles late design, but
  // chooses options[0] on unknown choices and has an unbounded isWaiting loop.
  // Adapt only its observed-modal handling here. Keep exact guide choices and
  // tick cancellation. Client.ts exposes narration as BUTTON_CONTINUE (6).
  const start=s.tick(),deadline=start+100;
  let ended=false,designSent=false,talks=0,last='';
  void s.ended?.then(()=>{ended=true;});
  const observation=()=>{
   const state=s.sdk.getState(),p=pos();
   return {position:p?{worldX:p.worldX,worldZ:p.worldZ,level:p.level}:null,
    modalOpen:state?.modalOpen,modalInterface:state?.modalInterface,dialog:s.sdk.getDialog(),
    inventory:s.sdk.getInventory(),quest:questFlags(s.client)?.find(q=>q.name==='Rune Mysteries Quest')?.state??'unknown',
    messages:state?.gameMessages?.slice(-3)};
  };
  const record=()=>{const value=JSON.stringify(observation());if(value!==last){last=value;console.log('RUNE_SUPPLY_STARTER '+JSON.stringify({tick:s.tick(),...observation()}));}return value;};
  const check=()=>{if(stop())throw Error('stopped during starter exit');if(ended)throw Error('starter session ended');
   if(s.tick()>deadline)throw Error('starter entry deadline: action exceeded tick budget; '+last);};
  // tutorial_complete clears the pack, grants this exact kit and sends the
  // mainland quest list. %tutorial is server-only, so native saved-state proof
  // additionally requires its actual1000 flag. Neither SDK success nor Z alone
  // establishes this exit. Banked25 coins are checked by the native accountant.
  const grant=[[1351,1],[590,1],[303,1],[315,1],[1925,1],[1931,1],[2309,1],[1265,1],
   [1205,1],[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[555,6],[557,4],[559,2]] as const;
  const arrived=()=>{const p=pos();return !!p&&p.level===0&&p.worldX>=3200&&p.worldX<=3235&&p.worldZ>=3200&&p.worldZ<=3250;};
  const ready=()=>arrived()&&grant.every(([id,n])=>s.sdk.getInventory().filter(i=>i.id===id).reduce((a,i)=>a+i.count,0)===n)
   &&questFlags(s.client)?.some(q=>q.name==='Rune Mysteries Quest'&&q.state!=='unknown');
  while(true){
   const page=record();check();
   if(ready())break;
   if(s.tick()>=deadline)throw Error('starter entry deadline: mainland, tutorial grant or dialogue unobserved; '+last);
   const state=s.sdk.getState(),dialog=s.sdk.getDialog();
   let action:Awaited<ReturnType<typeof s.sdk.sendClickDialog>>|undefined;
   if(state?.modalOpen){
    if(state.modalInterface!==3559)throw Error('unsupported tutorial modal; '+last);
    if(!designSent){designSent=true;action=await s.sdk.sendAcceptCharacterDesign();}
   }else if(!arrived()&&dialog?.isOpen){
    if(!dialog.isWaiting){
     const yes=dialog.options.find(o=>/^yes please[.]?$/i.test(o.text));
     if(yes&&dialog.options.every(o=>/^(yes please|no, thank you)[.]?$/i.test(o.text)))action=await s.sdk.clickDialogByText(/^yes please[.]?$/i);
     else if(dialog.options.length===0||dialog.options.length===1&&dialog.options[0]!.buttonType===6)
      action=await s.sdk.sendClickDialog(0);
     else throw Error('unsupported tutorial choice; '+last);
    }
   }else if(!arrived()&&(designSent||s.tick()-start>=15)&&talks<3){
    const guide=state?.nearbyNpcs.find(n=>/^runescape guide$/i.test(n.name));
    const op=guide?.optionsWithIndex.find(o=>/^talk-to$/i.test(o.text));
    if(guide&&op){talks++;action=await s.sdk.sendInteractNpc(guide.index,op.opIndex);}
   }
   check();
   if(action&&!action.success){record();throw Error('starter action refused: '+JSON.stringify(action)+'; '+last);}
   await waitUntil(s,()=>stop()||ended||s.tick()>=deadline||JSON.stringify(observation())!==page,{timeoutTicks:Math.min(8,deadline-s.tick())});
  }
 }
 const current=pos()!;
 if(current.level!==0&&current.worldX>=3200&&current.worldX<=3225&&current.worldZ>=3200&&current.worldZ<=3235){
  const r=await goTo(s,await getWorld(),{x:3226,z:3250,level:0},accountOf(s),{legTimeoutTicks:100});
  if(!r.ok)throw Error('starter floor exit: '+JSON.stringify(r));
 }
 if(stop())throw Error('stopped during starter exit');
}

