// Player fight loop: one account fights one named player in the Wilderness until a kill, a death, an escape or the
// tick cap. Each attack is one style turn (magic, ranged or melee); the gear for the turn is wielded in the same tick
// as the attack. With `freeze`, a freeze (Entangle, Snare or Bind) is cast whenever the target is free and it is ready.
// Server rules this follows (vendor/rs-sdk/server/content/scripts): protect prayers cut player hits by 40%
// (skill_combat/scripts/pvp/pvp_melee.rs2:32, pvp_ranged.rs2:38, pvp_magic.rs2:182); a freeze lasts half as long
// against Protect from Magic and leaves 5 ticks of immunity (pvp_magic.rs2:11-36, 85-104, 156); the attackable
// range is the lower Wilderness level (wilderness_levels.rs2:4-16, pvp_combat.rs2:32-48).
// Usage: bun scripts/pk.ts <bot> <target name> [CAP ticks]; practice only until a live pilot is qualified.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import { tickWaits } from '../packages/core/src/tick-stream';
import type { NearbyPlayer } from '../vendor/rs-sdk/sdk/types';

export const ITEMS = {
    shark: 385, karambwan: 3144, glory: [1712, 1710, 1708, 1706],
    prayerPotion: [2434, 139, 141, 143], superRestore: [3024, 3026, 3028, 3030],
    superAttack: [2436, 145, 147, 149], attackPotion: [2428, 121, 123, 125],
    superStrength: [2440, 157, 159, 161], strengthPotion: [113, 115, 117, 119],
    superDefence: [2442, 163, 165, 167], defencePotion: [2432, 133, 135, 137],
    rangingPotion: [2444, 169, 171, 173], magicPotion: [3040, 3042, 3044, 3046],
    antipoison: [2448, 181, 183, 185, 2446, 175, 177, 179],
    deathRune: 560, bloodRune: 565, chaosRune: 562, mindRune: 558,
    fireRune: 554, airRune: 556, waterRune: 555, earthRune: 557, natureRune: 561, lawRune: 563,
} as const;
export const SPELLS = {
    fireStrike: 1158, fireBolt: 1169, fireBlast: 1181, fireWave: 1189,
    saradominStrike: 1190, clawsOfGuthix: 1191, flamesOfZamorak: 1192, charge: 1193, ibanBlast: 1539,
    bind: 1572, snare: 1582, entangle: 1592,
    // Teleports work up to Wilderness level 20 (skill_magic/scripts/spells/teleport.rs2:17); Varrock costs 1 law, 3 air, 1 fire.
    varrockTeleport: 1164, lumbridgeTeleport: 1167, faladorTeleport: 1170, camelotTeleport: 1174,
} as const;
// Prayer indices (vendor/rs-sdk/sdk/types.ts PRAYER_NAMES, content prayers.dbrow).
export const PRAYER = {
    thickSkin: 0, burstOfStrength: 1, clarityOfThought: 2,
    rockSkin: 3, superhumanStrength: 4, improvedReflexes: 5,
    item: 8, steelSkin: 9, ultimateStrength: 10, incredibleReflexes: 11,
    magic: 12, missiles: 13, melee: 14, smite: 17,
} as const;
const PRAYER_REQ: Record<number, number> = {
    0: 1, 1: 4, 2: 7, 3: 10, 4: 13, 5: 16, 8: 25, 9: 28, 10: 31, 11: 34, 12: 37, 13: 40, 14: 43, 17: 52,
};

export type Style = 'magic' | 'ranged' | 'melee';
export type Kit = { [S in Style]?: number[] };
export type SpecConfig = { kit: number[]; bar: string; cost: number; below: number; style?: Style };
export type FightOptions = {
    kit: Kit;
    // Style turns in order; a style with no kit is skipped. Melee walks to the target.
    rotation?: Style[];
    eatAt?: number;
    restorePrayerAt?: number;
    // Cast a freeze whenever the target is free (default off: in a stand-up practice duel it slowed the kill, median
    // 358 against 305 ticks over 3 runs each; research/pvp-fight-loop.md).
    freeze?: boolean;
    // Choose a style the opponent's overhead prayer does not cover (default on).
    readOverheads?: boolean;
    // A melee or ranged special with this kit and combat-tab bar once the target's health bar is at or under `below`:
    // the dragon dagger is { kit: [dagger, shield], bar: 'combat_stabsword:specbar', cost: 250, below: 0.5 }.
    spec?: SpecConfig;
    // Out of food at or under this HP: rub an inventory amulet of glory to Edgeville (amulet_of_glory.rs2 allows it up
    // to Wilderness level 30; there is no Teleblock in the content), or with no glory cast `escapeSpell` (level 20).
    escapeAt?: number;
    escapeSpell?: number;
    // Return outcome "danger" (with the reason) as soon as dangerReason fires, so the caller can escape.
    exitOnDanger?: boolean;
    damageSpell?: number;
    maxWild?: number;
    maxDistance?: number;
    stop?: () => boolean;
    cap?: number;
    log?: (line: string) => void;
};
export type FightResult = { outcome: 'kill' | 'died' | 'escaped' | 'lost' | 'timeout' | 'danger' | 'session ended'; danger?: string; ticks: number; dealt: number; taken: number; eaten: number; attacks: Record<Style, number>; freezes: number; specs: number; targetAt?: { x: number; z: number } };

// Overhead protect prayers from the head icon bits (content player/configs/headicon.constant: 3 melee, 4 missiles, 5 magic).
export function protectedStyles(headicons: number | undefined): Set<Style> {
    const bits = headicons ?? 0, out = new Set<Style>();
    if (bits & (1 << 3)) out.add('melee');
    if (bits & (1 << 4)) out.add('ranged');
    if (bits & (1 << 5)) out.add('magic');
    return out;
}
export const skulled = (headicons: number | undefined) => ((headicons ?? 0) & 1) !== 0;

// The style a worn weapon attacks with, from its object name (content pack/obj.pack). No weapon is melee (fists).
let objNames: Map<number, string> | undefined;
const getObjNames = () => (objNames ??= new Map(readFileSync(join(resolve(import.meta.dir, '..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8')
    .split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; })));
export function weaponStyle(id: number | undefined, names = getObjNames()): Style {
    const name = id !== undefined && id >= 0 ? names.get(id) ?? '' : '';
    if (/(^|_)(shortbow|longbow|crossbow|dart|knife|thrownaxe|javelin)(_|$)|bow$/.test(name)) return 'ranged';
    if (/staff|wand/.test(name)) return 'magic';
    return 'melee';
}
const PROTECT_FROM: Record<Style, number> = { melee: 14, ranged: 13, magic: 12 };

// Prayers for the current combat state (player_combat_stat.rs2:33-35, 62-67): Protect Item, the best Defence prayer
// (boosts melee, ranged and 30% of magic defence), the overhead for the opponent's weapon, and on melee/spec turns the
// best Strength and Attack prayers (+15% max hit and accuracy at 31/34), turned off on non-melee turns to save drain.
export function combatPrayers(prayerBase: number, overhead: number | null, meleeTurn: boolean): { want: number[]; off: number[] } {
    const want: number[] = [], off: number[] = [];
    if (prayerBase >= PRAYER_REQ[PRAYER.item]!) want.push(PRAYER.item);
    const def = prayerBase >= 28 ? PRAYER.steelSkin : prayerBase >= 10 ? PRAYER.rockSkin : prayerBase >= 1 ? PRAYER.thickSkin : null;
    if (def !== null) want.push(def);
    if (overhead !== null && prayerBase >= (PRAYER_REQ[overhead] ?? 99)) want.push(overhead);
    const str = prayerBase >= 31 ? PRAYER.ultimateStrength : prayerBase >= 13 ? PRAYER.superhumanStrength : prayerBase >= 4 ? PRAYER.burstOfStrength : null;
    const atk = prayerBase >= 34 ? PRAYER.incredibleReflexes : prayerBase >= 16 ? PRAYER.improvedReflexes : prayerBase >= 7 ? PRAYER.clarityOfThought : null;
    for (const p of [str, atk]) {
        if (p === null) continue;
        if (meleeTurn) want.push(p);
        else off.push(p);
    }
    return { want, off };
}

// Default special-attack config from a staged kit (content specwep=true: dragon dagger 25%, longsword 25%, mace 25%,
// rune claws 25%, magic shortbow 35% in bows.obj:343).
export function defaultSpec(kit: Kit, names = getObjNames()): SpecConfig | undefined {
    for (const id of kit.melee ?? []) {
        const n = names.get(id) ?? '';
        if (/^dragon_dagger/.test(n)) return { kit: kit.melee!, bar: 'combat_stabsword:specbar', cost: 250, below: 0.65, style: 'melee' };
        if (n === 'dragon_longsword') return { kit: kit.melee!, bar: 'combat_hacksword:specbar', cost: 250, below: 0.6, style: 'melee' };
        if (n === 'dragon_mace') return { kit: kit.melee!, bar: 'combat_spiked:specbar', cost: 250, below: 0.6, style: 'melee' };
        if (n === 'rune_claws') return { kit: kit.melee!, bar: 'combat_claw:specbar', cost: 250, below: 0.6, style: 'melee' };
    }
    for (const id of kit.ranged ?? []) {
        if ((names.get(id) ?? '') === 'magic_shortbow') return { kit: kit.ranged!, bar: 'combat_bow:specbar', cost: 350, below: 0.5, style: 'ranged' };
    }
    return undefined;
}

// Metal/leather armour pieces that penalize a magic or ranged attack roll on the cast/shot tick (kiteshields.obj,
// platebodies.obj, platelegs.obj, full_helms.obj, leather_gear.obj). Ordered by largest penalty first (torso -30,
// legs -21, shield -8, helm -6); unequipped on the attack tick before the hit roll and re-equipped on the next tick.
export function negativeCastArmour(worn: readonly { id: number; slot: number }[], style: Style, kitIds: ReadonlySet<number>, names = getObjNames()): { id: number; slot: number }[] {
    if (style === 'melee') return [];
    const re = style === 'magic'
        ? /(^|_)(platebody|chainbody|dragonhide_body|leather_body|studded_body|platelegs|plateskirt|dragonhide_chaps|studded_chaps|kiteshield|sq_shield|full_helm|med_helm|coif)(_|$)/
        : /(^|_)(platebody|chainbody|platelegs|plateskirt|full_helm)(_|$)/;
    const rank = (slot: number) => (slot === 4 ? 0 : slot === 7 ? 1 : slot === 5 ? 2 : 3);
    return worn
        .filter(e => !kitIds.has(e.id) && re.test(names.get(e.id) ?? ''))
        .sort((a, b) => rank(a.slot) - rank(b.slot))
        .map(e => ({ id: e.id, slot: e.slot }));
}

// Another player's head icons and worn items, read from the in-process client's player entity (webclient
// dash3d/ClientPlayer.ts headicons, appearance: a part at 512 or more is an object id + 512). The SDK state leaves them
// out, and reading them here keeps the swarm's launch release unchanged.
// Its health bar (ClientEntity health, totalHealth) holds the values of the last hit it took.
export type Observed = { headicons: number; worn: number[]; health: number; totalHealth: number };
export function observePlayer(client: unknown, index: number): Observed | null {
    const p = (client as { players?: ({ headicons?: number; appearance?: ArrayLike<number>; health?: number; totalHealth?: number } | null)[] } | undefined)?.players?.[index];
    if (!p) return null;
    return { headicons: p.headicons ?? 0, worn: Array.from(p.appearance ?? [], part => (part >= 512 ? part - 512 : -1)), health: p.health ?? 0, totalHealth: p.totalHealth ?? 0 };
}
// Special attack energy (0-1000) and the bar's on state, client vars 300 and 301 (scripts/microbot-c-qol.ts enableSpecial).
const special = (client: unknown) => { const v = (client as { var?: number[] } | undefined)?.var; return { energy: v?.[300] ?? 0, on: v?.[301] === 1 }; };
// A health bar at or under the fraction, from a hit that showed one.
export const lowHealth = (seen: Observed | null, fraction: number) => !!seen && seen.totalHealth > 0 && seen.health / seen.totalHealth <= fraction;

// The killer's message for a PvP death, with the loser's display name (skill_combat/scripts/pvp/pvp_combat.rs2:203-222).
const KILL_MESSAGES = ['You have defeated {}.', '{} was no match for you.', 'With a crushing blow you finish {}.', 'Can anyone defeat you? Certainly not {}.',
    '{} regrets the day they met you in combat.', "It's all over for {}.", "{} didn't stand a chance against you.", 'A humiliating defeat for {}.',
    '{} falls before your might.', '{} has won a free ticket to Lumbridge.', 'You were clearly a better fighter than {}.'];
const plain = (text: string) => text.trim().toLowerCase().replace(/[_\u00a0]/g, ' ');
export const killMessage = (text: string, name: string) => KILL_MESSAGES.some(t => plain(t.replace('{}', name)) === plain(text));

// Attack delays in ticks: dragon dagger/scimitar/claws 4, longsword/mace 5, magic shortbow 4 (3 on rapid, 4 on spec per pvp_special_attack.rs2:35), spells 5.
const TURN: Record<Style, number> = { magic: 5, ranged: 4, melee: 4 };
const meleeWeaponDelay = (ids: readonly number[] | undefined, names = getObjNames()) =>
    (ids ?? []).some(id => /(longsword|mace|battleaxe|warhammer|2h_sword|halberd)/.test(names.get(id) ?? '')) ? 5 : 4;

// Food best first by heal; any other item with an Eat option comes after these.
export const FOOD_ORDER = [/^shark$/i, /^cooked karambwan$/i, /^swordfish$/i, /^lobster$/i, /^bass$/i, /^tuna$/i, /^salmon$/i, /^trout$/i, /^pike$/i];
export function bestFood<T extends { name: string; optionsWithIndex: { text: string }[] }>(inv: readonly T[]): T | undefined {
    const edible = inv.filter(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text)));
    for (const re of FOOD_ORDER) { const hit = edible.find(i => re.test(i.name)); if (hit) return hit; }
    return edible[0];
}
// A conservative max hit for an opponent of this combat level: about a quarter of it, never under 10 (a combat 126
// melee main with a dragon weapon hits about 30; the dagger special hits twice).
export const estMaxHit = (combatLevel: number) => Math.max(10, Math.round(combatLevel / 4));

// Danger: the fight is lost or about to be. Survival comes before the kill.
// - out of food with HP at or under 1.5 opponent max hits;
// - two or more players hit us in the last 10 ticks (a pile);
// - losing the damage race: over the last 30 ticks we took 30+ and at least twice what we dealt, at under 60% HP;
// - no prayer points left at under 50% HP.
export function dangerReason(o: { hp: number; maxHp: number; food: boolean; prayer: number; oppMax: number;
    hits: readonly { tick: number; damage: number; src: number }[]; dealt: readonly { tick: number; damage: number }[]; now: number }): string | null {
    if (!o.food && o.hp <= o.oppMax * 1.5) return `no food at HP ${o.hp}`;
    const attackers = new Set(o.hits.filter(h => o.now - h.tick <= 10).map(h => h.src));
    if (attackers.size >= 2) return `${attackers.size} players hitting`;
    const taken = o.hits.filter(h => o.now - h.tick <= 30).reduce((n, h) => n + h.damage, 0);
    const dealt = o.dealt.filter(h => o.now - h.tick <= 30).reduce((n, h) => n + h.damage, 0);
    if (taken >= 30 && taken >= 2 * dealt && o.hp < o.maxHp * 0.6) return `losing the race: took ${taken}, dealt ${dealt}`;
    if (o.prayer <= 0 && o.hp < o.maxHp * 0.5) return 'no prayer points';
    return null;
}

// The next game tick, or false once the session has ended: a dropped session publishes no more ticks, so a plain
// onTick wait would hang and a loop around it would spin on failed actions. The wait counts as an open tick stream,
// so a lockstep practice engine runs its next tick at once (inprocess.ts acknowledgeTick) and does not hold each tick
// for the busy limit.
export function nextTick(s: Pick<Session, 'onTick' | 'ended'>): Promise<boolean> {
    return new Promise(resolve => {
        let open = true;
        const end = (ticked: boolean) => { if (!open) return; open = false; tickWaits.active--; off(); resolve(ticked); };
        tickWaits.active++;
        const off = s.onTick(() => end(true));
        void s.ended.then(() => end(false));
    });
}

export const wildernessLevel = (z: number) => (z >= 9920 ? Math.floor((z - 9920) / 8) + 1 : z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0);
// Both players must stand in the Wilderness and the combat gap must fit inside the shallower player's level.
export function attackable(me: { z: number; combatLevel: number }, other: { z: number; combatLevel: number }): boolean {
    const level = Math.min(wildernessLevel(me.z), wildernessLevel(other.z));
    return level > 0 && Math.abs(me.combatLevel - other.combatLevel) <= level;
}
// The freeze spell the magic level allows: Entangle 79, Snare 50, Bind 20.
export const freezeSpell = (magic: number) => (magic >= 79 ? SPELLS.entangle : magic >= 50 ? SPELLS.snare : magic >= 20 ? SPELLS.bind : null);
const FREEZE_RUNES: Record<number, [number, number, number]> = { [SPELLS.entangle]: [5, 5, 4], [SPELLS.snare]: [4, 4, 3], [SPELLS.bind]: [3, 3, 2] };
const FREEZE_TICKS: Record<number, number> = { [SPELLS.entangle]: 24, [SPELLS.snare]: 16, [SPELLS.bind]: 8 };
// Freeze duration in ticks (magic_combat_spells.dbrow freeze_time; halved against Protect from Magic in pvp_magic.rs2:156-158).
export const freezeDuration = (spell: number, protectFromMagic: boolean) => {
    const base = FREEZE_TICKS[spell] ?? 16;
    return protectFromMagic ? Math.floor(base / 2) : base;
};
// Strongest freeze the Magic level and held runes allow (557 earth, 555 water, 561 nature).
export function castableFreeze(magic: number, carried: readonly { id: number; count: number }[]): number | null {
    const max = freezeSpell(magic);
    if (max === null) return null;
    const held = (id: number) => carried.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    for (const spell of [SPELLS.entangle, SPELLS.snare, SPELLS.bind]) {
        const [earth, water, nature] = FREEZE_RUNES[spell]!;
        if (spell <= max && held(ITEMS.earthRune) >= earth && held(ITEMS.waterRune) >= water && held(ITEMS.natureRune) >= nature) return spell;
    }
    return null;
}
// Strongest fire spell the Magic level and carried catalyst runes allow; defaults to Fire Wave when no catalyst runes are carried.
export function bestDamageSpell(magic: number, carried: readonly { id: number; count: number }[]): number {
    const has = (id: number) => carried.some(i => i.id === id && i.count > 0);
    if (magic >= 75 && has(ITEMS.bloodRune)) return SPELLS.fireWave;
    if (magic >= 59 && has(ITEMS.deathRune)) return SPELLS.fireBlast;
    if (magic >= 35 && has(ITEMS.chaosRune)) return SPELLS.fireBolt;
    if (has(ITEMS.mindRune)) return SPELLS.fireStrike;
    return SPELLS.fireWave;
}
// Adjacent, not diagonal: where a melee attack lands.
const adjacent = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// A style is usable only with a non-empty kit: an empty list casts damage spells with whatever is wielded
// (a dagger, a bow), which hits for a fraction of the staff's max hit and wastes the turn. kits built by
// scripts/pk-roam.ts kitFrom only hold a style when the account carries its weapon.
export const hasStyle = (kit: Kit, style: Style) => (kit[style]?.length ?? 0) > 0;

// The next style turn in rotation order, skipping a style that is not usable.
export function nextStyle(rotation: readonly Style[], last: number, usable: (s: Style) => boolean): { style: Style; index: number } | null {
    for (let step = 1; step <= rotation.length; step++) {
        const index = (last + step) % rotation.length, style = rotation[index]!;
        if (usable(style)) return { style, index };
    }
    return null;
}

export async function fightPlayer(s: Session, targetName: string, o: FightOptions): Promise<FightResult> {
    const log = o.log ?? ((line: string) => console.log(line));
    const rotation = o.rotation ?? ['magic', 'ranged', 'melee'];
    const eatAt = o.eatAt ?? 50, restoreAt = o.restorePrayerAt ?? 20, cap = o.cap ?? 600;
    const result: FightResult = { outcome: 'timeout', ticks: 0, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: 0 }, freezes: 0, specs: 0 };
    const sdk = s.sdk, start = s.tick(), want = targetName.toLowerCase();
    const startLife = sdk.getState()?.player?.lifeId;
    let last = -1, nextAttack = start, lastAttackAt = -10, lastWalkTicks = 0, hasAttacked = false, delayedUntil = start;
    let foodReady = start, karambwanReady = start, potionReady = start;
    let freezeReady = start, frozenUntil = start, freezeCastAt = -10, frozenTile: { x: number; z: number } | null = null, selfFrozenUntil = start;
    let seenEvent = 0, seenMessage = 0, lastSeen = start, unattackableSince = -1, poisoned = false, rapidSet = false, pjedByNpc = false;
    let target: NearbyPlayer | undefined, rubbed = -1, ranAt = -10, prevSelf: { x: number; z: number } | null = null;
    const hits: { tick: number; damage: number; src: number }[] = [], dealtLog: { tick: number; damage: number }[] = [];
    // Tank torso worn or carried at fight start (unequipped for a cast/shot and re-equipped on melee turns).
    const names = getObjNames();
    const initState = sdk.getState();
    const tankIds = new Set<number>(
        [...(initState?.equipment ?? []).filter(e => e.slot === 4), ...(initState?.inventory ?? [])]
            .filter(e => /(^|_)(platebody|chainbody)(_|$)/.test(names.get(e.id) ?? '')).map(e => e.id),
    );
    for (;;) {
        if (!await nextTick(s)) { result.outcome = 'session ended'; log(`PK session ended against ${targetName}`); return result; }
        const now = s.tick(), state = sdk.getState(), me = state?.player;
        // PlayerState x and z are scene-local; worldX and worldZ are the tile coordinates players and the Wilderness use.
        const at = me ? { x: me.worldX, z: me.worldZ } : null;
        result.ticks = now - start;
        if (!state || !me || !at) continue;
        if (prevSelf && (at.x !== prevSelf.x || at.z !== prevSelf.z)) selfFrozenUntil = now;
        prevSelf = { x: at.x, z: at.z };
        let maxEvent = seenEvent;
        for (const e of state.combatEvents) {
            const id = e.observationId ?? e.tick;
            if (id <= seenEvent) continue;
            if (id > maxEvent) maxEvent = id;
            if (e.type === 'damage_dealt' && e.targetType === 'other_player') { result.dealt += e.damage; dealtLog.push({ tick: now, damage: e.damage }); }
            if (e.type === 'damage_taken') { result.taken += e.damage; if (e.sourceType === 'other_player') hits.push({ tick: now, damage: e.damage, src: e.sourceIndex }); }
        }
        seenEvent = maxEvent;
        let maxMessage = seenMessage;
        for (const m of state.gameMessages) {
            const id = m.observationId ?? m.tick;
            if (id <= seenMessage || m.tick < start) continue;
            if (id > maxMessage) maxMessage = id;
            if (m.type === 0 && killMessage(m.text, targetName)) { result.outcome = 'kill'; log(`PK kill ${targetName} after ${result.ticks} ticks`); return result; }
            if (/magical force stops you from moving|you're stunned/i.test(m.text) && now >= selfFrozenUntil) selfFrozenUntil = now + 8;
            if (/already held by a magical force|currently immune to that spell/i.test(m.text)) {
                freezeReady = Math.max(freezeReady, now + 4);
                frozenUntil = Math.max(frozenUntil, now + 4);
            }
            if (/have been poisoned/i.test(m.text)) poisoned = true;
            if (/already under attack/i.test(m.text)) pjedByNpc = true;
        }
        seenMessage = maxMessage;
        if ((rubbed >= 0 || ranAt >= 0) && wildernessLevel(at.z) === 0) { result.outcome = 'escaped'; log(`PK escaped ${targetName} after ${result.ticks} ticks at HP ${me.hp}`); return result; }
        if (me.isDead || me.hp <= 0 || (startLife !== undefined && me.lifeId !== startLife)) { result.outcome = 'died'; log(`PK died to ${targetName} after ${result.ticks} ticks`); return result; }
        if (o.stop?.()) { log(`PK stopped against ${targetName}`); return result; }
        target = state.nearbyPlayers.find(p => p.name.toLowerCase() === want);
        if (target) {
            lastSeen = now;
            result.targetAt = { x: target.x, z: target.z };
            if (frozenTile && now > freezeCastAt + 1 && (target.x !== frozenTile.x || target.z !== frozenTile.z)) {
                // Target moved after the freeze cast: if it moved right away the spell splashed (no immunity); else it wore off (5-tick immunity).
                const splashed = now <= freezeCastAt + 3;
                frozenUntil = now;
                freezeReady = splashed ? now : Math.min(freezeReady, now + 5);
                frozenTile = null;
            }
            if (o.maxDistance !== undefined && target.distance > o.maxDistance) { result.outcome = 'lost'; return result; }
            if (o.maxWild !== undefined && (wildernessLevel(at.z) > o.maxWild || wildernessLevel(target.z) > o.maxWild)) { result.outcome = 'lost'; return result; }
        } else if (now - lastSeen > 10) { result.outcome = 'lost'; log(`PK lost ${targetName} after ${result.ticks} ticks`); return result; }
        if (result.ticks >= cap) { log(`PK timeout against ${targetName}`); return result; }
        const inv = state.inventory, slotOf = (ids: readonly number[]) => inv.find(i => ids.includes(i.id));
        const oppCombat = Math.max(target?.combatLevel ?? 0, ...state.nearbyPlayers.filter(p => hits.some(h => h.src === p.index && now - h.tick <= 10)).map(p => p.combatLevel));
        const oppMax = estMaxHit(oppCombat || me.combatLevel);
        const danger = dangerReason({ hp: me.hp, maxHp: me.maxHp, food: !!bestFood(inv), prayer: state.prayers.prayerPoints, oppMax, hits, dealt: dealtLog, now });
        if (danger && o.exitOnDanger) { result.outcome = 'danger'; result.danger = danger; log(`PK danger against ${targetName}: ${danger}`); return result; }
        // While suspended by p_delay (DDS spec p_delay(0), potion p_delay(1), karambwan p_delay(2)), processClientsIn
        // drops OpHeld/InvButton/OpPlayer/MoveClick and protected scripts fail p_finduid(uid); wait until un-delayed.
        if (now < delayedUntil) continue;
        const use = (item: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }, verb: RegExp): boolean => {
            const op = item.optionsWithIndex.find(x => verb.test(x.text));
            if (!op) return false;
            void sdk.sendUseItem(item.slot, op.opIndex);
            return true;
        };
        if (state.combatStyle?.currentStyle === 1) rapidSet = true;
        // Food before anything, any food best first; eating adds 3 ticks to %action_delay on the server (consume.rs2:130).
        if (me.hp <= Math.max(eatAt, oppMax + 8) && now >= foodReady) {
            const food = bestFood(inv);
            if (food) {
                use(food, /^Eat$/i);
                foodReady = now + 3;
                nextAttack = (hasAttacked ? nextAttack : now) + 3;
                hasAttacked = true;
                result.eaten++;
                if (food.id === ITEMS.karambwan) { delayedUntil = Math.max(delayedUntil, now + 4); nextAttack = Math.max(nextAttack, delayedUntil); }
                // Combo-eat a cooked karambwan in the same tick when dangerously low (consume_messages.dbrow:779 p_delay(2)).
                if (me.hp <= oppMax && now >= karambwanReady && food.id !== ITEMS.karambwan) {
                    const kw = slotOf([ITEMS.karambwan]);
                    if (kw) {
                        use(kw, /^Eat$/i);
                        karambwanReady = now + 3;
                        delayedUntil = Math.max(delayedUntil, now + 4);
                        nextAttack = Math.max(nextAttack + 2, delayedUntil);
                        result.eaten++;
                    }
                }
            }
        }
        // Deeper than the teleports reach (glory 30, spells 20): run south first.
        const reach = slotOf(ITEMS.glory) ? 30 : o.escapeSpell !== undefined ? 20 : 0;
        if (o.escapeAt !== undefined && me.hp <= o.escapeAt && !bestFood(inv) && reach && wildernessLevel(at.z) > reach) {
            if (now - ranAt > 3) { void sdk.sendWalk(at.x, at.z - 14); ranAt = now; }
            continue;
        }
        if (o.escapeAt !== undefined && me.hp <= o.escapeAt && !bestFood(inv) && wildernessLevel(at.z) <= 30) {
            const glory = slotOf(ITEMS.glory);
            if (glory && (rubbed < 0 || now - rubbed > 6) && !state.dialog?.isOpen) { log(`PK rub glory at HP ${me.hp}`); use(glory, /^Rub$/i); rubbed = now; }
            else if (!glory && o.escapeSpell !== undefined && wildernessLevel(at.z) <= 20 && (rubbed < 0 || now - rubbed > 6)) {
                log(`PK teleport spell at HP ${me.hp}`); void sdk.sendClickComponent(o.escapeSpell); rubbed = now;
            }
            if (state.dialog?.isOpen) void sdk.clickDialogByText(/^Edgeville/i);
            continue;
        }
        const prayers = state.prayers;
        // Drinking a potion triggers p_delay(1) in processClientsIn (consume_effects.rs2:167), blocking client input on
        // now+1 and now+2 (ready on now+3). Drink non-emergency potions only when now+3 <= nextAttack.
        if (now >= potionReady && (prayers.prayerPoints <= 5 || now + 3 <= nextAttack)) {
            let potion = prayers.prayerPoints <= restoreAt ? slotOf([...ITEMS.prayerPotion, ...ITEMS.superRestore]) : undefined;
            if (!potion && poisoned) {
                potion = slotOf(ITEMS.antipoison);
                if (potion) poisoned = false;
            }
            if (!potion && now + 3 <= nextAttack) {
                const skill = (n: string) => state.skills.find(k => k.name === n);
                const unboosted = (n: string) => { const k = skill(n); return !!k && k.level <= k.baseLevel; };
                if (hasStyle(o.kit, 'melee') && unboosted('Strength')) potion = slotOf([...ITEMS.superStrength, ...ITEMS.strengthPotion]);
                if (!potion && hasStyle(o.kit, 'melee') && unboosted('Attack')) potion = slotOf([...ITEMS.superAttack, ...ITEMS.attackPotion]);
                if (!potion && hasStyle(o.kit, 'ranged') && unboosted('Ranged')) potion = slotOf(ITEMS.rangingPotion);
                if (!potion && unboosted('Defence')) potion = slotOf([...ITEMS.superDefence, ...ITEMS.defencePotion]);
            }
            if (potion) {
                use(potion, /^Drink$/i);
                potionReady = now + 3;
                delayedUntil = Math.max(delayedUntil, now + 3);
                nextAttack = Math.max(nextAttack, delayedUntil);
                continue;
            }
        }
        if (!target) continue;
        if (!attackable({ z: at.z, combatLevel: me.combatLevel }, target)) {
            if (wildernessLevel(target.z) === 0) { result.outcome = 'lost'; return result; }
            if (unattackableSince < 0) unattackableSince = now;
            else if (now - unattackableSince >= 6) { result.outcome = 'lost'; return result; }
        } else unattackableSince = -1;
        const seen = observePlayer(s.client, target.index);
        const prayerBase = state.skills.find(k => k.name === 'Prayer')?.baseLevel ?? 99;
        const lastHit = [...hits].reverse().find(h => now - h.tick <= 10);
        const hitter = lastHit && lastHit.src !== target.index ? observePlayer(s.client, lastHit.src) : null;
        const overhead = hitter ? PROTECT_FROM[weaponStyle(hitter.worn[3])] : seen ? PROTECT_FROM[weaponStyle(seen.worn[3])] : adjacent(at, target) ? PRAYER.melee : PRAYER.magic;
        const canReachMelee = !(now < selfFrozenUntil && !adjacent(at, target)) && (cheb(at, target) <= 6 || (!hasStyle(o.kit, 'magic') && !hasStyle(o.kit, 'ranged')));
        const guarded = o.readOverheads === false ? new Set<Style>() : protectedStyles(seen?.headicons);
        const styleUsable = (st: Style) => hasStyle(o.kit, st) && (st !== 'melee' || canReachMelee);
        const upcomingTurn = nextStyle(rotation, last, st => styleUsable(st) && !guarded.has(st)) ?? nextStyle(rotation, last, styleUsable) ?? nextStyle(rotation, last, st => hasStyle(o.kit, st));
        if (pjedByNpc) {
            pjedByNpc = false;
            if (!hitter && typeof sdk.sendInteractNpc === 'function') {
                const npc = (state.nearbyNpcs ?? [])
                    .filter(n => (n.hp === null || n.hp > 0) && n.optionsWithIndex?.some(op => /^attack$/i.test(op.text)))
                    .sort((a, b) => Number(b.inCombat) - Number(a.inCombat) || a.distance - b.distance)[0];
                const op = npc?.optionsWithIndex.find(x => /^attack$/i.test(x.text));
                if (npc && op) {
                    for (const id of [...(o.kit.melee ?? []), ...tankIds]) {
                        if (state.equipment.some(e => e.id === id)) continue;
                        const item = slotOf([id]);
                        if (item) use(item, /^(Wield|Wear)$/i);
                    }
                    void sdk.sendInteractNpc(npc.index, op.opIndex);
                    nextAttack = now + 8;
                    continue;
                }
            }
        }
        // Cooldown ticks: never send OpHeld/InvButton (which call clearPendingAction on the server), but configure
        // prayers and one-time combat-style settings once any melee approach walk has finished.
        if (now < nextAttack || unattackableSince >= 0) {
            let budget = 5;
            const walkingToMelee = now <= lastAttackAt + lastWalkTicks;
            if (!walkingToMelee && !rapidSet && state.combatStyle && state.combatStyle.styles.length > 1 && state.combatStyle.currentStyle !== 1 && budget > 0) {
                void sdk.sendSetCombatStyle?.(1);
                rapidSet = true;
                budget--;
            }
            if (prayers.prayerPoints > 0 && budget > 0) {
                // Pre-activate melee prayers on the tick before a melee turn so the attack tick needs 0 prayer packets.
                const nextIsMelee = now === nextAttack - 1 && (upcomingTurn?.style === 'melee' || (!!o.spec && lowHealth(seen, o.spec.below)));
                const { want: wantPray, off: offPray } = combatPrayers(prayerBase, overhead, nextIsMelee);
                for (const p of wantPray) if (!prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; }
                for (const p of offPray) if (prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; }
            }
            continue;
        }
        // When not cardinally adjacent, client interactPlayer/spellOnPlayer emits MOVE_OPCLICK + OPPLAYER* (2 USER_EVENT packets).
        const attackPackets = adjacent(at, target) ? 1 : 2;
        // The special: equip its kit, toggle its specbar, and attack in the same tick (OpHeldHandler updates tabs[0]
        // during decodeIn before IfButtonHandler checks isComponentVisible). Keep total USER_EVENT packets <= 5.
        const spec = o.spec, energy = special(s.client), specStyle: Style = spec?.style ?? 'melee';
        if (spec && energy.energy >= spec.cost && lowHealth(seen, spec.below) && (specStyle !== 'melee' || canReachMelee)
            && (!guarded.has(specStyle) || lowHealth(seen, 0.25))) {
            let budget = 5 - attackPackets - (energy.on ? 0 : 1);
            const toWield: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[] = [];
            for (const id of [...spec.kit, ...(specStyle === 'melee' ? tankIds : [])]) {
                if (state.equipment.some(e => e.id === id)) continue;
                const item = slotOf([id]);
                if (item && toWield.length < budget) toWield.push(item);
            }
            budget -= toWield.length;
            if (prayers.prayerPoints > 0 && budget > 0) {
                const { want: wantPray } = combatPrayers(prayerBase, overhead, specStyle === 'melee');
                for (const p of wantPray) if (!prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; }
            }
            for (const item of toWield) use(item, /^(Wield|Wear)$/i);
            log(`PK special energy ${energy.energy} on ${energy.on} target ${seen!.health}/${seen!.totalHealth}`);
            if (!energy.on) void sdk.sendClickComponent(componentId(spec.bar));
            void sdk.sendInteractPlayer(target.index, 2);
            result.specs++; result.attacks[specStyle]++;
            last = Math.max(0, rotation.indexOf(specStyle));
            const walkTicks = specStyle === 'melee' ? ((me.runEnergy ?? 100) >= 100 ? Math.ceil(Math.max(0, cheb(at, target) - 1) / 2) : Math.max(0, cheb(at, target) - 1)) : 0;
            // pvp_special_attack.rs2:35 always uses oc_param($weapon, attackrate) (4 for MSB/DDS/claws, 5 for longsword/mace), ignoring Rapid.
            const delay = specStyle === 'melee' ? meleeWeaponDelay(spec.kit, names) : TURN[specStyle];
            if (specStyle === 'melee' && walkTicks === 0 && spec.kit.some(id => /^dragon_dagger/.test(names.get(id) ?? ''))) {
                delayedUntil = Math.max(delayedUntil, now + 2); // pvp_dragon_dagger.rs2:11 p_delay(0)
            }
            lastAttackAt = now; lastWalkTicks = walkTicks;
            nextAttack = now + walkTicks + delay;
            hasAttacked = true;
            continue;
        }
        const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const hasFreezeRunes = inv.some(i => i.id === ITEMS.natureRune || i.id === ITEMS.earthRune || i.id === ITEMS.waterRune);
        const freeze = o.freeze ? (hasFreezeRunes ? castableFreeze(magicLevel, inv) : freezeSpell(magicLevel)) : null;
        const castFreeze = freeze !== null && hasStyle(o.kit, 'magic') && now >= freezeReady && now >= frozenUntil;
        // Hit off the opponent's overhead: a style they protect against loses 40% of its max hit.
        const turn = castFreeze ? { style: 'magic' as Style, index: last } : upcomingTurn;
        if (!turn) continue;
        const kitIds = new Set(o.kit[turn.style] ?? []);
        const switching2H = turn.style === 'ranged' && state.equipment.some(e => e.slot === 3) && state.equipment.some(e => e.slot === 5);
        // If switching to a 2H bow with a full 28-item pack and a shield worn, eat a food first so ~try_equip has room for the shield.
        if (switching2H && inv.length >= 28 && now >= foodReady) {
            const food = bestFood(inv);
            if (food) {
                use(food, /^Eat$/i);
                foodReady = now + 3;
                nextAttack = (hasAttacked ? nextAttack : now) + 3;
                hasAttacked = true;
                result.eaten++;
                continue;
            }
        }
        let budget = 5 - attackPackets;
        const toWield: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[] = [];
        for (const id of [...(o.kit[turn.style] ?? []), ...(turn.style === 'melee' ? tankIds : [])]) {
            if (state.equipment.some(e => e.id === id)) continue;
            const item = slotOf([id]);
            if (item && toWield.length < budget) toWield.push(item);
        }
        budget -= toWield.length;
        const freeSlots = 28 - inv.length - (switching2H ? 1 : 0);
        const toRemove = turn.style !== 'melee' && typeof sdk.sendUseEquipmentItem === 'function' && me.hp > oppMax + 12 && freeSlots >= 1 && budget >= 1
            ? negativeCastArmour(state.equipment, turn.style, kitIds, names).filter(eq => eq.slot === 4).slice(0, 1)
            : [];
        budget -= toRemove.length;
        if (prayers.prayerPoints > 0 && budget > 0) {
            const { want: wantPray } = combatPrayers(prayerBase, overhead, turn.style === 'melee');
            for (const p of wantPray) if (!prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; }
        }
        for (const item of toWield) use(item, /^(Wield|Wear)$/i);
        for (const eq of toRemove) {
            tankIds.add(eq.id);
            void sdk.sendUseEquipmentItem(eq.slot, 1);
        }
        if (turn.style === 'magic') {
            const spell = castFreeze ? freeze! : (o.damageSpell ?? bestDamageSpell(magicLevel, inv));
            void sdk.sendSpellOnPlayer(target.index, spell);
            if (castFreeze) {
                result.freezes++;
                const dur = freezeDuration(freeze!, guarded.has('magic'));
                frozenUntil = now + dur;
                freezeReady = now + dur + 5;
                freezeCastAt = now;
                frozenTile = { x: target.x, z: target.z };
            }
        } else void sdk.sendInteractPlayer(target.index, 2);
        result.attacks[turn.style]++;
        last = turn.index;
        const walkTicks = turn.style === 'melee' ? ((me.runEnergy ?? 100) >= 100 ? Math.ceil(Math.max(0, cheb(at, target) - 1) / 2) : Math.max(0, cheb(at, target) - 1)) : 0;
        const delay = turn.style === 'ranged' && rapidSet ? 3 : turn.style === 'melee' ? meleeWeaponDelay(o.kit.melee, names) : TURN[turn.style];
        lastAttackAt = now; lastWalkTicks = walkTicks;
        nextAttack = now + walkTicks + delay;
        hasAttacked = true;
    }
}

if (import.meta.main) {
    const [bot, target, cap] = process.argv.slice(2);
    if (!bot || !target) { console.log('usage: bun scripts/pk.ts <bot> <target> [CAP ticks]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const s = await openBot(bot);
    const kit: Kit = {
        magic: [1401], ranged: [861, 892], melee: [1231, 1201],
    };
    const r = await fightPlayer(s, target, { kit, spec: defaultSpec(kit), cap: Number(cap ?? 600) });
    await finish([s], r.outcome === 'kill', `${r.outcome} ${JSON.stringify(r)}`);
}
