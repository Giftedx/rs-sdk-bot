// Tree Gnome Village from preset quest_tree (beside King Bolren), at the planner's combat state for the tree row:
// Attack, Strength, Defence 1, 10 HP, Magic 43, Prayer 43. Reward: 286,250 Attack at 25x (quest_tree.rs2:98), 2 QP.
// Varp %treequest (111): 1 Bolren, 2 Montai, 3 six logs, 4 Montai "I'll try my best", 5 ballista (fixed answer 0004,
// 0003, 0005, quest_tree.rs2:10-24, so the trackers are skipped), 6 the orb from the chest, 7 Bolren, 8 the warlord's
// death (khazard_warlord.rs2), then Bolren queues the completion (king_bolren.rs2:83-100).
// Combat: every enemy is melee (quest_tree/configs/gnome_battlefield.npc), so Protect from Melee (prayer index 14)
// sets their damage to 0 (npc_combat_melee.rs2:44-45). Fire Bolt (Magic 35, max 12; Fire Blast at 59 with death runes, quest-lib fireSpell) kills the
// warlord (170 HP, no magic level). The prayer is on only near enemies: 43 points last 215 ticks (prayer.rs2:164-174).
// Non-melee hazard: Montai's catapult hits 0-3 near 2524,3238 (commander_montai.rs2:74-90).
// TREE_FROM=<stage> starts later (debug presets with varp 111 set).
import { openQuest, fireSpell } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const BOLREN = { x: 2542, z: 3169 };
// From the loose railing (2515,3161) to the king by the west side of the village (SDK path, maps/m39_49.jm2).
const TO_BOLREN = [{ x: 2529, z: 3165, tol: 2 }, { x: 2542, z: 3171, tol: 0 }];
const ELKOY_OUT = { x: 2504, z: 3191 };                    // elkoy, outside the maze (elkoy_entrance_coord 2504,3192)
const MONTAI = { x: 2523, z: 3211 };
const WALL = { x: 2509, z: 3253 };                         // khazzacklowwall, climbed from the south side
const DOOR = { x: 2502, z: 3250 };                         // khazard_stronghold_door, opens from the north side
const WARLORD = { x: 2457, z: 3302 };
const BATTLEFIELD: [number, number][] = [[2492, 3254], [2483, 3263]];
const BALLISTA = { x: 2508, z: 3210 };                     // catabow 3x3 (maps/m39_50.jm2 0 12 10)
const LADDER = { x: 2503, z: 3252 };                       // ladder up inside the stronghold (m39_50.jm2 0 7 52)
const CHEST = { x: 2506, z: 3259 };                        // chestclosed_khazard on level 1 (m39_50.jm2 1 10 59)
const ITEM = { logs: 1511, orb: 587, orbs: 588, amulet: 589, prayerPot: [2434, 139, 141, 143], food: 379 };
const PFM = 14;                                            // protect_from_melee (sdk PRAYER_INDICES)

const q = await openQuest({ cap: 3000, eatAt: 6, food: [ITEM.food] });
try {
    const FROM = Number(process.env.TREE_FROM ?? 0);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+tree gnome village/i) > 0) questDone = true; });
    const prayers = (): any => q.st()?.prayers;
    const pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM];
    const points = (): number => prayers()?.prayerPoints ?? 0;
    let potions = 0;
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    // A prayer potion when the points run low, then the prayer back on (it switches off at 0).
    const keepPrayer = async (): Promise<void> => {
        if (points() > 8) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (!pot) return;
        const p0 = points();
        potions++;
        await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2);
    };
    const named = (re: RegExp, near?: { x: number; z: number }, r = 6) => q.findLoc(l => re.test(l.name) && (!near || Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) <= r));
    const stage = (): number => FROM;  // the varp is not in the SDK state; stages are tracked by dialog text and items

    // 1. Bolren: "Can I help at all?", "I would be glad to help." (1); Elkoy then takes the player out of the maze.
    if (stage() < 1) {
        await q.talk('bolren 1', /^king bolren$/i, [/can i help at all/i, /i would be glad to help/i], () => q.sawText(/my assistant shall guide you out|out of the maze now/i) && q.cheb(ELKOY_OUT.x, ELKOY_OUT.z) <= 6, BOLREN, 80);
        q.milestone(1);
    }

    // 2-4. Montai: the wood (2), the six logs (3), the trackers (4).
    if (stage() < 4) {
        await q.walk('to montai', [{ x: MONTAI.x, z: MONTAI.z - 2, tol: 2 }]);
        if (stage() < 2) {
            await q.talk('montai 1', /^commander montai$/i, [/i'll gather some wood/i], () => q.sawText(/as quick as you can/i), MONTAI);
            q.milestone(2);
        }
        if (stage() < 3) {
            await q.talk('montai logs', /^commander montai$/i, [], () => !q.has(ITEM.logs), MONTAI);
            q.milestone(3);
        }
        await q.talk('montai 2', /^commander montai$/i, [/i'll try my best/i], () => q.sawText(/braver than most|blood spilled/i), MONTAI, 80);
        q.milestone(4);
    }

    // 5. The ballista, fixed coordinates: height 0004, x 0003, y 0005.
    if (stage() < 5) {
        await q.walk('to ballista', [{ x: BALLISTA.x + 3, z: BALLISTA.z + 1, tol: 1 }]);
        const bal = () => named(/ballista/i, BALLISTA, 4);
        if (!bal()) console.log(`WARN no ballista: ${q.locs().slice(0, 15).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`);
        let fired = false;
        for (let i = 0; i < 3 && !fired; i++) {
            await q.guard('ballista');
            const b = bal();
            if (!b) { await q.waitTicks(1); continue; }
            await q.opLoc(b, q.opIndex(b, /fire/i));
            const answers = [/^0004$/, /^0003$/, /^0005$/];
            let k = 0;
            for (let t = 0; t < 60 && !fired; t++) {
                const d: any = q.s.sdk.getDialog();
                if (d?.isOpen && !d.isWaiting) {
                    const opt = (d.options ?? []).find((o: any) => k < 3 && answers[k]!.test(o.text.trim()));
                    if (opt) { k++; void q.s.sdk.sendClickDialog(opt.index); }
                    else void q.s.sdk.sendClickDialog(0);
                }
                await q.waitTicks(1);
                if (q.sawText(/reduced to rubble/i)) fired = true;
                if (q.sawText(/you've missed the target/i)) break;
            }
        }
        if (!fired) await q.fail('ballista');
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(5);
    }

    // 6. Over the crumbled wall, the chest, out by the stronghold door (it opens from the north side).
    if (stage() < 6) {
        // The troopers (2502-2516,3233-3246) stand on the way: the prayer goes on before the walk through them.
        await setPfm(true);
        await q.walk('to wall', [{ x: WALL.x, z: WALL.z - 1, tol: 1 }]);
        const wall = () => q.findLoc(l => l.x === WALL.x && l.z === WALL.z && (l.optionsWithIndex ?? []).length > 0);
        await q.step('climb wall', () => { const w = wall(); return w ? q.opLoc(w, q.opIndex(w, /climb|cross/i)) : q.waitTicks(1); }, () => (q.pos()?.worldZ ?? 0) > WALL.z, 15, 4);
        await q.converse([], () => !q.dialogOpen(), 6);
        q.milestone('wall');
        // The wall room (x 2507-2512) opens west by a diagonal door (loc 1530 at 2505,3256, m39_50.jm2) to the ladder room.
        await q.walk('to inner door', [{ x: 2507, z: 3256, tol: 1 }]);
        await q.openDoor('inner door', 2505, 3256);
        await q.climb('ladder up', () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - LADDER.x), Math.abs(l.z - LADDER.z)) <= 2), /climb-up/i, () => q.lvl() === 1);
        const chest = () => named(/chest/i, CHEST, 2);
        if (!chest()) console.log(`WARN no chest: ${q.locs().slice(0, 15).map((l: any) => `${l.name}@${l.x},${l.z}`).join(' ')}`);
        await q.step('chest', async () => {
            const c = chest();
            if (!c) return q.waitTicks(1);
            await q.opLoc(c, q.opIndex(c, /search|open/i));
            await q.waitTicks(2);
            await q.converse([], () => !q.dialogOpen(), 6);
        }, () => q.has(ITEM.orb), 15, 5);
        q.milestone(6);
        await q.climb('ladder down', () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - LADDER.x), Math.abs(l.z - LADDER.z)) <= 3), /climb-down/i, () => q.lvl() === 0);
        await q.walk('to door', [{ x: DOOR.x, z: DOOR.z + 1, tol: 0 }]);
        const door = () => q.findLoc(l => l.x === DOOR.x && l.z === DOOR.z && (l.optionsWithIndex ?? []).some((o: any) => /open/i.test(o.text)));
        await q.step('door out', () => { const d = door(); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => (q.pos()?.worldZ ?? 9999) <= DOOR.z && q.lvl() === 0, 10, 4);
        await q.walk('away from stronghold', [{ x: DOOR.x, z: DOOR.z - 8, tol: 2 }]);
        await setPfm(false);
    }

    // 7. Back to Bolren through the maze with Elkoy; he keeps the orb and Elkoy takes the player out again.
    const elkoyIn = async (label: string): Promise<void> => {
        await q.walk(`to elkoy ${label}`, [{ x: ELKOY_OUT.x, z: ELKOY_OUT.z + 1, tol: 2 }]);
        await q.talk(`elkoy ${label}`, /^elkoy$/i, [/^yes please/i], () => q.cheb(2515, 3159) <= 4, ELKOY_OUT, 40);
        await q.converse([], () => !q.dialogOpen(), 8);
        // Elkoy drops the player at 2515,3159 south of the village fence; the loose railing (loc 2186 at 2515,3161,
        // gnomevillage_fence.rs2) is the way north into the village.
        await q.dash('to railing', 2515, 3160, 0, 10);
        const rail = () => q.findLoc(l => l.id === 2186 || /loose railing/i.test(l.name));
        await q.step('squeeze railing', () => { const r = rail(); return r ? q.opLoc(r, q.opIndex(r, /squeeze/i)) : q.waitTicks(1); }, () => (q.pos()?.worldZ ?? 0) >= 3161, 8, 4);
    };
    if (stage() < 7) {
        await elkoyIn('in 1');
        await q.walk('to bolren 2', TO_BOLREN);
        await q.talk('bolren 2', /^king bolren$/i, [/i will find the warlord/i], () => !q.has(ITEM.orb) && q.cheb(ELKOY_OUT.x, ELKOY_OUT.z) <= 6, BOLREN, 120);
        q.milestone(7);
    }

    // 8. The Khazard warlord: Protect from Melee, then the strongest fire spell every 5 ticks until he falls and the orbs are in the pack.
    if (stage() < 8) {
        // Prayer on from the south edge of the battlefield: a trooper hit the bot (HP 10 -> 8) at 2468,3270 in a test run.
        await q.walk('to battlefield', [{ x: 2504, z: 3226, tol: 3 }]);
        await setPfm(true);
        // The walk planner closes the battlefield for this account (deadly hunters, packages/core/src/danger.ts) and went
        // round by the north of West Ardougne to 2458,3325. Under the prayer the way is open: client-routed hops, as the
        // raw pathfinder runs it (corners 2492,3254 and 2483,3263).
        for (const [hx, hz] of BATTLEFIELD) await q.dash(`battlefield ${hx},${hz}`, hx, hz, 2, 30);
        await q.dash('to warlord', WARLORD.x + 1, WARLORD.z - 6, 2, 30);
        const wl = () => q.npc(/^khazard warlord$/i);
        if (!wl()) await q.waitUntil(() => !!wl(), 20);
        if (!wl()) await q.fail('no warlord');
        const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));
        const blocked0 = lastMsg(/already under attack/i);
        // A cast every 5 ticks (spell attack delay). A level-up page blocks the cast: it is clicked first, and the cast goes
        // the tick after it closes, not at the next fixed 5-tick slot (one test run lost about 300 ticks to that).
        let casts = 0;
        let lastCast = -99;
        for (let t = 0; t < 600 && !q.has(ITEM.orbs); t++) {
            await q.guard('warlord');
            if (q.dialogOpen()) { const d: any = q.s.sdk.getDialog(); if (!d.isWaiting) void q.s.sdk.sendClickDialog(0); }
            await keepPrayer();
            if (!pfmOn() && points() > 0) await setPfm(true);
            const n = wl();
            if (n && !q.dialogOpen() && q.T() - lastCast >= 5) { casts++; lastCast = q.T(); await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId(fireSpell(q.s.sdk.getSkill('Magic')?.level ?? 1, id => q.has(id))), reason: 'SDK' }); }
            if (lastMsg(/do not have enough/i) > blocked0) await q.fail('out of runes');
            await q.waitTicks(1);
        }
        if (!q.has(ITEM.orbs)) await q.fail('warlord: no orbs');
        await q.converse([], () => !q.dialogOpen(), 8);
        console.log(`NOTE warlord down at ${q.T()} casts=${casts} prayer=${points()} potions=${potions}`);
        q.milestone(8);
        for (const [hx, hz] of [...BATTLEFIELD].reverse()) await q.dash(`back ${hx},${hz}`, hx, hz, 2, 30);
        await q.dash('back to battlefield edge', 2504, 3226, 3, 30);
        await setPfm(false);
    }

    // 9. Elkoy again, then Bolren takes the orbs and queues the completion.
    await elkoyIn('in 2');
    await q.walk('to bolren 3', TO_BOLREN);
    await q.talk('bolren 3', /^king bolren$/i, [], () => !q.has(ITEM.orbs) && (questDone || q.has(ITEM.amulet)), BOLREN, 120);
    await q.waitUntil(() => questDone, 20);
    q.milestone('complete');
    offDone();
    await q.end(questDone && q.has(ITEM.amulet), `qp=2 amulet=${q.has(ITEM.amulet)} questMsg=${questDone} potions=${potions} prayerLeft=${points()}`);

} catch (e) { await q.fail(String(e)); }
