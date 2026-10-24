// Temple of Ikov from preset quest_ikov (beside Lucien in the Flying Horse Inn, Ardougne; every skill 99; a worn magic
// shortbow, no armour; a lit candle, 20 limpwurt roots, Varrock Teleport runes and 2 sharks from a helper). The bot
// takes the Armadyl side (kill Lucien), which needs no fight with the 5 guardians. Reward: 1 QP, Ranged 10,500 and
// Fletching 8,000 XP before 25x (quests/quest_ikov/scripts/quest_ikov.rs2:182-190).
// %ikov (varp 26, quest_ikov.constant): Lucien 10 (lucien.rs2:61-72); the trap found 20 and the lever pulled 30
// (ikov_dungeon.rs2:133-165); the Fire Warrior dead 40 (fire_warrior_of_leskarus.rs2:20-30); Winelda 50 and her roots
// 60 (winelda.rs2); the guardian's bath 70 (guardian_of_armadyl.rs2:176-190); Lucien dead completes it
// (lucien.rs2:108-122). %ikov_dungeon (27): bit 0 the mended lever (ikov_dungeon.rs2:96-110).
// IK_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { candle: 33, knife: 946, root: 225, bow: 861, pendantL: 86, pendantA: 87, boots: 88, bootsWorn: 89, lever: 83, arrow: 78 };
const LUCIEN1 = { x: 2573, z: 3321 };
const CELLAR = { id: 1754, x: 2677, z: 3405 };           // ladder_cellar, Hemenster -> 2677,9805
const DARK_DOWN = { id: 98, x: 2651, z: 9808 };           // with a lit light -> 2641,9764
const DARK_UP = { id: 96, x: 2638, z: 9763 };             // -> 2654,9809
const BOOTS = { x: 2654, z: 9767 };
const WEB = { id: 733, x: 2654, z: 9766 };
const FEAR = { id: 94, x: 2662, z: 9815 };                // ikov_dooroffearl (2661 r, 2662 l)
const LEVER_PIECE = { x: 2637, z: 9819 };
const BRACKET = { id: 86, x: 2671, z: 9804 };
const GATE_S = { id: 89, x: 2662, z: 9803 };              // ikov_mendedleverdoorl
const CHESTS: Array<[number, number]> = [[2710, 9850], [2729, 9850], [2747, 9848], [2738, 9835], [2745, 9821], [2719, 9838]];
const TRAP_LEVER = { id: 91, x: 2665, z: 9855 };
const TRAP_DOOR = { id: 92, x: 2648, z: 9857 };
const FW_DOOR = { id: 93, x: 2646, z: 9870 };
const WINELDA = { x: 2656, z: 9875 };
const SECRET = { id: 1586, x: 2643, z: 9892 };
const LUCIEN2 = { x: 3176, z: 3476 };
const PROTECT_MAGIC = 12;

const FROM = process.env.IK_FROM ?? 'start';
const STAGES = ['start', 'low', 'arrows', 'warrior'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 7000, eatAt: 40, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 12); };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const wornCount = (id: number) => (q.st()?.equipment ?? []).filter((e: any) => e?.id === id).reduce((n: number, e: any) => n + (e.count ?? 1), 0);
    const use = (id: number, op: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: op, reason: 'SDK' });
    const wear = async (id: number, wornId = id) => {
        if (worn(wornId) && !q.has(id)) return;
        const op = (q.inv().find((i: any) => i.id === id)?.optionsWithIndex ?? []).find((o: any) => /wield|wear/i.test(o.text))?.opIndex ?? 2;
        await q.step(`wear ${id}`, () => use(id, op), () => worn(wornId) && !q.has(id), 4, 3);
    };
    const remove = async (id: number) => {
        const e = (q.st()?.equipment ?? []).find((k: any) => k?.id === id);
        if (!e) return;
        await q.step(`remove ${id}`, () => q.s.direct({ type: 'useEquipmentItem', slot: e.slot, optionIndex: 1, reason: 'SDK' }), () => !worn(id), 4, 3);
    };
    // By id: a hidden trapdoor (105) shares the trap lever tile 2665,9855 (trial 5 searched the trapdoor).
    const loc = (l: { id: number; x: number; z: number }) => q.findLoc((k: any) => k.id === l.id && k.x === l.x && k.z === l.z) ?? l;
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const pickup = async (label: string, id: number, gx: number, gz: number) => {
        const n0 = q.cnt(id);
        for (let i = 0; i < 12 && q.cnt(id) <= n0; i++) {
            await q.guard(label);
            const g = ground(id) ?? { x: gx, z: gz };
            if (i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
            await q.waitTicks(2);
        }
        if (q.cnt(id) <= n0) { console.log(`WARN ground ${JSON.stringify((q.st()?.groundItems ?? []).filter((g: any) => q.cheb(g.x, g.z) <= 15).map((g: any) => [g.id, g.x, g.z]))}`); await q.fail(`pickup ${label}`); }
    };
    const prayer = async (on: boolean) => {
        const p: any = q.st()?.prayers;
        if (!!p?.activePrayers?.[PROTECT_MAGIC] === on) return;
        await q.step(`protect magic ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MAGIC, reason: 'SDK' }), () => !!(q.st() as any)?.prayers?.activePrayers?.[PROTECT_MAGIC] === on, 3, 3);
    };
    // A door op that moves the bot: retried until arrived().
    const door = async (label: string, l: { id: number; x: number; z: number }, arrived: () => boolean) => {
        await q.step(label, () => q.opLoc(loc(l), 1), arrived, 12, 4);
        await q.waitTicks(1);
        await closeDlg();
    };
    // Drops what the quest no longer needs (pack room for the ice arrows).
    const drop = async (ids: number[]) => {
        for (let i = 0; i < 6 && ids.some(id => q.has(id)); i++) {
            const it = q.inv().find((e: any) => ids.includes(e.id));
            if (it) await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
            await q.waitTicks(1);
        }
    };
    // These doors are walls on one edge of the loc tile: an op from the loc tile crosses the wall, an op from the far
    // side moves the bot onto the loc tile (doors/scripts/open_and_close_double_doors.rs2:143-158). Trial 2 waited one
    // tile too far.
    const fearNorth = () => door('fear door north', FEAR, () => z() >= 9815);
    const fearSouth = () => door('fear door south', FEAR, () => z() <= 9814);

    if (from('start')) {
        // 1. Lucien: "I'm a mighty hero!", "That sounds like a laugh!" sets 10 and gives his pendant (lucien.rs2:14-72).
        // Lucien wanders through the inn's rooms; their doors (loc_1533) start shut and the walker plans through them,
        // so the bot opens them by tile first (proof attempt 1: "I can't reach that!" 3/3).
        for (const [dx, dz] of [[2576, 3320], [2571, 3322], [2569, 3322]] as const) {
            if (!q.shutAt(dx, dz)) continue;
            await q.walk(`to inn door ${dx},${dz}`, [{ x: dx === 2576 ? 2575 : dx === 2571 ? 2572 : 2570, z: dz, tol: 0 }]);
            await q.openDoor(`inn door ${dx},${dz}`, dx, dz);
        }
        await q.talk('lucien', /^lucien$/i, [/i'm a mighty hero/i, /that sounds like a laugh/i], () => q.has(ITEM.pendantL), LUCIEN1, 60);
        q.milestone(10);
        await wear(ITEM.pendantL);
        // 2. The Hemenster cellar ladder into the temple.
        await q.walk('to temple', [{ x: CELLAR.x, z: CELLAR.z + 1, tol: 1 }]);
        await q.climb('cellar', () => q.locAt(CELLAR.x, CELLAR.z) ?? CELLAR, /climb-down|^climb/i, () => z() > 9000);
    }
    if (from('low')) {
        // 3. The dark stairs with the lit candle; the boots of lightness; the stairs up (ikov_dungeon.rs2:3-10,84-85).
        await door('dark stairs down', DARK_DOWN, () => z() < 9790);
        // The boots lie in a closet behind a slashable web (bigweb_slashable 2654,9766); the knife cuts it 1 time in 2
        // (general_use/scripts/web.rs2:10-30). Trial 1: the pickup without this was "I can't reach that!".
        await q.walk('to web', [{ x: WEB.x, z: WEB.z - 1, tol: 0 }]);
        for (let i = 0; i < 12 && q.findLoc((k: any) => k.id === WEB.id && k.x === WEB.x && k.z === WEB.z); i++) {
            await q.guard('web');
            await q.useOnLoc(ITEM.knife, loc(WEB));
            await q.waitTicks(4);
        }
        if (q.findLoc((k: any) => k.id === WEB.id && k.x === WEB.x && k.z === WEB.z)) await q.fail('web');
        await pickup('boots', ITEM.boots, BOOTS.x, BOOTS.z);
        await drop([ITEM.knife, ITEM.candle]);
        await wear(ITEM.boots, ITEM.bootsWorn);
        await door('dark stairs up', DARK_UP, () => z() > 9790);
        // 4. The door of fear (pendant worn); the lava bridge with weight below 0 (boots -10 lb, no armour); the lever
        // piece; the bridge back (ikov_dungeon.rs2:12-23,36-82).
        await q.walk('to fear door', [{ x: FEAR.x, z: FEAR.z - 1, tol: 0 }]);
        await fearNorth();
        await q.walk('to bridge', [{ x: 2651, z: 9828, tol: 0 }]);
        await q.step('bridge west', () => q.s.direct({ type: 'walkTo', x: 2649, z: 9828, running: false, reason: 'SDK' }), () => x() <= 2647, 10, 4);
        await q.waitTicks(1);
        await q.walk('to lever piece', [{ x: LEVER_PIECE.x, z: LEVER_PIECE.z + 1, tol: 1 }]);
        await pickup('lever piece', ITEM.lever, LEVER_PIECE.x, LEVER_PIECE.z);
        await q.walk('to bridge back', [{ x: 2647, z: 9828, tol: 0 }]);
        await q.step('bridge east', () => q.s.direct({ type: 'walkTo', x: 2649, z: 9828, running: false, reason: 'SDK' }), () => x() >= 2651, 10, 4);
        await q.waitTicks(1);
        await q.walk('to fear door back', [{ x: FEAR.x, z: FEAR.z, tol: 0 }]);
        await fearSouth();
        // 5. The lever piece in the bracket; Pull sets the lever bit; the south gate opens (ikov_dungeon.rs2:25-34,87-110).
        await q.walk('to bracket', [{ x: BRACKET.x, z: BRACKET.z + 1, tol: 1 }]);
        await q.step('fit lever', () => q.useOnLoc(ITEM.lever, loc(BRACKET)), () => !q.has(ITEM.lever), 10, 3);
        await closeDlg();
        await q.step('pull lever', () => { const l = q.findLoc((k: any) => k.id === 87 && k.x === BRACKET.x && k.z === BRACKET.z); return l ? q.opLoc(l, 1) : q.waitTicks(1); }, () => q.sawText(/clunking of some hidden machinery/i), 10, 4);
        await closeDlg();
        q.milestone('lever');
        await q.walk('to south gate', [{ x: GATE_S.x, z: GATE_S.z, tol: 0 }]);
        await door('south gate', GATE_S, () => z() <= 9802);
    }
    if (from('arrows')) {
        // 6. Ice arrows: one of 6 chests holds 1-5 (random per find; the chest moves after each find,
        // quest_ikov.rs2:9-17, ikov_dungeon.rs2:112-131). The bot opens and searches round the chests until it has 10.
        for (let i = 0; i < 60 && q.cnt(ITEM.arrow) < 10; i++) {
            await q.guard('ice arrows');
            const [cx, cz] = CHESTS[i % CHESTS.length]!;
            if (!q.near(cx, cz, 10)) await q.walk(`to chest ${cx},${cz}`, [{ x: cx, z: cz, tol: 2 }]);
            const shut = () => q.findLoc((k: any) => k.id === 103 && k.x === cx && k.z === cz);
            const open = () => q.findLoc((k: any) => k.id === 104 && k.x === cx && k.z === cz);
            if (!open()) await q.step(`open chest ${cx},${cz}`, () => q.opLoc(shut() ?? { id: 103, x: cx, z: cz }, 1), () => !!open(), 10, 3);
            const a0 = q.cnt(ITEM.arrow), t0 = q.s.tick();
            await q.opLoc(open() ?? { id: 104, x: cx, z: cz }, 1);
            await q.waitUntil(() => q.cnt(ITEM.arrow) > a0 || (q.st()?.gameMessages ?? []).some((m: any) => m.tick >= t0 && /find nothing/i.test(m.text)), 10);
            await closeDlg();
            if (q.cnt(ITEM.arrow) > a0) console.log(`MILESTONE arrows ${q.cnt(ITEM.arrow)} at chest ${cx},${cz} ${q.T()}`);
        }
        if (q.cnt(ITEM.arrow) < 10) await q.fail(`ice arrows ${q.cnt(ITEM.arrow)}`);
        await wear(ITEM.arrow);
        q.milestone('arrows');
        // 7. Back north; the trap lever: Search (Thieving 42) sets 20, Pull sets 30; its door (ikov_dungeon.rs2:133-175).
        await q.walk('to south gate back', [{ x: GATE_S.x, z: GATE_S.z - 1, tol: 0 }]);
        await door('south gate back', GATE_S, () => z() >= 9803);
        await q.walk('to fear door', [{ x: FEAR.x, z: FEAR.z - 1, tol: 0 }]);
        await fearNorth();
        await q.walk('to trap lever', [{ x: TRAP_LEVER.x, z: TRAP_LEVER.z - 1, tol: 0 }]);
        await q.step('search lever', () => q.opLoc(loc(TRAP_LEVER), 2), () => q.sawText(/you disable the trap/i), 10, 4);
        await closeDlg();
        const t1 = q.s.tick();
        await q.opLoc(loc(TRAP_LEVER), 1);
        await q.waitTicks(4);
        if (z() > 9856 || q.s.tick() < t1) await q.fail('trap lever');
        q.milestone(30);
        await q.walk('to trap door', [{ x: TRAP_DOOR.x, z: TRAP_DOOR.z - 1, tol: 0 }]);
    }
    if (from('warrior')) {
        await door('trap lever door', TRAP_DOOR, () => z() >= 9858);
        // 8. The Fire Warrior (level 84) appears at his door; only ice arrows worn and Ranged hurt him
        // (skill_combat/scripts/npc/npc_combat.rs2:169); his fire blasts (max 8) go under Protect from Magic. 4 in 5
        // arrows fall under him (player_ranged.rs2:123-133), so the bot picks them up when the quiver is low.
        await q.walk('to warrior door', [{ x: FW_DOOR.x, z: FW_DOOR.z - 1, tol: 0 }]);
        await q.opLoc(loc(FW_DOOR), 1);
        await q.waitUntil(() => !!q.npc(/fire warrior/i), 12);
        await q.waitTicks(4);
        await prayer(true);
        const fw = () => q.npc(/fire warrior/i);
        for (let k = 0; k < 80 && fw(); k++) {
            await q.guard('fire warrior');
            if (wornCount(ITEM.arrow) < 2 || !worn(ITEM.arrow)) {
                for (let j = 0; j < 4 && ground(ITEM.arrow); j++) { const g = ground(ITEM.arrow); await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: ITEM.arrow, reason: 'SDK' }); await q.waitTicks(3); }
                if (q.has(ITEM.arrow)) await wear(ITEM.arrow);
                if (!worn(ITEM.arrow)) await q.fail('out of ice arrows');
            }
            const n = fw();
            if (!n) break;
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => !fw(), 6);
        }
        if (fw()) await q.fail('fire warrior alive');
        await prayer(false);
        q.milestone(40);
        await q.waitTicks(2);
        await door('warrior door', FW_DOOR, () => z() >= 9871);
        // 9. Winelda: "Yes I do!" (50); the 20 roots (60) and her teleport over the lava (winelda.rs2:1-71).
        await q.talk('winelda', /^winelda$/i, [/^yes i do/i], () => q.sawText(/get winelda 20 limpwurt roots/i), WINELDA, 60);
        // Her teleport lands at 2664,9876 east of the lava (x >= 2660 is reached no other way); proof attempt 2 waited
        // for that exact tile, missed it by a step and walked back toward her.
        await q.talk('winelda roots', /^winelda$/i, [], () => x() >= 2660, WINELDA, 60);
        q.milestone(60);
        // 10. A guardian (no Lucien pendant worn): the Mahjarrat, Lucien, "it's time for my yearly bath", "Ok! I'll
        // help!" gives the pendant of Armadyl (70, guardian_of_armadyl.rs2:72-198). The secret door leads to them.
        await remove(ITEM.pendantL);
        await q.walk('to secret door', [{ x: SECRET.x, z: SECRET.z - 1, tol: 0 }]);
        await door('secret door', SECRET, () => z() >= 9893);
        await q.talk('guardian', /^guardian of armadyl$/i, [/what are your kind/i, /who are the mahjarrat/i, /did you say lucien/i, /yearly bath/i, /ok! i'll help/i], () => q.has(ITEM.pendantA), { x: 2640, z: 9900 }, 80);
        q.milestone(70);
        // 11. Varrock Teleport; Lucien north of Varrock dies to a player wearing the pendant of Armadyl
        // (quest_ikov.rs2:141-157, lucien.rs2:108-122).
        await q.teleport('varrock teleport', 'magic:varrock_teleport', 3213, 3424);
        await wear(ITEM.pendantA);
        // The ice arrows are spent on the Fire Warrior; Lucien (level 14) dies to fists (trial 6: "no ammo left").
        await remove(ITEM.bow);
        await q.walk('to lucien', [{ x: LUCIEN2.x, z: LUCIEN2.z - 2, tol: 3 }]);
        for (let k = 0; k < 30 && !questDone; k++) {
            await q.guard('lucien');
            await closeDlg();
            const n = q.npc(/^lucien$/i);
            if (!n) { await q.walk('lucien approach', [{ x: LUCIEN2.x, z: LUCIEN2.z, tol: 4 }]); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => questDone || !q.npc(/^lucien$/i), 8);
        }
        await q.converse([], () => questDone, 20);
    }
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
