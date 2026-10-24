// Observatory Quest from preset quest_itgronigen (beside the professor in the reception north of the observatory; every
// skill 99; 3 planks, a bronze bar and a molten glass from a helper). Reward: 2 QP, 22,500 Crafting XP before 25x, an
// uncut sapphire and a random constellation gift (quest_itgronigen.rs2:220-270).
// Varp %itgronigen: 1 after "Sounds interesting, what can I do for you?", then one talk each for the planks (2), the
// bronze bar (3), the molten glass (4), the lens mould (5, he gives the glass back) and the lens (6)
// (observatory_professor.rs2:16-100,132-180). The mould lies under a sack in the goblin keep of the cavern below
// (quest_itgronigen.rs2:164-172); the keep gate is locked from the north until the keep key from a chest opens it
// (:85-150). The lens is the glass used on the mould (:174-185). The telescope in the observatory, with the second
// professor within 7 tiles, ends the quest (:152-162,187-266). The observatory has no way in on foot: its ladder comes
// up from the cavern (loc_2189, :20-22).
import { openQuest } from './quest-lib';

const PROF = { x: 2438, z: 3186 };
const LADDER_RECEPTION = { id: 2187, x: 2444, z: 3191 };   // -> 0_37_147_52_51 = 2420,9459
const UP_RECEPTION = { id: 2188, x: 2420, z: 9460 };       // -> 2444,3192
const UP_OBSERVATORY = { id: 2189, x: 2423, z: 9439 };     // -> 0_38_49_8_29 = 2440,3165
const KEY_CHEST = { x: 2428, z: 9419 };                    // loc_2197 shut, loc_2198 open
const GATE = { id: 2199, x: 2391, z: 9457 };
const SACK = { id: 2212, x: 2389, z: 9454 };
const TELESCOPE = { id: 2210, x: 2440, z: 3157 };
const ITEM = { plank: 960, bronze: 2349, glass: 1775, key: 601, mould: 602, lens: 603 };

const q = await openQuest({ cap: 3000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 10); };
    const prof = (label: string, pats: RegExp[], ok: () => boolean) => q.talk(label, /^observatory professor$/i, pats, ok, PROF, 80);
    const up = async (label: string, l: { id: number; x: number; z: number }) => {
        await q.walk(`to ${label}`, [{ x: l.x, z: l.z + 1, tol: 1 }]);
        await q.step(label, () => q.opLoc(loc(l), 1), () => z() < 9000, 10, 4);
    };

    // 1. The professor: start, then the planks, the bronze bar and the glass, one talk each (1-4).
    await prof('start', [/look through that telescope/i, /sounds interesting/i], () => q.sawText(/three planks of wood for the tripod/i));
    q.milestone(1);
    await prof('planks', [], () => !q.has(ITEM.plank) && q.sawText(/start the tripod construction/i));
    await prof('bronze', [], () => !q.has(ITEM.bronze) && q.sawText(/get me some molten glass/i));
    await prof('glass', [], () => !q.has(ITEM.glass) && q.sawText(/try and find it/i));
    q.milestone(4);

    // 2. Down into the cavern; the keep key from the south-east chest; the keep gate; the mould under the sack.
    await q.walk('to reception ladder', [{ x: LADDER_RECEPTION.x, z: LADDER_RECEPTION.z + 1, tol: 1 }]);
    await q.step('reception ladder', async () => { if (q.dialogOpen()) return q.converse([], () => !q.dialogOpen(), 6); return q.opLoc(loc(LADDER_RECEPTION), 1); }, () => z() > 9000, 10, 5);
    await closeDlg();
    await q.walk('to key chest', [{ x: 2426, z: 9465, tol: 2 }, { x: 2404, z: 9455, tol: 2 }, { x: 2391, z: 9466, tol: 2 }, { x: 2386, z: 9450, tol: 2 }, { x: 2397, z: 9444, tol: 2 },
        { x: 2386, z: 9443, tol: 2 }, { x: 2372, z: 9450, tol: 2 }, { x: 2370, z: 9431, tol: 2 }, { x: 2384, z: 9425, tol: 2 }, { x: 2399, z: 9421, tol: 2 }, { x: 2407, z: 9415, tol: 2 },
        { x: 2425, z: 9412, tol: 2 }, { x: KEY_CHEST.x - 1, z: KEY_CHEST.z, tol: 1 }]);
    const chest = () => q.findLoc(l => l.x === KEY_CHEST.x && l.z === KEY_CHEST.z);
    await q.step('open chest', () => { const c = chest(); return c ? q.opLoc(c, 1) : q.waitTicks(1); }, () => chest()?.id === 2198, 8, 4);
    await q.step('search chest', () => { const c = chest(); return c ? q.opLoc(c, 2) : q.waitTicks(1); }, () => q.has(ITEM.key), 8, 4);
    await closeDlg();
    q.milestone('key');
    await q.walk('to keep gate', [{ x: 2407, z: 9415, tol: 2 }, { x: 2399, z: 9421, tol: 2 }, { x: 2384, z: 9425, tol: 2 }, { x: 2371, z: 9436, tol: 2 }, { x: 2377, z: 9455, tol: 2 },
        { x: 2385, z: 9444, tol: 2 }, { x: 2397, z: 9446, tol: 2 }, { x: 2386, z: 9450, tol: 2 }, { x: 2387, z: 9466, tol: 2 }, { x: 2392, z: 9461, tol: 1 }, { x: GATE.x, z: GATE.z + 1, tol: 0 }]);
    // The gate is the north wall of 2391,9457; it p_teleports one tile, so the keep side is z <= 9457 (trial 1).
    await q.step('keep gate', () => q.useOnLoc(ITEM.key, loc(GATE)), () => z() <= GATE.z, 8, 5);
    await closeDlg();
    await q.walk('to sack', [{ x: SACK.x + 1, z: SACK.z + 1, tol: 1 }]);
    await q.step('sack', () => q.opLoc(loc(SACK), 1), () => q.has(ITEM.mould), 8, 4);
    q.milestone('mould');

    // 3. Out of the keep, up to the reception: the mould (5), the lens, the lens (6).
    await q.walk('to gate south', [{ x: GATE.x, z: GATE.z, tol: 0 }]);
    await q.step('gate out', () => q.opLoc(loc(GATE), 1), () => z() > GATE.z, 8, 5);
    await q.walk('to reception up', [{ x: 2397, z: 9459, tol: 2 }, { x: 2404, z: 9455, tol: 2 }, { x: 2414, z: 9466, tol: 2 }, { x: 2426, z: 9465, tol: 2 }, { x: 2421, z: 9458, tol: 1 }]);
    await up('reception up', UP_RECEPTION);
    await prof('mould', [], () => q.has(ITEM.glass) && q.sawText(/gives you back the molten glass/i));
    await closeDlg();
    await q.step('lens', () => q.useOnItem(ITEM.glass, ITEM.mould), () => q.has(ITEM.lens), 6, 4);
    await closeDlg();
    await prof('lens', [], () => !q.has(ITEM.lens) && q.sawText(/meet me at the observatory/i));
    q.milestone(6);

    // 4. Down again, through the cavern to the observatory ladder, the telescope.
    await q.walk('to reception ladder 2', [{ x: LADDER_RECEPTION.x, z: LADDER_RECEPTION.z + 1, tol: 1 }]);
    await q.step('reception ladder 2', async () => { if (q.dialogOpen()) return q.converse([], () => !q.dialogOpen(), 6); return q.opLoc(loc(LADDER_RECEPTION), 1); }, () => z() > 9000, 10, 5);
    await closeDlg();
    await q.walk('to observatory ladder', [{ x: 2426, z: 9465, tol: 2 }, { x: 2404, z: 9455, tol: 2 }, { x: 2391, z: 9466, tol: 2 }, { x: 2386, z: 9450, tol: 2 }, { x: 2397, z: 9444, tol: 2 },
        { x: 2386, z: 9443, tol: 2 }, { x: 2372, z: 9450, tol: 2 }, { x: 2370, z: 9431, tol: 2 }, { x: 2384, z: 9425, tol: 2 }, { x: 2399, z: 9421, tol: 2 }, { x: 2407, z: 9429, tol: 2 },
        { x: 2415, z: 9429, tol: 2 }, { x: UP_OBSERVATORY.x + 1, z: UP_OBSERVATORY.z - 1, tol: 1 }]);
    await q.step('observatory ladder', () => q.opLoc(loc(UP_OBSERVATORY), 1), () => z() < 9000, 10, 4);
    await q.walk('to telescope', [{ x: TELESCOPE.x, z: TELESCOPE.z + 1, tol: 1 }]);
    await q.step('telescope', () => q.opLoc(loc(TELESCOPE), 1), () => q.dialogOpen() || questDone || q.msgCount(/look through the telescope/i) > 0, 10, 4);
    await q.s.direct({ type: 'closeModal', reason: 'SDK' });
    await q.converse([/i can see a constellation/i], () => questDone, 60);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=2');
} catch (e) { await q.fail(String(e)); }
