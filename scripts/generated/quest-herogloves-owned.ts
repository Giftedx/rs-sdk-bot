// Ice gloves for Heroes' Quest on one owned account: the Ice Queen's drop at the end of White Wolf Mountain's ladder maze.
// From preset quest_herogloves-owned (west of the hero rockslide; Mining 50 and a pickaxe clear it,
// areas/area_white_wolf_mountain/scripts/white_wolf_mountain.rs2:14-22). The route, the ladders and the Fire Blast loop
// follow iceQueen() in quest-hero.ts. Then Camelot Teleport and the Seers bank: quest-hero-owned.ts stages the gloves
// from the bank. The `-owned` suffix keeps this phase out of the brain's quest board (packages/brain/src/catalog.ts).
// Usage: bun scripts/aio-quester.ts <account> sweep herogloves-owned (the sweep stages the preset's kit first).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';
import { depositObserved } from '../../packages/core/src/deposit';

const GLOVES = 1580;
const PRAYER_POT = [2434, 139, 141, 143];
const PFM = 14;                                              // protect_from_melee (sdk PRAYER_INDICES)
const BLAST = componentId('magic:fire_blast');
const QUEEN = 795;
const ICE_ADDS = [145, 125, 111, 64];                        // ice warrior (both), ice giant, ice spider
const QUEEN_AT = { x: 2866, z: 9952 };
const ROCKSLIDE = { id: 2634, x: 2838, z: 3517 };            // herorockslide, op2 Mine
const CAMELOT = { x: 2757, z: 3477 };
const SEERS_BANK = { x: 2726, z: 3492 };
type Tile = { x: number; z: number };

const q = await openQuest({ cap: Number(process.env.HEROGLOVES_CAP ?? 2500) });
const x = () => q.pos()?.worldX ?? 0;
const z = () => q.pos()?.worldZ ?? 0;
const under = () => z() > 6400;
const ground = (id: number, r = 14): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id && g.distance <= r).sort((a: any, c: any) => a.distance - c.distance)[0];
const npcsOf = (ids: number[]): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => ids.includes(n.id)).sort((a: any, c: any) => a.distance - c.distance);
const pfmOn = (): boolean => !!q.st()?.prayers?.activePrayers?.[PFM];
const pfm = async (on: boolean) => { if (pfmOn() !== on) await q.step(`pfm ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3); };
const keepPrayer = async () => {
    if ((q.st()?.prayers?.prayerPoints ?? 99) >= 15) return;
    const pot = PRAYER_POT.find(id => q.has(id));
    if (pot) { await q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }); await q.waitTicks(2); }
};
const ladder = async (id: number, lx: number, lz: number, stand: Tile, label: string) => {
    const was = under();
    await q.walk(label, [{ ...stand, tol: 0 }]);
    await q.climb(label, () => q.findLoc((l: any) => l.id === id && l.x === lx && l.z === lz) ?? { id, x: lx, z: lz }, /climb/i, () => under() !== was);
};

// One Fire Blast each `every` ticks on the queen until the gloves lie on the ground or in the pack. An add that holds the
// account in combat ("I'm already under attack!", single-way) dies first. No Magic XP for 40 ticks with the queen in view
// means a stale npc entry, so the account walks out of view and back (quest-hero.ts cast()).
async function castAtQueen(done: () => boolean, ticks: number, every: number, away: Tile): Promise<void> {
    let last = -100, busy = q.msgCount(/already under attack/i), add = -1, xp0 = q.xp('Magic'), xpAt = q.T();
    for (let t = 0; t < ticks && !done(); t++) {
        await q.guard('ice queen');
        await keepPrayer();
        const c = q.msgCount(/already under attack/i);
        if (c !== busy) { busy = c; add = npcsOf(ICE_ADDS).filter(n => n.distance <= 8)[0]?.index ?? -1; }
        let n = add >= 0 ? npcsOf(ICE_ADDS).find(k => k.index === add) : undefined;
        if (!n) { add = -1; n = npcsOf([QUEEN])[0]; }
        if (q.xp('Magic') !== xp0) { xp0 = q.xp('Magic'); xpAt = q.T(); }
        if (!n) {
            if (!q.near(QUEEN_AT.x, QUEEN_AT.z, 5) && t % 10 === 0) await q.walk('ice queen anchor', [{ ...QUEEN_AT, tol: 3 }]);
            xpAt = q.T();
            await q.waitTicks(1);
            continue;
        }
        if (q.T() - xpAt >= 40) {
            console.log(`NOTE ice queen: no cast landed in 40 ticks at ${x()},${z()}, target ${n.index} ${n.x},${n.z}: out of view and back`);
            await q.walk('ice queen away', [{ ...away, tol: 2 }]);
            await q.walk('ice queen back', [{ ...QUEEN_AT, tol: 3 }]);
            xpAt = q.T(); last = -100;
            continue;
        }
        if (q.T() - last >= every) { last = q.T(); await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: BLAST, reason: 'SDK' }); }
        await q.waitTicks(1);
    }
    if (!done()) await q.fail('ice queen: no gloves');
}

try {
    if (!q.has(GLOVES)) {
        // The lair (x2857-2877 z9917-9964): the rockslide from its west side, ladder down at 2848,3513, underground west
        // to 2824,9907, up, down at 2827,3510, underground east to 2857,9917, up into the sealed nook, down at 2859,3519.
        // Each climb keeps the tile (z +- 6400), so the stand tiles are exact.
        await q.walk('rockslide', [{ x: 2837, z: 3517, tol: 0 }]);
        await q.step('rockslide', () => {
            const l = q.findLoc((k: any) => k.x === ROCKSLIDE.x && k.z === ROCKSLIDE.z && k.id === ROCKSLIDE.id) ?? ROCKSLIDE;
            return q.opLoc(l, 2);
        }, () => x() >= 2839, 12, 4);
        q.milestone('rockslide');
        await pfm(true);
        await ladder(1759, 2848, 3513, { x: 2849, z: 3513 }, 'ladder 2848,3513');
        await ladder(1755, 2824, 9907, { x: 2825, z: 9907 }, 'ladder 2824,9907');
        await ladder(1759, 2827, 3510, { x: 2828, z: 3510 }, 'ladder 2827,3510');
        await ladder(1755, 2857, 9917, { x: 2858, z: 9917 }, 'ladder 2857,9917');
        await ladder(1759, 2859, 3519, { x: 2860, z: 3519 }, 'ladder 2859,3519');
        q.milestone('lair');
        await q.walk('ice queen', [{ ...QUEEN_AT, tol: 3 }]);
        await castAtQueen(() => !!ground(GLOVES) || q.has(GLOVES), 1100, 5, { x: 2860, z: 9921 });
        if (!q.has(GLOVES)) {
            await q.step('ice gloves', () => {
                const g = ground(GLOVES);
                return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: GLOVES, reason: 'SDK' }) : undefined;
            }, () => q.has(GLOVES), 15, 4);
        }
        await pfm(false);
    }
    q.milestone('ice gloves');
    await q.teleport('camelot teleport', 'magic:camelot_teleport', CAMELOT.x, CAMELOT.z);
    await q.walk('seers bank', [{ ...SEERS_BANK, tol: 2 }]);
    if (!(await q.s.bot.openBank()).success || !(await q.waitUntil(() => !!q.st()?.bank?.isOpen, 10))) await q.fail('seers bank did not open');
    const row = q.inv().find((i: any) => i.id === GLOVES);
    if (!row) await q.fail('ice gloves not held at the bank');
    const banked = await depositObserved(q.s, row);
    await q.s.bot.closeBank();
    q.milestone('banked');
    await q.end(banked === 1, `gloves=${banked}`);
} catch (e) { await q.fail(String(e)); }
