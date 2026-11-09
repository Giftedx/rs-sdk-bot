// Hero's Quest as a pair. Usage: bun scripts/generated/quest-hero.ts <blackarm> [phoenix=<blackarm>p]
// Presets: <blackarm> quest_hero, <phoenix> quest_hero_helper (both outside the Heroes' Guild door; every skill 99; nothing
// worn: Entrana bans weapons and armour). Reward: 1 QP and the guild (quests/quest_hero/scripts/quest_hero.rs2).
// Route, order, regions and dialogue answers are adapted from rs-stun-toolkit `q-heros-quest.ts` (MIT,
// research/stun-toolkit-LICENSE.txt), which ran both accounts in 1745-1803 ticks in their lockstep sim. Our SDK reads no
// varps, so every step gates on items, position and dialogue text.
//
// Why two accounts: only a Phoenix member at stage >= 4 can attack Grip (npcs/grip.rs2:59-65); only a Black Arm member can
// get the misc key and open the treasure room (grip.rs2:1-17, :48-56, locs/brimhaven_scarface_mansion.rs2:61-72).
//  - Both: Achietties (start), the Ice Queen's ice gloves (White Wolf Mountain ladder maze behind the hero rockslide), the
//    Entrana firebird's feather (ice gloves worn, no weapons or armour in the pack), the lava eel (Gerrant's slime, the
//    harralander potion, a fishing rod, the dusty key gate, the lava, a fire), the armband, Achietties.
//  - The mansion: Black Arm: Grubor "Four leaved clover", Trobert (ID papers), black armour worn, Garv, Grip (papers, then
//    "Anything I can do now?": misc key), the key to the Phoenix member outside Garv's door. Phoenix: Alfonse "gherkins",
//    the kitchen, Charlie, the panel, the garden, the side door with the key. Black Arm opens Grip's drinks cabinet beside
//    a pirate guard, so Grip walks to 2777,3198 (brimhaven_scarface_mansion.rs2:9-35). The Phoenix member hits him through
//    the arrow slit of the side room, Black Arm takes his keys, the treasure door, the chest (2 candlesticks).
//  - Quest doors teleport (doors/scripts/open_and_close_doors.rs2:9-38): on the door tile you go to the far side, from
//    anywhere else you land on the door tile. So every quest door is used from an exact tile, and blocked for the planner.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const MAIN = process.argv[2]!;
const HELPER = process.argv[3] ?? `${MAIN}p`;
const CAP = Number(process.env.HERO_CAP ?? 7000);

const ITEM = {
    gloves: 1580, feather: 1583, eel: 2149, rawEel: 2148, armband: 1579, candle: 1577, miscKey: 1586, gripKeys: 1588, papers: 1584,
    slime: 1581, oil: 1582, oilyRod: 1585, rod: 307, harra: 97, logs: 1511, tinderbox: 590, vial: 229, jailKey: 1591, dusty: 1590,
    pickaxe: 1265, helm: 1165, body: 1125, legs: 1077,
};
const BLACK = [ITEM.helm, ITEM.body, ITEM.legs];
const GLORY = [1712, 1710, 1708, 1706];
const PRAYER_POT = [2434, 139, 141, 143];
const PFM = 14;                                              // protect_from_melee (sdk PRAYER_INDICES)
const BLAST = componentId('magic:fire_blast');
const NPC = { queen: 795, firebird: 139, jailer: 201, grip: 792, guard: 799, baby: 52, spot: 800 };
const ICE_ADDS = [145, 125, 111, 64];                        // ice warrior (both), ice giant, ice spider
const AT = {
    achietties: { x: 2903, z: 3510 }, queen: { x: 2866, z: 9952 }, katrine: { x: 3186, z: 3385 }, straven: { x: 3246, z: 9780 },
    barnaby: { x: 2679, z: 3275 }, alfonse: { x: 2793, z: 3188 }, charlie: { x: 2790, z: 3191 }, trobert: { x: 2806, z: 3174 },
    garv: { x: 2776, z: 3186 }, grip: { x: 2774, z: 3192 }, meet: { x: 2774, z: 3185 }, gerrant: { x: 3013, z: 3225 },
    monks: { x: 3046, z: 3235 }, entranaMonk: { x: 2835, z: 3336 }, firebird: { x: 2847, z: 3386 }, lava: { x: 2890, z: 9767 },
    jailer: { x: 2933, z: 9695 }, velrak: { x: 2931, z: 9685 }, varrockMeet: { x: 3212, z: 3426 },
};
const LOC = {
    rockslide: { id: 2634, x: 2838, z: 3517 },               // herorockslide, op2 Mine (white_wolf_mountain.rs2:5-40)
    cellar: { id: 1754, x: 3244, z: 3383 },                  // down to the Phoenix HQ
    kitchen: { id: 2628, x: 2788, z: 3189 },                 // herokitchendoor, north edge (brimhaven_restaurant.rs2:1-6)
    panel: { id: 2629, x: 2787, z: 3190 },                   // herokitchenpanel, west edge (:8-12)
    side: { id: 2622, x: 2781, z: 3197 },                    // pete_sidedoor (brimhaven_scarface_mansion.rs2:37-50)
    grubor: { id: 2626, x: 2811, z: 3170 },                  // grubordoor, west edge (brimhaven_blackarm_hq.rs2:1-6)
    garv: { id: 2627, x: 2774, z: 3187 },                    // garvdoor
    cabinet: { id: 2635, x: 2775, z: 3196 },                 // gripcbshut -> gripcbopen 2636, reached from its north tile
    treasure: { id: 2621, x: 2764, z: 3197 },                // pete_treasuredoor
    chest: { id: 2632, x: 2766, z: 3199 },                   // shutcandlechest -> opencandlechest 2633
    tavLadder: { id: 1759, x: 2884, z: 3397 },
    jail: { id: 2631, x: 2931, z: 9690 },                    // dungeonjail, south wall of the tile
    gate: { id: 2623, x: 2924, z: 9803 },                    // deepdungeondoor, west wall of the tile
    baDoor: { id: 2399, x: 3185, z: 3388 },
};
type Tile = { x: number; z: number };
type Door = { id: number; x: number; z: number };
const exact = (n: string) => new RegExp(`^${n}$`, 'i');

type Q = Awaited<ReturnType<typeof openQuest>>;
let b: Q | undefined;
const p: Q = await openQuest({ name: HELPER, cap: CAP, others: () => b ? [b.s] : [] });
b = await openQuest({ name: MAIN, cap: CAP, others: () => [p.s] });
const B: Q = b;

// Shared state: each account's script waits on the other's flags.
const flags = new Set<string>();
const set = (k: string) => { flags.add(k); console.log(`NOTE flag ${k}`); };
const waitFlag = async (q: Q, k: string, ticks: number) => { if (!(await q.waitUntil(() => flags.has(k), ticks))) await q.fail(`partner never reached ${k}`); };

const x = (q: Q) => q.pos()?.worldX ?? 0;
const z = (q: Q) => q.pos()?.worldZ ?? 0;
const under = (q: Q) => z(q) > 6400;
const at = (q: Q, t: Tile) => x(q) === t.x && z(q) === t.z;
const worn = (q: Q, id: number) => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
const ground = (q: Q, id: number, r = 14): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id && g.distance <= r).sort((a: any, c: any) => a.distance - c.distance)[0];
const npcsOf = (q: Q, ids: number[]): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => ids.includes(n.id)).sort((a: any, c: any) => a.distance - c.distance);
const liveLoc = (q: Q, l: Door, ids = [l.id]) => q.findLoc((k: any) => k.x === l.x && k.z === l.z && ids.includes(k.id)) ?? l;
const shut = (q: Q, ticks = 12) => q.converse([], () => !q.dialogOpen(), ticks);
const questDone = (q: Q) => { let d = false; q.s.onTick(() => { if (q.msgCount(/quest complete|completed the hero/i) > 0) d = true; }); return () => d; };
const bDone = questDone(B), pDone = questDone(p);

const pfmOn = (q: Q): boolean => !!q.st()?.prayers?.activePrayers?.[PFM];
const pfm = async (q: Q, on: boolean) => { if (pfmOn(q) !== on) await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn(q) === on, 3, 3); };
const keepPrayer = async (q: Q) => {
    if ((q.st()?.prayers?.prayerPoints ?? 99) >= 15) return;
    const pot = PRAYER_POT.find(id => q.has(id));
    if (pot) { await q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }); await q.waitTicks(2); }
};
const wear = async (q: Q, id: number) => { if (!worn(q, id)) await q.step(`wear ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => worn(q, id), 3, 3); };
const dropIds = async (q: Q, ids: number[]) => {
    for (let i = 0; i < 12; i++) {
        const it = q.inv().find((e: any) => ids.includes(e.id));
        if (!it) return;
        await q.guard('drop');
        await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
        await q.waitTicks(1);
    }
};
const pickup = async (q: Q, label: string, id: number) => {
    await q.step(label, () => { const g = ground(q, id); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' }) : undefined; }, () => q.has(id), 15, 4);
};
const tele = async (q: Q, label: string, comp: string) => {
    if (q.dialogOpen()) await shut(q);
    const x0 = x(q), z0 = z(q);
    await q.step(label, () => q.s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }), () => Math.max(Math.abs(x(q) - x0), Math.abs(z(q) - z0)) > 20, 8, 4);
};
const gloryDraynor = async (q: Q, label: string) => {
    const g = () => q.inv().find((i: any) => GLORY.includes(i.id));
    if (!g()) await q.fail(`${label}: no glory`);
    const op = (g().optionsWithIndex ?? []).find((o: any) => /rub/i.test(o.text))?.opIndex ?? 4;
    const moved = () => q.near(3105, 3251, 8);
    await q.step(label, async () => {
        const h = g();
        if (h) await q.s.direct({ type: 'useInventoryItem', slot: h.slot, optionIndex: op, reason: 'SDK' });
        await q.converse([/^draynor/i], moved, 8);
    }, moved, 10, 3);
};
// Cross a quest door from an exact tile. A dialogue (Grubor, Garv) answers the op: the caller handles it.
const doorFrom = async (q: Q, door: Door, stand: Tile, through: () => boolean, label: string, key?: number) => {
    for (let k = 0; k < 5 && !through(); k++) {
        await q.guard(label);
        if (q.dialogOpen()) await shut(q);
        if (q.cheb(stand.x, stand.z) > 1) await q.walk(`${label} walk`, [{ ...stand, tol: 0 }]);
        if (!at(q, stand)) await q.dash(`${label} stand`, stand.x, stand.z, 0, 25);
        if (key !== undefined) await q.useOnLoc(key, liveLoc(q, door));
        else await q.opLoc(liveLoc(q, door), 1);
        await q.waitUntil(() => through() || q.dialogOpen(), 6);
        if (q.dialogOpen() && !through()) return;
    }
    if (!through()) await q.fail(`${label}: not through`);
};
// One Fire Blast every `every` ticks on the nearest npc of `ids` until done(). `adds`: an npc that holds the bot in
// combat ("I'm already under attack!", single-way) dies first. `away`: no Magic XP for 40 ticks with the target in view
// means a stale npc entry (the toolkit's casts were dropped silently there), so walk out of view and back.
async function cast(q: Q, label: string, ids: number[], done: () => boolean, o: { ticks: number; anchor?: Tile; adds?: number[]; every?: number; away?: Tile }): Promise<void> {
    const every = o.every ?? 5;
    let last = -100, busy = q.msgCount(/already under attack/i), add = -1, xp0 = q.xp('Magic'), xpAt = q.T();
    for (let t = 0; t < o.ticks && !done(); t++) {
        await q.guard(label);
        await keepPrayer(q);
        const c = q.msgCount(/already under attack/i);
        if (o.adds && c !== busy) { busy = c; add = npcsOf(q, o.adds).filter(n => n.distance <= 8)[0]?.index ?? -1; }
        let n = add >= 0 ? npcsOf(q, o.adds ?? []).find(k => k.index === add) : undefined;
        if (!n) { add = -1; n = npcsOf(q, ids)[0]; }
        if (q.xp('Magic') !== xp0) { xp0 = q.xp('Magic'); xpAt = q.T(); }
        if (!n) {
            if (o.anchor && !q.near(o.anchor.x, o.anchor.z, 5) && t % 10 === 0) await q.walk(`${label} anchor`, [{ ...o.anchor, tol: 3 }]);
            xpAt = q.T();
            await q.waitTicks(1);
            continue;
        }
        if (o.away && o.anchor && q.T() - xpAt >= 40) {
            console.log(`NOTE ${label}: no cast landed in 40 ticks at ${x(q)},${z(q)}, target ${n.index} ${n.x},${n.z}: out of view and back`);
            await q.walk(`${label} away`, [{ ...o.away, tol: 2 }]);
            await q.walk(`${label} back`, [{ ...o.anchor, tol: 3 }]);
            xpAt = q.T(); last = -100;
            continue;
        }
        if (q.T() - last >= every) { last = q.T(); await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: BLAST, reason: 'SDK' }); }
        await q.waitTicks(1);
    }
    if (!done()) await q.fail(`${label}: not done`);
}

// ---- Phases shared by both accounts ----
async function start(q: Q): Promise<void> {
    await q.talk('achietties', /^achietties$/i, [/i'm a hero, may i apply/i, /start looking for all those/i], () => q.sawText(/good luck with that/i) && !q.dialogOpen(), AT.achietties, 60);
    q.milestone('start');
}

// The lair (x2857-2877 z9917-9964) is the end of White Wolf Mountain's ladder maze: the rockslide from its west side,
// ladder down at 2848,3513, underground west to 2824,9907, up, down at 2827,3510, underground east to 2857,9917, up into
// the sealed nook, down at 2859,3519. Each climb keeps the tile (z +- 6400), so the stand tiles are exact.
async function iceQueen(q: Q): Promise<void> {
    const ladder = async (id: number, lx: number, lz: number, stand: Tile, label: string) => {
        const was = under(q);
        await q.walk(label, [{ ...stand, tol: 0 }]);
        await q.climb(label, () => q.findLoc((l: any) => l.id === id && l.x === lx && l.z === lz) ?? { id, x: lx, z: lz }, /climb/i, () => under(q) !== was);
    };
    await q.walk('rockslide', [{ x: 2837, z: 3517, tol: 0 }]);
    await q.step('rockslide', () => q.opLoc(liveLoc(q, LOC.rockslide), 2), () => x(q) >= 2839, 12, 4);
    q.milestone('rockslide');
    await pfm(q, true);
    await ladder(1759, 2848, 3513, { x: 2849, z: 3513 }, 'ladder 2848,3513');
    await ladder(1755, 2824, 9907, { x: 2825, z: 9907 }, 'ladder 2824,9907');
    await ladder(1759, 2827, 3510, { x: 2828, z: 3510 }, 'ladder 2827,3510');
    await ladder(1755, 2857, 9917, { x: 2858, z: 9917 }, 'ladder 2857,9917');
    await ladder(1759, 2859, 3519, { x: 2860, z: 3519 }, 'ladder 2859,3519');
    q.milestone('lair');
    await q.walk('ice queen', [{ ...AT.queen, tol: 3 }]);
    const got = () => !!ground(q, ITEM.gloves) || q.has(ITEM.gloves);
    await cast(q, 'ice queen', [NPC.queen], got, { ticks: 1100, anchor: AT.queen, adds: ICE_ADDS, every: 5, away: { x: 2860, z: 9921 } });
    if (!q.has(ITEM.gloves)) await pickup(q, 'ice gloves', ITEM.gloves);
    await pfm(q, false);
    await wear(q, ITEM.gloves);
    await dropIds(q, [ITEM.pickaxe]);                        // weapon_pickaxe is banned on Entrana
    q.milestone('ice gloves');
}

async function disembark(q: Q, label: string): Promise<void> {
    for (let i = 0; i < 8 && q.lvl() !== 0; i++) {
        await q.guard(label);
        if (q.dialogOpen()) { await shut(q); continue; }
        const plank = q.findLoc((l: any) => /^gangplank$/i.test(l.name));
        if (!plank) { await q.waitTicks(2); continue; }
        await q.opLoc(plank, q.opIndex(plank, /cross/i));
        await q.waitUntil(() => q.lvl() === 0, 10);
    }
    if (q.lvl() !== 0) await q.fail(label);
}

async function entrana(q: Q): Promise<void> {
    for (const id of BLACK) {
        const e = (q.st()?.equipment ?? []).find((k: any) => k?.id === id);
        if (e) await q.step(`remove ${id}`, () => q.s.direct({ type: 'useEquipmentItem', slot: e.slot, optionIndex: 1, reason: 'SDK' }), () => !worn(q, id), 4, 3);
    }
    await dropIds(q, [...BLACK, ITEM.pickaxe]);
    await gloryDraynor(q, 'glory draynor');
    await q.walk('to monks', [{ ...AT.monks, tol: 3 }]);
    await q.talk('ship monk', /^monk of entrana$/i, [/yes, okay, i'm ready to go/i], () => q.lvl() === 1 && q.near(2834, 3331, 6), AT.monks, 60, true);
    await disembark(q, 'entrana gangplank');
    q.milestone('entrana');
    await q.walk('firebird', [{ ...AT.firebird, tol: 4 }]);
    await cast(q, 'firebird', [NPC.firebird], () => !!ground(q, ITEM.feather) || q.has(ITEM.feather), { ticks: 900, anchor: AT.firebird, away: { x: 2834, z: 3338 } });
    if (!q.has(ITEM.feather)) await pickup(q, 'feather', ITEM.feather);
    q.milestone('feather');
    await q.walk('entrana monk', [{ ...AT.entranaMonk, tol: 3 }]);
    await q.talk('leave entrana', /^monk of entrana$/i, [/yes,? i'm ready to go/i], () => q.lvl() === 1 && q.near(3048, 3231, 6), AT.entranaMonk, 60, true);
    await disembark(q, 'sarim gangplank');
}

async function gerrant(q: Q): Promise<void> {
    await gloryDraynor(q, 'glory gerrant');
    await q.walk('to gerrant', [{ x: AT.gerrant.x + 1, z: AT.gerrant.z, tol: 2 }]);
    await q.talk('gerrant', /^gerrant$/i, [/how to catch a lava eel/i], () => q.has(ITEM.slime) && !q.dialogOpen(), AT.gerrant, 60);
    await q.step('blamish oil', () => q.useOnItem(ITEM.slime, ITEM.harra), () => q.has(ITEM.oil), 6, 3);
    await q.step('oily rod', () => q.useOnItem(ITEM.oil, ITEM.rod), () => q.has(ITEM.oilyRod), 6, 3);
    await dropIds(q, [ITEM.vial]);
    q.milestone('oily rod');
}

// Taverley dungeon as in quest-scorpion.ts: the Jailer's key, Velrak's cell, the dusty key, the deep gate; then the lava
// spot. Baby blue dragons at the spot restart the fishing roll with every hit (lavafish.rs2:46-67), so they die first.
async function eel(q: Q): Promise<void> {
    await tele(q, 'falador teleport', 'magic:falador_teleport');
    await q.walk('taverley ladder', [{ x: LOC.tavLadder.x, z: LOC.tavLadder.z + 1, tol: 1 }]);
    await q.climb('taverley ladder', () => liveLoc(q, LOC.tavLadder), /climb-down/i, () => under(q));
    q.blockDoor(0, LOC.gate.x, LOC.gate.z);
    await pfm(q, true);
    await q.walk('to jailer', [{ ...AT.jailer, tol: 3 }]);
    await cast(q, 'jailer', [NPC.jailer], () => !!ground(q, ITEM.jailKey) || q.has(ITEM.jailKey), { ticks: 200, anchor: AT.jailer });
    if (!q.has(ITEM.jailKey)) await pickup(q, 'jail key', ITEM.jailKey);
    const inCell = () => z(q) < LOC.jail.z;
    await q.walk('cell door', [{ x: LOC.jail.x, z: LOC.jail.z, tol: 1 }]);
    await q.step('cell door', () => q.useOnLoc(ITEM.jailKey, LOC.jail), inCell, 15, 4);
    await q.talk('velrak', /^velrak/i, [/know anywhere good to explore/i, /yes please/i], () => q.has(ITEM.dusty) && !q.dialogOpen(), AT.velrak, 40);
    await q.step('leave cell', () => q.opLoc(LOC.jail, 1), () => !inCell(), 15, 4);
    q.milestone('dusty key');
    const pastGate = () => x(q) < LOC.gate.x && Math.abs(z(q) - LOC.gate.z) < 40;
    await q.walk('deep gate', [{ x: LOC.gate.x + 1, z: LOC.gate.z, tol: 1 }]);
    await q.step('deep gate', () => q.useOnLoc(ITEM.dusty, LOC.gate), pastGate, 15, 4);
    await q.walk('lava', [{ ...AT.lava, tol: 1 }]);
    await dropIds(q, [ITEM.jailKey]);
    let last = -100;
    const t0 = q.T();
    while (!q.has(ITEM.rawEel)) {
        await q.guard('eel');
        await keepPrayer(q);
        if (q.T() - t0 > 600) await q.fail('no eel');
        const near = () => npcsOf(q, [NPC.baby]).filter(n => n.distance <= 3);
        if (near().length) {
            await cast(q, 'baby blue dragon', [NPC.baby], () => !near().length, { ticks: 120 });
            await q.walk('lava back', [{ ...AT.lava, tol: 1 }]);
            last = -100;
            continue;
        }
        if (q.T() - last >= 8) {
            const f = npcsOf(q, [NPC.spot])[0];
            if (!f) await q.fail('no lava fishing spot');
            last = q.T();
            await q.s.direct({ type: 'interactNpc', npcIndex: f.index, optionIndex: 1, reason: 'SDK' });
        }
        await q.waitTicks(1);
    }
    q.milestone('raw eel');
    await pfm(q, false);
    await tele(q, 'falador teleport (eel)', 'magic:falador_teleport');
    const fire = () => q.findLoc((l: any) => /^fire$/i.test(l.name) && l.distance <= 2);
    for (let k = 0; k < 4 && !q.has(ITEM.eel); k++) {
        await q.guard('cook eel');
        if (!fire()) {
            const logs0 = q.cnt(ITEM.logs);
            await q.useOnItem(ITEM.tinderbox, ITEM.logs);
            await q.waitUntil(() => q.cnt(ITEM.logs) < logs0 && !!fire(), 20);
        }
        if (!fire()) { await q.dash('fire tile', x(q) + (k % 2 ? -1 : 1), z(q) + (k > 1 ? 1 : 0), 0, 6); continue; }
        await q.step('cook eel', () => q.useOnLoc(ITEM.rawEel, fire()), () => q.has(ITEM.eel) || q.dialogOpen(), 10, 3);
        if (q.dialogOpen()) await q.converse([/cook/i], () => q.has(ITEM.eel) && !q.dialogOpen(), 12);
    }
    if (!q.has(ITEM.eel)) await q.fail('eel not cooked');
    q.milestone('eel');
}

async function toBrimhaven(q: Q): Promise<void> {
    await tele(q, 'ardougne teleport', 'magic:ardougne_teleport');
    await q.walk('to barnaby', [{ ...AT.barnaby, tol: 3 }]);
    await q.talk('barnaby', /^captain barnaby$/i, [/^yes please/i], () => q.lvl() === 1 && q.near(2775, 3234, 8), AT.barnaby, 40, true);
    await disembark(q, 'brimhaven gangplank');
    q.milestone('brimhaven');
}

async function finish(q: Q, done: () => boolean): Promise<void> {
    if (under(q) || q.cheb(AT.achietties.x, AT.achietties.z) > 150) await tele(q, 'falador teleport (finish)', 'magic:falador_teleport');
    await q.walk('to achietties', [{ x: 2904, z: 3510, tol: 2 }]);
    await q.talk('achietties finish', /^achietties$/i, [], done, AT.achietties, 80, true);
    await shut(q);
    q.milestone('done');
}

const downCellar = async (q: Q, label: string) => {
    if (under(q)) return;
    await q.walk(`${label} cellar`, [{ x: 3244, z: 3382, tol: 1 }]);
    await q.climb(`${label} down`, () => liveLoc(q, LOC.cellar), /climb-down/i, () => under(q));
};
const blockQuestDoors = (q: Q) => { for (const d of [LOC.kitchen, LOC.panel, LOC.side, LOC.grubor, LOC.garv, LOC.treasure]) q.blockDoor(0, d.x, d.z); };

// Hands `id` from one account to the other: the giver asks, the receiver serves one trade.
async function hand(from: Q, to: Q, fromName: string, toName: string, item: RegExp, id: number, label: string): Promise<void> {
    const want = to.cnt(id) + 1;
    for (let k = 0; k < 4 && to.cnt(id) < want; k++) {
        await from.guard(label);
        if (k > 0) await to.dash(`${label} step`, x(to) + (k % 2 ? 2 : -2), z(to), 1, 6).catch(() => undefined);
        const serve = to.s.bot.serveTrades({ from: exact(fromName), maxTrades: 1, timeout: 30_000 });
        const give = await from.s.bot.trade(exact(toName), { give: [{ item, amount: 1 }], timeout: 30_000 });
        await serve;
        if (!give.success) console.log(`WARN ${label} try ${k + 1}: ${(give as any).message}`);
    }
    if (to.cnt(id) < want) await from.fail(`${label}: not traded`);
}

// ---- The Phoenix account ----
async function phoenix(q: Q, done: () => boolean): Promise<void> {
    blockQuestDoors(q);
    await start(q);
    await iceQueen(q);
    await tele(q, 'varrock teleport', 'magic:varrock_teleport');
    await downCellar(q, 'straven');
    await q.talk('straven', /^straven$/i, [], () => q.sawText(/secret word 'gherkin'/i) && !q.dialogOpen(), AT.straven, 60);
    q.milestone('straven');
    await entrana(q);
    await toBrimhaven(q);
    await q.walk('to alfonse', [{ x: AT.alfonse.x, z: AT.alfonse.z - 1, tol: 2 }]);
    await q.talk('alfonse', /^alfonse/i, [/sell gherkins/i], () => q.sawText(/alfonse winks at you/i) && !q.dialogOpen(), AT.alfonse, 40);
    const inKitchen = () => z(q) >= 3190 && x(q) >= 2787 && x(q) <= 2799;
    await doorFrom(q, LOC.kitchen, { x: 2788, z: 3189 }, inKitchen, 'kitchen door');
    await q.talk('charlie', /^charlie/i, [/looking for a gherkin/i, /steal scarface pete's candlesticks/i], () => q.sawText(/quicker we get that loot/i) && !q.dialogOpen(), AT.charlie, 60);
    q.milestone('charlie');
    await doorFrom(q, LOC.kitchen, { x: 2788, z: 3190 }, () => z(q) <= 3189, 'kitchen door out');
    await q.walk('meet', [{ ...AT.meet, tol: 1 }]);
    set('p-at-meet');
    if (!(await q.waitUntil(() => q.has(ITEM.miscKey), 900))) await q.fail('no misc key from the partner');
    await q.walk('kitchen', [{ x: 2788, z: 3188, tol: 1 }]);
    await doorFrom(q, LOC.kitchen, { x: 2788, z: 3189 }, inKitchen, 'kitchen door 2');
    await doorFrom(q, LOC.panel, { x: 2787, z: 3190 }, () => x(q) <= 2786 && z(q) >= 3188 && z(q) <= 3199, 'panel');
    await doorFrom(q, LOC.side, { x: 2781, z: 3196 }, () => z(q) >= 3197 && x(q) >= 2780 && x(q) <= 2782, 'side door', ITEM.miscKey);
    await q.dash('arrow slit', 2780, 3198, 0, 10);
    set('p-ready');
    q.milestone('side room');
    await waitFlag(q, 'b-cabinet', 600);
    // The only line of fire is the arrow slit on the west edge of 2780,3198: cast only while Grip stands in that row. A cast
    // at Grip elsewhere walks the bot off the slit tile and every later cast is dropped silently.
    let last = -100;
    const gripDead = () => flags.has('grip-dead') || (!npcsOf(q, [NPC.grip]).length && !!ground(q, ITEM.gripKeys));
    for (let t = 0; t < 600 && !gripDead(); t++) {
        await q.guard('grip');
        if (!at(q, { x: 2780, z: 3198 })) await q.dash('arrow slit', 2780, 3198, 0, 6);
        const g = npcsOf(q, [NPC.grip])[0];
        if (g && g.z === 3198 && g.x >= 2774 && g.x <= 2779 && q.T() - last >= 3) {
            last = q.T();
            await q.s.direct({ type: 'spellOnNpc', npcIndex: g.index, spellComponent: BLAST, reason: 'SDK' });
        }
        await q.waitTicks(1);
    }
    if (!gripDead()) await q.fail('grip not killed from the side room');
    set('grip-dead');
    q.milestone('grip');
    await tele(q, 'varrock teleport 2', 'magic:varrock_teleport');
    await q.walk('varrock meet', [{ ...AT.varrockMeet, tol: 2 }]);
    set('p-varrock');
    if (!(await q.waitUntil(() => q.has(ITEM.candle), 900))) await q.fail('no candlestick from the partner');
    await downCellar(q, 'armband');
    await q.talk('straven armband', /^straven$/i, [], () => q.has(ITEM.armband) && !q.dialogOpen(), AT.straven, 60);
    q.milestone('armband');
    await gerrant(q);
    await eel(q);
    await finish(q, done);
}

// ---- The Black Arm account ----
async function blackarm(q: Q, done: () => boolean): Promise<void> {
    blockQuestDoors(q);
    await start(q);
    q.blockDoor(0, LOC.baDoor.x, LOC.baDoor.z);
    const toKatrine = async (label: string) => {
        await q.walk(`${label} east door`, [{ x: 3197, z: 3384, tol: 0 }]);
        await q.openDoor(`${label} door 1`, 3196, 3384);
        await q.dash(`${label} room`, 3191, 3384, 0, 10);
        await q.openDoor(`${label} door 2`, 3190, 3384);
    };
    await tele(q, 'varrock teleport', 'magic:varrock_teleport');
    await toKatrine('katrine');
    await q.talk('katrine', /^katrine$/i, [/rank of master thief/i], () => q.sawText(/four leafed clover/i) && !q.dialogOpen(), { x: 3190, z: 3384 }, 60);
    q.milestone('katrine');
    await gerrant(q);
    await eel(q);
    await toBrimhaven(q);
    // Grubor's door: the HQ is east of it. Before the password the op talks to Grubor through it.
    const inHq = () => (x(q) >= 2811 && x(q) <= 2815 && z(q) >= 3167 && z(q) <= 3178) || (x(q) >= 2805 && x(q) <= 2810 && z(q) >= 3171 && z(q) <= 3178);
    await q.walk('grubor door', [{ x: 2810, z: 3170, tol: 0 }]);
    for (let k = 0; k < 6 && !inHq(); k++) {
        await q.guard('grubor');
        if (!at(q, { x: 2810, z: 3170 })) await q.dash('grubor stand', 2810, 3170, 0, 15);
        await q.opLoc(liveLoc(q, LOC.grubor), 1);
        await q.waitUntil(() => inHq() || q.dialogOpen(), 8);
        if (q.dialogOpen()) await q.converse([/four leaved clover/i], () => !q.dialogOpen(), 30);
    }
    if (!inHq()) await q.fail('not into the Black Arm hideout');
    q.milestone('grubor');
    await q.talk('trobert', /^trobert$/i, [/help me get scarface pete's candlesticks/i, /i volunteer/i], () => q.has(ITEM.papers) && !q.dialogOpen(), AT.trobert, 60);
    q.milestone('trobert');
    await q.walk('grubor door inside', [{ x: 2811, z: 3170, tol: 0 }]);
    await doorFrom(q, LOC.grubor, { x: 2811, z: 3170 }, () => !inHq(), 'grubor door out');
    const inMansion = () => z(q) >= 3188 && x(q) >= 2759 && x(q) <= 2781;
    for (const id of BLACK) await wear(q, id);
    await q.walk('to garv', [{ x: AT.garv.x, z: AT.garv.z - 1, tol: 2 }]);
    await q.talk('garv', /^garv$/i, [], () => q.sawText(/grip will want to talk to you/i) && !q.dialogOpen(), AT.garv, 40);
    await doorFrom(q, LOC.garv, { x: 2774, z: 3187 }, inMansion, 'garv door');
    await q.talk('grip', /^grip$/i, [/anything i can do now/i, /what do my duties involve/i], () => q.has(ITEM.miscKey) && !q.dialogOpen(), AT.grip, 60);
    q.milestone('misc key');
    await doorFrom(q, LOC.garv, { x: 2774, z: 3188 }, () => z(q) <= 3187, 'garv door out');
    await waitFlag(q, 'p-at-meet', 1200);
    await hand(q, p, MAIN, HELPER, /^miscellaneous key$/i, ITEM.miscKey, 'misc key trade');
    await doorFrom(q, LOC.garv, { x: 2774, z: 3187 }, inMansion, 'garv door 2');
    await waitFlag(q, 'p-ready', 600);
    const stand = { x: 2775, z: 3197 };
    for (let k = 0; k < 8 && !flags.has('grip-dead'); k++) {
        await q.guard('cabinet');
        if (!q.near(stand.x, stand.z, 0)) await q.walk('cabinet', [{ ...stand, tol: 0 }]);
        await q.waitUntil(() => npcsOf(q, [NPC.guard]).some(n => Math.max(Math.abs(n.x - stand.x), Math.abs(n.z - stand.z)) <= 3), 60);
        await q.opLoc(liveLoc(q, LOC.cabinet, [2635, 2636]), 1);
        await q.waitUntil(() => q.dialogOpen(), 12);
        if (q.dialogOpen()) await q.converse([/won't notice me/i], () => !q.dialogOpen(), 20);
        set('b-cabinet');
        await q.waitUntil(() => flags.has('grip-dead') || !!ground(q, ITEM.gripKeys), 40);
        if (ground(q, ITEM.gripKeys)) set('grip-dead');
    }
    if (!flags.has('grip-dead')) await q.fail('grip not killed');
    await q.waitUntil(() => !!ground(q, ITEM.gripKeys), 10);
    await pickup(q, 'grip keys', ITEM.gripKeys);
    q.milestone('grip keys');
    await q.walk('treasure door', [{ x: 2763, z: 3197, tol: 0 }]);
    await doorFrom(q, LOC.treasure, { x: 2763, z: 3197 }, () => x(q) >= 2764 && x(q) <= 2772 && z(q) >= 3196, 'treasure door', ITEM.gripKeys);
    for (let k = 0; k < 8 && q.cnt(ITEM.candle) < 2; k++) {
        await q.guard('chest');
        const c = liveLoc(q, LOC.chest, [2632, 2633]);
        await q.opLoc(c, 1);
        await q.waitUntil(() => q.cnt(ITEM.candle) >= 2 || q.dialogOpen() || liveLoc(q, LOC.chest, [2632, 2633]).id !== c.id, 14);
        if (q.dialogOpen()) await q.converse([], () => q.cnt(ITEM.candle) >= 2 && !q.dialogOpen(), 8);
    }
    if (q.cnt(ITEM.candle) < 2) await q.fail(`candlesticks ${q.cnt(ITEM.candle)}/2`);
    q.milestone('candlesticks');
    await tele(q, 'varrock teleport 2', 'magic:varrock_teleport');
    await q.walk('varrock meet', [{ ...AT.varrockMeet, tol: 2 }]);
    await waitFlag(q, 'p-varrock', 900);
    await hand(q, p, MAIN, HELPER, /^pete's candlestick$/i, ITEM.candle, 'candlestick trade');
    await toKatrine('katrine armband');
    await q.talk('katrine armband', /^katrine$/i, [/i have a candlestick now/i], () => q.has(ITEM.armband) && !q.dialogOpen(), { x: 3190, z: 3384 }, 60);
    q.milestone('armband');
    await tele(q, 'camelot teleport', 'magic:camelot_teleport');
    await iceQueen(q);
    await entrana(q);
    await finish(q, done);
}

try {
    const tick0 = B.T();
    let bTicks = -1, pTicks = -1;
    await Promise.all([
        blackarm(B, bDone).then(() => { bTicks = B.T() - tick0; }),
        phoenix(p, pDone).then(() => { pTicks = p.T(); }),
    ]);
    await B.end(bDone() && pDone(), `qp=1 mainTicks=${bTicks} helperTicks=${pTicks} mainDone=${bDone()} helperDone=${pDone()} helperHpMin=${p.stats.hpMin} helperEats=${p.stats.eats}`);
} catch (e) { await B.fail(String(e)); }
