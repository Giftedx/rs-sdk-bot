// Player fight loop: one account fights one named player in the Wilderness until a kill, a death, an escape or the
// tick cap. Each attack is one style turn (magic, ranged or melee); the gear for the turn is wielded in the same tick
// as the attack. With `freeze`, a freeze (Entangle, Snare or Bind) is cast whenever the target is free and it is ready.
// Server rules this follows (vendor/rs-sdk/server/content/scripts): protect prayers cut player hits by 40%
// (skill_combat/scripts/pvp/pvp_melee.rs2:32, pvp_ranged.rs2:38, pvp_magic.rs2:182); a freeze lasts half as long
// against Protect from Magic and leaves 5 ticks of immunity (pvp_magic.rs2:11-36, 85-104, 156); the attackable
// range is the lower Wilderness level (wilderness_levels.rs2:4-16, pvp_combat.rs2:32-48).
// Usage: bun scripts/pk.ts <bot> <target name> [CAP ticks]; practice only until a live pilot is qualified.
import { loadGear } from './gear';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { amendKillReceipt, killMessage, killReceiptProof, writeKillReceipt } from '../packages/core/src/kill-receipt';
import { componentId } from '../packages/core/src/logout';
import { weaponNameStyle } from '../packages/core/src/opponent';
import { questFlags } from '../packages/core/src/quest-status';
import { holdSessionEater } from '../packages/core/src/sustain';
import { tickWaits } from '../packages/core/src/tick-stream';
import { checkKillFeed, killFeed, settleKillFeed } from './pk-kill-feed';
import { armourDefence, StyleArms, StylePredictor, weakestFirst, type StyleArm } from './pk-read';
import { castable } from './teleport-runes';
import { Spells } from '../vendor/rs-sdk/sdk/spells';
import type { NearbyPlayer } from '../vendor/rs-sdk/sdk/types';

export const ITEMS = {
    shark: 385, karambwan: 3144, glory: [1712, 1710, 1708, 1706],
    dragonMace: 1434, dragonBattleaxe: 1377,
    prayerPotion: [2434, 139, 141, 143], superRestore: [3024, 3026, 3028, 3030], restorePotion: [2430, 127, 129, 131],
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
    magic: 12, missiles: 13, melee: 14,
} as const;
const PRAYER_REQ: Record<number, number> = {
    0: 1, 1: 4, 2: 7, 3: 10, 4: 13, 5: 16, 8: 25, 9: 28, 10: 31, 11: 34, 12: 37, 13: 40, 14: 43,
};

export type Style = 'magic' | 'ranged' | 'melee';
export type Kit = { [S in Style]?: number[] };
// stun: the ticks the special holds the target with no input (the dragon spear's, 4).
export type SpecConfig = { kit: number[]; bar: string; cost: number; below: number; style?: Style; stun?: number };
export type FightOptions = {
    kit: Kit;
    // The folder of the kill receipts when it is not the default one (packages/core/src/kill-receipt.ts). A session
    // with no lifecycle identity (a test double) writes a receipt only with this folder set.
    killReceiptRoot?: string;
    // Style turns in order; a style with no kit is skipped. Melee walks to the target.
    rotation?: Style[];
    eatAt?: number;
    restorePrayerAt?: number;
    // true: cast a freeze whenever the target is free (in a stand-up practice duel it slowed the kill, median 358
    // against 305 ticks over 3 runs each; research/pvp-fight-loop.md). 'flee': cast it only while the target runs away.
    // 'low': also while its health bar is at or under `freezeBelow` (default 0.62), so a target that is about to run is
    // already held.
    freeze?: boolean | 'flee' | 'low';
    freezeBelow?: number;
    // The freeze spell as for this Magic level at most: 78 casts Snare at most (4 earth, 4 water, 3 nature runes), 49
    // Bind (3, 3, 2), against Entangle's 5, 5, 4 (freezeSpell). Default the account's level.
    freezeMagicCap?: number;
    // With 'low': at most this many freeze casts on a target that has not run (default no limit). Each cast takes a
    // turn of 5 ticks, and against a target that stands and fights the turns cost more than the freeze gives.
    freezeEarlyMax?: number;
    // Once the target has fled (it is out of food): the style turns to use, and whether every special goes out at
    // once (default true). Unset, the rotation stays as it is.
    fledRotation?: Style[];
    // true: wield the staff for a freeze as for any spell. Default false: with the freeze runes carried, the freeze is
    // cast with the weapon in hand. An opponent that prays against the weapon it sees then has no Protect from Magic
    // up, and the freeze lasts its full time (pvp_magic.rs2:156 halves it under that prayer).
    freezeWithStaff?: boolean;
    // false: a freeze on a fled target takes off the torso alone, as any cast does.
    freezeStrip?: boolean;
    // Armour that cuts the attack roll of a cast or a shot (negativeCastArmour). 'torso' (default) takes the torso off
    // for the turn while HP is safe; 'keep' takes nothing off; 'strip' takes every such piece off.
    castArmour?: 'torso' | 'keep' | 'strip';
    // The same rule for a freeze (default 'torso', whatever castArmour says): the freeze needs its magic roll.
    freezeArmour?: 'torso' | 'keep' | 'strip';
    // false: no Defence prayer (Steel Skin and the lower ones). It saves prayer points and gives up their defence.
    defencePrayer?: boolean;
    // false: no Protect Item. An account with no skull keeps its three best items without it, and a melee turn then
    // has four prayers on, the most that the prayer flick turns off and on again in one tick.
    // 'skulled': Protect Item only while our own skull shows. A skulled account keeps no item without it, so it is the one
    // item that the prayer saves; an account with no skull keeps three without it and the prayer saves a fourth (deathRisk).
    protectItem?: boolean | 'skulled';
    // Read the opponent, as a skilled player does. All off by default.
    // predictPrayer: pray against the style the opponent will use next, learnt from the order of its weapons, in place
    // of the weapon it holds now (which is its last attack, one step behind).
    predictPrayer?: boolean;
    // snapPrayer: with predictPrayer, hold the overhead for the weapon the opponent shows and change to the predicted
    // style only snapLead ticks (default 1) before its next attack is due. The opponent chooses its style from the
    // overhead it saw the tick before, so a change that late arrives with its hit and it cannot go round it.
    snapPrayer?: boolean;
    // counterRead: with predictPrayer, against an opponent that has shown two styles, predict the style our overhead
    // does not show now (see the loop). Off by default.
    counterRead?: boolean;
    // adaptStyles: learn from the overhead each attack met whether to attack with a style the opponent's overhead does
    // not show or with the one it shows (see the loop). Off by default.
    adaptStyles?: boolean;
    snapLead?: number;
    // styleByArmour: among the styles the opponent does not protect against, attack with the one its worn armour is
    // weakest to (the content's defence bonuses), in place of the fixed order.
    styleByArmour?: boolean;
    // mixStyles: choose the next style at random among the usable ones, so an opponent cannot learn the order.
    mixStyles?: boolean;
    // The seed of that random choice. A practice spar sets it from the bench seed and the fighter's place, so the same
    // seed gives the same fight; unset (live), the choice is not repeatable.
    mixSeed?: number;
    // adapt: an opponent that has hit us 6 times or more and has shown a melee weapon only cannot answer from range:
    // the loop then freezes it whenever it is free and keeps 3 tiles away while it is held.
    adapt?: boolean;
    // Bow burst: the health fraction of the target at or under which the loop spends its special energy on magic
    // shortbow specials (and a melee special between two of them, so each lands off the overhead prayer). The server
    // rolls the bow special against the ATTACKER's own ranged defence (pvp_magic_shortbow.rs2:39 calls
    // ~player_defence_roll_specific with no dot), so the loop takes its armour off and drops its Defence prayer the tick
    // before: the roll then goes against a bare 99 Defence, about 83% to hit where full rune gives about 27%. Both
    // arrows land on one tick from 3 tiles or less.
    bowBurst?: number;
    // 'keep' retains torso/legs armour and Steel Skin during bowBurst (safer in multi-way); default ('strip') drops them per pvp_magic_shortbow.rs2:39.
    bowBurstArmour?: 'strip' | 'keep';
    // Prayer flick: prayer points drain on a 5-tick timer that starts when the first prayer goes on and is cleared when
    // none is on (skill_prayer/scripts/prayer.rs2:30-43). Every 4 ticks, on a cooldown tick, the loop turns every
    // active prayer off and on again in one tick, so the timer never fires and the prayers cost no points. One tick
    // holds 5 inputs: with three prayers on, the third comes back on the next tick. false turns the flick off.
    prayerFlick?: boolean;
    // zeroDrainFlick: track prayer_drain timer start (prayer.rs2:30-43) and step down from 5 active prayers before
    // cycling off+on so overhead protection stays up at the end of every tick with zero drain.
    zeroDrainFlick?: boolean;
    // offensiveFlick: keep melee Strength/Attack prayers off during cooldown and toggle them on for melee attack ticks only.
    offensiveFlick?: boolean;
    // Ticks between two flicks (default 4). The drain timer fires 5 ticks after the prayers came on, and a bow on Rapid
    // gives one cooldown tick each 3 ticks: at 4 each second bow turn has no flick and the timer fires; at 3 it does not.
    flickEvery?: number;
    // Hold a decoy weapon of a different style during cooldown ticks, then 1-tick switch to the real weapon on the attack tick.
    fakieSwitch?: boolean | Style;
    // true: eat a carried karambwan on each tick where it costs no attack (see the loop). Default off.
    freeFood?: boolean;
    // true: pair standard food with a cooked karambwan in the same tick at or below KO burst threshold (comboAt / koComboAt).
    comboFood?: boolean;
    comboAt?: number;
    koComboAt?: number;
    // Tiles to keep from the target between turns that are not melee: on a cooldown tick the loop steps away to this
    // distance, so an opponent with a melee weapon must walk for each hit.
    standOff?: number;
    // The same step back, but only while the target is frozen and holds a melee weapon: it cannot follow, so each of
    // its turns is lost while ours land from range (clamped to <= 10 tiles so pvp_frozen never breaks).
    kiteFrozen?: number;
    // In place of the step back: stand on the same tile as a frozen target that holds a melee weapon (rsmod reached is
    // false for same-tile melee while line of sight stays true).
    stepUnderFrozen?: boolean;
    // In place of the step back: stand on a diagonal corner tile of a frozen target that holds a melee weapon. Melee reaches
    // the 4 side tiles only (RectangleBoundary.ts), so it cannot hit us there, and the bow shoots with no walk.
    diagonalFrozen?: boolean;
    // Against a target that holds a melee weapon: freezes and steps only, no hit and no special. A freeze goes out
    // whenever one can (the target is free and not immune, within 10 tiles); while the target is held the account keeps
    // this many tiles from it (at most 10: past 10 the hold breaks, pvp_magic.rs2 pvp_frozen); while it is free or
    // immune (5 ticks after a hold) the account runs straight away from it. The test of a melee attacker kept out of
    // reach for good: a melee hit needs a side tile (RectangleBoundary.ts), and each cast costs one tick stood still.
    kiteMelee?: number;
    // Any freeze goes out the way a kiteMelee freeze does: only within 10 tiles and with a line of sight to the target
    // (GameMap.ts isApproached), from a stand (a moving account stops on one tick and casts on the next), and no walk,
    // food or potion click until the hold shows or 3 ticks pass (a walk or item click clears the queued spell).
    // It loses runners (research/pvp-fight-loop.md finding 44): past 10 tiles the server walks the account in and
    // casts on arrival, a chase that costs no click.
    freezeStill?: boolean;
    fledSpec?: boolean;
    // In multi-way combat, hits from this many different players within 8 ticks start the escape (escapeWalk, glory,
    // escapeSpell) at once, whatever the food: a lone account against three cannot win (research finding 48).
    escapeOutnumbered?: number | null;
    // Our own accounts in this fight (lower case): each one within 10 tiles takes one attacker off the count of
    // escapeOutnumbered, so an account does not leave an ally that stands with it.
    allies?: readonly string[];
    // An escape that outlives one call of the loop: a harness that starts a new fight for each attacker passes the
    // same object, so an escape begun against one attacker goes on against the next.
    escapeLatch?: { outnumbered: boolean };
    // The loop only escapes: glory, escapeSpell or a run south (escapeWalk), from the first tick, whatever the food.
    flee?: boolean;
    // One freeze for a group of our accounts on one target: `clock` is a tick count they share, `at` the tick of the
    // last freeze one of them cast and `until` the tick to which it holds the target and keeps it immune (the hold,
    // then 5 ticks). An account casts no freeze before `until`, and the caster sets `until` back to now when it sees
    // the freeze splash, so the others' turns go to damage in place of casts on a held or immune target.
    // stagger: a cast blocks the others for that many ticks only, until its caster sees the hold (3 ticks after the
    // cast); then for the rest of the freeze and its immunity. Absent: the whole freeze from the cast.
    // heldUntil: the tick of `clock` to which a hold that its caster saw stops the target.
    freezeShare?: { clock: () => number; until: number; stagger?: number; heldUntil?: number };
    // While the shared freeze holds the target (freezeShare.heldUntil), every special goes as soon as it can, whatever
    // the target's health or the special reserve: the group's hits land while the target cannot run (pk-army BURST_HOLD).
    burstOnHold?: boolean;
    // always: on every freeze, not only on a target that fled.
    dropForStrip?: { free: number; minFood: number; hpAbove: number; always?: boolean };
    freezeWear?: string[];
    meleeStyle?: number;
    // One stun for a group on one target: a special that stuns (SpecConfig.stun) waits until `until - overlap` (default 1,
    // queuing push_* inside the final tick of p_delay(4) with zero eat/teleport gap). `stunnedUntil` marks when teammates burst.
    stunShare?: { clock: () => number; until: number; stunnedUntil?: number; overlap?: number };
    // Secondary stun-lock special (such as a carried Dragon spear alongside a primary DDS/bow DPS special).
    stunSpec?: SpecConfig;
    // While the target is stunned (observed shoved spotanim 254 or shared stunShare.stunnedUntil), bypass spec.below and specReserve.
    burstOnStun?: boolean;
    // The first turn of the fight is a freeze, whatever the freeze rule: a group's opening holds the target before it
    // sees itself outnumbered and runs (pk-army OPEN_FREEZE).
    openFreeze?: boolean;
    // While holdFire() is true the loop attacks and casts nothing; it walks to within 3 tiles of the target and eats
    // and prays as usual (a group's opening in one tick).
    holdFire?: () => boolean;
    holdRange?: number;
    // Skip non-fled 'low' freezes when cardinally adjacent to a standing target at or below this health fraction (so KO swings/specs land cleanly).
    freezeFloor?: number;
    // The army's volley (scripts/pk-army.ts VOLLEY=1): the first special on a target waits, attacks and all, until
    // `members` accounts stand next to the target with a special ready, or `window` ticks of `clock` after the first
    // did; then every one of them specials at once, so the hits land inside the target's eat delay. Optional `below`
    // gates joining until the target is fled, bursting, or below that health fraction.
    volley?: { state: (target: string) => VolleyState; members: number; window: number; clock: () => number; below?: number };
    // In multi-way combat, against two or more players that face us or an ally, the overhead prayer covers the style
    // most of them hold (a crowd's hits all carry the source we face, so the last hitter names no one).
    crowdPrayer?: boolean;
    // The overhead covers the weapon of the player that we face and no other (research/gang-clones.md "The prayer of the gang": in live run 3 a
    // gang account's protect prayer equals the weapon class of the account it faces in 98 of 107 swaps, and never goes to Protect from Magic).
    // The hits of another player and the crowd rule do not change it.
    facedPrayer?: boolean;
    // The ticks over which exitOnDanger's damage race is read (default 30).
    raceWindow?: number;
    // false: exitOnDanger leaves on no food, two attackers and no prayer, not on a lost damage race.
    raceExit?: boolean;
    // exitOnDanger's no-food exit waits while the target's health bar shows this fraction or lower.
    pressLow?: number;
    // exitOnDanger leaves with no food at this many times the opponent's estimated max hit or less (default 1.5).
    noFoodAt?: number;
    // Special energy kept back (0-1000) for a target that has fled or is at 30% of its health or lower (the champion
    // keeps 500: research/pvp-fight-loop.md finding 50).
    specReserve?: number;
    // Choose a style the opponent's overhead prayer does not cover (default on).
    readOverheads?: boolean;
    // false: no protect prayer over the head, whatever the opponent holds.
    overheadPrayer?: boolean;
    // The style that the threat radar wants covered when no player hits us yet (scripts/pk-threat.ts), read each tick.
    threatPrayer?: () => Style | null;
    // Ticks for which a protect prayer stays once it is on, whatever the opponent holds then (default 0: the prayer
    // follows the opponent each tick).
    overheadHold?: number;
    // A melee or ranged special with this kit and combat-tab bar once the target's health bar is at or under `below`:
    // the dragon dagger is { kit: [dagger, shield], bar: 'combat_stabsword:specbar', cost: 250, below: 0.5 }.
    spec?: SpecConfig;
    // Out of food at or under this HP: rub an inventory amulet of glory to Edgeville (amulet_of_glory.rs2 allows it up
    // to Wilderness level 30; there is no Teleblock in the content), or with no glory cast `escapeSpell` (level 20).
    escapeAt?: number;
    escapeSpell?: number;
    // false: no run after a target that flees or is out of view. An account that waits for its opponents to come to
    // it stays on its tile.
    chase?: boolean;
    // At this Wilderness level or under, the way out is a walk south over the edge of the Wilderness: no player can
    // attack a player outside it (pvp_combat.rs2:32-48). It needs no item.
    escapeWalk?: number;
    // Drink an antipoison in the first tick after the poison shows (default), though the drink can cost a tick of the next
    // attack. false: the loop waits for a tick with 3 ticks to the next attack, and turns back to back give none.
    cureNow?: boolean;
    // The wait of a protect prayer change, as weights of 0, 1, 2 ... ticks: [48, 35, 11, 5] waits 1 tick in 35 of 99
    // changes. The bench gang gets the wait that the world feed shows the dagger gang has (research/pvp-fight-loop.md,
    // "The gang in a long fight").
    prayerLag?: number[];
    // With chase false: run after a target that flees while its health bar is at or under this fraction.
    chaseBelow?: number;
    // Cut off a target that flees: the chase runs to the tile `cutOff` tiles ahead of it along its heading, not to its
    // own tile, and starts at 2 tiles, not 6. A runner that walks south to the edge of the Wilderness then walks into
    // our reach in place of away from it. Unset: the chase runs to the target's tile.
    cutOff?: number;
    // scripts/pk-gang.ts only: an account of the gang in view with its health bar at or under this fraction becomes the
    // target as soon as the single-way rule lets our attack through (the last player to hit us is that account, or
    // none has hit us for 8 ticks, pvp_combat.rs2:110). Unset: the target is the account that hit us last.
    focusRunner?: number;
    // Return outcome "danger" (with the reason) as soon as dangerReason fires, so the caller can escape.
    exitOnDanger?: boolean;
    damageSpell?: number;
    // Cast Charge before the first attack and again when it fades. With a god staff and that god's cape worn, a god
    // spell then hits up to 30, not 20 (pvp/spells/scripts/flames_of_zamorak.rs2:27; Charge needs Magic 80, 3 fire,
    // 3 blood and 3 air runes, and the Mage Arena done, skill_magic/scripts/spells/charge.rs2).
    charge?: boolean;
    // Trigger Dragon Battleaxe (1377) combat_axe:specbar Strength warcry self-buff when carrying 1377 at 100% energy
    // (specwep.rs2:61-78 drains Attack/Defence/Ranged/Magic by 10% and boosts Strength by 10 + sum/4).
    // 'restore' also prioritizes super restore/attack potion after buffing to recover drained combat stats.
    battleaxeBuff?: boolean | 'restore';
    maxWild?: number;
    maxDistance?: number;
    stop?: () => boolean;
    cap?: number;
    log?: (line: string) => void;
};
export type FightResult = { outcome: 'kill' | 'died' | 'escaped' | 'lost' | 'timeout' | 'danger' | 'session ended'; danger?: string; ticks: number; dealt: number; taken: number; eaten: number; attacks: Record<Style, number>; freezes: number; specs: number; flicks?: number; prayerLeft?: number; targetAt?: { x: number; z: number };
    // The file of the kill receipt (packages/core/src/kill-receipt.ts), on a kill with a written receipt.
    receipt?: string };

// Overhead protect prayers from the head icon bits (content player/configs/headicon.constant: 3 melee, 4 missiles, 5 magic).
export function protectedStyles(headicons: number | undefined): Set<Style> {
    const bits = headicons ?? 0, out = new Set<Style>();
    if (bits & (1 << 3)) out.add('melee');
    if (bits & (1 << 4)) out.add('ranged');
    if (bits & (1 << 5)) out.add('magic');
    return out;
}
export const skulled = (headicons: number | undefined) => ((headicons ?? 0) & 1) !== 0;
// The death line's skull fields: the skull and what the death costs, read on the last tick that the account was alive (the
// client clears the skull at the death itself), as ` skull=1 keeps=0 lost=420 lostValue=190000`. Empty when the client
// showed no local player. The bait test reads it: an account hit first keeps no skull and keeps its 3 dearest items.
export const deathSkullFields = (view: { skull: boolean | null; units: readonly { id: number; count: number }[]; protect: boolean } | null, cost: (id: number) => number): string => {
    if (!view || view.skull === null) return '';
    const risk = deathRisk(view.units, cost, view.skull, view.protect);
    return ` skull=${view.skull ? 1 : 0} keeps=${risk.kept.length} lost=${risk.lostUnits} lostValue=${risk.lostValue}`;
};
// Our own skull: the head icon of the client's local player. Null when the client shows no local player (a test double).
export const ownSkull = (client: unknown): boolean | null => {
    const local = (client as { localPlayer?: { headicons?: number } } | undefined)?.localPlayer;
    return local ? skulled(local.headicons) : null;
};
// What a death to a player in the Wilderness keeps and loses (content death.rs2 pvp_death_lose_items and
// move_priciest_item_on_hero_to_death): an account with no skull keeps its 3 dearest items, Protect Item keeps 1 more, and a
// skulled account keeps only that one. Each keep takes one unit of the item with the highest content cost (items with a cost of
// 0 are never kept). `cost` gives the content cost of an item id (knowledge/items.json). `units` are the pack and the worn items.
export function deathRisk(units: readonly { id: number; count: number }[], cost: (id: number) => number, skull: boolean, protect: boolean): { keeps: number; kept: number[]; keptValue: number; lostValue: number; lostUnits: number } {
    const left = new Map<number, number>();
    for (const u of units) if (u.count > 0) left.set(u.id, (left.get(u.id) ?? 0) + u.count);
    const keeps = (skull ? 0 : 3) + (protect ? 1 : 0), kept: number[] = [];
    for (let i = 0; i < keeps; i++) {
        let best: number | undefined;
        for (const id of left.keys()) if (cost(id) > (best === undefined ? 0 : cost(best))) best = id;
        if (best === undefined) break;
        kept.push(best);
        left.set(best, left.get(best)! - 1);
        if (left.get(best) === 0) left.delete(best);
    }
    let lostValue = 0, lostUnits = 0;
    for (const [id, n] of left) { lostValue += cost(id) * n; lostUnits += n; }
    return { keeps, kept, keptValue: kept.reduce((n, id) => n + cost(id), 0), lostValue, lostUnits };
}
let costTable: Map<number, number> | undefined;
// The content cost of an item (knowledge/items.json). 0 for an item that the file does not know.
export const itemCostOf = (id: number): number => (costTable ??= new Map((JSON.parse(readFileSync(join(resolve(import.meta.dir, '..'), 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[]).map(i => [i.id, i.cost ?? 0]))).get(id) ?? 0;

// The style a worn weapon attacks with, from its object name (content pack/obj.pack). No weapon is melee (fists).
let objNames: Map<number, string> | undefined;
export const getObjNames = () => (objNames ??= new Map(readFileSync(join(resolve(import.meta.dir, '..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8')
    .split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; })));
// The style of a weapon by its name: a bow or a thrown weapon is ranged, a staff magic. The simulator
// (scripts/pk-sim.ts) and the prayer guard use the same rule (packages/core/src/opponent.ts).
export function styleOfName(name: string): Style {
    return weaponNameStyle(name);
}
export function weaponStyle(id: number | undefined, names = getObjNames()): Style {
    return styleOfName(id !== undefined && id >= 0 ? names.get(id) ?? '' : '');
}
const PROTECT_FROM: Record<Style, number> = { melee: 14, ranged: 13, magic: 12 };

export const isDragonSpearName = (name: string) => /^dragon_spear(_p)?$|^tbwt_dragon_spear_kp$/.test(name);
export const OFFENSIVE_MELEE_PRAYERS: readonly number[] = [
    PRAYER.ultimateStrength, PRAYER.incredibleReflexes,
    PRAYER.superhumanStrength, PRAYER.improvedReflexes,
    PRAYER.burstOfStrength, PRAYER.clarityOfThought,
];
const isOverheadPrayer = (p: number) => p >= PRAYER.magic && p <= PRAYER.melee;

// Prayers for the current combat state (player_combat_stat.rs2:33-35, 62-67): Protect Item, the best Defence prayer
// (boosts melee, ranged and 30% of magic defence), the overhead for the opponent's weapon, and on melee/spec turns the
// best Strength and Attack prayers (+15% max hit and accuracy at 31/34), turned off on non-melee turns to save drain.
export function combatPrayers(prayerBase: number, overhead: number | null, meleeTurn: boolean, defence = true, item = true): { want: number[]; off: number[] } {
    const want: number[] = [], off: number[] = [];
    if (prayerBase >= PRAYER_REQ[PRAYER.item]!) (item ? want : off).push(PRAYER.item);
    const def = prayerBase >= 28 ? PRAYER.steelSkin : prayerBase >= 10 ? PRAYER.rockSkin : prayerBase >= 1 ? PRAYER.thickSkin : null;
    if (def !== null) (defence ? want : off).push(def);
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

export type PrayerPlanInput = {
    now: number;
    nextAttack: number;
    lastAttackAt: number;
    walkingToMelee: boolean;
    prayerBase: number;
    overhead: number | null;
    activePrayers: readonly boolean[];
    prayerDrainAt: number;
    flickAt: number;
    flickEvery: number;
    zeroDrainFlick: boolean;
    prayerFlick: boolean;
    offensiveFlick: boolean;
    upcomingStyle: Style | null;
    specMeleeLikely: boolean;
    defencePrayer: boolean;
    protectItem: boolean;
    budget: number;
    // Packets for prayer set-up when no flick is due. Unset: `budget`. A caller lowers it to keep packets of the same
    // tick for a step or a style setting; a due flick still uses `budget`.
    setupBudget?: number;
};
export type PrayerPlanResult = { toggles: number[]; didFlick: boolean; nextDrainAt: number; nextFlickAt: number };

const keepPrayerPriority = (p: number, overhead: number | null) =>
    p === overhead || isOverheadPrayer(p) ? 3
        : (p === PRAYER.steelSkin || p === PRAYER.rockSkin || p === PRAYER.thickSkin) ? 2
        : p === PRAYER.item ? 1
        : 0;

// Plan prayer toggles during cooldown ticks under rev 289's 5-tick prayer_drain timer (prayer.rs2:30-43).
export function planPrayerTick(input: PrayerPlanInput): PrayerPlanResult {
    const {
        now, nextAttack, lastAttackAt, walkingToMelee, prayerBase, overhead,
        activePrayers, prayerDrainAt, flickAt, flickEvery, zeroDrainFlick,
        prayerFlick, offensiveFlick, upcomingStyle, specMeleeLikely, defencePrayer, protectItem, budget,
    } = input;
    const sim = [...activePrayers];
    let drainAt = sim.some(Boolean) ? (prayerDrainAt >= 0 ? prayerDrainAt : now) : -1;
    const apply = (p: number) => {
        const had = sim.some(Boolean);
        sim[p] = !sim[p];
        const has = sim.some(Boolean);
        if (!has) drainAt = -1;
        else if (!had && has) drainAt = now;
    };
    const active = sim.flatMap((on, p) => (on ? [p] : []));
    const flickAllowed = (zeroDrainFlick || prayerFlick) && !walkingToMelee && active.length > 0;
    const elapsed = zeroDrainFlick ? (drainAt >= 0 ? now - drainAt : 0) : now - flickAt;
    const canFlickWindow = now < nextAttack - 1;
    const maxFlick = Math.floor(budget / 2);

    if (flickAllowed && canFlickWindow && budget >= 2) {
        // Under zeroDrainFlick, never truncate an off+on cycle (active * 2 <= budget); step down lowest-priority
        // prayers (offensive -> item) when >= 2 ticks remain before nextAttack so nextAttack - 1 stays free to buff.
        if (zeroDrainFlick && active.length > maxFlick && elapsed >= Math.max(1, flickEvery - 1) && now <= nextAttack - 3) {
            const toDrop = active
                .filter(p => p !== overhead && !isOverheadPrayer(p) && p !== PRAYER.steelSkin && p !== PRAYER.rockSkin && p !== PRAYER.thickSkin)
                .sort((a, b) => keepPrayerPriority(a, overhead) - keepPrayerPriority(b, overhead))
                .slice(0, Math.min(budget, active.length - maxFlick));
            if (toDrop.length > 0) {
                for (const p of toDrop) apply(p);
                return { toggles: toDrop, didFlick: false, nextDrainAt: drainAt, nextFlickAt: flickAt };
            }
        }
        const due = zeroDrainFlick
            ? (elapsed >= flickEvery || (now === nextAttack - 2 && elapsed >= Math.max(1, flickEvery - 1)))
            : elapsed >= flickEvery;
        const canCycle = zeroDrainFlick ? active.length <= maxFlick : active.length < budget;
        if (due && canCycle) {
            const order = [...active].sort((a, b) => keepPrayerPriority(b, overhead) - keepPrayerPriority(a, overhead));
            const toggles = zeroDrainFlick
                ? [...order, ...order]
                : [...order, ...order.slice(0, budget - order.length)];
            for (const p of toggles) apply(p);
            return { toggles, didFlick: true, nextDrainAt: drainAt, nextFlickAt: now };
        }
    }

    const toggles: number[] = [], setupBudget = Math.min(budget, input.setupBudget ?? budget);
    if (setupBudget > 0) {
        const nextIsMelee = now === nextAttack - 1 && (upcomingStyle === 'melee' || specMeleeLikely);
        const { want, off } = combatPrayers(prayerBase, overhead, nextIsMelee, defencePrayer, protectItem);
        const dropOffensive = offensiveFlick && now < nextAttack - 1 && (now === lastAttackAt + 1 || !nextIsMelee);
        const dropSet = dropOffensive ? new Set([...off, ...OFFENSIVE_MELEE_PRAYERS]) : new Set(off);
        // Priority order on activation: keep overhead active first, then non-overhead boosts.
        const prioritizedWant = [...want].sort((a, b) => keepPrayerPriority(b, overhead) - keepPrayerPriority(a, overhead));
        let rem = setupBudget;
        for (const p of prioritizedWant) {
            if (!sim[p] && rem > 0) { toggles.push(p); apply(p); rem--; }
        }
        for (const p of dropSet) {
            if (sim[p] && rem > 0) { toggles.push(p); apply(p); rem--; }
        }
    }
    return { toggles, didFlick: false, nextDrainAt: drainAt, nextFlickAt: flickAt };
}

// Ticks to cover `tiles` steps of a melee approach. A running tick covers two tiles and costs at most 134 energy units
// (the clamped weight limit); under 100 units the account walks, and a walked tick gives back 8 units at Agility 1.
// `runEnergy` is the reported percent, so its 100 units are the lower bound. A last single tile is a walked tick.
// Unknown energy counts as none: the walking time is the bound that is never too short.
export function meleeApproachTicks(tiles: number, runEnergy: number | undefined): number {
    let left = Math.max(0, tiles), ticks = 0;
    let units = typeof runEnergy === 'number' && Number.isFinite(runEnergy) ? Math.max(0, Math.min(100, runEnergy)) * 100 : 0;
    let running = units >= 100;
    while (left > 0) {
        const steps = Math.min(left, running ? 2 : 1);
        left -= steps;
        ticks++;
        units = steps === 2 ? Math.max(0, units - 134) : Math.min(10000, units + 8);
        if (units < 100) running = false;
    }
    return ticks;
}

export function shouldComboEat(opts: {
    hp: number; maxHp: number; oppMax: number; eatAt: number;
    comboFood?: boolean; comboAt?: number; koComboAt?: number;
    recentDamage?: number; oppSpecThreat?: boolean;
}): boolean {
    if (opts.comboFood === false || opts.hp >= opts.maxHp) return false;
    // Limit tbwt_cooked_karambwan (p_delay(2) suspension) strictly to surviving lethal KO bursts unless explicitly configured.
    const koBase = opts.koComboAt ?? (opts.oppSpecThreat ? Math.min(opts.eatAt, opts.oppMax + 8) : opts.oppMax);
    const limit = opts.comboFood
        ? (opts.comboAt !== undefined ? Math.max(opts.comboAt, koBase) : Math.min(opts.eatAt, Math.max(18, koBase)))
        : koBase;
    return opts.hp <= limit || (opts.comboFood === true && (opts.recentDamage ?? 0) >= opts.hp && opts.hp <= opts.eatAt);
}

export function pickFakieWeapon(opts: {
    kit: Kit;
    realStyle: Style;
    preferred?: boolean | Style;
    inventory: readonly { id: number; slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[];
    equipment: readonly { id: number; slot: number }[];
    names?: Map<number, string>;
}): { id: number; slot: number; style: Style; opIndex: number } | null {
    if (!opts.preferred) return null;
    const names = opts.names ?? getObjNames();
    const wornWeapon = opts.equipment.find(e => e.slot === 3);
    const hasShield = opts.equipment.some(e => e.slot === 5);
    const wornStyle = wornWeapon ? weaponStyle(wornWeapon.id, names) : null;
    // Skip redundant equip if already holding the requested decoy (or any off-style weapon when fakieSwitch is boolean).
    if (typeof opts.preferred === 'string' && opts.preferred !== opts.realStyle) {
        if (wornStyle === opts.preferred) return null;
    } else if (wornStyle && wornStyle !== opts.realStyle) return null;
    const order: Style[] = typeof opts.preferred === 'string' && opts.preferred !== opts.realStyle
        ? [opts.preferred, ...(['melee', 'ranged', 'magic'] as Style[]).filter(s => s !== opts.preferred && s !== opts.realStyle)]
        : (['melee', 'magic', 'ranged'] as Style[]).filter(s => s !== opts.realStyle);
    for (const st of order) {
        const ids = opts.kit[st] ?? [];
        if (!ids.length) continue;
        // Skip equipping a 2H bow/spear decoy when a shield is worn and the pack has no free slot.
        if (hasShield && opts.inventory.length >= 28 && (st === 'ranged' || ids.some(id => isDragonSpearName(names.get(id) ?? '')))) continue;
        for (const id of ids) {
            if (opts.equipment.some(e => e.id === id)) continue;
            const n = names.get(id) ?? '';
            if (/(kiteshield|sq_shield|shield|arrow|bolt)$/.test(n)) continue;
            const item = opts.inventory.find(i => i.id === id);
            const op = item?.optionsWithIndex.find(x => /^(Wield|Wear)$/i.test(x.text));
            if (item && op) return { id, slot: item.slot, style: st, opIndex: op.opIndex };
        }
    }
    return null;
}

// SAFETY: the chain of the rune throwing axe special picks its next target with huntall(origin, 3, line of sight) around the THROWER, excluding only the earlier targets
// and the thrower (pvp_rune_thrownaxe.rs2 pvp_rune_thrownaxe_hunt), so any player within 3 tiles of the thrower that is attackable is a chain target: in a stacked squad
// the special hits our own members. The special is refused when an ally stands within `AXE_ALLY_RANGE` tiles of us (one more than the server's 3, for a move in the tick).
export const AXE_ALLY_RANGE = 4;
export const thrownAxeHitsAlly = (spec: { kit: readonly number[] } | undefined, nearby: readonly { name: string; distance: number }[], allies: readonly string[] | undefined, names: ReadonlyMap<number, string>) =>
    !!spec && !!allies?.length && spec.kit.some(id => names.get(id) === 'rune_thrownaxe') && nearby.some(p => p.distance <= AXE_ALLY_RANGE && allies.includes(p.name.toLowerCase()));

// Default special-attack config from a staged kit (content specwep=true: dragon dagger 25%, longsword 25%, mace 25%,
// rune claws 25%, magic shortbow 35% in bows.obj:343, dragon spear/_p/kp 25%).
export function defaultSpec(kit: Kit, names = getObjNames()): SpecConfig | undefined {
    // A kit that carries rune throwing axes uses their special: it chains from the target to up to 4 more players within 3
    // tiles when our account and each target stand in multi-way combat (pvp_rune_thrownaxe.rs2 pvp_rune_thrownaxe_hunt),
    // each hit a ranged roll with +10 Ranged levels, and costs 10% (sa_energy 100). It replaces the melee special: a fight
    // has one special config. The kit option is a thrown axe stack among `ranged` (scripts/pk-kits.ts).
    const axe = (kit.ranged ?? []).find(id => names.get(id) === 'rune_thrownaxe');
    if (axe !== undefined) return { kit: [axe], bar: 'combat_thrown:specbar', cost: 100, below: 1, style: 'ranged' };
    for (const id of kit.melee ?? []) {
        const n = names.get(id) ?? '';
        if (/^dragon_dagger/.test(n)) return { kit: kit.melee!, bar: 'combat_stabsword:specbar', cost: 250, below: 0.65, style: 'melee' };
        if (n === 'dragon_longsword') return { kit: kit.melee!, bar: 'combat_hacksword:specbar', cost: 250, below: 0.6, style: 'melee' };
        if (n === 'dragon_mace') return { kit: kit.melee!, bar: 'combat_spiked:specbar', cost: 250, below: 0.6, style: 'melee' };
        // The halberd is a weapon_polearm (polearms.obj): its tab is combat_polearm.
        if (n === 'dragon_halberd') return { kit: kit.melee!, bar: 'combat_polearm:specbar', cost: 300, below: 0.6, style: 'melee' };
        if (n === 'rune_claws') return { kit: kit.melee!, bar: 'combat_claw:specbar', cost: 250, below: 0.6, style: 'melee' };
        // The dragon spear's special does no damage: it holds the target 5 ticks with no input (pvp_dragon_spear.rs2
        // p_delay(4)), so it cannot eat or change its prayer: it goes out when the target is low enough to want food.
        if (isDragonSpearName(n)) return { kit: [id], bar: 'combat_spear:specbar', cost: 250, below: 0.55, style: 'melee', stun: 4 };
    }
    return bowSpec(kit, names);
}
// Carried dragon spear secondary stun spec for kits whose primary spec weapon is a DPS weapon (e.g. DDS + dragon spear).
export function defaultStunSpec(kit: Kit, names = getObjNames()): SpecConfig | undefined {
    for (const id of kit.melee ?? []) {
        if (isDragonSpearName(names.get(id) ?? '')) return { kit: [id], bar: 'combat_spear:specbar', cost: 250, below: 0.55, style: 'melee', stun: 4 };
    }
    return undefined;
}
// The magic shortbow special of a kit: the burst against a target out of melee reach.
// A weapon's reach in tiles from knowledge/gear.json (param attackrange: magic shortbow 7, magic longbow 10).
let gearRange: Map<string, number> | undefined;
export function weaponRange(id: number, names = getObjNames()): number | undefined {
    gearRange ??= new Map((JSON.parse(readFileSync(join(resolve(import.meta.dir, '..'), 'knowledge', 'gear.json'), 'utf8')) as { debugname: string; attackRange?: number }[])
        .filter(g => g.attackRange).map(g => [g.debugname, g.attackRange!]));
    return gearRange.get(names.get(id) ?? '');
}
// The bow special: the magic longbow's when the kit carries one (pvp_magic_longbow.rs2: no hit roll, +10 Ranged levels
// to its max hit, 10 tiles), else the magic shortbow's (two arrows, accuracy x10/7, 7 tiles). Both cost 35%.
export function bowSpec(kit: Kit, names = getObjNames()): SpecConfig | undefined {
    const ids = kit.ranged ?? [];
    const bow = ids.find(id => names.get(id) === 'magic_longbow') ?? ids.find(id => names.get(id) === 'magic_shortbow');
    return bow === undefined ? undefined : { kit: [bow], bar: 'combat_bow:specbar', cost: 350, below: 0.5, style: 'ranged' };
}
// A turn's ranged weapons: the magic shortbow when the kit carries it with the longbow (4 ticks, 3 on rapid, against
// the longbow's 6); the longbow is the special's.
export function shootingKit(kit: Kit, names = getObjNames()): number[] {
    // The thrown axe is the special's weapon only: a plain turn with it would be a slow throw (attack rate 5).
    const ids = (kit.ranged ?? []).filter(id => names.get(id) !== 'rune_thrownaxe');
    return ids.some(id => names.get(id) === 'magic_shortbow') ? ids.filter(id => names.get(id) !== 'magic_longbow') : ids;
}

// Metal/leather armour pieces that penalize a magic or ranged attack roll on the cast/shot tick (kiteshields.obj,
// platebodies.obj, platelegs.obj, full_helms.obj, leather_gear.obj). Ordered by largest penalty first (torso -30,
// legs -21, shield -8, helm -6); unequipped on the attack tick before the hit roll and re-equipped on the next tick.
export function negativeCastArmour(worn: readonly { id: number; slot: number }[], style: Style, kitIds: ReadonlySet<number>, names = getObjNames()): { id: number; slot: number }[] {
    if (style === 'melee') return [];
    // Each worn item's own penalty to this attack (knowledge/gear.json magicAttack or rangeAttack), the largest first:
    // the vambraces' -10 magic counts as the plate's does. The weapon and shield of the turn's kit stay.
    const key = style === 'magic' ? 'magicAttack' : 'rangeAttack';
    return worn.map(e => ({ id: e.id, slot: e.slot, p: gearBonus(e.id, key, names) }))
        .filter(e => !kitIds.has(e.id) && e.p < 0)
        .sort((a, b) => a.p - b.p || a.slot - b.slot)
        .map(e => ({ id: e.id, slot: e.slot }));
}
let gearBonuses: Map<string, Record<string, number>> | undefined;
export function gearBonus(id: number, bonus: string, names = getObjNames()): number {
    gearBonuses ??= new Map((JSON.parse(readFileSync(join(resolve(import.meta.dir, '..'), 'knowledge', 'gear.json'), 'utf8')) as { debugname: string; bonuses: Record<string, number> }[]).map(g => [g.debugname, g.bonuses]));
    return gearBonuses.get(names.get(id) ?? '')?.[bonus] ?? 0;
}

// Another player's head icons and worn items, read from the in-process client's player entity (webclient
// dash3d/ClientPlayer.ts headicons, appearance: a part at 512 or more is an object id + 512). The SDK state leaves them
// out, and reading them here keeps the swarm's launch release unchanged.
// Its health bar (ClientEntity health, totalHealth) holds the values of the last hit it took.
// spotanim: the graphic on the player, -1 for none. A hold spell that lands shows its impact on its target in the tick
// the server casts it (entangle_impact 179, snare_impact 180, bind_impact 181), and one that splashes
// failedspell_impact (85) (pvp_magic.rs2, magic_combat_spells.dbrow, pack/spotanim.pack).
export type Observed = { headicons: number; worn: number[]; health: number; totalHealth: number; spotanim: number };
export const HOLD_IMPACT: readonly number[] = [179, 180, 181], SPLASH_IMPACT = 85;
// spotanim.pack:255 stunned_shove, applied by pvp_dragon_spear.rs2 on stun impact.
export const STUNNED_SHOVE_SPOTANIM = 254;
// The hold spell of each impact graphic (magic_combat_spells.dbrow spotanim_target): its freeze_time sets the hold.
export const IMPACT_SPELL: Readonly<Record<number, number>> = { 179: SPELLS.entangle, 180: SPELLS.snare, 181: SPELLS.bind };
export function observePlayer(client: unknown, index: number): Observed | null {
    const p = (client as { players?: ({ headicons?: number; appearance?: ArrayLike<number>; health?: number; totalHealth?: number; spotanimId?: number } | null)[] } | undefined)?.players?.[index];
    if (!p) return null;
    return { headicons: p.headicons ?? 0, worn: Array.from(p.appearance ?? [], part => (part >= 512 ? part - 512 : -1)), health: p.health ?? 0, totalHealth: p.totalHealth ?? 0, spotanim: p.spotanimId ?? -1 };
}
// Special attack energy (0-1000) and the bar's on state, client vars 300 and 301 (scripts/microbot-c-qol.ts enableSpecial).
const special = (client: unknown) => { const v = (client as { var?: number[] } | undefined)?.var; return { energy: v?.[300] ?? 0, on: v?.[301] === 1 }; };
// A health bar at or under the fraction, from a hit that showed one.
// A fraction of 1 or more holds at any health, also before the target's health bar shows (its first hit).
export const lowHealth = (seen: Observed | null, fraction: number) => !!seen && (fraction >= 1 || (seen.totalHealth > 0 && seen.health / seen.totalHealth <= fraction));
// After a fight: wear again the armour that the account wore at the start and that now sits in the pack with its slot empty. A freeze strips the platelegs, the full
// helm and other pieces for the cast, and `tankIds` that wears them again lives in one fight: the next fight's set holds only the plate and chain bodies, so
// the legs and the helm stayed in the pack for the rest of the run (run 3: members fought without them after a freeze). The weapon and the shield are not
// touched: the fight loop picks the weapon, and wearing a shield would unwield a two-handed weapon. Returns the pieces that it wore.
const ARMOUR_SLOT: Record<string, number> = { hat: 0, back: 1, torso: 4, legs: 7, hands: 9, feet: 10 };
let gearSlots: Map<number, string> | undefined;
export async function rewearStart(s: Session, start: readonly number[], log: (line: string) => void = () => {}, tick: () => Promise<boolean> = () => nextTick(s)): Promise<number> {
    gearSlots ??= new Map(loadGear().map(g => [g.id, g.slot]));
    let n = 0;
    for (const id of start) {
        const slot = ARMOUR_SLOT[gearSlots.get(id) ?? ''];
        if (slot === undefined || (s.sdk.getState()?.equipment ?? []).some(e => e.slot === slot)) continue;
        const item = s.sdk.getInventory().find(i => i.id === id), op = item?.optionsWithIndex?.find(x => /^(wear|wield)$/i.test(x.text));
        if (!item || !op) continue;
        await s.sdk.sendUseItem(item.slot, op.opIndex);
        n++;
        if (!await tick()) break;
    }
    if (n) log(`PK wore ${n} piece${n === 1 ? '' : 's'} of the starting armour again`);
    return n;
}

// Poison. The server prints "You have been poisoned!" only when the poison was at 0 (poison.rs2 poison_player), so a poison that carries into the next fight, or one that is
// renewed while it runs, gives no message. Its damage is a hitsplat of type hitmark_poison (2, hitmark.constant), which the client keeps for the own player
// (ClientEntity damageTypes): poisonSplat reads it. A hit comes each 30 ticks (the poison timer), so the state holds POISON_HOLD ticks after its last sign and is
// carried between fights of one account (poisonCarry). The client shows a hitsplat for 70 cycles (ClientEntity.ts: damageCycles = loopCycle + 70), about 2.3 ticks, so one
// splat is on screen for 3 ticks: a splat counts once, by its end cycle (poisonSplat returns it), or a cure on the first tick would be undone by the same splat on the next.
export const POISON_HITMARK = 2, POISON_HOLD = 40;
export function poisonSplat(client: unknown): number {
    const c = client as { localPlayer?: { damageTypes?: ArrayLike<number>; damageCycles?: ArrayLike<number> }; getClientCycle?: () => number } | undefined;
    const p = c?.localPlayer;
    if (!p?.damageTypes || !p.damageCycles || typeof c?.getClientCycle !== 'function') return 0;
    const cycle = c.getClientCycle();
    let end = 0;
    for (let i = 0; i < 4; i++) if (p.damageTypes[i] === POISON_HITMARK && (p.damageCycles[i] ?? 0) > cycle) end = Math.max(end, p.damageCycles[i]!);
    return end;
}
export const ownPoisonHit = (client: unknown): boolean => poisonSplat(client) > 0;
const poisonCarry = new WeakMap<object, { poisoned: boolean; seenAt: number; splat: number }>();
export const carriedPoison = (client: unknown, now: number): boolean => { const c = typeof client === 'object' && client ? poisonCarry.get(client) : undefined; return !!c && c.poisoned && now - c.seenAt <= POISON_HOLD; };
// The end cycle of the last splat that a fight used, so that the next fight does not count it again.
export const carriedSplat = (client: unknown): number => (typeof client === 'object' && client ? poisonCarry.get(client)?.splat ?? 0 : 0);
export function noteFightPoison(client: unknown, poisoned: boolean, seenAt: number, splat = 0): void { if (typeof client === 'object' && client) poisonCarry.set(client, { poisoned, seenAt, splat }); }

// The reasons that let a special go, for its log line: the flee state, the bow burst, the volley, the stun chain, a health bar under the weapon's threshold.
export const specReasons = (r: { fled: boolean; bursting: boolean; volleying: boolean; chainStun: boolean; low: boolean }) =>
    ([['fled', r.fled], ['burst', r.bursting], ['volley', r.volleying], ['chain', r.chainStun], ['low', r.low]] as const).filter(([, on]) => on).map(([name]) => name).join('+') || 'none';
// The flee state ends when the flee hold (6 ticks after the last step away) has run out, no freeze holds the target and it stands within 2 tiles of us.
export const fledEnds = (fled: boolean, gap: number, now: number, fleeingUntil: number, frozenUntil: number) => fled && gap <= 2 && now >= fleeingUntil && now >= frozenUntil;

// A health bar at 0 (a hit that showed one, and the target has no Hitpoints left): the target is dying. lowHealth is true there, so without this guard a special
// attack, a freeze or a bind goes into a target that is already dead (run 3: about 40 specials and many binds).
export const isDying = (seen: Observed | null) => !!seen && seen.totalHealth > 0 && seen.health <= 0;

// The new hit splats on another player since the last call, read from the client's player entity (ClientEntity
// damageCycles and damageValues, four slots). The SDK publishes a damage_dealt event only while our player faces the
// target at the tick the splat shows (bot/StateCollector.ts), so an arrow or a spell that lands after a gear switch is
// not counted: one spar read 102 dealt where the other side took 274. `seen` holds the cycle of each slot; the first
// call only records them. Null when the client shows no splat data for the player.
export function newSplats(client: unknown, index: number, seen: { cycles: number[] | null }): number[] | null {
    const p = (client as { players?: ({ damageCycles?: ArrayLike<number>; damageValues?: ArrayLike<number> } | null)[] } | undefined)?.players?.[index];
    if (!p?.damageCycles || !p.damageValues) return null;
    const cycles = Array.from({ length: 4 }, (_, j) => p.damageCycles![j] ?? 0);
    const out = seen.cycles ? cycles.flatMap((cycle, j) => (cycle > 0 && cycle > seen.cycles![j]! ? [p.damageValues![j] ?? 0] : [])) : [];
    seen.cycles = cycles;
    return out;
}
// Bodies the game lets only a Dragon Slayer finisher wear (levelrequire.rs2:94-101).
const DRAGON_SLAYER_BODY = /^(rune_platebody|dragonhide_body)/;

// The killer's message for a PvP death is in packages/core/src/kill-receipt.ts, which also reads the receipts.
export { killMessage };
// Adds the items that a pickup took after a kill to the receipt of that kill. `picked` maps an object id to its count
// (scripts/pk-gang.ts pickUp). A fight with no receipt changes nothing.
export function recordKillLoot(r: Pick<FightResult, 'receipt'>, picked: Record<string, number>, names = getObjNames()): void {
    if (!r.receipt) return;
    try { amendKillReceipt(r.receipt, { loot: Object.entries(picked).map(([id, count]) => ({ id: Number(id), name: names.get(Number(id)), count })) }); }
    catch (e) { console.error(`[pk] kill receipt loot update failed: ${String(e)}`); }
}
// The items that a pack gained between two reads, by object id: the loot of a pickup that reports no items.
export function packGain(before: readonly { id: number; count: number }[], after: readonly { id: number; count: number }[]): Record<string, number> {
    const had = new Map<number, number>(), gain: Record<string, number> = {};
    for (const i of before) had.set(i.id, (had.get(i.id) ?? 0) + i.count);
    const has = new Map<number, number>();
    for (const i of after) has.set(i.id, (has.get(i.id) ?? 0) + i.count);
    for (const [id, n] of has) if (n > (had.get(id) ?? 0)) gain[id] = n - (had.get(id) ?? 0);
    return gain;
}

// Attack delays in ticks: dragon dagger/scimitar/claws 4, longsword/mace 5, magic shortbow 4 (3 on rapid, 4 on spec per pvp_special_attack.rs2:35), spells 5.
const TURN: Record<Style, number> = { magic: 5, ranged: 4, melee: 4 };
// A thrown weapon attacks each 3 ticks, each 2 on Rapid (knives.obj, darts.obj attackrate 3); a shortbow each 4, each 3 on Rapid.
export const rangedWeaponDelay = (ids: readonly number[] | undefined, rapid: boolean, names = getObjNames()) =>
    ((ids ?? []).some(id => /_(knife|dart)(_p)?$/.test(names.get(id) ?? '')) ? 3 : TURN.ranged) - (rapid ? 1 : 0);
export const meleeWeaponDelay = (ids: readonly number[] | undefined, names = getObjNames()) => {
    let maxDelay = 4;
    for (const id of ids ?? []) {
        const n = names.get(id) ?? '';
        if (/(2h_sword|halberd)/.test(n)) maxDelay = Math.max(maxDelay, 7);
        else if (/(spear|battleaxe|warhammer)/.test(n)) maxDelay = Math.max(maxDelay, 6);
        else if (/(longsword|mace)/.test(n)) maxDelay = Math.max(maxDelay, 5);
    }
    return maxDelay;
};

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
    hits: readonly { tick: number; damage: number; src: number }[]; dealt: readonly { tick: number; damage: number }[]; now: number; window?: number; race?: boolean; noFoodAt?: number }): string | null {
    if (!o.food && o.hp <= o.oppMax * (o.noFoodAt ?? 1.5)) return `no food at HP ${o.hp}`;
    // A hit's source is the entity the player faced (StateCollector); -1 is no one, not a second player.
    const attackers = new Set(o.hits.filter(h => o.now - h.tick <= 10 && h.src >= 0).map(h => h.src));
    if (attackers.size >= 2) return `${attackers.size} players hitting`;
    // The race over the last `window` ticks (default 30).
    const window = o.window ?? 30;
    const taken = o.hits.filter(h => o.now - h.tick <= window).reduce((n, h) => n + h.damage, 0);
    const dealt = o.dealt.filter(h => o.now - h.tick <= window).reduce((n, h) => n + h.damage, 0);
    if (o.race !== false && taken >= 30 && taken >= 2 * dealt && o.hp < o.maxHp * 0.6) return `losing the race: took ${taken}, dealt ${dealt}`;
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

// Multi-combat zones: maps/multiway.csv lists 8x8 zones as level_mapX_mapZ_localX_localZ (engine GameMap.loadCsvMap).
let multi: Set<string> | undefined;
export function isMulti(x: number, z: number, root = resolve(import.meta.dir, '..')): boolean {
    if (!multi) {
        multi = new Set();
        try {
            for (const line of readFileSync(join(root, 'vendor/rs-sdk/server/content/maps/multiway.csv'), 'ascii').split(/\r?\n/)) {
                if (!line || line.startsWith('//')) continue;
                const [y, mx, mz, lx, lz] = line.split('_').map(Number);
                if (y === 0) multi.add((((mx! << 6) + lx!) >> 3) + ',' + (((mz! << 6) + lz!) >> 3));
            }
        } catch { /* no map: everything single-way */ }
    }
    return multi.has((x >> 3) + ',' + (z >> 3));
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
// Whether the escape teleport (a spell component id, sdk/spells.ts) can be cast from the pack, the worn staff and the
// Magic level (scripts/teleport-runes.ts). Live, a squad account with no law runes clicked Camelot Teleport four times
// at 17 to 8 HP and died beside its attacker; with this false the escape runs south instead.
export function escapeCastable(spell: number, carried: readonly { id: number; count: number }[], wornIds: readonly number[], magic: number): boolean {
    const key = Object.entries(Spells).find(([, id]) => id === spell)?.[0];
    if (!key) return false;
    return castable(`magic:${key.toLowerCase()}`, id => carried.filter(i => i.id === id).reduce((n, i) => n + i.count, 0), wornIds, magic);
}

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

// Rev 289 Charge varp (%magearena_charge = varp 272, set to 350 and decremented every 2 ticks by [timer,charge]).
export const chargeVarpTicks = (client: unknown): number | undefined => {
    const val = (client as { var?: number[] } | undefined)?.var?.[272];
    return typeof val === 'number' ? val : undefined;
};

// Charge eligibility: Magic 80+, 3 fire/3 blood/3 air runes, and varp 272 <= 0 when observable.
export function canCastChargeNow(magicLevel: number, inv: readonly { id: number; count: number }[], chargeVarp?: number): boolean {
    if (magicLevel < 80 || (chargeVarp !== undefined && chargeVarp > 0)) return false;
    const countOf = (id: number) => inv.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    return countOf(ITEMS.fireRune) >= 3 && countOf(ITEMS.bloodRune) >= 3 && countOf(ITEMS.airRune) >= 3;
}

// Exact rev-289 Dragon Battleaxe warcry stat drains & Strength boost (specwep.rs2:67-77).
export function battleaxeWarcryMath(levels: { Attack: number; Defence: number; Ranged: number; Magic: number }) {
    const drained = {
        attack: Math.floor(levels.Attack / 10),
        defence: Math.floor(levels.Defence / 10),
        ranged: Math.floor(levels.Ranged / 10),
        magic: Math.floor(levels.Magic / 10),
    };
    const sum = drained.attack + drained.defence + drained.ranged + drained.magic;
    return { drained, strengthBoost: 10 + Math.floor(sum / 4) };
}
// A repeatable random number source (mulberry32): the same seed gives the same numbers.
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// An index drawn with the given weights: [3, 1] gives 0 in 3 of 4 draws.
export function pickWeighted(weights: readonly number[], rand: () => number): number {
    const total = weights.reduce((n, w) => n + Math.max(0, w), 0);
    let r = rand() * total;
    for (let i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]!); if (r < 0) return i; }
    return 0;
}
// The attack range of a shortbow (skill_combat/configs/ranged/bows.obj attackrange).
const BOW_RANGE = 7;
// Adjacent, not diagonal: where a melee attack lands.
const adjacent = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
// kiteMelee: the 8 step directions, and the SDK's path search, loaded on the first kite step only (it holds the
// collision map).
const KITE_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
export const DIAGONAL_CORNERS: readonly [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
// Compute the cooldown kite tile while the target is frozen and holds melee, enforcing pvp_frozen's 10-tile leash.
export function pickFrozenKiteTile(opts: {
    at: { x: number; z: number };
    target: { x: number; z: number };
    stepUnder?: boolean;
    diagonal?: boolean;
    standOff?: number;
    kiteFrozen?: number;
    frozen: boolean;
    canWalkTo?: (x: number, z: number) => boolean;
}): { x: number; z: number } | null {
    const { at, target, stepUnder, diagonal, standOff, kiteFrozen, frozen, canWalkTo } = opts;
    if (stepUnder) {
        if (at.x === target.x && at.z === target.z) return null;
        return !canWalkTo || canWalkTo(target.x, target.z) ? { x: target.x, z: target.z } : null;
    }
    if (diagonal) {
        if (Math.abs(at.x - target.x) === 1 && Math.abs(at.z - target.z) === 1) return null;
        const dxPref = Math.sign(at.x - target.x) || 1, dzPref = Math.sign(at.z - target.z) || 1;
        const corners = [...DIAGONAL_CORNERS].sort((a, b) => {
            const ad = Math.abs(at.x - (target.x + a[0])) + Math.abs(at.z - (target.z + a[1]));
            const bd = Math.abs(at.x - (target.x + b[0])) + Math.abs(at.z - (target.z + b[1]));
            const aPref = (a[0] === dxPref ? 0 : 1) + (a[1] === dzPref ? 0 : 1);
            const bPref = (b[0] === dxPref ? 0 : 1) + (b[1] === dzPref ? 0 : 1);
            return ad - bd || aPref - bPref;
        });
        for (const [cx, cz] of corners) {
            const tile = { x: target.x + cx, z: Math.max(3522, target.z + cz) };
            if (!canWalkTo || canWalkTo(tile.x, tile.z)) return tile;
        }
        return null;
    }
    const rawKeep = standOff ?? (frozen ? kiteFrozen ?? 0 : 0);
    if (!rawKeep) return null;
    const keep = frozen ? Math.min(rawKeep, 10) : rawKeep;
    if (cheb(at, target) >= keep) return null;
    const dx = Math.sign(at.x - target.x) || 1, dz = Math.sign(at.z - target.z);
    const tile = { x: target.x + dx * keep, z: Math.max(3522, target.z + dz * keep) };
    if (!canWalkTo || canWalkTo(tile.x, tile.z)) return tile;
    for (const [ddx, ddz] of KITE_DIRS) {
        const alt = { x: target.x + ddx * keep, z: Math.max(3522, target.z + ddz * keep) };
        if (canWalkTo(alt.x, alt.z)) return alt;
    }
    return null;
}
let kitePaths: typeof import('../vendor/rs-sdk/sdk/pathfinding') | null = null;
let kiteLos: typeof import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder') | null = null;
// A spell goes out only with a line of sight to the target (GameMap.ts isApproached, rsmod hasLineOfSight with
// CollisionFlag.PLAYER, the engine's BLOCK_NPC_AND_PLAYERS 0x100000).
async function lineOfSight(level: number, from: { x: number; z: number }, to: { x: number; z: number }): Promise<boolean> {
    kitePaths ??= await import('../vendor/rs-sdk/sdk/pathfinding');
    kiteLos ??= await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    kitePaths.initPathfinding();
    return kiteLos.hasLineOfSight(level, from.x, from.z, to.x, to.z, 1, 1, 1, 1, kiteLos.CollisionFlag.PLAYER);
}

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

// The style order of a fight: the order asked for, or the full order where the kit has no style of it. A profile
// with the order ranged, melee on a kit that only casts would never attack.
export function kitRotation(asked: readonly Style[] | undefined, kit: Kit): readonly Style[] {
    const full: readonly Style[] = ['magic', 'ranged', 'melee'];
    return asked?.some(st => hasStyle(kit, st)) ? asked : full;
}

// The fight loop times each eat against its attacks, so it holds the session's eat guard (packages/core/src/eat-guard.ts)
// for the fight.
export type VolleyState = { ready: Set<string>; first: number; fired: boolean; done: Set<string> };
export const newVolley = (): VolleyState => ({ ready: new Set(), first: -1, fired: false, done: new Set() });

export type SpecPlanInput = {
    dying: boolean;
    canReachMelee: boolean;
    fled: boolean;
    running: boolean;
    castFreezePending: boolean;
    kiteTarget: boolean;
    at: { x: number; z: number };
    target: NearbyPlayer;
    guarded: ReadonlySet<Style>;
    seen: Observed | null;
    energy: number;
    lastSpecStyle: Style | null;
    targetStunned: boolean;
    stunOpenForChain: boolean;
    spec?: SpecConfig;
    stunSpec?: SpecConfig;
    burstBow?: SpecConfig;
    bursting: boolean;
    bowBurstArmour?: 'strip' | 'keep';
    bowSpecFallback?: SpecConfig;
    fledSpec?: boolean;
    specReserve?: number;
    burstOnHold?: boolean;
    burstOnStun?: boolean;
    freezeShareHeld?: boolean;
    stunShare?: { until: number; overlap?: number; clock: () => number };
    hasWeaponAndShield: boolean;
    invLength: number;
    nearbyPlayers: readonly NearbyPlayer[];
    allies?: readonly string[];
    volleyBelow?: number;
    names?: Map<number, string>;
};

/** Evaluates active special selection, burst armour-strip eligibility, prayer/range gates, and melee prayer likelihood once per tick. */
export function evaluateSpecPlan(i: SpecPlanInput) {
    const names = i.names ?? getObjNames();
    const stunOverlap = i.stunShare?.overlap ?? 1;
    const canSecondaryStun = !i.dying && !!i.stunSpec && i.canReachMelee && !i.bursting
        && i.energy >= i.stunSpec.cost && i.stunOpenForChain
        && (i.fled || lowHealth(i.seen, i.stunSpec.below) || !!i.stunShare);
    const meleeSpecReady = !!i.spec && i.spec.style !== 'ranged' && i.energy >= i.spec.cost && i.canReachMelee;
    const spec: SpecConfig | undefined = canSecondaryStun ? i.stunSpec
        : i.bursting ? (i.lastSpecStyle === 'ranged' && meleeSpecReady ? i.spec : i.burstBow)
        : i.spec && i.fled && i.spec.style !== 'ranged' && !i.canReachMelee ? i.bowSpecFallback ?? i.spec : i.spec;
    const specStyle: Style = spec?.style ?? 'melee';
    const stripBurstArmour = i.bursting && spec === i.burstBow && i.bowBurstArmour !== 'keep';
    const specRange = specStyle === 'ranged' && spec ? weaponRange(spec.kit[0]!, names) ?? BOW_RANGE : BOW_RANGE;
    const gap = cheb(i.at, i.target);
    const specWaits = i.running && ((i.castFreezePending && !(spec?.stun && adjacent(i.at, i.target))) || (specStyle === 'ranged' && gap > specRange));
    const stunWaits = !!spec?.stun && !!i.stunShare && i.stunShare.clock() < i.stunShare.until - stunOverlap;
    const chainStun = !!spec?.stun && !!i.stunShare && i.stunShare.until >= 0 && i.stunOpenForChain;
    const freezeHeld = !!i.burstOnHold && !!i.freezeShareHeld;
    const burstStun = !!i.burstOnStun && !spec?.stun && i.targetStunned;
    const specNeedsRoom = !!spec?.kit.some(id => isDragonSpearName(names.get(id) ?? '')) && i.hasWeaponAndShield && i.invLength >= 28;
    const axeHitsAlly = thrownAxeHitsAlly(spec, i.nearbyPlayers, i.allies, names);
    const baseReady = !!spec && !i.dying && !axeHitsAlly && !specNeedsRoom && !i.kiteTarget && !specWaits && !stunWaits && i.energy >= spec.cost && (specStyle !== 'melee' || i.canReachMelee);
    const prayerAllowed = !!spec && (!!spec.stun || !i.guarded.has(specStyle) || lowHealth(i.seen, 0.25));
    const threatPass = !!spec && ((i.fled && i.fledSpec !== false) || i.bursting || freezeHeld || burstStun || chainStun || lowHealth(i.seen, spec.below));
    const volleyThresholdPass = i.volleyBelow === undefined || (i.fled && i.fledSpec !== false) || i.bursting || freezeHeld || burstStun || chainStun || lowHealth(i.seen, i.volleyBelow);
    const reservePass = !!spec && (i.fled || i.bursting || freezeHeld || burstStun || chainStun || lowHealth(i.seen, 0.3) || i.energy - spec.cost >= (i.specReserve ?? 0));
    const inRange = gap <= (specStyle === 'melee' ? 1 : specRange);
    const triggerNoVolley = baseReady && prayerAllowed && threatPass && reservePass;
    return {
        spec,
        specStyle,
        specRange,
        specWaits,
        stunWaits,
        chainStun,
        freezeHeld,
        burstStun,
        specNeedsRoom,
        axeHitsAlly,
        stripBurstArmour,
        inRange,
        volleyJoinEligible: baseReady && prayerAllowed && inRange && volleyThresholdPass,
        triggerNoVolley,
        specMeleeLikely: triggerNoVolley && specStyle === 'melee',
    };
}

// The entry script of this process, for the owner field of a kill receipt.
const KILL_SCRIPT = process.argv[1] ? relative(resolve(import.meta.dir, '..'), process.argv[1]).split(sep).join('/') : null;
export async function fightPlayer(s: Session, targetName: string, o: FightOptions): Promise<FightResult> {
    const eater = holdSessionEater(s.sdk);
    try { return await fightLoop(s, targetName, o, eater.ateAt + 3); } finally { eater.release(); }
}

async function fightLoop(s: Session, targetName: string, o: FightOptions, guardFoodReady: number): Promise<FightResult> {
    const log = o.log ?? ((line: string) => console.log(line));
    const rotation = kitRotation(o.rotation, o.kit);
    const eatAt = o.eatAt ?? 50, restoreAt = o.restorePrayerAt ?? 20, cap = o.cap ?? 600;
    const result: FightResult = { outcome: 'timeout', ticks: 0, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: 0 }, freezes: 0, specs: 0 };
    const sdk = s.sdk, start = s.tick(), want = targetName.toLowerCase();
    const startLife = sdk.getState()?.player?.lifeId;
    // The feed watch starts with the fight, so that it holds the victim's records when the kill comes.
    const feedWatch = killFeed(s.lifecycle?.server);
    let last = -1, nextAttack = start, lastAttackAt = -10, lastWalkTicks = 0, hasAttacked = false, delayedUntil = start;
    let foodReady = Math.max(start, guardFoodReady), karambwanReady = start, potionReady = start;
    let freezeReady = start, frozenUntil = start, freezeCastAt = -10, freezeDur = 0, lastSpot = -1, frozenTile: { x: number; z: number } | null = null, selfFrozenUntil = start;
    let seenEvent = 0, seenMessage = 0, lastSeen = start, unattackableSince = -1, poisoned = carriedPoison(s.client, start), poisonSeenAt = start, splatUsed = carriedSplat(s.client), rapidSet = false, pjedByNpc = false;
    let target: NearbyPlayer | undefined, rubbed = -1, gloryOffAt = -10, ranAt = -10, prevSelf: { x: number; z: number } | null = null;
    const predictor = new StylePredictor();
    let oppStyle: Style | null = null, oppChangedAt = start, earlyFreezes = 0;
    // A bench run (BENCH_SEED) with no mixSeed seeds its random choices from the seed and the account name, so a route
    // case (hunt, roam, army) repeats on its seed; a live run keeps Math.random.
    const benchSeed = o.mixSeed === undefined && process.env.BENCH_SEED !== undefined
        // A bench name is aiob…x<4-character token><role>; the role (1, 1b, …) is the same on every run.
        ? Number(process.env.BENCH_SEED) * 100_003 + [...(s.name.toLowerCase().match(/^aiob[a-z0-9]*x[a-z0-9]{4}(.+)$/)?.[1] ?? s.name.toLowerCase())].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) : undefined;
    const rand = o.mixSeed !== undefined ? seededRandom(o.mixSeed) : benchSeed !== undefined ? seededRandom(benchSeed) : Math.random;
    let charged = (chargeVarpTicks(s.client) ?? 0) > 0, chargeAt = -10, battleaxeAt = -10, stepAt = -10, flickAt = start, prayerDrainAt = -1, targetStunnedUntil = -1, lastFakieAt = -10, lastSpecStyle: Style | null = null;
    let heldOverhead: number | null = null, overheadSince = -1000, chaseLow = false, kiteStopAt = -10, outnumbered = o.escapeLatch?.outnumbered ?? false;
    // prayerLag: the overhead that the loop wants, the tick from which it has it, and the overhead it has now.
    let lagWant: number | null | undefined, lagAt = start, lagHas: number | null | undefined;
    let lastStyle: Style | null = null, arm: StyleArm = 'avoid', lastArm: StyleArm = 'avoid';
    const arms = new StyleArms();
    const splatSeen: { cycles: number[] | null } = { cycles: null };
    let prevTarget: { x: number; z: number } | null = null, prevGap = 0, fleeingUntil = start, heading = { x: 0, z: 0 }, chaseAt = -10, fled = false;
    const hits: { tick: number; damage: number; src: number }[] = [], dealtLog: { tick: number; damage: number }[] = [];
    // Tank torso worn or carried at fight start (unequipped for a cast/shot and re-equipped on melee turns).
    const names = getObjNames();
    const initState = sdk.getState();
    // An antipoison in the first tick after the poison (default). false: only in a tick with 3 ticks to the next attack, which
    // bow and dagger turns back to back do not give: in one live meeting 139 of 455 damage was poison and no antipoison was drunk.
    const cureNow = o.cureNow !== false;
    // Protect Item on or off for this tick: see FightOptions.protectItem.
    const protectItemNow = () => o.protectItem === false ? false : o.protectItem === 'skulled' ? ownSkull(s.client) === true : true;
    // Our skull and what a death would cost with it, logged at the start and at each change (the attacker takes a skull).
    let lastSkull: boolean | null | undefined;
    // The skull, the items and Protect Item of the last tick that we were alive, for the death line (deathSkullFields).
    let aliveView: { skull: boolean | null; units: { id: number; count: number }[]; protect: boolean } | null = null;
    // An account without Dragon Slayer cannot put its rune platebody back on after a cast ("You have not earned the
    // right to wear this yet."), so the loop leaves such a body on. The quest journal gives the state; where it does
    // not, the first refusal ends the removals.
    const slayer = questFlags(s.client)?.find(q => /dragon slayer/i.test(q.name))?.state;
    let torsoLocked = slayer === 'not started' || slayer === 'started';
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
        feedWatch?.aim(at.x, at.z);
        const skullNow = ownSkull(s.client);
        if (!(me.isDead || me.hp <= 0 || (startLife !== undefined && me.lifeId !== startLife))) aliveView = { skull: skullNow, units: [...state.inventory, ...state.equipment], protect: protectItemNow() };
        if (skullNow !== lastSkull) {
            lastSkull = skullNow;
            if (skullNow !== null) {
                const risk = deathRisk([...state.inventory, ...state.equipment], itemCostOf, skullNow, protectItemNow());
                log(`PK skull ${skullNow ? 'on' : 'off'}: a death keeps ${risk.kept.length} item${risk.kept.length === 1 ? '' : 's'} and loses ${risk.lostUnits} items worth ${risk.lostValue}`);
            }
        }
        const stoodStill = !!prevSelf && at.x === prevSelf.x && at.z === prevSelf.z;
        if (prevSelf && (at.x !== prevSelf.x || at.z !== prevSelf.z)) selfFrozenUntil = now;
        prevSelf = { x: at.x, z: at.z };
        let maxEvent = seenEvent;
        const eventDealt: number[] = [];
        // Events from before this fight are not its own: the history still holds the last fight's hits, and counted
        // as new they ended the next fight at once on "2 players hitting" (extra:roam-field with LOOT=0, finding 71).
        for (const e of state.combatEvents) {
            const id = e.observationId ?? e.tick;
            if (id <= seenEvent || e.tick < start) continue;
            if (id > maxEvent) maxEvent = id;
            if (e.type === 'damage_dealt' && e.targetType === 'other_player') eventDealt.push(e.damage);
            if (e.type === 'damage_taken') { result.taken += e.damage; if (e.sourceType === 'other_player') hits.push({ tick: now, damage: e.damage, src: e.sourceIndex }); }
        }
        seenEvent = maxEvent;
        // escapeOutnumbered: in multi-way combat, hits from that many players in 8 ticks start the escape for good, food
        // or not. In single-way combat one player at a time can hit (pvp_combat.rs2:103-133), so a crowd is no danger.
        const allyNear = o.allies?.length ? state.nearbyPlayers.filter(p => o.allies!.includes(p.name.toLowerCase()) && p.distance <= 10) : [];
        const alliesNear = allyNear.length;
        // The attackers: the client names a hit's source by the entity we face, so in a crowd every hit counts for one
        // player. A player within 10 tiles, not an ally, faces us when the index it faces is not in our own list of
        // nearby players (we are not in it); it faces an ally when that index is an ally's. Another fight close by (a
        // player facing some other visible player) counts for neither.
        const allyIdx = new Set(allyNear.map(p => p.index)), visibleIdx = new Set(state.nearbyPlayers.map(p => p.index));
        const faceOf = (index: number) => (s.client as { players?: ({ faceEntity?: number } | null)[] } | undefined)?.players?.[index]?.faceEntity ?? -1;
        const hostile = o.escapeOutnumbered != null || o.crowdPrayer
            ? state.nearbyPlayers.filter(p => p.distance <= 10 && !allyIdx.has(p.index) && !o.allies?.includes(p.name.toLowerCase())).map(p => ({ p, f: faceOf(p.index) - 32768 })).filter(x => x.f >= 0)
            : [];
        // Those that face us directly (`!visibleIdx.has(x.f)`) count for self crowd/escape checks instead of drowning in ally attackers.
        const directFacers = hostile.filter(x => !visibleIdx.has(x.f)).map(x => x.p);
        const facing = directFacers.length;
        const facers = hostile.filter(x => !visibleIdx.has(x.f) || allyIdx.has(x.f)).map(x => x.p);
        const sources = Math.max(new Set(hits.filter(h => now - h.tick <= 8 && h.src >= 0).map(h => h.src)).size, hits.some(h => now - h.tick <= 8) ? facing : 0);
        if (o.escapeOutnumbered != null && !outnumbered && isMulti(at.x, at.z) && sources - alliesNear >= o.escapeOutnumbered) {
            outnumbered = true; if (o.escapeLatch) o.escapeLatch.outnumbered = true; log(`PK outnumbered at HP ${me.hp}: escape`);
        }
        const escapeNow = (pack: typeof state.inventory) => o.flee === true || outnumbered || (o.escapeAt !== undefined && me.hp <= o.escapeAt && !bestFood(pack));
        let maxMessage = seenMessage;
        for (const m of state.gameMessages) {
            const id = m.observationId ?? m.tick;
            if (id <= seenMessage || m.tick < start) continue;
            if (id > maxMessage) maxMessage = id;
            // A dead player stands at its respawn point, and an attack click that is still in hand would walk our account
            // after it: a walk to our own tile ends that click.
            if (m.type === 0 && killMessage(m.text, targetName)) {
                if (typeof sdk.sendWalk === 'function') void sdk.sendWalk(at.x, at.z);
                result.outcome = 'kill'; log(`PK kill ${targetName} after ${result.ticks} ticks`);
                // The receipt is the record of the kill for the owner goal. A failed write must not end the run: the
                // log line names the failure and the fight result has no receipt.
                if (s.lifecycle || o.killReceiptRoot) try {
                    const victim = state.nearbyPlayers.find(p => p.name.toLowerCase() === want);
                    const { file, receipt } = writeKillReceipt({
                        session: s.lifecycle ? { server: s.lifecycle.server, attemptId: s.lifecycle.attemptId } : null,
                        account: s.name, victim: victim?.name ?? targetName, tick: now, tile: { x: at.x, z: at.z, level: me.level ?? 0 },
                        wilderness: wildernessLevel(at.z), multi: isMulti(at.x, at.z), message: m.text,
                        victimCombat: victim?.combatLevel ?? target?.combatLevel ?? null, victimTile: victim ? { x: victim.x, z: victim.z } : result.targetAt ?? null,
                        kit: { worn: state.equipment.map(e => ({ slot: e.slot, id: e.id, name: e.name })), switches: { magic: [...(o.kit.magic ?? [])], ranged: [...(o.kit.ranged ?? [])], melee: [...(o.kit.melee ?? [])] } },
                        fight: { ticks: result.ticks, dealt: result.dealt, taken: result.taken, eaten: result.eaten, specs: result.specs },
                    }, { script: KILL_SCRIPT, ...(o.killReceiptRoot ? { root: o.killReceiptRoot } : {}) });
                    result.receipt = file;
                    log(`PK kill receipt ${receipt.domain} ${receipt.id} wilderness ${receipt.wilderness} ${receipt.multi ? 'multi' : 'single'}`);
                    if (feedWatch) checkKillFeed(feedWatch, receipt.victim, receipt.at, match => {
                        amendKillReceipt(file, { feed: match });
                        log(`PK kill feed ${match.matched ? `matched at feed tick ${match.feedTick}` : `no match: ${match.reason}`}`);
                    });
                } catch (e) { log(`PK kill receipt failed: ${String(e)}`); }
                return result;
            }
            if (/magical force stops you from moving|you're stunned/i.test(m.text) && now >= selfFrozenUntil) selfFrozenUntil = now + 8;
            if (/already held by a magical force|currently immune to that spell/i.test(m.text)) {
                freezeReady = Math.max(freezeReady, now + 4);
                frozenUntil = Math.max(frozenUntil, now + 4);
            }
            if (/have been poisoned/i.test(m.text)) { poisoned = true; poisonSeenAt = now; }
            if (/not earned the right to wear/i.test(m.text)) torsoLocked = true;
            if (/feel charged with magic power/i.test(m.text)) charged = true;
            if (/magical charge fades away/i.test(m.text)) charged = false;
            if (/already under attack/i.test(m.text)) pjedByNpc = true;
        }
        seenMessage = maxMessage;
        if ((rubbed >= 0 || ranAt >= 0) && wildernessLevel(at.z) === 0) { result.outcome = 'escaped'; log(`PK escaped ${targetName} after ${result.ticks} ticks at HP ${me.hp}`); return result; }
        if (me.isDead || me.hp <= 0 || (startLife !== undefined && me.lifeId !== startLife)) { result.outcome = 'died'; log(`PK died to ${targetName} after ${result.ticks} ticks${deathSkullFields(aliveView, itemCostOf)}`); return result; }
        if (o.stop?.()) { log(`PK stopped against ${targetName}`); return result; }
        target = state.nearbyPlayers.find(p => p.name.toLowerCase() === want);
        // Damage dealt: the splats on the target where the client shows them, else the SDK's events.
        for (const damage of (target ? newSplats(s.client, target.index, splatSeen) : null) ?? eventDealt) { result.dealt += damage; dealtLog.push({ tick: now, damage }); }
        if (target) {
            lastSeen = now;
            result.targetAt = { x: target.x, z: target.z };
            // The target flees when it moves and the gap grows past 2 tiles; the state holds for 6 ticks after the last such step.
            const gap = cheb(at, target);
            if (prevTarget && (target.x !== prevTarget.x || target.z !== prevTarget.z) && gap > prevGap && gap > 2) {
                fleeingUntil = now + 6;
                fled = true;
                heading = { x: Math.sign(target.x - prevTarget.x), z: Math.sign(target.z - prevTarget.z) };
            } else if (fledEnds(fled, gap, now, fleeingUntil, frozenUntil)) {
                // The flee hold has run out (no step away for 6 ticks), the target is not held by a freeze and it stands within 2 tiles: it re-engaged. `fled` bypasses the
                // special's health threshold and the energy reserve, so it must not outlive the flight (a latch that never reset sent the specials at full health).
                fled = false;
                log(`PK target back within ${gap} tiles: no longer fled`);
            }
            prevTarget = { x: target.x, z: target.z }; prevGap = gap;
            // The graphic on the target names a hold spell's result in the tick the server casts it, whoever cast it:
            // an impact graphic a hold, failedspell_impact a splash (of ours only within 3 ticks of our cast). The tile read
            // below cannot tell a hold from a target that stands still (SPOT_READ=0 leaves only the tile read).
            const spotRead = process.env.SPOT_READ !== '0', seenNow = observePlayer(s.client, target.index), spot = spotRead ? seenNow?.spotanim ?? -1 : -1;
            if (spot !== lastSpot && HOLD_IMPACT.includes(spot)) {
                const dur = freezeDuration(IMPACT_SPELL[spot]!, protectedStyles(seenNow?.headicons).has('magic'));
                frozenUntil = Math.max(frozenUntil, now + dur); freezeReady = Math.max(freezeReady, now + dur + 5); frozenTile = null;
                if (o.freezeShare) { o.freezeShare.until = Math.max(o.freezeShare.until, o.freezeShare.clock() + dur + 5); o.freezeShare.heldUntil = o.freezeShare.clock() + dur; }
                log(`PK freeze held (graphic) at distance ${cheb(at, target)}, wilderness level ${wildernessLevel(target.z)}`);
            } else if (spot !== lastSpot && spot === SPLASH_IMPACT && now - freezeCastAt <= 3 && frozenTile) {
                if (o.freezeShare) { o.freezeShare.until = o.freezeShare.clock(); o.freezeShare.heldUntil = Math.min(o.freezeShare.heldUntil ?? -1, o.freezeShare.clock()); }
                frozenUntil = now; freezeReady = now; frozenTile = null;
                log(`PK freeze missed (graphic) at distance ${cheb(at, target)}`);
            } else if (spot !== lastSpot && spot === STUNNED_SHOVE_SPOTANIM) {
                // Observed in the tick after server .p_delay(4) sets delayedUntil = fireTick + 5 -> 4 ticks left.
                targetStunnedUntil = Math.max(targetStunnedUntil, now + 4);
                if (o.stunShare) {
                    const shareClock = o.stunShare.clock();
                    if (o.stunShare.until <= shareClock) o.stunShare.until = shareClock + 4;
                    o.stunShare.stunnedUntil = Math.max(o.stunShare.stunnedUntil ?? -1, shareClock + 4);
                }
                log(`PK target stunned (shove graphic) at distance ${cheb(at, target)}`);
            }
            if (spot !== lastSpot && process.env.PK_TRACE === '1') log(`PKS target graphic ${spot}`);
            lastSpot = spot;
            // The server casts in the tick after our click, and a target that runs can step once more before it: the tile
            // of a hold is where the target stands two ticks after the cast.
            if (frozenTile && now === freezeCastAt + 2) frozenTile = { x: target.x, z: target.z };
            if (frozenTile && now > freezeCastAt + 2 && (target.x !== frozenTile.x || target.z !== frozenTile.z)) {
                // Target moved after the freeze cast: if it moved right away the spell splashed (no immunity); else it wore off (5-tick immunity).
                const splashed = now <= freezeCastAt + 3;
                if (splashed && fled) log(`PK freeze missed at distance ${gap}`);
                if (splashed && o.freezeShare) o.freezeShare.until = o.freezeShare.clock();
                if (o.freezeShare?.heldUntil !== undefined) o.freezeShare.heldUntil = Math.min(o.freezeShare.heldUntil, o.freezeShare.clock());
                frozenUntil = now;
                freezeReady = splashed ? now : Math.min(freezeReady, now + 5);
                frozenTile = null;
            } else if (frozenTile && now === freezeCastAt + 3) {
                if (fled) log(`PK freeze held at distance ${gap}, wilderness level ${wildernessLevel(target.z)}`);
                // With the graphic read on, a target that only stood still is no hold: the graphic confirms a hold.
                if (!spotRead && o.freezeShare?.stagger !== undefined) o.freezeShare.until = Math.max(o.freezeShare.until, o.freezeShare.clock() + freezeDur + 2);
                if (!spotRead && o.freezeShare) o.freezeShare.heldUntil = o.freezeShare.clock() + freezeDur - 3;
            }
            if (o.maxDistance !== undefined && target.distance > o.maxDistance) { result.outcome = 'lost'; return result; }
            if (o.maxWild !== undefined && (wildernessLevel(at.z) > o.maxWild || wildernessLevel(target.z) > o.maxWild)) { result.outcome = 'lost'; return result; }
        } else if (now - lastSeen > 10 && !escapeNow(state.inventory)) {
            // While it escapes, a target out of view is the aim: the loop goes on until it is out of the Wilderness.
            result.outcome = 'lost'; log(`PK lost ${targetName} after ${result.ticks} ticks`); return result;
        }
        if (result.ticks >= cap) { log(`PK timeout against ${targetName}`); return result; }
        const inv = state.inventory, slotOf = (ids: readonly number[]) => inv.find(i => ids.includes(i.id));
        const oppCombat = Math.max(target?.combatLevel ?? 0, ...state.nearbyPlayers.filter(p => hits.some(h => h.src === p.index && now - h.tick <= 10)).map(p => p.combatLevel));
        const oppMax = estMaxHit(oppCombat || me.combatLevel);
        const danger = dangerReason({ hp: me.hp, maxHp: me.maxHp, food: !!bestFood(inv), prayer: state.prayers.prayerPoints, oppMax, hits, dealt: dealtLog, now, window: o.raceWindow, race: o.raceExit, noFoodAt: o.noFoodAt });
        // pressLow: a danger with food gone waits while the target's health bar shows this fraction or lower and the
        // target is the only one hitting us: one more hit or special may end it.
        const pressing = o.pressLow !== undefined && !!target && !!danger && /^no food/.test(danger) && lowHealth(observePlayer(s.client, target.index), o.pressLow)
            && !hits.some(h => now - h.tick <= 10 && h.src >= 0 && h.src !== target?.index);
        if (danger && o.exitOnDanger && !pressing) { result.outcome = 'danger'; result.danger = danger; log(`PK danger against ${targetName}: ${danger}`); return result; }
        // While suspended by p_delay (DDS spec p_delay(0), potion p_delay(1), karambwan p_delay(2)), processClientsIn
        // drops OpHeld/InvButton/OpPlayer/MoveClick and protected scripts fail p_finduid(uid); wait until un-delayed.
        if (now < delayedUntil) continue;
        // Food and movement share the native five-USER_EVENT limit with gear, prayers and attacks.
        let sentEvents = 0;
        const walk = (x: number, z: number): boolean => {
            if (sentEvents >= 5) return false;
            void sdk.sendWalk(x, z);
            sentEvents++;
            return true;
        };
        const use = (item: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }, verb: RegExp): boolean => {
            const op = item.optionsWithIndex.find(x => verb.test(x.text));
            if (!op || sentEvents >= 5) return false;
            void sdk.sendUseItem(item.slot, op.opIndex);
            sentEvents++;
            return true;
        };
        if (state.combatStyle?.currentStyle === 1) rapidSet = true;
        // Free food: a cooked karambwan has no eat delay and adds nothing to the attack timer (consume.rs2:38 passes
        // null for both); it only suspends the player for 2 ticks (consume_messages.dbrow message_delay). Eaten on a
        // tick with 3 or more ticks to our next attack it costs no attack, where a shark costs 3 ticks each time. Off by
        // default: the 2 ticks with no input also stop the prayer switch, and the karambwan build lost to the shark
        // build (6 kills, 10 deaths in 16 spars).
        const freeFood = o.freeFood === true ? slotOf([ITEMS.karambwan]) : undefined;
        if (freeFood && hasAttacked && now >= karambwanReady && nextAttack - now >= 3 && me.hp <= me.maxHp - 18) {
            use(freeFood, /^Eat$/i);
            karambwanReady = now + 3;
            delayedUntil = Math.max(delayedUntil, now + 3);
            result.eaten++;
            continue;
        }
        // Food before anything, any food best first; eating adds 3 ticks to %action_delay on the server (consume.rs2:130).
        // An account with few Hitpoints is under every threshold at full health, so full health never eats.
        // kiteMelee: an inventory click (OpHeld) in the two ticks of a cast clears the spell before the server casts it,
        // so food and potions wait unless the next hit could kill.
        let ateThisTick = false;
        const castShield = (o.kiteMelee !== undefined || o.freezeStill === true) && now <= freezeCastAt + 2 && me.hp > oppMax;
        // freezeStill: the ticks after a cast until the hold shows (the target stood: held two ticks after the cast).
        const freezeHolding = o.freezeStill === true && now <= freezeCastAt + 3 && !(now < frozenUntil && now >= freezeCastAt + 2 && !!frozenTile);
        const wornGlory = state.equipment.find(e => e.slot === 2 && (ITEMS.glory as readonly number[]).includes(e.id));
        // The escape spell counts only when its runes, staff and level allow a cast (escapeCastable).
        const spellReady = o.escapeSpell !== undefined && escapeCastable(o.escapeSpell, inv, state.equipment.map(e => e.id), state.skills.find(k => k.name === 'Magic')?.level ?? 1);
        const instantSpellOut = spellReady && wildernessLevel(at.z) <= 20;
        // A worn glory needs a pack slot before it can be rubbed, unless an instant teleport spell is castable in Wild <= 20.
        const gloryRoom = !instantSpellOut && escapeNow(inv) && wildernessLevel(at.z) <= 30 && !!wornGlory && !slotOf(ITEMS.glory)
            && inv.length >= 28 && typeof sdk.sendUseEquipmentItem === 'function';
        if ((!castShield || gloryRoom) && (gloryRoom || me.hp < me.maxHp && me.hp <= Math.max(eatAt, oppMax + 8)) && now >= foodReady) {
            const food = bestFood(inv);
            if (food && use(food, /^Eat$/i)) {
                foodReady = now + 3;
                ateThisTick = true;
                result.eaten++;
                if (food.id === ITEMS.karambwan) {
                    // tbwt_cooked_karambwan adds 0 ticks to %action_delay (consume.rs2:38) and suspends input via p_delay(2).
                    karambwanReady = now + 3;
                    delayedUntil = Math.max(delayedUntil, now + 4);
                    nextAttack = Math.max(nextAttack, delayedUntil);
                } else {
                    nextAttack = (hasAttacked ? nextAttack : now) + 3;
                    hasAttacked = true;
                    const recentDamage = hits.filter(h => now - h.tick <= 2).reduce((n, h) => n + h.damage, 0);
                    const comboWant = shouldComboEat({
                        hp: me.hp, maxHp: me.maxHp, oppMax, eatAt,
                        comboFood: o.comboFood, comboAt: o.comboAt, koComboAt: o.koComboAt,
                        recentDamage, oppSpecThreat: !!o.spec || !!target,
                    });
                    if (comboWant && now >= karambwanReady) {
                        const kw = slotOf([ITEMS.karambwan]);
                        if (kw && use(kw, /^Eat$/i)) {
                            karambwanReady = now + 3;
                            delayedUntil = Math.max(delayedUntil, now + 4);
                            nextAttack = Math.max(nextAttack, delayedUntil);
                            result.eaten++;
                        }
                    }
                }
                if (gloryRoom) continue;
            }
        }
        // Deeper than the teleports reach (glory 30, spells 20): run south first.
        if (o.escapeWalk !== undefined && escapeNow(inv) && wildernessLevel(at.z) <= o.escapeWalk) {
            if (now - ranAt > 2) { if (ranAt < 0) log(`PK walks out of the Wilderness at HP ${me.hp}`); walk(at.x, Math.max(at.z - 20, at.z - 8 * wildernessLevel(at.z) - 2)); ranAt = now; }
            continue;
        }
        // The game rubs a glory only from the pack (amulet_of_glory.rs2 has no worn option), so a worn one comes off first:
        // the amulet that an account wears is then its way out, and its pack needs no second one.
        const reach = slotOf(ITEMS.glory) || wornGlory ? 30 : spellReady ? 20 : 0;
        // No teleport at all (no glory, no escape spell): the way out is a run south, at any level, or the escape
        // stands beside its attacker until its cap (review of PR #804).
        const runSouth = () => { if (now - ranAt > 2) { if (ranAt < 0) log(`PK walks out of the Wilderness at HP ${me.hp}`); walk(at.x, Math.max(at.z - 20, at.z - 8 * wildernessLevel(at.z) - 2)); ranAt = now; } };
        if (escapeNow(inv) && !reach && wildernessLevel(at.z) > 0) { runSouth(); continue; }
        if (escapeNow(inv) && reach && wildernessLevel(at.z) > reach) {
            if (now - ranAt > 3) { if (ranAt < 0) log(`PK run south at HP ${me.hp}`); walk(at.x, at.z - 14); ranAt = now; }
            continue;
        }
        if (escapeNow(inv) && wildernessLevel(at.z) <= 30) {
            const glory = slotOf(ITEMS.glory);
            const dropVial = !glory && wornGlory && !ateThisTick && inv.length >= 28 ? slotOf([229]) : undefined;
            const slotFood = !glory && wornGlory && !ateThisTick && inv.length >= 28 && !dropVial && now >= foodReady ? bestFood(inv) : undefined;
            // Instant 1-tick teleport spell beats Glory's rub dialog in Wild <= 20 because enemy hits close chat dialogs (.if_close).
            if (spellReady && o.escapeSpell !== undefined && wildernessLevel(at.z) <= 20 && (rubbed < 0 || now - rubbed > 6)) {
                log(`PK teleport spell at HP ${me.hp}`); void sdk.sendClickComponent(o.escapeSpell); rubbed = now;
            } else if (glory && (rubbed < 0 || now - rubbed >= 2) && !state.dialog?.isOpen) { log(`PK rub glory at HP ${me.hp}`); use(glory, /^Rub$/i); rubbed = now; }
            else if (!glory && wornGlory && inv.length < 28 && typeof sdk.sendUseEquipmentItem === 'function') { if (now - gloryOffAt > 2) { log(`PK takes its glory off at HP ${me.hp}`); void sdk.sendUseEquipmentItem(wornGlory.slot, 1); gloryOffAt = now; } }
            else if (dropVial && use(dropVial, /^Drop$/i)) { log(`PK drops vial for glory at HP ${me.hp}`); }
            else if (slotFood && use(slotFood, /^Eat$/i)) { foodReady = now + 3; result.eaten++; log(`PK eats for glory slot at HP ${me.hp}`); }
            else if (!glory && wornGlory && ateThisTick && inv.length >= 28) { /* wait one tick for eaten food to free a pack slot */ }
            // A worn glory with a full pack and nothing to drop or eat, or a spell out of its reach: run south.
            else if (!glory && (!wornGlory || inv.length >= 28) && (!spellReady || wildernessLevel(at.z) > 20) && !state.dialog?.isOpen) runSouth();
            if (state.dialog?.isOpen) void sdk.clickDialogByText(/^Edgeville/i);
            continue;
        }
        const prayers = state.prayers;
        // Drinking a potion triggers p_delay(1) in processClientsIn (consume_effects.rs2:167), blocking client input on
        // now+1 and now+2 (ready on now+3). Drink non-emergency potions only when now+3 <= nextAttack.
        // The poison hitsplat on us is the sign that the message does not give (a carried or renewed poison); the state ends POISON_HOLD ticks after its last sign.
        const splat = poisonSplat(s.client);
        if (splat > splatUsed) { poisoned = true; poisonSeenAt = now; splatUsed = splat; } else if (poisoned && now - poisonSeenAt > POISON_HOLD) poisoned = false;
        noteFightPoison(s.client, poisoned, poisonSeenAt, splatUsed);
        if (!castShield && now >= potionReady && (prayers.prayerPoints <= 5 || now + 3 <= nextAttack || (cureNow && poisoned && !!slotOf(ITEMS.antipoison)))) {
            let potion = prayers.prayerPoints <= restoreAt ? slotOf([...ITEMS.prayerPotion, ...ITEMS.superRestore]) : undefined;
            if (!potion && poisoned) {
                potion = slotOf(ITEMS.antipoison);
                if (potion) poisoned = false;
            }
            if (!potion && now + 3 <= nextAttack) {
                const skill = (n: string) => state.skills.find(k => k.name === n);
                const unboosted = (n: string) => { const k = skill(n); return !!k && k.level <= k.baseLevel; };
                const drained = (n: string) => { const k = skill(n); return !!k && k.level < k.baseLevel; };
                if (o.battleaxeBuff === 'restore' && (drained('Attack') || drained('Defence') || drained('Ranged') || drained('Magic'))) {
                    potion = slotOf([...ITEMS.superRestore, ...ITEMS.restorePotion]);
                }
                if (!potion && hasStyle(o.kit, 'melee') && unboosted('Strength')) potion = slotOf([...ITEMS.superStrength, ...ITEMS.strengthPotion]);
                if (!potion && hasStyle(o.kit, 'melee') && unboosted('Attack')) potion = slotOf([...ITEMS.superAttack, ...ITEMS.attackPotion]);
                if (!potion && hasStyle(o.kit, 'ranged') && unboosted('Ranged')) potion = slotOf(ITEMS.rangingPotion);
                if (!potion && hasStyle(o.kit, 'magic') && unboosted('Magic')) potion = slotOf(ITEMS.magicPotion);
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
        // Chase: a target that flees covers 2 tiles a tick, and an attack that is done leaves us where we stand until
        // the next turn. While we stand, run after it: to its tile, or along its heading once it is out of view. A walk
        // would cancel an approach that the server has in hand, so it is sent only while we stand still.
        const ranged = hasStyle(o.kit, 'magic') || hasStyle(o.kit, 'ranged');
        if (o.chaseBelow !== undefined && target) chaseLow = lowHealth(observePlayer(s.client, target.index), o.chaseBelow);
        if (o.kiteMelee === undefined && !freezeHolding && (o.chase !== false || chaseLow) && ranged && stoodStill && now >= selfFrozenUntil && now - chaseAt >= 2 && now < nextAttack && now < fleeingUntil + 12) {
            const ahead = o.cutOff !== undefined && now < fleeingUntil;
            const to = target && cheb(at, target) > (ahead ? 1 : 5) ? (ahead ? { x: target.x + heading.x * o.cutOff!, z: target.z + heading.z * o.cutOff! } : { x: target.x, z: target.z })
                : !target && prevTarget ? { x: prevTarget.x + heading.x * 12, z: prevTarget.z + heading.z * 12 } : null;
            if (to && walk(to.x, to.z)) chaseAt = now;
        }
        if (!target) continue;
        if (o.holdFire?.()) {
            // To within holdRange (default 3) tiles; at 1, onto the side tile toward us (a melee tile, not a corner).
            const range = o.holdRange ?? 3;
            if (cheb(at, target) > range && stoodStill && now - stepAt >= 2) {
                const dx = Math.sign(at.x - target.x), dz = Math.sign(at.z - target.z);
                const side = range <= 1 ? (Math.abs(at.x - target.x) >= Math.abs(at.z - target.z) ? { x: dx, z: 0 } : { x: 0, z: dz }) : { x: dx * (range - 1), z: dz * (range - 1) };
                if (walk(target.x + side.x, target.z + side.z)) stepAt = now;
            }
            continue;
        }
        if (!attackable({ z: at.z, combatLevel: me.combatLevel }, target)) {
            if (wildernessLevel(target.z) === 0) { result.outcome = 'lost'; return result; }
            if (unattackableSince < 0) unattackableSince = now;
            else if (now - unattackableSince >= 6) { result.outcome = 'lost'; return result; }
        } else unattackableSince = -1;
        const seen = observePlayer(s.client, target.index);
        const dying = isDying(seen);
        // PK_TRACE=1: one line for each tick of what the loop reads, to find where two runs with one seed part.
        if (process.env.PK_TRACE === '1') log(`PKT ${result.ticks} hp=${me.hp} run=${me.runEnergy ?? '?'} at=${at.x},${at.z} t=${target.x},${target.z} th=${seen?.health}/${seen?.totalHealth} hi=${seen?.headicons} w=${seen?.worn.join('.')} pp=${state.prayers.prayerPoints} na=${nextAttack - start} hits=${hits.map(h => h.damage).join('.')} dealt=${result.dealt} ev=${state.combatEvents.length} inv=${inv.length}`);
        const prayerBase = state.skills.find(k => k.name === 'Prayer')?.baseLevel ?? 99;
        const lastHit = [...hits].reverse().find(h => now - h.tick <= 5);
        const hitter = !o.facedPrayer && lastHit && lastHit.src !== target.index ? observePlayer(s.client, lastHit.src) : null;
        if (seen) {
            const shown = weaponStyle(seen.worn[3]);
            predictor.observe(shown);
            if (shown !== oppStyle) { oppStyle = shown; oppChangedAt = now; }
        }
        // An opponent that changes weapon attacks in the tick of the change, so its next attack is one attack delay later.
        const oppDue = oppChangedAt + (oppStyle === 'magic' ? 5 : oppStyle === 'ranged' ? 3 : 4);
        // counterRead: an opponent that reads our overhead does not attack with the style it covers. One that has shown
        // two styles then has one left, so its next attack is the style our overhead does not show now.
        const shownGuard: Style | null = prayers.activePrayers[PRAYER.melee] ? 'melee' : prayers.activePrayers[PRAYER.missiles] ? 'ranged' : prayers.activePrayers[PRAYER.magic] ? 'magic' : null;
        const left = [...predictor.seen()].filter(st => st !== shownGuard);
        const countered = o.counterRead && shownGuard && predictor.seen().size === 2 && left.length === 1 ? left[0]! : null;
        const predicted = o.predictPrayer && !hitter && (!o.snapPrayer || now >= oppDue - (o.snapLead ?? 1)) ? countered ?? predictor.predict() : null;
        // crowdPrayer: two or more hostiles in multi-way facing US directly set the plurality overhead; a lone off-target direct facer sets offTargetFacer.
        const pluralityStyle = (list: readonly NearbyPlayer[]) => {
            const n = new Map<Style, number>();
            for (const p of list) { const w = observePlayer(s.client, p.index); const st = weaponStyle(w?.worn[3]); n.set(st, (n.get(st) ?? 0) + 1); }
            return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        };
        const crowdStyle = o.crowdPrayer && !o.facedPrayer && isMulti(at.x, at.z) && directFacers.length >= 2 ? pluralityStyle(directFacers) : null;
        const offTargetFacer = o.crowdPrayer && !o.facedPrayer && directFacers.length === 1 && directFacers[0]!.index !== target.index
            ? weaponStyle(observePlayer(s.client, directFacers[0]!.index)?.worn[3]) : null;
        // threatPrayer: the style of a threat that is not the opponent (the threat radar of scripts/pk-threat.ts). A hitter, the opponent's
        // own hits, still come first.
        const threatStyle = o.threatPrayer?.() ?? null;
        let wantedOverhead = o.overheadPrayer === false ? null : crowdStyle ? PROTECT_FROM[crowdStyle] : hitter ? PROTECT_FROM[weaponStyle(hitter.worn[3])] : threatStyle ? PROTECT_FROM[threatStyle] : offTargetFacer ? PROTECT_FROM[offTargetFacer] : predicted ? PROTECT_FROM[predicted] : seen ? PROTECT_FROM[weaponStyle(seen.worn[3])] : adjacent(at, target) ? PRAYER.melee : PRAYER.magic;
        if (o.prayerLag?.length) {
            if (lagHas === undefined) lagWant = lagHas = wantedOverhead;
            else if (wantedOverhead !== lagWant) { lagWant = wantedOverhead; lagAt = now + pickWeighted(o.prayerLag, rand); }
            if (now >= lagAt) lagHas = lagWant;
            wantedOverhead = lagHas ?? null;
        }
        if (wantedOverhead !== heldOverhead && (heldOverhead === null || now - overheadSince >= (o.overheadHold ?? 0))) { heldOverhead = wantedOverhead; overheadSince = now; }
        const overhead = o.overheadHold ? heldOverhead : wantedOverhead;
        // An opponent that only has melee: hold it and stay out of its reach.
        // Only with a freeze that the carried runes can cast: with none, the loop would spend turns on a spell that
        // does not go out and kite an opponent that is not held.
        const meleeOnly = !!o.adapt && hits.filter(h => h.src === target!.index).length >= 6 && [...predictor.seen()].every(st => st === 'melee')
            && castableFreeze(state.skills.find(k => k.name === 'Magic')?.level ?? 1, inv) !== null;
        const kiteTiles = o.kiteFrozen ?? (meleeOnly ? 3 : 0), freezeRule: FightOptions['freeze'] = o.kiteMelee !== undefined ? true : o.freeze || (meleeOnly ? true : false);
        // A chase: the target flees, or stands frozen more than 2 tiles away. A melee turn then spends the freeze on a
        // walk, so an account with a ranged or magic kit attacks from where it stands. Within 2 tiles a melee turn or
        // a melee special costs one step.
        const chasing = (now < fleeingUntil || now < frozenUntil) && cheb(at, target) > 2 && ranged;
        // While we kite a frozen target, a melee turn would walk back into its reach.
        const heldMelee = now < frozenUntil && weaponStyle(seen?.worn[3]) === 'melee' && ranged;
        const kiting = (!!kiteTiles || !!o.diagonalFrozen || !!o.stepUnderFrozen) && heldMelee;
        const canReachMelee = !chasing && !kiting && !(now < selfFrozenUntil && !adjacent(at, target)) && (cheb(at, target) <= 6 || (!hasStyle(o.kit, 'magic') && !hasStyle(o.kit, 'ranged')));
        const guarded = o.readOverheads === false ? new Set<Style>() : protectedStyles(seen?.headicons);
        const styleUsable = (st: Style) => hasStyle(o.kit, st) && (st !== 'melee' || canReachMelee);
        const turns = fled && o.fledRotation?.length ? o.fledRotation : rotation;
        const rotationTurn = nextStyle(turns, last, st => styleUsable(st) && !guarded.has(st)) ?? nextStyle(turns, last, styleUsable) ?? nextStyle(turns, last, st => hasStyle(o.kit, st));
        // The styles open now: usable and not under the opponent's overhead.
        const open = [...new Set(turns)].filter(st => styleUsable(st) && !guarded.has(st));
        // adaptStyles: the tick after an attack shows the overhead it met. The loop learns from that which way to
        // choose the next style (StyleArms in pk-read.ts): one its overhead does not show, or the one it shows, which
        // an opponent that predicts is about to leave. The way is set once for each attack.
        if (lastStyle && now === lastAttackAt + 1) {
            arms.record(lastArm, protectedStyles(seen?.headicons).has(lastStyle));
            arm = o.adaptStyles ? arms.pick(rand) : 'avoid';
        }
        const shownStyle = arm === 'into' ? [...protectedStyles(seen?.headicons)].find(st => turns.includes(st) && styleUsable(st)) : undefined;
        const chosen = shownStyle ? shownStyle : !open.length ? null
            : o.styleByArmour && seen ? weakestFirst(armourDefence(seen.worn.map(id => names.get(id) ?? ''))).find(st => open.includes(st)) ?? null
            : o.mixStyles ? open[Math.floor(rand() * open.length)]! : null;
        const upcomingTurn = chosen ? { style: chosen, index: Math.max(0, turns.indexOf(chosen)) } : rotationTurn;
        const burstBow = o.bowBurst !== undefined ? bowSpec(o.kit, names) : undefined;
        const burstRange = burstBow ? weaponRange(burstBow.kit[0]!, names) ?? BOW_RANGE : BOW_RANGE;
        const bursting = !dying && !!burstBow && special(s.client).energy >= burstBow.cost && (fled || lowHealth(seen, o.bowBurst!)) && cheb(at, target) <= burstRange;
        if (pjedByNpc) {
            pjedByNpc = false;
            if (!hitter && typeof sdk.sendInteractNpc === 'function') {
                // Only an NPC that faces a player close by: the server also sends the message for a player's hit, and in
                // the first 8 ticks of a new world (pvp_combat.rs2:110), and a far NPC is then no reason to leave the fight.
                const npc = (state.nearbyNpcs ?? [])
                    .filter(n => (n.hp === null || n.hp > 0) && n.targetIndex >= 32768 && n.distance <= 8 && n.optionsWithIndex?.some(op => /^attack$/i.test(op.text)))
                    .sort((a, b) => Number(b.inCombat) - Number(a.inCombat) || a.distance - b.distance)[0];
                const op = npc?.optionsWithIndex.find(x => /^attack$/i.test(x.text));
                if (npc && op) {
                    for (const id of [...(o.kit.melee ?? []), ...tankIds]) {
                        if (state.equipment.some(e => e.id === id)) continue;
                        const item = slotOf([id]);
                        // NPC distance is Chebyshev: even distance 1 can need MOVE_OPCLICK before OPNPC.
                        if (item && sentEvents < 3) use(item, /^(Wield|Wear)$/i);
                    }
                    void sdk.sendInteractNpc(npc.index, op.opIndex);
                    nextAttack = now + 8;
                    continue;
                }
            }
        }
        // kiteMelee: against a target that holds a melee weapon, freezes and steps only (see the option). The freeze goes
        // out through the attack turn below; on every other tick the account keeps its distance: up to kiteMelee tiles
        // (never past the 10-tile hold, pvp_magic.rs2 pvp_frozen) while the target is held, a run straight away from it
        // while it is free or immune. The run stays 10 tiles inside the Wilderness, so an escape never counts as a dodge.
        const kiteTarget = o.kiteMelee !== undefined && weaponStyle(seen?.worn[3]) === 'melee';
        let kiteCast = false;
        if (kiteTarget) {
            const gap = cheb(at, target), held = now < frozenUntil;
            const kiteRunes = inv.some(i => i.id === ITEMS.natureRune || i.id === ITEMS.earthRune || i.id === ITEMS.waterRune);
            const kiteMagic = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
            kitePaths ??= await import('../vendor/rs-sdk/sdk/pathfinding');
            kiteLos ??= await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
            kitePaths.initPathfinding();
            const level = me.level ?? 0;
            // The server casts only with a line of sight to the target (GameMap.ts isApproached); without one it walks the
            // account toward the target to find one. CollisionFlag.PLAYER is the engine's BLOCK_NPC_AND_PLAYERS (0x100000).
            const foe = target, sight = (from: { x: number; z: number }) => kiteLos!.hasLineOfSight(level, from.x, from.z, foe.x, foe.z, 1, 1, 1, 1, kiteLos!.CollisionFlag.PLAYER);
            kiteCast = !held && now >= freezeReady && now >= nextAttack && gap <= 10 && sight(at)
                && (kiteRunes ? castableFreeze(kiteMagic, inv) : hasStyle(o.kit, 'magic') ? freezeSpell(kiteMagic) : null) !== null;
            // A spell click while the account still runs is re-pathed and mostly never cast (Player.ts tryInteract: the
            // ap trigger runs only within the approach distance after movement). So the account stops first, and casts on
            // the next tick, stood still.
            if (kiteCast && !stoodStill) { walk(at.x, at.z); kiteCast = false; stepAt = now; kiteStopAt = now; }
            const want = held ? Math.min(o.kiteMelee!, 10) : 10;
            // After a cast the account holds still until the hold shows (the target stood a tick: held two ticks after the
            // cast), 3 ticks at most: the server re-queues the spell while our attack delay runs (pvp_magic.rs2
            // pvp_combat_spell_checks), and a walk click clears it.
            const casting = now <= freezeCastAt + 3 && !(held && now >= freezeCastAt + 2);
            if (!kiteCast && !casting && kiteStopAt !== now && gap < want && now >= selfFrozenUntil) {
                // The step: of the tiles 6 out in the 8 directions, the one with a path whose end is farthest from the
                // target. A tile behind a wall has no path, and the client sends no click for it.
                let best: { x: number; z: number } | null = null, bestScore = -Infinity;
                for (const [ddx, ddz] of KITE_DIRS) {
                    const to = { x: at.x + ddx * 6, z: Math.max(3530, at.z + ddz * 6) };
                    const path = kitePaths.findLongPath(level, at.x, at.z, to.x, to.z, 40);
                    const end = path[path.length - 1];
                    if (!end) continue;
                    // Farthest from the target, then a tile with a line of sight for the next cast, then straight away.
                    const score = cheb(end, target) * 2 + (sight(end) ? 3 : 0) + (ddx * Math.sign(at.x - target.x) + ddz * Math.sign(at.z - target.z));
                    if (score > bestScore) { bestScore = score; best = { x: end.x, z: end.z }; }
                }
                if (best && cheb(best, target) > gap && walk(best.x, best.z)) stepAt = now;
            }
        }
        // Cooldown and attack ticks share one freeze/special readiness evaluation so prayer flicks, fakie decoys, and burst armour stripping stay consistent.
        const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
        const hasFreezeRunes = inv.some(i => i.id === ITEMS.natureRune || i.id === ITEMS.earthRune || i.id === ITEMS.waterRune);
        const freezeMagic = Math.min(magicLevel, o.freezeMagicCap ?? magicLevel);
        const freeze = freezeRule ? (hasFreezeRunes ? castableFreeze(freezeMagic, inv) : freezeSpell(freezeMagic)) : null;
        const belowFreezeFloor = freezeRule === 'low' && o.freezeFloor !== undefined && now >= fleeingUntil && adjacent(at, target)
            && !!seen && seen.totalHealth > 0 && seen.health > 0 && seen.health / seen.totalHealth <= o.freezeFloor;
        const freezeWindowDue = freeze !== null && !dying && !belowFreezeFloor && (hasStyle(o.kit, 'magic') || hasFreezeRunes) && now >= freezeReady && now >= frozenUntil
            && (freezeRule === true || now < fleeingUntil || (o.openFreeze === true && !hasAttacked) || (freezeRule === 'low' && earlyFreezes < (o.freezeEarlyMax ?? Infinity) && lowHealth(seen, o.freezeBelow ?? 0.62)))
            && !(o.freezeShare && o.freezeShare.clock() < o.freezeShare.until);
        const energy = special(s.client);
        const stunOverlap = o.stunShare?.overlap ?? 1;
        const targetStunned = now < targetStunnedUntil || (!!o.stunShare && o.stunShare.clock() < (o.stunShare.stunnedUntil ?? -1));
        const stunOpenForChain = o.stunShare ? o.stunShare.clock() >= o.stunShare.until - stunOverlap : !targetStunned;
        const specPlan = evaluateSpecPlan({
            dying, canReachMelee, fled, running: now < fleeingUntil, castFreezePending: freezeWindowDue,
            kiteTarget, at, target, guarded, seen, energy: energy.energy, lastSpecStyle, targetStunned, stunOpenForChain,
            spec: o.spec, stunSpec: o.stunSpec, burstBow, bursting, bowBurstArmour: o.bowBurstArmour,
            bowSpecFallback: o.spec ? bowSpec(o.kit, names) : undefined,
            fledSpec: o.fledSpec, specReserve: o.specReserve, burstOnHold: o.burstOnHold, burstOnStun: o.burstOnStun,
            freezeShareHeld: !!o.freezeShare && o.freezeShare.clock() < (o.freezeShare.heldUntil ?? -1),
            stunShare: o.stunShare,
            hasWeaponAndShield: state.equipment.some(e => e.slot === 3) && state.equipment.some(e => e.slot === 5),
            invLength: inv.length, nearbyPlayers: state.nearbyPlayers, allies: o.allies, volleyBelow: o.volley?.below, names,
        });
        // Cooldown ticks: never send OpHeld/InvButton (which call clearPendingAction on the server), but configure
        // prayers and one-time combat-style settings once any melee approach walk has finished.
        if (now < nextAttack || unattackableSince >= 0) {
            let budget = 5 - sentEvents;
            const walkingToMelee = now <= lastAttackAt + lastWalkTicks;
            const flickEvery = o.flickEvery ?? (lastStyle === 'ranged' || upcomingTurn?.style === 'ranged' ? 3 : 4);
            let didFlick = false;
            const kiteStep = (heldMelee && (o.stepUnderFrozen || o.diagonalFrozen || kiteTiles)) || o.standOff
                ? pickFrozenKiteTile({
                    at, target,
                    stepUnder: heldMelee && !!o.stepUnderFrozen,
                    diagonal: heldMelee && !o.stepUnderFrozen && !!o.diagonalFrozen,
                    standOff: o.standOff,
                    kiteFrozen: heldMelee ? kiteTiles : undefined,
                    frozen: now < frozenUntil,
                    canWalkTo: kitePaths ? (wx, wz) => {
                        const path = kitePaths!.findLongPath(me.level ?? 0, at.x, at.z, wx, wz, 16);
                        const end = path[path.length - 1];
                        return !!end && end.x === wx && end.z === wz;
                    } : undefined,
                })
                : null;
            const skipStandOffMelee = !!o.standOff && !heldMelee && upcomingTurn?.style === 'melee';
            // The tick holds five packets. A due flick uses them first. Prayer set-up keeps one packet for a due
            // stand-off step and one for the one-time style setting; the prayers it leaves go out on the next tick.
            const stepDue = !!kiteStep && !walkingToMelee && !skipStandOffMelee && now > lastAttackAt && now >= selfFrozenUntil && now - stepAt >= 2;
            const styleDue = !walkingToMelee && !rapidSet && !!state.combatStyle && state.combatStyle.styles.length > 1 && state.combatStyle.currentStyle !== 1;
            if (prayers.prayerPoints > 0) {
                const plan = planPrayerTick({
                    setupBudget: Math.max(0, budget - Number(stepDue) - Number(styleDue)),
                    now, nextAttack, lastAttackAt, walkingToMelee, prayerBase, overhead,
                    activePrayers: prayers.activePrayers, prayerDrainAt, flickAt, flickEvery,
                    zeroDrainFlick: o.zeroDrainFlick === true,
                    prayerFlick: o.prayerFlick !== false,
                    offensiveFlick: o.offensiveFlick === true,
                    upcomingStyle: upcomingTurn?.style ?? null,
                    specMeleeLikely: specPlan.specMeleeLikely,
                    defencePrayer: o.defencePrayer !== false && !specPlan.stripBurstArmour,
                    protectItem: protectItemNow(),
                    budget,
                });
                for (const p of plan.toggles) { void sdk.sendTogglePrayer(p); budget--; }
                prayerDrainAt = plan.nextDrainAt;
                flickAt = plan.nextFlickAt;
                didFlick = plan.didFlick;
                if (didFlick) {
                    result.flicks = (result.flicks ?? 0) + 1;
                }
            }
            if (stepDue && budget > 0 && walk(kiteStep!.x, kiteStep!.z)) { budget--; stepAt = now; }
            if (styleDue && budget > 0) {
                void sdk.sendSetCombatStyle?.(1);
                rapidSet = true;
                budget--;
            }
            // The tick before a bow special of the burst: armour off when stripBurstArmour holds, as far as packets and free pack slots allow.
            if (specPlan.stripBurstArmour && now === nextAttack - 1 && typeof sdk.sendUseEquipmentItem === 'function' && budget > 1) {
                const free = 28 - inv.length - 1;
                for (const eq of negativeCastArmour(state.equipment, 'magic', new Set(), names).filter(e => !(torsoLocked && DRAGON_SLAYER_BODY.test(names.get(e.id) ?? ''))).slice(0, Math.max(0, Math.min(budget - 1, free)))) {
                    tankIds.add(eq.id); void sdk.sendUseEquipmentItem(eq.slot, 1); budget--;
                    log(`PK burst takes off ${names.get(eq.id)}`);
                }
            }
            // 1-tick fakie switch: hold a decoy weapon style during cooldown (accounting for upcoming melee/ranged specs), then swap back on the attack tick.
            const castingFreeze = now <= freezeCastAt + 3 && !(now < frozenUntil && now >= freezeCastAt + 2);
            const fakieRealStyle = specPlan.triggerNoVolley ? specPlan.specStyle : freezeWindowDue ? 'magic' : upcomingTurn?.style;
            if (o.fakieSwitch && fakieRealStyle && hasAttacked && now > lastAttackAt && now < nextAttack - 1 && !walkingToMelee && !castingFreeze && lastFakieAt < lastAttackAt && budget >= 1) {
                const decoy = pickFakieWeapon({
                    kit: o.kit, realStyle: fakieRealStyle, preferred: o.fakieSwitch,
                    inventory: inv, equipment: state.equipment, names,
                });
                if (decoy) {
                    void sdk.sendUseItem(decoy.slot, decoy.opIndex);
                    lastFakieAt = now;
                    budget--;
                }
            }
            continue;
        }
        // kiteMelee: an attack tick with no freeze to cast is a step, not a hit.
        if (kiteTarget && !kiteCast) continue;
        // Charge goes out on an attack tick, in place of that attack: a button on a cooldown tick could clear an attack
        // that the server still has in hand. One try each 6 ticks, until the game confirms it or varp 272 > 0.
        const chargeVarp = chargeVarpTicks(s.client);
        if (chargeVarp !== undefined) charged = chargeVarp > 0;
        if (o.charge && !charged && now - chargeAt >= 6 && canCastChargeNow(magicLevel, inv, chargeVarp)) {
            log('PK cast Charge');
            void sdk.sendClickComponent(SPELLS.charge);
            chargeAt = now; nextAttack = now + 2;
            continue;
        }
        // Dragon Battleaxe warcry (specwep.rs2:61-78): 100% energy immediate Strength buff when carrying item 1377.
        const hasBattleaxe = state.equipment.some(e => e.id === ITEMS.dragonBattleaxe) || inv.some(i => i.id === ITEMS.dragonBattleaxe);
        const strSkill = state.skills.find(k => k.name === 'Strength');
        if (o.battleaxeBuff && hasBattleaxe && !kiteTarget && now - battleaxeAt >= 12 && energy.energy >= 1000
            && (!strSkill || strSkill.level <= strSkill.baseLevel + 4)) {
            const axeItem = state.equipment.some(e => e.id === ITEMS.dragonBattleaxe) ? undefined : slotOf([ITEMS.dragonBattleaxe]);
            if (axeItem) use(axeItem, /^(Wield|Wear)$/i);
            void sdk.sendClickComponent(componentId('combat_axe:specbar'));
            log('PK Dragon Battleaxe warcry');
            battleaxeAt = now;
            result.specs++;
            nextAttack = Math.max(nextAttack, now + 1);
            continue;
        }
        // When not cardinally adjacent, client interactPlayer/spellOnPlayer emits MOVE_OPCLICK + OPPLAYER* (2 USER_EVENT packets).
        const attackPackets = adjacent(at, target) ? 1 : 2;
        const castFreeze = freezeWindowDue && (o.freezeStill !== true || (cheb(at, target) <= 10 && await lineOfSight(me.level ?? 0, at, target)));
        // freezeStill: a moving account stops on this tick and casts from its stand on the next.
        if (castFreeze && o.freezeStill === true && !stoodStill && !kiteTarget) { void sdk.sendWalk(at.x, at.z); continue; }
        const { spec, specStyle, specRange, chainStun, freezeHeld, burstStun, stripBurstArmour } = specPlan;
        const vs = o.volley && spec ? o.volley.state(targetName.toLowerCase()) : undefined, myKey = (s.name ?? '').toLowerCase();
        if (vs && vs.fired && o.volley!.clock() - vs.first >= Math.max(4, o.volley!.window + 3)) {
            vs.ready.clear(); vs.done.clear(); vs.first = -1; vs.fired = false;
        }
        if (vs && !vs.fired) {
            const allyNearTarget = (o.allies?.length ?? 0) > 0
                ? state.nearbyPlayers.filter(p => o.allies!.includes(p.name.toLowerCase()) && cheb(p, target!) <= (specStyle === 'melee' ? 2 : specRange + 2)).length
                : 0;
            if (specPlan.volleyJoinEligible && (o.volley!.members <= 1 || vs.ready.size >= 2 || allyNearTarget > 0 || vs.first >= 0)) {
                vs.ready.add(myKey);
                if (vs.first < 0) vs.first = o.volley!.clock();
            } else vs.ready.delete(myKey);
            if (vs.ready.size >= o.volley!.members || (vs.first >= 0 && o.volley!.clock() - vs.first >= o.volley!.window)) {
                vs.fired = true; log(`PK volley with ${vs.ready.size} of ${o.volley!.members} ready`);
            } else if (specPlan.volleyJoinEligible && (vs.ready.has(myKey) && allyNearTarget > 0)) continue;
        }
        const volleying = (!!vs?.fired && !vs.done.has(myKey)) || freezeHeld || burstStun;
        if (spec && (specPlan.triggerNoVolley || (volleying && specPlan.volleyJoinEligible))) {
            let budget = 5 - sentEvents - attackPackets - (energy.on ? 0 : 1);
            const toWield: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[] = [];
            const specWieldIds = spec.kit.some(id => isDragonSpearName(names.get(id) ?? '')) ? spec.kit : [...spec.kit, ...(specStyle === 'melee' ? tankIds : [])];
            for (const id of specWieldIds) {
                if (state.equipment.some(e => e.id === id)) continue;
                const item = slotOf([id]);
                if (item && toWield.length < budget) toWield.push(item);
            }
            budget -= toWield.length;
            if (o.meleeStyle !== undefined && specStyle === 'melee' && state.combatStyle && state.combatStyle.currentStyle !== o.meleeStyle && budget > 0) { void sdk.sendSetCombatStyle?.(o.meleeStyle); budget--; }
            if (prayers.prayerPoints > 0 && budget > 0) {
                const { want: wantPray } = combatPrayers(prayerBase, overhead, specStyle === 'melee', o.defencePrayer !== false && !stripBurstArmour, protectItemNow());
                const orderedPray = [...wantPray].sort((a, b) => Number(b === overhead || isOverheadPrayer(b)) - Number(a === overhead || isOverheadPrayer(a)));
                const hadPrayer = prayers.activePrayers.some(Boolean);
                let turnedOn = 0;
                for (const p of orderedPray) if (!prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; turnedOn++; }
                if (!hadPrayer && turnedOn > 0 && prayerDrainAt < 0) prayerDrainAt = now;
            }
            for (const item of toWield) use(item, /^(Wield|Wear)$/i);
            // The reasons that let this special go (specReasons): which path fired it, so that a special at full health names the rule that allowed it.
            log(`PK special ${specStyle} energy ${energy.energy} on ${energy.on} target ${seen?.health}/${seen?.totalHealth} by ${specReasons({ fled: fled && o.fledSpec !== false, bursting, volleying, chainStun, low: lowHealth(seen, spec.below) })}`);
            if (!energy.on) void sdk.sendClickComponent(componentId(spec.bar));
            void sdk.sendInteractPlayer(target.index, 2);
            result.specs++; result.attacks[specStyle]++; lastSpecStyle = specStyle;
            if (vs) vs.done.add(myKey);
            const walkTicks = specStyle === 'melee' ? meleeApproachTicks(cheb(at, target) - 1, me.runEnergy) : 0;
            if (spec.stun) {
                targetStunnedUntil = Math.max(targetStunnedUntil, now + walkTicks + spec.stun + 1);
                if (o.stunShare) {
                    const nextStunEnd = Math.max(o.stunShare.until, o.stunShare.clock() + walkTicks) + spec.stun + 1;
                    o.stunShare.until = nextStunEnd;
                    o.stunShare.stunnedUntil = Math.max(o.stunShare.stunnedUntil ?? -1, nextStunEnd);
                }
            }
            last = Math.max(0, rotation.indexOf(specStyle));
            // pvp_special_attack.rs2:35 always uses oc_param($weapon, attackrate) (4 for MSB/DDS/claws, 5 for longsword/mace, 6 for spear), ignoring Rapid.
            const delay = specStyle === 'melee' ? meleeWeaponDelay(spec.kit, names) : TURN[specStyle];
            if (specStyle === 'melee' && walkTicks === 0 && spec.kit.some(id => /^dragon_dagger/.test(names.get(id) ?? ''))) {
                delayedUntil = Math.max(delayedUntil, now + 2); // pvp_dragon_dagger.rs2:11 p_delay(0)
            }
            lastAttackAt = now; lastWalkTicks = walkTicks;
            nextAttack = now + walkTicks + delay;
            hasAttacked = true;
            continue;
        }
        // Hit off the opponent's overhead: a style they protect against loses 40% of its max hit.
        const turn = castFreeze ? { style: 'magic' as Style, index: last } : upcomingTurn;
        if (!turn) continue;
        const rawMeleeIds = o.kit.melee ?? [];
        const nonSpearMelee = rawMeleeIds.filter(id => !isDragonSpearName(names.get(id) ?? '') && id !== ITEMS.dragonBattleaxe);
        const meleeIds = nonSpearMelee.some(id => !/(shield)$/.test(names.get(id) ?? '')) ? nonSpearMelee : rawMeleeIds;
        const turnIds = turn.style === 'ranged' ? shootingKit(o.kit, names) : turn.style === 'melee' ? meleeIds : (o.kit[turn.style] ?? []);
        const kitIds = new Set(turnIds);
        const switching2H = (turn.style === 'ranged' || (turn.style === 'melee' && meleeIds.some(id => isDragonSpearName(names.get(id) ?? '') || /(2h_sword|halberd)/.test(names.get(id) ?? ''))))
            && state.equipment.some(e => e.slot === 3) && state.equipment.some(e => e.slot === 5);
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
        let budget = 5 - sentEvents - attackPackets;
        const toWield: { slot: number; optionsWithIndex: { text: string; opIndex: number }[] }[] = [];
        const keepWeapon = castFreeze && hasFreezeRunes && o.freezeWithStaff !== true;
        // freezeWear: items (debugnames) worn for a freeze cast, such as a god cape (magic attack +10); the other turns'
        // switch lists put the usual ones back (pk-kits tribrid-dragon-capeswap).
        const freezeWear = castFreeze && o.freezeWear ? inv.filter(i => o.freezeWear!.includes(names.get(i.id) ?? '')).map(i => i.id) : [];
        for (const id of [...freezeWear, ...(keepWeapon ? [] : [...turnIds, ...(turn.style === 'melee' ? tankIds : [])])]) {
            if (state.equipment.some(e => e.id === id)) continue;
            const item = slotOf([id]);
            if (item && toWield.length < budget) toWield.push(item);
        }
        budget -= toWield.length;
        // meleeStyle: the combat style of a melee turn (dagger 0 Stab accurate +3 Attack, 1 Lunge aggressive +3
        // Strength); a bow turn goes back to 1 (rapid). One index serves every weapon, so each change costs a packet.
        if (o.meleeStyle !== undefined && state.combatStyle && state.combatStyle.styles.length > 1 && budget > 0) {
            const want = turn.style === 'melee' ? o.meleeStyle : turn.style === 'ranged' ? 1 : state.combatStyle.currentStyle;
            if (state.combatStyle.currentStyle !== want) { void sdk.sendSetCombatStyle?.(want); budget--; }
        }
        // dropForStrip: a freeze on a target that fled, at high health with food to spare, drops one food a tick until
        // the pack has `free` slots, so the strip before the cast takes off more penalising armour (finding 72: the
        // dragon kit catches 32 runners with 14 sharks and 17 with 18, but 14 sharks lose the rival fights).
        const dfs = o.dropForStrip, foods = dfs ? inv.filter(i => i.optionsWithIndex.some(op => /^eat$/i.test(op.text))) : [];
        if (dfs && castFreeze && (fled || dfs.always === true) && 28 - inv.length < dfs.free && foods.length > dfs.minFood && me.hp >= me.maxHp * dfs.hpAbove && budget > 1 && typeof sdk.sendDropItem === 'function') {
            void sdk.sendDropItem(foods[foods.length - 1]!.slot); budget--; log(`PK drops a food for the strip, ${foods.length - 1} left`);
        }
        const freeSlots = 28 - inv.length - (switching2H ? 1 : 0);
        const armourStrip = (castFreeze ? (o.freezeArmour ?? 'torso') : (o.castArmour ?? 'torso')) === 'strip';
        // A freeze on a target that has fled decides the chase, and the runner does not hit back: every piece that
        // cuts the magic attack roll comes off for it (platelegs -21, kiteshield -8, full helm -6), as far as the
        // packets and free pack slots of this tick allow. Any other cast takes off the torso alone.
        const strip = (castFreeze && fled && o.freezeStrip !== false) || (armourStrip && me.hp > oppMax + 12);
        // castArmour governs a shot or a damage spell, freezeArmour a freeze (default 'torso'): a freeze that misses lets
        // a runner go, and plate leaves the magic roll near 0. The freeze on a fled target strips under freezeStrip.
        const armourRule = castFreeze ? (o.freezeArmour ?? 'torso') : (o.castArmour ?? 'torso');
        const toRemove = (armourRule !== 'keep' || strip) && turn.style !== 'melee' && typeof sdk.sendUseEquipmentItem === 'function' && (strip || me.hp > oppMax + 12) && freeSlots >= 1 && budget >= 1
            ? negativeCastArmour(state.equipment, turn.style, kitIds, names).filter(eq => !(torsoLocked && DRAGON_SLAYER_BODY.test(names.get(eq.id) ?? '')))
                .filter(eq => strip || eq.slot === 4).slice(0, strip ? Math.min(budget, freeSlots) : 1)
            : [];
        budget -= toRemove.length;
        if (prayers.prayerPoints > 0 && budget > 0) {
            const { want: wantPray, off: offPray } = combatPrayers(prayerBase, overhead, turn.style === 'melee', o.defencePrayer !== false, protectItemNow());
            const orderedPray = [...wantPray].sort((a, b) => Number(b === overhead || isOverheadPrayer(b)) - Number(a === overhead || isOverheadPrayer(a)));
            const hadPrayer = prayers.activePrayers.some(Boolean);
            let turnedOn = 0;
            for (const p of orderedPray) if (!prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; turnedOn++; }
            if (o.offensiveFlick) for (const p of offPray) if (prayers.activePrayers[p] && budget > 0) { void sdk.sendTogglePrayer(p); budget--; }
            if (!hadPrayer && turnedOn > 0 && prayerDrainAt < 0) prayerDrainAt = now;
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
                log(`PK freeze cast at distance ${cheb(at, target)}, target health ${seen?.health}/${seen?.totalHealth}, target protects ${[...guarded].join('+') || 'nothing'}`);
                result.freezes++;
                if (now >= fleeingUntil) earlyFreezes++;
                const dur = freezeDuration(freeze!, guarded.has('magic'));
                if (o.freezeShare) o.freezeShare.until = o.freezeShare.clock() + (o.freezeShare.stagger ?? dur + 5);
                freezeDur = dur;
                frozenUntil = now + dur;
                freezeReady = now + dur + 5;
                freezeCastAt = now;
                frozenTile = { x: target.x, z: target.z };
            }
        } else void sdk.sendInteractPlayer(target.index, 2);
        result.attacks[turn.style]++;
        lastStyle = turn.style;
        lastArm = shownStyle !== undefined && turn.style === shownStyle ? 'into' : 'avoid';
        last = turn.index;
        const walkTicks = turn.style === 'melee' ? meleeApproachTicks(cheb(at, target) - 1, me.runEnergy) : 0;
        const delay = turn.style === 'ranged' ? rangedWeaponDelay(o.kit.ranged, rapidSet, names) : turn.style === 'melee' ? meleeWeaponDelay(meleeIds, names) : TURN[turn.style];
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
    await settleKillFeed();
    await finish([s], r.outcome === 'kill', `${r.outcome} ${killReceiptProof(r.receipt ? [r.receipt] : [])} ${JSON.stringify(r)}`);
}
