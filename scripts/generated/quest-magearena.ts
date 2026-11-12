// The Mage Arena from preset quest_magearena (beside Kolodion in the cellar): the god cape and the god staff of Zamorak
// and Flames of Zamorak for use outside the arena. Paths below are under
// vendor/rs-sdk/server/content/scripts/areas/area_mage_arena/.
// Varp %magearena (267, configs/mage_arena.constant): 1 Kolodion took the player in; 2 to 5 the form that is next
// (ogre, spider, ghost, demon); 6 the demon is dead; 7 a prayer at a statue; 8 the guardian gave the staff. %zamomage
// (270) counts the casts of Flames of Zamorak in the arena; 99 lets the spell work outside it.
// The way: Kolodion (2541,4715) asks for Magic 60 and a pack and body with no armour and no weapon; a staff, a knife,
// runes, potions and food pass (scripts/kolodion.rs2:6, scripts/mage_arena.rs2:100-138). He sends the player to
// 3105,3934 in the arena (Wilderness level 52) and comes as five forms, one after the other, with 3, 65, 78, 78 and
// 107 Hitpoints (configs/mage_arena.npc). Each form casts a god spell with a max hit of 20 once in 5 ticks from 5
// tiles or less (the first form 3 tiles), and no form has a melee attack (scripts/kolodion_fight.rs2:1-11).
// After the demon the player comes back to the cellar. The pool (2541,4719) leads to the chamber; a prayer at the
// statue of Zamorak (2516,4721) puts the cape on the tile in front (scripts/chamber.rs2:5-22); the guardian
// (2508,4696) gives the staff to a player who holds the cape (scripts/chamber_guardian.rs2:4-17). The pool of the
// chamber (2508,4686) leads back. The ladder (2542,4713) goes up to the hut at 3091,3957 (Wilderness level 55); two
// webs (3093,3957 and 3095,3957) need a knife; the portal (3105,3953) lets a player with %magearena 6 or more in.
// 99 casts of Flames of Zamorak at an NPC, with the player in the arena, set %zamomage to 99
// (skill_combat/scripts/player/spells/scripts/flames_of_zamorak.rs2:9-38). The battle mages (Hitpoints 120) are the
// targets; each casts a god spell with a max hit of 20.
// Two methods:
// - Prayer 37 or more: Protect from Magic (prayer index 12). A spell of an NPC fails when the prayer is on
//   (skill_combat/scripts/npc/npc_combat_magic.rs2:37), so Kolodion and the battle mages do no damage. The bot stands
//   and casts once in 5 ticks.
// - With no prayer (MA_MODE=leash): the leash. An NPC drops a target that is more than maxrange + attackrange tiles
//   from the tile where the NPC came into the world, and does not walk more than maxrange tiles from it (engine
//   Npc.ts targetWithinMaxRange). Kolodion and the battle mages have maxrange 10 and attackrange 5. The bot casts from a
//   tile 17 from that start tile (spell range 10), and when the NPC is too far it steps in, casts and runs back.
//   The tile is on the row of the gap in the west wall (see the constants). This works for Kolodion only. At the
//   battle mages such an account stands, takes the hits and eats.
// The spell at Kolodion: Fire Wave (Magic 75, max hit 20), else Fire Blast (Magic 59, max hit 16). The god spells
// need the god staff, and Iban Blast needs Underground Pass.
// The leash is not safe: on a Magic 99, Hitpoints 83 account with 23 sharks it passed at 1 seed of 4 in practice, and
// a Hitpoints 10 account died. So the script ends at once for an account under Prayer 37, and MA_MODE=leash runs the
// leash for a test. The script finds its stage from what Kolodion says and what the account holds.
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const POOL_CELLAR = { id: 2878, x: 2541, z: 4719 }, POOL_CHAMBER = { id: 2879, x: 2508, z: 4686 };
const STATUE = { id: 2874, x: 2516, z: 4721 };
const GUARDIAN = { x: 2508, z: 4696 };
const LADDER_UP = { id: 2872, x: 2542, z: 4713 }, LADDER_DOWN = { id: 2871, x: 3091, z: 3957 };
const WEBS = [{ x: 3093, z: 3957 }, { x: 3095, z: 3957 }];
const PORTAL = { id: 2880, x: 3105, z: 3953 };
const ITEM = { cape: 2414, staff: 2417, knife: 946, prayerPot: [2434, 139, 141, 143], food: 385 };
const NPC = { kolodion: 905, guardian: 904, forms: [907, 908, 909, 910, 911], mages: [912, 913, 914] };
const PFMAGIC = 12;                                         // protect_from_magic (sdk PRAYER_INDICES)
// The leash method. The floor of the arena is 25 tiles wide (x 3093 to 3117, z 3921 to 3945), too small for a tile 17
// from an NPC in its middle. The west wall has a gap on rows 3933 and 3934 (x 3088 to 3092), and a ring between the
// wall and the outer fence goes round the floor from that gap to the portal; the ring ends at x 3084 on row 3934
// (sdk pathfinding: a path from the floor to 3081,3934 ends at 3084,3934). The bot casts at Kolodion along row 3934.
const ROW = 3934, GAP_X = 3088, SCOUT = { x: 3094, z: ROW };
const RING_END = 3084, FOOD_FLOOR = 2;
// The rectangles of the arena (configs/mage_arena.dbrow).
const ZONE: Array<[number, number, number, number]> = [[3084, 3919, 3126, 3944], [3088, 3944, 3123, 3948], [3093, 3949, 3118, 3953], [3089, 3914, 3121, 3918]];
const LEASH = 17;

// Two spells of 20 can land between two meals: the bot eats under 45.
const q = await openQuest({ cap: 3000, eatAt: 45, food: [ITEM.food] });
try {
    const prayers = (): any => q.st()?.prayers;
    const prayOn = (): boolean => !!prayers()?.activePrayers?.[PFMAGIC];
    const points = (): number => prayers()?.prayerPoints ?? 0;
    const base = (skill: string): number => q.st()?.skills?.find((k: any) => k.name === skill)?.baseLevel ?? 1;
    const MODE = process.env.MA_MODE ?? 'pray';
    if (MODE === 'pray' && base('Prayer') < 37) await q.fail(`Prayer ${base('Prayer')} under the 37 of Protect from Magic (MA_MODE=leash runs the method with no prayer)`);
    const SPELL = base('Magic') >= 75 ? 'magic:fire_wave' : 'magic:fire_blast';
    const FLAMES = componentId('magic:flames_of_zamorak');
    let potions = 0, casts = 0, lures = 0;
    const setPray = async (on: boolean): Promise<void> => {
        if (MODE !== 'pray' || prayOn() === on || (on && points() <= 0)) return;
        await q.step(`protect from magic ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFMAGIC, reason: 'SDK' }), () => prayOn() === on, 3, 3);
    };
    const keepPrayer = async (): Promise<void> => {
        if (MODE !== 'pray') return;
        if (points() <= 8) {
            const pot = ITEM.prayerPot.find(id => q.has(id));
            if (pot) { const p0 = points(); potions++; await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2); }
        }
        if (!prayOn() && points() > 0) await setPray(true);
    };
    const worn = (id: number): boolean => (q.st()?.equipment ?? []).some((e: any) => e?.id === id);
    const held = (id: number): boolean => q.has(id) || worn(id);
    const wear = async (id: number): Promise<void> => {
        if (worn(id)) return;
        await q.step(`wear ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), () => worn(id), 3, 3);
    };
    const npcs = (ids: number[]): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => ids.includes(n.id)).sort((a: any, b: any) => a.distance - b.distance);
    const lastMsg = (re: RegExp): number => Math.max(-1, ...(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).map((m: any) => m.observationId ?? m.tick));
    const inZone = (x: number, z: number): boolean => ZONE.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
    const inArena = (): boolean => { const p = q.pos(); return !!p && inZone(p.worldX, p.worldZ); };
    const inCellar = (): boolean => (q.pos()?.worldZ ?? 0) > 4600;
    // The cellar holds the bank room (east) and the chamber of the statues (west).
    const inBank = (): boolean => inCellar() && (q.pos()?.worldX ?? 0) > 2525;
    const run = (x: number, z: number) => q.s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
    // Back to a tile west on the row of the gap, in steps of 8 tiles or less: first to the gap, then along the row.
    const back = (safe: { x: number; z: number }) => { const x = q.pos().worldX; return x > GAP_X + 5 && safe.x <= GAP_X + 3 ? run(GAP_X + 3, ROW) : run(Math.max(safe.x, x - 8), ROW); };
    // Tiles between the player and the nearest tile of an NPC (the spider and the demon cover 3 by 3 tiles).
    const gap = (n: any): number => {
        const p = q.pos(), size = n.id === 909 || n.id === 911 ? 3 : 1;
        const d = (a: number, lo: number) => (a < lo ? lo - a : a > lo + size - 1 ? a - (lo + size - 1) : 0);
        return Math.max(d(p.worldX, n.x), d(p.worldZ, n.z));
    };
    const talkId = async (label: string, id: number, pats: RegExp[], ok: () => boolean, maxTicks = 60): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            const n = npcs([id])[0];
            if (!n) await q.fail(`${label}: no npc ${id}`);
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 25);
            let shut = 0;
            await q.converse(pats, () => { shut = q.dialogOpen() ? 0 : shut + 1; return (ok() && !q.dialogOpen()) || shut >= 3; }, maxTicks);
            if (ok()) return;
        }
        await q.fail(`talk ${label}`);
    };
    // A loc click with pages after it (the pools, the statue), until arrived().
    const locThen = async (label: string, loc: { id: number; x: number; z: number }, arrived: () => boolean, ticks = 25): Promise<void> => {
        for (let i = 0; i < 4 && !arrived(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            await q.opLoc(loc, 1);
            await q.converse([], arrived, ticks);
        }
        if (!arrived()) await q.fail(label);
    };

    // One fight. `pick` gives the NPC to cast at; `spell` the component; the fight ends when done() holds. In the
    // leash method `home` gives the start tile of the NPC and the tile to cast from.
    const fight = async (label: string, pick: () => any, spell: number, done: () => boolean, maxTicks: number,
        home?: (n: any) => { start: { x: number; z: number }; safe: { x: number; z: number } }): Promise<void> => {
        const t0 = q.T(), c0 = casts, mxp0 = q.xp('Magic'), runes0 = lastMsg(/do not have enough/i), hp0 = q.hp();
        let lastCast = -99, index = -1, unseen = 0, landed = 0, xpLast = mxp0, leash: ReturnType<NonNullable<typeof home>> | undefined, damage = 0, hpLast = q.hp();
        for (let t = 0; t < maxTicks && !done(); t++) {
            await q.guard(label);
            if (q.hp() < hpLast) damage += hpLast - q.hp();
            hpLast = q.hp();
            if (q.xp('Magic') > xpLast) landed++;
            xpLast = q.xp('Magic');
            if (q.dialogOpen()) { const d: any = q.s.sdk.getDialog(); if (!d.isWaiting) void q.s.sdk.sendClickDialog(0); }
            await keepPrayer();
            if (lastMsg(/do not have enough/i) > runes0) await q.fail(`${label}: out of runes`);
            if (casts - c0 >= 12 && q.xp('Magic') === mxp0) await q.fail(`${label}: no cast landed`);
            const n = pick();
            if (!n) {
                // The NPC list covers about 15 tiles. With no target in it for 3 ticks the leash method walks to the
                // mouth of the gap, where the floor of the arena is in view.
                // A form of Kolodion that lost its target walks about its start tile: the bot goes to 12 tiles from it.
                const sx = Math.max(SCOUT.x, (leash?.start.x ?? 0) - 12);
                if (home && MODE !== 'pray' && ++unseen >= 3 && !q.near(sx, ROW, 0)) await run(Math.min(sx, q.pos().worldX + 8), ROW);
                await q.waitTicks(1); continue;
            }
            unseen = 0;
            const ready = !q.dialogOpen() && q.T() - lastCast >= 5;
            const cast = async () => { casts++; lastCast = q.T(); await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: spell, reason: 'SDK' }); };
            if (MODE === 'pray' || !home) {
                if (ready) await cast();
                await q.waitTicks(1); continue;
            }
            if (n.index !== index) { index = n.index; leash = home(n); console.log(`NOTE ${label} npc ${n.id} start ${leash.start.x},${leash.start.z} safe ${leash.safe.x},${leash.safe.z} at ${q.T()}`); }
            const d = gap(n), ds = q.cheb(leash!.start.x, leash!.start.z), atSafe = ds >= LEASH - 1;
            // The first form has 3 Hitpoints and waits 5 ticks before its first spell: one cast ends it.
            // A form that came west of x 3101 has no tile 17 west of it (the ring ends at x 3084), and the gap is a
            // dead end with the form at its mouth. The bot stands and casts at such a form, takes its hits and eats.
            if (n.id === NPC.forms[0] || leash!.start.x - LEASH < RING_END) { if (ready) await cast(); }
            else if (ready && d <= 10 && (atSafe || d >= 7)) await cast();
            else if (ready && d > 10) {
                // Too far for the spell: a step toward the NPC, to 9 tiles from it. The next tick casts.
                // West of the mouth the bot keeps to the row of the gap; on the floor it also steps north or south.
                const x = Math.min(n.x - 9, SCOUT.x + 6), off = Math.abs(n.z - ROW) - 9;
                lures++;
                await run(x, x >= SCOUT.x && off > 0 ? ROW + Math.sign(n.z - ROW) * off : ROW);
            } else if (!q.near(leash!.safe.x, leash!.safe.z, 0)) await back(leash!.safe);
            await q.waitTicks(1);
        }
        console.log(`NOTE ${label} ${q.T() - t0} ticks casts=${casts - c0} landed=${landed} refused=${q.msgCount(/already under attack/i)} magicXp=${q.xp('Magic') - mxp0} damage=${damage} hp=${hp0}->${q.hp()} prayer=${points()} potions=${potions} lures=${lures} msgs=${(q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-3).map((m: any) => m.text).join(' / ')}`);
        if (!done()) await q.fail(`${label}: not done`);
    };
    // The tile to cast at a form of Kolodion from: on the row of the gap, 17 tiles west of the tile where the form
    // came. The row is open from the floor through the gap to x 3084. Each form comes where the form before it
    // ended, 5 to 10 tiles nearer to the gap, so the last forms often have no such tile.
    const kolodionHome = (n: any) => ({ start: { x: n.x, z: n.z }, safe: { x: n.x - LEASH, z: ROW } });

    // 1. Kolodion. At %magearena 0 to 5 he sends the player into the arena; at 6 or more he does not.
    let fought = false;
    if (!held(ITEM.cape) && !held(ITEM.staff)) {
        await setPray(true);
        // Kolodion shuts the pages 4 ticks before the player lands in the arena, so the talk ends only on the landing.
        const told = () => inArena() || (q.sawText(/step into the magic pool|carrying weapons or armour/i) && !q.dialogOpen());
        await q.step('kolodion', () => q.talkTo(npcs([NPC.kolodion])[0]), () => q.dialogOpen() || told(), 25, 3);
        await q.converse([/can i fight here/i, /yes indeedy/i, /ok, let's fight/i], told, 120);
        if (q.sawText(/carrying weapons or armour/i)) await q.fail('Kolodion refuses the pack');
        if (inArena()) {
            q.milestone('arena');
            fought = true;
            await fight('kolodion', () => npcs(NPC.forms)[0], componentId(SPELL), inCellar, 1500, kolodionHome);
            q.milestone('kolodion');
            await q.converse([], () => !q.dialogOpen(), 30);
        }
        await setPray(false);
    }
    const fightXp = q.gains();

    // 2. The pool, the statue of Zamorak, the guardian, the pool.
    if (!held(ITEM.staff)) {
        if (!held(ITEM.cape)) {
            if (inBank()) await locThen('pool to chamber', POOL_CELLAR, () => q.near(2509, 4689, 4));
            const ground = () => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.cape);
            await locThen('statue', STATUE, () => !!ground() || q.has(ITEM.cape), 20);
            await q.converse([], () => !q.dialogOpen(), 10);
            await q.step('cape', () => { const g = ground(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.cape), 12, 4);
            q.milestone('cape');
        }
        // The cape goes on before the staff comes: the guardian drops the staff on the floor of a full pack
        // (chamber_guardian.rs2:14).
        if (q.has(ITEM.cape)) await wear(ITEM.cape);
        await q.walk('to guardian', [{ x: GUARDIAN.x, z: GUARDIAN.z - 2, tol: 2 }]);
        await talkId('guardian', NPC.guardian, [], () => q.has(ITEM.staff), 60);
        q.milestone('staff');
    }
    if (q.has(ITEM.cape)) await wear(ITEM.cape);
    if (q.has(ITEM.staff)) await wear(ITEM.staff);
    if (inCellar() && !inBank()) await locThen('pool to cellar', POOL_CHAMBER, () => q.near(2542, 4718, 4));

    // 3. Up the ladder and through the webs, 99 casts of Flames of Zamorak in the arena, and back.
    const web = (w: { x: number; z: number }): any => q.findLoc(l => l.x === w.x && l.z === w.z && (l.optionsWithIndex ?? []).some((o: any) => /slash/i.test(o.text)));
    const cutWebs = async (order: typeof WEBS): Promise<void> => {
        for (const w of order) {
            for (let i = 0; i < 20 && web(w); i++) {
                await q.guard('web');
                await q.s.direct({ type: 'useItemOnLoc', itemSlot: q.slot(ITEM.knife)!, x: w.x, z: w.z, locId: web(w).id, reason: 'SDK' });
                await q.waitTicks(3);
            }
            if (web(w)) await q.fail(`web ${w.x},${w.z}`);
        }
    };
    await q.walk('to ladder', [{ x: LADDER_UP.x - 1, z: LADDER_UP.z, tol: 1 }]);
    await q.climb('ladder up', () => q.locAt(LADDER_UP.x, LADDER_UP.z), /climb-up/i, () => !inCellar());
    await cutWebs(WEBS);
    const unlocked = (): boolean => q.msgCount(/can now cast Flames of Zamorak outside/i) > 0 || q.sawText(/may now use this spell outside/i);
    await q.dash('to portal', PORTAL.x, PORTAL.z + 1, 0, 40);
    await setPray(true);
    await q.step('portal in', () => q.opLoc(PORTAL, 1), () => inArena(), 8, 4);
    q.milestone('portal');
    await q.dash('into the arena', 3105, 3946, 1, 30);
    // The arena is single combat: a cast at one mage while another attacks the player is refused ("I'm already
    // under attack!") and does not count. So the target is the mage that attacks the player, else the mage of the
    // cast before, else the nearest. The leash does not work here: a mage of another god follows the player into the
    // gap, and its reach ends past the end of the ring. An account with no prayer takes the hits and eats; with
    // FOOD_FLOOR pieces or fewer left it goes out, and a later run goes on from the count that %zamomage holds.
    let mage = -1;
    const foodLow = (): boolean => MODE !== 'pray' && q.cnt(ITEM.food) <= FOOD_FLOOR;
    await fight('casts', () => {
        const all = npcs(NPC.mages), n = all.find((m: any) => m.targetIndex >= 32768 && m.distance <= 10) ?? all.find((m: any) => m.index === mage) ?? all[0];
        mage = n?.index ?? -1;
        return n;
    }, FLAMES, () => unlocked() || foodLow(), 1200);
    if (unlocked()) q.milestone('casts');
    await q.converse([], () => !q.dialogOpen(), 10);
    await q.dash('to portal inside', PORTAL.x, PORTAL.z, 0, 40);
    await q.step('portal out', () => q.opLoc(PORTAL, 1), () => !inArena(), 8, 4);
    await setPray(false);
    await q.dash('to webs', WEBS[1]!.x + 1, WEBS[1]!.z, 0, 40);
    await cutWebs([...WEBS].reverse());
    await q.climb('ladder down', () => q.locAt(LADDER_DOWN.x, LADDER_DOWN.z), /climb-down/i, inCellar);
    q.milestone('complete');
    const ok = held(ITEM.cape) && held(ITEM.staff) && unlocked();
    if (!ok && foodLow()) console.log(`WARN food low after ${casts} casts: the count stays, a second run ends the casts`);
    await q.end(ok, `mode=${MODE} spell=${SPELL} fought=${fought} fightXp=${fightXp || '-'} casts=${casts} lures=${lures} potions=${potions} prayerLeft=${points()} cape=${held(ITEM.cape)} staff=${held(ITEM.staff)} unlocked=${unlocked()}`);
} catch (e) { await q.fail(String(e)); }
