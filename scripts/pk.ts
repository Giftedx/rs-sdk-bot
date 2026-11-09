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
import type { NearbyPlayer } from '../vendor/rs-sdk/sdk/types';

export const ITEMS = {
    shark: 385, glory: [1712, 1710, 1708, 1706], prayerPotion: [2434, 139, 141, 143], superRestore: [3024, 3026, 3028, 3030],
    deathRune: 560, bloodRune: 565, fireRune: 554, airRune: 556, waterRune: 555, earthRune: 557, natureRune: 561, lawRune: 563,
} as const;
export const SPELLS = { fireBlast: 1181, fireWave: 1189, bind: 1572, snare: 1582, entangle: 1592 } as const;
// Prayer indices (vendor/rs-sdk/sdk/types.ts PRAYER_NAMES): 8 Protect Item, 12 Magic, 13 Missiles, 14 Melee.
export const PRAYER = { item: 8, magic: 12, missiles: 13, melee: 14 } as const;

export type Style = 'magic' | 'ranged' | 'melee';
export type Kit = { [S in Style]?: number[] };
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
    // A melee special with this kit and combat-tab bar once the target's health bar is at or under `below`: the dragon
    // dagger is { kit: [dagger, shield], bar: 'combat_stabsword:specbar', cost: 250, below: 0.5 }.
    spec?: { kit: number[]; bar: string; cost: number; below: number };
    // Out of food at or under this HP: rub an inventory amulet of glory to Edgeville (amulet_of_glory.rs2 allows it up
    // to Wilderness level 30; there is no Teleblock in the content).
    escapeAt?: number;
    damageSpell?: number;
    cap?: number;
    log?: (line: string) => void;
};
export type FightResult = { outcome: 'kill' | 'died' | 'escaped' | 'lost' | 'timeout'; ticks: number; dealt: number; taken: number; eaten: number; attacks: Record<Style, number>; freezes: number; specs: number };

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
export function weaponStyle(id: number | undefined, names = (objNames ??= new Map(readFileSync(join(resolve(import.meta.dir, '..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8')
    .split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; })))): Style {
    const name = id !== undefined && id >= 0 ? names.get(id) ?? '' : '';
    if (/(^|_)(shortbow|longbow|crossbow|dart|knife|thrownaxe|javelin)(_|$)|bow$/.test(name)) return 'ranged';
    if (/staff|wand/.test(name)) return 'magic';
    return 'melee';
}
const PROTECT_FROM: Record<Style, number> = { melee: 14, ranged: 13, magic: 12 };

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

// Attack delays in ticks: dragon dagger 4, dragon longsword 5, magic shortbow 4 (3 on rapid), spells 5.
const TURN: Record<Style, number> = { magic: 5, ranged: 4, melee: 4 };

export const wildernessLevel = (z: number) => (z >= 9920 ? Math.floor((z - 9920) / 8) + 1 : z >= 3520 ? Math.floor((z - 3520) / 8) + 1 : 0);
// Both players must stand in the Wilderness and the combat gap must fit inside the shallower player's level.
export function attackable(me: { z: number; combatLevel: number }, other: { z: number; combatLevel: number }): boolean {
    const level = Math.min(wildernessLevel(me.z), wildernessLevel(other.z));
    return level > 0 && Math.abs(me.combatLevel - other.combatLevel) <= level;
}
// The freeze spell the magic level allows: Entangle 79, Snare 50, Bind 20.
export const freezeSpell = (magic: number) => (magic >= 79 ? SPELLS.entangle : magic >= 50 ? SPELLS.snare : magic >= 20 ? SPELLS.bind : null);
// Adjacent, not diagonal: where a melee attack lands.
const adjacent = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;

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
    let last = -1, nextAttack = start, foodReady = start, potionReady = start, freezeReady = start, frozenUntil = start, seenEvent = 0, seenMessage = 0, lastSeen = start;
    let target: NearbyPlayer | undefined, rubbed = -1;
    for (;;) {
        await new Promise<void>(resolve => { const off = s.onTick(() => { off(); resolve(); }); });
        const now = s.tick(), state = sdk.getState(), me = state?.player;
        // PlayerState x and z are scene-local; worldX and worldZ are the tile coordinates players and the Wilderness use.
        const at = me ? { x: me.worldX, z: me.worldZ } : null;
        result.ticks = now - start;
        if (!state || !me || !at) continue;
        for (const e of state.combatEvents) {
            if ((e.observationId ?? e.tick) <= seenEvent) continue;
            seenEvent = e.observationId ?? e.tick;
            if (e.type === 'damage_dealt' && e.targetType === 'other_player') result.dealt += e.damage;
            if (e.type === 'damage_taken') result.taken += e.damage;
        }
        for (const m of state.gameMessages) {
            const id = m.observationId ?? m.tick;
            if (id <= seenMessage || m.tick < start) continue;
            seenMessage = id;
            if (m.type === 0 && killMessage(m.text, targetName)) { result.outcome = 'kill'; log(`PK kill ${targetName} after ${result.ticks} ticks`); return result; }
        }
        if (rubbed >= 0 && wildernessLevel(at.z) === 0) { result.outcome = 'escaped'; log(`PK escaped ${targetName} after ${result.ticks} ticks at HP ${me.hp}`); return result; }
        if (me.isDead || me.hp <= 0 || (startLife !== undefined && me.lifeId !== startLife)) { result.outcome = 'died'; log(`PK died to ${targetName} after ${result.ticks} ticks`); return result; }
        target = state.nearbyPlayers.find(p => p.name.toLowerCase() === want);
        if (target) lastSeen = now;
        else if (now - lastSeen > 10) { result.outcome = 'lost'; log(`PK lost ${targetName} after ${result.ticks} ticks`); return result; }
        if (result.ticks >= cap) { log(`PK timeout against ${targetName}`); return result; }
        const inv = state.inventory, slotOf = (ids: readonly number[]) => inv.find(i => ids.includes(i.id));
        const use = (item: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }, verb: RegExp) => {
            const op = item.optionsWithIndex.find(x => verb.test(x.text));
            if (op) void sdk.sendUseItem(item.slot, op.opIndex);
        };
        // Food before anything: a shark heals 20 and takes 3 ticks before the next.
        if (me.hp <= eatAt && now >= foodReady) {
            const food = slotOf([ITEMS.shark]);
            if (food) { use(food, /^Eat$/i); foodReady = now + 3; result.eaten++; }
        }
        if (o.escapeAt !== undefined && me.hp <= o.escapeAt && !slotOf([ITEMS.shark]) && wildernessLevel(at.z) <= 30) {
            const glory = slotOf(ITEMS.glory);
            if (glory && (rubbed < 0 || now - rubbed > 6) && !state.dialog?.isOpen) { log(`PK rub glory at HP ${me.hp}`); use(glory, /^Rub$/i); rubbed = now; }
            if (state.dialog?.isOpen) void sdk.clickDialogByText(/^Edgeville/i);
            continue;
        }
        const prayers = state.prayers;
        if (prayers.prayerPoints <= restoreAt && now >= potionReady) {
            const potion = slotOf([...ITEMS.prayerPotion, ...ITEMS.superRestore]);
            if (potion) { use(potion, /^Drink$/i); potionReady = now + 3; }
        }
        if (!target) continue;
        const seen = observePlayer(s.client, target.index);
        // Protect from the style of the opponent's worn weapon, and Protect Item.
        if (prayers.prayerPoints > 0) {
            const wanted = seen ? PROTECT_FROM[weaponStyle(seen.worn[3])] : adjacent(at, target) ? PRAYER.melee : PRAYER.magic;
            for (const p of [PRAYER.item, wanted]) if (!prayers.activePrayers[p]) void sdk.sendTogglePrayer(p);
        }
        if (now < nextAttack || !attackable({ z: at.z, combatLevel: me.combatLevel }, target)) continue;
        // The special: wield its kit first, since the combat tab shows the new weapon's bar only after the switch;
        // then turn the bar on and attack in the next tick.
        const spec = o.spec, energy = special(s.client);
        if (spec && energy.energy >= spec.cost && lowHealth(seen, spec.below)) {
            const missing = spec.kit.filter(id => !state.equipment.some(e => e.id === id));
            if (missing.length) { for (const id of missing) { const item = slotOf([id]); if (item) use(item, /^(Wield|Wear)$/i); } nextAttack = now + 1; continue; }
            log(`PK special energy ${energy.energy} on ${energy.on} target ${seen!.health}/${seen!.totalHealth}`);
            if (!energy.on) void sdk.sendClickComponent(componentId(spec.bar));
            void sdk.sendInteractPlayer(target.index, 2);
            result.specs++; result.attacks.melee++;
            last = Math.max(0, rotation.indexOf('melee'));
            nextAttack = now + TURN.melee;
            continue;
        }
        const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const freeze = o.freeze ? freezeSpell(magicLevel) : null;
        const castFreeze = freeze !== null && o.kit.magic && now >= freezeReady && now >= frozenUntil;
        // Hit off the opponent's overhead: a style they protect against loses 40% of its max hit.
        const guarded = o.readOverheads === false ? new Set<Style>() : protectedStyles(seen?.headicons);
        const turn = castFreeze ? { style: 'magic' as Style, index: last }
            : nextStyle(rotation, last, st => !!o.kit[st] && !guarded.has(st)) ?? nextStyle(rotation, last, st => !!o.kit[st]);
        if (!turn) continue;
        // Wield the turn's kit in this tick, then attack.
        for (const id of o.kit[turn.style] ?? []) {
            if (state.equipment.some(e => e.id === id)) continue;
            const item = slotOf([id]);
            if (item) use(item, /^(Wield|Wear)$/i);
        }
        if (turn.style === 'magic') {
            const spell = castFreeze ? freeze! : (o.damageSpell ?? SPELLS.fireWave);
            void sdk.sendSpellOnPlayer(target.index, spell);
            if (castFreeze) { result.freezes++; freezeReady = now + 25; frozenUntil = now + 16; }
        } else void sdk.sendInteractPlayer(target.index, 2);
        result.attacks[turn.style]++;
        last = turn.index;
        nextAttack = now + TURN[turn.style];
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
    const r = await fightPlayer(s, target, { kit, cap: Number(cap ?? 600) });
    await finish([s], r.outcome === 'kill', `${r.outcome} ${JSON.stringify(r)}`);
}
