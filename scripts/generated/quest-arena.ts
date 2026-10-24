// Fight Arena from preset quest_arena (beside Lady Servil), at the planner's state for the rival-fight-arena row:
// Attack 94, Magic 99, Prayer 43, Strength, Defence 1, 10 HP. Reward: 1,000 coins, 121,750 Attack and 21,750 Thieving
// (x25: 304,375 and 54,375), 2 QP (quest_arena.rs2 arena_quest_complete). Paths below are under
// vendor/rs-sdk/server/content/scripts/quests/quest_arena/.
// Varp %arenaquest (17, quest_arena.constant): 1 Lady Servil; 2 the chest (2613,3189) gives the Khazard helmet and
// armour; 3 the guard at 2615,3141 (arena_guard2) wants a drink; the barman (2566,3140) sells a Khali brew at stage 3+
// (khazard_barman.rs2); 5 the guard drinks it and gives the cell keys (khazard_guard.rs2:110-125); 6 the keys on
// Jeremy's cell door (2617,3167) put the player in the arena with the ogre (jeremy_servil.rs2:57-93); 8 the ogre dies;
// General Khazard sends the player to the cells (9, general_khazard.rs2:233-270); Hengrad (2598,3142) calls the guard
// and the scorpion comes (hengrad.rs2:1-70); 10 the scorpion dies, Khazard brings Bouncer; 11 Bouncer dies; 12 Khazard
// frees the Servils and attacks. Lady Servil at 12 queues the completion (lady_servil.rs2:14-19). Khazard himself
// (13) is not needed.
// Combat: the ogre, scorpion, Bouncer and Khazard are melee (configs/quest_arena.npc), so Protect from Melee (prayer
// index 14) sets their damage to 0 (npc_combat_melee.rs2:44-45). Fire Wave (Magic 75, max 20, staff of fire) every 5 ticks.
// The doors: fightarena_door1 (2617,3171 and 2585,3141) opens from the inside tile; from outside the guard lets a
// player in Khazard armour through (quest_arena.rs2:33-52).
// ARENA_FROM=<stage> starts later (debug presets with varp 17 set).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const SERVIL = { x: 2566, z: 3199 };
const CHEST = { x: 2613, z: 3189 };                         // arena_guard_chest_shut (75), forceapproach north
const DOOR_N = { x: 2617, z: 3171 };                        // fightarena_door1, north wall of the inside tile
const DOOR_W = { x: 2585, z: 3141 };                        // fightarena_door1, west wall of the inside tile
const GUARD2 = { x: 2615, z: 3141 };                        // arena_guard2 (254), the drunk guard
const BARMAN = { x: 2566, z: 3140 };
const CELL = { id: 80, x: 2617, z: 3167 };                  // arena_jeremydoor
const HENGRAD = { x: 2598, z: 3142 };
const ARENA_DOOR = { x: 2606, z: 3152 };                    // fightarena_door2
const ITEM = { helmet: 74, armour: 75, keys: 76, brew: 77, prayerPot: [2434, 139, 141, 143], food: 379, coins: 995 };
const NPC = { guard2: 254 };
const PFM = 14;                                             // protect_from_melee (sdk PRAYER_INDICES)
const WAVE = componentId('magic:fire_wave');

const q = await openQuest({ cap: 2500, eatAt: 6, food: [ITEM.food] });
try {
    const FROM = Number(process.env.ARENA_FROM ?? 0);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+fight arena/i) > 0) questDone = true; });
    const prayers = (): any => q.st()?.prayers;
    const pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM];
    const points = (): number => prayers()?.prayerPoints ?? 0;
    let potions = 0, casts = 0;
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on || (on && points() <= 0)) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    const keepPrayer = async (): Promise<void> => {
        if (points() > 8) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (!pot) return;
        const p0 = points();
        potions++;
        await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2);
    };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const wear = async (id: number): Promise<void> => {
        if (worn(id)) return;
        await q.step(`wear ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => worn(id), 3, 3);
    };
    const npcId = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    // Talk-to an NPC found by type id (several Khazard Guard types share the name), then pages until ok().
    const talkId = async (label: string, id: number, pats: RegExp[], ok: () => boolean, maxTicks = 60): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = npcId(id);
            if (!n) await q.fail(`${label}: no npc ${id}`);
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 25);
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 3; }, maxTicks);
            if (ok()) return;
        }
        await q.fail(`talk ${label}`);
    };
    const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));
    // A door that may open after a guard's pages: click it, then pages, until through().
    const doorThrough = async (label: string, d: { x: number; z: number }, through: () => boolean): Promise<void> => {
        for (let i = 0; i < 4 && !through(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const l = q.findLoc(l => l.x === d.x && l.z === d.z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)));
            if (l) await q.opLoc(l, q.opIndex(l, /^open$/i));
            await q.converse([], () => through(), 25);
        }
        if (!through()) await q.fail(label);
    };
    // Fire Wave every 5 ticks on the NPC until it is gone (dead) or done() holds; Protect from Melee kept on.
    // Fire Wave every 5 ticks on the NPC until it is gone (dead) or done() holds; Protect from Melee kept on. The
    // ogre, scorpion and Bouncer come out of cages on the arena's east side (gates at x 2606, arena_inactivegate,
    // spawns 2607,3159 / 3162 / 3165, quest_arena.rs2 arena_release_*): a cast while one is still inside sent the bot
    // walking into the gate for line of sight, the gate shut behind it after 6 ticks, and every later cast was
    // cant_reach (proof run p1). So the bot casts only once the NPC's tile is west of x 2606. Each cage also holds a
    // static spawn (2608,3159 / 3162 / 3165, maps/m40_49.jm2); when one is out of its cage the cutscene sends it at the
    // player and adds another (jeremy_servil.rs2:95-111), so the target is the one attacking the player, else the
    // nearest one out ("I'm already under attack!" for 300 ticks in a test run that cast on the wrong ogre).
    const target = (re: RegExp): any => {
        const all: any[] = (q.st()?.nearbyNpcs ?? []).filter((n: any) => re.test(n.name) && n.distance <= 20).sort((a: any, b: any) => a.distance - b.distance);
        // Any NPC already on the player first (a scorpion left out by an earlier run attacked during the ogre fight).
        const foe = (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.targetIndex >= 32768 && n.distance <= 10 && !/servil/i.test(n.name)).sort((a: any, b: any) => a.distance - b.distance)[0];
        return foe ?? all.find(n => (n.tileX ?? n.x) <= 2605);
    };
    const fight = async (label: string, re: RegExp, done: () => boolean, maxTicks = 300, retrigger = false): Promise<void> => {
        const t0 = q.T();
        const runes0 = lastMsg(/do not have enough/i);
        const mxp0 = q.xp('Magic');
        let lastCast = -99, gone = 0, seen = false, firstCast = -1;
        let blocked = lastMsg(/already under attack/i);
        let forced = -1, lastTarget = -1;
        let waiting = 0;
        for (let t = 0; t < maxTicks && !done(); t++) {
            await q.guard(label);
            if (q.dialogOpen()) { const d: any = q.s.sdk.getDialog(); if (!d.isWaiting) void q.s.sdk.sendClickDialog(0); }
            await keepPrayer();
            if (!pfmOn() && points() > 0) await setPfm(true);
            const ua = lastMsg(/already under attack/i);
            if (ua > blocked) {
                blocked = ua;
                const near: any[] = (q.st()?.nearbyNpcs ?? []).filter((x: any) => x.distance <= 10);
                console.log(`WARN under attack at ${q.T()}: ${near.map((x: any) => `${x.name}@${x.tileX ?? x.x},${x.tileZ ?? x.z} t=${x.targetIndex} c=${x.inCombat}`).join('; ')}`);
                // The attacker is a melee NPC beside the bot that is not the last target: cast on it instead.
                const foe = near.filter((x: any) => x.distance <= 2 && x.index !== lastTarget && !/servil|hengrad/i.test(x.name)).sort((x: any, y: any) => (re.test(y.name) ? 1 : 0) - (re.test(x.name) ? 1 : 0) || x.distance - y.distance)[0];
                if (foe) forced = foe.index;
            }
            const f = forced >= 0 ? (q.st()?.nearbyNpcs ?? []).find((x: any) => x.index === forced) : undefined;
            if (forced >= 0 && !f) forced = -1;
            const n = f ?? target(re);
            if (!n) {
                if (seen && ++gone >= 4) break;
                // No fighter out after 20 ticks: Jeremy's talk at stages 9 and 10 runs the cage release again
                // (jeremy_servil.rs2:39-44; the scorpion stayed in its cage for 300 ticks in proof run r3).
                if (!seen && retrigger && ++waiting % 20 === 0 && waiting <= 60) {
                    const j = q.npc(/^jeremy servil$/i);
                    console.log(`WARN ${label}: none out at ${q.T()}, talking to Jeremy (${j ? `${j.x},${j.z}` : 'not seen'})`);
                    if (j) { await q.talkTo(j); await q.waitUntil(() => q.dialogOpen(), 15); await q.converse([], () => !q.dialogOpen(), 20); }
                }
                await q.waitTicks(1); continue;
            }
            gone = 0;
            if (!q.dialogOpen() && q.T() - lastCast >= 5) {
                seen = true; casts++; lastCast = q.T(); if (firstCast < 0) firstCast = q.T();
                lastTarget = n.index;
                await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: WAVE, reason: 'SDK' });
            }
            if (firstCast >= 0 && q.T() - firstCast > 60 && q.xp('Magic') === mxp0) await q.fail(`${label}: no cast landed`);
            if (lastMsg(/do not have enough/i) > runes0) await q.fail('out of runes');
            await q.waitTicks(1);
        }
        console.log(`NOTE ${label} ${q.T() - t0} ticks casts=${casts} prayer=${points()} potions=${potions} hp=${q.hp()}`);
        if (!done() && (target(re) || !seen)) await q.fail(`${label}: not dead`);
    };
    const inArena = (): boolean => { const p = q.pos(); return !!p && p.worldX >= 2581 && p.worldX <= 2606 && p.worldZ >= 3151 && p.worldZ <= 3171; };

    // 1. Lady Servil: "Can I help you?".
    if (FROM < 1) {
        await q.talk('servil 1', /^lady servil$/i, [/can i help you/i], () => q.sawText(/i'll be waiting here for you|reward you handsomely/i), SERVIL, 60);
        q.milestone(1);
    }

    // 2. The chest in the guards' house: Open, then Search (helmet and armour), and wear both.
    if (FROM < 2) {
        await q.walk('to chest', [{ x: CHEST.x, z: CHEST.z + 1, tol: 0 }]);
        await q.step('chest', async () => {
            const c = q.findLoc(l => l.x === CHEST.x && l.z === CHEST.z && /chest/i.test(l.name));
            if (!c) return q.waitTicks(1);
            await q.opLoc(c, q.opIndex(c, /search|open/i));
            await q.waitTicks(2);
            await q.converse([], () => !q.dialogOpen(), 6);
        }, () => q.has(ITEM.helmet) && q.has(ITEM.armour), 12, 5);
        q.milestone(2);
    }
    if (q.has(ITEM.helmet)) await wear(ITEM.helmet);
    if (q.has(ITEM.armour)) await wear(ITEM.armour);

    // 3. In by the north door (the guard lets a Khazard guard through), the guard by the south cells.
    if (FROM < 6) {
        if ((q.pos()?.worldZ ?? 0) > DOOR_N.z) {
            await q.walk('to north door', [{ x: DOOR_N.x, z: DOOR_N.z + 1, tol: 0 }]);
            await doorThrough('north door', DOOR_N, () => (q.pos()?.worldZ ?? 9999) <= DOOR_N.z);
        }
        // The east corridor (x 2617, z 3151-3171) is walked with client-routed clicks: walkPath takes the cell doors
        // beside it (arena_prisondoor 2617,3159 and 2617,3163, Jeremy's 2617,3167; west walls, maps/m40_49.jm2) for
        // doors on its way and clicks them ("The cell gate is securely locked", 79-89 idle ticks a time in test runs;
        // blockDoorTemporarily did not stop it). South of z 3151 walkPath opens the real doors (loc_1533 2616,3147,
        // loc_1530 2609,3143), where a client-routed click stops.
        const toGuard2 = async () => {
            if ((q.pos()?.worldZ ?? 0) > 3151) await q.dash('corridor south', 2617, 3151, 0, 30);
            await q.walk('to guard', [{ x: GUARD2.x, z: GUARD2.z + 2, tol: 2 }]);
        };
        if (FROM < 3) {
            await toGuard2();
            await talkId('guard 1', NPC.guard2, [], () => q.sawText(/fall asleep/i));
            q.milestone(3);
        }
        // 4. The barman, out by the west door (free from the inside tile), back in past the guard there.
        if (!q.has(ITEM.brew) && !q.has(ITEM.keys)) {
            await q.walk('to west door', [{ x: DOOR_W.x, z: DOOR_W.z, tol: 0 }]);
            await doorThrough('west door out', DOOR_W, () => (q.pos()?.worldX ?? 0) < DOOR_W.x);
            await q.walk('to barman', [{ x: BARMAN.x + 1, z: BARMAN.z + 1, tol: 2 }]);
            await q.talk('barman', /^khazard barman$/i, [/khali brew/i], () => q.has(ITEM.brew), BARMAN, 40);
            q.milestone(4);
            await q.walk('back to west door', [{ x: DOOR_W.x - 1, z: DOOR_W.z, tol: 0 }]);
            await doorThrough('west door in', DOOR_W, () => (q.pos()?.worldX ?? 0) >= DOOR_W.x);
        }
        // 5. The brew for the cell keys.
        if (!q.has(ITEM.keys)) {
            await toGuard2();
            await talkId('guard 2', NPC.guard2, [], () => q.has(ITEM.keys), 80);
            q.milestone(5);
        }
        // 6. The keys on Jeremy's cell door; the server walks the player into the arena and lets the ogre out.
        await q.walk('to corridor', [{ x: 2617, z: 3151, tol: 0 }]);
        await q.dash('to cell', CELL.x, CELL.z, 0, 30);
        await setPfm(true);
        await q.step('keys on cell', () => q.useOnLoc(ITEM.keys, CELL), () => inArena() || q.sawText(/i have the keys/i), 15, 4);
        await q.converse([], () => inArena(), 60);
        if (!inArena()) await q.fail('not in the arena');
        q.milestone(6);
    }

    // 8. The ogre; Khazard's pages, then the cells.
    const inCells = (): boolean => { const p = q.pos(); return !!p && p.worldZ <= 3146 && p.worldX >= 2586 && p.worldX <= 2604; };
    if (FROM < 9) {
        await setPfm(true);
        await q.converse([], () => !!q.npc(/^khazard ogre$/i) && !q.dialogOpen(), 20);
        await fight('ogre', /^khazard ogre$/i, () => inCells());
        q.milestone(8);
        await q.converse([], () => inCells() && !q.dialogOpen(), 60);
        if (!inCells()) await q.fail('not in the cells');
        q.milestone(9);
    }

    // 10-11. Hengrad calls the guard; the scorpion, then Bouncer.
    if (FROM < 12) {
        // Off while in the cells if a page lets it (a level-up or the guard's page can hold it).
        if (pfmOn()) { await q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }); await q.waitTicks(1); }
        if (inCells()) {
            await q.talk('hengrad', /^hengrad$/i, [], () => inArena(), HENGRAD, 80, true);
            await q.converse([], () => !q.dialogOpen(), 20);
        }
        if (!inArena()) await q.fail('not back in the arena');
        await setPfm(true);
        const t0 = q.T();
        await q.waitUntil(() => !!q.npc(/^khazard scorpion$/i), 20);
        await fight('scorpion', /^khazard scorpion$/i, () => false, 300, true);
        q.milestone(10);
        await q.converse([], () => !!q.npc(/^bouncer$/i) && !q.dialogOpen(), 30);
        await fight('bouncer', /^bouncer$/i, () => false, 300, true);
        q.milestone(11);
        // Khazard's pages; the last one frees the Servils (12) and he attacks.
        await q.converse([], () => q.sawText(/at least have the pleasure of killing you/i) && !q.dialogOpen(), 40);
        console.log(`NOTE arena fights ${q.T() - t0} ticks`);
        q.milestone(12);
    }

    // Out by the arena door (from the inside it opens and moves the player out, quest_arena.rs2:125-136), north to Servil.
    await setPfm(true);
    if (inArena()) {
        await q.walk('to arena door', [{ x: ARENA_DOOR.x - 1, z: ARENA_DOOR.z + 1, tol: 0 }]);
        await doorThrough('arena door', ARENA_DOOR, () => !inArena());
    }
    // From the arena door (out at 2607,3151) east past the open loc_1530 at 2613,3150 and up the corridor. The north
    // door opens from its own tile; a click from outside (z 3172) after stage 12 makes the guard attack
    // (khazard_guard_generals_pet), so the bot never steps back.
    if (points() < 20) { const pot = ITEM.prayerPot.find(id => q.has(id)); if (pot) { potions++; await q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }); } }
    if ((q.pos()?.worldZ ?? 0) <= DOOR_N.z) {
        if ((q.pos()?.worldX ?? 0) < 2616) {
            await q.openDoor('door 2613,3150', 2613, 3150);
            await q.dash('to corridor', 2617, 3151, 0, 30);
        }
        await q.dash('corridor north', DOOR_N.x, DOOR_N.z, 0, 30);
        await doorThrough('north door out', DOOR_N, () => (q.pos()?.worldZ ?? 0) > DOOR_N.z);
    }
    await q.walk('to servil', [{ x: SERVIL.x, z: SERVIL.z - 2, tol: 3 }]);
    if (pfmOn()) await q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' });
    await q.talk('servil 2', /^lady servil$/i, [], () => questDone, SERVIL, 60);
    await q.waitUntil(() => questDone, 10);
    q.milestone('complete');
    offDone();
    await q.end(questDone, `qp=2 questMsg=${questDone} casts=${casts} potions=${potions} prayerLeft=${points()}`);

} catch (e) { await q.fail(String(e)); }
