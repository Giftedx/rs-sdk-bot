import { F, S } from './files';
import { box, zone } from './lookup';
import type { ExcludedSpec, Spec } from './types';

const CRASH_ISLAND_BOX = box('0_45_42_0_0', '0_45_42_63_63');
const DAERO_HANGAR_BOX_A = box('0_37_154_0_0', '0_37_154_63_63');
const DAERO_HANGAR_BOX_B = box('0_40_70_0_0', '0_41_71_63_63');
const APE_ATOLL_BOX = box('0_43_42_0_0', '0_43_42_63_63');
const LUMDO_ISLAND_BOX = box('0_42_143_0_0', '2_42_143_63_63');

const essence = (npc: string, op: number, file: string, trigger: string, ret: string): Spec => ({
    kind: 'npc-teleport', destination: 'Rune essence mine', npc, op,
    trigger: { file, needle: trigger },
    candidates: { file: F.essEnum, returnConst: ret, returnRadius: { file: F.ess, needle: 'def_coord $coord = map_findsquare(%exit_essence_mine_coord, 0, 2,' } },
    to: { at: { file: F.ess, needle: 'p_telejump($coord);' }, radius: { file: F.ess, needle: '$coord = map_findsquare($coord, 0, 1, ^map_findsquare_lineofsight);' } },
    fare: { coins: 0, free: 'teleport_to_essence_mine removes no coins' },
    requires: [{ varp: 'runemysteries', op: '>=', constant: 'runemysteries_complete', at: { file: F.ess, needle: 'if(%runemysteries < ^runemysteries_complete) {' } }],
    notes: [`The direct op${op} Teleport needs no dialogue. The mine exit portal returns the player to ^${ret}.`],
});
const gliderOut = (dest: string, label: string, com: string): Spec => ({
    kind: 'glider', destination: label, npc: 'gnomepilot', op: 1,
    trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
    options: ['Can you take me on the glider?'], optionsFile: F.glider,
    button: { file: F.glider, needle: `[if_button,glidermap:${com}] @gnomeglider_fly(^${dest});`, component: `glidermap:${com}` },
    from: { rule: 'pilot within 8 tiles of ^ta_quir_priw (calc_gliderstart)', at: { file: F.glider, needle: 'if(inzone(movecoord(^ta_quir_priw, -8, 0, -8)' }, keep: zone('ta_quir_priw', 8) },
    to: { at: { file: `${S}areas/area_gnome/configs/glider.constant`, needle: `^${dest} = ` }, radius: { file: F.glider, needle: 'p_teleport(map_findsquare($dest, 0, 1, ^map_findsquare_lineofwalk));' } },
    fare: { coins: 0, free: 'gnomeglider_fly removes no coins' },
    requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_complete', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' } }],
    members: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' },
    notes: ['Only legs that start or end at Ta Quir Priw fly (gnomeglider_fly refuses others).'],
});
const gliderHome = (start: string, label: string): Spec => ({
    kind: 'glider', destination: `Ta Quir Priw (Grand Tree) from ${label}`, npc: 'gnomepilot', op: 1,
    trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
    options: ['Can you take me on the glider?'], optionsFile: F.glider,
    button: { file: F.glider, needle: '[if_button,glidermap:com_22] @gnomeglider_fly(^ta_quir_priw);', component: 'glidermap:com_22' },
    from: { rule: `pilot within 8 tiles of ^${start} (${label}, calc_gliderstart)`, at: { file: F.glider, needle: `inzone(movecoord(^${start}, -8, 0, -8)` }, keep: zone(start, 8) },
    to: { at: { file: `${S}areas/area_gnome/configs/glider.constant`, needle: '^ta_quir_priw = ' }, radius: { file: F.glider, needle: 'p_teleport(map_findsquare($dest, 0, 1, ^map_findsquare_lineofwalk));' } },
    fare: { coins: 0, free: 'gnomeglider_fly removes no coins' },
    requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_complete', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' } }],
    members: { file: F.glider, needle: 'if(%grandtree = ^grandtree_complete & map_members = ^true) {' },
});

export const WORLD_SPECS: Spec[] = [
    // ---- tolls and passes ----
    {
        kind: 'toll', destination: 'Al Kharid (east of the toll gate)', npc: 'borderguard1', op: 1,
        trigger: { file: F.border, needle: '[opnpc1,borderguard1]' },
        options: ['Yes, ok.'], optionsFile: F.border,
        to: { at: { file: F.border, needle: 'def_coord $coord = 0_51_50_4_27;' }, offsets: [{ file: F.border, needle: '$coord = movecoord($coord, -1, 0, 0);' }, { file: F.border, needle: '$destination = movecoord(coord, 1, 0, 0);' }] },
        fare: { coins: 10, at: { file: F.border, needle: 'inv_del(inv, coins, 10);' } },
        notes: ['Free with %princequest >= ^prince_saved (no menu). The border_gate_toll_left/right loc op1 also starts this talk.'],
        requires: [],
    },
    {
        kind: 'toll', destination: 'Lumbridge side (west of the toll gate)', npc: 'borderguard2', op: 1,
        trigger: { file: F.border, needle: '[opnpc1,borderguard2]' },
        options: ['Yes, ok.'], optionsFile: F.border,
        to: { at: { file: F.border, needle: 'def_coord $coord = 0_51_50_4_27;' }, offsets: [{ file: F.border, needle: '$destination = movecoord(coord, -1, 0, 0);' }] },
        fare: { coins: 10, at: { file: F.border, needle: 'inv_del(inv, coins, 10);' } },
        notes: ['Free with %princequest >= ^prince_saved (no menu). The border_gate_toll_left/right loc op1 also starts this talk.'],
    },
    {
        kind: 'toll', destination: 'Kharidian Desert (south of Shantay Pass)', npc: 'shantay_guard_still', op: 1,
        trigger: { file: F.shantayPass, needle: '[opnpc1,shantay_guard_still]' },
        options: ["I'd like to go into the desert please.", "Yeah, that poster doesn't scare me!"], optionsFile: F.shantayPass,
        to: { at: { file: F.shantayPass, needle: 'p_teleport(0_51_48_40_46);' }, offsets: [{ file: F.shantayPass, needle: 'p_telejump(movecoord(coord, 0, 0, -3));' }] },
        fare: { coins: null, rule: 'One shantay_pass per trip; Shantay sells it for 5 coins ("I want to buy a shantay pass for 5 gold coins.").', at: [{ file: F.shantay, needle: 'inv_del(inv, coins, 5);', after: '[label,shantay_buy_shantay_pass]' }, { file: F.shantay, needle: '"I want to buy a shantay pass for 5 gold coins."' }] },
        items: [{ item: 'shantay_pass', use: 'consumed', at: { file: F.shantayPass, needle: 'inv_del(inv, shantay_pass, 1);' } }],
        members: { file: F.shantayPass, needle: 'if (map_members = ^false) {' },
        notes: ['The poster choice appears only without thshantaydisc; the first trip adds the disclaimer. The shantay_pass_henge_doorway loc op1 does the same check; going north through it is free.'],
    },
    {
        kind: 'toll', destination: 'Shilo Village furnace building', npc: 'shilofurnaceowner', op: 1,
        trigger: { file: F.yohnus, needle: '[opnpc1,shilofurnaceowner]' },
        options: ['Use Furnace - 20 Gold'], optionsFile: F.yohnus,
        to: { at: { file: F.yohnus, needle: '~forcemove(0_44_46_40_19);' }, offsets: [{ file: F.yohnus, needle: 'p_teleport(movecoord(coord, 0, 0, 1));' }] },
        fare: { coins: 20, at: { file: F.yohnus, needle: 'inv_del(inv, coins, 20);' } },
    },
    {
        kind: 'other', destination: 'Port Sarim jail', npc: 'shantay', op: 1,
        trigger: { file: F.shantay, needle: '[opnpc1,shantay]' },
        options: ['What is this place?', 'I am definitely an outlaw, prepare to die!', "No thanks, you're not having my money.", 'No, do your worst!'], optionsFile: F.shantay,
        to: { at: { file: F.shantay, needle: 'p_telejump(0_47_49_9_46);' } },
        fare: { coins: 0, free: 'shantay_send_player_to_port_sarim removes no coins' },
        notes: ['Shantay first jails the player at 0_51_48_32_52, then the refusal path sends the player to Port Sarim.'],
        gaps: ['The Port Sarim jail exit is not in knowledge/doors.json near the arrival tile; the way out is not verified.'],
    },
    // ---- gliders ----
    gliderOut('gandius', 'Gandius (Karamja shipyard)', 'com_21'),
    gliderOut('sindarpos', 'Sindarpos (White Wolf Mountain)', 'com_23'),
    gliderOut('lemanto_andra', 'Lemanto Andra (Digsite, east of Varrock)', 'com_24'),
    gliderOut('kar_hewo', 'Kar-Hewo (Al Kharid)', 'com_25'),
    gliderHome('gandius', 'Gandius'), gliderHome('sindarpos', 'Sindarpos'), gliderHome('kar_hewo', 'Kar-Hewo'),
    {
        kind: 'glider', destination: 'Karamja crash site', npc: 'gnomepilot', op: 1,
        trigger: { file: F.glider, needle: '[opnpc1,gnomepilot]' },
        options: ['Take me to Karamja please!'], optionsFile: F.glider,
        from: { rule: 'pilot in 3_38_54_31_43..3_38_54_35_47', at: { file: F.glider, needle: 'inzone(3_38_54_31_43, 3_38_54_35_47, npc_coord)' }, keep: box('3_38_54_31_43', '3_38_54_35_47') },
        to: { at: { file: F.glider, needle: 'p_teleport(0_45_47_37_50);' } },
        fare: { coins: 0, free: 'gnomepilot removes no coins' },
        requires: [{ varp: 'grandtree', op: '=', constant: 'grandtree_released_prison', at: { file: F.glider, needle: 'if(%grandtree = ^grandtree_released_prison & inzone(' } }],
        notes: ['The Grand Tree quest leg.'],
    },
    {
        kind: 'glider', destination: 'Crash Island', npc: 'mm_waydar', op: 1,
        trigger: { file: F.waydar, needle: '[opnpc1,mm_waydar]' },
        options: ['Yes'], optionsFile: F.waydar,
        from: { rule: 'Waydar outside the Crash Island square 0_45_42', at: { file: F.waydar, needle: 'if(inzone(0_45_42_0_0, 0_45_42_63_63, npc_coord) = true) {' }, keep: t => !CRASH_ISLAND_BOX(t) },
        to: { at: { file: F.waydar, needle: 'p_teleport(0_45_42_13_37);' } },
        fare: { coins: 0, free: 'waydar_fly_crash_island removes no coins' },
        requires: [{ varp: 'mm_daero', op: '=', constant: 'daero_complete', at: { file: F.waydar, needle: 'if(%mm_daero = ^daero_complete) {' } }],
        notes: ['Waydar waits in the underground glider hangar; Daero takes the player there.'],
    },
    {
        kind: 'glider', destination: 'Gnome Stronghold (near the Gnomeball pitch)', npc: 'mm_waydar', op: 1,
        trigger: { file: F.waydar, needle: '[opnpc1,mm_waydar]' },
        options: ['I need to return to your kingdom.'], optionsFile: F.waydar,
        from: { rule: 'Waydar inside the Crash Island square 0_45_42', at: { file: F.waydar, needle: 'if(inzone(0_45_42_0_0, 0_45_42_63_63, npc_coord) = true) {' }, keep: CRASH_ISLAND_BOX },
        to: { at: { file: F.waydar, needle: 'p_teleport(0_37_54_25_10);' } },
        fare: { coins: 0, free: 'waydar_return removes no coins' },
        requires: [
            { varp: 'mm_waydar', op: '=', constant: 'waydar_arrived_island', at: { file: F.waydar, needle: 'case ^waydar_arrived_island :' } },
            { varp: 'mm_main', op: '>', constant: 'mm_shown_seal', at: { file: F.waydar, needle: 'if(%mm_main > ^mm_shown_seal) {' } },
        ],
    },
    // ---- Monkey Madness transfers ----
    {
        kind: 'other', destination: 'Underground glider hangar', npc: 'mm_daero', op: 1,
        trigger: { file: F.daero, needle: '[opnpc1,mm_daero]' },
        options: [],
        from: { rule: 'Daero outside the hangar squares 0_37_154 and 0_40_70..0_41_71', at: { file: F.daero, needle: 'if(inzone(0_37_154_0_0, 0_37_154_63_63, npc_coord) = true | inzone(0_40_70_0_0, 0_41_71_63_63, npc_coord) = true) {' }, keep: t => !DAERO_HANGAR_BOX_A(t) && !DAERO_HANGAR_BOX_B(t) },
        to: { at: { file: F.daero, needle: 'else p_teleport(0_41_70_25_36);' } },
        fare: { coins: 0, free: 'daero_move_hangar removes no coins' },
        requires: [
            { varp: 'mm_narnode', op: '>=', constant: 'narnode_received_orders', at: { file: F.daero, needle: 'if(%mm_narnode < ^narnode_received_orders) {' } },
            { varp: 'mm_main', op: '=', constant: 'mm_complete_training', at: { file: F.daero, needle: 'if(%mm_main = ^mm_complete_training) {' } },
            { varp: 'mm_daero', op: '>=', constant: 'daero_reinit_complete', at: { file: F.daero, needle: 'if(%mm_daero < ^daero_reinit_complete) p_teleport(0_37_154_25_36);' } },
        ],
        notes: ['At %mm_main = ^mm_complete Daero runs the one-time training instead; after it the talk goes to the hangar. During the quest (%mm_daero >= ^daero_left_grandtree) the menu answer is "Yes".'],
    },
    {
        kind: 'other', destination: 'Ape Atoll', npc: 'mm_lumdo', op: 1,
        trigger: { file: F.lumdo, needle: '[opnpc1,mm_lumdo]' },
        options: [],
        from: { rule: 'Lumdo outside 0_43_42 (Ape Atoll) and 0_42_143', at: { file: F.lumdo, needle: 'if(inzone(0_43_42_0_0, 0_43_42_63_63, npc_coord) = true) {' }, keep: t => !APE_ATOLL_BOX(t) && !LUMDO_ISLAND_BOX(t) },
        to: { at: { file: F.lumdo, needle: 'p_teleport(0_43_42_50_19);' } },
        fare: { coins: 0, free: 'mm_lumdo removes no coins' },
        requires: [{ varp: 'mm_lumdo', op: '=', constant: 'lumdo_travelled', at: { file: F.lumdo, needle: 'case ^lumdo_travelled :' } }],
        notes: ['The script shows a fade; it names no vehicle.'],
    },
    {
        kind: 'other', destination: 'Crash Island', npc: 'mm_lumdo', op: 1,
        trigger: { file: F.lumdo, needle: '[opnpc1,mm_lumdo]' },
        options: [],
        from: { rule: 'Lumdo inside 0_43_42 (Ape Atoll)', at: { file: F.lumdo, needle: 'if(inzone(0_43_42_0_0, 0_43_42_63_63, npc_coord) = true) {' }, keep: APE_ATOLL_BOX },
        to: { at: { file: F.lumdo, needle: 'p_teleport(0_45_42_14_38);' } },
        fare: { coins: 0, free: 'mm_lumdo removes no coins' },
    },
    // ---- NPC teleports ----
    essence('ardounge_wizard', 3, F.cromperty, '[opnpc3,ardounge_wizard]', 'essence_mine_to_cromperty'),
    essence('aubury', 4, F.aubury, '[opnpc4,aubury]', 'essence_mine_to_aubury'),
    essence('head_wizard', 3, F.sedridor, '[opnpc3,head_wizard]', 'essence_mine_to_sedridor'),
    essence('guild_wizard', 3, F.distentor, '[opnpc3,guild_wizard]', 'essence_mine_to_disentor'),
    essence('gnome_brimstail', 3, F.brimstail, '[opnpc3,gnome_brimstail]', 'essence_mine_to_brimstail'),
    ...([['before the crate is delivered', 'def_coord $coord = 0_41_51_25_7;', '<'], ['after the crate is delivered', '$coord = 0_41_51_14_57;', '>=']] as const).map(([label, needle, op]): Spec => ({
        kind: 'npc-teleport', destination: `Cromperty's other teleport block (${label})`, npc: 'ardounge_wizard', op: 1,
        trigger: { file: F.cromperty, needle: '[opnpc1,ardounge_wizard]' },
        options: ['So what have you invented?', 'Can I be teleported please?', 'Yes, that sounds good. Teleport me!'], optionsFile: F.cromperty,
        to: { at: { file: F.cromperty, needle } },
        fare: { coins: 0, free: 'rpdt_teleport removes no coins' },
        requires: [
            { varp: 'totemquest', op: '<', constant: 'totem_complete', at: { file: F.cromperty, needle: 'if(%totemquest < ^totem_complete) {' } },
            { varp: 'totemquest', op, constant: 'totem_crate_delivered', at: { file: F.cromperty, needle: 'if(%totemquest >= ^totem_crate_delivered) {' } },
        ],
        notes: ['Tribal Totem leg; after quest completion the teleport fails with no movement.'],
    })),
    {
        kind: 'npc-teleport', destination: 'Temple of Ikov, across the lava', npc: 'ikov_winelda', op: 1,
        trigger: { file: F.winelda, needle: '[opnpc1,ikov_winelda]' },
        options: [],
        to: { at: { file: F.winelda, needle: 'p_teleport(0_41_154_40_20);' } },
        fare: { coins: 0, free: 'ikov_winelda_teleport removes no coins' },
        requires: [{ varp: 'ikov', op: 'not-in', constant: ['ikov_defeated_fire_warrior', 'ikov_spoken_winelda'], at: { file: F.winelda, needle: 'Hi again. Could you do the honours again please?' } }],
        items: [{ item: 'limpwurt_root x20 (first trip, at ^ikov_spoken_winelda)', use: 'consumed', at: { file: F.winelda, needle: 'inv_del(inv, limpwurt_root, 20);' } }],
        notes: ['The case default branch teleports with no menu; at ^ikov_spoken_winelda the first trip costs 20 limpwurt roots.'],
    },
    // ---- other NPC-led moves ----
    {
        kind: 'other', destination: 'Tree Gnome Village (inside the maze)', npc: 'elkoy', op: 1,
        trigger: { file: F.elkoy, needle: '[opnpc1,elkoy]' },
        options: ['Yes please.'], optionsFile: F.elkoy,
        to: { at: { file: F.elkoy, needle: 'def_coord $dest_coord = ^elkoy_maze_coord;', after: '[label,elkoy_jumpmaze_postquest]' } },
        fare: { coins: 0, free: 'elkoy removes no coins' },
        requires: [{ varp: 'treequest', op: '>=', constant: 'tree_started', at: { file: F.elkoy, needle: 'case ^tree_started, ^tree_spoken_montai' } }],
        notes: ['Post-quest path shown; quest stages use the same answer "Yes please." except where the menu differs per stage.'],
    },
    {
        kind: 'other', destination: 'Tree Gnome Village maze entrance', npc: 'elkoy_village', op: 1,
        trigger: { file: F.elkoy, needle: '[opnpc1,elkoy_village]' },
        options: ['Yes please.'], optionsFile: F.elkoy,
        to: { at: { file: F.elkoy, needle: '$dest_coord = ^elkoy_entrance_coord;', after: '[label,elkoy_jumpmaze_postquest]' } },
        fare: { coins: 0, free: 'elkoy_village removes no coins' },
        requires: [{ varp: 'treequest', op: '>=', constant: 'tree_started', at: { file: F.elkoy, needle: 'case ^tree_started, ^tree_spoken_montai', after: '[opnpc1,elkoy_village]' } }],
        notes: ['Post-quest path shown. At stages ^tree_retrieved_orb and ^tree_returned_first_orb the answer is "Can you show me out of the village?".'],
    },
    {
        kind: 'other', destination: 'Shilo Village gate (inside)', npc: 'mosol_rei', op: 1,
        trigger: { file: F.mosol, needle: '[opnpc1,mosol_rei]' },
        options: ["Yes, I'll give it a go!"], optionsFile: F.mosol,
        to: { at: { file: F.mosol, needle: 'p_telejump(0_44_46_50_8);' } },
        fare: { coins: 0, free: 'mosol_rei removes no coins' },
        requires: [
            { varp: 'junglepotion', op: '>=', constant: 'junglepotion_complete', at: { file: F.mosol, needle: 'if(%junglepotion < ^junglepotion_complete) {' } },
            { varp: 'zombiequeen', op: 'in', constant: ['zombiequeen_complete', 'zombiequeen_complete_spoken_trufitus1', 'zombiequeen_complete_spoken_trufitus2'], at: { file: F.mosol, needle: 'case ^zombiequeen_complete, ^zombiequeen_complete_spoken_trufitus1' } },
        ],
    },
    {
        kind: 'other', destination: 'Entrana dungeon (one way)', npc: 'cave_monk', op: 1,
        trigger: { file: F.caveMonk, needle: '[opnpc1,cave_monk]' },
        options: ['Well that is a risk I will have to take.'], optionsFile: F.caveMonk,
        to: { at: { file: F.caveMonk, needle: 'p_telejump(0_44_152_6_46);' } },
        fare: { coins: 0, free: 'cave_monk removes no coins' },
        notes: ['Prayer drops (stat_sub(prayer, 0, 95)). The only exit is a portal to deep Wilderness (monk dialogue).'],
    },
    {
        kind: 'other', destination: 'Skavid cave by the enclave', npc: 'enclave_guard', op: 1,
        trigger: { file: F.enclave, needle: '[opnpc1,enclave_guard]' },
        options: ['I want to go in there.'], optionsFile: F.enclave,
        to: { at: { file: F.enclave, needle: 'p_teleport(0_40_147_28_2);' } },
        fare: { coins: 0, free: 'enclave_guard removes no coins' },
        requires: [{ varp: 'itwatchtower', op: '>=', constant: 'itwatchtower_complete', at: { file: F.enclave, needle: 'if(%itwatchtower >= ^itwatchtower_complete) {' } }],
        notes: ['Before quest completion the answer starts a fight; using nightshade on the guard passes from ^itwatchtower_skavid_crystal.'],
    },
];

// Handlers that move the player but are not travel legs a router can use.
export const EXCLUDED: ExcludedSpec[] = [
    { npc: 'arenamage1', at: { file: `${S}areas/area_mage_arena/scripts/kolodion.rs2`, needle: 'p_teleport(^mage_arena_start_coord);' }, reason: 'Enters the Mage Arena fight and spawns the boss.' },
    { npc: 'holgartplatform', at: { file: F.holgartPlatform, needle: 'p_telejump(^seaslug_island_coord);' }, reason: 'Sea Slug quest step (stage seaslug_spoken_kennith or seaslug_sailed_kent).' },
    { npc: 'murphy', at: { file: `${S}minigames/game_trawler/scripts/trawler_start.rs2`, needle: 'p_teleport(map_findsquare(^trawler_start_center_under' }, reason: 'Fishing Trawler minigame start, returns to Port Khazard.' },
    { npc: 'ogre_guard1', at: { file: `${S}quests/quest_itwatchtower/scripts/ogre_guard.rs2`, needle: 'p_teleport(^gutanoth_hill);' }, reason: 'Guards eject the player; entry is the gate loc via @enter_gutanoth.' },
    { npc: 'regicide gate guard', at: { file: `${S}quests/quest_regicide/scripts/regicide_arandar_gate_guard.rs2`, needle: 'p_teleport(movecoord(coord, 0, 0, 2));' }, reason: 'Arandar gate passage, a player-relative step through a gate.' },
    { npc: 'legends_guard', at: { file: `${S}quests/quest_legends/scripts/legends_guard.rs2`, needle: 'p_teleport($inside_dest);' }, reason: 'Legends Guild gate passage.' },
    { npc: 'gujuo', at: { file: `${S}quests/quest_legends/scripts/gujuo.rs2`, needle: 'p_teleport(^legends_gujuo_guide_coord);' }, reason: 'Gujuo has no static spawn (npcs.json spawns empty).' },
    { npc: 'caveguide5', at: { file: `${S}quests/quest_upass/scripts/koftik.rs2`, needle: 'p_teleport(0_38_151_49_53);' }, reason: 'Underground Pass quest ending.' },
    { npc: 'grandtree_foreman', at: { file: `${S}quests/quest_grandtree/scripts/foreman.rs2`, needle: 'p_teleport(0_46_47_11_25);' }, reason: 'Grand Tree quest step (office cutscene).' },
    { npc: 'general_khazard', at: { file: `${S}quests/quest_arena/scripts/general_khazard.rs2`, needle: 'p_teleport(0_40_49_45_5);' }, reason: 'Fight Arena quest jail.' },
    { npc: 'captain_siad', at: { file: `${S}quests/quest_desertrescue/scripts/captain_siad.rs2`, needle: 'p_teleport(^desertrescue_prison_coord);' }, reason: 'Desert mining camp jail.' },
    { npc: 'desertminingmercenary2', at: { file: `${S}quests/quest_desertrescue/scripts/camp_guard.rs2`, needle: 'p_teleport(^desertrescue_underground_prison_coord);' }, reason: 'Desert mining camp jail.' },
    { npc: 'bedabin_guard', at: { file: `${S}quests/quest_desertrescue/scripts/bedabin_nomad_guard.rs2`, needle: 'p_teleport(0_49_47_33_38);' }, reason: 'Tent doorway step.' },
    { npc: 'grandtree_glough', at: { file: `${S}quests/quest_grandtree/scripts/glough.rs2`, needle: 'p_telejump(^grandtree_jail_coord);' }, reason: 'Grand Tree quest jail.' },
    { npc: 'grandtree_narnode', at: { file: `${S}quests/quest_grandtree/scripts/king_narnode.rs2`, needle: 'p_telejump(movecoord(coord, -1, 0, 6399));' }, reason: 'Grand Tree quest trapdoor step.' },
];
