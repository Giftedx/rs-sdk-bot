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
 targetLevel?:number;
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
 if(j.targetLevel!==undefined&&(!['cooking','wine'].includes(j.family)||!Number.isSafeInteger(j.targetLevel)||j.targetLevel<1||j.targetLevel>99))throw Error('invalid bank cooking level target');
 if(j.target>2147483647||j.batch>2147483647||j.cap>100000)throw Error('bank job exceeds native count or tick limits');
 for(const p of [j.bank,j.site])if(p&&(![p.x,p.z,p.level].every(Number.isSafeInteger)||p.level<0||p.level>3||p.x<0||p.x>16383||p.z<0||p.z>16383))throw Error('invalid bank/site tile');
}

export function fittingBankBatch(inputs:Record<number,number>,tools:number[],maximum:number,freeSlots:number,stackable:(id:number)=>boolean,outputs:Record<number,number>={}):number{
 const slots=(items:Record<number,number>,n:number)=>{const ids=new Set([...Object.keys(items).map(Number),...tools]);let count=0;for(const id of ids){const units=(items[id]??0)*n+(tools.includes(id)?1:0);if(units>0)count+=stackable(id)?1:units;}return count;};
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
 const tools=new Set(options.tools),missingTools=[...tools].filter(id=>(options.bankStock[id]??0)<1);
 const requiredInputs:Record<number,number>={},shortfalls:Record<number,number>={};
 let feasibleUnits=missingTools.length?0:options.target;
 for(const [rawId,units] of Object.entries(options.inputs)){
  if(!Number.isFinite(units)||units<0)throw Error('invalid bank schedule input unit count');
  const id=Number(rawId),retained=tools.has(id)?1:0,need=units*options.target+reserve+retained,have=options.bankStock[id]??0;
  requiredInputs[id]=need;
  if(have<need)shortfalls[id]=need-have;
  const canMake=units===0?(have>=reserve+retained?options.target:0):Math.max(0,Math.floor((have-reserve-retained)/units));
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

// Server reads up to 5 USER_EVENT inputs per tick (NetworkPlayer.ts:70). Bank slots never shift while open
// (bank.rs2: ~reorganize_inv runs only on openbank/closebank) and inventory slots never shift on deposit, so up to
// BANK_BATCH_MAX preset-button (1, 5, 10, -1/All) withdrawals or deposits execute in a single tick with zero sleeps.
export const BANK_BATCH_MAX = 5;
export const isInstantBankAmount = (amount: number): boolean => amount === 1 || amount === 5 || amount === 10 || amount === -1;

export interface FastBankSession {
 tick(): number;
 sdk: { getState(): any };
 onTick(cb: () => void): () => void;
 direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
 bot?: { openBank?(): Promise<{ success: boolean; message?: string }>; closeBank?(): Promise<unknown> };
 ended?: Promise<{ reason: string }>;
}

// Ensures the bank interface is open without redundant openBank() calls when already open.
export async function ensureBankOpen(s: FastBankSession): Promise<{ ok: boolean; opened: boolean; message?: string }> {
 if (s.sdk.getState()?.bank?.isOpen) return { ok: true, opened: false };
 if (typeof s.bot?.openBank !== 'function') return { ok: false, opened: false, message: 'openBank unavailable' };
 const r = await s.bot.openBank();
 return { ok: r.success === true, opened: r.success === true, ...(r.message ? { message: r.message } : {}) };
}

function countById(rows: readonly { id: number; count: number }[] | undefined, id: number): number {
 if (!Array.isArray(rows)) return 0;
 let total = 0;
 for (let i = 0; i < rows.length; i++) {
  const row = rows[i]!;
  if (row.id === id) total += row.count;
 }
 return total;
}

// Batches up to BANK_BATCH_MAX instant bank withdrawals per tick (amounts 1, 5, 10, or -1 for all) without
// sleeping between items in the same tick. Non-preset amounts (requiring p_countdialog) run individually.
export async function withdrawBatchFast(
 s: FastBankSession,
 requests: readonly { id: number; amount: number }[],
 waitUntilFn: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>,
 options: { timeoutTicks?: number } = {},
): Promise<{ ok: boolean; withdrawn: Record<number, number>; ticks: number; missing?: number }> {
 const start = s.tick(), timeoutTicks = options.timeoutTicks ?? 6;
 const withdrawn: Record<number, number> = {};
 if (!requests.length) return { ok: true, withdrawn, ticks: 0 };
 const state0 = s.sdk.getState();
 if (!state0?.bank?.isOpen) return { ok: false, withdrawn, ticks: s.tick() - start };
 // Build O(N) id -> slot map once: bank slots stay stable while open.
 const byId = new Map<number, { slot: number; id: number; count: number }>();
 const bankItems: { slot: number; id: number; count: number }[] = state0.bank.items ?? [];
 for (let i = 0; i < bankItems.length; i++) {
  const row = bankItems[i]!;
  if (!byId.has(row.id)) byId.set(row.id, row);
 }
 for (const req of requests) {
  if (!byId.has(req.id)) return { ok: false, withdrawn, ticks: s.tick() - start, missing: req.id };
 }
 let i = 0;
 while (i < requests.length) {
  const batch: { id: number; slot: number; amount: number; before: number; expectedMin: number }[] = [];
  const curInv = s.sdk.getState()?.inventory;
  if (isInstantBankAmount(requests[i]!.amount)) {
   const seenIds = new Set<number>();
   while (i < requests.length && batch.length < BANK_BATCH_MAX && isInstantBankAmount(requests[i]!.amount) && !seenIds.has(requests[i]!.id)) {
    const req = requests[i]!;
    const row = byId.get(req.id)!;
    const before = countById(curInv, req.id);
    const expectedMin = req.amount === -1 ? 1 : Math.min(req.amount, row.count);
    seenIds.add(req.id);
    batch.push({ id: req.id, slot: row.slot, amount: req.amount, before, expectedMin });
    i++;
   }
  } else {
   const req = requests[i]!;
   const row = byId.get(req.id)!;
   batch.push({ id: req.id, slot: row.slot, amount: req.amount, before: countById(curInv, req.id), expectedMin: Math.min(req.amount, row.count) });
   i++;
  }
  await Promise.all(batch.map(b => s.direct({ type: 'bankWithdraw', slot: b.slot, amount: b.amount, reason: 'SDK' }).catch(() => undefined)));
  const settled = await waitUntilFn(() => {
   const inv = s.sdk.getState()?.inventory;
   for (let k = 0; k < batch.length; k++) {
    const b = batch[k]!;
    if (countById(inv, b.id) < b.before + b.expectedMin) return false;
   }
   return true;
  }, timeoutTicks);
  const invAfter = s.sdk.getState()?.inventory;
  for (const b of batch) withdrawn[b.id] = (withdrawn[b.id] ?? 0) + Math.max(0, countById(invAfter, b.id) - b.before);
  if (!settled) return { ok: false, withdrawn, ticks: s.tick() - start };
 }
 return { ok: true, withdrawn, ticks: s.tick() - start };
}

// Batches up to BANK_BATCH_MAX instant bank deposits (-1/1/5/10) per tick without sleeping between items.
export async function depositBatchFast(
 s: FastBankSession,
 requests: readonly { id: number; amount?: number }[],
 waitUntilFn: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>,
 options: { timeoutTicks?: number } = {},
): Promise<{ ok: boolean; deposited: Record<number, number>; ticks: number }> {
 const start = s.tick(), timeoutTicks = options.timeoutTicks ?? 6;
 const deposited: Record<number, number> = {};
 if (!requests.length) return { ok: true, deposited, ticks: 0 };
 if (!s.sdk.getState()?.bank?.isOpen) return { ok: false, deposited, ticks: s.tick() - start };
 let i = 0;
 while (i < requests.length) {
  const curInv: { slot: number; id: number; count: number }[] = s.sdk.getState()?.inventory ?? [];
  const slotById = new Map<number, number>();
  for (let k = 0; k < curInv.length; k++) if (!slotById.has(curInv[k]!.id)) slotById.set(curInv[k]!.id, curInv[k]!.slot);
  const batch: { id: number; slot: number; amount: number; before: number }[] = [];
  const seenIds = new Set<number>();
  while (i < requests.length && batch.length < BANK_BATCH_MAX) {
   const req = requests[i]!;
   const amount = req.amount ?? -1;
   if (batch.length > 0 && (!isInstantBankAmount(amount) || seenIds.has(req.id))) break;
   const slot = slotById.get(req.id);
   i++;
   if (slot === undefined) continue;
   const before = countById(curInv, req.id);
   if (before <= 0) continue;
   seenIds.add(req.id);
   batch.push({ id: req.id, slot, amount, before });
   if (!isInstantBankAmount(amount)) break;
  }
  if (!batch.length) continue;
  await Promise.all(batch.map(b => s.direct({ type: 'bankDeposit', slot: b.slot, amount: b.amount, reason: 'SDK' }).catch(() => undefined)));
  const settled = await waitUntilFn(() => {
   const inv = s.sdk.getState()?.inventory;
   for (let k = 0; k < batch.length; k++) {
    const b = batch[k]!;
    const expectedAfter = b.amount === -1 ? 0 : Math.max(0, b.before - b.amount);
    if (countById(inv, b.id) > expectedAfter) return false;
   }
   return true;
  }, timeoutTicks);
  const invAfter = s.sdk.getState()?.inventory;
  for (const b of batch) deposited[b.id] = (deposited[b.id] ?? 0) + Math.max(0, b.before - countById(invAfter, b.id));
  if (!settled) return { ok: false, deposited, ticks: s.tick() - start };
 }
 return { ok: true, deposited, ticks: s.tick() - start };
}
