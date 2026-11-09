// Throne of Miscellania from preset quest_misc (north of King Vargas's throne room door, level 1 of the Miscellania
// castle; every skill 99; Heroes' Quest and The Fremennik Trials done; an iron sickle worn; helper items
// below). Reward: 1 QP (quest_misc.rs2:1-6). Server truth: quests/quest_misc/scripts/*.rs2.
// %misc_quest (varp 359, quest_misc.constant): King Vargas 10 (king_vargas.rs2:42-59; the approval is set to 32 of
// 127), Queen Sigrid 20 (queen_sigrid.rs2:56-81), the King 30 (king_vargas.rs2:76-88), Sigrid 40 (:83-96), Prince Brand's
// anthem 50 (prince_brand.rs2:22-36), Advisor Ghrim's correction 60 (advisor_ghrim.rs2:36-46), Sigrid's treaty 70
// (queen_sigrid.rs2:131-145), the King 80 (king_vargas.rs2:102-109), the giant pen 90 (:117-126); the King queues the
// completion when Princess Astrid has agreed (%misc_affection 40) and the approval is 96 or more (:139-168).
// Princess Astrid (male player, princess_astrid.rs2): 3 sets of 3 talks; each talk asks the next open question, and
// the 3 right answers come in a random order with a fourth nonsense option (misc_quest.rs2:28-48). Set 1 also needs
// flowers and the dance emote in her room, set 2 a bow, set 3 the blow-kiss emote and a ring (:622-766).
// The approval: each herb weeded in the garden by the castle adds 1 (area_miscellania/scripts/weed_herbs.rs2), with
// no decay before the quest ends (managing_miscellania.rs2:148-150).
// MI_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = { flowers: 2472, bow: 841, ring: 1635, bar: 2351, logs: 1511, anthemBad: 3894, anthemGood: 3895, treaty: 3896, nib: 3897, pen: 3898 };
const KING = { x: 2501, z: 3859 };                          // level 1
const ASTRID = { x: 2502, z: 3868 };                        // level 1
const BRAND = { x: 2502, z: 3852 };                         // level 1
const GHRIM = { x: 2499, z: 3857 };                         // level 1
const DOOR_S = { x: 2506, z: 3857 };                        // misc_ulby_throneroomdoor
const DOOR_N = { x: 2506, z: 3863 };
const STAIRS_N = { id: 1742, x: 2505, z: 3871 };            // level 0 <-> level 1 (1743)
const STAIRS_S = { id: 1742, x: 2505, z: 3848 };
const SIGRID = { x: 2612, z: 3877 };                        // level 1 of the Etceteria castle
const SIG_STAIRS = { id: 1738, x: 2613, z: 3867 };          // level 0; the top is 2614,3867 (1740)
const SIG_DOOR = { x: 2615, z: 3870 };                      // level 1
const DERRIK = { x: 2551, z: 3897 };
const HERBS = [4677, 4678, 4679];                           // misc_heather_light/normal/dark; 2524-2530, 3847-3855
const EMOTE = { dance: 'controls:com_18', kiss: 'controls:com_45' };
const NEED = 64;                                            // approval 32 -> 96

const FROM = process.env.MI_FROM ?? 'start';
const STAGES = ['start', 'weed', 'peace', 'pen'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);



const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const seen = new Set<string>();
    let weeded = 0;
    const off = q.s.onTick(() => {
        if (q.msgCount(/quest complete/i) > 0) questDone = true;
        for (const m of (q.st()?.gameMessages ?? [])) {
            if (m.type !== 0 || !/weed some herbs/i.test(m.text)) continue;
            const k = `${m.tick}:${m.text}`;
            if (!seen.has(k)) { seen.add(k); weeded++; }
        }
    });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 20); };
    const stairs = (l: { id: number; x: number; z: number }) => q.findLoc((k: any) => Math.abs(k.x - l.x) <= 1 && Math.abs(k.z - l.z) <= 1 && /stair/i.test(k.name)) ?? l;
    const climb = async (label: string, l: { id: number; x: number; z: number }, re: RegExp, toLevel: number) => {
        await q.climb(label, () => stairs(l), re, () => lv() === toLevel, 5);
        await q.waitTicks(1);
    };
    // Miscellania castle: level 1 <-> level 0 by the north stairs.
    const down = async () => { if (lv() === 0) return; await leave(true); await q.walk('to stairs n', [{ x: STAIRS_N.x - 1, z: STAIRS_N.z, tol: 1 }]); await climb('stairs down', STAIRS_N, /climb-down/i, 0); };
    const up = async () => { if (lv() === 1) return; await q.walk('to stairs n', [{ x: STAIRS_N.x - 1, z: STAIRS_N.z, tol: 1 }]); await climb('stairs up', STAIRS_N, /climb-up/i, 1); };
    // The throne room (x 2499-2510, z 3857-3863, level 1) has a door in its north wall (2506,3863) and one in its south
    // wall (2506,3857). Each op walks the player through and shuts it (~open_and_close_door); from outside the guard
    // within 1 tile is asked first until %misc_quest > 0 (misc_door_guard.rs2:1-8).
    const inRoom = () => lv() === 1 && z() >= 3857 && z() <= 3863;
    const pass = async (label: string, d: { x: number; z: number }, side: () => boolean) => {
        const inner = d.z;
        const outer = d.z === DOOR_N.z ? d.z + 1 : d.z - 1;
        await q.walk(`${label} approach`, [{ x: d.x, z: inRoom() ? inner : outer, tol: 0 }]);
        await q.step(label, async () => { await closeDlg(); const l = q.locAt(d.x, d.z); return l ? q.opLoc(l, q.opIndex(l, /open/i)) : q.waitTicks(1); }, side, 8, 6);
    };
    const throne = async () => {
        await up();
        if (inRoom()) return;
        if (z() >= 3864) await pass('throne door n', DOOR_N, inRoom);
        else await pass('throne door s', DOOR_S, inRoom);
    };
    const leave = async (north: boolean) => {
        if (!inRoom()) return;
        if (north) await pass('out door n', DOOR_N, () => z() >= 3864);
        else await pass('out door s', DOOR_S, () => z() <= 3856);
    };
    const king = async (label: string, pats: RegExp[], ok: () => boolean) => {
        await throne();
        await q.talk(label, /king vargas/i, pats, ok, KING, 120);
        await closeDlg();
    };
    const sigrid = async (label: string, pats: RegExp[], ok: () => boolean) => {
        await down();
        await q.walk('to etceteria', [{ x: 2560, z: 3870, tol: 3 }, { x: 2590, z: 3878, tol: 3 }, { x: SIG_STAIRS.x - 1, z: SIG_STAIRS.z, tol: 1 }]);
        await climb('sigrid stairs up', SIG_STAIRS, /climb-up/i, 1);
        // Her room's south door (loc 1512, north wall of 2615,3870) is shut on a fresh server and the planner treats it as open.
        await q.walk('sigrid door', [{ ...SIG_DOOR, tol: 0 }]);
        await q.openDoor('sigrid door', SIG_DOOR.x, SIG_DOOR.z);
        await q.walk('sigrid room', [{ x: SIG_DOOR.x, z: SIG_DOOR.z + 1, tol: 0 }]);
        await q.talk(label, /queen sigrid/i, pats, ok, SIGRID, 120);
        await closeDlg();
        await q.walk('sigrid door out', [{ x: SIG_DOOR.x, z: SIG_DOOR.z + 1, tol: 0 }]);
        await q.openDoor('sigrid door out', SIG_DOOR.x, SIG_DOOR.z);
        await q.walk('sigrid landing', [{ ...SIG_DOOR, tol: 0 }]);
        await climb('sigrid stairs down', { id: 1740, x: 2614, z: 3867 }, /climb-down/i, 0);
    };
    const emote = async (label: string, comp: string, reply: RegExp) => {
        await q.walk(`${label} spot`, [{ x: 2501, z: 3868, tol: 1 }]);
        await q.step(label, async () => { await closeDlg(); return q.s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }); }, () => q.sawText(reply), 6, 4);
        await closeDlg();
    };
    const give = async (label: string, item: number, reply: RegExp) => {
        await q.step(label, async () => { await closeDlg(); const n = q.npc(/princess astrid/i); return n ? q.useOnNpc(item, n) : q.walk('astrid', [{ ...ASTRID, tol: 2 }]); },
            () => q.dialogOpen() || !q.has(item), 10, 4);
        await q.converse([/^yes$/i], () => !q.has(item) && q.sawText(reply) && !q.dialogOpen(), 30);
        if (q.has(item)) await q.fail(label);
        await closeDlg();
    };
    // One Astrid talk per call; stops on the reply that shows the answer counted (or the set's end).
    const astrid = async (label: string, pats: RegExp[], ok: () => boolean) => {
        await q.talk(label, /princess astrid/i, pats, ok, ASTRID, 80);
        await closeDlg();
    };
    const astridSet = async (n: number, pats: RegExp[], replies: RegExp[], end?: RegExp) => {
        for (const r of replies) await astrid(`astrid ${n} ${r.source}`, pats, () => q.sawText(r));
        if (end) await astrid(`astrid ${n} end`, pats, () => q.sawText(end));
    };

    if (from('start')) {
        // 1. The door guard grants the audience (misc_door_guard.rs2:24-30); King Vargas: "If I may be so bold..." (10).
        // The door op asks the guard within 1 tile (misc_door_guard.rs2:1-8).
        await q.walk('to throne door', [{ x: DOOR_N.x, z: DOOR_N.z + 1, tol: 0 }]);
        for (let i = 0; i < 4 && !q.sawText(/then you may pass/i); i++) {
            await q.guard('door guard');
            const d = q.locAt(DOOR_N.x, DOOR_N.z);
            if (d) await q.opLoc(d, q.opIndex(d, /open/i));
            await q.waitUntil(() => q.dialogOpen(), 10);
            await q.converse([], () => q.sawText(/then you may pass/i) && !q.dialogOpen(), 60);
        }
        if (!q.sawText(/then you may pass/i)) await q.fail('door guard');
        await throne();
        await king('king 1', [/if i may be so bold/i], () => q.sawText(/convince my daughter/i));
        q.milestone(10);
        // 2. Princess Astrid (her room north of the throne room). Set 1: flowers, the dance, 3 answers (20).
        await leave(true);
        await q.walk('to astrid', [{ ...ASTRID, tol: 2 }]);
        await astrid('astrid start', [], () => q.sawText(/if you impress me enough/i));
        await give('flowers', ITEM.flowers, /they're lovely/i);
        await emote('dance', EMOTE.dance, /you dance well/i);
        await astridSet(1, [/archery is a noble art/i, /^hahahaha!?$/i, /he's been very helpful/i],
            [/glad you agree/i, /wouldn't hit you as well/i, /wise decision/i], /call me 'princess'/i);
        q.milestone('astrid1');
        // Set 2: the bow, 3 answers (30).
        await give('bow', ITEM.bow, /it's lovely/i);
        await astridSet(2, [/quite fond of it myself/i, /sounds like a good idea/i, /what happened next/i],
            [/shares my interests/i, /that sounds like a good idea/i, /neither of us have an army/i], /onto the shortlist/i);
        q.milestone('astrid2');
        // Set 3: the blow kiss, 3 answers, the ring (40).
        await emote('kiss', EMOTE.kiss, /you flatter me/i);
        await astridSet(3, [/what a great bard he makes/i, /much opportunity to/i, /lovely little country/i],
            [/quite the bard, he is/i, /take me with you sometime/i, /glad you like it/i]);
        await give('ring', ITEM.ring, /thought you'd never ask/i);
        q.milestone('astrid3');
        await down();
    }
    if (from('weed')) {
        // 3. The approval: weed the herbs by the castle until 64 have counted.
        // Inside the fence: 2523,3851 is the far side of the castle wall, where every herb has no route and each
        // refused click costs about a minute. The way in is the fence's north-east corner (2530,3855).
        await q.walk('to herbs', [{ x: 2527, z: 3852, tol: 1 }]);
        const t1 = q.T();
        let target = -1, sent = 0, lastCount = weeded, idle = 0;
        while (weeded < NEED && q.T() - t1 < 1200) {
            await q.guard('weeding');
            if (q.dialogOpen()) { await closeDlg(); continue; }
            if (weeded !== lastCount) { lastCount = weeded; target = -1; idle = 0; }
            const herb = q.findLoc((l: any) => HERBS.includes(l.id) && l.distance <= 12 && l.reachable !== false);
            if (!herb) { await q.walk('herbs', [{ x: 2527, z: 3851, tol: 2 }]); continue; }
            if (target === -1 || ++idle > 12) {
                idle = 0;
                target = herb.id;
                sent++;
                await q.opLoc(herb, q.opIndex(herb, /weed|clear|pick/i));
            }
            await q.waitTicks(1);
        }
        console.log(`WEED weeded=${weeded} clicks=${sent} ticks=${q.T() - t1}`);
        if (weeded < NEED) await q.fail('weeding');
        q.milestone('approval');
    }
    if (from('peace')) {
        // 4. The peace: Sigrid (20), the King (30), Sigrid (40), Brand's anthem (50), Ghrim's (60), Sigrid's treaty (70).
        await sigrid('sigrid 1', [], () => q.sawText(/officially recognise etceteria/i));
        q.milestone(20);
        await king('king 2', [], () => q.sawText(/better anthems/i));
        q.milestone(30);
        await sigrid('sigrid 2', [], () => q.sawText(/find a bard/i));
        q.milestone(40);
        // Brand's room is south of the throne room: up by the south stairs.
        await q.walk('to stairs s', [{ x: STAIRS_S.x - 1, z: STAIRS_S.z, tol: 1 }]);
        await climb('stairs s up', STAIRS_S, /climb-up/i, 1);
        // Two shut doors the planner treats as open: the landing's north door (2506,3851) and Brand's east door (2504,3853).
        await q.walk('brand landing', [{ x: 2506, z: 3851, tol: 0 }]);
        await q.openDoor('brand landing door', 2506, 3851);
        await q.walk('brand corridor', [{ x: 2505, z: 3853, tol: 0 }]);
        await q.openDoor('brand door', 2504, 3853);
        await q.walk('brand room', [{ x: 2504, z: 3853, tol: 0 }]);
        await q.talk('brand', /prince brand/i, [], () => q.has(ITEM.anthemBad) && q.sawText(/don't mention it/i), BRAND, 120);
        await closeDlg();
        await q.walk('brand door out', [{ x: 2504, z: 3853, tol: 0 }]);
        await q.openDoor('brand door out', 2504, 3853);
        await q.walk('brand corridor out', [{ x: 2505, z: 3853, tol: 0 }]);
        q.milestone(50);
        await throne();
        await q.talk('ghrim', /advisor ghrim/i, [/what am i meant to be doing/i], () => q.has(ITEM.anthemGood) && q.sawText(/negotiating peace/i), GHRIM, 120);
        await closeDlg();
        q.milestone(60);
        await sigrid('sigrid 3', [], () => q.has(ITEM.treaty));
        q.milestone(70);
    }
    if (from('pen')) {
        // 5. The King takes the treaty (80); Derrik makes the nib from the iron bar; the nib on the logs is the pen; the
        // King signs (90) and, with Astrid's yes and the approval, queues the completion.
        await king('king 3', [], () => !q.has(ITEM.treaty) && q.sawText(/pen large enough/i));
        q.milestone(80);
        await down();
        await q.walk('to derrik', [{ x: DERRIK.x, z: DERRIK.z - 2, tol: 2 }]);
        await q.talk('derrik', /derrik/i, [/slightly strange request/i], () => q.has(ITEM.nib), DERRIK, 80);
        await closeDlg();
        await q.step('pen', async () => { await closeDlg(); return q.useOnItem(ITEM.nib, ITEM.logs); }, () => q.has(ITEM.pen), 6, 4);
        q.milestone('pen');
        await king('king 4', [], () => questDone);
        await q.waitUntil(() => questDone, 10);
    }
    off();
    if (!questDone) await q.fail('no quest complete message');
    q.milestone(100);
    await q.end(true, 'qp=1');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
