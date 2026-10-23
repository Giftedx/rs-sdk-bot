// Gertrude's Cat from preset quest_fluffs (Gertrude's house west of Varrock; every skill 99; bucket of milk, seasoned
// sardine, 100 coins and Varrock teleport runes from a helper). Reward: 1 QP, a kitten, 1,525 Cooking XP before 25x
// (quest_fluffs.rs2:313-318).
// Varp %fluffs: 0 -> 1 Gertrude, 2 Shilop paid, 3 milk, 4 sardine (the kitten crate is set at random), 5 kitten
// given, 6 Gertrude (queued completion).
// Server truth: areas/area_varrock/scripts/gertrude.rs2, shilop.rs2, quests/quest_fluffs/scripts/quest_fluffs.rs2.
import { openQuest } from './quest-lib';

const GERTRUDE = { x: 3151, z: 3410 };
const SHILOP = { x: 3221, z: 3434 };
const FENCE = { id: 2618, x: 3305, z: 3493 };             // gertrudefence: climbed from 3305,3492
const LADDER = { id: 1747, x: 3310, z: 3509 };            // laddertop 1746 on level 1
const CAT = { x: 3306, z: 3512 };                         // level 1
const ITEM = { milk: 1927, sardine: 1552, kitten: 1554 };
// kittens_mew "Crate" npcs; the kitten is at one of them (quest_fluffs.rs2:221-228, 271-279).
const CRATES = [{ x: 3305, z: 3500 }, { x: 3310, z: 3499 }, { x: 3307, z: 3507 }, { x: 3303, z: 3506 }, { x: 3298, z: 3514 }, { x: 3311, z: 3511 }];

const q = await openQuest({ cap: 1500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const gert = /^gertrude$/i;

    // 1. Gertrude: "Well, I suppose I could." sets 1 (gertrude.rs2:105-113).
    await q.talk('gertrude 1', gert, [/i suppose i could/i], () => q.sawText(/shilop and wilough/i), GERTRUDE);
    q.milestone(1);

    // 2. Shilop in the market (door loc_1530 at 3150,3412): "What will make you tell me?", "Okay then, I'll pay." sets
    // 2 (quest_fluffs.rs2:34-114). The choice comes only when Wilough stands within 3 tiles in line of sight (:39-47);
    // apart, the talk ends with no choice and no progress (3 of 3 failed runs in a proof). The bot talks only when the
    // two stand within 2 tiles of each other, and talks again on a miss.
    await q.openDoor('gertrude door', 3150, 3412);
    await q.walk('to shilop', [{ x: SHILOP.x, z: SHILOP.z, tol: 3 }]);
    const paid = () => q.sawText(/broken fence/i);
    for (let tries = 0; tries < 8 && !paid(); tries++) {
        await q.guard('shilop');
        const s = q.npc(/^shilop$/i), w = q.npc(/^wilough$/i);
        const together = s && w && Math.max(Math.abs(s.x - w.x), Math.abs(s.z - w.z)) <= 2;
        if (!together) { await q.waitTicks(1); tries--; if (q.T() > 600) break; continue; }
        const boy = s.distance <= w.distance ? s : w;
        await q.talkTo(boy);
        await q.waitUntil(() => q.dialogOpen(), 12);
        let shut = 0;
        await q.converse([/what will make you tell me/i, /okay then, i'll pay/i], () => { shut = q.dialogOpen() ? 0 : shut + 1; return (paid() && shut >= 2) || shut >= 3; }, 80);
    }
    if (!paid()) await q.fail('shilop not paid');
    // "broken fence" is the last page before %fluffs = 2 (quest_fluffs.rs2:112-113): the bot waits for the dialog to close.
    q.milestone(2);

    // 3. The lumber yard: the broken fence from the south, the ladder, Fluffs on level 1: milk (3), sardine (4).
    await q.walk('to fence', [{ x: FENCE.x, z: FENCE.z - 1, tol: 0 }]);
    const inYard = () => (q.pos()?.worldZ ?? 0) >= FENCE.z;
    await q.step('fence', () => q.opLoc(q.locAt(FENCE.x, FENCE.z) ?? FENCE, 1), inYard, 8, 4);
    const up = async (label: string): Promise<void> => {
        await q.walk(`${label} ladder`, [{ x: LADDER.x, z: LADDER.z - 1, tol: 1 }]);
        await q.climb(`${label} ladder up`, () => q.locAt(LADDER.x, LADDER.z) ?? LADDER, /climb-up/i, levelIs(1));
    };
    await up('cat 1');
    const cat = () => q.npc(/^gertrudes cat$/i);
    const useOnCat = async (label: string, item: number): Promise<void> => {
        await q.step(label, () => { const c = cat(); return c ? q.useOnNpc(item, c) : q.waitTicks(1); }, () => !q.has(item), 12, 4);
        await q.waitTicks(2);
    };
    await useOnCat('milk', ITEM.milk);
    q.milestone(3);
    await useOnCat('sardine', ITEM.sardine);
    q.milestone(4);

    // 4. Down, search the crates (op1 on the kittens_mew npc, p_delay(4) each) until the kitten.
    await q.climb('ladder down', () => q.findLoc(l => l.x === LADDER.x && l.z === LADDER.z && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))) ?? { id: 1746, ...LADDER }, /climb-down/i, levelIs(0));
    // The npc list lags the level change by a tick or two (a trial saw only the level-1 cat right after the ladder).
    await q.waitUntil(() => (q.st()?.nearbyNpcs ?? []).some((m: any) => /crate/i.test(m.name)), 8);
    const order = [...CRATES].sort((a, b) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z));
    for (const c of order) {
        if (q.has(ITEM.kitten)) break;
        await q.guard('crates');
        const n = (q.st()?.nearbyNpcs ?? []).find((m: any) => m.x === c.x && m.z === c.z && /crate/i.test(m.name));
        if (!n) { console.log(`WARN no crate npc at ${c.x},${c.z}`); continue; }
        const m0 = q.msgCount(/you find nothing/i);
        await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.[0]?.opIndex ?? 1, reason: 'SDK' });
        await q.waitUntil(() => q.has(ITEM.kitten) || q.msgCount(/you find nothing/i) > m0, 25);
        await q.converse([], () => !q.dialogOpen(), 5);
    }
    if (!q.has(ITEM.kitten)) await q.fail('no kitten');
    q.milestone('kitten');

    // 5. The kitten on Fluffs (5), Varrock teleport, Gertrude queues the completion (gertrude.rs2:41-60).
    await up('cat 2');
    await q.step('kitten', () => { const c = cat(); return c ? q.useOnNpc(ITEM.kitten, c) : q.waitTicks(1); }, () => !q.has(ITEM.kitten), 12, 4);
    await q.waitUntil(() => !cat(), 15);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(5);
    await q.teleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('to gertrude', [{ x: 3150, z: 3413, tol: 1 }]);
    await q.openDoor('gertrude door in', 3150, 3412);
    await q.talk('gertrude 2', gert, [], () => questDone, GERTRUDE, 60, true);
    await q.converse([], () => !q.dialogOpen(), 10);
    q.milestone(6);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
