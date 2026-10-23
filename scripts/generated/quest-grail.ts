// Holy Grail from preset quest_grail (beside King Arthur in Camelot), at the planner's state for the grail row: every
// skill 99 (after the last 99), Merlin's Crystal done, Excalibur in the pack, nothing worn. Reward: 2 QP, 110,000
// Prayer and 153,000 Defence before 25x (quest_grail.rs2 grail_quest_complete).
// Varp %grail (5, quest_grail.constant): 2 King Arthur (king_arthur.rs2 grailstart), 3 Merlin in his workshop
// (merlin.rs2; the workshop door merlinworkshop spawns him), 4 the crone (high_priest_of_entrana.rs2 spawns her),
// 8 the Fisher King (fisher_king.rs2 fisher_king_well), 9 the whistle given to Sir Percival (sir_percival.rs2),
// then King Arthur queues the completion with the Holy Grail in the pack.
// Route: Camelot (Arthur, Merlin on level 1); Falador teleport, Port Sarim, Excalibur dropped (no weapons on Entrana),
// the ship to Entrana, the High Priest and the crone, back, Excalibur picked up; Camelot teleport, Galahad (the holy
// table napkin); Falador teleport, Draynor Manor level 2, the whistle door (whistles spawn while the napkin is in the
// pack); Camelot teleport, Ardougne docks, the ship to Brimhaven, the whistle at 2740-2743,3234-3237 to the Fisher
// Realm; the fisherman (the bell), the Black Knight Titan (Excalibur worn, black_knight_titan.rs2 defeat_titan), the
// bell into the castle, the Fisher King on level 1; the whistle back; Falador teleport, the Goblin Village sacks,
// Sir Percival; Camelot teleport, Ardougne, Brimhaven, the whistle to the restored realm, the Holy Grail (level 2);
// the whistle back; Camelot teleport, King Arthur.
// Helper items (tradeable): 100 coins, runes. HG_FROM=<milestone> starts later (debug presets); HG_STOP ends early.
import { openQuest } from './quest-lib';

const ARTHUR = { x: 2764, z: 3515 };
const MERLIN_DOOR = { x: 2764, z: 3503 };                 // level 1, merlinworkshop 24 (maps/m43_54.jm2 1 12 47)
const MERLIN = { x: 2767, z: 3500 };                      // level 1 (quest_grail.rs2 npc_add 1_43_54_15_44)
const SARIM_MONK = { x: 3046, z: 3234 };
const PRIEST = { x: 2851, z: 3349 };
const ENTRANA_MONK = { x: 2835, z: 3336 };
const GALAHAD = { x: 2612, z: 3474 };
const MANOR_DOOR = { x: 3108, z: 3353 };                  // haunteddoorl 134 (maps/m48_52.jm2 0 36 25)
const WHISTLE_DOOR = { x: 3106, z: 3361 };                // level 2, whistledoor 22 (maps/m48_52.jm2 2 34 33)
const BARNABY = { x: 2679, z: 3275 };
const CROSSING = { x: 2742, z: 3235 };                    // whistle zone 0_42_50_52_34 .. 0_42_50_55_37
const FISHERMAN = { x: 2802, z: 4706 };                   // maps/m43_73.jm2 0 50 34
const TITAN = { x: 2791, z: 4722 };                       // maps/m43_73.jm2 0 39 50
const BELL = { x: 2762, z: 4694 };                        // grail_fisherman.rs2 obj_add 0_43_73_10_22
const FISHER_KING = { x: 2762, z: 4688 };                 // level 1, maps/m43_73.jm2 1 10 16
const SACKS = { x: 2960, z: 3507 };                       // percy_sacks 23 (maps/m46_54.jm2 0 16 51)
const GRAIL = { x: 2649, z: 4684 };                       // level 2, maps/m41_73.jm2 obj 2 25 12
const ITEM = { excalibur: 35, scimitar: 1333, napkin: 15, whistle: 16, bell: 17, grail: 19, coins: 995, food: 379 };
const NPC = { titan: 221 };
const PFM = 14;

const q = await openQuest({ cap: 5000, eatAt: 60, food: [ITEM.food], lumbridgeOk: false });
try {
    const FROM = Number(process.env.HG_FROM || 0);
    const STOP = Number(process.env.HG_STOP || 99);
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+holy grail/i) > 0) questDone = true; });
    const ms = async (k: number): Promise<void> => { q.milestone(k); if (k >= STOP) await q.end(true, `stopped at ${k}`); };
    const tele = (label: string, comp: string, x: number, z: number) => q.teleport(label, comp, x, z);
    // Protect from Melee 14, Ultimate Strength 10, Incredible Reflexes 11 (skill_prayer/configs/prayers.dbrow order).
    const prayOn = (i: number): boolean => !!q.st()?.prayers?.activePrayers?.[i];
    const setPrayer = async (i: number, on: boolean): Promise<void> => {
        if (prayOn(i) === on) return;
        await q.step(`prayer ${i} ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: i, reason: 'SDK' }), () => prayOn(i) === on, 3, 3);
    };
    const setPfm = async (on: boolean): Promise<void> => {
        for (const i of [PFM, 10, 11]) if (prayOn(i) !== on) await q.s.direct({ type: 'togglePrayer', prayerIndex: i, reason: 'SDK' });
        await q.waitUntil(() => [PFM, 10, 11].every(i => prayOn(i) === on), 3);
        for (const i of [PFM, 10, 11]) await setPrayer(i, on);
    };
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const stairs = (re: RegExp, at: { x: number; z: number }, r = 8) => () => q.findLoc(l => /stair|ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= r && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const listLocs = (r = 6) => q.locs().filter((l: any) => l.distance <= r).map((l: any) => `${l.name}#${l.id}@${l.x},${l.z}:${(l.optionsWithIndex ?? []).map((o: any) => o.text).join('/')}`).join(' ');
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => (a.distance ?? 0) - (b.distance ?? 0))[0];
    const pickUp = async (label: string, id: number, n = 1): Promise<void> => {
        const want = q.cnt(id) + n;
        await q.step(label, () => { const g = ground(id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.cnt(id) >= want, 10, 5);
    };
    const worn = (id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const wield = async (id: number): Promise<void> => {
        if (worn(id)) return;
        await q.step('wield', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => worn(id), 3, 3);
    };
    const gangplank = () => q.findLoc(l => /gangplank/i.test(l.name) && (l.optionsWithIndex ?? []).length > 0 && l.distance <= 8);
    // A ship NPC: the dialog, the journey interface, then the deck (level 1) at `deck`; the gangplank down.
    const sail = async (label: string, re: RegExp, pats: RegExp[], at: { x: number; z: number }, deck: { x: number; z: number }): Promise<void> => {
        await q.talk(label, re, pats, () => q.near(deck.x, deck.z, 6), at, 60);
        await q.converse([], () => !q.dialogOpen(), 6);
        if (q.lvl() === 1) await q.climb(`${label} disembark`, gangplank, /cross|walk|disembark/i, levelIs(0), 4);
    };
    // The whistle (iop1 Blow): Karamja to the realm or back (quest_grail.rs2 opheld1 magic_whistle).
    const blow = async (label: string, arrived: () => boolean): Promise<void> => {
        await q.step(label, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.whistle)!, optionIndex: 1, reason: 'SDK' }), arrived, 6, 3);
    };
    const inRealm = () => (q.pos()?.worldZ ?? 0) > 4600;
    const toRealm = async (label: string): Promise<void> => {
        await tele(`${label} camelot teleport`, 'magic:camelot_teleport', 2757, 3478);
        await q.walk(`${label} to barnaby`, [{ x: BARNABY.x, z: BARNABY.z + 1, tol: 2 }]);
        await sail(`${label} barnaby`, /^captain barnaby$/i, [/^yes please/i], BARNABY, { x: 2775, z: 3234 });
        await q.walk(`${label} to crossing`, [{ x: CROSSING.x, z: CROSSING.z, tol: 0 }]);
        await blow(`${label} whistle`, inRealm);
    };

    // 1. King Arthur: the grail quest (%grail 2).
    if (FROM < 1) {
        await q.talk('arthur', /^king arthur$/i, [/tell me of this quest/i, /enjoy trying that/i], () => q.sawText(/next to the library/i), ARTHUR, 40);
        await ms(1);
    }
    // 2. Merlin: the workshop door on level 1 spawns him (%grail 3).
    if (FROM < 2) {
        if (q.lvl() === 0) {
            await q.walk('to camelot stairs', [{ x: 2752, z: 3510, tol: 1 }]);
            await q.climb('camelot stairs up', stairs(/climb-up/i, { x: 2750, z: 3510 }, 3), /climb-up/i, levelIs(1));
        }
        await q.walk('to workshop door', [{ x: MERLIN_DOOR.x, z: MERLIN_DOOR.z, tol: 0 }]);
        const door = () => q.findLoc(l => l.id === 24 && l.x === MERLIN_DOOR.x && l.z === MERLIN_DOOR.z) ?? { id: 24, x: MERLIN_DOOR.x, z: MERLIN_DOOR.z };
        await q.step('workshop door in', () => q.opLoc(door(), 1), () => (q.pos()?.worldX ?? 0) > MERLIN_DOOR.x, 6, 4);
        await q.talk('merlin', /^merlin$/i, [/thank you for the advice/i], () => q.sawText(/speaking to sir galahad/i), MERLIN, 40);
        await q.dash('to workshop door inside', MERLIN_DOOR.x + 1, MERLIN_DOOR.z, 0, 10);
        await q.step('workshop door out', () => q.opLoc(door(), 1), () => (q.pos()?.worldX ?? 99999) <= MERLIN_DOOR.x, 6, 4);
        await q.walk('to camelot stairs top', [{ x: 2752, z: 3511, tol: 1 }]);
        await q.climb('camelot stairs down', stairs(/climb-down/i, { x: 2750, z: 3511 }, 3), /climb-down/i, levelIs(0));
        await ms(2);
    }
    // 3. Entrana: Excalibur stays on the Port Sarim dock (300 ticks, drop.rs2); the High Priest spawns the crone
    // (%grail 4).
    if (FROM < 3) {
        if (FROM < 2) await tele('falador teleport', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to sarim monks', [{ x: SARIM_MONK.x, z: SARIM_MONK.z + 3, tol: 1 }]);
        const dropAt = { x: q.pos()!.worldX, z: q.pos()!.worldZ };
        for (const id of [ITEM.excalibur, ITEM.scimitar]) if (q.has(id)) await q.step(`drop ${id}`, () => q.s.sdk.sendDropItem(q.slot(id)!), () => !q.has(id), 4, 3);
        await sail('entrana monk', /^monk of entrana$/i, [/ready to go/i], SARIM_MONK, { x: 2834, z: 3331 });
        await q.walk('to high priest', [{ x: PRIEST.x, z: PRIEST.z - 1, tol: 2 }]);
        await q.talk('priest', /^high priest( of entrana)?$/i, [/ok,? i will go searching/i], () => q.sawText(/good luck with that/i), PRIEST, 60);
        await q.walk('to entrana monks', [{ x: ENTRANA_MONK.x, z: ENTRANA_MONK.z + 2, tol: 2 }]);
        await sail('leave entrana', /^monk of entrana$/i, [/yes,? i'm ready to go/i], ENTRANA_MONK, { x: 3048, z: 3231 });
        if (!ground(ITEM.excalibur)) await q.walk('to excalibur', [{ x: dropAt.x, z: dropAt.z, tol: 3 }]);
        await pickUp('take excalibur', ITEM.excalibur);
        if (ground(ITEM.scimitar)) await pickUp('take scimitar', ITEM.scimitar);
        await wield(q.has(ITEM.scimitar) ? ITEM.scimitar : ITEM.excalibur);
        await ms(3);
    }
    // 4. Galahad, west of McGrubor's Wood: the holy table napkin.
    if (FROM < 4) {
        await tele('camelot teleport 1', 'magic:camelot_teleport', 2757, 3478);
        await q.walk('to galahad', [{ x: GALAHAD.x + 1, z: GALAHAD.z, tol: 2 }]);
        await q.talk('galahad', /^galahad$/i, [/item from the realm of the fisher king/i], () => q.has(ITEM.napkin) && q.sawText(/cup of tea/i), GALAHAD, 60);
        await ms(4);
    }
    // 5. Draynor Manor level 2: the whistle door spawns two whistles while the napkin is in the pack.
    if (FROM < 5) {
        if (FROM < 4) await tele('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to manor door', [{ x: MANOR_DOOR.x, z: MANOR_DOOR.z - 1, tol: 0 }]);
        const front = () => q.findLoc(l => l.id === 134 && l.x === MANOR_DOOR.x && l.z === MANOR_DOOR.z) ?? { id: 134, x: MANOR_DOOR.x, z: MANOR_DOOR.z };
        await q.step('manor door', () => q.opLoc(front(), 1), () => (q.pos()?.worldZ ?? 0) > MANOR_DOOR.z, 6, 4);
        await q.walk('to manor stairs', [{ x: 3108, z: 3362, tol: 1 }]);
        await q.climb('manor stairs', stairs(/walk-up|climb-up/i, { x: 3108, z: 3363 }, 3), /walk-up|climb-up/i, levelIs(1));
        await q.walk('to spiral stairs', [{ x: 3104, z: 3364, tol: 2 }]);
        await q.climb('spiral stairs', stairs(/climb-up/i, { x: 3104, z: 3362 }, 3), /climb-up/i, levelIs(2));
        await q.walk('to whistle door', [{ x: WHISTLE_DOOR.x, z: WHISTLE_DOOR.z + 1, tol: 0 }]);
        const wdoor = () => q.findLoc(l => l.id === 22 && l.x === WHISTLE_DOOR.x && l.z === WHISTLE_DOOR.z) ?? { id: 22, x: WHISTLE_DOOR.x, z: WHISTLE_DOOR.z };
        await q.step('whistle door', () => q.opLoc(wdoor(), 1), () => !!ground(ITEM.whistle), 6, 4);
        await pickUp('whistle 1', ITEM.whistle);
        await pickUp('whistle 2', ITEM.whistle);
        await ms(5);
    }
    // 6. The Fisher Realm: the fisherman's bell, the Black Knight Titan, the castle, the Fisher King (%grail 8).
    if (FROM < 6) await toRealm('realm 1');
    if (FROM < 7) {
        // The rune scimitar (speed 4, slash 45, strength 44) does the damage; Excalibur goes on at 20 HP or less (the
        // scimitar's max hit with Ultimate Strength is 20), so it is worn when the Titan dies (defeat_titan).
        if (q.has(ITEM.scimitar)) await wield(ITEM.scimitar);
        await setPfm(true);
        const titan = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => n.id === NPC.titan);
        const beaten = () => q.msgCount(/defeated the black knight titan/i) > 0;
        await q.walk('to titan', [{ x: TITAN.x + 2, z: TITAN.z, tol: 1 }]);
        for (let t = 0; t < 300 && !beaten(); t++) {
            await q.guard('titan');
            const n = titan();
            if (n && typeof n.hp === 'number' && n.hp <= 20 && !worn(ITEM.excalibur)) await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.excalibur)!, optionIndex: 2, reason: 'SDK' });
            if (q.dialogOpen()) await q.s.sdk.sendClickDialog(0);
            else if (n && t % 4 === 0 && q.pos()?.combat?.targetIndex !== n.index) await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
            if (process.env.HG_DEBUG && t % 5 === 0) console.log(`TITAN t=${t} hp=${n?.hp} d=${n?.distance} tgt=${q.pos()?.combat?.targetIndex} exc=${worn(ITEM.excalibur)} anim=${q.pos()?.animId ?? ''} me=${q.pos()?.worldX},${q.pos()?.worldZ} pray=${[PFM, 10, 11].map(prayOn).join('/')}`);
            await q.waitTicks(1);
        }
        if (!beaten()) await q.fail('titan');
        if (!worn(ITEM.excalibur)) await wield(ITEM.excalibur);
        q.milestone('6titan');
        await setPfm(false);
        await q.talk('fisherman', /^fisherman$/i, [/how to get into the castle/i], () => !!ground(ITEM.bell) || q.sawText(/always bells there/i), FISHERMAN, 40);
        await q.walk('to bell', [{ x: BELL.x, z: BELL.z, tol: 1 }]);
        await pickUp('take bell', ITEM.bell);
        // The bell works only with a grail maiden (she wanders inside the wall) within 4 tiles (opheld1 grail_bell).
        const maidenNear = () => (q.st()?.nearbyNpcs ?? []).some((n: any) => /grail maiden/i.test(n.name) && q.near(n.x, n.z, 3));
        const inside = () => q.near(2761, 4692, 1);
        for (let t = 0; t < 80 && !inside(); t++) {
            await q.guard('ring bell');
            if (q.dialogOpen()) await q.s.sdk.sendClickDialog(0);
            else if (maidenNear() || t % 10 === 9) await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.bell)!, optionIndex: 1, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!inside()) await q.fail(`ring bell: maidens ${(q.st()?.nearbyNpcs ?? []).filter((n: any) => /maiden/i.test(n.name)).map((n: any) => `${n.x},${n.z}`).join(' ')}`);
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone('6castle');
        await q.walk('to castle stairs', [{ x: 2761, z: 4682, tol: 2 }]);
        await q.climb('castle stairs', stairs(/climb-up/i, { x: 2761, z: 4680 }, 3), /climb-up/i, levelIs(1));
        // The king's room: door 1530 at 2766,4684 (west wall), then the diagonal door 1530 at 2766,4688
        // (maps/m43_73.jm2 1 14 12 and 1 14 16); the SDK plan does not cross the diagonal one.
        await q.walk('to king door 1', [{ x: 2765, z: 4684, tol: 0 }]);
        await q.openDoor('king door 1', 2766, 4684);
        await q.dash('past king door 1', 2767, 4687, 0, 10);
        await q.openDoor('king door 2', 2766, 4688);
        await q.dash('into king room', 2765, 4689, 0, 10);
        await q.talk('fisher king',/^the fisher king$/i, [/you don't look too well/i], () => q.sawText(/see if i can find him/i), FISHER_KING, 60);
        await blow('whistle back 1', () => !inRealm());
        await ms(6);
    }
    // 7. The Goblin Village sacks: Sir Percival takes a whistle (%grail 9).
    if (FROM < 8) {
        await tele('falador teleport 3', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to sacks', [{ x: SACKS.x - 1, z: SACKS.z, tol: 0 }]);
        const sacks = () => q.findLoc(l => l.id === 23) ?? { id: 23, x: SACKS.x, z: SACKS.z };
        const w0 = q.cnt(ITEM.whistle);
        await q.step('open sacks', () => q.opLoc(sacks(), 2), () => q.dialogOpen(), 8, 3);
        await q.converse([/your father wishes to speak to you/i], () => q.cnt(ITEM.whistle) < w0 && !q.dialogOpen(), 60);
        if (q.cnt(ITEM.whistle) >= w0) await q.talk('percival', /^sir percival$/i, [/your father wishes to speak to you/i], () => q.cnt(ITEM.whistle) < w0, SACKS, 60);
        await ms(7);
    }
    // 8. The restored realm: the Holy Grail on level 2 of the castle.
    if (FROM < 9) {
        await toRealm('realm 2');
        await q.walk('to grail stairs', [{ x: 2647, z: 4682, tol: 2 }]);
        await q.climb('grail stairs', stairs(/climb-up/i, { x: 2648, z: 4683 }, 3), /climb-up/i, levelIs(1));
        await q.climb('grail ladder', stairs(/climb-up/i, { x: 2651, z: 4684 }, 4), /climb-up/i, levelIs(2));
        await pickUp('take grail', ITEM.grail);
        await blow('whistle back 2', () => !inRealm());
        await ms(8);
    }
    // 9. King Arthur.
    if (FROM < 10) {
        await tele('camelot teleport 9', 'magic:camelot_teleport', 2757, 3478);
        await q.talk('arthur 2', /^king arthur$/i, [], () => questDone, ARTHUR, 40);
        await ms(9);
    }

    offDone();
    await q.end(questDone, `qp=2 grail=${!q.has(ITEM.grail)} questMsg=${questDone}`);
} catch (e) { await q.fail(String(e)); }
