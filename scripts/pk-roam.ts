// Wilderness PK hunt over the whole surface Wilderness.
// The world feed roster shows every player's tile and combat level, so the hunter picks the target it can reach
// first, runs to where that target will be (cutting it off on its way south), freezes it when it runs, and keeps
// attacking with the style the target does not protect against until the target dies, logs out or leaves.
//
// usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO]
//        [RANGED=bow-name-regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=1000] [BANK_AT=30000]
//        [FRIENDS=name,name] (the accounts never to attack, in place of the owned and listed accounts; FRIENDS= is none)
// The account starts south of the Wilderness with its gear worn and food in its inventory.
// Stop files: .practice/stop-<account>, .practice/stop-pk-hunt (shared with scripts/pk-hunt.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, serverFromEnv, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { RosterFeed } from '../packages/core/src/roster-feed';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { tradePartners } from '../packages/core/src/tradeguard';
import { readOpponent, readOpponents } from '../packages/core/src/opponent';
import { componentId } from '../packages/core/src/logout';
import { bestFood, dangerReason, defaultSpec, estMaxHit, fightPlayer, getObjNames, isMulti, observePlayer, type FightOptions, type Kit } from './pk';
import { armourDefence } from './pk-read';

// Surface Wilderness (content area_wilderness wilderness_zones: 0_46_55 to 3_52_99, 8 tiles per level).
export function wildLevel(x: number, z: number): number {
    if (x < 2944 || x > 3391 || z < 3520 || z > 3967) return 0;
    return Math.floor((z - 3520) / 8) + 1;
}

// pvp_combat.rs2: the combat gap must be no more than the lower of the two Wilderness levels.
export function canAttack(me: { x: number; z: number; combat: number }, them: { x: number; z: number; combatLevel: number }): boolean {
    const a = wildLevel(me.x, me.z), b = wildLevel(them.x, them.z);
    return a > 0 && b > 0 && Math.abs(me.combat - them.combatLevel) <= Math.min(a, b);
}

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const clampWild = (p: { x: number; z: number }) => ({ x: Math.min(3391, Math.max(2944, p.x)), z: Math.min(3967, Math.max(3520, p.z)) });

// Roster tile and speed; the rest is known only for players in view (client state and the opponent sensor).
export type Track = {
    name: string; x: number; z: number; combatLevel: number; vx: number; vz: number;
    fighting?: 'npc' | 'player'; skulled?: boolean; protect?: readonly string[]; hpFrac?: number; weapon?: number;
};

// Multi-combat zones (scripts/pk.ts isMulti).
export { isMulti };

// Lower is better: ticks to meet, less a bonus for prey that is weak, busy, carrying everything or unable to teleport.
// A skulled player drops all its items; a player fighting an NPC or another player is already losing HP and looking
// away; above Wilderness level 20 normal teleports fail and above 30 a glory fails (amulet_of_glory.rs2).
export function preyScore(t: Track, meetTicks: number, ganged = false): number {
    const lvl = wildLevel(t.x, t.z);
    return meetTicks
        - (t.skulled ? 40 : 0)
        - (t.fighting ? 30 : 0)
        - (t.hpFrac !== undefined ? (1 - t.hpFrac) * 60 : 0)
        - (t.protect && t.protect.length === 0 ? 10 : 0)
        - (lvl > 30 ? 25 : lvl > 20 ? 10 : 0)
        - (ganged ? 30 : 0);
}

// Target claims shared by our hunters (one file per side's checkout): in single-way combat only one attacker can
// fight a target, so a claimed target is left to its hunter; in multi-combat a claimed target is ganged.
export type Claims = Map<string, { hunter: string; at: number }>;
export const CLAIM_TTL_MS = 60_000;
// A target this many combat levels above us outclasses us; this many strangers within 6 tiles of it is a pile.
export const OUTCLASS_GAP = 3;
export const PILE_SIZE = 2;

// A player outclasses us when its combat is more than OUTCLASS_GAP above ours, or when it is within 5 levels of ours
// and its weapon is worth more than twice ours (items.json cost). Goondelf (126, dragon dagger) outclasses Mightyrod
// (126, adamant scimitar).
export function outclasses(me: { combat: number; weaponValue?: number }, them: { combatLevel: number; weapon?: number }): boolean {
    if (them.combatLevel > me.combat + OUTCLASS_GAP) return true;
    return me.weaponValue !== undefined && them.weapon !== undefined && them.combatLevel >= me.combat - 5 && itemCost(them.weapon) > 2 * me.weaponValue;
}

// Where the escape stands at a Wilderness level with what the pack holds: a glory works to level 30
// (amulet_of_glory.rs2), a teleport spell to level 20; deeper than both, run south until one works.
export function escapeStep(level: number, has: { glory: boolean; teleport: boolean }): 'glory' | 'teleport' | 'run' | 'out' {
    if (level === 0) return 'out';
    if (has.glory && level <= 30) return 'glory';
    if (has.teleport && level <= 20) return 'teleport';
    return 'run';
}

// Where to run to meet a moving target: the first tick t at which we (2 tiles per tick running) can stand on its
// predicted tile. A target running south at full speed from behind has no meeting point; then the hunter heads for
// the tile 30 ticks along its line, which puts it between the target and the south edge.
export function intercept(me: { x: number; z: number }, t: Track, speed = 2, horizon = 120): { x: number; z: number; ticks: number } {
    for (let tick = 0; tick <= horizon; tick++) {
        const p = clampWild({ x: Math.round(t.x + t.vx * tick), z: Math.round(t.z + t.vz * tick) });
        if (cheb(me, p) <= speed * tick) return { ...p, ticks: tick };
    }
    const p = clampWild({ x: Math.round(t.x + t.vx * 30), z: Math.round(t.z + t.vz * 30) });
    return { ...p, ticks: horizon + cheb(me, p) / speed };
}

// The lowest z at which a combat gap is still attackable: Wilderness level >= gap.
export function escapeZ(gap: number): number {
    return 3520 + (Math.max(gap, 1) - 1) * 8;
}

// Tiles a target at the meeting tile must run south to get out of attack range. A freeze cycle is the hold plus 5
// immune ticks (pvp_magic.rs2:85-104) in which the target runs about 10 tiles; a tough target takes several cycles
// (practice: 95 HP in rune armour lost 19 HP in a 24-tick Entangle), so 40 tiles leaves about four.
export const MIN_ESCAPE_TILES = 40;

// The best prey we can attack at the meeting tile and freeze before it runs out of range. In single-way combat a
// player already fighting another player, or claimed by another of our hunters, cannot be attacked; in multi-combat
// both are fair game and a claimed target is ganged.
export function pickTrack(me: { x: number; z: number; combat: number; name?: string; weaponValue?: number }, tracks: Track[], friends: ReadonlySet<string>, maxWild: number,
    skip: ReadonlySet<string> = new Set(), minEscape = MIN_ESCAPE_TILES, claims: Claims = new Map(), now = Date.now(), multiAt: (x: number, z: number) => boolean = isMulti) {
    let best: { track: Track; at: { x: number; z: number; ticks: number }; score: number } | null = null;
    for (const t of tracks) {
        const key = t.name.toLowerCase();
        if (friends.has(key) || skip.has(key) || wildLevel(t.x, t.z) === 0 || wildLevel(t.x, t.z) > maxWild) continue;
        const at = intercept(me, t);
        if (!canAttack({ x: at.x, z: at.z, combat: me.combat }, { x: at.x, z: at.z, combatLevel: t.combatLevel })) continue;
        if (at.z - escapeZ(Math.abs(me.combat - t.combatLevel)) < minEscape) continue;
        const multiHere = multiAt(t.x, t.z);
        const claim = claims.get(key);
        const claimedByOther = !!claim && now - claim.at < CLAIM_TTL_MS && claim.hunter !== me.name?.toLowerCase();
        if (!multiHere && (t.fighting === 'player' || claimedByOther)) continue;
        // Survival first: never pick a fight with someone stronger, or with a crowd round them.
        if (t.combatLevel > me.combat + OUTCLASS_GAP) continue;
        // Live: Goondelf (combat 126, dragon dagger) out-hit Mightyrod (126, adamant scimitar) about 10 to 1. At about
        // our combat level, a weapon worth more than twice ours means we lose the trade.
        if (me.weaponValue !== undefined && t.weapon !== undefined && t.combatLevel >= me.combat - 5 && itemCost(t.weapon) > 2 * me.weaponValue) continue;
        if (tracks.filter(o => o !== t && !friends.has(o.name.toLowerCase()) && cheb(o, t) <= 6).length >= PILE_SIZE) continue;
        const score = preyScore(t, at.ticks, multiHere && claimedByOther);
        if (!best || score < best.score) best = { track: t, at, score };
    }
    return best;
}

// Two roster frames 10 ticks apart give each player's tile and velocity in tiles per tick.
export class Radar {
    private prev = new Map<string, { x: number; z: number; k: number }>();
    tracks = new Map<string, Track>();
    tick = -1;
    at = 0;
    accept(m: { t?: string; k?: number; p?: [number, string, number, number, number, number][] }, now = Date.now()) {
        if (m?.t !== 'roster' || !Array.isArray(m.p) || typeof m.k !== 'number') return;
        const next = new Map<string, Track>();
        for (const [, name, x, z, plane, combatLevel] of m.p) {
            if (plane !== 0 || typeof name !== 'string') continue;
            const key = name.toLowerCase(), old = this.prev.get(key), dt = old ? m.k - old.k : 0;
            next.set(key, { name, x, z, combatLevel, vx: dt > 0 ? (x - old!.x) / dt : 0, vz: dt > 0 ? (z - old!.z) / dt : 0 });
        }
        this.prev = new Map([...next].map(([k, t]) => [k, { x: t.x, z: t.z, k: m.k! }]));
        this.tracks = next;
        this.tick = m.k;
        this.at = now;
    }
    fresh(now = Date.now()) { return now - this.at < 15_000; }
}

function connectRadar(server: string, radar: Radar) {
    const url = `${isLocalServer(server) ? 'ws' : 'wss'}://${server}/worldfeed`;
    const socket = new WebSocket(url), feed = new RosterFeed();
    let beat: ReturnType<typeof setInterval> | undefined;
    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'roster', on: true }));
        beat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' })); }, 30_000);
    });
    socket.addEventListener('message', ({ data }) => { try { radar.accept(feed.expand(JSON.parse(String(data)))); } catch { /* not a roster frame */ } });
    socket.addEventListener('close', () => { if (beat) clearInterval(beat); });
    return () => { if (beat) clearInterval(beat); socket.close(); };
}

// Strongest freeze the account can cast (components from pack/interface.pack magic:bind/snare/entangle).
const FREEZE_RUNES: Record<number, [number, number, number]> = { 1592: [5, 5, 4], 1582: [4, 4, 3], 1572: [3, 3, 2] };
// The strongest freeze the Magic level allows and the pack holds the runes for (557 earth, 555 water, 561 nature).
// Live: Mightyrod (Magic 91) tried Entangle with 1 water and no nature runes: "Not enough runes to cast spell".
export function castableFreeze(magic: number, carried: readonly { id: number; count: number }[]): number | null {
    const held = (id: number) => carried.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    for (const spell of [1592, 1582, 1572]) {
        const [earth, water, nature] = FREEZE_RUNES[spell]!;
        if (freezeSpell(magic) !== null && freezeSpell(magic)! >= spell && held(557) >= earth && held(555) >= water && held(561) >= nature) return spell;
    }
    return null;
}
export function freezeSpell(magic: number): number | null {
    return magic >= 79 ? 1592 : magic >= 50 ? 1582 : magic >= 20 ? 1572 : null;
}

// Wear the glory in the pack (after a rub: the game rubs a glory only from the pack).
export async function wearGlory(s: Session): Promise<void> {
    const g = s.sdk.getInventory().find(i => /^amulet of glory\([1-4]\)$/i.test(i.name));
    const op = g?.optionsWithIndex?.find((o: { text: string }) => /^wear$/i.test(o.text));
    if (g && op && !s.sdk.getEquipment().some(i => /^amulet of glory/i.test(i.name))) { await s.sdk.sendUseItem(g.slot, op.opIndex); await s.sdk.waitForTicks(1); }
}

// friends replaces the fleet list of accounts never to attack (practice passes its own target's absence).
export type Cfg = { maxMs: number; maxWild: number; eatAt: number; fleeAt: number; spell: string; ranged?: RegExp; loot: boolean; freeze: boolean; friends?: readonly string[];
    // Fight options added to each fight of the hunt (the army's allies and shared freeze, scripts/pk-army.ts).
    fight?: Partial<FightOptions>;
    // While hold() is true the chase closes to 3 tiles of its target and casts and attacks nothing (the army's
    // opening in one tick, scripts/pk-army.ts).
    hold?: () => boolean;
    // The tiles the hold closes to (default 3).
    holdRange?: number;
    // While true, the chase toward a target out of view waits (the army's pace, scripts/pk-army.ts PACE).
    pace?: () => boolean;
    specAll?: boolean;
    maxTicks?: number;
    // Pick up stacks worth at least lootMin gp; bank when carried loot reaches bankAt gp (defaults 1,000 and 100,000).
    lootMin?: number; bankAt?: number };

// A hunter's first sweep tile, from its name: hunters spread round the loop instead of starting together.
export function sectorStart(name: string, legs: number): number {
    let h = 0;
    for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return legs > 0 ? h % legs : 0;
}

// Sweep tiles across the Wilderness, west to east and back, shallow to deep.
export function sweep(maxWild: number): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    const zs = [3540, 3620, 3700, 3780, 3860, 3940].filter(z => wildLevel(3100, z) <= maxWild);
    zs.forEach((z, i) => { const xs = [2970, 3060, 3150, 3240, 3330]; pts.push(...(i % 2 ? xs.reverse() : xs).map(x => ({ x, z }))); });
    return pts.length ? pts : [{ x: 3090, z: 3524 }];
}

type Item = { id: number; name: string; slot?: number };
const MELEE_WEAPON = /dagger|scimitar|longsword|sword|mace|battleaxe|warhammer|spear|halberd/i;
// Fight kit for scripts/pk.ts: melee wields the worn weapon and shield (or a carried melee weapon/shield if a bow or
// staff is worn at start), ranged a carried bow (RANGED, default any bow), magic a carried staff. A style is
// present only when the account carries its weapon: fightPlayer skips a style with an empty kit (pk.ts hasStyle).
export function kitFrom(worn: readonly Item[], carried: readonly Item[], ranged = /bow$/i): Kit {
    const kit: Kit = {};
    const wornWep = worn.find(i => i.slot === 3 && !ranged.test(i.name) && !/staff/i.test(i.name));
    const wornShield = worn.find(i => i.slot === 5);
    const wep = wornWep ?? carried.find(i => !ranged.test(i.name) && !/staff/i.test(i.name) && MELEE_WEAPON.test(i.name));
    const shield = wornShield ?? (wep ? carried.find(i => /shield$/i.test(i.name)) : undefined);
    const melee = [wep?.id, shield?.id].filter((id): id is number => id !== undefined);
    if (melee.length) kit.melee = melee;
    const bow = [...worn, ...carried].find(i => ranged.test(i.name));
    if (bow) kit.ranged = [bow.id];
    const staff = [...worn, ...carried].find(i => /staff/i.test(i.name));
    if (staff) kit.magic = [staff.id];
    return kit;
}

// Damage spell components (vendor/rs-sdk/sdk/spells.ts) by SPELL name.
const SPELL_IDS: Record<string, number> = { FIRE_STRIKE: 1158, FIRE_BOLT: 1169, FIRE_BLAST: 1181, FIRE_WAVE: 1189 };
export function spellId(name: string): number {
    const n = Number(name);
    return SPELL_IDS[name.toUpperCase()] ?? (Number.isInteger(n) && n > 0 ? n : SPELL_IDS.FIRE_BOLT);
}

// The strongest fire spell the Magic level and carried runes allow (a fire staff or fire runes assumed):
// Fire Wave 75 (blood), Fire Blast 59 (death), Fire Bolt 35 (chaos), else Fire Strike.
export function bestFireSpell(magic: number, carried: readonly { id: number; count: number }[]): number {
    const has = (id: number) => carried.some(i => i.id === id && i.count > 0);
    if (magic >= 75 && has(565)) return SPELL_IDS.FIRE_WAVE!;
    if (magic >= 59 && has(560)) return SPELL_IDS.FIRE_BLAST!;
    if (magic >= 35 && has(562)) return SPELL_IDS.FIRE_BOLT!;
    return SPELL_IDS.FIRE_STRIKE!;
}

// The account's server, from the SERVER line of its bot.env (the same file openBot reads).
export function accountServer(name: string, root = resolve(import.meta.dir, '..')): string {
    return serverFromEnv(readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8'));
}

export async function huntOnce(session: Session, cfg: Cfg, stopped: () => boolean, emit: (e: object) => void, server = accountServer(session.name)) {
    const { sdk, bot } = session;
    const me = () => { const p = sdk.getState()?.player; return p && { x: p.worldX, z: p.worldZ, level: p.level, combat: p.combatLevel, hp: p.hp, maxHp: p.maxHp }; };
    const friends = new Set([...(cfg.friends ?? tradePartners(server))].map(n => n.toLowerCase()));
    friends.add(session.name.toLowerCase());
    const route = sweep(cfg.maxWild);
    let leg = -1;
    const radar = new Radar();
    const closeRadar = connectRadar(server, radar);
    const end = Date.now() + cfg.maxMs;
    // cfg.maxTicks: the hunt also ends after that many game ticks, so a practice run gets the same game time whatever
    // the machine's speed (the wall clock gave 213 to 3,169 ticks to one minute, extra:roam-field).
    const tickEnd = cfg.maxTicks ? session.tick() + cfg.maxTicks : Infinity;
    const going = () => Date.now() < end && session.tick() < tickEnd;
    const food = () => sdk.getInventory().filter(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const magic = sdk.getSkill('Magic')?.baseLevel ?? 1;
    // The fight loop casts the freeze the level allows, so it freezes only when that one is castable.
    const freezeNow = () => cfg.freeze ? castableFreeze(magic, sdk.getInventory()) : null;
    const freeze = freezeNow();
    const stats = { attacks: 0, kills: 0, deaths: 0, eats: 0, freezes: 0, chases: 0, loot: [] as string[], lootValue: 0, banked: 0, escapes: 0, targets: [] as string[] };
    const walker = await sessionWalker(session);
    const skip = new Set<string>();
    // Roster tracks plus the players the client sees now; the client copy wins for players in view.
    const tracks = (): Track[] => {
        const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
        const all = new Map(radar.fresh() ? radar.tracks : []);
        for (const p of sdk.getState()?.nearbyPlayers ?? []) {
            const key = p.name.toLowerCase(), old = all.get(key);
            const o = seen.get(key);
            const fighting = p.inCombat && (p.combatTargetType === 'npc' || p.combatTargetType === 'player') ? p.combatTargetType : undefined;
            all.set(key, { name: p.name, x: p.x, z: p.z, combatLevel: p.combatLevel, vx: old?.vx ?? 0, vz: old?.vz ?? 0, fighting,
                skulled: o?.skulled, protect: o?.protect, hpFrac: o?.hp ? o.hp.current / o.hp.max : undefined, weapon: o?.worn.rhand });
        }
        return [...all.values()];
    };
    const claimsFile = join(resolve(import.meta.dir, '..'), '.practice', 'pk-roam', 'claims.json');
    const readClaims = (): Claims => {
        try { return new Map(Object.entries(JSON.parse(readFileSync(claimsFile, 'utf8')))) as Claims; } catch { return new Map(); }
    };
    const writeClaims = (edit: (c: Claims) => void) => {
        try {
            const c = readClaims(); edit(c);
            mkdirSync(join(claimsFile, '..'), { recursive: true });
            writeFileSync(claimsFile, JSON.stringify(Object.fromEntries(c)));
        } catch { /* claims are a courtesy between our hunters */ }
    };
    const myName = session.name.toLowerCase();
    // Our own weapon's value: the best of the staged melee and ranged weapons.
    const myWeaponValue = () => Math.max(0, ...[...(kit.melee ?? []), ...(kit.ranged ?? []), ...(kit.magic ?? [])].map(id => itemCost(id)));
    const claim = (target: string) => writeClaims(c => c.set(target.toLowerCase(), { hunter: myName, at: Date.now() }));
    const release = (target: string) => writeClaims(c => { if (c.get(target.toLowerCase())?.hunter === myName) c.delete(target.toLowerCase()); });
    const pickNow = (m: { x: number; z: number; combat: number }) =>
        pickTrack({ ...m, name: myName, weaponValue: myWeaponValue() }, tracks(), friends, cfg.maxWild, skip, MIN_ESCAPE_TILES, readClaims(), Date.now());
    let wentIn = false;
    let spun = -1;
    // The fight kit is read once, as staged: the worn weapon and shield, a bow and a staff carried.
    const kit = kitFrom(sdk.getEquipment(), sdk.getInventory(), cfg.ranged);
    emit({ e: 'kit', kit });
    // Loot and banking: everything staged at the start is kit; anything else carried is loot.
    // The kit is the pack's count of each item at the start: loot often is the same items (a maxed target drops rune
    // arrows, a staff, rune armour, a dagger, a glory and runes), so an id kept as kit left all of it in the pack
    // and each bank trip deposited nothing (extra:roam-field, finding 70). An item counts in any dose or charge (a
    // drunk Prayer potion(2) or a rubbed glory is still kit): the key is its name without the "(n)".
    const GLORY = /^amulet of glory\([1-4]\)$/i;
    const kitKey = (i: { id: number; name: string }) => i.name.replace(/\(\d\)$/, '').toLowerCase();
    const startPack = new Map<string, number>();
    // Worn items count too: the fight loop's escape takes a worn glory off to rub it and leaves it in the pack.
    for (const i of [...sdk.getInventory(), ...sdk.getEquipment()]) startPack.set(kitKey(i), (startPack.get(kitKey(i)) ?? 0) + i.count);
    const extraLoot = () => { const now = new Map<string, number>(); for (const i of [...sdk.getInventory(), ...sdk.getEquipment()]) now.set(kitKey(i), (now.get(kitKey(i)) ?? 0) + i.count); return [...now].some(([k, n]) => n > (startPack.get(k) ?? 0)); };
    const startFood = food()[0];
    const foodCount = startFood ? sdk.getInventory().filter(i => i.id === startFood.id).length : 0;
    const valuer = makeValuer(server);
    const lootMin = cfg.lootMin ?? 1000, bankAt = cfg.bankAt ?? 30_000;
    let carried = 0;
    const loot = async (at: { x: number; z: number }) => { carried += await lootAt(session, at, { value: valuer, min: lootMin, stats, emit }); };
    // A full pack sends the hunt to the bank only with loot to put there: the fight kit itself (18 sharks, runes,
    // potions, the bow) leaves 2 slots or fewer, and each chase then ended in a 156-tick walk to the bank and back
    // with nothing deposited (extra:army-route-spear-pair-x5, finding 68).
    const needBank = () => carried >= bankAt || (carried > 0 && 28 - sdk.getInventory().length <= 2);
    const bank = async (why: string) => {
        emit({ e: 'bank-trip', why, carried });
        const ok = await bankTrip(session, walker, startPack, kitKey, startFood?.id, foodCount, stopped, emit);
        if (ok) { stats.banked += carried; carried = 0; }
        return ok;
    };

    // Damage taken from players, for the danger checks between fights (the fight loop keeps its own).
    const hits: { tick: number; damage: number; src: number }[] = [];
    let seenHit = 0;
    const recordHits = () => {
        let maxHit = seenHit;
        for (const e of sdk.getState()?.combatEvents ?? []) {
            const id = e.observationId ?? e.tick;
            if (id <= seenHit) continue;
            if (id > maxHit) maxHit = id;
            if (e.type === 'damage_taken' && e.sourceType === 'other_player') hits.push({ tick: session.tick(), damage: e.damage, src: e.sourceIndex });
        }
        seenHit = maxHit;
    };
    const canTeleport = () => (sdk.getSkill('Magic')?.level ?? 1) >= 25 && sdk.getInventory().some(i => /^law rune$/i.test(i.name))
        && sdk.getInventory().some(i => /^air rune$/i.test(i.name) && i.count >= 3)
        && (sdk.getInventory().some(i => /^fire rune$/i.test(i.name)) || sdk.getEquipment().some(i => /staff of fire|fire battlestaff/i.test(i.name)));
    // Leave the Wilderness: glory, else teleport, else run south (eating) until one works. Ends the hunt.
    const escape = async (why: string) => {
        stats.escapes++;
        emit({ e: 'escape', why, hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0 });
        // A stop request does not end the escape: live, a stop file froze Mightyrod at level 36 and it died.
        let blocked = 0, removeTries = 0;
        for (let step = 0; step < 120; step++) {
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (m.hp * 100 <= m.maxHp * cfg.eatAt) { const meal = bestFood(sdk.getInventory() as any); if (meal) await bot.eatFood(meal as any); }
            const glory = sdk.getInventory().find(i => GLORY.test(i.name));
            const worn = sdk.getEquipment().find(i => GLORY.test(i.name));
            const how = escapeStep(wildLevel(m.x, m.z), { glory: !!glory || (!!worn && removeTries < 3), teleport: canTeleport() });
            if (how === 'out') { emit({ e: 'escaped', at: [m.x, m.z], hp: m.hp }); return true; }
            // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option): a worn one comes off
            // first, into a free slot (a full pack eats a food for one). Without this a roam with its glory worn
            // walked out, and a blocked walk stood 908 ticks at level 14. Three tries, then the walk.
            if (how === 'glory' && !glory) {
                const meal = sdk.getInventory().length >= 28 ? bestFood(sdk.getInventory() as any) : undefined;
                if (meal) await bot.eatFood(meal as any);
                else { removeTries++; await sdk.sendUseEquipmentItem?.(worn!.slot, 1); }
                await sdk.waitForTicks(1); continue;
            }
            if (how === 'glory') {
                const op = glory!.optionsWithIndex?.find((o: any) => /^rub$/i.test(o.text));
                await sdk.sendUseItem(glory!.slot, op?.opIndex ?? 4);
                for (let i = 0; i < 6 && !sdk.getDialog()?.isOpen; i++) await sdk.waitForTicks(1);
                await sdk.clickDialogByText(/^Edgeville/i);
                await sdk.waitForTicks(6);
                // A glory that came off to be rubbed goes back on: left in the pack, the rubbed one (a new item id)
                // read as loot and the next bank trip deposited it.
                if (removeTries > 0) await wearGlory(session);
            } else if (how === 'teleport') {
                await sdk.sendClickComponent(componentId('magic:varrock_teleport'));
                await sdk.waitForTicks(6);
            } else {
                // A walk that moved us nowhere goes 10 tiles to the side, east and west in turn, before south again.
                const side = blocked ? (blocked % 2 ? 10 : -10) : 0;
                await walkPath(walker, [{ x: m.x + side, z: Math.max(3510, m.z - (side ? 4 : 20)), tol: 2 }], { maxTicks: 12, idleMs: 9000 });
                const n = me();
                blocked = n && n.x === m.x && n.z === m.z ? blocked + 1 : 0;
            }
        }
        return false;
    };
    const survive = async (): Promise<'ok' | 'flee' | 'dead'> => {
        const m = me();
        if (!m) return 'ok';
        recordHits();
        if (wildLevel(m.x, m.z) > 0) wentIn = true;
        if (wentIn && cheb(m, { x: 3222, z: 3218 }) <= 6) { stats.deaths++; emit({ e: 'death' }); return 'dead'; }
        const attackers = (sdk.getState()?.nearbyPlayers ?? []).filter(p => hits.some(h => h.src === p.index && session.tick() - h.tick <= 10));
        const oppMax = estMaxHit(Math.max(m.combat, ...attackers.map(p => p.combatLevel)));
        if (m.hp <= Math.max(m.maxHp * cfg.eatAt / 100, oppMax + 8) && food().length) {
            const r = await bot.eatFood(bestFood(sdk.getInventory() as any) as any ?? food()[0]);
            stats.eats++; emit({ e: 'eat', hp: m.hp, ok: r.success });
        }
        const danger = wildLevel(m.x, m.z) > 0 ? dangerReason({ hp: m.hp, maxHp: m.maxHp, food: food().length > 0, prayer: sdk.getState()?.prayers?.prayerPoints ?? 1,
            // No race here: this check does not see the damage dealt, so every fight's hits read as a lost race
            // (dealt 0) and ended the hunt after its first timeout (finding 63). The fight loop runs the race itself.
            oppMax, hits, dealt: [], now: session.tick(), race: process.env.ROAM_RACE === '1', noFoodAt: cfg.fight?.noFoodAt }) : null;
        if (danger) { await escape(danger); return 'flee'; }
        if (wildLevel(m.x, m.z) > 0) {
            const seen = new Map(readOpponents(session.client).map(o => [o.name.toLowerCase(), o]));
            const threat = (sdk.getState()?.nearbyPlayers ?? []).find(p => !friends.has(p.name.toLowerCase()) && p.distance <= 12 && outclasses(
                { combat: m.combat, weaponValue: myWeaponValue() }, { combatLevel: p.combatLevel, weapon: seen.get(p.name.toLowerCase())?.worn.rhand }));
            if (threat) { await escape(`threat: ${threat.name} (combat ${threat.combatLevel}) at ${threat.distance} tiles`); return 'flee'; }
            if (wildLevel(m.x, m.z) > cfg.maxWild) { await escape(`deeper than the limit (${wildLevel(m.x, m.z)} > ${cfg.maxWild})`); return 'flee'; }
        }
        return 'ok';
    };

    // Fight one target until it dies, logs out, leaves the Wilderness, or the chase stalls.
    // The feed shows no armour, so the first pick is by reach. Once the target is in view, the chase moves, before its
    // first fight, to an idle player in view whose melee armour is at least ROAM_SOFTER (40) stab defence lower
    // (research/pvp-fight-loop.md finding 62). ROAM_SWITCH=0 keeps the first pick.
    const switchOn = process.env.ROAM_SWITCH !== '0', softer = Number(process.env.ROAM_SOFTER ?? 40);
    // cfg.specAll: every special goes at any health and with no reserve (the army leader's LEADER_SPEC=all).
    const specAll = <T extends { below: number } | undefined>(spec: T): T => (cfg.specAll && spec ? { ...spec, below: 1 } : spec);
    const stabOf = (index: number) => { const o = observePlayer(session.client, index); return o ? armourDefence(o.worn.map(id => getObjNames().get(id) ?? '')).melee : null; };
    let chasing = '';
    const chase = async (first: string): Promise<'kill' | 'gone' | 'left' | 'stall' | 'flee' | 'dead' | 'stop'> => {
        let name = chasing = first, fought = false;
        stats.chases++;
        let lastTile: { x: number; z: number } | null = null, lastDist = Infinity, contactAt = session.tick();
        let held = false, freezeReady = 0, lastSeenAt: { x: number; z: number } | null = null;
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s !== 'ok') return s;
            const m = me()!;
            const near = sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === name.toLowerCase());
            const track = radar.tracks.get(name.toLowerCase());
            if (session.tick() % 10 === 0) claim(name);
            const opp = near ? readOpponent(session.client, name) : null;
            if (opp?.hp?.fresh && opp.hp.current === 0) {
                stats.kills++; emit({ e: 'kill', target: name, at: lastTile });
                await sdk.waitForTicks(4);
                if (cfg.loot && lastTile) await loot(lastTile);
                return 'kill';
            }
            if (!near && radar.fresh() && !track) { emit({ e: 'gone', target: name, at: lastTile }); if (cfg.loot && lastTile && cheb(m, lastTile) <= 3) await loot(lastTile); return 'gone'; }
            const pos = near ?? track;
            if (!pos) {
                // No radar and out of view: give up after 60 ticks.
                if (session.tick() - contactAt > 60) { emit({ e: 'gone', target: name, at: lastTile }); return 'gone'; }
                await sdk.waitForTicks(1); continue;
            }
            if (wildLevel(pos.x, pos.z) === 0) { emit({ e: 'left', target: name }); return 'left'; }
            // Never follow a target past the depth limit: live, a chase took Mightyrod from level 5 to 36, past the
            // reach of its teleport (20), and it died there.
            if (wildLevel(pos.x, pos.z) > cfg.maxWild || wildLevel(m.x, m.z) > cfg.maxWild) { emit({ e: 'too-deep', target: name, wild: wildLevel(m.x, m.z) }); return 'left'; }
            lastTile = { x: pos.x, z: pos.z };

            if (near && near.distance <= 15 && switchOn && !fought) {
                const mine = stabOf(near.index);
                const soft = mine === null ? undefined : (sdk.getState()?.nearbyPlayers ?? [])
                    .filter(p => p.index !== near.index && !friends.has(p.name.toLowerCase()) && !skip.has(p.name.toLowerCase()) && p.distance <= 15 && !p.inCombat && canAttack(m, p))
                    .map(p => ({ p, stab: stabOf(p.index) })).filter(x => x.stab !== null && x.stab + softer <= mine)
                    .sort((a, b) => a.stab! - b.stab! || a.p.distance - b.p.distance)[0];
                if (soft) {
                    emit({ e: 'switch', from: name, to: soft.p.name, stab: [mine, soft.stab] });
                    release(name); name = chasing = soft.p.name; claim(name); stats.targets.push(name);
                    lastDist = Infinity; held = false; lastSeenAt = null; continue;
                }
            }
            if (near && near.distance <= 15) {
                contactAt = session.tick();
                const fleeing = near.distance > lastDist && near.distance >= 2;
                lastDist = near.distance;
                // The SDK reports every freeze as a hit (the server grants the XP before the hit roll), so a held
                // target is one that stops moving: a move after a freeze means it splashed or ended.
                if (held && lastSeenAt && cheb(lastSeenAt, near) >= 1) { held = false; freezeReady = Math.max(freezeReady, session.tick() + 5); }
                lastSeenAt = { x: near.x, z: near.z };
                // Freeze first, at first reach, before the target can run; freeze again whenever it moves.
                const castable = freezeNow();
                if (cfg.hold?.()) {
                    const range = cfg.holdRange ?? 3;
                    if (near.distance > range && !cfg.pace?.()) await walkPath(walker, [{ x: near.x, z: near.z, tol: range }], { maxTicks: 2, idleMs: 9000, stop: stopped });
                    else await sdk.waitForTicks(1);
                    continue;
                }
                if (castable && canAttack(m, near) && session.tick() >= freezeReady && !held) {
                    // A cast on an immune or held target gives no XP; the SDK then waits out its timeout, so keep it short:
                    // 2.4 s is 6 live ticks (400 ms). Live, 1 s (2.5 ticks) reported every Snare as unproved.
                    const r = await bot.castSpell(near as any, castable, 2400);
                    if (r.success) { held = true; stats.freezes++; lastSeenAt = { x: near.x, z: near.z }; }
                    freezeReady = session.tick() + 3;
                    emit({ e: 'freeze', target: name, spell: freeze, ok: r.success, msg: r.success ? undefined : r.message });
                    continue;
                }
                if (!canAttack(m, near)) {
                    // Out of level range here: step toward the target, which takes us deeper.
                    await walkPath(walker, [{ x: near.x, z: near.z, tol: 1 }], { maxTicks: 4, idleMs: 9000, stop: stopped });
                    continue;
                }
                // The tribrid fight itself: scripts/pk.ts fightPlayer (style off the overhead, gear switch per turn,
                // special, food, prayer, glory escape). It exits immediately if the target leaves range or the
                // Wilderness, exceeds maxWild, or a stop condition fires.
                stats.attacks++; fought = true;
                const fight = await fightPlayer(session, name, {
                    // eatAt is a percentage here and an HP value in fightPlayer. Live, a 26 HP account given 50 ate a shark every
                    // 3 ticks at full HP.
                    kit, spec: specAll(defaultSpec(kit)), freeze: freezeNow() !== null ? 'flee' : false, predictPrayer: true, snapPrayer: true, eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), exitOnDanger: true,
                    escapeAt: Math.ceil((me()?.maxHp ?? 99) * cfg.fleeAt / 100), damageSpell: cfg.spell.toUpperCase() === 'AUTO' ? bestFireSpell(magic, sdk.getInventory()) : spellId(cfg.spell),
                    cap: 120, maxWild: cfg.maxWild, maxDistance: 15, ...cfg.fight, stop: () => stopped() || !going(),
                    log: line => emit({ e: "fight", line }),
                });
                emit({ e: "fight-end", target: name, outcome: fight.outcome, ticks: fight.ticks, dealt: fight.dealt, taken: fight.taken, eaten: fight.eaten });
                stats.eats += fight.eaten;
                stats.freezes += fight.freezes;
                if (fight.outcome === "kill") {
                    stats.kills++;
                    const at = fight.targetAt ?? lastTile;
                    await sdk.waitForTicks(4);
                    if (cfg.loot && at) await loot(at);
                    return "kill";
                }
                if (fight.outcome === "died") { stats.deaths++; return "dead"; }
                if (fight.outcome === "escaped") return "flee";
                if (fight.outcome === "danger") {
                    // The fight loop's own escape first (ROAM_FLEE, default on): protect prayer off the attacker's style,
                    // food, glory or the teleport spell, else a run with freezes on a chaser; as the hunt does (finding 61).
                    if (process.env.ROAM_FLEE !== '0') {
                        stats.escapes++;
                        emit({ e: 'escape', why: fight.danger ?? 'danger', hp: me()?.hp, wild: me() ? wildLevel(me()!.x, me()!.z) : 0, flee: true });
                        const e = await fightPlayer(session, name, { kit, exitOnDanger: false, cap: 200, predictPrayer: true, snapPrayer: true, flee: true,
                            eatAt: Math.ceil((me()?.maxHp ?? 99) * cfg.eatAt / 100), maxDistance: 15,
                            escapeSpell: canTeleport() ? componentId('magic:varrock_teleport') : undefined, log: line => emit({ e: 'fight', line }) });
                        emit({ e: 'flee-end', outcome: e.outcome, hp: me()?.hp });
                        if (e.outcome === 'died') { stats.deaths++; return 'dead'; }
                        const m2 = me();
                        if (m2 && wildLevel(m2.x, m2.z) === 0) return 'flee';
                    }
                    await escape(fight.danger ?? "danger"); return "flee";
                }
                lastDist = Infinity;
                continue;
            }
            // Out of view: run to the cut-off tile, re-aimed on each new roster frame.
            if (session.tick() - contactAt > 400) { emit({ e: 'stall', target: name }); return 'stall'; }
            // A group's pace: while pace() is true (someone is behind) the chase waits a tick for it.
            if (cfg.pace?.()) { await sdk.waitForTicks(1); continue; }
            const aim = track ? intercept(m, track) : { ...pos, ticks: 0 };
            const frame = radar.tick;
            await walkPath(walker, [{ x: aim.x, z: aim.z, tol: 2 }], {
                maxTicks: 40, idleMs: 9000,
                stop: () => stopped() || radar.tick !== frame || !!cfg.pace?.() ||
                    !!sdk.getState()?.nearbyPlayers.some(p => p.name.toLowerCase() === name.toLowerCase() && p.distance <= 15),
            });
        }
        return 'stop';
    };

    try {
        while (!stopped() && going()) {
            // A pass that used no game tick waits one, so the client and other sessions keep running.
            if (session.tick() === spun) await sdk.waitForTicks(1);
            spun = session.tick();
            const s = await survive();
            if (s === 'dead') break;
            const m = me();
            if (!m) { await sdk.waitForTicks(1); continue; }
            if (s === 'flee') break;
            const pick = pickNow(m);
            if (!pick) {
                // Nobody attackable: sweep the Wilderness. Start at the nearest sweep tile, then go round.
                // Each hunter starts at its own point of the loop, so several hunters spread over the Wilderness.
                if (leg < 0) leg = sectorStart(session.name, route.length);
                else if (cheb(route[leg], m) <= 4) leg = (leg + 1) % route.length;
                const before = session.tick();
                const walk = await walkPath(walker, [{ ...route[leg], tol: 3 }], { maxTicks: 30, idleMs: 9000, stop: () => stopped() || !!pickNow(me()!) });
                // Never spin: a walk that used no tick (blocked or already there) moves to the next leg and waits.
                if (session.tick() === before) {
                    if (!walk.ok) emit({ e: 'sweep-blocked', leg: route[leg], at: [m.x, m.z], detail: walk.detail });
                    leg = (leg + 1) % route.length; await sdk.waitForTicks(1);
                }
                continue;
            }
            const name = pick.track.name;
            stats.targets.push(name);
            emit({ e: 'target', target: name, combat: pick.track.combatLevel, wild: wildLevel(pick.track.x, pick.track.z), meetIn: Math.round(pick.at.ticks), at: [pick.track.x, pick.track.z] });
            claim(name);
            const outcome = await chase(name).finally(() => release(chasing));
            emit({ e: 'chase-end', target: chasing, outcome });
            if (outcome === 'dead' || outcome === 'stop') break;
            if (outcome === 'flee') break;
            if (outcome === 'stall' || outcome === 'left') skip.add(chasing.toLowerCase());
            if (needBank() && !(await bank(carried >= bankAt ? 'loot value' : 'pack full'))) break;
        }
        // Bank whatever loot is carried before logging out; with none, just leave the Wilderness.
        const m = me();
        if (m && stats.deaths === 0) {
            // Out of the Wilderness first, whatever ended the hunt (a stop request included).
            if (wildLevel(m.x, m.z) > 0) await escape(stopped() ? 'stop requested' : 'end of hunt');
            if (extraLoot()) await bank('end of hunt');
        }
    } finally { closeRadar(); }
    return stats;
}

// Item value in gp: the live market (referencePrice, else lastPrice, else basePrice), cached per item; with no market
// (a practice server or a failed request) the item cost in knowledge/items.json. Coins are 1 gp each.
let costs: Map<number, number> | undefined;
export function itemCost(id: number, root = resolve(import.meta.dir, '..')): number {
    costs ??= new Map((JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[]).map(i => [i.id, i.cost ?? 0]));
    return costs.get(id) ?? 0;
}
export function makeValuer(server: string, get: (url: string) => Promise<any> = async url => (await fetch(url, { signal: AbortSignal.timeout(3000) })).json()) {
    const cache = new Map<number, number>();
    return async (id: number): Promise<number> => {
        if (id === 995) return 1;
        if (cache.has(id)) return cache.get(id)!;
        let price = 0;
        if (!isLocalServer(server)) {
            try { const r = await get(`https://${server}/api/market/items/${id}`); price = r?.referencePrice ?? r?.lastPrice ?? r?.basePrice ?? 0; }
            catch { /* market down: cost below */ }
        }
        if (!(price > 0)) price = itemCost(id);
        cache.set(id, price);
        return price;
    };
}

type Ground = { id: number; name: string; count: number; x: number; z: number };
// The stacks on and next to the kill tile worth at least min gp, most valuable first.
export function planLoot(ground: readonly Ground[], at: { x: number; z: number }, price: ReadonlyMap<number, number>, min: number) {
    return ground.filter(g => cheb(g, at) <= 1).map(g => ({ ...g, value: (price.get(g.id) ?? 0) * g.count }))
        .filter(g => g.value >= min).sort((a, b) => b.value - a.value);
}

// Picks up the valuable stacks at a kill tile; a full pack eats a food to make room. Returns the gp picked up.
async function lootAt(session: Session, at: { x: number; z: number }, ctx: { value: (id: number) => Promise<number>; min: number; stats: { loot: string[]; lootValue: number }; emit: (e: object) => void }) {
    const { sdk, bot } = session;
    const ground = (sdk.getState()?.groundItems ?? []) as unknown as Ground[];
    const price = new Map<number, number>();
    for (const g of ground) if (cheb(g, at) <= 1 && !price.has(g.id)) price.set(g.id, await ctx.value(g.id));
    let got = 0;
    for (const g of planLoot(ground, at, price, ctx.min)) {
        const stacks = sdk.getInventory().some(i => i.id === g.id && i.count > 1);
        if (sdk.getInventory().length >= 28 && !stacks) {
            const meal = sdk.getInventory().find(i => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
            if (!meal) { ctx.emit({ e: 'loot-skipped', item: g.name, value: g.value, why: 'pack full' }); continue; }
            await bot.eatFood(meal);
        }
        const live = (sdk.getState()?.groundItems ?? []).find((x: any) => x.id === g.id && x.x === g.x && x.z === g.z);
        if (!live) continue;
        const r = await bot.pickupItem(live as any);
        if (!r.success) { ctx.emit({ e: 'loot-failed', item: g.name, msg: r.message }); continue; }
        got += g.value; ctx.stats.lootValue += g.value; ctx.stats.loot.push(g.name);
        ctx.emit({ e: 'loot', item: g.name, count: g.count, value: g.value });
    }
    return got;
}

export const EDGEVILLE_BANK_TILE = { x: 3094, z: 3492 };
// Walks to Edgeville bank, deposits everything that is not kit, takes food back to its staged count. True when banked.
async function bankTrip(session: Session, walker: Awaited<ReturnType<typeof sessionWalker>>, startPack: ReadonlyMap<string, number>, kitKey: (i: { id: number; name: string }) => string,
    foodId: number | undefined, foodCount: number, stopped: () => boolean, emit: (e: object) => void): Promise<boolean> {
    const { sdk, bot } = session;
    const walk = await walkPath(walker, [{ ...EDGEVILLE_BANK_TILE, tol: 3 }], { maxTicks: 900, idleMs: 9000, stop: stopped });
    if (!walk.ok) { emit({ e: 'bank-failed', why: 'walk', detail: walk.detail }); return false; }
    if (!(await bot.openBank()).success) { emit({ e: 'bank-failed', why: 'open' }); return false; }
    // Each item beyond the pack's count at the start goes in the bank.
    const deposited: string[] = [];
    const held = new Map<number, { item: ReturnType<typeof sdk.getInventory>[number]; count: number }>();
    for (const i of sdk.getInventory()) { const h = held.get(i.id); held.set(i.id, { item: h?.item ?? i, count: (h?.count ?? 0) + i.count }); }
    const kitLeft = new Map(startPack);
    for (const w of sdk.getEquipment()) kitLeft.set(kitKey(w), (kitLeft.get(kitKey(w)) ?? 0) - w.count);
    for (const { item, count } of held.values()) {
        const k = kitKey(item), keepN = Math.min(count, kitLeft.get(k) ?? 0);
        kitLeft.set(k, (kitLeft.get(k) ?? 0) - keepN);
        if (count - keepN <= 0) continue;
        const r = await bot.depositItem(item, count - keepN);
        if (r.success) deposited.push(`${item.name} x${count - keepN}`);
    }
    let restocked = 0;
    const have = foodId === undefined ? 0 : sdk.getInventory().filter(i => i.id === foodId).length;
    if (foodId !== undefined && have < foodCount) {
        const r = await bot.withdrawItem(foodId, foodCount - have);
        if (r.success) restocked = foodCount - have;
    }
    await bot.closeBank();
    emit({ e: 'banked', deposited, restocked });
    return true;
}

const arg = (args: string[], key: string, d: string) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? d;

if (import.meta.main) {
    const [name, ...args] = process.argv.slice(2);
    if (!name) throw new Error('usage: bun scripts/pk-roam.ts <account> [MAX_MINUTES=20] [MAX_WILD=30] [EAT_AT=50] [FLEE_AT=30] [SPELL=AUTO] [RANGED=regex] [LOOT=1] [FREEZE=1] [LOOT_MIN=1000] [BANK_AT=30000] [MAX_TICKS=n] [FRIENDS=name,name]');
    const stop = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
    if (stop()) throw new Error('PK stop file present');
    const ranged = arg(args, 'RANGED', '');
    const cfg: Cfg = {
        maxMs: Number(arg(args, 'MAX_MINUTES', '20')) * 60_000, maxWild: Number(arg(args, 'MAX_WILD', '30')),
        eatAt: Number(arg(args, 'EAT_AT', '50')), fleeAt: Number(arg(args, 'FLEE_AT', '30')),
        spell: arg(args, 'SPELL', 'AUTO'), ranged: ranged ? new RegExp(ranged, 'i') : undefined,
        loot: arg(args, 'LOOT', '1') === '1', freeze: arg(args, 'FREEZE', '1') === '1',
        lootMin: Number(arg(args, 'LOOT_MIN', '1000')), bankAt: Number(arg(args, 'BANK_AT', '30000')),
        ...(arg(args, 'MAX_TICKS', '') ? { maxTicks: Number(arg(args, 'MAX_TICKS', '')) } : {}),
        // A practice run registers its accounts as owned (tradeguard.ts), so its target is a friend unless FRIENDS names the list.
        ...(args.some(a => a.startsWith('FRIENDS=')) ? { friends: arg(args, 'FRIENDS', '').split(',').filter(Boolean) } : {}),
    };
    // ROAM_PROFILE=<profile of scripts/pk-spar.ts>: that profile's fight options (its reading, prayers, freezes,
    // armour, reserve and crowd rules) for each fight of the hunt; the kit, spec weapon and caps stay the roam's.
    // auto (default): the champion for a maxed account (combat 115 or more), whose fights against a target that
    // defends on the champion went 379 dealt, 360 taken where the roam's own options went 307, 404 (research finding
    // 58); the roam's own options for a lower build (finding 37). none: the roam's own options.
    const session = await openBot(name);
    const roamProfile = arg(args, 'ROAM_PROFILE', 'auto'), combat = session.sdk.getState()?.player?.combatLevel ?? 0;
    const chosen = roamProfile === 'auto' ? (combat >= 115 ? 'champion' : '') : roamProfile === 'none' ? '' : roamProfile;
    if (chosen) {
        const { PROFILES } = await import('./pk-spar');
        const { specBelow: _below, ...profile } = PROFILES[chosen] ?? (() => { throw new Error(`unknown ROAM_PROFILE ${chosen}`); })();
        cfg.fight = { ...cfg.fight, ...profile };
    }
    const emit = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: session.tick(), ...e }));
    let result: Awaited<ReturnType<typeof huntOnce>> | undefined, failure: string | undefined;
    try { result = await huntOnce(session, cfg, stop, emit); }
    catch (error) { failure = String(error); }
    const ok = !!result && !failure;
    const loggedOut = await settle([session], ok, failure ?? `PK hunt: ${result!.kills} kills, ${result!.deaths} deaths, ${result!.attacks} attacks`);
    console.log('PK_HUNT ' + JSON.stringify({ ok, failure, ...result, loggedOut }));
    process.exitCode = ok && loggedOut ? 0 : 1;
}

// Restock before a trip: what to buy from the runes held (bank and pack) and the coins held.
// Law runes: GE at most 1,600 gp each (live ask 1,345), up to 10, while under 2 are held: Varrock Teleport is the
// escape. Nature runes for freezes: GE at most 300 gp (ask 250), up to 20. Water runes have no GE sellers; Betty's
// rune shop (scripts/shop-buyer.ts betty) sells them, with a spend cap. 1,000 coins always stay.
export type RestockStep = { kind: 'ge'; item: number; quantity: number; limit: number; owned: number } | { kind: 'shop'; profile: 'betty'; maxSpend: number };
// Food and gear come after the escape runes (GE, live prices): sharks up to 20 at 700 gp (ask 563, 2 million for
// sale); a magic shortbow at 110,000 (ask 96,000) for Ranged 50+ without one; a rune chainbody at 300,000 (ask
// 278,874) for Defence 40+ without rune body armour. Rune scimitars, platebodies, platelegs and kiteshields had no
// sellers. Each gear buy also keeps 20,000 coins for the next restock.
export function restockPlan(held: { law: number; nature: number; water: number; coins: number; magic: number;
    food?: number; sharks?: number; ranged?: number; defence?: number; magicShortbow?: boolean; runeBody?: boolean }): RestockStep[] {
    const steps: RestockStep[] = [];
    let coins = held.coins - 1000;
    if (held.law < 2) {
        const quantity = Math.min(10, Math.floor(coins / 1600));
        if (quantity >= 1) { steps.push({ kind: 'ge', item: 563, quantity, limit: 1600, owned: held.law }); coins -= quantity * 1600; }
    }
    // Freezes need both nature and water runes: keep the water budget back before buying nature runes.
    const waterShort = held.magic >= 50 && held.water < 10;
    let nature = held.nature;
    if (held.magic >= 50 && held.nature < 8) {
        const quantity = Math.min(20, Math.floor((coins - (waterShort ? 500 : 0)) / 300));
        if (quantity >= 4) { steps.push({ kind: 'ge', item: 561, quantity, limit: 300, owned: held.nature }); coins -= quantity * 300; nature += quantity; }
    }
    // Water alone cannot freeze: buy it only with 4 or more nature runes (Bind needs 2, Entangle 4) held after.
    if (waterShort && nature >= 4 && coins >= 500) { steps.push({ kind: 'shop', profile: 'betty', maxSpend: 500 }); coins -= 500; }
    if (held.food !== undefined && held.food < 15) {
        const quantity = Math.min(20 - held.food, Math.floor(coins / 700));
        // owned is EXPECTED_OWNED for buy-owned-ge-item.ts: the sharks already held, which it tops up from.
        if (quantity >= 5) { steps.push({ kind: 'ge', item: 385, quantity, limit: 700, owned: held.sharks ?? 0 }); coins -= quantity * 700; }
    }
    if ((held.ranged ?? 1) >= 50 && held.magicShortbow === false && coins >= 110_000 + 20_000) {
        steps.push({ kind: 'ge', item: 861, quantity: 1, limit: 110_000, owned: 0 }); coins -= 110_000;
    }
    if ((held.defence ?? 1) >= 40 && held.runeBody === false && coins >= 300_000 + 20_000) {
        steps.push({ kind: 'ge', item: 1113, quantity: 1, limit: 300_000, owned: 0 }); coins -= 300_000;
    }
    return steps;
}
