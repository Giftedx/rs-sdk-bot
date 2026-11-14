// Universal Rune & Pure Essence Gatherer:
// Mines Rune essence (and Pure essence from Mining 30+ on supported worlds) via Aubury teleport and banks at Varrock East.
// Usage: bun scripts/gather-essence.ts <bot> [CAP ticks, default 15000] [BANK_AT essence, default 28]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, randomEventsOf, sessionDied } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import { existsSync,readFileSync } from 'node:fs';
import {resolve} from 'node:path';
import {eligiblePickaxe} from './microbot-b-mining';
import {depositObserved} from '../packages/core/src/deposit';

const BANK_SPOT = { x: 3253, z: 3420 };
const AUBURY_OUTSIDE = { x: 3253, z: 3398 };
const AUBURY_INSIDE = { x: 3253, z: 3402 };
const SHOP_DOOR = { x: 3253, z: 3399 };

// Known Rune Essence mine locations (LostCity rev 289 map zone 45_75)
const ESSENCE_ROCKS = [
    { x: 2891, z: 4847 },
    { x: 2893, z: 4812 },
    { x: 2925, z: 4848 },
    { x: 2927, z: 4814 }
];

const EXIT_PORTALS = [
    { x: 2885, z: 4850 },
    { x: 2889, z: 4813 },
    { x: 2932, z: 4854 },
    { x: 2933, z: 4815 }
];

const RUNE_ESSENCE = 1436;
const PURE_ESSENCE = 7936;
const ESSENCE_IDS = [RUNE_ESSENCE, PURE_ESSENCE];
const PICKAXES = [1275, 1271, 1273, 1269, 1267, 1265]; // Rune down to Bronze

// Retries are activity, not output. Bound a broken rock even when clicks succeed.
const refusedPickWields=new WeakMap<Session,Set<number>>();
let nativePickWieldLevels:Map<number,number>|undefined;
export function essencePickWieldLevel(id:number){
 if(!nativePickWieldLevels){const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),pack=new Map(readFileSync(resolve(root,'pack/obj.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])]as const]:[];}));nativePickWieldLevels=new Map();
  for(const tier of[1,5,20,30,40])for(const m of readFileSync(resolve(root,'scripts/levelrequire/scripts/tier'+tier+'.rs2'),'utf8').matchAll(/\[opheld2,(\w+_pickaxe)\]\s*@levelrequire_attack\((\d+),/g)){const item=pack.get(m[1]!);if(item!==undefined)nativePickWieldLevels.set(item,Number(m[2]));}
  const bronze=pack.get('bronze_pickaxe'),tier1=readFileSync(resolve(root,'scripts/levelrequire/scripts/tier1.rs2'),'utf8'),tutorial=readFileSync(resolve(root,'scripts/tutorial/scripts/tutorial.rs2'),'utf8');if(bronze!==undefined&&tier1.includes('[opheld2,bronze_pickaxe] @tutorial_island_equip(last_slot);')&&/@levelrequire_attack\(1,\s*\$slot\)/.test(tutorial))nativePickWieldLevels.set(bronze,1);
 }return nativePickWieldLevels.get(id);
}
// Native Mining eligibility/rate comes from the existing pickaxe table consumer.
// Called only during the worker's own bank visit; never buys or discards a tool.
export async function upgradeOwnedEssencePick(s:Session,o:{openBank:()=>Promise<void>;stop:()=>boolean}){
 const p=s.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,hp0=s.sdk.getSkill('Hitpoints')?.level??0;
 const stop=()=>{const at=s.sdk.getState()?.player;return o.stop()||!at||at.isDead||at.lifeId!==life||(at.respawnCount??0)!==respawns||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0||hp0<1;};
 if(stop())throw Error('essence pick upgrade stopped');await o.openBank();
 if(!await waitUntil(s,()=>stop()||!!s.bankObservation?.(),{timeoutTicks:10})||stop()||!s.sdk.getState()?.bank.isOpen)throw Error('essence pick bank observation absent');
 const state=s.sdk.getState()!,bank=s.bankObservation!()!,candidate=eligiblePickaxe({...state,inventory:[...s.sdk.getInventory(),...bank.items.filter(i=>i.count>0)],equipment:s.sdk.getEquipment()});
 if(!candidate)throw Error('no eligible owned native pickaxe');
 const inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),count=(id:number,rows:readonly{id:number;count:number}[])=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const totals=()=>{const b=s.bankObservation?.();if(!b||!s.sdk.getState()?.bank.isOpen)throw Error('essence pick current bank receipt missing');const m=new Map<number,number>();for(const i of [...inv(),...eq(),...b.items])m.set(i.id,(m.get(i.id)??0)+i.count);return m;},before=totals(),weapon=eq().find(i=>i.slot===3);
 if(!inv().some(i=>i.id===candidate.id)&&!eq().some(i=>i.slot===3&&i.id===candidate.id)){
  if(inv().length>=28||stop())throw Error('essence pick upgrade needs one free slot');const item=state.bank.items.find(i=>i.id===candidate.id),old=s.bankObservation!()!,held=count(candidate.id,inv()),stored=count(candidate.id,old.items);
  if(!item)throw Error('owned upgrade pick missing from observed bank');await s.bot.withdrawItem(item,1,{asNote:false});
  const matched=()=>{const b=s.bankObservation?.();return !!b&&b.generation>old.generation&&count(candidate.id,inv())===held+1&&count(candidate.id,b.items)===stored-1;};
  if(!await waitUntil(s,()=>stop()||matched(),{timeoutTicks:10})||stop()||!matched())throw Error('essence upgrade withdrawal does not reconcile');
 }
 const requiredAttack=essencePickWieldLevel(candidate.id),attack=s.sdk.getSkill('Attack')?.baseLevel,refused=refusedPickWields.get(s)??new Set<number>();refusedPickWields.set(s,refused);
 if(!eq().some(i=>i.slot===3&&i.id===candidate.id)&&(!weapon||PICKAXES.includes(weapon.id))&&requiredAttack!==undefined&&attack!==undefined&&attack>=requiredAttack&&!refused.has(candidate.id)){
  if(stop())throw Error('essence stopped before pick equip');const item=inv().find(i=>i.id===candidate.id);if(!item)throw Error('owned pick vanished');const generation=s.bankObservation!()!.generation;
  await s.bot.closeBank();if(!await waitUntil(s,()=>stop()||!s.sdk.getState()?.bank.isOpen&&!s.bankObservation?.(),{timeoutTicks:8})||stop()||s.sdk.getState()?.bank.isOpen)throw Error('essence upgrade bank close unobserved');
  // SDK equip dismisses modal UI. A closed bank has no bankObservation receipt.
  try{await s.bot.equipItem(item);}catch{/* Observe once; never retry this uncertain wield in the same session. */}
  if(!eq().some(i=>i.slot===3&&i.id===candidate.id))refused.add(candidate.id);
  if(stop())throw Error('essence stopped after wield');await o.openBank();
  if(!await waitUntil(s,()=>stop()||!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:12})||stop()||!s.sdk.getState()?.bank.isOpen||!s.bankObservation?.()||(s.bankObservation?.()?.generation??-1)<=generation)throw Error('essence post-wield fresh bank absent');
 }
 if(stop())throw Error('essence pick upgrade stopped after dispatch');
 const worn=eq().some(i=>i.slot===3&&i.id===candidate.id);
 if(worn)for(const item of [...inv()].filter(i=>PICKAXES.includes(i.id)&&i.id!==candidate.id)){if(stop())throw Error('essence stopped before inferior pick bank');await depositObserved(s,item);}
 const after=totals();if([...new Set([...before.keys(),...after.keys()])].some(id=>(before.get(id)??0)!==(after.get(id)??0)))throw Error('essence pick upgrade changed owned assets');
 const active=eligiblePickaxe({...s.sdk.getState()!,inventory:inv(),equipment:eq()});if(active?.id!==candidate.id)throw Error('best owned eligible pick not active');
 console.log('ESSENCE_PICK '+JSON.stringify({id:candidate.id,worn,preserved:true}));return{id:candidate.id,worn,preserved:true};
}

export async function mineEssenceBatch(s: Session, o: {count:()=>number;full:()=>boolean;stop:()=>boolean;busy:()=>boolean;click:()=>Promise<unknown>;gain:(n:number)=>void}) {
    let held=o.count(), lastOutput=s.tick(), lastClick=s.tick();
    await o.click();
    while(!o.stop()&&!o.full()) {
        await waitTicks(s,2);
        const current=o.count();
        if(current>held){o.gain(current-held);lastOutput=s.tick();}
        held=current;
        if(o.stop())break;
        if(s.tick()-lastOutput>=60)throw Error('no essence progress: no observed output for60 ticks');
        if(o.busy())continue;
        if(s.tick()-Math.max(lastOutput,lastClick)>10){await o.click();lastClick=s.tick();}
    }
}

export function isEssence(id: number): boolean {
    return ESSENCE_IDS.includes(id);
}

type EssenceMessage = { text: string; tick: number; observationId?: number };
export function essenceTeleportProblem(inMine: boolean, messages: readonly EssenceMessage[], cursor: number): string | null {
    if (inMine) return null;
    const refused = messages.some(m => (m.observationId ?? m.tick) > cursor
        && /\bneed to have completed the rune mysteries quest to use this feature\b/i.test(m.text));
    return refused ? 'Rune Mysteries quest required: Aubury refused teleport' : 'Teleport to essence mine timed out';
}

export function dist(a: { x: number; z: number }, b: { worldX: number; worldZ: number } | { x: number; z: number }): number {
    const bx = 'worldX' in b ? b.worldX : b.x;
    const bz = 'worldZ' in b ? b.worldZ : b.z;
    return Math.max(Math.abs(a.x - bx), Math.abs(a.z - bz));
}

export async function runEssenceGatherer(s: Session, o: { cap: number; bankAt: number; maxTrips?:number; stop?: () => boolean }) {
    if(!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.bankAt)||o.bankAt<1||o.bankAt>28
        ||(o.maxTrips!==undefined&&(!Number.isSafeInteger(o.maxTrips)||o.maxTrips<1)))throw Error('invalid essence limits');
    const start = s.tick();
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const inv = () => s.sdk.getInventory();
    const eq = () => s.sdk.getEquipment();
    const miningLevel = () => s.sdk.getSkill('Mining')?.level ?? 1;
    const miningXp = () => s.sdk.getSkillXp('Mining') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;

    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const essenceCount = () => inv().filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
    const freeSlots = () => 28 - inv().length;

    let ended = false;
    let died = false;
    let totalMined = 0;
    let totalBanked = 0;
    let trips = 0;
    let failure = '';
    const initialEssence=essenceCount();
    let cleanupDeadline:number|undefined;

    void s.ended.then(() => { ended = true; });
    const over = () => ended || died || !!o.stop?.() || (cleanupDeadline===undefined?s.tick()-start>=o.cap:s.tick()>=cleanupDeadline);
    const observe=(action:string,phase:string)=>console.log('ESSENCE_ACTION '+JSON.stringify({at:Date.now(),tick:s.tick(),action,phase,
        position:pos()?{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}:null,hp:hp(),held:essenceCount(),trips,totalBanked,
        miningXp:miningXp(),bankOpen:st()?.bank?.isOpen,generation:s.bankObservation?.()?.generation,
        pickaxes:[...inv(),...eq()].filter(i=>PICKAXES.includes(i.id))}));
    const action=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
        observe(name,'start');try{const result=await work();observe(name,'end');return result;}
        catch(error){observe(name,'error');throw error;}
    };
    const active=()=>{if(over())throw Error('essence stopped; preserve observed load');};

    // A death is the server's (sessionDied): a blank state in a disconnect reads HP 0 and no position.
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });

    const isInMine = (): boolean => {
        const p = pos();
        return !!p && p.worldX >= 2880 && p.worldX <= 2945 && p.worldZ >= 4800 && p.worldZ <= 4865;
    };

    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
        const p = pos();
        if (p && dist({ x, z }, p) <= tol) return true;
        const walker = await sessionWalker(s);
        const r = await walkPath(walker, [{ x, z, tol }], { stop: over, maxTicks: 120 });
        return r.ok;
    };

    const openDoorIfNeeded = async () => {
        const door = (st()?.nearbyLocs ?? []).find(l =>
            Math.max(Math.abs(l.x - SHOP_DOOR.x), Math.abs(l.z - SHOP_DOOR.z)) <= 1 &&
            l.optionsWithIndex.some(o => /open/i.test(o.text))
        );
        if (door) {
            const op = door.optionsWithIndex.find(o => /open/i.test(o.text))!;
            await s.sdk.sendInteractLoc(door.x, door.z, door.id, op.opIndex);
            await waitTicks(s, 2);
        }
    };

    const openBank = async () => {
        active();await action('dismiss-bank-ui',()=>s.bot.dismissBlockingUI());active();
        if (!st()?.bank.isOpen) {
            const res = await action('open-bank',()=>s.bot.openBank());
            if (!res.success) throw new Error(`openBank failed: ${res.message}`);
            if(!await waitUntil(s, () => over()||!!st()?.bank.isOpen, { timeoutTicks: 15 })||!st()?.bank.isOpen)
                throw Error('essence bank open unobserved');
        }
        active();
    };

    const depositEssence = async () => {
        await openBank();
        if (!await waitUntil(s, () => over()||!!s.bankObservation?.(), { timeoutTicks: 10 }))
            throw new Error('no essence progress: deposit bank observation unavailable');
        active();
        const beforeBank = s.bankObservation!()!.items.filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
        const held = essenceCount();

        // A successful action alone does not prove a deposit. Observe both
        // sides, using the same fresh bank receipts as the owned-kit workers.
        const ids = new Set(inv().filter(i => !PICKAXES.includes(i.id)).map(i => i.id));
        for (const id of ids) {
            active();
            const item = inv().find(i => i.id === id), before = s.bankObservation?.();
            if (!item || !before) throw new Error(`no essence progress: deposit inputs unknown ${id}`);
            const amount = count(id), stored = before.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
            const matched=()=>{
                const receipt = s.bankObservation?.();
                return !!receipt && receipt.generation > before.generation && count(id) === 0
                    && receipt.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) === stored + amount;
            };
            if (!(await action('deposit-'+id,()=>s.bot.depositItem(item, -1))).success || !await waitUntil(s, () => over()||matched(), { timeoutTicks: 10 })||!matched())
                throw new Error(`no essence progress: deposit debit/credit unobserved ${id}`);
        }

        const afterBank = s.bankObservation!()!.items.filter(i => isEssence(i.id)).reduce((n, i) => n + i.count, 0);
        const bankedDelta = afterBank - beforeBank;
        if (bankedDelta !== held) throw new Error('no essence progress: deposit total mismatch');
        totalBanked += bankedDelta;
        if(bankedDelta>0)trips++;
        console.log(`ESSENCE_BANK trip=${trips} bankedDelta=${bankedDelta} totalBanked=${totalBanked} miningXp=${miningXp()}`);
        active();await action('close-bank',()=>s.bot.closeBank());
        if(!await waitUntil(s, () => over()||!st()?.bank.isOpen, { timeoutTicks: 5 })||st()?.bank.isOpen)
            throw Error('essence bank close unobserved');
        active();

    };

    const checkPickaxe = async () => {
        active();await upgradeOwnedEssencePick(s,{openBank,stop:over});active();
        await action('close-upgrade-bank',()=>s.bot.closeBank());
        if(!await waitUntil(s,()=>over()||!st()?.bank.isOpen,{timeoutTicks:5})||over()||st()?.bank.isOpen)throw Error('essence pick bank close unobserved');
    };
    const teleportToMine = async () => {
        // Walk to shop entrance and open door if closed
        await walk(AUBURY_OUTSIDE.x, AUBURY_OUTSIDE.z, 2);
        await openDoorIfNeeded();
        await walk(AUBURY_INSIDE.x, AUBURY_INSIDE.z, 2);

        let aubury = (st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553);
        if (!aubury) {
            await waitUntil(s, () => !!(st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553), { timeoutTicks: 10 });
            aubury = (st()?.nearbyNpcs ?? []).find(n => /aubury/i.test(n.name) || n.id === 553);
        }
        if (!aubury) throw new Error('Aubury not found in shop');

        // Check for right-click Teleport (opIndex 3 or option matching teleport)
        const opt = aubury.optionsWithIndex.find(o => /teleport/i.test(o.text));
        const opIndex = opt?.opIndex ?? 3;
        const cursor = Math.max(-1, ...(st()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
        await s.sdk.sendInteractNpc(aubury.index, opIndex);

        await waitUntil(s, () => {
            if (isInMine()) return true;
            // Check if dialog opened
            const d = s.sdk.getDialog();
            if (d?.isOpen) {
                const optEss = d.options.find(o => /teleport me to the rune essence/i.test(o.text));
                if (optEss) {
                    void s.sdk.sendClickDialog(optEss.index);
                } else {
                    void s.sdk.sendClickDialog(0);
                }
            }
            return isInMine() || over();
        }, { timeoutTicks: 25 });

        // Position proves success. Old chat or a lamp's different quest message cannot undo an arrival.
        const problem = essenceTeleportProblem(isInMine(), st()?.gameMessages ?? [], cursor);
        if (problem) throw new Error(problem);
    };

    const getClosestRock = () => {
        const p = pos();
        if (!p) return ESSENCE_ROCKS[0]!;
        let best = ESSENCE_ROCKS[0]!;
        let bestD = Infinity;
        for (const rock of ESSENCE_ROCKS) {
            const d = dist(rock, p);
            if (d < bestD) {
                bestD = d;
                best = rock;
            }
        }
        return best;
    };

    const getClosestPortal = () => {
        const p = pos();
        if (!p) return EXIT_PORTALS[0]!;
        let best = EXIT_PORTALS[0]!;
        let bestD = Infinity;
        for (const portal of EXIT_PORTALS) {
            const d = dist(portal, p);
            if (d < bestD) {
                bestD = d;
                best = portal;
            }
        }
        return best;
    };

    const exitMine = async () => {
        const first = getClosestPortal();
        const rest = EXIT_PORTALS.filter(p => p !== first).sort((a, b) =>
            dist(a, pos() ?? a) - dist(b, pos() ?? b)
        );
        const portals = [first, ...rest];
        for (const targetPortal of portals.slice(0, 2)) {
            const walked = await walk(targetPortal.x, targetPortal.z, 2);
            if (!walked) continue;
            let portalLoc = (st()?.nearbyLocs ?? []).find(l =>
                (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10
            );
            if (!portalLoc) {
                await waitUntil(s, () => !!(st()?.nearbyLocs ?? []).find(l =>
                    (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10
                ), { timeoutTicks: 15 });
                portalLoc = (st()?.nearbyLocs ?? []).find(l =>
                    (l.id === 2492 || /blankrunestone_exit_portal|portal/i.test(l.name)) && dist(targetPortal, l) <= 10
                );
            }
            if (!portalLoc) continue;
            const opt = portalLoc.optionsWithIndex.find(o => /use|enter|exit|step/i.test(o.text));
            const opIndex = opt?.opIndex ?? 0;
            await s.sdk.sendInteractLoc(portalLoc.x, portalLoc.z, portalLoc.id, opIndex);
            const exited = await waitUntil(s, () => !isInMine() || over(), { timeoutTicks: 25 });
            if (exited && !isInMine()) return;
            if (over()) break;
        }
        const locs = (st()?.nearbyLocs ?? []).map(l => `${l.name}#${l.id}@${l.x},${l.z}`).join(';');
        throw new Error(`no essence progress: mine exit incomplete; nearby: ${locs}`);
    };

    const mineEssence = async () => {
        const targetRock = getClosestRock();
        await walk(targetRock.x, targetRock.z, 2);

        const rockLoc = (st()?.nearbyLocs ?? []).find(l =>
            (l.id === 2491 || /blankrunestone|rune essence/i.test(l.name)) && dist(targetRock, l) <= 6
        );
        if (!rockLoc) throw new Error('Rune essence rock not found in range');

        const opt = rockLoc.optionsWithIndex.find(o => /mine/i.test(o.text));
        const opIndex = opt?.opIndex ?? 0;

        await mineEssenceBatch(s,{count:essenceCount,full:()=>freeSlots()===0||essenceCount()>=o.bankAt,stop:over,
            busy:()=>!!randomEventsOf(s)?.busy(),click:()=>s.sdk.sendInteractLoc(rockLoc.x,rockLoc.z,rockLoc.id,opIndex),
            gain:n=>{totalMined+=n;}});
    };

    // A full load may reach the cap on its return leg. Finish that same trip
    // under a bounded cleanup budget; never turn a cancelled walk into a deposit.
    const bankLoad = async () => {
        cleanupDeadline = s.tick() + 300;
        try {
            if (isInMine()) await exitMine();
            if (over() || !await walk(BANK_SPOT.x, BANK_SPOT.z, 2))
                throw Error('no essence progress: final bank route incomplete');
            if (inv().some(i => !PICKAXES.includes(i.id))) await depositEssence();
            if (over() || essenceCount() > 0) throw Error('no essence progress: final load not banked');
            if(s.tick()-start<o.cap&&(o.maxTrips===undefined||trips<o.maxTrips))await action('check-pickaxe',checkPickaxe);
            active();
        } finally { cleanupDeadline = undefined; }
    };

    try {
        console.log(`ESSENCE_START level=${miningLevel()} xp=${miningXp()} cap=${o.cap}`);
        
        const initialTrips=trips;
        if (!isInMine() || freeSlots() === 0) await action('initial-bank-load',bankLoad);
        while (!over() && (o.maxTrips===undefined||trips-initialTrips<o.maxTrips)) {
            if (freeSlots() === 0 || essenceCount() >= o.bankAt) {
                await action('bank-load',bankLoad);
            } else {
                if (!isInMine()) {
                    await action('teleport',teleportToMine);
                }
                await action('mine',mineEssence);
            }
        }
        // A tick cap stops production, not its in-flight server action. Leave
        // the rock and bank the final observed load before declaring success.
        if(!ended&&!died&&!o.stop?.()&&(isInMine()||essenceCount()>0)){
            console.log('ESSENCE_CLEANUP cap');
            await action('cleanup-bank-load',bankLoad);
        }
    } catch (e) {
        failure = String(e);
        console.error(`ESSENCE_ERROR: ${failure}`);
    } finally {
        off();
    }

    // Includes an item published on the stop tick or during action cancellation.
    totalMined=totalBanked+essenceCount()-initialEssence;
    observe('return','end');

    return {
        ok: !failure && !died && !ended && !o.stop?.(),
        totalMined,
        totalBanked,
        held:essenceCount(),
        trips,
        died,
        failure: failure || '-'
    };
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) throw new Error('Account argument required');
    const cap = Number(process.env.CAP ?? 15000);
    const bankAt = Number(process.env.BANK_AT ?? 28);

    let stopped = false;
    const stopFile = `.practice/stop-${botName}`;
    const s = await openBot(botName, {
        onStop: async () => { stopped = true; }
    }).catch(e => finish([], false, `login ${String(e)}`));

    try {
        const r = await runEssenceGatherer(s, {
            cap,
            bankAt,
            stop: () => stopped || existsSync(stopFile)
        });
        await finish([s], r.ok, `essence ${JSON.stringify(r)}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
