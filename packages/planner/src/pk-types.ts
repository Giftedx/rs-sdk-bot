export const SPELLS = {
    fireStrike: 1158, fireBolt: 1169, fireBlast: 1181, fireWave: 1189,
    saradominStrike: 1190, clawsOfGuthix: 1191, flamesOfZamorak: 1192, charge: 1193, ibanBlast: 1539,
    bind: 1572, snare: 1582, entangle: 1592,
    // Teleports work up to Wilderness level 20 (skill_magic/scripts/spells/teleport.rs2:17); Varrock costs 1 law, 3 air, 1 fire.
    varrockTeleport: 1164, lumbridgeTeleport: 1167, faladorTeleport: 1170, camelotTeleport: 1174,
} as const;

export type Style = 'magic' | 'ranged' | 'melee';
export type Kit = { [S in Style]?: number[] };
// stun: the ticks the special holds the target with no input (the dragon spear's, 4).
export type SpecConfig = { kit: number[]; bar: string; cost: number; below: number; style?: Style; stun?: number };
export type VolleyState = { ready: Set<string>; first: number; fired: boolean; done: Set<string> };

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
    // Eat threshold override used whenever the account currently holds no karambwan (e.g. Pure Sharks or after combo food is exhausted).
    noComboEatAt?: number;
    // Only strip full freeze armour when fleeing or safely above combo-eat HP under single-attacker pressure; otherwise strip torso only.
    safeStrip?: boolean;
    // Shared game-message deduplication keys across fight calls so delayed/cross-target PvP kills credit exactly once.
    seenKillKeys?: Set<string>;
    // Invoked when a PvP death message for a player other than the current `targetName` arrives during combat (e.g. recoil, poison, or post-switch).
    onOtherKill?: (victim: string, info: { text: string; tick: number }) => void;
    maxWild?: number;
    maxDistance?: number;
    stop?: () => boolean;
    cap?: number;
    log?: (line: string) => void;
};
