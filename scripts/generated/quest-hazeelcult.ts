// Hazeel Cult (good side) from preset quest_hazeelcult (beside Sir Ceril Carnillean in his house, west of the Ardougne
// zoo; every skill 99; no helper items). Reward: 1 QP, 15,000 Thieving XP before 25x, 2,000 coins
// (quest_hazeelcult.rs2:169-175).
// Varp %hazeelcultquest (223): 2 after Ceril (ceril_carnillean.rs2:8-31), 3 then 4 after Clivet when the bot refuses to
// join (clivet.rs2:147-158,228-272; side 0 = good), 6 when Alomone dies (alomone.rs2:100-123, he drops the armour), 7
// after the armour goes to Ceril upstairs (ceril_carnillean.rs2:108-139), complete after the cupboard search with Ceril
// and Jones near (quest_hazeelcult.rs2:84-122). %hazeelcult_valves (224): the raft goes to the hideout end only when all 5
// valve bits are set (quest_hazeelcult.rs2:11-70): valve 3 turns left, the other 4 turn right.
// The good side needs one raft trip; the evil side needs two hideout visits and the house chest, so it is longer.
import { openQuest } from './quest-lib';

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

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const dlg = (): string => { const d: any = q.s.sdk.getDialog(); return d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ') : ''; };
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 8); };
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];

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
    const alo = (): any => q.npc(/^alomone$/i);
    for (let t = 0; t < 120 && !ground(ITEM.armour); t++) {
        await q.guard('alomone');
        const a = alo();
        if (a && t % 4 === 0) await q.s.direct({ type: 'interactNpc', npcIndex: a.index, optionIndex: a.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
        await q.waitTicks(1);
    }
    await q.step('armour', () => { const g = ground(ITEM.armour); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.armour), 12, 6);
    q.milestone(6);

    // 5. A raft back to the cave mouth, the stairs out, the walk to the house, upstairs to Ceril (7).
    await q.walk('to end raft', [{ x: RAFT_END.x, z: RAFT_END.z - 1, tol: 1 }]);
    await q.step('raft back', () => q.opLoc(loc(RAFT_END), 1), () => q.near(2567, 9680, 3), 12, 4);
    await closeDlg();
    await q.step('cave stairs', () => q.opLoc(loc(CAVE_STAIRS), 1), () => z() < 9000, 10, 4);
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
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
