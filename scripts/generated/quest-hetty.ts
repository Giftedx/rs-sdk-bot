import { openQuest } from './quest-lib';
import type { Session } from '../../packages/core/src/inprocess';
import { questFlags } from '../../packages/core/src/quest-status';

const HETTY = { x: 2968, z: 3206 };
const RATS = { x: 2957, z: 3203 };
const CAULDRON = { id: 2024, x: 2967, z: 3205 };
const TAIL = 300;

// Public observations only. A hit/XP gain is not a death or a tail credit.
export function observeHettyRat(q:Pick<Awaited<ReturnType<typeof openQuest>>, 's'|'st'|'cnt'>,phase:string,selectedIndex:number|null=null,reply?:unknown){
 const state=q.st(),p=state?.player;
 const observation={phase,tick:q.s.tick(),quest:questFlags(q.s.client)?.find(f=>f.name==="Witch's Potion")?.state??'unknown',
  selectedIndex,player:p?{x:p.worldX,z:p.worldZ,level:p.level,hp:p.hp,animId:p.animId,
   combat:p.combat??null,rootTargetIndex:p.targetIndex??null}:null,
  rats:(state?.nearbyNpcs??[]).filter((n:any)=>/^rat$/i.test(n.name)).map((n:any)=>({
   id:n.id,index:n.index,x:n.x,z:n.z,tileX:n.tileX,tileZ:n.tileZ,distance:n.distance,
   hp:n.hp,maxHp:n.maxHp,inCombat:n.inCombat,targetIndex:n.targetIndex,lastCombatTick:n.lastCombatTick,animId:n.animId})),
  tails:(state?.groundItems??[]).filter((g:any)=>g.id===TAIL).map((g:any)=>({id:g.id,x:g.x,z:g.z,count:g.count})),
  carriedTail:q.cnt(TAIL),bankTail:q.s.bankObservation?.()?.items.filter(i=>i.id===TAIL).reduce((n,i)=>n+i.count,0)??null,
  xp:Object.fromEntries(['Attack','Strength','Defence','Hitpoints'].map(k=>[k,q.s.sdk.getSkillXp(k)])),
  messages:(state?.gameMessages??[]).filter((m:any)=>m.type===0).slice(-4).map((m:any)=>m.text),reply};
 console.log('HETTY_RAT_OBSERVATION '+JSON.stringify(observation));
 return observation;
}

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
    const tailOnGround = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === TAIL);
    let selectedIndex:number|null=null,idleSince=0;
    for (let t = 0; t < 120 && !q.has(TAIL); t++) {
        observeHettyRat(q,'tick');
        await q.guard('rat');
        const g = tailOnGround();
        if (g) {
            if (t % 3 === 0) {
                observeHettyRat(q,'pickup');
                const reply=await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
                observeHettyRat(q,'pickup-reply',null,reply);
            }
        } else {
            // The target is nested under combat, not on player. Nearest-NPC order changes during a fight. One dispatch
            // per fight (attackNpc: the bow, the strikes or the hands), and a fight that ends with no tail on the ground
            // (a miss with the hands, a rat lost) frees the next dispatch after six ticks; death/drop processing (rat.rs2)
            // fits within that. Neither XP nor HP zero is a tail.
            const combat=q.pos()?.combat;
            if(combat?.targetType==='npc'&&combat.targetIndex>=0){selectedIndex??=combat.targetIndex;idleSince=t;}
            else if(selectedIndex!==null&&t-idleSince>=6)selectedIndex=null;
            // A strike does not repeat on its own: the engaged rat is attacked again every five ticks (the helper's cast
            // rate) until it dies; the bow and the hands keep fighting through the repeat.
            const engaged:any = selectedIndex!==null?(q.st()?.nearbyNpcs??[]).find((n:any)=>n.index===selectedIndex):null;
            const rat:any = selectedIndex===null?q.npc(/^rat$/i):null;
            if (engaged&&t % 5 === 0) await q.attackNpc(engaged);
            else if (selectedIndex===null&&!rat) { if (t % 10 === 0) await q.dash('to rats', RATS.x, RATS.z, 3); }
            else if (selectedIndex===null&&rat&&t % 4 === 0) {
                selectedIndex=rat.index;idleSince=t;
                observeHettyRat(q,'attack',rat.index);
                const reply=await q.attackNpc(rat);
                observeHettyRat(q,'attack-reply',rat.index,reply);
            }
        }
        await q.waitTicks(1);
    }
    observeHettyRat(q,'exit');
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
