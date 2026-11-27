// What a quest sweep does with the journal state that it finds at entry. Quest varps never reach the client
// (packages/core/src/quest-status.ts), so a run that ended mid-quest leaves a started journal and nothing else. A generated
// quest script starts at its first step, and the NPC of that step no longer says the text that the step waits for: the
// restart fails the same way on every login (live: "fail talk squire 1" after "fail talk thurgo pie").
// A quest in QUEST_RESUME reads its stage from the journal text and starts the script at that stage (q.stageFrom in
// scripts/generated/quest-lib.ts). A quest in SELF_RESUME reads the started journal in its own script or sweep branch.
// Any other started quest ends at entry with a named refusal, and the planner does not choose it for that account.
import { journalText } from '../../../core/src/quest-journal';

export type QuestJournalState = 'not started' | 'started' | 'complete' | 'unknown';

export type QuestResume = {
    // questlist:<key>, the quest list button that opens the journal.
    readonly key: string;
    // The journal title (interface 8144).
    readonly title: RegExp;
    // The varp stage that the journal text names, or undefined.
    readonly stage: (body: string) => number | undefined;
    // The varp stage at completion: a journal at this stage or higher has nothing to resume.
    readonly complete: number;
    // Items of the start preset that the quest takes before a stage: the sweep does not stage them for that stage.
    readonly spent?: (stage: number) => readonly number[];
    // The script's FROM value for a varp stage (default: the stage itself). Undefined: the script cannot go on from the
    // start tile at that stage (the account stands in a cell, an arena or a cutscene), and the sweep refuses by name.
    readonly from?: (stage: number) => number | undefined;
    // Quest items that the account got before a stage and that the script needs: the sweep withdraws them when the
    // pack and the worn slots do not hold them.
    readonly held?: (stage: number) => readonly number[];
    // Items that the sweep stages beyond the preset pack at a stage: the price of a lost quest item that the script
    // gets again.
    readonly extra?: (stage: number) => readonly { readonly id: number; readonly count: number }[];
};

// The script's FROM value for a journal stage, or undefined for a stage with no resume from the start tile.
export function resumeFrom(resume: QuestResume, stage: number): number | undefined {
    return resume.from ? resume.from(stage) : stage;
}

// The Knight's Sword: %squire (varp 122), quests/quest_squire/configs/quest_squire.constant and quest.constant:55. The
// active lines of squire_journal.rs2, from the highest stage down.
export function squireJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 7;
    if (/to make a replica sword he will need two Iron Bars/i.test(text) || /Thurgo has now smithed me a replica of Sir Vyvin's sword/i.test(text)) return 6;
    if (/The Squire told me about a portrait of Sir Vyvin's father/i.test(text)) return 5;
    if (/Thurgo needs a picture of the sword before he can help/i.test(text)) return 4;
    if (/He will help me now I have gained his trust through pie/i.test(text)) return 3;
    if (/they dislike strangers, and LOVE redberry pies/i.test(text)) return 2;
    if (/The Squire suggests I speak to Reldo/i.test(text)) return 1;
    if (/I can start this quest by talking to the Squire/i.test(text)) return 0;
    return undefined;
}

// Druidic Ritual: %druidquest (varp 80), quests/quest_druid/configs/quest_druid.constant and quest.constant:19
// (complete 4). Each branch of druid_journal.rs2, from the highest stage down: the struck lines of earlier stages come
// back at later stages, so each test names the line that only its own stage shows.
export function druidJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 4;
    if (/speak to Kaqemeex again and claim my reward/i.test(text)) return 3;
    if (/the Cauldron of Thunder in the dungeon South of Taverley/i.test(text)) return 2;
    if (/I should speak to Sanfew in the village to the South/i.test(text)) return 1;
    if (/I can start this quest by speaking to Kaqemeex/i.test(text)) return 0;
    return undefined;
}

// Fight Arena: %arenaquest (varp 17), quests/quest_arena/configs/quest_arena.constant and quest.constant:3 (complete 14
// and 15). Each stage's own line of arena_journal.rs2, from the highest stage down: a stage's line comes back struck at
// later stages, and journalText drops the colour tags that tell them apart.
export function arenaJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 14;
    if (/General Khazard was a tough foe, but I eventually killed him/i.test(text)) return 13;
    if (/He challenged me to fight him, but I ran away/i.test(text)) return 12;
    if (/but he wants to kill me himself/i.test(text)) return 11;
    if (/General Khazard ordered me to fight his pet, Bouncer/i.test(text)) return 10;
    if (/I'm going to have to fight in the Arena!/i.test(text)) return 9;
    if (/I should talk to Jeremy in the Fight Arena!/i.test(text)) return 8;
    if (/I need to protect Jeremy and his father from a huge Ogre/i.test(text)) return 6;
    if (/Now I've got the keys I should try to rescue Lady Servil's family/i.test(text)) return 5;
    if (/One of the guards told me that he really likes Khali Brew/i.test(text)) return 3;
    if (/Luckily I found some Khazard armour in a chest/i.test(text)) return 2;
    if (/I should go to the Fight Arena and try to find her family/i.test(text)) return 1;
    if (/I can start this quest by speaking to Lady Servil/i.test(text)) return 0;
    return undefined;
}

// quest-arena.ts goes on from the start tile beside Lady Servil before the ogre fight (1-5: the chest gives the Khazard
// armour again and the drunk guard spare keys, quest_arena.rs2:5-28, khazard_guard.rs2:78-83) and after it (12-13: Lady
// Servil queues the completion, lady_servil.rs2:8-13). At 6-11 the account stands in the arena or the cells: the arena
// door from the inside starts the ogre fight again at 6 (quest_arena.rs2:118-123), and the cells hold it at 9.
export function arenaFrom(stage: number): number | undefined {
    if (stage <= 5) return stage;
    if (stage === 12 || stage === 13) return 12;
    return undefined;
}

// Family Crest: %crestquest (varp 148), quests/quest_crest/configs/quest_crest.constant:1-11 and quest.constant:13
// (complete 11). The journal reads no other varp; the fish lines at 2 and the jewellery lines at 7 read the pack
// (crest_journal.rs2:37-41, 73-74). Each stage's own active line of crest_journal.rs2, from the highest stage down.
// The longest journal (stage 10) has about 20 lines, under the 49 that split_init shows.
export function crestJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 11;
    if (/Johnathon lost his piece of the family crest to a demon/i.test(text)) return 10;
    if (/I found Johnathon looking very ill at the Jolly Boar Inn/i.test(text)) return 9;
    if (/The final crest piece is with their brother Johnathon/i.test(text)) return 8;
    if (/Avan will give me his crest piece if I can bring him a ruby/i.test(text)) return 7;
    if (/I should find a dwarf named Boot who lives somewhere in/i.test(text)) return 6;
    if (/The Al-Kharid Gem Trader told me that Avan is wearing a/i.test(text)) return 5;
    if (/Caleb told me his brother Avan is on a treasure hunt/i.test(text)) return 4;
    if (/I have one crest piece, I need to find the other two/i.test(text)) return 3;
    if (/Caleb will let me have his piece in return for/i.test(text)) return 2;
    if (/I need to find his son Caleb\. The last Dimintheis heard of/i.test(text)) return 1;
    if (/I can start this quest by speaking to Dimintheis/i.test(text)) return 0;
    return undefined;
}

// Caleb takes the 5 cooked fish at 2 -> 3 (crest_caleb.rs2:64-79). quest-crest.ts makes the ring and necklace from the
// 2 'perfect' gold bars and 2 rubies after the gem trader (5) and before Avan's first talk (6), so they are spent from 6.
// At 5 the journal does not tell whether the jewellery is made, so the bars and rubies are staged. Johnathon takes one
// of the 2 antipoisons (crest_johnathon.rs2:21) and the script drinks the other, so neither is in `spent`.
const CREST_FISH = [373, 365, 361, 329, 315]; // swordfish, bass, tuna, salmon, shrimp
const CREST_BAR = 2365, CREST_RUBY = 1603;
// The server names Caleb's piece avan_crest (779) and Avan's piece caleb_crest (780) (crest_caleb.rs2:79, crest_man.rs2:59).
const CREST_PIECE_CALEB = 779, CREST_PIECE_AVAN = 780, CREST_PIECE_JOHNATHON = 781, FAMILY_CREST = 782;
const CREST_RING = 773, CREST_NECKLACE = 774;

export function crestSpent(stage: number): readonly number[] {
    return [...(stage >= 3 ? CREST_FISH : []), ...(stage >= 6 ? [CREST_BAR, CREST_RUBY] : [])];
}

// The quest items of a stage that quest-crest.ts needs: Caleb's piece from 3 (crest_caleb.rs2:79); the 'perfect' ring
// and necklace from 5 until Avan takes them at 7 -> 8 (crest_man.rs2:53-59); Avan's piece from 8; at 10 Johnathon's
// piece (Chronozon's drop, crest_chronozon.rs2:4-5) or the joined crest (quest_crest.rs2:117-123).
export function crestHeld(stage: number): readonly number[] {
    if (stage >= 10) return [CREST_PIECE_CALEB, CREST_PIECE_AVAN, CREST_PIECE_JOHNATHON, FAMILY_CREST];
    if (stage >= 8) return [CREST_PIECE_CALEB, CREST_PIECE_AVAN];
    if (stage >= 5) return [CREST_PIECE_CALEB, CREST_RING, CREST_NECKLACE];
    if (stage >= 3) return [CREST_PIECE_CALEB];
    return [];
}

// Witch's House: %ballquest (varp 226), quests/quest_ball/configs/quest_ball.constant:1-6 and quest.constant:5. The
// active lines of ball_journal.rs2, from the highest stage down. Stages 3 and 5 (the diary read after the mouse) show
// one text (ball_journal.rs2:30-33): the parser names 3, and quest-ball.ts runs both alike.
export function ballJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 7;
    if (/Now the shapeshifter is dead I should return the boy's ball/i.test(text)) return 6;
    if (/I have worked out how to unlock the back door to the garden/i.test(text)) return 3;
    if (/I have found a magnet in a cupboard in the basement/i.test(text)) return 2;
    if (/I should find a way into the garden where the ball is/i.test(text)) return 1;
    if (/I can start this quest by speaking to the little boy/i.test(text)) return 0;
    return undefined;
}

const BALL_CHEESE = 1985, BALL_MAGNET = 2410, BALL_SHED_KEY = 2411;

// Holy Grail: %grail (varp 5), quests/quest_grail/configs/quest_grail.constant (2, 3, 4, 7, 8, 9) and quest.constant:27
// (complete 10). Each stage's own line of grail_journal.rs2, from the highest stage down. No server script sets 5 or 6;
// there the journal holds only the two struck start lines, and the parser names no stage. The longest journal has 22
// lines, under the 49 that split_init shows.
export function grailJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 10;
    if (/I honoured the Fisher King's request to find his son/i.test(text)) return 9;
    if (/The Fisher King is very sick\. He has asked me to find his son/i.test(text)) return 8;
    if (/I need to find a weapon that can defeat him somehow/i.test(text)) return 7;
    if (/According to a Crone on Entrana I need to go to where the/i.test(text)) return 4;
    if (/Merlin suggested two things to help find the Grail/i.test(text)) return 3;
    if (/King Arthur has sent me questing for the Holy Grail of legend/i.test(text)) return 2;
    if (/I can start this quest by speaking to King Arthur at Camelot Castle/i.test(text)) return 0;
    return undefined;
}

// quest-grail.ts HG_FROM is a milestone. 2: Merlin on (milestone 1). 3: Entrana on (2). 4 and 7 (the titan beaten
// without Excalibur worn, black_knight_titan.rs2:30-32): Galahad on (3); the script skips Galahad with a napkin held and
// the manor with two whistles held. 8: Sir Percival on (7). 9: the restored realm on (8), skipped with the grail held.
export function grailFrom(stage: number): number | undefined {
    switch (stage) {
        case 0: return 0;
        case 2: return 1;
        case 3: return 2;
        case 4: case 7: return 3;
        case 8: return 7;
        case 9: return 8;
        default: return undefined;
    }
}

const GRAIL_NAPKIN = 15, GRAIL_WHISTLE = 16, HOLY_GRAIL = 19, EXCALIBUR = 35, RUNE_SCIMITAR = 1333;

// The napkin opens the whistle door (quest_grail.rs2:31), the whistles cross to the realm and back
// (quest_grail.rs2:37-50) and one goes to Sir Percival (sir_percival.rs2:43-47); King Arthur takes the grail from the
// pack only, and a banked grail stops a second pick-up (quest_grail.rs2:69-72). Before the titan the script needs
// Excalibur: a banked one is withdrawn.
export function grailHeld(stage: number): readonly number[] {
    if (stage >= 2 && stage <= 3) return [EXCALIBUR];
    if (stage === 4 || stage === 7) return [GRAIL_NAPKIN, GRAIL_WHISTLE, EXCALIBUR];
    if (stage === 8) return [GRAIL_NAPKIN, GRAIL_WHISTLE];
    if (stage === 9) return [GRAIL_NAPKIN, GRAIL_WHISTLE, HOLY_GRAIL];
    return [];
}

// The script leaves Excalibur on the Port Sarim dock before Entrana (a drop lasts 300 ticks, drop.rs2:22), so a run
// that ended there has lost it. Before the titan the sweep does not ask for Excalibur, and stages the 500 coins for
// which the Lady of the Lake gives it again to a player who holds none (lady_of_the_lake.rs2:4-35). From 8 the titan
// is behind the account and no block wields Excalibur or the rune scimitar.
export function grailSpent(stage: number): readonly number[] {
    if (stage >= 8) return [EXCALIBUR, RUNE_SCIMITAR];
    return stage >= 2 ? [EXCALIBUR] : [];
}

export function grailExtra(stage: number): readonly { id: number; count: number }[] {
    return stage >= 2 && stage <= 7 ? [{ id: 995, count: 500 }] : [];
}

// Merlin's Crystal: %arthur (varp 14), quests/quest_arthur/configs/quest_arthur.constant:1-7 and quest.constant:4
// (complete 7). The journal (arthur_journal.rs2, questlist:arthur) also reads bit 0 of %excalibur_components_progress
// (varp 15) and the pack at stage 4 (arthur_journal.rs2:45-63); the stage comes from the one line that only that
// stage shows, from the highest stage down.
export function merlinJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 7;
    if (/Now that Merlin is freed I should speak to King Arthur/i.test(text)) return 6;
    if (/I should free Merlin by using Excalibur on the crystal/i.test(text)) return 5;
    if (/To bind Thrantax to my will I will need the following/i.test(text)) return 4;
    if (/There might be a way to enter with a delivery by sea/i.test(text)) return 3;
    if (/Gawain think this was the work of Morgan Le Faye/i.test(text)) return 2;
    if (/I should ask the other Knights if they have any advice/i.test(text)) return 1;
    if (/I can start this quest by speaking to King Arthur/i.test(text)) return 0;
    return undefined;
}

// quest-merlin.ts MC_FROM is a milestone: %arthur 1-4 the same, 5 (Thrantax bound) 8, 6 (Merlin free, King Arthur
// only) 9. %arthur 4 covers milestones 4-7: the script skips the candle maker for a held candle, the Lady for a held
// Excalibur and the chaos altar when the journal names its words.
const MERLIN_FROM: readonly number[] = [0, 1, 2, 3, 4, 8, 9];
const MERLIN_WAX = 30, MERLIN_LIT_CANDLE = 32, MERLIN_EXCALIBUR = 35, MERLIN_UNLIT_CANDLE = 38, MERLIN_BREAD = 2309;

// Temple of Ikov: %ikov (varp 26), quests/quest_ikov/configs/quest_ikov.constant:1-8 and quest.constant:35-36
// (complete 80 on the Armadyl side, 90 on the Lucien side). Each stage's own text of ikov_journal.rs2, from the highest
// stage down. Stages 20 and 30 show one text (ikov_journal.rs2:29-36), so the parser names 20. The journal is at most
// 13 lines.
export function ikovJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return /the staff had made him more powerful/i.test(text) ? 90 : 80;
    if (/I will kill Lucien\. The guardians gave me a pendant/i.test(text)) return 70;
    if (/Winelda teleported me across after I got her twenty limpwurt roots/i.test(text)) return 60;
    if (/Winelda will teleport me across if I first get her twenty limpwurt roots/i.test(text)) return 50;
    if (/I went into another chamber and was attacked by a Fire Warrior/i.test(text)) return 40;
    if (/I have found some boots of lightness/i.test(text)) return 20;
    if (/Lucien has asked me to retrieve the Staff of Armadyl/i.test(text)) return 10;
    if (/I can start this quest at the Flying Horse Inn/i.test(text)) return 0;
    return undefined;
}

// The index in quest-ikov.ts STAGES (['start', 'low', 'arrows', 'warrior', 'winelda', 'teleport', 'lucien'],
// q.stageName). 'warrior' (a debug preset at %ikov 30 by the trap-lever door) has no journal text of its own.
export function ikovFrom(stage: number): number | undefined {
    switch (stage) {
        case 0: return 0;               // start
        case 10: return 1;              // low: the cellar ladder, the boots, the lever
        case 20: case 30: return 2;     // arrows: the chests if fewer than 10 arrows, the trap lever, its door
        case 40: return 4;              // winelda: through the door of fear and the two doors, "Yes I do!"
        case 50: case 60: return 5;     // teleport: the roots (50) or a free teleport (60), the guardian
        case 70: return 6;              // lucien: Varrock Teleport, the pendant of Armadyl, the kill
    }
    return undefined;
}

const IKOV_LIT_CANDLE = 33, IKOV_KNIFE = 946, IKOV_LIMPWURT = 225, IKOV_ICE_ARROW = 78, PENDANT_LUCIEN = 86, PENDANT_ARMADYL = 87;

// Quest items that the script needs from a stage on: the pendant of Lucien for the door of fear north
// (ikov_dungeon.rs2:15-23) at 10-60, the ice arrows for the Fire Warrior at 20-30, the pendant of Armadyl to attack
// Lucien at 70 (quest_ikov.rs2:26).
export function ikovHeld(stage: number): readonly number[] {
    if (stage >= 70) return [PENDANT_ARMADYL];
    if (stage === 20 || stage === 30) return [PENDANT_LUCIEN, IKOV_ICE_ARROW];
    if (stage >= 10) return [PENDANT_LUCIEN];
    return [];
}

// The script drops the knife and the lit candle after the boots (stage 10), and Winelda takes the 20 roots at 50 -> 60
// (winelda.rs2:9).
export function ikovSpent(stage: number): readonly number[] {
    if (stage >= 60) return [IKOV_LIT_CANDLE, IKOV_KNIFE, IKOV_LIMPWURT];
    if (stage >= 20) return [IKOV_LIT_CANDLE, IKOV_KNIFE];
    return [];
}

// Dragon Slayer: %dragonquest (varp 176; quests/quest_dragon/configs/quest_dragon.constant, complete 10 at
// quest.constant:18). The journal also shows the side varps %dragon_oracle, %dragon_shield and %dragon_goblin (184, 186,
// 187), the map pieces in the pack (inv only: dragon_journal.rs2:103, 110, 121) and the shield (:151-153). The stage is
// %dragonquest * 10, plus at %dragonquest 2 the part that the text shows:
//   20  a side varp unset: "return to Oziach" (dragon_journal.rs2:26-27; %dragonquest 3 shows the same text, :38-39)
//   21  all side varps set; no Oracle rhyme and no map piece 3 in the pack
//   22  the Oracle's rhyme: %dragon_oracle 2 and no piece 3 in the pack (:113-114, 135-146)
//   23  map piece 3 or the joined map in the pack (:110-111)
// The longest journal has 27 lines, under the 49 that split_init shows.
export function dragonJournalStage(body: string): number | undefined {
    const text = journalText(body);
    if (/QUEST COMPLETE!/i.test(text)) return 100;
    if (/Now all I need to do is kill the dragon!/i.test(text)) return 90;
    if (/Now I should go to my ship in Port Sarim and set sail for Crandor!/i.test(text)) return 80;
    // %dragonquestvar reaches 3 only with %dragonquest 3 -> 7 (lady_lumbridge.rs2:79-87).
    if (/I still need to find a captain for my ship/i.test(text)) return /I have repaired my ship using wooden planks/i.test(text) ? 70 : 30;
    if (/I should see if there is a ship for sale in Port Sarim/i.test(text)) {
        if (/I found the piece of the map that was hidden in beneath Ice Mountain/i.test(text)) return 23;
        if (/Last, a bowl that's not seen heat/i.test(text)) return 22;
        return 21;
    }
    if (/I should return to Oziach for more detailed instructions/i.test(text)) return 20;
    if (/I should speak to Oziach, who lives by the cliffs to the west of Edgeville/i.test(text)) return 10;
    if (/I can start this quest by speaking to the Guildmaster/i.test(text)) return 0;
    return undefined;
}

// quest-dragon.ts DS_FROM (a milestone) for each stage: 20 goes back to Oziach, 21 asks the Oracle, 22 goes to the magic
// door, 23 starts at the maze; at 21-23 the script skips the mine, the maze and the Duke when it holds their piece or
// the shield. 30 repairs the ship, 70 goes to Wormbrain, 80 sails, 90 kills Elvarg (off Crandor it sails again first:
// dragonslayer_ned.rs2:22-24 reset the ship).
export function dragonFrom(stage: number): number | undefined {
    switch (stage) {
        case 0: return 0;
        case 10: case 20: return 1;
        case 21: return 2;
        case 22: return 3;
        case 23: return 4;
        case 30: return 11;
        case 70: return 12;
        case 80: return 14;
        case 90: return 15;
        default: return undefined;
    }
}

const MELZAR_KEY = 1542, DS_PART1 = 1535, DS_PART2 = 1536, DS_PART3 = 1537, DS_MAP = 1538, ANTIDRAGON_SHIELD = 1540;
const DS_DOOR_ITEMS = [1907, 1791, 301, 950]; // wizard's mind bomb, unfired bowl, lobster pot, silk
const DS_PLANK = 960, DS_NAILS = 1539;

// Quest items (quest_dragon.obj tradeable=no) that the account got before a stage and still needs. Oziach does not give
// a second Melzar's key while one is in the bank (oziach.rs2:122). Pieces 1 and 3 and the shield come before the ship,
// piece 2 and the map at 70 (Wormbrain, then the join, crandor_map.rs2:34-45); the map goes to Ned at 80. At 21-23 an
// account can hold piece 1 or the shield in any order: the maze chest gives no piece while one is banked
// (melzars_maze.rs2:160), so a banked one comes back to the pack.
export function dragonHeld(stage: number): readonly number[] {
    if (stage === 20) return [MELZAR_KEY];
    if (stage >= 21 && stage <= 23) return [MELZAR_KEY, DS_PART3, DS_PART1, ANTIDRAGON_SHIELD];
    if (stage === 30) return [DS_PART1, DS_PART3, ANTIDRAGON_SHIELD];
    if (stage === 70) return [DS_PART1, DS_PART2, DS_PART3, DS_MAP, ANTIDRAGON_SHIELD];
    if (stage === 80 || stage === 90) return [ANTIDRAGON_SHIELD];
    return [];
}

// The magic door takes its four items (magic_door.rs2:10-16) and opens freely after (:24-26). Each plank takes 4 nails
// (lady_lumbridge.rs2:77-78); at 90 the crash reset the hull and the second sail needs them again. Klarense takes 2,000
// coins (klarense.rs2:91-96) and Wormbrain 10,000 (wormbrain.rs2:63-71).
export function dragonSpent(stage: number): readonly number[] {
    if (stage === 23 || stage === 30) return DS_DOOR_ITEMS;
    if (stage === 70) return [...DS_DOOR_ITEMS, DS_PLANK, DS_NAILS];
    if (stage === 80) return [...DS_DOOR_ITEMS, DS_PLANK, DS_NAILS, 995];
    if (stage === 90) return [...DS_DOOR_ITEMS, 995];
    return [];
}

const SQUIRE_PIE = 2325;
// Raw beef, rat, bear and chicken (quest_druid preset), and the enchanted meats of the Cauldron of Thunder.
const DRUID_RAW_MEATS = [2132, 2134, 2136, 2138];
const DRUID_ENCHANTED_MEATS = [522, 523, 524, 525];

export const QUEST_RESUME: Readonly<Record<string, QuestResume>> = {
    // Thurgo eats the redberry pie at stage 2 -> 3 (quest_squire.rs2:125-151).
    squire: { key: 'squire', title: /Knight's Sword/i, stage: squireJournalStage, complete: 7, spent: (stage) => (stage >= 3 ? [SQUIRE_PIE] : []) },
    // Sanfew takes the four enchanted meats at 2 -> 3 (sanfew.rs2:55-64). At 2 an earlier run can have dipped some
    // meats in the cauldron: the sweep withdraws a banked enchanted meat, and quest-druid.ts dips only the others.
    druid: {
        key: 'druid', title: /Druidic Ritual/i, stage: druidJournalStage, complete: 4,
        spent: (stage) => (stage >= 3 ? DRUID_RAW_MEATS : []),
        held: (stage) => (stage === 2 ? DRUID_ENCHANTED_MEATS : []),
    },
    // The pack has no item that the quest takes: the barman's 5 coins come from the staged 20.
    arena: { key: 'arena', title: /Fight Arena/i, stage: arenaJournalStage, complete: 14, from: arenaFrom },
    // quest-crest.ts goes on from the start tile beside Dimintheis at every stage 1-10: each later block starts with a
    // teleport (the Lumbridge teleport and the toll gate into Al Kharid at 5-7, the Varrock teleport at 10).
    crest: { key: 'crest', title: /Family Crest/i, stage: crestJournalStage, complete: 11, spent: crestSpent, held: crestHeld },
    // The mouse hole takes the cheese before the magnet unlocks the back door (quest_ball.rs2:80-86, 111-112). The
    // cupboard gives a magnet and the fountain a shed key only when the pack and the bank hold none (:67-70, :163-165),
    // so the sweep withdraws a banked one.
    // The candles and Excalibur are tradeable=no (quest_arthur.obj:16,63,94): an earlier run at stage 4 can have made
    // the candle (candle_maker.rs2:11) or got Excalibur (beggar.rs2:122), and the sweep withdraws a banked one. A banked
    // Excalibur also hides the Lady's offer (lady_of_the_lake.rs2:4). The candle maker takes the wax before Thrantax
    // (candle_maker.rs2:10), the beggar the bread before the crystal (beggar.rs2:114); at stage 5 the bread stays
    // staged, so a lost Excalibur is got again.
    merlin: {
        key: 'arthur', title: /Merlin's Crystal/i, stage: merlinJournalStage, complete: 7, from: (stage) => MERLIN_FROM[stage],
        held: (stage) => (stage === 4 ? [MERLIN_LIT_CANDLE, MERLIN_UNLIT_CANDLE, MERLIN_EXCALIBUR] : stage === 5 ? [MERLIN_EXCALIBUR] : []),
        spent: (stage) => (stage >= 6 ? [MERLIN_WAX, MERLIN_BREAD] : stage === 5 ? [MERLIN_WAX] : []),
    },
    dragon: { key: 'dragon', title: /Dragon Slayer/i, stage: dragonJournalStage, complete: 100, from: dragonFrom, held: dragonHeld, spent: dragonSpent },
    ikov: { key: 'ikov', title: /Temple of Ikov/i, stage: ikovJournalStage, complete: 80, from: ikovFrom, held: ikovHeld, spent: ikovSpent },
    grail: { key: 'grail', title: /Holy Grail/i, stage: grailJournalStage, complete: 10, from: grailFrom, held: grailHeld, spent: grailSpent, extra: grailExtra },
    ball: {
        key: 'ball', title: /Witch's House/i, stage: ballJournalStage, complete: 7,
        spent: (stage) => (stage >= 3 ? [BALL_CHEESE] : []),
        held: (stage) => (stage === 2 ? [BALL_MAGNET] : stage === 3 || stage === 5 ? [BALL_SHED_KEY] : []),
    },
};

// Quests whose script or sweep branch reads a started journal itself: the journal stage parsers of priestperil, zanaris,
// rj and totem, the journal-flag branches of cook, druidspirit, fluffs, hetty, hunt, priest, runemysteries, sheepherder
// and vampire, the held armour and Ceril's greeting of hazeelcult, and the sweep's own Black Knight return to Amik
// (sweep-plan.ts returnToAmik).
export const SELF_RESUME: ReadonlySet<string> = new Set([
    'blackknight', 'cook', 'druidspirit', 'fluffs', 'hazeelcult', 'hetty', 'hunt', 'priest', 'priestperil', 'rj',
    'runemysteries', 'sheepherder', 'totem', 'vampire', 'zanaris',
]);

// A quest that can go on from a started journal.
export function questResumable(slug: string): boolean {
    return SELF_RESUME.has(slug) || Object.hasOwn(QUEST_RESUME, slug);
}

// The quest points that the start of a quest tests: the Champions' Guild door before the guildmaster of Dragon Slayer
// (live quest_board:dragon: "The door won't open - you need at least 32 Quest Points"), the Heroes' Guild for Heroes'
// Quest and the Legends' Guild for Legends' Quest. The server sends %qp (varp 101, packages/core/src/guild-facts.ts).
export const QUEST_POINTS_REQUIRED: Readonly<Record<string, number>> = { dragon: 32, hero: 55, legends: 107 };

export type QuestEntry =
    | { readonly kind: 'run' }
    | { readonly kind: 'resume'; readonly resume: QuestResume }
    | { readonly kind: 'refuse'; readonly reason: string };

export type QuestResumeStart =
    | {
        readonly kind: 'resume'; readonly from: number; readonly spent: readonly number[]; readonly held: readonly number[];
        readonly extra: readonly { readonly id: number; readonly count: number }[];
    }
    | { readonly kind: 'refuse'; readonly reason: string };

// What the sweep does with the journal stage that it read: the script's FROM value and the items to leave out or fetch,
// or a named refusal.
export function resumeStart(resume: QuestResume, name: string, stage: number): QuestResumeStart {
    if (stage >= resume.complete) return { kind: 'refuse', reason: `refused: ${name} journal stage ${stage} is complete` };
    const from = resumeFrom(resume, stage);
    if (from === undefined) return { kind: 'refuse', reason: `refused: ${name} journal stage ${stage} has no resume from the start tile` };
    return { kind: 'resume', from, spent: resume.spent?.(stage) ?? [], held: resume.held?.(stage) ?? [], extra: resume.extra?.(stage) ?? [] };
}

// The refusal text starts with "refused:": the supervisor ends the job on it and does not log in again
// (packages/practice/src/supervise.ts isNamedRefusal). An unknown quest point total does not refuse.
export function questEntry(slug: string, name: string, state: QuestJournalState, questPoints?: number): QuestEntry {
    const qpNeed = QUEST_POINTS_REQUIRED[slug];
    if (qpNeed !== undefined && state === 'not started' && questPoints !== undefined && questPoints < qpNeed) {
        return { kind: 'refuse', reason: `refused: ${name} needs ${qpNeed} quest points, the account has ${questPoints}` };
    }
    if (SELF_RESUME.has(slug) || state === 'not started' || state === 'unknown') return { kind: 'run' };
    if (state === 'complete') return { kind: 'refuse', reason: `refused: ${name} is complete` };
    const resume = QUEST_RESUME[slug];
    if (resume) return { kind: 'resume', resume };
    return { kind: 'refuse', reason: `refused: ${name} journal is started and quest-${slug}.ts has no resume stage` };
}
