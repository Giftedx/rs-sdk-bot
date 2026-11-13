// Cannon fight: set up a dwarf multicannon at a spot from CANNON_SPOTS, keep it loaded, and fight beside it with the
// worn weapon (a bow and its ammo, or a melee weapon). It picks up nothing. At the end it takes the cannon back and
// walks clear of the NPCs before logout.
// Usage: bun scripts/cannon-fight.ts <account> [KEY=value ...]
// Env: SPOT (a CANNON_SPOTS key, default spiders), CAP (ticks, default 3000), STOP_SKILL and STOP_LEVEL (end at that
// base level, default Ranged 99), STYLE (combat style index; unset keeps the current style), RELOAD (ticks between
// top-ups, default 20), PRAYER (a sdk PrayerName kept on, with a prayer potion at 10 points; `none` for no prayer;
// default from the spot), EAT_AT (hitpoints; default 40% of the base level).
//
// Server facts (vendor/rs-sdk/server/content/scripts/quests/quest_mcannon/scripts):
// - Set-up: the player's tile is the centre of the 3x3 cannon, the loc sits on its south-west tile and the player steps
//   to a tile 2 out (cannon_setup.rs2:90-124). Stand, barrels and furnace go on with item-on-loc (lines 144-226).
// - [timer,cannon_rotate] turns one of 8 directions a tick and fires at most once a tick (cannon_fire.rs2:1-91). It
//   checks for ammo only when it faces north (line 21) and then stops: Fire (oploc1) starts it again (line 262).
//   A load (oplocu with cannonballs) fills to 30 and does not restart it (lines 264-278).
// - A hit gives 2 Ranged XP per damage and no Hitpoints XP (cannon_fire.rs2:116-119; 50 Ranged XP at the server's 25x,
//   engine/src/util/WorldConfig.ts:102). The roll uses the worn weapon and style (`%damagetype`, line 116).
// - The rotate timer is a normal timer, so it waits while the player is busy (engine/src/engine/entity/Player.ts:1069,
//   937-947). A level-up message is a chat modal (levelup/scripts/levelup.rs2:54), so each open one stops the cannon
//   and the attack until it closes. The fight closes it on the tick it sees it.
// - In single-way combat the cannon hits only the NPC the player fights (player_combat.rs2:101-126): use multiway spots.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { PRAYER_NAMES, type PrayerName } from '../vendor/rs-sdk/sdk/types';

export type Tile = { x: number; z: number; level: number };
export type CannonSpot = { label: string; centre: Tile; target: string; prayer: PrayerName | 'none'; near: number };

// Each centre has a free 3x3 for set-up; set-up tries a spiral up to 6 tiles out when it is blocked.
export const CANNON_SPOTS: Readonly<Record<string, CannonSpot>> = {
    // Wilderness level 37 (z 3810). Map square 51_59 holds 62 poison spiders (npc 134, maps/m51_59.jm2 NPC section) and
    // all of it is multiway (maps/multiway.csv 0_51_59_*). Poison spider: hitpoints 64, defence 52, ranged defence 14,
    // stab attacks, wanderrange 10, respawnrate 60, huntmode cowardly, huntrange 1 (_unpack/225/all.npc:3476-3498);
    // cowardly attacks any player in the Wilderness (all.hunt:37-45). Spawn density puts 7.8 of the 8 cannon directions
    // over a spider within 3 tiles of this centre (.practice/cannon-spiders/placement.ts).
    spiders: { label: 'Wilderness poison spiders', centre: { x: 3287, z: 3810, level: 0 }, target: '^poison spider$', prayer: 'protect_from_melee', near: 10 },
    // Gnome battlefield, multiway (maps/multiway.csv "gnome battlefield"), 23 khazard_troop and 16 khazard_troop_spearmen
    // (maps/m39_50.jm2); research/combat-measure.md section 6.
    battlefield: { label: 'Gnome battlefield troopers', centre: { x: 2525, z: 3242, level: 0 }, target: '^khazard trooper$', prayer: 'none', near: 10 },
};

export const CANNON_PARTS = [/^cannon base$/i, /^cannon stand$/i, /^cannon barrels$/i, /^cannon furnace$/i] as const;
export const CANNON_BALL = /^cannonball$/i;
const FOOD = /^(shrimps|trout|salmon|tuna|lobster|swordfish|monkfish|shark)$/i;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// "You load the cannon with 30 cannonballs." (cannon_setup.rs2:276); 0 for any other message.
export function loadedBalls(text: string): number {
    const m = text.match(/^You load the cannon with (\d+) cannonballs\.$/);
    return m ? Number(m[1]) : 0;
}

// The top-up is due when the cannon reported empty, or RELOAD ticks passed since the last load. The cannon fires at
// most once a tick and holds 30 (cannon_setup.rs2:270-274), so an interval of 30 or less never runs it dry.
export function reloadDue(o: { now: number; lastLoad: number; interval: number; empty: boolean }): boolean {
    return o.empty || o.now - o.lastLoad >= o.interval;
}

export type TargetNpc = { index: number; name: string; x: number; z: number; hp: number | null; distance: number; targetIndex: number; reachable?: boolean; optionsWithIndex: { text: string; opIndex: number }[] };
// The next target: a live NPC of the spot within `near` tiles of the cannon centre and within `reach` of the player
// (a bow does not walk), with an Attack option. NPCs next to the player come first (they fight it and stand in the
// cannon's close range), then the lowest hitpoints, then the nearest.
export function pickTarget(npcs: readonly TargetNpc[], o: { target: RegExp; centre: { x: number; z: number }; me: { x: number; z: number }; near: number; reach: number; skip: (index: number) => boolean }): TargetNpc | undefined {
    const close = (n: TargetNpc) => Number(cheb(n, o.me) <= 1);
    return npcs
        .filter(n => o.target.test(n.name) && (n.hp ?? 1) > 0 && n.reachable !== false && !o.skip(n.index) && n.optionsWithIndex.some(p => /^attack$/i.test(p.text))
            && cheb(n, o.centre) <= o.near && cheb(n, o.me) <= o.reach)
        .sort((a, b) => close(b) - close(a) || (a.hp ?? 99) - (b.hp ?? 99) || a.distance - b.distance)[0];
}

// Ticks for each level band from the tick each level was first seen: {"55-60": ticks, ...}.
export function bandTicks(levelAt: ReadonlyMap<number, number>, bands: readonly number[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < bands.length; i++) {
        const a = levelAt.get(bands[i]!), b = levelAt.get(bands[i + 1]!);
        if (a !== undefined && b !== undefined) out[`${bands[i]}-${bands[i + 1]}`] = b - a;
    }
    return out;
}

function messageFeed(s: Session) {
    const seen = new Set<string>(), all: string[] = [];
    const off = s.onTick(() => {
        for (const m of (s.sdk.getState()?.gameMessages ?? [])) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (!seen.has(k)) { seen.add(k); all.push(m.text); }
        }
    });
    return { all, mark: () => all.length, saw: (re: RegExp, from: number) => all.slice(from).some(t => re.test(t)), off };
}

export type PlacedCannon = { x: number; z: number; id: number; centre: { x: number; z: number }; setupTicks: number };
const findCannon = (s: Session) => (s.sdk.getState()?.nearbyLocs ?? []).filter(l => /cannon/i.test(l.name)).sort((a, b) => a.distance - b.distance)[0];

// Set up the cannon with the player's tile as the centre, load it and start it. `centre` walks there first. When the
// 3x3 is blocked ("There isn't enough space", cannon_setup.rs2:82-113) it tries the tiles of a spiral up to 6 out.
export async function setupCannon(s: Session, o: { centre?: { x: number; z: number }; avoidOld?: boolean } = {}): Promise<PlacedCannon> {
    const feed = messageFeed(s), t0 = s.tick();
    const me = () => s.sdk.getState()!.player!;
    const slot = (re: RegExp) => s.sdk.getInventory().find(i => re.test(i.name));
    try {
        const base = slot(CANNON_PARTS[0]);
        if (!base) throw Error('no cannon base in pack');
        for (const part of CANNON_PARTS.slice(1)) if (!slot(part)) throw Error(`no ${part.source} in pack`);
        if (!slot(CANNON_BALL)) throw Error('no cannonballs in pack');
        const op = base.optionsWithIndex.find(p => /set-?up/i.test(p.text))?.opIndex ?? 1;
        if (o.centre && cheb({ x: me().worldX, z: me().worldZ }, o.centre) > 0) { await s.bot.walkTo(o.centre.x, o.centre.z, 0); await waitTicks(s, 1); }
        // A cannon left by an earlier run (decay 2,500 ticks, cannon.constant) blocks the spot: stand 6+ tiles away from it.
        if (o.avoidOld) {
            const p0 = me();
            for (const [dx, dz] of [[0, 0], [8, 0], [-8, 4], [4, 8], [-6, -6], [10, 8]]) {
                const c = findCannon(s), sx = p0.worldX + dx!, sz = p0.worldZ + dz!;
                if (!c || cheb({ x: c.x + 1, z: c.z + 1 }, { x: sx, z: sz }) >= 6) { if (dx || dz) { await s.bot.walkTo(sx, sz, 0); await waitTicks(s, 1); } break; }
            }
        }
        const ring: number[][] = [[0, 0]];
        for (let r = 1; r <= 6; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) ring.push([dx, dz]);
        const p1 = me();
        let m0 = feed.mark(), placed = false, tries = 0;
        for (const [dx, dz] of ring) {
            if (tries >= 30) break;
            if (dx || dz) { const w = await s.bot.walkTo(p1.worldX + dx!, p1.worldZ + dz!, 0); if (!w.success) continue; await waitTicks(s, 1); }
            m0 = feed.mark(); tries++;
            await s.direct({ type: 'useInventoryItem', slot: slot(CANNON_PARTS[0])!.slot, optionIndex: op, reason: 'cannon set-up' });
            await waitUntil(s, () => feed.saw(/place the cannon base|can't|cannot|isn't enough|won't be happy|not permitted|too dank/i, m0), { timeoutTicks: 8 });
            if (feed.saw(/place the cannon base/i, m0)) { placed = true; break; }
            if (!feed.saw(/isn't enough space/i, m0)) break;
        }
        if (!placed) throw Error(`cannon base not placed after ${tries} tries: ${feed.all.slice(m0).join(' | ')}`);
        await waitTicks(s, 1);
        for (const part of CANNON_PARTS.slice(1)) {
            const item = slot(part), l = findCannon(s);
            if (!item || !l) throw Error(`missing ${part.source} or cannon loc`);
            await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: l.x, z: l.z, locId: l.id, reason: 'cannon set-up' });
            if (!await waitUntil(s, () => { const n = findCannon(s); return !!n && n.id !== l.id; }, { timeoutTicks: 8 })) throw Error(`cannon part not added: ${part.source}`);
        }
        const l = findCannon(s)!, balls = slot(CANNON_BALL)!;
        m0 = feed.mark();
        await s.direct({ type: 'useItemOnLoc', itemSlot: balls.slot, x: l.x, z: l.z, locId: l.id, reason: 'cannon load' });
        if (!await waitUntil(s, () => feed.saw(/load the cannon/i, m0), { timeoutTicks: 8 })) throw Error('first cannon load unobserved');
        const fire = l.optionsWithIndex.find(p => /^fire$/i.test(p.text))?.opIndex ?? 1;
        await s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: fire, reason: 'cannon fire' });
        await waitTicks(s, 2);
        return { x: l.x, z: l.z, id: l.id, centre: { x: l.x + 1, z: l.z + 1 }, setupTicks: s.tick() - t0 };
    } finally { feed.off(); }
}

// Pick the cannon up (oploc2, 4 free slots, cannon_setup.rs2:230-244); its loaded balls come back to the pack.
export async function pickupCannon(s: Session, c: PlacedCannon): Promise<boolean> {
    const l = (s.sdk.getState()?.nearbyLocs ?? []).find(n => n.x === c.x && n.z === c.z && /cannon/i.test(n.name));
    if (!l) return false;
    const op = l.optionsWithIndex.find(p => /pick-?up/i.test(p.text))?.opIndex ?? 2;
    await s.direct({ type: 'interactLoc', x: c.x, z: c.z, locId: l.id, optionIndex: op, reason: 'cannon pick-up' });
    return waitUntil(s, () => !!s.sdk.getInventory().some(i => CANNON_PARTS[0].test(i.name)), { timeoutTicks: 12 });
}

export type CannonFightOptions = { spot: CannonSpot; cap: number; stopSkill: string; stopLevel: number; style?: number; reload: number; prayer: PrayerName | 'none'; eatAt?: number; stop?: () => boolean };

export async function runCannonFight(s: Session, o: CannonFightOptions) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.reload) || o.reload < 1 || o.reload > 30) throw Error('cannon fight: cap >= 1 and reload 1..30');
    const st = () => s.sdk.getState()!, me = () => st().player!;
    const inv = () => s.sdk.getInventory(), slot = (re: RegExp) => inv().find(i => re.test(i.name));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0, maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const xp = (k: string) => s.sdk.getSkillXp(k) ?? 0, level = (k: string) => s.sdk.getSkill(k)?.baseLevel ?? 0;
    const ammo = () => s.sdk.getEquipment().filter(i => i.slot === 13).reduce((n, i) => n + i.count, 0);
    const target = new RegExp(o.spot.target, 'i');
    const prayerIndex = o.prayer === 'none' ? -1 : PRAYER_NAMES.indexOf(o.prayer);
    const eatAt = o.eatAt ?? Math.max(Math.floor(maxHp * 0.4), Math.min(maxHp - 12, 8));
    const feed = messageFeed(s);
    if (o.style !== undefined) { await s.direct({ type: 'setCombatStyle', style: o.style, reason: 'cannon fight style' }); await waitTicks(s, 2); }
    // A bow does not walk to its target: reach 7 with ammo worn, else melee (walks to any target near the cannon).
    const reach = ammo() > 0 ? 7 : o.spot.near * 2;
    const prayerOn = () => prayerIndex >= 0 && !!st().prayers?.activePrayers?.[prayerIndex];
    if (prayerIndex >= 0 && !prayerOn() && level('Prayer') > 0) { await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'cannon fight prayer' }); await waitTicks(s, 1); }
    const cannon = await setupCannon(s, { centre: o.spot.centre, avoidOld: true });
    console.log(`CANNON up at ${cannon.x},${cannon.z} centre ${cannon.centre.x},${cannon.centre.z} setupTicks=${cannon.setupTicks} stand ${me().worldX},${me().worldZ}`);

    const skills = ['Ranged', 'Hitpoints', 'Defence', 'Attack', 'Strength'];
    const x0 = Object.fromEntries(skills.map(k => [k, xp(k)])) as Record<string, number>;
    const balls = () => countItems(s, CANNON_BALL), food = () => countItems(s, FOOD);
    const balls0 = balls(), ammo0 = ammo(), food0 = food(), t0 = s.tick(), wall0 = Date.now();
    const levelAt = new Map<number, number>([[level(o.stopSkill), 0]]);
    let reloads = 0, refires = 0, attacks = 0, eats = 0, potions = 0, antis = 0, dialogs = 0, idle = 0, kills = 0, dmgTaken = 0, hpMin = hp();
    let lastLoad = t0, loadPending = -1, loadMark = 0, needFire = false, firePending = -1, emptyMark = feed.mark(), poisonMark = 0, antiAt = -999;
    let targetIndex = -1, attackAt = -99, lastGain = -99, lastHpXp = xp('Hitpoints'), stopped = '';
    const skip = new Map<number, number>(), seenEvents = new Set<string>();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    // One decision a tick. The loop waits with waitTicks, so the lockstep engine sees the wait and runs the next tick
    // at once (packages/core/src/inprocess.ts acknowledgeTick); a bare onTick handler held every tick to SIM_BUSY_MS.
    const step = (): boolean => {
        const now = s.tick(), lv = level(o.stopSkill);
        hpMin = Math.min(hpMin, hp());
        if (!levelAt.has(lv)) { levelAt.set(lv, now - t0); console.log(`LEVEL ${o.stopSkill}=${lv} t=${now - t0} ranged=${xp('Ranged') - x0.Ranged!} hpXp=${xp('Hitpoints') - x0.Hitpoints!} balls=${balls0 - balls()} ammo=${ammo0 - ammo()} dialogs=${dialogs}`); }
        if (o.stop?.()) stopped = 'stop';
        if (now - t0 >= o.cap || hp() <= 0 || stopped || lv >= o.stopLevel) return true;
        for (const e of st().combatEvents ?? []) {
            const k = `${e.observationId ?? ''}:${e.tick}:${e.type}:${e.sourceIndex}:${e.targetIndex}:${e.damage}`;
            if (seenEvents.has(k)) continue;
            seenEvents.add(k);
            if (e.type === 'damage_taken') dmgTaken += e.damage;
            if (e.type === 'kill') kills++;
        }
        // 1. A level-up message holds the cannon and the attack (levelup.rs2:54, Player.ts:1069): close it now.
        if (st().dialog?.isOpen || st().modalOpen) { void s.direct({ type: 'closeModal', reason: 'level-up message holds the cannon' }); dialogs++; targetIndex = -1; return false; }
        // 2. Food, prayer, antipoison. Each clears the attack, so the target is picked again on the next tick.
        if (hp() <= eatAt) { const f = slot(FOOD); if (f) { void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'eat' }); eats++; targetIndex = -1; return false; } }
        if (prayerIndex >= 0) {
            const pray = s.sdk.getSkill('Prayer')?.level ?? 0;
            const pot = pray <= 10 ? slot(/^prayer potion/i) : undefined;
            if (pot) { void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'prayer potion' }); potions++; targetIndex = -1; return false; }
            if (pray > 0 && !prayerOn()) void s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer back on' });
        }
        if (feed.saw(/^You have been poisoned!$/, poisonMark) && now - antiAt >= 150) {
            const a = slot(/^antipoison/i);
            if (a) { poisonMark = feed.mark(); void s.direct({ type: 'useInventoryItem', slot: a.slot, optionIndex: 1, reason: 'antipoison' }); antis++; antiAt = now; targetIndex = -1; return false; }
        }
        // 3. Cannon. A load is pending until its message or 6 ticks; no attack click meanwhile (a click replaces the
        //    item-on-loc). After "out of ammo" Fire goes once the load lands (cannon_fire.rs2:21-24).
        if (loadPending >= 0) {
            if (!feed.saw(/load the cannon|already full/i, loadMark) && now - loadPending < 6) return false;
            loadPending = -1;
            if (needFire) { needFire = false; void s.direct({ type: 'interactLoc', x: cannon.x, z: cannon.z, locId: cannon.id, optionIndex: 1, reason: 'cannon fire' }); refires++; firePending = now; targetIndex = -1; return false; }
        }
        if (firePending >= 0 && now - firePending < 2) return false;
        firePending = -1;
        const empty = feed.saw(/out of ammo/i, emptyMark);
        if (reloadDue({ now, lastLoad, interval: o.reload, empty })) {
            const b = slot(CANNON_BALL);
            if (b) {
                if (empty) { needFire = true; emptyMark = feed.mark(); }
                loadMark = feed.mark(); loadPending = now; lastLoad = now; reloads++; targetIndex = -1;
                void s.direct({ type: 'useItemOnLoc', itemSlot: b.slot, x: cannon.x, z: cannon.z, locId: cannon.id, reason: 'cannon top-up' });
                return false;
            }
        }
        // 4. Fight: the target lives and own hits (Hitpoints XP; the cannon gives none) came in the last 10 ticks.
        const npcs = (st().nearbyNpcs ?? []) as TargetNpc[], cur = npcs.find(n => n.index === targetIndex);
        const hx = xp('Hitpoints');
        if (hx > lastHpXp) { lastHpXp = hx; lastGain = now; }
        if (cur && (cur.hp ?? 1) > 0 && (now - lastGain < 10 || now - attackAt < 10)) return false;
        if (cur && now - attackAt >= 10) skip.set(cur.index, now + 30);
        const p = me();
        const next = pickTarget(npcs, { target, centre: cannon.centre, me: { x: p.worldX, z: p.worldZ }, near: o.spot.near, reach, skip: i => (skip.get(i) ?? 0) > now });
        if (!next) { idle++; targetIndex = -1; return false; }
        void s.direct({ type: 'interactNpc', npcIndex: next.index, optionIndex: next.optionsWithIndex.find(q => /^attack$/i.test(q.text))!.opIndex, reason: 'cannon fight attack' });
        targetIndex = next.index; attackAt = now; attacks++;
        return false;
    };
    while (!ended && !step()) await waitTicks(s, 1);
    const ticks = s.tick() - t0, died = hp() <= 0;
    const gain = Object.fromEntries(skills.map(k => [k, xp(k) - x0[k]!])) as Record<string, number>;
    const used = { balls: balls0 - balls(), ammo: ammo0 - ammo(), food: food0 - food() };
    let picked = false, clear = false;
    if (!died && !ended) {
        picked = await pickupCannon(s, cannon);
        // A player hit in the last 10 s cannot log out: walk 18 tiles out and wait for 17 ticks with no hit.
        const from = { x: me().worldX, z: me().worldZ };
        for (const [dx, dz] of [[18, 0], [-18, 0], [0, 18], [0, -18], [12, 12], [-12, -12]]) if ((await s.bot.walkTo(from.x + dx!, from.z + dz!, 2)).success) break;
        clear = await waitUntil(s, () => { const lt = me().combat?.lastDamageTick ?? -1; return lt < 0 || s.tick() - lt >= 17; }, { timeoutTicks: 60 });
        if (prayerOn()) await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer off' });
    }
    feed.off();
    const bands = bandTicks(levelAt, [1, 50, 55, 60, 70, 80, 90, 95, 99].filter(l => levelAt.has(l)));
    return {
        ok: !died && !stopped && picked && (level(o.stopSkill) >= o.stopLevel || ticks >= o.cap),
        died, stopped: stopped || '-', ticks, setupTicks: cannon.setupTicks, msPerTick: Math.round((Date.now() - wall0) / Math.max(1, ticks)),
        startLevel: [...levelAt.keys()][0], endLevel: level(o.stopSkill), gain, used, reloads, refires, attacks, eats, potions, antis, dialogs, idle, kills, dmgTaken, hpMin, picked, clear,
        bands, levelAt: Object.fromEntries(levelAt),
    };
}

if (import.meta.main) {
    const [bot] = process.argv.slice(2);
    const env = process.env;
    const spot = CANNON_SPOTS[env.SPOT ?? 'spiders'];
    if (!bot || !spot) { console.log(`RESULT fail usage: bun scripts/cannon-fight.ts <account> SPOT=${Object.keys(CANNON_SPOTS).join('|')}`); process.exit(2); }
    const prayer = (env.PRAYER ?? spot.prayer) as PrayerName | 'none';
    if (prayer !== 'none' && !PRAYER_NAMES.includes(prayer)) { console.log(`RESULT fail unknown PRAYER ${prayer}`); process.exit(2); }
    let stopped = false;
    const s = await openBot(bot, { onStop: async () => { stopped = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        await waitTicks(s, 2);
        const r = await runCannonFight(s, { spot, cap: Number(env.CAP ?? 3000), stopSkill: env.STOP_SKILL ?? 'Ranged', stopLevel: Number(env.STOP_LEVEL ?? 99), style: env.STYLE === undefined ? undefined : Number(env.STYLE), reload: Number(env.RELOAD ?? 20), prayer, eatAt: env.EAT_AT === undefined ? undefined : Number(env.EAT_AT), stop: () => stopped });
        const per = (n: number) => (n / Math.max(1, r.ticks)).toFixed(1);
        await finish([s], r.ok, `cannon-fight spot=${env.SPOT ?? 'spiders'} ticks=${r.ticks} ${env.STOP_SKILL ?? 'Ranged'}=${r.startLevel}->${r.endLevel} rangedXp=${r.gain.Ranged} rangedXpPerTick=${per(r.gain.Ranged!)} hpXp=${r.gain.Hitpoints} hpXpPerTick=${per(r.gain.Hitpoints!)} defXp=${r.gain.Defence} ` +
            `balls=${r.used.balls} ammo=${r.used.ammo} food=${r.used.food} potions=${r.potions} antis=${r.antis} reloads=${r.reloads} refires=${r.refires} dialogs=${r.dialogs} attacks=${r.attacks} idle=${r.idle} kills=${r.kills} hpMin=${r.hpMin} died=${r.died} picked=${r.picked} clear=${r.clear} setupTicks=${r.setupTicks} msPerTick=${r.msPerTick} ` +
            `bands=${Object.entries(r.bands).map(([k, v]) => `${k}:${v}`).join(',') || '-'} stop=${r.stopped}`);
    } catch (e) { await finish([s], false, `cannon-fight: ${String(e)}`); }
}
