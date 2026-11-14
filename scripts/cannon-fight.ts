// Cannon fight: set up a dwarf multicannon at a spot from CANNON_SPOTS, keep it loaded, and fight beside it with the
// worn weapon (a bow and its ammo, or a melee weapon). It picks up nothing. At the end it takes the cannon back and
// walks clear of the NPCs before logout. After a death it walks back for the cannon, or gets it from Nulodion.
// Usage: bun scripts/cannon-fight.ts <account> [KEY=value ...]
// Env: SPOT (a CANNON_SPOTS key, default spiders), CAP (ticks, default 3000), STOP (levels that end the run, all of
// them: "Ranged=99,Defence=99,Hitpoints=99"; default STOP_SKILL=STOP_LEVEL, Ranged 99), PHASES (weapon:style:until
// phases, see parsePhases; default one phase of STYLE, or the current style), SPECIAL=0 (no magic shortbow special;
// default on: research/combat-measure.md 6c), RELOAD (ticks between top-ups, default 20), PRAYER (a sdk PrayerName kept on, with a prayer
// potion at 10 points; `none` for no prayer; default from the spot), EAT_AT (hitpoints; default 40% of the base level).
// MODE=reclaim [CANNON_AT=x,z] only gets the cannon parts back (reclaimCannon) and ends. MODE=buy only buys the full
// cannon from Nulodion with 750,000 coins in the pack (buyCannon) and ends.
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
import { componentId } from '../packages/core/src/logout';
import { PRAYER_NAMES, type PrayerName } from '../vendor/rs-sdk/sdk/types';
import { walkTarget } from './walk-to';

export type Tile = { x: number; z: number; level: number };
// `clear`: a tile out of the spot's NPC range for the walk before logout, where hunters attack any player in reach.
export type CannonSpot = { label: string; centre: Tile; target: string; prayer: PrayerName | 'none'; near: number; clear?: Tile };

// Each centre has a free 3x3 for set-up; set-up tries a spiral up to 6 tiles out when it is blocked.
export const CANNON_SPOTS: Readonly<Record<string, CannonSpot>> = {
    // Wilderness level 37 (z 3810). Map square 51_59 holds 62 poison spiders (npc 134, maps/m51_59.jm2 NPC section) and
    // all of it is multiway (maps/multiway.csv 0_51_59_*). Poison spider: hitpoints 64, defence 52, ranged defence 14,
    // stab attacks, wanderrange 10, respawnrate 60, huntmode cowardly, huntrange 1 (_unpack/225/all.npc:3476-3498);
    // cowardly attacks any player in the Wilderness (all.hunt:37-45). Spawn density puts 7.8 of the 8 cannon directions
    // over a spider within 3 tiles of this centre (.practice/cannon-spiders/placement.ts).
    // The walk before logout leaves the map square to the south (z < 3776, beyond the wander range 10): live, an 18-tile
    // walk kept WeeQuickie among the spiders and the logout timed out.
    spiders: { label: 'Wilderness poison spiders', centre: { x: 3287, z: 3810, level: 0 }, target: '^poison spider$', prayer: 'protect_from_melee', near: 10, clear: { x: 3287, z: 3755, level: 0 } },
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

// Pick the cannon up (oploc2 on the whole cannon, 4 free slots, cannon_setup.rs2:230-244; oploc1 on a part stage,
// lines 133-207); its loaded balls come back to the pack.
export async function pickupCannon(s: Session, c: { x: number; z: number }): Promise<boolean> {
    const l = (s.sdk.getState()?.nearbyLocs ?? []).find(n => n.x === c.x && n.z === c.z && /cannon/i.test(n.name));
    if (!l) return false;
    const op = l.optionsWithIndex.find(p => /pick-?up/i.test(p.text))?.opIndex ?? (/^dwarf multicannon$/i.test(l.name) ? 2 : 1);
    await s.direct({ type: 'interactLoc', x: c.x, z: c.z, locId: l.id, optionIndex: op, reason: 'cannon pick-up' });
    return waitUntil(s, () => !!s.sdk.getInventory().some(i => CANNON_PARTS[0].test(i.name)), { timeoutTicks: 12 });
}

// The cannon loc lives 2,500 ticks from its last part (loc_add / loc_change duration ^cannon_decay_length,
// cannon_setup.rs2:129-218, cannon.constant:1). After that it is gone and %ownedmcannon still holds its tile, so a new
// set-up is refused ("You cannot construct more than one Cannon", cannon_setup.rs2:59-63). The fight picks it up and
// sets it up again before then.
export const CANNON_LIFE = 2500;
export const CANNON_REFRESH = CANNON_LIFE - 100;
// Nulodion (npc 209, maps/m47_53.jm2 at 3011,3453) replaces a cannon only when its loc is gone; while any stage of it
// stands he sends the player back to it (quests/quest_mcannon/scripts/npcs/nulodion.rs2:91-143). His room opens by the
// door on the west wall of the porch (loc 3 at 3015,3453, scripts/generated/dwarfcannon.ts).
export const NULODION = { x: 3011, z: 3453, level: 0 }, NULODION_DOOR = { id: 3, x: 3015, z: 3453 };

// A phase: the weapon to wield (an item id held in the pack or worn), the combat style index, and the levels that end
// it. The last phase has no end of its own and runs until every STOP level is reached.
export type Phase = { weapon?: number; style?: number; until?: Record<string, number> };
// "Defence=99,Hitpoints=99" -> {Defence: 99, Hitpoints: 99}
export function parseLevels(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of text.split(',').map(p => p.trim()).filter(Boolean)) {
        const m = part.match(/^([A-Za-z]+)=(\d+)$/);
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 99) throw Error(`bad level "${part}"`);
        out[m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()] = Number(m[2]);
    }
    return out;
}
// "1333:3:Defence=99;861:1" -> scimitar on style 3 until Defence 99, then the magic shortbow on style 1. An empty
// weapon or style keeps the current one.
export function parsePhases(text: string): Phase[] {
    return text.split(';').map(p => p.trim()).filter(Boolean).map(p => {
        const [weapon, style, until] = p.split(':');
        const ph: Phase = {};
        if (weapon) { if (!/^\d+$/.test(weapon)) throw Error(`bad phase weapon "${weapon}"`); ph.weapon = Number(weapon); }
        if (style) { if (!/^[0-3]$/.test(style)) throw Error(`bad phase style "${style}"`); ph.style = Number(style); }
        if (until) ph.until = parseLevels(until);
        return ph;
    });
}
export const levelsMet = (levels: (k: string) => number, want: Record<string, number> | undefined) => !!want && Object.entries(want).every(([k, v]) => levels(k) >= v);
// The magic shortbow special (Snapshot) costs 350 of 1,000 energy (bows.obj magic_shortbow sa_energy) and fires two
// arrows at Ranged + 10 and 10/7 accuracy (player/specs pvm_magic_shortbow_sa); energy regains 100 every 50 ticks
// (combat.constant:1-3). Turn it on only while a target is under attack, with the bar off and the energy there.
export const MSB = 861, MSB_SPECIAL_COST = 350;
export const specialDue = (o: { special: boolean; weapon: number | undefined; energy: number | undefined; enabled: number | undefined; fighting: boolean }) =>
    o.special && o.weapon === MSB && o.fighting && o.enabled === 0 && (o.energy ?? 0) >= MSB_SPECIAL_COST;

type Walk = (to: Tile) => Promise<boolean>;

// From the porch (east of NULODION_DOOR), opens the door, steps in and talks to Nulodion. Each open page clicks the
// first option that `pick` matches, else continues, until `done` holds (60 ticks at most). 'refused' when a page
// matches `refuse`; 'absent' when he is not in view.
async function talkToNulodion(s: Session, pick: RegExp, done: () => boolean, refuse: RegExp, reason: string): Promise<'done' | 'refused' | 'absent' | 'timeout'> {
    const me = () => s.sdk.getState()?.player;
    if ((me()?.worldX ?? NULODION_DOOR.x) >= NULODION_DOOR.x) {
        const door = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === NULODION_DOOR.id && l.x === NULODION_DOOR.x && l.z === NULODION_DOOR.z);
        const open = door?.optionsWithIndex.find(p => /^open$/i.test(p.text));
        if (door && open) { await s.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: open.opIndex, reason: 'Nulodion door' }); await waitTicks(s, 2); }
        await s.bot.walkTo(NULODION.x + 1, NULODION.z, 0);
        await waitUntil(s, () => (me()?.worldX ?? NULODION_DOOR.x) < NULODION_DOOR.x, { timeoutTicks: 10 });
    }
    const npc = (s.sdk.getState()?.nearbyNpcs ?? []).find(n => /^nulodion$/i.test(n.name));
    const talk = npc?.optionsWithIndex.find(p => /talk/i.test(p.text));
    if (!npc || !talk) return 'absent';
    await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: talk.opIndex, reason: `Nulodion: ${reason}` });
    for (let t = 0; t < 60 && !done(); t++) {
        await waitTicks(s, 1);
        const d = s.sdk.getDialog();
        if (!d?.isOpen || d.isWaiting) continue;
        const option = d.options.find(p => pick.test(p.text));
        if (option) await s.sdk.sendClickDialog(option.index);
        else if (refuse.test([d.text ?? '', ...(d.allComponents ?? []).map(c => c.text)].join(' '))) return 'refused';
        else await s.sdk.sendClickDialog(0);
    }
    return done() ? 'done' : 'timeout';
}

// The full cannon from Nulodion: 750,000 coins for the four parts, an ammo mould and the manual, to an account with
// Dwarf Cannon complete (quest_mcannon/scripts/npcs/nulodion.rs2:61-76, 145-160).
export const CANNON_PRICE = 750_000;
export async function buyCannon(s: Session, o: { walk: Walk }): Promise<{ ok: boolean; detail: string }> {
    // setupCannon needs all four parts. A part already held makes a second full set a waste, so a partial kit is a
    // failure that names the missing parts.
    const missing = () => CANNON_PARTS.filter(re => !s.sdk.getInventory().some(i => re.test(i.name))).map(re => re.source.replace(/^\^|\$$/g, ''));
    const held = () => missing().length === 0;
    if (held()) return { ok: true, detail: 'cannon already in the pack' };
    if (missing().length < CANNON_PARTS.length) return { ok: false, detail: `incomplete cannon in the pack: missing ${missing().join(', ')}` };
    const coins = s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
    if (coins < CANNON_PRICE) return { ok: false, detail: `${coins} coins in the pack, ${CANNON_PRICE} needed` };
    if (s.sdk.getInventory().length > 28 - 6) return { ok: false, detail: 'the cannon needs 6 free pack slots' };
    if (!await o.walk({ x: NULODION_DOOR.x, z: NULODION_DOOR.z, level: 0 })) return { ok: false, detail: 'walk to Nulodion failed' };
    const r = await talkToNulodion(s, /sell me a cannon|take a cannon please/i, held, /don't have enough money|doesn't seem interested/i, 'buy cannon');
    return held() ? { ok: true, detail: 'bought' } : { ok: false, detail: `no cannon: ${r}${missing().length < CANNON_PARTS.length ? `, missing ${missing().join(', ')}` : ''}` };
}
// Get the cannon parts back into the pack, by the content's rules: pick up the standing cannon (from `at`, its
// south-west tile, or the nearest cannon loc in view), else ask Nulodion, who replaces it once the loc is gone.
// `placedAt` is the tick of the last set-up: when the cannon cannot be reached, the loc still stands until
// placedAt + CANNON_LIFE, so the account waits for that tick (at most `maxWait` ticks, default CANNON_LIFE) before it
// asks Nulodion. A later run with MODE=reclaim does the same with no tick known.
export async function reclaimCannon(s: Session, o: { at?: { x: number; z: number; level?: number }; walk: Walk; nulodion?: boolean; placedAt?: number; maxWait?: number }): Promise<{ ok: boolean; how: string; detail: string }> {
    const held = () => s.sdk.getInventory().some(i => CANNON_PARTS[0].test(i.name));
    if (held()) return { ok: true, how: 'held', detail: 'cannon base already in the pack' };
    const me = () => s.sdk.getState()?.player;
    const nearCannon = () => (s.sdk.getState()?.nearbyLocs ?? []).filter(l => /cannon/i.test(l.name) && l.optionsWithIndex.some(p => /pick-?up/i.test(p.text)))
        .sort((a, b) => (o.at ? cheb(a, o.at) - cheb(b, o.at) : 0) || a.distance - b.distance)[0];
    if (o.at) {
        const p = me();
        if (!p || p.level !== (o.at.level ?? 0) || cheb({ x: p.worldX, z: p.worldZ }, o.at) > 12) await o.walk({ x: o.at.x + 1, z: o.at.z - 1, level: o.at.level ?? 0 });
    }
    const loc = nearCannon();
    if (loc && await pickupCannon(s, loc)) return { ok: true, how: 'picked', detail: `picked up at ${loc.x},${loc.z}` };
    if (o.nulodion === false) return { ok: false, how: 'none', detail: loc ? `pick-up refused at ${loc.x},${loc.z}` : 'no cannon in view' };
    // Nulodion.
    const feed = messageFeed(s);
    try {
        if (!await o.walk({ x: NULODION_DOOR.x, z: NULODION_DOOR.z, level: 0 })) return { ok: false, how: 'nulodion', detail: 'walk to Nulodion failed' };
        if (o.placedAt !== undefined) {
            const decay = o.placedAt + CANNON_LIFE + 10, wait = decay - s.tick();
            if (wait > (o.maxWait ?? CANNON_LIFE)) return { ok: false, how: 'nulodion', detail: `cannon stands until tick ${decay}; ${wait} ticks to wait` };
            if (wait > 0) {
                console.log(`RECLAIM wait ${wait} ticks for the cannon loc to end (tick ${decay})`);
                // A step every 200 ticks keeps the session from looking idle while it waits.
                const home = { x: me()?.worldX ?? NULODION_DOOR.x, z: me()?.worldZ ?? NULODION_DOOR.z };
                for (let i = 0; s.tick() < decay; i++) {
                    await waitUntil(s, () => s.tick() >= decay, { timeoutTicks: Math.min(200, decay - s.tick() + 1) });
                    if (s.tick() < decay) await s.bot.walkTo(home.x + (i % 2 ? 0 : 1), home.z, 0);
                }
            }
        }
        const m0 = feed.mark();
        const r = await talkToNulodion(s, /lost my cannon/i, held, /only allowed to replace|happily parked/i, 'lost cannon');
        if (r === 'absent') return { ok: false, how: 'nulodion', detail: 'Nulodion not in view' };
        if (r === 'refused') return { ok: false, how: 'nulodion', detail: 'refused: the cannon loc still stands' };
        return held() ? { ok: true, how: 'nulodion', detail: feed.all.slice(m0).join(' | ') || 'parts given' } : { ok: false, how: 'nulodion', detail: `no parts: ${feed.all.slice(m0).join(' | ')}` };
    } finally { feed.off(); }
}

export type CannonFightOptions = { spot: CannonSpot; cap: number; stop: Record<string, number>; phases: Phase[]; reload: number; prayer: PrayerName | 'none'; eatAt?: number; special?: boolean; halt?: () => boolean; walk?: Walk };

export async function runCannonFight(s: Session, o: CannonFightOptions) {
    if (!Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.reload) || o.reload < 1 || o.reload > 30) throw Error('cannon fight: cap >= 1 and reload 1..30');
    if (!Object.keys(o.stop).length) throw Error('cannon fight: no stop levels');
    const st = () => s.sdk.getState()!, me = () => st().player!;
    const inv = () => s.sdk.getInventory(), slot = (re: RegExp) => inv().find(i => re.test(i.name));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0, maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const xp = (k: string) => s.sdk.getSkillXp(k) ?? 0, level = (k: string) => s.sdk.getSkill(k)?.baseLevel ?? 0;
    const ammo = () => s.sdk.getEquipment().filter(i => i.slot === 13).reduce((n, i) => n + i.count, 0);
    const weapon = () => s.sdk.getEquipment().find(i => i.slot === 3);
    const cvar = (i: number) => (s.client as { var?: number[] } | undefined)?.var?.[i];
    const target = new RegExp(o.spot.target, 'i');
    const prayerIndex = o.prayer === 'none' ? -1 : PRAYER_NAMES.indexOf(o.prayer);
    const eatAt = o.eatAt ?? Math.max(Math.floor(maxHp * 0.4), Math.min(maxHp - 12, 8));
    const walk: Walk = o.walk ?? (async to => (await s.bot.walkTo(to.x, to.z, 1)).success);
    const life0 = { respawn: me().respawnCount, life: me().lifeId };
    const died = () => hp() <= 0 || !!me().isDead || me().respawnCount > life0.respawn || (life0.life !== undefined && me().lifeId !== life0.life);
    const feed = messageFeed(s);
    let phase = o.phases.findIndex((ph, i) => i === o.phases.length - 1 || !levelsMet(level, ph.until));
    let targetIndex = -1;
    const applyPhase = async () => {
        const ph = o.phases[phase];
        if (!ph) return;
        if (ph.weapon !== undefined && weapon()?.id !== ph.weapon) {
            const item = inv().find(i => i.id === ph.weapon);
            if (!item) throw Error(`phase weapon ${ph.weapon} is not in the pack`);
            await s.bot.equipItem(item);
            if (!await waitUntil(s, () => weapon()?.id === ph.weapon, { timeoutTicks: 6 })) throw Error(`phase weapon ${ph.weapon} not wielded`);
        }
        if (ph.style !== undefined && st().combatStyle?.currentStyle !== ph.style) {
            await s.direct({ type: 'setCombatStyle', style: ph.style, reason: 'cannon fight style' });
            await waitUntil(s, () => st().combatStyle?.currentStyle === ph.style, { timeoutTicks: 6 });
        }
        targetIndex = -1;
        console.log(`PHASE ${phase} weapon=${weapon()?.name ?? '-'} style=${st().combatStyle?.currentStyle} t=${s.tick()}`);
    };
    await applyPhase();
    // A bow stands still (reach 7, attackrange param of the bow, bows.obj); a melee weapon takes targets within 3 tiles,
    // so the player stays beside the cannon while the spiders it hits come to it.
    const reach = () => /bow/i.test(weapon()?.name ?? '') && ammo() > 0 ? 7 : 3;
    const prayerOn = () => prayerIndex >= 0 && !!st().prayers?.activePrayers?.[prayerIndex];
    if (prayerIndex >= 0 && !prayerOn() && level('Prayer') > 0) { await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'cannon fight prayer' }); await waitTicks(s, 1); }
    let reclaimed = '-';
    const place = async () => {
        try { return await setupCannon(s, { centre: o.spot.centre, avoidOld: true }); } catch (e) {
            if (!/more than one Cannon/i.test(String(e))) throw e;
            // The server holds a cannon for this account: pick it up or get it replaced, then set up here.
            const r = await reclaimCannon(s, { walk });
            reclaimed = `${r.how}:${r.ok}`;
            if (!r.ok) throw Error(`cannon held by the server and not reclaimed: ${r.detail}`);
            if (cheb({ x: me().worldX, z: me().worldZ }, o.spot.centre) > 0) await walk(o.spot.centre);
            return setupCannon(s, { centre: o.spot.centre, avoidOld: true });
        }
    };
    let cannon = await place();
    let placedAt = s.tick(), refreshes = 0;
    console.log(`CANNON up at ${cannon.x},${cannon.z} centre ${cannon.centre.x},${cannon.centre.z} setupTicks=${cannon.setupTicks} stand ${me().worldX},${me().worldZ}`);

    const skills = ['Ranged', 'Hitpoints', 'Defence', 'Attack', 'Strength'];
    const x0 = Object.fromEntries(skills.map(k => [k, xp(k)])) as Record<string, number>;
    const balls = () => countItems(s, CANNON_BALL), food = () => countItems(s, FOOD);
    const balls0 = balls(), ammo0 = ammo(), food0 = food(), t0 = s.tick(), wall0 = Date.now();
    const track = Object.keys(o.stop);
    const levelAt = new Map<number, number>([[level(track[0]!), 0]]);
    const doneAt: Record<string, number> = {};
    let reloads = 0, refires = 0, attacks = 0, eats = 0, potions = 0, antis = 0, dialogs = 0, idle = 0, kills = 0, dmgTaken = 0, specials = 0, hpMin = hp();
    let lastLoad = t0, loadPending = -1, loadMark = 0, needFire = false, firePending = -1, emptyMark = feed.mark(), poisonMark = 0, antiAt = -999, specAt = -99;
    let attackAt = -99, lastGain = -99, lastHpXp = xp('Hitpoints'), stopped = '';
    const skip = new Map<number, number>(), seenEvents = new Set<string>();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    // One decision a tick. The loop waits with waitTicks, so the lockstep engine sees the wait and runs the next tick
    // at once (packages/core/src/inprocess.ts acknowledgeTick); a bare onTick handler held every tick to SIM_BUSY_MS.
    type Step = 'go' | 'stop' | 'phase' | 'refresh';
    const step = (): Step => {
        const now = s.tick(), lv = level(track[0]!);
        hpMin = Math.min(hpMin, hp());
        if (!levelAt.has(lv)) { levelAt.set(lv, now - t0); console.log(`LEVEL ${track[0]}=${lv} t=${now - t0} ranged=${xp('Ranged') - x0.Ranged!} hpXp=${xp('Hitpoints') - x0.Hitpoints!} defXp=${xp('Defence') - x0.Defence!} balls=${balls0 - balls()} ammo=${ammo0 - ammo()} dialogs=${dialogs}`); }
        for (const k of track) if (doneAt[k] === undefined && level(k) >= o.stop[k]!) { doneAt[k] = now - t0; console.log(`DONE ${k}=${level(k)} t=${now - t0}`); }
        if (o.halt?.()) stopped = 'stop';
        if (died()) { stopped = 'died'; return 'stop'; }
        if (now - t0 >= o.cap || stopped || levelsMet(level, o.stop)) return 'stop';
        for (const e of st().combatEvents ?? []) {
            const k = `${e.observationId ?? ''}:${e.tick}:${e.type}:${e.sourceIndex}:${e.targetIndex}:${e.damage}`;
            if (seenEvents.has(k)) continue;
            seenEvents.add(k);
            if (e.type === 'damage_taken') dmgTaken += e.damage;
            if (e.type === 'kill') kills++;
        }
        // 1. A level-up message holds the cannon and the attack (levelup.rs2:54, Player.ts:1069): close it now.
        if (st().dialog?.isOpen || st().modalOpen) { void s.direct({ type: 'closeModal', reason: 'level-up message holds the cannon' }); dialogs++; targetIndex = -1; return 'go'; }
        if (phase < o.phases.length - 1 && levelsMet(level, o.phases[phase]!.until)) { phase++; return 'phase'; }
        // 2. Food, prayer, antipoison. Each clears the attack, so the target is picked again on the next tick.
        if (hp() <= eatAt) { const f = slot(FOOD); if (f) { void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'eat' }); eats++; targetIndex = -1; return 'go'; } }
        if (prayerIndex >= 0) {
            const pray = s.sdk.getSkill('Prayer')?.level ?? 0;
            const pot = pray <= 10 ? slot(/^prayer potion/i) : undefined;
            if (pot) { void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'prayer potion' }); potions++; targetIndex = -1; return 'go'; }
            if (pray > 0 && !prayerOn()) void s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer back on' });
        }
        if (feed.saw(/^You have been poisoned!$/, poisonMark) && now - antiAt >= 150) {
            const a = slot(/^antipoison/i);
            if (a) { poisonMark = feed.mark(); void s.direct({ type: 'useInventoryItem', slot: a.slot, optionIndex: 1, reason: 'antipoison' }); antis++; antiAt = now; targetIndex = -1; return 'go'; }
        }
        // 3. Cannon. A load is pending until its message or 6 ticks; no attack click meanwhile (a click replaces the
        //    item-on-loc). After "out of ammo" Fire goes once the load lands (cannon_fire.rs2:21-24).
        if (loadPending >= 0) {
            if (!feed.saw(/load the cannon|already full/i, loadMark) && now - loadPending < 6) return 'go';
            loadPending = -1;
            if (needFire) { needFire = false; void s.direct({ type: 'interactLoc', x: cannon.x, z: cannon.z, locId: cannon.id, optionIndex: 1, reason: 'cannon fire' }); refires++; firePending = now; targetIndex = -1; return 'go'; }
        }
        if (firePending >= 0 && now - firePending < 2) return 'go';
        firePending = -1;
        if (now - placedAt >= CANNON_REFRESH) return 'refresh';
        const empty = feed.saw(/out of ammo/i, emptyMark);
        if (reloadDue({ now, lastLoad, interval: o.reload, empty })) {
            const b = slot(CANNON_BALL);
            if (b) {
                if (empty) { needFire = true; emptyMark = feed.mark(); }
                loadMark = feed.mark(); loadPending = now; lastLoad = now; reloads++; targetIndex = -1;
                void s.direct({ type: 'useItemOnLoc', itemSlot: b.slot, x: cannon.x, z: cannon.z, locId: cannon.id, reason: 'cannon top-up' });
                return 'go';
            }
        }
        // 4. Fight: the target lives and own hits (Hitpoints XP; the cannon gives none) came in the last 10 ticks.
        const npcs = (st().nearbyNpcs ?? []) as TargetNpc[], cur = npcs.find(n => n.index === targetIndex);
        const hx = xp('Hitpoints');
        if (hx > lastHpXp) { lastHpXp = hx; lastGain = now; }
        const fighting = !!cur && (cur.hp ?? 1) > 0 && (now - lastGain < 10 || now - attackAt < 10);
        if (fighting && now - specAt >= 3 && specialDue({ special: !!o.special, weapon: weapon()?.id, energy: cvar(300), enabled: cvar(301), fighting })) {
            specAt = now; specials++;
            void s.sdk.sendClickComponent(componentId('combat_bow:specbar'));
            return 'go';
        }
        if (fighting) return 'go';
        if (cur && now - attackAt >= 10) skip.set(cur.index, now + 30);
        const p = me();
        const next = pickTarget(npcs, { target, centre: cannon.centre, me: { x: p.worldX, z: p.worldZ }, near: o.spot.near, reach: reach(), skip: i => (skip.get(i) ?? 0) > now });
        if (!next) { idle++; targetIndex = -1; return 'go'; }
        void s.direct({ type: 'interactNpc', npcIndex: next.index, optionIndex: next.optionsWithIndex.find(q => /^attack$/i.test(q.text))!.opIndex, reason: 'cannon fight attack' });
        targetIndex = next.index; attackAt = now; attacks++;
        return 'go';
    };
    for (;;) {
        if (ended) break;
        const r = step();
        if (r === 'stop') break;
        if (r === 'phase') await applyPhase();
        if (r === 'refresh') {
            // Pick up and set up again before the loc's 2,500 ticks end (CANNON_LIFE).
            if (!await pickupCannon(s, cannon)) throw Error('cannon refresh: pick-up failed');
            cannon = await setupCannon(s, { centre: o.spot.centre, avoidOld: false });
            placedAt = s.tick(); lastLoad = placedAt; refreshes++; emptyMark = feed.mark(); targetIndex = -1;
            console.log(`CANNON refresh at ${cannon.x},${cannon.z} setupTicks=${cannon.setupTicks}`);
        }
        await waitTicks(s, 1);
    }
    const ticks = s.tick() - t0, dead = stopped === 'died';
    const gain = Object.fromEntries(skills.map(k => [k, xp(k) - x0[k]!])) as Record<string, number>;
    const used = { balls: balls0 - balls(), ammo: ammo0 - ammo(), food: food0 - food() };
    let picked = false, clear = false;
    if (dead && !ended) {
        // After a death the cannon stands at the spot and %ownedmcannon holds it: walk back and pick it up, or get it
        // replaced, so the account can set up again (reclaimCannon).
        await waitUntil(s, () => hp() > 0 && !me().isDead, { timeoutTicks: 30 });
        const r = await reclaimCannon(s, { at: { x: cannon.x, z: cannon.z, level: o.spot.centre.level }, walk, placedAt });
        reclaimed = `${r.how}:${r.ok}`; picked = r.ok;
        console.log(`RECLAIM ${JSON.stringify(r)}`);
    } else if (!ended) {
        picked = await pickupCannon(s, cannon);
    }
    if (!ended) {
        // A player hit in the last 10 s cannot log out: walk out (to the spot's clear tile, with the prayer still on, or
        // 18 tiles) and wait for 17 ticks with no hit.
        const from = { x: me().worldX, z: me().worldZ };
        if (!dead || reclaimed.startsWith('picked')) {
            if (o.spot.clear) await walk(o.spot.clear);
            else for (const [dx, dz] of [[18, 0], [-18, 0], [0, 18], [0, -18], [12, 12], [-12, -12]]) if ((await s.bot.walkTo(from.x + dx!, from.z + dz!, 2)).success) break;
        }
        clear = await waitUntil(s, () => { const lt = me().combat?.lastDamageTick ?? -1; return lt < 0 || s.tick() - lt >= 17; }, { timeoutTicks: 60 });
        if (prayerOn()) await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'prayer off' });
    }
    feed.off();
    const bands = bandTicks(levelAt, [1, 50, 55, 60, 70, 80, 90, 95, 99].filter(l => levelAt.has(l)));
    return {
        ok: !dead && !stopped && picked && (levelsMet(level, o.stop) || ticks >= o.cap),
        died: dead, stopped: stopped || '-', ticks, setupTicks: cannon.setupTicks, msPerTick: Math.round((Date.now() - wall0) / Math.max(1, ticks)),
        startLevel: [...levelAt.keys()][0], endLevels: Object.fromEntries(track.map(k => [k, level(k)])), doneAt, gain, used,
        reloads, refires, refreshes, attacks, eats, potions, antis, dialogs, specials, idle, kills, dmgTaken, hpMin, picked, clear, reclaimed,
        bands, levelAt: Object.fromEntries(levelAt),
    };
}

if (import.meta.main) {
    const [bot] = process.argv.slice(2);
    const env = process.env;
    const spot = CANNON_SPOTS[env.SPOT ?? 'spiders'];
    if (!bot || !spot) { console.log(`RESULT fail usage: bun scripts/cannon-fight.ts <account> SPOT=${Object.keys(CANNON_SPOTS).join('|')} [MODE=reclaim CANNON_AT=x,z | MODE=buy]`); process.exit(2); }
    const prayer = (env.PRAYER ?? spot.prayer) as PrayerName | 'none';
    if (prayer !== 'none' && !PRAYER_NAMES.includes(prayer)) { console.log(`RESULT fail unknown PRAYER ${prayer}`); process.exit(2); }
    let halted = false;
    // A death reaches onStop as 'died'; the fight sees it itself (respawnCount) and reclaims the cannon.
    const s = await openBot(bot, { onStop: async (_s, detail) => { if (detail !== 'died') halted = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
    const walk: Walk = async to => (await walkTarget(s, to, false)).ok;
    try {
        await waitTicks(s, 2);
        if (env.MODE === 'reclaim') {
            const at = env.CANNON_AT ? env.CANNON_AT.split(',').map(Number) : undefined;
            const r = await reclaimCannon(s, { ...(at && at.length === 2 && at.every(Number.isSafeInteger) ? { at: { x: at[0]!, z: at[1]! } } : {}), walk });
            await finish([s], r.ok, `cannon-reclaim how=${r.how} detail=${r.detail}`);
        }
        if (env.MODE === 'buy') {
            const r = await buyCannon(s, { walk });
            await finish([s], r.ok, `cannon-buy ${r.detail}`);
        }
        const stop = env.STOP ? parseLevels(env.STOP) : { [env.STOP_SKILL ?? 'Ranged']: Number(env.STOP_LEVEL ?? 99) };
        const phases = env.PHASES ? parsePhases(env.PHASES) : [{ ...(env.STYLE === undefined ? {} : { style: Number(env.STYLE) }) }];
        const r = await runCannonFight(s, { spot, cap: Number(env.CAP ?? 3000), stop, phases, reload: Number(env.RELOAD ?? 20), prayer, eatAt: env.EAT_AT === undefined ? undefined : Number(env.EAT_AT), special: env.SPECIAL !== '0', halt: () => halted, walk });
        const per = (n: number) => (n / Math.max(1, r.ticks)).toFixed(1);
        const kv = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(',') || '-';
        // OK_ON_RECLAIM=1 (the death-recovery bench case): a death followed by the cannon back in the pack ends ok.
        const ok = r.ok || (env.OK_ON_RECLAIM === '1' && r.died && r.picked);
        await finish([s], ok, `cannon-fight spot=${env.SPOT ?? 'spiders'} ticks=${r.ticks} ${Object.keys(stop)[0]}=${r.startLevel}->${r.endLevels[Object.keys(stop)[0]!]} levels=${kv(r.endLevels)} done=${kv(r.doneAt)} ` +
            `rangedXp=${r.gain.Ranged} rangedXpPerTick=${per(r.gain.Ranged!)} hpXp=${r.gain.Hitpoints} hpXpPerTick=${per(r.gain.Hitpoints!)} defXp=${r.gain.Defence} defXpPerTick=${per(r.gain.Defence!)} ` +
            `balls=${r.used.balls} ammo=${r.used.ammo} food=${r.used.food} potions=${r.potions} antis=${r.antis} reloads=${r.reloads} refires=${r.refires} refreshes=${r.refreshes} dialogs=${r.dialogs} specials=${r.specials} attacks=${r.attacks} idle=${r.idle} kills=${r.kills} hpMin=${r.hpMin} ` +
            `died=${r.died} picked=${r.picked} reclaimed=${r.reclaimed} clear=${r.clear} setupTicks=${r.setupTicks} msPerTick=${r.msPerTick} bands=${kv(r.bands)} stop=${r.stopped}`);
    } catch (e) { await finish([s], false, `cannon-fight: ${String(e)}`); }
}
