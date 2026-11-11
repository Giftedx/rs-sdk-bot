// Ranged camp on Taverley's two black dragons, from the corridor south of their cave.
// bun scripts/black-dragon-camp.ts <account> [cap ticks=9000]   Env: KILLS (default 9), STAGED=1 (start in the corridor
// with the kit worn, no bank trip). Without STAGED it is one bank-owned trip (scripts/microbot-combat-trip.ts blackKit):
// ARROW names the arrow (default mithril_arrow) and ARROWS its count (default 700).
//
// Server facts (vendor/rs-sdk/server/content):
// - black_dragon (npc 54): size 4, level 227, 190 hitpoints, Defence 200, ranged defence 50, respawn 60 ticks
//   (scripts/_unpack/225/all.npc). Two spawn in the cave, at 2829,9826 and 2835,9824 (maps/m44_153.jm2).
// - A dragon attacks only a player beside it: one attack in four is fire (up to 30, or 50 on a failed roll, 5 behind
//   an anti-dragon shield, 10 under Protect from Magic), the rest melee (npc/scripts/dragon.rs2). It has no attack
//   from a distance.
// - Every kill drops dragon bones and one black dragonhide on the dragon's south-west tile, for 200 ticks
//   (drop tables/scripts/black_dragon.rs2, lootdrop.constant).
// The corridor south of the cave is three tiles wide (2834-2836, 9818-9821). A 4x4 dragon cannot enter it, and from
// 2835,9820 no tile a dragon can stand on is within one tile, while the dragon that spawns on 2835,9824 is in sight
// four tiles north (BLACK_DRAGON.safe; scripts/black-dragon-camp.test.ts recomputes both from the collision data). The row north of it, 9821, is beside dragon ground: practice, an account that stepped there fell from 96
// to 22 hitpoints in 20 ticks. So the camp never lets an attack walk it: it shoots only a dragon it can see from the
// tile, and a step off the tile is walked back before anything else.
// The loot lies inside the cave, and the other dragon comes as near the camp tile as it can, which is beside the
// pile. The camp fetches the pile under Protect from Magic: a breath is then 10 at most and a melee hit about 21
// (Strength 200), so three attacks cost at most 63 of the 75 hitpoints a fetch starts with. Under Protect from Melee
// a breath is up to 50 (practice: 99 to 74 in one, on the pile beside a dragon) and three could kill. It takes its own
// arrows from the pile too. Every lost hitpoint is logged (`DRAGON_CAMP hit`): the steady 4 to 6 every 30 ticks on the
// tile is the poison of the spiders on the way in.
import { existsSync } from 'node:fs';
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { initPathfinding } from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import type { NearbyNpc } from '../vendor/rs-sdk/sdk/types';
import { giantStyle } from './gather-combat';
import { BLACK_BANK, blackKit, combatTrip, varrockTeleport } from './microbot-combat-trip';
import { walkTargetPersist } from './walk-to';

export type Tile = { x: number; z: number };
export const BLACK_DRAGON = { npc: 54, size: 4, hitpoints: 190, hide: 1747, bones: 536, safe: { x: 2835, z: 9820 } as Tile, range: 5, spawns: [{ x: 2829, z: 9826 }, { x: 2835, z: 9824 }] as Tile[] } as const;
// Food the camp eats, best first; arrows it fires (bronze to rune); Protect from Magic (prayers.dbrow order).
export const CAMP_FOOD = [385, 373, 379] as const, CAMP_ARROWS = [892, 890, 888, 886, 884, 882] as const, PROTECT_MAGIC = 12;
export const EAT_AT = 60, DASH_HP = 75, MIN_ARROWS = 60, OTHER_CLEAR = 5, OTHER_WAIT = 40;
// Ticks without Ranged experience before the attack is sent again. Practice, magic shortbow and mithril arrows at
// Ranged 99: one kill took 432 ticks with the attack sent again after 20 quiet ticks, and about 235 with it sent every 5.
export const REATTACK = 6;

// Tiles between a tile and a dragon's 4x4 footprint (0 when the tile is under it).
export function footprintDistance(sw: Tile, tile: Tile, size: number = BLACK_DRAGON.size): number {
    return Math.max(Math.max(sw.x - tile.x, tile.x - (sw.x + size - 1), 0), Math.max(sw.z - tile.z, tile.z - (sw.z + size - 1), 0));
}
// Whether a dragon standing at `sw` can be shot from `tile` without the game walking the shooter: its south-west tile
// is within `range` and in sight, and so is its footprint. The range is two tiles inside a shortbow's seven:
// practice, a first shot from 2835,9820 at a dragon on 2828,9824 (seven tiles west, in sight by the collision data)
// walked the account to 2834,9822, onto dragon ground, while 1,500 ticks of shots at dragons within five tiles moved
// it nowhere.
export function canShoot(tile: Tile, sw: Tile, range: number = BLACK_DRAGON.range): boolean {
    initPathfinding();
    return Math.max(Math.abs(sw.x - tile.x), Math.abs(sw.z - tile.z)) <= range
        && rsmod.hasLineOfSight(0, tile.x, tile.z, sw.x, sw.z, 1, 1, 1, 1, 0)
        && rsmod.hasLineOfSight(0, tile.x, tile.z, sw.x, sw.z, 1, 1, BLACK_DRAGON.size, BLACK_DRAGON.size, 0);
}
// The south-west tile of an NPC: the SDK's route tile when it has one (`x`/`z` are the render position, offset for a
// large NPC).
export const swTile = (n: Pick<NearbyNpc, 'x' | 'z' | 'tileX' | 'tileZ'>): Tile => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

export async function runBlackDragonCamp(s: Session, o: { cap: number; kills: number; stop?: () => boolean }) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || o.cap > 20000 || !Number.isSafeInteger(o.kills) || o.kills < 1) throw Error('invalid camp cap or kills');
    const SAFE = BLACK_DRAGON.safe;
    const st = () => s.sdk.getState(), me = () => st()?.player;
    const at = (t: Tile) => { const p = me(); return !!p && p.level === 0 && p.worldX === t.x && p.worldZ === t.z; };
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0, xp = () => s.sdk.getSkillXp('Ranged') ?? 0;
    const inv = () => s.sdk.getInventory(), eq = () => s.sdk.getEquipment();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const quiver = () => eq().find(i => i.slot === 13 && (CAMP_ARROWS as readonly number[]).includes(i.id));
    const points = () => st()?.prayers?.prayerPoints ?? 0, praying = () => !!st()?.prayers?.activePrayers?.[PROTECT_MAGIC];
    const own = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
    const p0 = me();
    // The trip ends its walk in the corridor's south half; the camp takes the tile from there.
    if (!p0 || p0.level !== 0 || Math.abs(p0.worldX - SAFE.x) > 1 || p0.worldZ > SAFE.z || p0.worldZ < SAFE.z - 3) throw Error(`stage in the corridor at or south of ${SAFE.x},${SAFE.z}`);
    if (!eq().some(i => i.slot === 3) || (quiver()?.count ?? 0) < MIN_ARROWS) throw Error(`stage with a bow wielded and ${MIN_ARROWS} arrows in the quiver`);
    if (typeof st()?.autoRetaliateEnabled !== 'boolean') throw Error('auto-retaliate state unknown');
    const ammo = quiver()!.id, ammo0 = quiver()!.count + held(ammo), start = s.tick(), xp0 = xp(), initialRetaliate = st()!.autoRetaliateEnabled;
    let ended = false; void s.ended.then(() => { ended = true; });
    const alive = () => { const p = me(); return !ended && !!p && !p.isDead && p.lifeId === p0.lifeId && hp() > 0; };
    const over = () => !alive() || !!o.stop?.() || s.tick() - start >= o.cap;
    let kills = 0, hides = 0, bones = 0, strays = 0, hpMin = hp(), foods = 0, lostPiles = 0, failure = '', reason = '';
    // Every lost hitpoint is logged with where the account stood and what was aiming at it (the first 20 of a run).
    let lastHp = hp(), hits = 0;
    const off = s.onTick(() => {
        const now = hp(), p = me();
        if (now < lastHp && hits++ < 20) console.log(`DRAGON_CAMP hit t=${s.tick() - start} hp=${lastHp}->${now} at=${p?.worldX},${p?.worldZ} pray=${praying() ? 1 : 0} by=${JSON.stringify((st()?.nearbyNpcs ?? []).filter(n => Number.isInteger(own) && n.targetIndex === 32768 + own!).map(n => `${n.name}@${swTile(n).x},${swTile(n).z}`))}`);
        lastHp = now; hpMin = Math.min(hpMin, now);
    });
    const dragons = () => (st()?.nearbyNpcs ?? []).filter(n => n.id === BLACK_DRAGON.npc && n.hp !== 0);
    const attackOp = (n: NearbyNpc) => n.optionsWithIndex.find(v => /^attack$/i.test(v.text))?.opIndex;
    const backToSafe = async () => {
        if (at(SAFE)) return;
        strays++;
        await walkPath(await sessionWalker(s), [{ ...SAFE, tol: 0 }], { maxTicks: 40, stop: () => !alive() });
        if (!at(SAFE)) throw Error('return to the safe tile failed');
    };
    const eat = async (below: number) => {
        while (hp() < below && alive()) {
            const food = inv().find(i => (CAMP_FOOD as readonly number[]).includes(i.id));
            if (!food) return;
            const before = hp();
            await s.sdk.sendUseItem(food.slot, 1);
            if (!await waitUntil(s, () => hp() > before || !alive(), { timeoutTicks: 4 })) return;
            foods++;
            await waitTicks(s, 2);
        }
    };
    const pray = async (on: boolean) => {
        if (praying() === on || on && points() <= 0) return;
        await s.sdk.sendTogglePrayer(PROTECT_MAGIC);
        await waitUntil(s, () => praying() === on, { timeoutTicks: 3 });
    };
    // A dragon the tile can shoot, one already on this account first. Never one another player fights.
    const pick = () => dragons().filter(n => attackOp(n) !== undefined && canShoot(SAFE, swTile(n)) && (!n.inCombat || Number.isInteger(own) && n.targetIndex === 32768 + own!))
        .sort((a, b) => Number(b.inCombat) - Number(a.inCombat) || (a.hp ?? BLACK_DRAGON.hitpoints) - (b.hp ?? BLACK_DRAGON.hitpoints) || a.distance - b.distance)[0];
    // Anything else that fights this account at the tile (a poison spider that followed it in) is shot first.
    const intruder = () => (st()?.nearbyNpcs ?? []).find(n => n.id !== BLACK_DRAGON.npc && n.hp !== 0 && Number.isInteger(own) && n.targetIndex === 32768 + own! && attackOp(n) !== undefined);
    const groundKey = (g: { id: number; x: number; z: number }) => `${g.id}:${g.x}:${g.z}`;
    const fetch = async (pile: Tile) => {
        // Wait while the other dragon stands by the pile; the drop lasts 200 ticks.
        for (let t = 0; t < OTHER_WAIT && !over() && dragons().some(n => footprintDistance(swTile(n), pile) <= OTHER_CLEAR); t += 2) await waitTicks(s, 2);
        await eat(DASH_HP);
        if (over()) return;
        if (points() <= 0 && (hp() < DASH_HP || dragons().some(n => footprintDistance(swTile(n), pile) <= 2))) { lostPiles++; console.log(`DRAGON_CAMP pile left at ${pile.x},${pile.z}: no prayer and a dragon beside it`); return; }
        await pray(true);
        try {
            for (const id of [BLACK_DRAGON.hide, BLACK_DRAGON.bones, ammo]) {
                const g = s.sdk.getGroundItems().find(i => i.id === id && i.x === pile.x && i.z === pile.z);
                if (!g || id === ammo && g.count < 5 || id !== ammo && inv().length >= 28) continue;
                const before = held(id);
                if (!(await s.sdk.sendPickup(g.x, g.z, g.id)).success) continue;
                await waitUntil(s, () => held(id) > before || !alive(), { timeoutTicks: 14 });
                if (id === BLACK_DRAGON.hide) hides += held(id) - before; else if (id === BLACK_DRAGON.bones) bones += held(id) - before;
            }
        } finally {
            if (alive()) { await backToSafe(); strays--; await pray(false); }
        }
        const picked = inv().find(i => i.id === ammo);
        if (picked) { await s.bot.equipItem(picked); await waitUntil(s, () => held(ammo) === 0, { timeoutTicks: 5 }); }
    };
    try {
        if (initialRetaliate) { await s.direct({ type: 'clickComponent', componentId: 151, reason: 'camp holds its tile' }); if (!await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 8 })) throw Error('auto-retaliate off unobserved'); }
        // A bow's rapid style fires a tick sooner (scripts/gather-combat.ts giantStyle).
        const style = giantStyle(st()?.combatStyle as Parameters<typeof giantStyle>[0], 'Ranged');
        if (st()?.combatStyle?.currentStyle !== style.index) { await s.sdk.sendSetCombatStyle(style.index); await waitUntil(s, () => st()?.combatStyle?.currentStyle === style.index, { timeoutTicks: 8 }); }
        let idle = 0;
        while (!over() && kills < o.kills) {
            await backToSafe();
            await eat(EAT_AT);
            if (hp() < EAT_AT && !inv().some(i => (CAMP_FOOD as readonly number[]).includes(i.id))) { reason = 'out of food'; break; }
            if ((quiver()?.count ?? 0) < MIN_ARROWS) { reason = 'arrows low'; break; }
            if (inv().length > 26) { reason = 'pack full'; break; }
            const foe = intruder(), target = foe ?? pick();
            if (!target) { await waitTicks(s, 2); idle += 2; if (idle >= 400) { reason = 'no dragon in sight for 400 ticks'; break; } continue; }
            idle = 0;
            const ground0 = new Set(s.sdk.getGroundItems().filter(g => g.id === BLACK_DRAGON.hide).map(groundKey));
            if (!(await s.sdk.sendInteractNpc(target.index, attackOp(target)!)).success) { await waitTicks(s, 2); continue; }
            let lastXp = xp(), lastHit = s.tick(), gone = false;
            while (!over()) {
                await waitTicks(s, 1);
                if (!at(SAFE)) { const p = me(), q = (st()?.nearbyNpcs ?? []).find(v => v.index === target.index); console.log(`DRAGON_CAMP stray t=${s.tick() - start} at=${p?.worldX},${p?.worldZ} target=${q ? `${swTile(q).x},${swTile(q).z}` : 'gone'} hp=${hp()}`); break; }
                const n = (st()?.nearbyNpcs ?? []).find(v => v.index === target.index && v.id === target.id);
                if (!n || n.hp === 0) { gone = true; break; }
                // The dragon walked out of the tile's reach: the next shot would walk the account after it (practice: a
                // step to 2834,9822 after a dragon that had gone seven tiles west). A walk to the tile it stands on
                // ends the attack.
                if (target.id === BLACK_DRAGON.npc && !canShoot(SAFE, swTile(n))) { await s.sdk.sendWalk(SAFE.x, SAFE.z); break; }
                if (xp() > lastXp) { lastXp = xp(); lastHit = s.tick(); }
                if (hp() < EAT_AT) { await eat(EAT_AT); lastHit = s.tick() - REATTACK; }
                if (!foe && intruder()) break;
                if (s.tick() - lastHit >= REATTACK) {
                    // No hit for REATTACK ticks: a run of misses, a lapsed attack, or the dragon left the tile's sight.
                    if (target.id === BLACK_DRAGON.npc && !canShoot(SAFE, swTile(n))) break;
                    await s.sdk.sendInteractNpc(n.index, attackOp(n) ?? attackOp(target)!);
                    lastHit = s.tick();
                }
            }
            if (!gone || target.id !== BLACK_DRAGON.npc) continue;
            // The hide on the ground is the kill's proof and names its tile.
            let pile: Tile | undefined;
            await waitUntil(s, () => { const g = s.sdk.getGroundItems().find(i => i.id === BLACK_DRAGON.hide && !ground0.has(groundKey(i))); if (g) pile = { x: g.x, z: g.z }; return !!g || !alive(); }, { timeoutTicks: 8 });
            if (!pile) continue;
            kills++;
            console.log(`DRAGON_CAMP kill ${kills} t=${s.tick() - start} pile=${pile.x},${pile.z} hp=${hp()} arrows=${quiver()?.count ?? 0}`);
            await fetch(pile);
        }
        if (!reason) reason = kills >= o.kills ? 'kills met' : o.stop?.() ? 'stopped' : !alive() ? 'life lost' : 'cap';
    } catch (e) { failure = String(e); }
    finally {
        off();
        if (alive()) try {
            await pray(false);
            if (st()?.autoRetaliateEnabled !== initialRetaliate) { await s.direct({ type: 'clickComponent', componentId: initialRetaliate ? 150 : 151, reason: 'restore camp auto-retaliate' }); await waitUntil(s, () => st()?.autoRetaliateEnabled === initialRetaliate, { timeoutTicks: 8 }); }
        } catch (e) { failure += '; cleanup ' + String(e); }
    }
    const ammoUsed = ammo0 - (quiver()?.count ?? 0) - held(ammo);
    return { ok: !failure && alive() && kills > 0, kills, hides, bones, lostPiles, reason, failure, strays, hpMin, foods, ammo, ammoUsed, drops: { [BLACK_DRAGON.hide]: hides, [BLACK_DRAGON.bones]: bones }, rangedXp: xp() - xp0, ticks: s.tick() - start };
}

// An account that starts a trip inside the dungeon (a trip whose return failed left it on the camp tile with its
// loot) leaves by the trip's own teleport and banks its pack at Varrock West. No walker plans a way out for it: a
// planned route can cross dragon ground, the black demons or the blue dragons with a bow and no armour.
export const VARROCK_WEST = { x: 3185, z: 3436 }, TELEPORT_RUNES = { 563: 1, 556: 3, 554: 1 } as const;
export const underground = (p: { worldZ: number } | null | undefined) => !!p && p.worldZ > 9000;
export async function leaveToVarrock(s: Session): Promise<{ banked: Record<number, number> }> {
    const st = () => s.sdk.getState(), inv = () => s.sdk.getInventory(), held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    for (const [id, n] of Object.entries(TELEPORT_RUNES)) if (held(Number(id)) < n) throw Error(`black dragon leave: ${held(Number(id))} of rune ${id} in the pack, the Varrock teleport needs ${n}; a person decides the way out`);
    if (!await varrockTeleport(s)) throw Error('black dragon leave: the Varrock teleport did not take the account');
    const walked = await walkPath(await sessionWalker(s), [{ ...VARROCK_WEST, tol: 1 }], { maxTicks: 200 });
    if (!walked.ok) throw Error(`black dragon leave: walk to the Varrock West bank: ${walked.detail}`);
    const generation = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 })) throw Error('black dragon leave: bank did not open');
    const banked: Record<number, number> = {};
    for (const id of new Set(inv().map(i => i.id))) {
        const row = inv().find(i => i.id === id), n = held(id);
        if (!row || !(await s.bot.depositItem(row, n)).success || !await waitUntil(s, () => held(id) === 0, { timeoutTicks: 10 })) throw Error(`black dragon leave: deposit of item ${id}`);
        banked[id] = n;
    }
    await s.bot.closeBank();
    await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 10 });
    return { banked };
}

if (import.meta.main) {
    let s: Session | undefined, stopped = false;
    try {
        const [account, cap] = process.argv.slice(2);
        if (!account) throw Error('account required');
        s = await openBot(account, { onStop: async () => { stopped = true; } });
        const stop = () => stopped || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all');
        const kills = Number(process.env.KILLS ?? 9);
        if (process.env.STAGED === '1') {
            const r = await runBlackDragonCamp(s, { cap: Number(cap ?? 6000), kills, stop });
            console.log('BLACK_DRAGON_CAMP_RESULT ' + JSON.stringify(r));
            await finish([s], r.ok, `black-dragon-camp kills=${r.kills} hides=${r.hides} bones=${r.bones} ammoUsed=${r.ammoUsed} foods=${r.foods} hpMin=${r.hpMin} strays=${r.strays} reason=${r.reason}${r.failure ? ' failure=' + r.failure : ''}`);
        } else {
            // The whole trip: to the Falador west bank by the shared walker (any teleport it likes, nothing is packed
            // yet), then kit out, Taverley, the dusty key gate, the camp, a Varrock teleport and the Varrock West bank.
            // LEAVE=1 only brings an account home from the dungeon; a trip that starts there does that first.
            const live = s;
            await waitUntil(live, () => !!live.sdk.getState()?.player, { timeoutTicks: 15 });
            if (underground(live.sdk.getState()?.player)) {
                const out = await leaveToVarrock(live);
                console.log('DRAGON_CAMP left the dungeon ' + JSON.stringify(out));
                if (process.env.LEAVE === '1') { await finish([s], true, `black-dragon-leave hides=${out.banked[BLACK_DRAGON.hide] ?? 0} bones=${out.banked[BLACK_DRAGON.bones] ?? 0} banked=true`); process.exit(0); }
            } else if (process.env.LEAVE === '1') throw Error('black dragon leave: the account is not in the dungeon');
            const here = live.sdk.getState()?.player;
            if (!here || here.level !== 0 || Math.max(Math.abs(here.worldX - BLACK_BANK.x), Math.abs(here.worldZ - BLACK_BANK.z)) > 3) {
                const there = await walkTargetPersist(live, BLACK_BANK);
                if (!there.ok) throw Error(`route to the Falador west bank: ${there.reason ?? ''} ${there.detail ?? ''}`);
            }
            const kit = blackKit(process.env.ARROW ?? 'mithril_arrow', Number(process.env.ARROWS ?? 700));
            const r = await combatTrip(live, 'black', async tripStop => { const c = await runBlackDragonCamp(live, { cap: 5000, kills, stop: tripStop }); return { ...c, failure: c.failure }; }, { cap: Number(cap ?? 9000), stop, kit });
            const c = r.result as Awaited<ReturnType<typeof runBlackDragonCamp>> | undefined;
            console.log('BLACK_DRAGON_TRIP_RESULT ' + JSON.stringify(r));
            await finish([s], r.ok, `black-dragon-trip kills=${c?.kills ?? 0} hides=${c?.hides ?? 0} bones=${c?.bones ?? 0} ammoUsed=${c?.ammoUsed ?? 0} hpMin=${c?.hpMin ?? '-'} banked=${r.banked} ticks=${r.ticks}${r.failure ? ' failure=' + r.failure : ''}`);
        }
    } catch (e) { await finish(s ? [s] : [], false, String(e)); }
}
