// Hazeel Cult (good side): enter Ceril's house from the exterior south door, west of the Ardougne
// zoo. Ordinary quest-sweep accounts keep their combat kit. Reward: 1 QP, 1,500 Thieving XP before 25x, 2,005 coins
// (quest_hazeelcult.rs2:169-175).
// Varp %hazeelcultquest (223): 2 after Ceril (ceril_carnillean.rs2:8-31), 3 then 4 after Clivet when the bot refuses to
// join (clivet.rs2:147-158,228-272; side 0 = good), 6 when Alomone dies (alomone.rs2:100-123, he drops the armour), 7
// after the armour goes to Ceril upstairs (ceril_carnillean.rs2:108-139), complete after the cupboard search with Ceril
// and Jones near (quest_hazeelcult.rs2:84-122). %hazeelcult_valves (224): the raft goes to the hideout end only when all 5
// valve bits are set (quest_hazeelcult.rs2:11-70): valve 3 turns left, the other 4 turn right.
// The good side needs one raft trip; the evil side needs two hideout visits and the house chest, so it is longer.
import { openQuest } from './quest-lib';
import { questFlags } from '../../packages/core/src/quest-status';

type Entry = {
    lvl(): number;
    near(x: number, z: number, tolerance: number): boolean;
    npc(re: RegExp): { reachable?: boolean } | undefined;
    walk(label: string, points: {x:number;z:number;tol:number}[]): Promise<void>;
    openDoor(label: string, x: number, z: number): Promise<void>;
    waitUntil(f: () => boolean, ticks: number): Promise<boolean>;
    observeEntry?(stage: string): void;
    probeEntry?(): Promise<void>;
    fail(why: string): Promise<never>;
};
// m40_51.jm2: loc_1533 at 0_40_51_5_8, angle 3. Collision has a
// north/south wall between z=3271 and z=3272; distance alone cannot prove entry.
export async function enterCerilHouse(q: Entry): Promise<void> {
    const reachable = () => q.lvl() === 0 && q.npc(/^ceril carnillean$/i)?.reachable === true;
    q.observeEntry?.('before');
    if (q.near(2565, 3273, 0) && reachable()) return;
    await q.walk('Ceril exterior', [{x:2565,z:3271,tol:0}]);
    q.observeEntry?.('exterior');
    await q.openDoor('Ceril south door', 2565, 3272);
    q.observeEntry?.('door');
    await q.walk('Ceril interior', [{x:2565,z:3273,tol:0}]);
    q.observeEntry?.('interior');
    if (!await q.waitUntil(() => { q.observeEntry?.('waiting'); return reachable(); }, 12)) {
        q.observeEntry?.('deadline');
        await q.probeEntry?.();
        await q.fail('Ceril entry unreachable');
    }
}

const CERIL = { x: 2565, z: 3271 };
const CERIL_UP = { x: 2573, z: 3268 };
const VALVES = [
    { id: 2845, x: 2572, z: 3263, op: 2 },     // sewervalve2
    { id: 2844, x: 2562, z: 3247, op: 2 },     // sewervalve1
    { id: 2846, x: 2585, z: 3245, op: 1 },     // sewervalve3 turns left
    { id: 2847, x: 2597, z: 3263, op: 2 },     // sewervalve4
    { id: 2848, x: 2609, z: 3243, op: 2 },     // sewervalve5
];
const CAVE = { id: 2852, x: 2585, z: 3233 };          // -> 0_40_151_10_18 = 2570,9682
const RAFT = { id: 2849, x: 2567, z: 9679 };
const RAFT_END = { id: 2849, x: 2606, z: 9693 };      // any other raft -> 2567,9680
const CAVE_STAIRS = { id: 2853, x: 2570, z: 9683 };   // -> 0_40_50_27_37 = 2587,3237
const HOUSE_STAIRS = { x: 2568, z: 3268 };
const CUPBOARD = { x: 2573, z: 3267 };
const ITEM = { armour: 2405 };

async function main() {
const q = await openQuest({ cap: 3000, food: [385,379] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const dlg = (): string => { const d: any = q.s.sdk.getDialog(); return d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ') : ''; };
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 8); };
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];

    // Diagnostic only: snapshot the published route observation and one real OP dispatch.
    // NPC 885 spawns at 0_40_51_5_7; NPCs in this client list share the active scene plane.
    const observeEntry = (stage: string) => {
        const st = q.st(), client: any = q.s.client;
        const candidates = (st?.nearbyNpcs ?? []).filter((n: any) => n.id === 885 || /ceril|carnillean/i.test(n.name ?? ''));
        console.log('CERIL_ENTRY ' + JSON.stringify({stage, tick: st?.tick, revision: st?.revision,
            player: q.pos() && {x:q.pos().worldX,z:q.pos().worldZ,level:q.lvl()}, sceneLevel:client.minusedlevel,
            selected:q.npc(/^ceril carnillean$/i) ?? null,
            candidates:candidates.map((n: any) => {
                const entity = client.npc?.[n.index];
                return {...n, reachable:n.reachable ?? 'unknown',
                    route:entity ? {x:client.mapBuildBaseX + entity.routeX?.[0],z:client.mapBuildBaseZ + entity.routeZ?.[0]} : null};
            }), nearbyNames:(st?.nearbyNpcs ?? []).map((n:any)=>({id:n.id,index:n.index,name:n.name})),
            doors:q.locs().filter((l:any)=>l.x>=2563&&l.x<=2567&&l.z>=3269&&l.z<=3274),
            feedback:st?.opFeedback ?? null, dialog:q.s.sdk.getDialog()}));
    };
    // Resume: holding Carnillean's armour means steps 1-4 are done (quest varps are not sent to the client).
    if (!q.has(ITEM.armour)) {
    await enterCerilHouse({...q, observeEntry, probeEntry:async()=>{
        const n=q.npc(/^ceril carnillean$/i);
        if(!n){console.log('CERIL_PROBE '+JSON.stringify({outcome:'absent',tick:q.st()?.tick}));return;}
        const before=q.st()?.revision;
        const reply=await q.talkTo(n);
        const dialog=await q.waitUntil(()=>q.dialogOpen(),8);
        console.log('CERIL_PROBE '+JSON.stringify({index:n.index,id:n.id,beforeRevision:before,reply,dialog}));
        observeEntry('probe-result');
    }});
    q.milestone('house-entry');
    // Finite practice interruption at the real entry boundary. The next CLI run uses this save unchanged.
    if (process.env.Q_STOP_AFTER_ENTRY === '1') await q.fail('interrupted house entry');
    // 1. Ceril: "What's wrong?", "Yes, of course, I'd be happy to help." sets 2.
    await q.talk('ceril', /^ceril carnillean$/i, [/what's wrong/i, /yes, of course/i], () => q.sawText(/see what i can do/i), CERIL, 80);
    q.milestone(2);

    // 2. The 5 sewer valves (sewervalve3 left, the rest right); each shows a mesbox.
    for (const [i, v] of VALVES.entries()) {
        await q.walk(`to valve ${i}`, [{ x: v.x, z: v.z, tol: 2 }]);
        await closeDlg();
        await q.step(`valve ${i}`, () => q.opLoc(loc(v), v.op), () => /large metal valve/i.test(dlg()), 10, 4);
        await closeDlg();
    }
    q.milestone('valves');

    // 3. The cave; Clivet: "What do you mean?", "You're crazy, I'd never help you." sets 4 (good side); he leaves.
    await q.walk('to cave', [{ x: CAVE.x, z: CAVE.z + 1, tol: 1 }]);
    await q.step('cave', () => q.opLoc(loc(CAVE), 1), () => z() > 9000, 10, 4);
    await q.talk('clivet', /^clivet$/i, [/what do you mean/i, /you're crazy/i], () => q.sawText(/jumps onto the raft/i) || q.msgCount(/never find us/i) > 0, { x: 2566, z: 9683 }, 120);
    await closeDlg();
    q.milestone(4);

    // 4. The raft to the hideout end, Alomone's talk turns him hostile; kill him, take the armour (6).
    await q.step('raft', () => q.opLoc(loc(RAFT), 1), () => q.near(2606, 9692, 4), 12, 4);
    await closeDlg();
    await q.talk('alomone', /^alomone$/i, [], () => q.sawText(/die!!!/i), { x: 2609, z: 9670 }, 40);
    // Alomone (level 13) dies to a low-Attack ranger's bow, not to its hands; the sweep brings the bow and QUEST_ARROWS.
    await q.wieldBow();
    const alo = (): any => q.npc(/^alomone$/i);
    for (let t = 0; t < 120 && !ground(ITEM.armour); t++) {
        await q.guard('alomone');
        const a = alo();
        if (a && t % 4 === 0) await q.s.direct({ type: 'interactNpc', npcIndex: a.index, optionIndex: a.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
        await q.waitTicks(1);
    }
    await q.step('armour', () => { const g = ground(ITEM.armour); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.armour), 12, 6);
    q.milestone(6);
    }

    // 5. A raft back to the cave mouth, the stairs out, the walk to the house, upstairs to Ceril (7).
    if (z() > 9000) {
    await q.walk('to end raft', [{ x: RAFT_END.x, z: RAFT_END.z - 1, tol: 1 }]);
    await q.step('raft back', () => q.opLoc(loc(RAFT_END), 1), () => q.near(2567, 9680, 3), 12, 4);
    await closeDlg();
    await q.step('cave stairs', () => q.opLoc(loc(CAVE_STAIRS), 1), () => z() < 9000, 10, 4);
    }
    await q.walk('to house', [{ x: 2577, z: 3231, tol: 2 }, { x: 2565, z: 3233, tol: 2 }, { x: 2560, z: 3248, tol: 2 }, { x: 2559, z: 3261, tol: 2 }, { x: 2559, z: 3278, tol: 2 }, { x: 2569, z: 3278, tol: 1 }, { x: HOUSE_STAIRS.x, z: HOUSE_STAIRS.z + 1, tol: 1 }]);
    const stairs = () => q.findLoc(l => l.x === HOUSE_STAIRS.x && l.z === HOUSE_STAIRS.z && (l.optionsWithIndex ?? []).some((o: any) => /climb-up/i.test(o.text)));
    await q.climb('house stairs', stairs, /climb-up/i, () => lv() === 1);
    await q.openDoor('upstairs door', 2572, 3268);
    await q.talk('ceril up', /^ceril carnillean$/i, [], () => !q.has(ITEM.armour) && q.sawText(/don't darken my doorstep|smirks at you/i), CERIL_UP, 80);
    await closeDlg();
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });     // the "kind of completed" quest scroll (:159-167)
    q.milestone(7);

    // 6. The cupboard: open it, search it with Ceril and Jones near; the queue completes the quest.
    const cb = () => q.findLoc(l => l.x === CUPBOARD.x && l.z === CUPBOARD.z);
    await q.step('open cupboard', () => { const k = cb(); return k ? q.opLoc(k, q.opIndex(k, /^open$/i)) : q.waitTicks(1); }, () => (cb()?.optionsWithIndex ?? []).some((o: any) => /search/i.test(o.text)), 8, 4);
    await q.step('search cupboard', () => { const k = cb(); return k ? q.opLoc(k, q.opIndex(k, /search/i)) : q.waitTicks(1); }, () => q.dialogOpen() || questDone, 8, 4);
    await q.converse([], () => questDone, 120);
    const complete = () => questFlags(q.s.client)?.some(f => f.name === 'Hazeel Cult' && f.state === 'complete') === true;
    if (!await q.waitUntil(() => questDone && complete(), 10)) await q.fail('Hazeel completion flag unobserved');
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
}

if (import.meta.main || (globalThis as {QUEST_SESSION?:unknown}).QUEST_SESSION) await main();
