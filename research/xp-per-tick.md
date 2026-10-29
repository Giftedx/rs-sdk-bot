# XP per tick of the specialist's own playtime

Source: rev 289 RuneScript in `vendor/rs-sdk/server/content/scripts` (paths below are relative to that folder, unless they start with `engine/`, which means `vendor/rs-sdk/server/engine/src`).

Assumptions: members world, 25x XP rate, 99 = 998,458 XP, helpers supply all tradeable items (noted where useful), the specialist pays only for its own ticks. "Est. ticks" comes from a greedy simulation (best XP/tick method at each level) on the server curve. The simulation script was a scratch file and is not committed. Estimates include a bank or trade overhead model, which is inferred, not measured.

## Summary table

| Skill | Best method found | Req. | XP/action base -> 25x | Rate | Est. ticks 1->99 | Live #1 | Explained? |
|---|---|---|---|---|---|---|---|
| Cooking | Bank-wide wine ferment, timer started by **login** | none for the timer | 110 -> 2,750 per wine, batched | one timer, 20 ticks after login | ~20-25 | 38 | Yes. Live 38 = ~18 ticks to reach 35 + 20-tick timer |
| Fletching | Arrows then darts (15 or 10 per action) | 1 | 15x13=195 tenths -> 487 (bronze arrows) ... 10x188 -> 4,700 (rune darts) | 5 actions/tick | 48 | 58 | Yes |
| Crafting | Gem cutting, dragonstone from 55 | 1 | 137.5 -> 3,437 | 5/tick, 27 per bank cycle (7 ticks) | 79 | 197 | Method yes; live is slower than the model |
| Herblore | Finish potions (secondary on unf), zamorak brew from 78 | 1 (no Druidic Ritual check) | 25 -> 625 ... 175 -> 4,375 | 5/tick, 14 per bank cycle (4 ticks) | 71 | 447 | Not fully. Live is 6x slower; bank model may be optimistic |
| Firemaking | Logs ladder to magic logs | 1 | 40 -> 1,000 ... 303.8 -> 7,595 | ~4 ticks/log at full success | 693 | 673 | Yes |
| Prayer | Bury dragon bones | 1 | 72 -> 1,800 | 2 ticks/bone | 1,169 | 1,281 | Yes |
| Smithing | Platebodies (5 bars) ladder, adamant from 88 | 1 | 5x62.5 -> 7,812 (addy body) | 5 ticks/item | 913 | 1,337 | Partly (live slower) |
| Magic | Enchant jewellery; **Charge** at 80 if Mage Arena done | 7 / 80 | 78 -> 1,950 (enchant 5); 180 -> 4,500 (Charge) | 3 ticks/cast; Charge 5/tick | 1,708; 570 + Mage Arena time with Charge | 1,513 | Partly. Live beats pure enchant |
| Runecraft | Trade 27 essence into the altar, craft, repeat; law from 54 | 1 | 27 x 9.5 -> 6,412 per trip (law) | 8-14 ticks/trip | 1,256 (8 t/trip) - 2,198 (14 t/trip) | 2,354 | Yes (trip length dominates) |
| Thieving | Pickpocket ladder, Ardougne knights from 55 | 1 | 84.3 -> 2,107 | 2 ticks + 8-tick stun on fail | 2,325 | 2,935 | Yes |
| Woodcutting | Oak then willow, drop logs | 1 | 67.5 -> 1,687 (willow) | 4 ticks/roll | 3,852 | 3,329 | Partly (live faster) |
| Fishing | Fly fishing, then karambwan at 65 | 1 / 65 | 105 -> 2,625 (karambwan) | 5 ticks/roll | 3,940 | 3,425 | Partly |
| Mining | Essence to 15, then power-mine iron | 1 / 15 | 35 -> 875 (iron) | 3 ticks/roll with rune pick | 3,601 (no depletion) - 5,355 | 3,964 | Yes |
| Agility | Gnome -> Barbarian -> Wilderness course | 1/35/52 | 571.4 -> 14,285 per wilderness lap | ~90 ticks/lap (inferred) | ~6,800 | 6,772 | Yes (inferred) |
| Attack | Quest XP: Waterfall + Tree Gnome Village + Grand Tree (+ MM) | quests | 343,750 + 286,250 + 460,000 | one-off | quest time only | 4,728 | Plausible (inferred) |
| Strength | Quest XP: Haunted Mine + Waterfall + Dragon Slayer / Scorpion Catcher | quests | 550,000 + 343,750 + 466,250 | one-off | quest time only | 4,966 | Plausible (inferred) |
| Defence | Quest XP: Dragon Slayer + Holy Grail + MM | quests | 466,250 + 382,500 + 875,000 | one-off | quest time only | 7,974 | Plausible (inferred) |
| Ranged | Dwarf multicannon + own ranged attacks | Dwarf Cannon quest | 2 XP/dmg -> 50/dmg (cannon); 4 -> 100/dmg (player) | cannon up to 1 shot/tick | ~1,700 + quest (inferred) | 5,595 | Not verified |
| Hitpoints | MM reward (875,000) + Witch's House (158,125), or combat at 1.33 XP/dmg | quests | 33.25 XP/dmg at 25x | combat-bound | quest time only | 17,058 | Live looks like plain combat |

## Engine facts that every estimate uses

- **The 25x rate applies to every script source.** `STAT_ADVANCE` calls `addXp(stat, xp)` with the default `allowMulti = true` (`engine/engine/script/handlers/PlayerOps.ts:811-817`). `addXp` multiplies by `Environment.node.xpRate` (`engine/engine/entity/Player.ts:1878-1890`). Quests, timers, minigames, and lamps all use `stat_advance`, so all of them get 25x. The only call with `allowMulti = false` is the `::` cheat handler (`engine/network/game/client/handler/ClientCheatHandler.ts:483`). Default rate 25: `engine/util/WorldConfig.ts:102`.
- XP is stored in tenths. `stat_advance(cooking, 1100)` = 110 XP base = 2,750 XP at 25x.
- **5 successful user actions per tick.** `decodeIn` stops at `USER_EVENT.limit = 5` (`engine/network/game/client/ClientGameProtCategory.ts:5-8`, `engine/engine/entity/NetworkPlayer.ts:69,141-146`). OpHeld, OpHeldU, OpHeldT, IfButton, InvButton, CloseModal, OpLoc, and OpNpc are all USER_EVENT. Only successful packets count toward the limit.
- OpHeld/OpHeldU scripts run **immediately** in the packet handler (`OpHeldUHandler.ts:118`). They are refused only when `player.delayed` is set (`OpHeldUHandler.ts:16`). An open chat modal (level-up) does not block them. So an item-on-item script with no `p_delay` can run 5 times per tick.
- **`p_delay(n)` costs n+2 ticks between client actions.** `delayedUntil = tick + 1 + n` (`PlayerOps.ts:376-379`). The flag clears in `processPlayers` (`engine/engine/World.ts:776`), which runs after packet decode, so the packet on tick `delayedUntil` is still refused. Measured from the code: bury `p_delay(0)` = 2 ticks, enchant `p_delay(1)` = 3 ticks, high alch `p_delay(3)` = 5 ticks.
- Normal timers, queues, and loc/npc interactions need `canAccess()`: not delayed and no main or chat modal open (`Player.ts:873-889,1010`). A level-up chat blocks the wine timer and the bank booth until the modal closes. CloseModal takes effect in the next `processQueues`, not at once (`CloseModalHandler.ts`).
- Bank cycle model (inferred): last action tick + OpLoc booth, then one tick of deposit-all, withdraw, withdraw, close, then actions resume. The model uses 1 extra tick per inventory.

## Per-skill notes

### Cooking (seen in code)
- `skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2:22-70`: `[timer,fermenting_wine]` takes `inv_total(bank, jug_unfermented_wine)`. It splits the total into 15 batches. Each batch is **one** `stat_random(cooking,48,352)` roll and gives `stat_advance(cooking, calc(1100 * $wines_per_batch))` (line 35).
- **The level 35 check is only in `[label,make_wine]` (line 8).** `[proc,ferment_wines_login]` (line 72-73) sets the same 20-tick timer, and `login_logout/login.rs2:70` calls it on **every login** with no level check.
- Fastest route: helpers trade noted unfermented wine (`cert_jug_unfermented_wine` exists in `content/pack/obj.pack:1997`). The specialist logs in (timer starts), deposits the notes at a bank, and closes the bank before tick 20. At level 1 a batch succeeds with p ~ 48/256 = 19%. P(all 15 batches fail) is about 4%. After one success the level is 99 and the remaining batches always pass. With 15,000 wines in the bank, one batch = 1,000 wines = 2.75M XP. Est. 20-25 ticks.
- If the login route fails: reach 35 with fruit blasts. `gnome_cooking/gnome_cocktail_finish.rs2:27-31` gives 60 XP (1,500 at 25x) per finish, has no level check and no delay, and needs 8 actions (2 ticks). Then make one wine (instant, wine.rs2:13-20) and wait 20 ticks. Total ~23 ticks. Live 38 fits "reach 35 in ~18 ticks + 20-tick timer".
- Items: noted unfermented wine (or jugs and grapes), and `unfinished_fruit_blast1` with lemon slices for the fallback.

### Fletching (seen in code)
- `skill_fletching/scripts/arrows.rs2:70-86`: up to 15 arrows per action, XP = count x table XP, no delay. `darts.rs2:41-62`: 10 darts per action. Tables: `skill_fletching/configs/arrows/arrows.dbrow`, `darts/darts.dbrow`.
- Per action at 25x: bronze arrows 487 (lvl 1), iron arrows 937 (15), iron darts 950 (22), steel arrows 1,875 (30), mithril arrows 2,812 (45), adamant arrows 3,750 (60), rune arrows 4,687 (75), rune darts 4,700 (81).
- 5 actions per tick, all items stack, so no banking. Sim: 48 ticks from level 1 to 99.
- Items: headless arrows (made by helpers), arrowheads and dart tips of every tier, feathers.

### Crafting (seen in code; rate inferred)
- `skill_crafting/scripts/gem/uncut_gem.rs2:15-63`: chisel on uncut gem, one gem per action, no delay. XP from `skill_crafting/configs/gem/gem.dbrow`: sapphire 20 (50), emerald 27 (67.5), ruby 34 (85), diamond 43 (107.5), dragonstone 55 (137.5 -> 3,437). Opal, jade, and red topaz can fail and smash.
- Battlestaves (`battlestaves.rs2:15-38`, air 66 = 137.5) tie with dragonstone and use 2 slots per action, so they are worse.
- Model: 27 uncut gems per inventory, 7 ticks per inventory. Sim: 79 ticks. Live 197 suggests slower banking or a different method.
- Items: uncut gems of every tier, chisel.

### Herblore (seen in code; rate inferred)
- `skill_herblore/scripts/brewing/brew_potion.rs2:98-147` and `scripts/herblore.rs2:10-24`: one potion per OpHeldU, no `p_delay`, `anim` only. Identify and brew have **no Druidic Ritual check**, see `scripts/identifying/identify.rs2` (the comment above the level check).
- Levels and XP: `skill_herblore/configs/brewing/brew_potion.struct`. Examples: attack potion 25 (625), super defence 66 (150 -> 3,750), zamorak brew 78 (175 -> 4,375).
- Model: 14 unfinished potions + 14 secondaries per inventory, 4 ticks per inventory. Sim: 71 ticks. Live 447 is far slower. Either the live player banks slowly, or the bank model is wrong. Test the bank cycle in game before you rely on it.
- Items: unfinished potions of every tier and their secondaries.

### Firemaking (code-read)
- `skill_firemaking/scripts/firemaking.rs2:79-131`: `%action_delay` +3 for the initial attempt, then a roll every 4 ticks, `stat_random(firemaking,64,512)` (always succeeds from about level 44). XP is in `configs/firemaking.obj`: logs 40, oak 60, willow 90, maple 135, yew 202.5, magic 303.8.
- Sim: 693 ticks. Live 673 matches.
- Other options: Mort'ton pyre, `pyre_fm_experience` up to 404.5 (`minigames/game_mortton/configs/flamtaer_pyre.struct:64`). This needs the Shades of Mort'ton quest. The cycle time is not checked.

### Prayer (seen in code)
- `skill_prayer/scripts/bury_bone.rs2:1-15`: `p_delay(0)` = 2 ticks per bone. Dragon bones = 72 XP (`configs/bones.obj:82`) -> 1,800.
- 555 bones. Model: 28 bones per inventory + 3 ticks. Sim: 1,169 ticks. Live 1,281 matches.

### Smithing (seen in code; overhead inferred)
- `skill_smithing/scripts/smithing/smithing.rs2:271-301`: `p_delay(1)`, XP = bars x xpperbar (line 283), then `p_delay(2)`. That is 5 ticks per item for the whole make-X loop. Platebody = 5 bars (bronze 18, iron 33, steel 48, mithril 68, adamant 88, `configs/smithing/smithing.dbrow:793-846`).
- Sim: 913 ticks (5 ticks per item + 4 ticks per load). The anvil-to-bank distance is unknown. A helper can trade bars at the anvil instead.
- Quest XP: Knight's Sword `quests/quest_squire/scripts/quest_squire.rs2:223` = 318,125 at 25x.

### Magic (seen in code)
- Enchant: `skill_magic/scripts/spells/enchant.rs2:7-53`, `p_delay(1)` = 3 ticks. XP from `configs/magic_spells.dbrow`: lvl1 (7) 17.5, lvl2 (27) 37, lvl3 (49) 59, lvl4 (57) 67, lvl5 (68) 78.
- Teleports `spells/teleport.rs2:61-65` take about 4 ticks. Superheat (`superheat.rs2:67`, 43) takes 3 ticks. High alch takes 5 ticks (`alchemy.rs2:37`).
- **Charge**: `spells/charge.rs2:1-26` gives 180 XP (4,500 at 25x) per cast, level 80, **no `p_delay`**, and the "already charged" check is commented out (lines 8-11). That allows 5 casts per tick = 22,500 XP/tick, so 80->99 takes ~33 ticks. It needs `%magearena >= ^mage_arena_staff_given`, which means the Mage Arena fight, and the time for that fight is unknown. Runes: blood, fire, air.
- Sim: enchant ladder 1,708 ticks. Enchant to 80 then Charge: 570 ticks + Mage Arena time. Live 1,513 beats pure enchant.
- Quest XP: Watchtower `quests/quest_itwatchtower/scripts/quest_itwatchtower.rs2:533` = 382,500.

### Runecraft (seen in code; trip time inferred)
- `skill_runecraft/scripts/runecraft.rs2:68-99`: XP = all essence in the inventory x rune XP (line 95), then `p_delay(3)` (5 ticks). There are no pouches.
- The death altar is not reachable: `deathtemple_ruined` has no op (`configs/runecraft.loc:284-289`). The best altar is law (54, 9.5 XP).
- Method: stay in the altar. A helper trades 27 essence (`interface_trade/scripts/trade.rs2`, 2 accept screens), the specialist crafts, and the cycle repeats. Est. 8 ticks per trip with trade, or ~14 if slower. One air trip from level 1 = 3,375 XP = level 20.
- Sim: 1,256 ticks (8 per trip) to 2,198 (14 per trip). Live 2,354 fits.

### Thieving (seen in code)
- `skill_thieving/scripts/thieving.rs2:1-22`: pickpocket = `p_delay(0)` = 2 ticks. A fail gives an 8-tick stun (line 49). Table: `configs/pickpocking/*.dbrow` (knight 55 = 84.3 XP, success 50..240).
- Sim: 2,325 ticks, knights from 55 to 99. Live 2,935 fits.
- Quest XP: Tourist Trap choice `quests/quest_desertrescue/scripts/irena.rs2:89` = 116,250.

### Woodcutting (seen in code)
- `skill_woodcutting/scripts/woodcut.rs2:153-190`: a roll every 4 ticks. Rune axe rates are in `configs/*.dbrow` (willow 56..175, yew 14..44, magic 7..21). On this server, yew and magic trees give less XP per tick than willow.
- Kharazi jungle: `quests/quest_legends/scripts/jungle_tree.rs2:115-131`, 100 XP per log at 50% x `stat_random(70,233)`. It needs the Legends' Quest map. It is no better than willows.
- Sim: 3,852 ticks (oak, then willow). Live 3,329 is faster. The cause is not found.

### Fishing (seen in code)
- A roll every 5 ticks (`skill_fishing/scripts/fishing_spots/freshfish.rs2:37-39`). Karambwan: `fishing_spots/tbwt.rs2:99-127`, 105 XP (2,625), level 65, `stat_random(5,160)`, needs Tai Bwo Wannai Trio started (Lubufu).
- Sim: 3,940 ticks (fly fishing, then karambwan). Live 3,425.
- Quest XP: Sea Slug `areas/area_ardougne_east/scripts/caroline.rs2` 71,750 -> 179,375; Tai Bwo Wannai Trio `areas/area_karamja/scripts/tbwt_tiadeche_final.rs2` 50,000 -> 125,000.

### Mining (seen in code)
- `skill_mining/scripts/mining.rs2:118-214`: roll period = pickaxe `mining_rate` + 1 (rune 2 -> 3 ticks, `configs/pickaxes.obj:198`). Iron uses `get_ore_fast` (no `p_delay`), 35 XP, success 96..350, respawn 20. Essence always succeeds but gives only 5 XP.
- Sim: 3,601 ticks if a rock is always ready, 5,355 with 1.5x depletion waits. Live 3,964 fits.
- Quest XP: Dig Site `quests/quest_itexam/scripts/quest_itexam.rs2:41` = 382,500.

### Agility (seen in code; lap time inferred)
- Wilderness course (52): obstacles plus the 498.9 lap bonus (`skill_agility/scripts/wilderness_course.rs2:76-176`) = 571.4 XP per lap -> 14,285. At ~90 ticks per lap, 52->99 takes ~6,000 ticks. Gnome and Barbarian courses up to 52 add ~730 ticks. Total ~6,800. Live 6,772 matches.
- Rejected options: agility arena tickets (`minigames/game_agilityarena/scripts/agilityarena_tickettrader.rs2:48,60-67`) give 1,000 tickets -> 8M XP, but tickets are `tradeable=no` (`configs/agilityarena.obj:15`) and the pillar moves every 98 ticks (`agilityarena_clerk.rs2:85`).
- To test in game: Watchtower climbing rocks (`skill_agility/scripts/shortcuts.rs2:16-24`), level 5, 25 XP (625), `p_telejump` with **no delay**, at map tile (2561,3108). The return path length decides the rate.
- Quest XP: Regicide `quest_regicide.rs2:852` = 343,750; Troll Romance `quest_troll_love.rs2:305` = 200,000; Grand Tree `quest_grandtree.rs2:199` = 197,500.

### Attack, Strength, Defence, Hitpoints, Ranged (formula seen in code; times inferred)
- Combat XP: `skill_combat/scripts/combat.rs2:88-150`. 4 XP per damage in the trained style -> 100/dmg at 25x. Hitpoints get 1.33/dmg -> 33.25. NPC `combat_xp_multiplier` is only ever lower than the default (`macro events/configs/antimacro.npc`). Attack dummy: 5 XP per 6 ticks (`areas/area_varrock/scripts/attack_dummy.rs2:12-15`), which is useless.
- Cannon: `quests/quest_mcannon/scripts/cannon_fire.rs2:91,117-119` rotates every tick, max hit 30, and gives 2 XP/dmg (50 at 25x) to ranged. It does not depend on the player's level.
- Quest XP is the large lever (25x applies):
  - Monkey Madness `quest_mm/scripts/mm_daero.rs2:295-307`: 875,000 to two skills of att/def/str/hp and 500,000 to the other two.
  - Grand Tree attack `quest_grandtree.rs2:200` = 460,000.
  - Waterfall attack and strength `quest_waterfall.rs2:491-492` = 343,750 each.
  - Tree Gnome Village `quest_tree.rs2:98` = 286,250.
  - Fight Arena `quest_arena.rs2:270` = 304,375.
  - Haunted Mine strength `quest_hauntedmine/scripts/hauntedmine_crystals.rs2:54` = 550,000.
  - Dragon Slayer strength and defence `quest_dragon.rs2:33-34` = 466,250 each.
  - Holy Grail defence `quest_grail.rs2:117` = 382,500 and prayer `:116` = 275,000.
  - Witch's House hitpoints `quest_ball.rs2:202` = 158,125.
  - Temple of Ikov ranged `quest_ikov.rs2:62` = 262,500.
- Waterfall + Tree Gnome Village + Grand Tree = 1.09M Attack. That fits live Attack 4,728 if those quests take about 4,700 ticks. The quest durations are not measured.

### Rejected or one-off sources
- XP lamps give level x 10 XP (`general/scripts/xplamp/xplamp.rs2:110-111`), but the lamp is `tradeable=no` (`general/configs/xplamp.obj:12`).
- Big Chompy Bird Hunting: a one-time 750,000 ranged at **4,000 kills** (`quest_chompybird/scripts/chompy_bird.rs2:211-212`).

## Open checks before you build on these numbers
1. Measure the bank cycle (Herblore, Crafting) in game: ticks per 14 and per 27 actions.
2. Test the login wine timer: noted deposit, then fire at tick 20 with no modal open.
3. Measure trade-in-altar ticks for Runecraft.
4. Measure the Mage Arena duration (it gates Charge).
5. Find the return path of the Watchtower rocks.
6. Measure quest durations for the combat skills.
