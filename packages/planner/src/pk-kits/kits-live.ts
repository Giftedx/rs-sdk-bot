// Gang-hunter, live-walker, single-style, and cheaper metal tribrid kit definitions.
import { BOOSTS, FREEZE, PRAYER_POTS, RUNE, WAVE, trained, type KitSpec } from './model';

export const LIVE_KITS: Readonly<Record<string, KitSpec>> = {
    // The cheapest kit that clears the dagger gang at its most (research/pvp-fight-loop.md, "Rivals: the dagger gang"):
    // bow and dagger, an adamant platebody with mithril helm, legs and shield, steel arrows, the three boosts, a super
    // defence and a super antipoison (the gang's daggers are poisoned). It carries no prayer potion: its profile holds
    // the prayers with a flick each 2 ticks. Its way out is the glory that it wears.
    'gang-hunter': { worn: { hat: 'mithril_full_helm', torso: 'adamant_platebody', legs: 'mithril_platelegs', shield: 'mithril_kiteshield', amulet: 'amulet_of_glory_4', cape: 'black_cape', feet: 'leather_boots',
        weapon: 'dragon_dagger_p', ammo: ['steel_arrow', 150] },
        carried: ['magic_shortbow', ...BOOSTS, '4dose2defense', '4dose2antipoison'], food: 21,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'mithril_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The gang-hunter kit for a meeting at the edge of the Wilderness: an amulet of power for the glory. Its way out is
    // a walk south over the edge.
    'edge-hunter': { worn: { hat: 'mithril_full_helm', torso: 'adamant_platebody', legs: 'mithril_platelegs', shield: 'mithril_kiteshield', amulet: 'amulet_of_power', cape: 'black_cape', feet: 'leather_boots',
        weapon: 'dragon_dagger_p', ammo: ['steel_arrow', 150] },
        carried: ['magic_shortbow', ...BOOSTS, '4dose2defense', '4dose2antipoison'], food: 21,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'mithril_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The cheapest kit that clears the dagger gang at its most with one pack and no step out of the Wilderness: the
    // gang-hunter kit with an amulet of power for the glory and the runes of Camelot Teleport for the way out. The
    // account drinks the four boosts at the bank and takes sharks for their slots (scripts/pk-gang.ts SPAR_PRETRIP):
    // it walks in with 23 sharks.
    'gang-walker': { worn: { hat: 'mithril_full_helm', torso: 'adamant_platebody', legs: 'mithril_platelegs', shield: 'mithril_kiteshield', amulet: 'amulet_of_power', cape: 'black_cape', feet: 'leather_boots',
        weapon: 'dragon_dagger_p', ammo: ['steel_arrow', 150] },
        carried: ['magic_shortbow', ...BOOSTS, '4dose2defense', '4dose2antipoison', ['lawrune', 2], ['airrune', 10]], food: 19,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'mithril_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The gang-walker kit as the live market lets Mightyrod fill it: adamant helm, body and legs, no shield (the GE has
    // no kiteshield for sale), the plain dragon dagger, no ranging potion, super defence and antipoison of three doses.
    'live-walker': { worn: { hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['steel_arrow', 150] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The live kit with what the shops and the GE had: no helm, iron arrows.
    'live-walker-iron': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // live-walker-iron with the three prayer potions that the live pilot takes from its bank (scripts/pk-live/live-pilot.ts, up to 3
    // of POTIONS), in place of the defence potion and two sharks: the bench kit has no prayer potion.
    'live-walker-iron-pray': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3doseantipoison', ...PRAYER_POTS, '4doseprayerrestore', ['lawrune', 2], ['airrune', 10]], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // live-walker-iron with a ring of life and with a ring of recoil in the ring slot (research/pvp-fight-loop.md, "Rings").
    'live-walker-iron-life': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ring: 'ring_of_life', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-recoil': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ring: 'ring_of_recoil', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // live-walker-iron with the runes of 10 Entangles (5 earth, 5 water, 4 nature a cast) for 3 sharks: the freeze holds
    // a gang account that walks out of the Wilderness (FightOptions freeze 'flee'; the cast keeps the weapon in hand).
    'live-walker-iron-snare': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // live-walker-iron with the poisoned dagger: a hit that deals damage poisons at 1 in 4 (pvp_melee.rs2:50, the
    // special at pvp_dragon_dagger.rs2:35), severity 20: 4 damage each 30 ticks, 50 in all (poison.rs2). The gang
    // carries no antipoison, so the poison goes on through its walk out of the Wilderness.
    'live-walker-iron-p': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    // The same with a super antipoison in place of the antipoison: 600 ticks with no poison a dose, not 150
    // (anti_poison.rs2 sets %poison to -20, not -5), so one drink covers most of a meeting with the gang's dagger(p).
    'live-walker-iron-psuper': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3dose2antipoison', ['lawrune', 2], ['airrune', 10]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    // The measured kit options against the bench gang (research/pvp-fight-loop.md, "Measured gang kit options"): the snare
    // kit's Entangle runes for freeze 'flee' and the poisoned dagger with a super antipoison, for 3 sharks (17).
    'live-walker-iron-snarep': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3dose2antipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    // The cost of a kill (scripts/measure/aio-bench-cases.ts extra:gang-live-cheap-*): live-walker-iron-snare with
    // fewer bought supplies. nopot: no Attack, Strength or Defence potion; noanti: no antipoison; bare: neither.
    'live-walker-iron-snare-nopot': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-noanti': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-bare': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 21,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The same kit with a stronger arrow: the kill is faster, so the gang has fewer turns (cost of a kill).
    'live-walker-iron-snare-addy': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['adamant_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-rune': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-mith': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['mithril_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // Adamant arrows with the poisoned dagger and a super antipoison; -nopot without the boosts.
    'live-walker-iron-snare-addyp': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['adamant_arrow', 300] },
        carried: ['magic_shortbow', '4dose2attack', '4dose2strength', '3dose2defense', '3dose2antipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 17,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-addyp-nopot': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['adamant_arrow', 300] },
        carried: ['magic_shortbow', '3dose2antipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-p-nopot': { worn: { torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger_p', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3dose2antipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] } },
    // Worn armour is bought once and kept (no death in the gang sets), so only the food it saves counts: an adamant helm, and full rune.
    'live-walker-iron-snare-helm-nopot': { worn: { hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-rune-nopot': { worn: { hat: 'rune_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The rune kit with what NPC shops sell: no rune full helm has a shop (smithing only), so an adamant one; -cape adds the cape of legends.
    'live-walker-iron-snare-runeshop-nopot': { worn: { hat: 'adamant_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-snare-runeshop-cape-nopot': { worn: { hat: 'adamant_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', cape: 'cape_of_legends', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The rune kit on the least build that the gang's post lets fight it: combat 111 (Attack 75, Prayer 43 for Protect
    // from Melee, Magic 49 for Bind), within the Wilderness level 16 of the multi-way zone west of the post from the
    // gang's 126 (pvp_combat.rs2:32-48). About 25 million XP less than the maxed build.
    'live-walker-iron-snare-rune-nopot-b111': { worn: { hat: 'rune_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 20,
        skills: trained({ Attack: 75, Strength: 99, Defence: 99, Ranged: 99, Magic: 49, Prayer: 43 }),
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The live pilot's kit: rune chainbody (the platebody needs Dragon Slayer), no freeze runes (the rune shops' water
    // shelves were empty).
    'live-walker-iron-rune-chain': { worn: { hat: 'rune_full_helm', torso: 'rune_chainbody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10]], food: 23,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-rune-chain-bind': { worn: { hat: 'rune_full_helm', torso: 'rune_chainbody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 30], ['waterrune', 30], ['naturerune', 20]], food: 20,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // The live pilot's kit as it ran: no antipoison either (only junglestore sells it).
    // The bind kit with rune throwing axes for their special (scripts/pk.ts defaultSpec): the pack gives one food slot to
    // the axe stack, which chains the special onto up to 4 more players in multi-way combat.
    'live-walker-iron-rune-chain-bind-axe': { worn: { hat: 'rune_full_helm', torso: 'rune_chainbody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', '3doseantipoison', ['lawrune', 2], ['airrune', 10], ['earthrune', 30], ['waterrune', 30], ['naturerune', 20], ['rune_thrownaxe', 40]], food: 19,
        switches: { ranged: ['magic_shortbow', 'rune_thrownaxe'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    'live-walker-iron-rune-chain-bare': { worn: { hat: 'rune_full_helm', torso: 'rune_chainbody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', ['lawrune', 2], ['airrune', 10]], food: 24,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'] }, options: { rotation: ['ranged', 'melee'] } },
    // live-walker-iron-rune-chain-bare with Fire Blast runes (Aubury sells death runes) cast with the dagger in hand:
    // the gang's overhead follows the weapon that it sees (FightOptions prayerLag), so a spell from the dagger meets
    // Protect from Melee. Bind runes too.
    'live-walker-iron-rune-chain-blast': { worn: { hat: 'rune_full_helm', torso: 'rune_chainbody', legs: 'rune_platelegs', amulet: 'amulet_of_power', weapon: 'dragon_dagger', ammo: ['iron_arrow', 300] },
        carried: ['magic_shortbow', ['lawrune', 2], ['airrune', 250], ['firerune', 300], ['deathrune', 60], ['earthrune', 50], ['waterrune', 50], ['naturerune', 40]], food: 19,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger'], magic: ['dragon_dagger'] }, options: { rotation: ['magic', 'ranged', 'melee'] } },
    // One style each, in the armour of that style.
    melee: { worn: { ...RUNE, amulet: 'amulet_of_strength', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield' },
        carried: [...PRAYER_POTS, '4dose2attack', '4dose2strength'], food: 22, switches: { melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['melee'] } },
    ranger: { worn: { hat: 'coif', torso: 'dragonhide_body', legs: 'dragonhide_chaps', hands: 'dragon_vambraces', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'magic_shortbow', ammo: ['rune_arrow', 500] },
        carried: [...PRAYER_POTS, '4doserangerspotion'], food: 23, switches: { ranged: ['magic_shortbow'] }, options: { rotation: ['ranged'] } },
    mage: { worn: { hat: 'splitbark_helm', torso: 'splitbark_body', legs: 'splitbark_legs', hands: 'splitbark_gauntlets', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', weapon: 'mystic_fire_staff' },
        carried: [...WAVE, ...FREEZE, ...PRAYER_POTS], food: 20, switches: { magic: ['mystic_fire_staff'] }, options: { rotation: ['magic'] } },
    // Cheaper tribrids: each tier drops the metal, the bow, the arrows and the spell one step.
    'tribrid-adamant': { worn: { hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', feet: 'leather_boots', weapon: 'rune_scimitar', shield: 'adamant_kiteshield', ammo: ['adamant_arrow', 300] },
        carried: ['staff_of_fire', 'maple_shortbow', ['airrune', 500], ['deathrune', 150], ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['maple_shortbow'], melee: ['rune_scimitar', 'adamant_kiteshield'] } },
    'tribrid-mithril': { worn: { hat: 'mithril_full_helm', torso: 'mithril_platebody', legs: 'mithril_platelegs', amulet: 'amulet_of_power', feet: 'leather_boots', weapon: 'mithril_scimitar', shield: 'mithril_kiteshield', ammo: ['steel_arrow', 300] },
        carried: ['staff_of_fire', 'willow_shortbow', ['airrune', 500], ['chaosrune', 200], ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['willow_shortbow'], melee: ['mithril_scimitar', 'mithril_kiteshield'] } },
};
