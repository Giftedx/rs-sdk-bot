export type Tile={x:number;z:number;level:number};
export type FishingProtection={prayer:14;potionsPerUnit:1|2|3;maximumDoses:number;antifire?:true};
export type Heat='range'|'fire';

export interface BankRouteJob{
 family:string;
 recipe:string;
 target:number;
 batch:number;
 cap:number;
 returnTicks:number;
 members:boolean;
 reserve?:number;
 bank?:Tile;
 site?:Tile;
 heat?:Heat;
 alchemyTarget?:string;
 tool?:number;
 xpRate?:number;
 fishingProtection?:FishingProtection;
}

export interface BankProfile{
 inputs:Record<number,number>;
 tools:number[];
 outputs:number[];
 capacityOutputs?:Record<number,number>;
 bank:Tile;
 site:Tile;
 prepare?:(stop:()=>boolean)=>Promise<void>;
 deferBankRecovery?:()=>boolean;
 run:(n:number,cap:number,stop:()=>boolean)=>Promise<void|number>;
}

export function bankTravelTolerance(family:string,productionSite:boolean):number{
 return productionSite&&['cooking','magic-npc'].includes(family)?0:2;
}

export function validateBankRouteJob(j:BankRouteJob):void{
 if(typeof j.family!=='string'||!j.family||typeof j.recipe!=='string'||!j.recipe||typeof j.members!=='boolean'||![j.target,j.batch,j.cap,j.returnTicks].every(v=>Number.isSafeInteger(v)&&v>0)||j.cap<=j.returnTicks||!Number.isSafeInteger(j.reserve??0)||(j.reserve??0)<0)throw Error('invalid finite bank job');
 if(j.family==='fishing'&&j.recipe==='lava'&&j.fishingProtection?.antifire!==true)throw Error('Lava requires declared melee and antifire protection');
 if(j.fishingProtection!==undefined){const p=j.fishingProtection;if(j.family!=='fishing'||!p||p.prayer!==14||(!Number.isSafeInteger(p.potionsPerUnit)||p.potionsPerUnit<1||p.potionsPerUnit>3)||!Number.isSafeInteger(p.maximumDoses)||p.maximumDoses<1||p.maximumDoses>40||p.antifire!==undefined&&(p.antifire!==true||j.recipe!=='lava'))throw Error('invalid finite fishing protection');}
 if(j.xpRate!==undefined&&(!Number.isSafeInteger(j.xpRate)||j.xpRate<1||j.xpRate>1000))throw Error('invalid declared XP rate');
 if(j.target>2147483647||j.batch>2147483647||j.cap>100000)throw Error('bank job exceeds native count or tick limits');
 for(const p of [j.bank,j.site])if(p&&(![p.x,p.z,p.level].every(Number.isSafeInteger)||p.level<0||p.level>3||p.x<0||p.x>16383||p.z<0||p.z>16383))throw Error('invalid bank/site tile');
}

export function fittingBankBatch(inputs:Record<number,number>,tools:number[],maximum:number,freeSlots:number,stackable:(id:number)=>boolean,outputs:Record<number,number>={}):number{
 const slots=(items:Record<number,number>,n:number)=>{const ids=new Set([...Object.keys(items).map(Number),...tools]);let count=0;for(const id of ids){const units=(items[id]??0)*n+(tools.includes(id)?1:0);count+=stackable(id)?1:units;}return count;};
 let lower=0,upper=maximum;
 while(lower<upper){
  const n=Math.ceil((lower+upper)/2);
  if(Math.max(slots(inputs,n),slots(outputs,n))<=freeSlots)lower=n;
  else upper=n-1;
 }
 return lower;
}

// Pre-flight bank-trip planner: calculates exact batch size, number of trips, required stock per input, and shortfalls.
export function planBankTripSchedule(options:{
 target:number;
 inputs:Record<number,number>;
 tools:number[];
 outputs?:Record<number,number>;
 bankStock:Readonly<Record<number,number>>;
 reserve?:number;
 freeSlots?:number;
 stackable?:(id:number)=>boolean;
}){
 const freeSlots=options.freeSlots??28,reserve=options.reserve??0,stackable=options.stackable??(()=>false);
 const perTrip=fittingBankBatch(options.inputs,options.tools,options.target,freeSlots,stackable,options.outputs);
 if(perTrip<1)throw Error('bank schedule cannot fit a single unit in available slots');
 const missingTools=options.tools.filter(id=>(options.bankStock[id]??0)<1);
 const requiredInputs:Record<number,number>={},shortfalls:Record<number,number>={};
 let feasibleUnits=options.target;
 for(const [rawId,units] of Object.entries(options.inputs)){
  const id=Number(rawId),need=units*options.target+reserve,have=options.bankStock[id]??0;
  requiredInputs[id]=need;
  if(have<need)shortfalls[id]=need-have;
  const canMake=Math.max(0,Math.floor((have-reserve)/units));
  feasibleUnits=Math.min(feasibleUnits,canMake);
 }
 return {
  perTrip,
  tripsNeeded:Math.ceil(options.target/perTrip),
  feasibleUnits,
  feasibleTrips:Math.ceil(feasibleUnits/perTrip),
  missingTools,
  requiredInputs,
  shortfalls,
  ready:missingTools.length===0&&Object.keys(shortfalls).length===0,
 };
}
