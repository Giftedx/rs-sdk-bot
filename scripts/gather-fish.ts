// Catherby Fisher: catches Lobsters (Cage) or Swordfish/Tuna (Harpoon) at Catherby beach (2838,3431)
// and banks at Catherby Bank (2809,3441).
// Usage: bun scripts/gather-fish.ts <botName> [method: cage | harpoon, default cage] [CAP ticks, default 15000]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyNpc } from '../vendor/rs-sdk/sdk/types';

// Pinned rev289 npc.pack 322=0_44_53_memberfish; memberfish.rs2 opnpc3.
export function sharkSpot(n: { id: number; name: string; optionsWithIndex: readonly { text: string; opIndex: number }[] }) {
    return n.id === 322 && /^fishing spot$/i.test(n.name)
        && n.optionsWithIndex.some(o => o.opIndex === 1 && /^net$/i.test(o.text))
        && n.optionsWithIndex.some(o => o.opIndex === 3 && /^harpoon$/i.test(o.text));
}

// Diagnostic only: never treat an animation or a dispatched packet as a catch,
// a live server action, or a failed RNG roll. The public state has no action_delay
// or p_opnpc queue. Keep that boundary unknown until a retained CLI trace exists.
export function sharkFishingTrace(s: Session, emit: (row: unknown) => void = row => console.log('SHARK_FISH_TRACE '+JSON.stringify(row))) {
    const key = (m: {observationId?:number;tick:number;type:number;text:string}) => JSON.stringify([m.observationId??null,m.tick,m.type,m.text]);
    // Do not consume the SDK's shared chat cursor or log player/PM messages.
    const seen = new Set<string>();
    const remember = (messages: {observationId?:number;tick:number;type:number;text:string}[]) => {
        for(const m of messages)if(m.type===0)seen.add(key(m));
        // At most the SDK's500-message history; never retain player/PM text.
        while(seen.size>500)seen.delete(seen.values().next().value!);
    };
    const npc = (n: NearbyNpc) => ({index:n.index,id:n.id,name:n.name,x:n.x,z:n.z,tileX:n.tileX??null,tileZ:n.tileZ??null,
        distance:n.distance,reachable:n.reachable??null,options:n.optionsWithIndex.map(o=>({...o}))});
    let selected: ReturnType<typeof npc> | undefined,failed=false;
    const traceFailed = (error: unknown) => {
        if(failed)return;failed=true;
        // A diagnostic failure must neither mask the original cause nor stop
        // other onTick listeners. Report once; absent trace is not evidence.
        try{console.warn('SHARK_FISH_TRACE_ERROR '+String(error));}catch{}
    };
    try{remember(s.sdk.getState()?.gameMessages??[]);}catch(error){traceFailed(error);}
    const record = (event: string, detail?: unknown) => {
        if(failed)return;
        try{
        const st=s.sdk.getState(),p=st?.player;
        const messages=(st?.gameMessages??[]).filter(m=>!seen.has(key(m))&&m.type===0).map(m=>({tick:m.tick,observationId:m.observationId??null,text:m.text}));
        remember(st?.gameMessages??[]);
        const fishing=s.sdk.getSkill('Fishing');
        // Wall time joins this client row to the engine diagnostic's map_clock rows.
        emit({event,at:Date.now(),tick:s.tick(),stateTick:st?.tick??null,revision:st?.revision??null,stateAgeMs:s.sdk.getStateAge?.()??null,
            account:s.name,player:p?{name:p.name,x:p.worldX,z:p.worldZ,level:p.level,hp:p.hp,animId:p.animId,spotanimId:p.spotanimId}:null,
            selected:selected??null,currentSelected:st?.nearbyNpcs.find(n=>n.index===selected?.index)?npc(st.nearbyNpcs.find(n=>n.index===selected?.index)!):null,
            candidates:(st?.nearbyNpcs??[]).filter(sharkSpot).map(npc),
            rawSharks:s.sdk.getInventory().filter(i=>i.id===383).reduce((n,i)=>n+i.count,0),
            slots:s.sdk.getInventory().length,harpoons:s.sdk.getInventory().filter(i=>i.id===311).reduce((n,i)=>n+i.count,0),
            fishing:fishing?{level:fishing.level,baseLevel:fishing.baseLevel,xp:fishing.experience}:null,
            opFeedback:st?.opFeedback?{...st.opFeedback}:null,dialog:st?.dialog?{isOpen:st.dialog.isOpen}:null,
            actionSettlement:'unknown',messages,detail:detail??null});
        }catch(error){traceFailed(error);}
    };
    return {record,select(n: NearbyNpc){if(!failed)try{selected=npc(n);}catch(error){traceFailed(error);}}};
}

// Pinned memberfish.rs2 attempt_fish_shark: an op3 that arrives while %action_delay is
// 1-3 or 5 ticks ahead (or equal) returns without p_opnpc, so a repeat click ends a
// running harpoon action. Only a fresh start or the +4 phase prints this message.
const SHARK_START = /^You start Harpooning fish\.$/;
const messageKey = (m: {observationId?:number;tick:number;type:number;text:string}) => JSON.stringify([m.observationId??null,m.tick,m.type,m.text]);
// A confirmed action is left alone while it animates. fish_shark replays anim(human_harpoon)
// on every roll, one roll per6 ticks (%action_delay +5, then the equal phase). Native
// cWx27l: longest animId -1 run while the server action kept rolling was3 ticks;
// a48-tick time watchdog re-click landed at phase3 and dropped two live actions (9 idle ticks each).
// After7 ticks without the harpoon animation %action_delay is stale, so a re-dispatch starts fresh.
// A re-dispatch that lands mid-cycle prints no start message and is retried after the window.
export const SHARK_HARPOON_ANIM = 618, SHARK_IDLE_TICKS = 7, SHARK_START_REFUSALS = 3;
// fishing.struct shark success_high40 at Fishing99: stat_random gives41/256 per6-tick roll.
// (215/256)^70 < 5e-6, so a 420-tick gap is a stall, not bad luck. cWx27l failed the old
// 160-tick bound with22 live misses ((215/256)^22 = 2.2%).
export const SHARK_PROGRESS_TICKS = 420;

// Caller owns travel, banking, budget and logout. Never counts tuna/swordfish.
export async function catchSharks(s: Session, amount: number, stop: () => boolean, progressTicks = SHARK_PROGRESS_TICKS) {
    const count = () => s.sdk.getInventory().filter(i => i.id === 383).reduce((n, i) => n + i.count, 0);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 27) throw Error('invalid shark batch');
    if ((s.sdk.getSkill('Fishing')?.level ?? 0) < 76) throw Error('sharks require Fishing76');
    if (!s.sdk.getInventory().some(i => i.id === 311)) throw Error('sharks require harpoon');
    const before = count(); let last = before, progress = s.tick();
    // The NPC the server confirmed with a start message. Cleared when it moves, vanishes or stalls.
    let active: {index:number;x:number;z:number;at:number} | undefined, refusals = 0;
    const same = (n: NearbyNpc, a: {index:number;x:number;z:number}) => n.index === a.index && n.x === a.x && n.z === a.z && sharkSpot(n);
    const trace=sharkFishingTrace(s);
    trace.record('begin',{amount,before,progressTicks,idleTicks:SHARK_IDLE_TICKS});
    // Consecutive observed ticks without the harpoon animation.
    let still = 0;
    const offStill=s.onTick(()=>{still = s.sdk.getState()?.player?.animId === SHARK_HARPOON_ANIM ? 0 : still + 1;});
    const off=s.onTick(()=>trace.record('tick'));
    try { while (count() - before < amount) {
        if (stop()) throw Error('shark fishing budget/health stop');
        if (s.sdk.getInventory().length >= 28) throw Error('shark fishing full pack');
        if (s.tick() - progress >= progressTicks) throw Error('shark fishing no progress');
        const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
        // No wait outlasts the unchanged progress deadline.
        const until = (end: number) => Math.max(1, Math.min(end, progress + progressTicks) - s.tick());
        if (active) {
            const a = active;
            if (!npcs.some(n => same(n, a))) { trace.record('spot-lost',a); active = undefined; continue; }
            await waitUntil(s, st => stop() || count() > last || still >= SHARK_IDLE_TICKS || !st.nearbyNpcs.some((n: NearbyNpc) => same(n, a)), { timeoutTicks: until(progress + progressTicks) });
            if (count() > last) { last = count(); progress = s.tick(); a.at = s.tick(); }
            else if (still >= SHARK_IDLE_TICKS) { trace.record('action-ended',{...a,still}); active = undefined; }
            continue;
        }
        const spot = npcs.filter(sharkSpot).sort((a,b) => a.distance-b.distance)[0];
        if (!spot) { await waitTicks(s, 1); continue; }
        const x = spot.x, z = spot.z, seen = new Set((s.sdk.getState()?.gameMessages ?? []).map(messageKey));
        const started = () => (s.sdk.getState()?.gameMessages ?? []).some(m => m.type === 0 && SHARK_START.test(m.text) && !seen.has(messageKey(m)));
        trace.select(spot);trace.record('dispatch',{option:3,last,progress,refusals});
        const reply=await s.sdk.sendInteractNpc(spot.index, 3);
        trace.record('dispatch-reply',reply);
        // The server walks first when the spot is not adjacent. The window always outlasts %action_delay.
        await waitUntil(s, st => stop() || started() || !st.nearbyNpcs.some((n: NearbyNpc) => same(n, {index:spot.index,x,z})), { timeoutTicks: until(s.tick() + 8 + Math.min(20, Math.ceil(spot.distance))) });
        const moved = !(s.sdk.getState()?.nearbyNpcs ?? []).some(n => same(n, {index:spot.index,x,z}));
        // A catch can land on the dispatch tick (the equal phase) without a running action.
        if (count() > last) { last = count(); progress = s.tick(); refusals = 0; }
        if (started() && !moved) { active = {index:spot.index,x,z,at:s.tick()}; still = 0; refusals = 0; trace.record('started',active); }
        else if (!moved && !stop() && ++refusals >= SHARK_START_REFUSALS) throw Error('shark fishing dispatch refused');
        else trace.record('unstarted',{moved,refusals});
    }
    trace.record('complete',{caught:count()-before});
    return { caught: count() - before };
    } catch(error) {
        trace.record('failure',{cause:String(error),caught:count()-before,last,progress,progressTicks});
        throw error;
    } finally { off(); offStill(); }
}

const CATHERBY_BANK = { x: 2809, z: 3441 };
const BEACH_SPOT = { x: 2838, z: 3432 };

if (import.meta.main) {
const botName = process.argv[2] ?? 'Mightyrod';
const method = (process.argv[3] ?? process.env.METHOD ?? 'cage').toLowerCase();
const CAP = Number(process.argv[4] ?? process.env.CAP ?? 15000);
const BANK_AT = Number(process.argv[5] ?? process.env.BANK_AT ?? 27);

const isCage = method === 'cage';
const requiredTool = isCage ? /lobster pot/i : /harpoon/i;
const targetOp = isCage ? 'Cage' : 'Harpoon';

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitUntil(s, st => (st?.inGame ?? false) && (st?.player !== null) && (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const fishCount = () => inv().filter(i => /raw (lobster|swordfish|tuna)/i.test(i.name)).reduce((n, i) => n + i.count, 0);
    const freeSpace = () => 28 - inv().length;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let caughtTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async () => {
        await walk(CATHERBY_BANK.x, CATHERBY_BANK.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }

        const currentFish = fishCount();
        if (currentFish > 0) {
            caughtTotal += currentFish;
            // Deposit all fish
            for (const item of inv()) {
                if (/raw (lobster|swordfish|tuna)/i.test(item.name)) {
                    await s.bot.depositItem(item.name, -1);
                }
            }
        }

        // Ensure we have the required tool
        if (!inv().some(i => requiredTool.test(i.name))) {
            const toolName = isCage ? 'Lobster pot' : 'Harpoon';
            console.log(`Withdrawing ${toolName}...`);
            await s.bot.withdrawItem(requiredTool, 1);
            // No tool in the pack or the bank: stop now instead of banking for the whole cap.
            if (!await waitUntil(s, () => inv().some(i => requiredTool.test(i.name)), { timeoutTicks: 5 }))
                await finish([s], false, `no ${toolName} in the pack or the bank`);
        }

        await waitTicks(s, 1);
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} caughtTotal=${caughtTotal} bankTrips=${bankTrips}`);
    };

    console.log(`START gather-fish ${botName} method=${method} at=${pos()?.worldX},${pos()?.worldZ}`);

    while (!over()) {
        if (fishCount() >= BANK_AT || freeSpace() === 0 || !inv().some(i => requiredTool.test(i.name))) {
            await bank();
            continue;
        }

        // Walk to fishing beach
        const p = pos();
        if (!p || Math.max(Math.abs(p.worldX - BEACH_SPOT.x), Math.abs(p.worldZ - BEACH_SPOT.z)) > 12) {
            await walk(BEACH_SPOT.x, BEACH_SPOT.z, 3);
            continue;
        }

        // Find fishing spot NPC
        const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
        const spot = npcs.find(n => /fishing spot/i.test(n.name) && n.options.includes(targetOp));

        if (!spot) {
            await waitTicks(s, 3);
            continue;
        }

        const invBefore = inv().length;
        const opt = spot.optionsWithIndex.find(o => new RegExp(`^${targetOp}$`, 'i').test(o.text));
        if (!opt) {
            await waitTicks(s, 2);
            continue;
        }

        await s.sdk.sendInteractNpc(spot.index, opt.opIndex);

        // Wait for catch or spot relocation
        for (let t = 0; t < 15 && !over(); t++) {
            await waitTicks(s, 1);
            if (inv().length > invBefore || freeSpace() === 0) break;
            // If spot moved
            if (!s.sdk.getState()?.nearbyNpcs.some(n => n.index === spot.index)) break;
        }
    }

    const total = caughtTotal + fishCount();
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], total > 0, `ticks=${used()} totalCaught=${total} banked=${caughtTotal} held=${fishCount()} bankTrips=${bankTrips} fishPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
}
