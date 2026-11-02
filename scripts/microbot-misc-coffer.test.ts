import {test,expect} from 'bun:test';
import {depositMiscCoffer,cofferText,cofferDepositEffect,MISC_COFFER,miscResourceText,miscResourceEffect} from './microbot-misc-coffer';
function fixture(o:{coffers?:number;resources?:boolean;member?:number;swapLife?:boolean;publicReceipt?:boolean;stopAtCount?:boolean;choiceLag?:number;collect?:boolean;badCredit?:boolean;crowded?:boolean}={}){
 let tick=0,modal=-1,countOpen=false,phase='',coffers=o.coffers??1000,observations=0,buttons=0,submits=0,no=0,talks=0;
 const inventory=[{id:995,count:5000,slot:0},{id:2357,count:2,slot:1}],equipment=[{id:1381,count:1,slot:3}],dialogs:any[]=[],messages:any[]=[],player={worldX:2499,worldZ:3856,level:1,lifeId:1,respawnCount:0,isDead:false};
 if(o.crowded)for(let i=0;i<20;i++)inventory.push({id:10000+i,count:1,slot:2+i});
 let delivery:{at:number;dialog:any}|undefined;let dialog:any={isOpen:false,options:[],isWaiting:false};
 const text=(value:string)=>{dialogs.push({tick,observationId:++observations,text:[value]});dialog={isOpen:true,options:[{index:1,text:'Click here to continue'}],isWaiting:false};};
 const state=()=>({player,inventory,equipment,dialog,recentDialogs:dialogs,gameMessages:messages,nearbyNpcs:[{id:1375,index:7,distance:1,reachable:true}],skills:[{name:'Hitpoints',level:50,baseLevel:50,experience:1000}]});
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{let active=true;queueMicrotask(()=>{if(active){tick++;if(delivery&&tick>=delivery.at){dialog=delivery.dialog;delivery=undefined;}cb();}});return()=>{active=false;};},client:{ingame:true,membersAccount:o.member??1,getModalInterface:()=>modal,isChatBackInputOpen:()=>countOpen,ifType:(id:number)=>id===MISC_COFFER.balance?{text:String(coffers)}:{colour:0x00f800}},sdk:{getState:state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkill:()=>({level:50}),getDialog:()=>dialog,sendCloseModal:async()=>{modal=-1;countOpen=false;dialog={isOpen:false,options:[],isWaiting:false};return{success:true};},sendInteractNpc:async(index:number,op:number)=>{expect([index,op]).toEqual([7,1]);talks++;phase='greeting';text('Greetings, Your Royal Highness.');return{success:true};},sendClickDialog:async(index:number)=>{const old=dialog,lag=phase==='choice'?(o.choiceLag??0):0;
  if(phase==='greeting'){phase='choice';dialog={isOpen:true,isWaiting:false,options:[{index:1,text:'How is the Kingdom faring?'},{index:2,text:'How do I manage the kingdom?'}]};}
  else if(phase==='choice'){expect(index).toBe(1);phase=o.resources?'resource-intro':'distribution';text(o.resources?'Would you like to collect the resources gathered by your subjects?':'This is how your subjects are distributing their effort.');}
  else if(phase==='resource-intro'){phase='resource-choice';dialog={isOpen:true,isWaiting:false,options:[{index:1,text:'Yes'},{index:2,text:'No'}]};}
  else if(phase==='resource-choice'){if(o.collect){expect(index).toBe(1);inventory.push({id:1518,count:o.badCredit?8:9,slot:2});inventory.push({id:254,count:1,slot:3});inventory.push({id:268,count:1,slot:4});phase='resources';text('9 Maple Logs|2 Herbs');}else{expect(index).toBe(2);no++;phase='distribution';text('This is how your subjects are distributing their effort.');}}
  else if(phase==='resources'){phase='distribution';text('This is how your subjects are distributing their effort.');}
  else if(phase==='distribution'||phase==='added'){modal=MISC_COFFER.interface;dialog={isOpen:false,options:[],isWaiting:false};phase='manage';}
  else if(phase==='prompt'){countOpen=true;dialog={isOpen:false,options:[],isWaiting:false};}
  else throw Error('unexpected dialog '+phase);if(lag){delivery={at:tick+lag,dialog};dialog=old;}return{success:true};},sendClickComponent:async(id:number)=>{expect(id).toBe(MISC_COFFER.deposit);buttons++;modal=-1;phase='prompt';text('You are carrying 5000 coins. Enter an amount to deposit in the coffers.');return{success:true};},sendCountDialog:async(value:number)=>{submits++;countOpen=false;inventory[0]!.count-=value;coffers+=value;if(o.swapLife)player.lifeId=2;phase='added';if(o.publicReceipt){messages.push({type:2,observationId:++observations,tick,text:'Added '+value+' coins to the coffers.'});modal=MISC_COFFER.interface;dialog={isOpen:false,options:[],isWaiting:false};}else text('Added '+value+' coins to the coffers.');return{success:true};}}};
 s.sdk.clickDialogByText=async(re:RegExp)=>{const option=dialog.options.find((v:any)=>re.test(v.text));if(!option)return{success:false};return s.sdk.sendClickDialog(option.index);};
 return{s,inventory,player,counts:()=>({buttons,submits,no,talks}),stop:()=>!!o.stopAtCount&&countOpen};
}
test('only canonical native balance text and exact two-sided coin transfer qualify',()=>{
 expect(cofferText('500,000')).toBeUndefined();expect(cofferText('1234')).toBe(1234);expect(cofferText('5000001')).toBeUndefined();
 expect(cofferDepositEffect(100,1000,900,4999900,5000000)).toBe(true);expect(cofferDepositEffect(101,1000,900,4999900,5000000)).toBe(false);
});
test('Ghrim resource path chooses No and deposits exactly once with coffer and stock receipts',async()=>{
 const f=fixture({resources:true});const r=await depositMiscCoffer(f.s,1234,100);expect(r).toMatchObject({ok:true,submitted:true,coinsSpent:1234,cofferBefore:1000,cofferAfter:2234,preserved:true,pending:false});expect(f.counts()).toEqual({buttons:1,submits:1,no:1,talks:1});expect(f.inventory[1]!.count).toBe(2);
});

test('deposit waits for its fresh prompt while the distribution page is still published',async()=>{
 const f=fixture(),state=f.s.sdk.getState,dialog=f.s.sdk.getDialog,click=f.s.sdk.sendClickComponent;let until=-1,old:any[]=[];
 f.s.sdk.getState=()=>{const value=state();return f.s.tick()<until?{...value,recentDialogs:old}:value;};
 f.s.sdk.getDialog=()=>f.s.tick()<until?{isOpen:true,isWaiting:false,options:[{index:1,text:'Click here to continue'}]}:dialog();
 f.s.sdk.sendClickComponent=async(id:number)=>{old=[...state().recentDialogs];const r=await click(id);until=f.s.tick()+3;return r;};
 const r=await depositMiscCoffer(f.s,1234,100);expect(r.ok).toBe(true);expect(f.counts().buttons).toBe(1);expect(f.counts().submits).toBe(1);expect(r.coinsSpent).toBe(1234);
});

test('a paid deposit waits for fresh Added text and the exact balance publication without another submission',async()=>{
 const f=fixture(),state=f.s.sdk.getState,dialog=f.s.sdk.getDialog,submit=f.s.sdk.sendCountDialog;let until=-1,old:any[]=[];
 f.s.sdk.getState=()=>{const value=state();return f.s.tick()<until?{...value,recentDialogs:old}:value;};
 f.s.sdk.getDialog=()=>f.s.tick()<until?{isOpen:true,isWaiting:false,options:[{index:1,text:'Click here to continue'}]}:dialog();
 f.s.sdk.sendCountDialog=async(amount:number)=>{old=[...state().recentDialogs];const r=await submit(amount);until=f.s.tick()+3;return r;};
 const r=await depositMiscCoffer(f.s,1234,100);expect(r.ok).toBe(true);expect(r.cofferAfter).toBe(2234);expect(f.counts().submits).toBe(1);expect(r.pending).toBe(false);
});
test('capacity clamp is refused before deposit button or amount packet',async()=>{
 const f=fixture({coffers:4999990});const r=await depositMiscCoffer(f.s,20,80);expect(r.ok).toBe(false);expect(r.detail).toContain('capacity');expect(f.counts().buttons).toBe(0);expect(f.counts().submits).toBe(0);expect(f.inventory[0]!.count).toBe(5000);
});
test('unknown membership and insufficient owned funds never start Ghrim dialogue',async()=>{
 const f=fixture({member:0});await expect(depositMiscCoffer(f.s,100,80)).rejects.toThrow('member');expect(f.counts().talks).toBe(0);
 const g=fixture();await expect(depositMiscCoffer(g.s,5001,80)).rejects.toThrow('owned');expect(g.counts().talks).toBe(0);
});
test('stop at count prompt never dispatches an amount',async()=>{
 const f=fixture({stopAtCount:true});const r=await depositMiscCoffer(f.s,100,80,f.stop);expect(r.ok).toBe(false);expect(r.submitted).toBe(false);expect(f.counts().submits).toBe(0);expect(f.inventory[0]!.count).toBe(5000);
});
test('cached original-life mutation after submit cannot qualify and never triggers retry',async()=>{
 const f=fixture({swapLife:true});const r=await depositMiscCoffer(f.s,100,80);expect(r.ok).toBe(false);expect(r.detail).toContain('life changed');expect(r.submitted).toBe(true);expect(f.counts().submits).toBe(1);
});
test('public chat cannot replace the private native addition receipt',async()=>{
 const f=fixture({publicReceipt:true});const r=await depositMiscCoffer(f.s,100,20);expect(r.ok).toBe(false);expect(f.counts().submits).toBe(1);
});

test('a dispatched Ghrim choice waits for published retirement instead of reinterpreting the stale menu',async()=>{
 const f=fixture({resources:true,choiceLag:3});const r=await depositMiscCoffer(f.s,1234,100);expect(r.ok).toBe(true);expect(f.counts()).toEqual({buttons:1,submits:1,no:1,talks:1});
});

test('native resource report audits exact noted credits and aggregated random herbs',()=>{
 expect(miscResourceText('9 Maple Logs|2 Herbs')).toEqual({'Maple Logs':9,Herbs:2});expect(miscResourceText('9 Maple Logs|garbage')).toBeUndefined();
 const before=new Map([[995,50000]]),after=new Map([[995,50000],[1518,9],[254,1],[268,1]]);
 expect(miscResourceEffect(before,after,'9 Maple Logs|2 Herbs')).toEqual({1518:9,254:1,268:1});expect(miscResourceEffect(before,after,'8 Maple Logs|2 Herbs')).toBeUndefined();
 after.set(995,49999);expect(miscResourceEffect(before,after,'9 Maple Logs|2 Herbs')).toBeUndefined();
});
test('declared collection consumes one Yes then deposits with exact resource receipts',async()=>{
 const f=fixture({resources:true,collect:true,choiceLag:3}),r=await depositMiscCoffer(f.s,1234,100,()=>false,{collectResources:true});
 expect(r).toMatchObject({ok:true,collectionSubmitted:true,collectionConfirmed:true,collectionCredits:{1518:9,254:1,268:1},coinsSpent:1234,pending:false});expect(f.counts()).toEqual({buttons:1,submits:1,no:0,talks:1});
});
test('resource credit mismatch preserves pending attribution and never deposits or repeats Yes',async()=>{
 const f=fixture({resources:true,collect:true,badCredit:true}),r=await depositMiscCoffer(f.s,1234,100,()=>false,{collectResources:true});expect(r.ok).toBe(false);expect(r.collectionPending).toBe(true);expect(r.pending).toBe(true);expect(f.counts().submits).toBe(0);expect(f.counts().talks).toBe(1);
});
test('collection refuses missing capacity before destructive native resource generation',async()=>{
 const f=fixture({resources:true,collect:true,crowded:true}),r=await depositMiscCoffer(f.s,1234,100,()=>false,{collectResources:true});expect(r.ok).toBe(false);expect(r.collectionSubmitted).toBe(false);expect(r.detail).toContain('note slots');expect(f.inventory.some(i=>i.id===1518)).toBe(false);
});
