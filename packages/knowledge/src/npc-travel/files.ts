export const S = 'scripts/';

export const F = {
    sailors: `${S}areas/area_port_sarim/scripts/sailors.rs2`,
    barnaby: `${S}areas/area_ardougne_east/scripts/captain_barnaby.rs2`,
    customs: `${S}areas/area_karamja/scripts/customs_officer.rs2`,
    sarimMonk: `${S}areas/area_port_sarim/scripts/monk_of_entrana.rs2`,
    entranaMonk: `${S}areas/area_entrana/scripts/monk_of_entrana.rs2`,
    shanks: `${S}areas/area_karamja/scripts/captain_shanks.rs2`,
    seravel: `${S}areas/area_shilo/scripts/seravel.rs2`,
    jenkins: `${S}areas/area_port_sarim/scripts/cabin_boy_jenkins.rs2`,
    holgartLand: `${S}areas/area_ardougne_east/scripts/holgart_ardougne.rs2`,
    holgartPlatform: `${S}areas/area_fishing_platform/scripts/holgart_platform.rs2`,
    holgartIsland: `${S}areas/area_fishing_platform/scripts/holgart_island.rs2`,
    miscSailor: `${S}areas/area_miscellania/scripts/misc_sailor.rs2`,
    vikingSailor: `${S}quests/quest_viking/scripts/viking_sailor.rs2`,
    ned: `${S}quests/quest_dragon/scripts/dragonslayer_ned.rs2`,
    sail: `${S}interface_boat/scripts/sail.rs2`,
    hajedy: `${S}areas/area_brimhaven/scripts/hajedy.rs2`,
    vigroy: `${S}areas/area_shilo/scripts/vigroy.rs2`,
    yohnus: `${S}areas/area_shilo/scripts/yohnus.rs2`,
    border: `${S}areas/area_alkharid/scripts/border_gate.rs2`,
    shantayPass: `${S}areas/area_alkharid/scripts/shantay_pass.rs2`,
    shantay: `${S}areas/area_alkharid/scripts/shantay.rs2`,
    glider: `${S}areas/area_gnome/scripts/gnome_glider.rs2`,
    daero: `${S}quests/quest_mm/scripts/mm_daero.rs2`,
    waydar: `${S}quests/quest_mm/scripts/mm_waydar.rs2`,
    lumdo: `${S}quests/quest_mm/scripts/mm_lumdo.rs2`,
    ess: `${S}skill_runecraft/scripts/essence_mine.rs2`,
    essEnum: `${S}skill_runecraft/configs/essence_mine_teleports.enum`,
    cromperty: `${S}areas/area_ardougne_east/scripts/wizard_cromperty.rs2`,
    aubury: `${S}areas/area_varrock/scripts/aubury.rs2`,
    sedridor: `${S}areas/area_wizard_tower/scripts/sedridor.rs2`,
    distentor: `${S}areas/area_yanille/scripts/wizard_distentor.rs2`,
    brimstail: `${S}areas/area_gnome/scripts/brimstail.rs2`,
    winelda: `${S}quests/quest_ikov/scripts/winelda.rs2`,
    elkoy: `${S}areas/area_gnome/scripts/elkoy.rs2`,
    mosol: `${S}quests/quest_zombiequeen/scripts/mosol_rei.rs2`,
    caveMonk: `${S}areas/area_entrana/scripts/cave_monk.rs2`,
    enclave: `${S}quests/quest_itwatchtower/scripts/enclave_guard.rs2`,
};

export const SAIL_PROCS = new Set(['~set_sail(', '~set_sail_cairn(', '~misc_longship_sail(']);

export const ABSENT_TRAVEL = {
    kinds: ['charter', 'carpet', 'balloon (transport)', 'canoe', 'Pest Control', "Mos Le'Harmless", 'Lunar Isle', 'Port Phasmatys', 'Abyss (Mage of Zamorak)'],
    evidence: 'No .npc or .loc config name or debugname in content matches these travel methods; party room balloons are not transport.',
};
