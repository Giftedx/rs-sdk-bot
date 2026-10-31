import { openQuest } from './quest-lib';
import type { Session } from '../../packages/core/src/inprocess';
import { questFlags } from '../../packages/core/src/quest-status';

const HETTY = { x: 2968, z: 3206 };
const RATS = { x: 2957, z: 3203 };
const CAULDRON = { id: 2024, x: 2967, z: 3205 };
const TAIL = 300;

// The parent passes its session and owns logout. Direct/quest-sweep entry retains openQuest cleanup.
export async function completeHetty(s:Session,cap:number,stop:()=>boolean=()=>false){
 const q=await openQuest({session:s,cap,stop,food:[],eatAt:0,lumbridgeOk:true});
 try{return await executeHetty(q);}finally{await q.dispose();}
}
export async function executeHetty(q:Awaited<ReturnType<typeof openQuest>>){
 const flag=()=>questFlags(q.s.client)?.find(f=>f.name==="Witch's Potion")?.state??'unknown';
 if(!await q.waitUntil(()=>flag()!=='unknown'&&Array.isArray(q.st()?.inventory),20))throw Error('Hetty entry unobserved');
 if(flag()==='complete')throw Error('quest already complete');
 const before=[1957,221,2146,300].map(id=>q.cnt(id));
 if(before.slice(0,3).some(n=>n<1))throw Error('Hetty ingredients missing');
    const hetty = /^hetty$/i;

    // 1. "I am in search of a quest.", "Yes help me become one with my darker side." sets 1 (hetty.rs2:40-83).
    if(flag()==='not started')await q.talk('hetty 1', hetty, [/in search of a quest/i, /yes help me become one/i], () => flag()==='started', HETTY);
    q.milestone(1);

    // 2. One rat in the house next door; its tail drops on its tile. Both houses have a shut door (loc_1530): Hetty's in
    // her west wall at 2965,3206, the rat house's in its north wall at 2956,3205 (maps/m46_50.jm2). Shut, the attack
    // click cannot route (opRejected, 96 idle ticks in a trial).
    if(!q.has(TAIL)){
    await q.openDoor('hetty door', 2965, 3206);
    await q.dash('rat house', 2956, 3206, 0);
    await q.openDoor('rat door', 2956, 3205);
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const tailOnGround = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === TAIL);
    for (let t = 0; t < 120 && !q.has(TAIL); t++) {
        await q.guard('rat');
        const g = tailOnGround();
        if (g) {
            if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
        } else {
            const rat = q.npc(/^rat$/i);
            if (!rat) { if (t % 10 === 0) await q.dash('to rats', RATS.x, RATS.z, 3); }
            else if (t % 4 === 0 && q.pos()?.targetIndex !== rat.index) await attack(rat);
        }
        await q.waitTicks(1);
    }
    if (!q.has(TAIL)) await q.fail('no rat tail');
    q.milestone('tail');
    }

    // 3. The hand-in sets 2 (hetty.rs2:13-26).
    await q.openDoor('rat door out', 2956, 3205);
    await q.openDoor('hetty door in', 2965, 3206);
    const tailBeforeHandin=q.cnt(TAIL);
    await q.talk('hetty 2', hetty, [], () => q.cnt(TAIL)===tailBeforeHandin-1, HETTY);
    q.milestone(2);

    // 4. Drink from the cauldron (quest_hetty.rs2:1-4).
    await q.step('cauldron', () => q.opLoc(CAULDRON, 1), () => flag()==='complete', 10, 4);
    if(!await q.converse([], () => !q.dialogOpen(), 10))throw Error('Hetty final dialogue still open');
    q.milestone(3);
    if(!await q.waitUntil(()=>flag()==='complete'&&[1957,221,2146].every((id,i)=>q.cnt(id)===before[i]!-1)&&q.cnt(TAIL)===Math.max(0,before[3]!-1),15))throw Error('Hetty completion or ingredient deltas unobserved');
    return {ok:true as const,detail:'Hetty complete; four ingredient debits observed'};
}
if(import.meta.main||(globalThis as {QUEST_SESSION?:Session}).QUEST_SESSION){
 const q=await openQuest({cap:Number(process.env.CAP??600),food:[],eatAt:0,lumbridgeOk:true});
 try{const r=await executeHetty(q);await q.end(r.ok,r.detail);}catch(e){await q.fail(String(e));}
}
