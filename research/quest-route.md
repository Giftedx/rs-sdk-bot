# Quest routes to 99

Quest XP: [quest-xp](quest-xp.md), read from this server's quest scripts (x25). Source checks and measured segments: [quest-plan](quest-plan.md). Current work: the [joined plan](../docs/plans/joined-plan.md). The scripts under `vendor/rs-sdk/server/content/scripts/quests/<quest>/` decide every requirement; a guide from another game revision decides none.

## XP of the quest chains

- Attack: Waterfall Quest 343,750 (+ Strength 343,750), Tree Gnome Village 286,250, Fight Arena about 304,000, Vampire Slayer 120,625, The Grand Tree 460,000 (+ Agility 197,500). The total is about 1.5M; level 99 needs 998,458.
- Strength: Waterfall 343,750 + Dragon Slayer 466,250 + Scorpion Catcher 165,625 = 975,625, plus Heroes' Quest 76,875.
- Defence: Dragon Slayer 466,250 + Holy Grail 382,500 = 848,750, plus Heroes' Quest 76,875.

## Requirements checked by the content

Paths are under `vendor/rs-sdk/server/content/scripts`.

| Quest | Requirement | Content line |
|---|---|---|
| The Grand Tree | Agility 25 | `quests/quest_grandtree/scripts/quest_grandtree.rs2:25` |
| Holy Grail | Merlin's Crystal complete | `areas/area_camelot/scripts/king_arthur.rs2:43` |
| Holy Grail | Attack 20 (the Excalibur wear level) | `levelrequire/scripts/tier20.rs2:16` |
| Scorpion Catcher | Prayer 31 | `quests/quest_scorpcatcher/scripts/scorpcatcher_journal.rs2:9` |
| Digsite Quest | Agility 10, Herblore 10, Thieving 25 | `quests/quest_itexam/scripts/itexam_journal.rs2:10,16,22` |
| Temple of Ikov | Thieving 42 | `quests/quest_ikov/scripts/ikov_dungeon.rs2:158` |
| Temple of Ikov | Ranged 40 | `quests/quest_ikov/scripts/ikov_journal.rs2:15` (journal text; no script check) |
| Underground Pass | Biohazard complete; Ranged 25 | `quests/quest_upass/scripts/quest_upass.rs2:81`; `areas/area_ardougne_east/scripts/king_lathas.rs2:95` |
| Regicide | Underground Pass, Agility 56, Crafting 10 | `quests/quest_regicide/scripts/regicide_journal.rs2:16,21` |
| Haunted Mine | Agility 15, Crafting 35 | `quests/quest_hauntedmine/scripts/hauntedmine_journal.rs2:10,13` |
| Eadgar's Ruse | Druidic Ritual, Troll Stronghold, Herblore 31 | `areas/area_taverly/scripts/sanfew.rs2:27,102,103` |
| Heroes' Quest | Fishing 53, Cooking 53, Mining 50, Herblore 25 | `packages/dashboard/gen-quest-reqs.ts` `CONTENT_REQS` names each line |

Waterfall Quest, Tree Gnome Village, Fight Arena, Vampire Slayer, Witch's House and Watchtower have no skill check in their folders that this table lists. Tree Gnome Village is not a prerequisite of The Grand Tree. Dragon Slayer needs 32 quest points (`quests/quest_dragon/scripts/dragon_journal.rs2:7`).

One account can carry Attack, Strength, Defence, Hitpoints and Agility together: every board reads the same playtime clock.
