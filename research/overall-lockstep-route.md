# Overall lockstep route (SIM_LOCKSTEP=1)

Model and snapshot: [overall-lockstep-summary.json](overall-lockstep-summary.json) (mirrors local raw probe outputs and model runner under `.practice/overall-opt/`). Paths under `vendor/rs-sdk/server/` abbreviate `content/scripts/` as `C/` and `engine/src/` as `E/`. Server configuration: `SIM_LOCKSTEP=1`, `xpRate=25`, custom `2^(L/10)` curve (`XP99 = 998,458`).

Proof level: lockstep practice and engine/RuneScript code reads. Live server admission, resource contention, and helper fleet staging remain unverified.

## 1. Route totals and benchmarks

- **`Route R6-Max` (`allMaxed: true`, `hpDeficit: 0`):** **`21,310t`** realistic (`20,043 fg + 1,267 travel`, `4,712` relogs, `1,222,191` Hitpoints XP) / **`21,003t`** floor (`19,736 fg + 1,267 travel`, `4,686` relogs); conditions: `SIM_LOCKSTEP=1`, `29` realistic (`27` floor) Trawler helpers, guard-boxed Spice Stall at `(2658, 3299)`; evidence: `research/overall-lockstep-summary.json`; gap: live latency (`+0.5t` to `+2.0t` per relog) and Spice Stall `166t` offline respawn wall-clock.
- **`Route R6-Practical` (`allMaxed: true`, `hpDeficit: 0`):** **`23,020t`** realistic (`21,753 fg + 1,267 travel`, `4,192` relogs) / **`22,567t`** floor (`21,300 fg + 1,267 travel`, `4,166` relogs); conditions: caps Trawler at `20` helpers (`575t` 3t fly-fishing top-off) and uses Ardougne Knights relog-on-fail (`1,793t` real) instead of single-stall `166t` offline waits; evidence: `research/overall-lockstep-summary.json`; gap: same live latency sensitivity.

| Reference | Baseline / Record | Half Target | `Route R6-Max` Real | Delta vs Half |
|---|---:|---:|---:|---:|
| Live #1 (`okay_den`, `research/hiscores-2026-11-20.json`) | `29,972t` | `14,986t` | `21,310t` | `+6,324t` (`+8,662t` faster than live #1) |
| Planner baseline (`packages/planner/src/haggis-boards.json`) | `28,416t` real / `26,734t` floor | `14,208t` / `13,367t` | `21,310t` / `21,003t` | `+7,102t` real / `+7,636t` floor |
| Round 2 lockstep baseline | `26,623t` real / `25,441t` floor | `13,312t` / `12,721t` | `21,310t` / `21,003t` | `+7,998t` (`-5,313t` cut) |

## 2. Verified lockstep breakthroughs

- **Trawler 4-in-1 boat (`1,076t` = `24t` lobby + `1,047t` boat + `5t` net):** Fishing `78+3->99` (`evLv81 = 1,421.9 XP/roll` Manta Rays; `29` helpers Max / `20` helpers Practical + `575t` 3t-fly top-off), absorbing Firemaking `1->99` (`642/667t`), Crafting `1->99` (`194/195t`), and `153-175t` Herblore; conditions: `trawler_control.rs2` allows multi-player scaling on boat, Firemaking allowed on deck; evidence: `research/overall-lockstep-summary.json` (`ablationDecisions.trawlerEvCheck`, `.practice/overall-opt/round3-trawler.json`); gap: live helper fleet coordination and zero-tick Herb/Craft boat-pack integration test (`probe-round8-bottlenecks.ts`).
- **Brimhaven Agility Arena MDP (`3,476t` Max / `3,858t` Practical):** Exact 24-pillar / 38-edge Bellman MDP on `m43_149.jm2` level 3, `2.00t` abort (`[2, 2, 2]`), measured fast obstacles (`lowwall 8t`, `spikes 8t`, `pad 8t`, `blade 8t`, `saw 7t`), and `10+25+100` Jackie cash-in (`136` tickets, `1,004,040` Agility XP, `25.56 t/tkt`, `613` relogs); evidence: `research/overall-lockstep-summary.json` (`ablationDecisions.brimhavenModels`, `.practice/overall-opt/round6-verified.json`, `.practice/overall-opt/round7-verified.json`); gap: 9 obstacle edges (`plank`, `rope`, `log`, `monkey`, `ledge`, `pillar`, `swing`, `hands`, `darts`) still use `12-16t` conservative estimates rather than individual pillar-to-pillar lockstep timings.
- **Boxed Ardougne Spice Stall (`1,012.5 XP/t`):** North-side Spice Stall at `(2658, 3299)` yields `2,025` Thieving XP in `2` playtime ticks per spawn with 4 helpers boxing nearby market guards/knights/paladins; evidence: `research/overall-lockstep-summary.json` (`round6Probes`, `.practice/overall-opt/round6-verified.json`); gap: single-stall `166t` offline respawn (`C/skill_thieving/configs/stalls/stealing.dbrow:88`) imposes large wall-clock runtime (`~447 * 166t`); `Route R6-Practical` substitutes Ardougne Knights relog-on-fail (`1,793t` real).
- **1-tick multiway relog Combat, Ranged, and Magic:** Pooled 50-swing CB-101 `rune_2h_sword` Strength (`1,604.24` real / `1,768.48` floor `XP/t`), Attack (`1,462.48 XP/t`), Defence (`1,489.48 XP/t`), BiS Magic Longbow Ranged (`879.15 -> 1,046.25 XP/t`), Rune Thrownaxe 5-hit multiway spec (`4,950` Ranged XP in `2t` = `2,475 XP/t`), and 1t Curses/Stun (`954.6 -> 1,968.75 XP/t`, saving `601t` over Mage Arena + Charge at `-601` net delta); evidence: `.practice/overall-opt/round3-combat.json`, `.practice/overall-opt/round4-breakthroughs.json`, `.practice/overall-opt/round5-verified.json`, `.practice/overall-opt/round7b-verified.json`; gap: prior probes ran unboosted due to login clamping (`E/engine/entity/PlayerLoading.ts:99`) and `Route R6` Strength row uses pre-quest gear check (`death_climbingboots` requires Death Plateau).
- **Zero-foreground Fletching, Login-Wine Cooking, `8.00 t/pack` Runecraft, `33.00 t/pack` Smithing:** `5/t` arrow fletching fits inside `159t` open-road travel (`0 fg`), Login-Wine ferments `22t` offline (`4/8t fg`), Nature Altar `tickTransfer` achieves the exact `8.00 t/pack` engine floor (`C/skill_runecraft/scripts/runecraft.rs2:99` `p_delay(3)` + `4t` burst trade, winning by `51t` over adding Law Altar), and Varrock West Adamant Platebody smithing runs at `33.00 t/pack` (`1,183.71 XP/t`, `C/skill_smithing/scripts/smithing/smithing.rs2:272,286`); evidence: `research/overall-lockstep-summary.json`, `.practice/overall-opt/round2-final.json`, `.practice/overall-opt/round6-verified.json`; gap: live multi-carrier synchronization.

## 3. Route R6-Max schedule (realistic)

| # | Step | Travel Leg | Tr | Fg | Relogs | Window | Evidence |
|---:|---|---|---:|---:|---:|---|---|
| 1 | `tutorial` | `lumbridge-spawn -> lumbridge-spawn (same)` | 0 | 10 | 0 | `0..10` | `MEASURED` |
| 2 | `runecraft-air` | `lumbridge-spawn -> air-ruins (path)` | 142 | 56 | 0 | `152..208` | `MEASURED` |
| 3 | `trade-start` | `air-ruins -> air-ruins (same)` | 0 | 12 | 0 | `208..220` | `MEASURED` |
| 4 | `fletch` | `air-ruins -> air-ruins (same)` | 0 | 0 | 0 | `220..220` | `MEASURED` |
| 5 | `runecraft-nature` | `air-ruins -> nature-ruins (teleport:glory-karamja)` | 164 | 1,292 | 0 | `384..1,676` | `MEASURED` |
| 6 | `woodcut-prayer` | `nature-ruins -> draynor-willows (teleport:glory-draynor)` | 23 | 3,329 | 0 | `1,699..5,028` | `MEASURED` |
| 7 | `druid` | `draynor-willows -> kaqemeex (teleport:glory-edgeville)` | 141 | 177 | 0 | `5,169..5,346` | `MEASURED` |
| 8 | `doric` | `kaqemeex -> doric (path)` | 30 | 18 | 0 | `5,376..5,394` | `MEASURED` |
| 9 | `smith-anvil` | `doric -> varrock-west-anvil (teleport:glory-edgeville)` | 91 | 992 | 0 | `5,485..6,477` | `MEASURED` |
| 10 | `herb-tail` | `varrock-west-anvil -> bank:varrock-west-bank:0 (path)` | 11 | 93 | 0 | `6,488..6,581` | `MEASURED` |
| 11 | `mine` | `bank:varrock-west-bank:0 -> ardougne-zoo (teleport:dueling-castle-wars)` | 152 | 3,507 | 0 | `6,733..10,240` | `MEASURED` |
| 12 | `rival-fight-arena` | `ardougne-zoo -> lady-servil (path)` | 26 | 526 | 0 | `10,266..10,792` | `MEASURED` |
| 13 | `thieve` | `lady-servil -> ardougne-spice-stall (estimate)` | 62 | 1,041 | 462 | `10,854..11,895` | `MEASURED` |
| 14 | `rival-seaslug` | `ardougne-market -> caroline (path)` | 30 | 348 | 0 | `11,925..12,273` | `MEASURED` |
| 15 | `fish-pre-boat` | `caroline -> caroline (same)` | 0 | 144 | 0 | `12,273..12,417` | `MEASURED` |
| 16 | `trawler-4in1` | `caroline -> trawler-pier (estimate)` | 82 | 1,076 | 0 | `12,499..13,575` | `MEASURED` |
| 17 | `relog-wine` | `trawler-pier -> trawler-pier (same)` | 0 | 8 | 1 | `13,575..13,583` | `MEASURED` |
| 18 | `agility-brimhaven` | `trawler-pier -> brimhaven-arena (teleport:glory-karamja)` | 73 | 3,476 | 613 | `13,656..17,132` | `MDP-CALIBRATED` |
| 19 | `imp-catcher` | `brimhaven-arena -> wizard-tower (teleport:glory-draynor)` | 51 | 9 | 0 | `17,183..17,192` | `MEASURED` |
| 20 | `magic-44-50` | `wizard-tower -> bank:draynor-bank:0 (teleport:glory-draynor)` | 15 | 26 | 0 | `17,207..17,233` | `SCALED` |
| 21 | `relog-str` | `bank:draynor-bank:0 -> multiway-relog` | 174 | 925 | 835 | `17,407..18,332` | `MEASURED` |
| 22 | `relog-atk` | `multiway-relog -> multiway-relog (same)` | 0 | 475 | 475 | `18,332..18,807` | `MEASURED` |
| 23 | `relog-def` | `multiway-relog -> multiway-relog (same)` | 0 | 671 | 671 | `18,807..19,478` | `MEASURED` |
| 24 | `relog-rng` | `multiway-relog -> multiway-relog (same)` | 0 | 1,285 | 1,168 | `19,478..20,763` | `MEASURED` |
| 25 | `relog-magic-curses` | `multiway-relog -> multiway-relog (same)` | 0 | 547 | 487 | `20,763..21,310` | `MEASURED` |

## 4. Relog latency sensitivity

Each `+1t` added to relog latency shifts total route cost across all `4,712` (`R6-Max`) / `4,192` (`R6-Practical`) relogs (`research/overall-lockstep-summary.json`):

| Extra / Relog | `R6-Max` Real | `R6-Practical` Real | `R6-Max` + Knights | Margin vs Live `29,972t` (`R6-Max`) |
|---|---:|---:|---:|---:|
| `+0.0t` | `21,310` (`4,712` relogs) | `23,020` (`4,192` relogs) | `22,063` (`4,340` relogs) | `+8,662t` |
| `+0.5t` | `23,666` (`4,712` relogs) | `25,116` (`4,192` relogs) | `24,233` (`4,340` relogs) | `+6,306t` |
| `+1.0t` | `26,022` (`4,712` relogs) | `27,212` (`4,192` relogs) | `26,403` (`4,340` relogs) | `+3,950t` |
| `+2.0t` | `30,734` (`4,712` relogs) | `31,404` (`4,192` relogs) | `30,743` (`4,340` relogs) | `-762t` |

## 5. Per-skill rev-289 engine lower bounds

| Skill | Standalone Floor (t) | Limiting Engine / Script Constraint |
|---|---:|---|
| Attack | `475` | Atk 83 (`Fight Arena`) + `1.00t/swing` BiS R2H @ `1,462.48 XP/t`; `E/engine/World.ts:1008` 1-tick relog minimum |
| Strength | `890` | `C/skill_combat/scripts/pvp/pvp_combat.rs2:148` (`1.125x` CB>=100 cap) + `E/engine/World.ts:1008` 1-tick relog |
| Defence | `671` | `r2h_bis_99_def` `1,489.48 XP/t` @ `1.00t/swing` |
| Hitpoints | `0` | Passive `1.33x/4` side-XP during Atk/Str/Def/Rng (`1,222,191 > 998,458`) |
| Ranged | `1,096` | `C/skill_combat/scripts/pvp/pvp_ranged.rs2` + 1t relog BiS MLB (`879 -> 1,046 XP/t`) |
| Magic | `540` | 1t Stun (`1,968.75 XP/t` = `31,500 XP` / `16t`) vs Mage Arena + Charge (`5/t` cap, `E/network/game/client/ClientGameProtCategory.ts:6`) |
| Prayer | `0` | Absorbed in Draynor 3t WC + bone-givers (`3,223/3,329t`; `bury_bone.rs2` `p_delay(0)`) |
| Firemaking | `0` | Absorbed inside `1,047t` Trawler Boat (`642/667t` @ `4t/log` `firemaking.rs2`) |
| Crafting | `0` | Absorbed inside `1,047t` Trawler Boat (`5/t` `USER_EVENT` cap, `ClientGameProtCategory.ts:6`) |
| Herblore | `71` | `druid` (`177t`) + `153-175t` inside Trawler Boat + `71-93t` post-boat tail |
| Cooking | `4` | `login-wine` (`22t` offline fermentation) + `4-8t` prep/relog |
| Fletching | `0` | `5/t` arrows absorbed inside `159t` open-road travel |
| Smithing | `991` | `C/skill_smithing/scripts/smithing/smithing.rs2:272,286` (`p_delay(1)+p_delay(2)` = `25t/5` plates + `7-8t` burst trade) |
| Runecraft | `1,292` | `C/skill_runecraft/scripts/runecraft.rs2:99` `p_delay(3)` (`4t` lock at `E/engine/World.ts:888`) + `4t` `tickTransfer` = `8.00 t/pack` |
| Mining | `3,500` | `C/skill_mining/scripts/mining.rs2:77,202` `%action_delay` + Zoo 3t `276.0 XP/t` ceiling (`20t` iron respawn) |
| Woodcutting | `3,223` | `C/skill_woodcutting/scripts/woodcut.rs2:59,175` `%action_delay+3`; Draynor 3t + bones covers WC + Prayer |
| Thieving | `894` | `C/skill_thieving/scripts/thieving.rs2:70` `p_delay(0)` + `E/engine/World.ts:1008` = `2t/steal` (Spice Stall `1,012.5 XP/t`) |
| Agility | `3,476` | `C/minigames/game_agilityarena/scripts/agilityarena_clerk.rs2:85` `98t` global switch + `2t` abort + `m43_149.jm2` MDP |
| Fishing | `1,563` | `trawler_control.rs2` `1,076t` boat + Sea Slug (`344t`) + `74->78` 3t fly (`143t`) |

## 6. Bounded, gated, and non-viable mechanisms

- **Relog cannot skip active `p_delay`:** `E/engine/World.ts:1004-1017` (`canRemoveNow`) returns `false` when `player.delayed || !player.canAccess() || player.engineQueue.head() !== null`; `p_delay(3)` in Runecraft, `p_delay(1)+p_delay(2)` in Smithing, and `p_delay(0)` in `bury_bone.rs2` hold logout until expiry (`8.00 t/pack` RC confirmed across `craftAt = 5, 13, 21, 29`).
- **Trawler boat logout ejects to shore:** `C/login_logout/login.rs2:64` calls `~trawler_login` (`C/minigames/game_trawler/scripts/trawler.rs2:52-55`), executing `p_teleport(^trawler_escape)` when logging in inside `trawler_game_zones` or `trawler_wreck_zones`.
- **No Wilderness Willows; no Multiway Iron:** Map scan of `vendor/rs-sdk/server/content/maps/*.jm2` against `multiway.csv` shows `0` Willows in Wilderness (`z >= 3525`) and `0` iron rocks in any multiway zone on any plane. Moss Giant Willows (`2671, 3226`) fail `2t` NPC flinch because Moss Giants leash (`feasible: false`).
- **Wilderness 8-Iron 2t under single-way Hobgoblins is slower than Zoo 3t:** Hobgoblin Mine single-way NPCs force interruption and `20t` rock depletion walks yield `140.43 XP/t` (Lv 85) and `172.84 XP/t` (Lv 49) in `.practice/overall-opt/round5-verified.json`, below Zoo 3t (`276.0/275.5 XP/t`).
- **Zero-quest equipment gates verified in `C/`:**
  - `death_climbingboots` (`3105`) requires `%death_equiproom >= ^death_complete` (`C/quests/quest_death/scripts/quest_death.rs2:120-125`).
  - `dragon_halberd` requires Regicide (`C/levelrequire/scripts/tier60.rs2:10`).
  - Green `dragonhide_body` requires Dragon Slayer, whereas `blue_dragonhide_body` (`C/levelrequire/scripts/tier50.rs2:9`) and `black_dragonhide_body` (`C/levelrequire/scripts/tier70.rs2:6`) require only Ranged (`50/70`) and Defence (`40`) with no quest gate.
  - `law_talisman` has `tradeable=no` (`C/skill_runecraft/configs/runecraft.obj:173`).
  - `stealing_gem_stall` awards `160` base tenths = `16` XP raw (`C/skill_thieving/configs/stalls/stealing.dbrow:106`).
  - `watchshortcut` (`loc 2298` at `(2561, 3108)`, `C/skill_agility/scripts/shortcuts.rs2:16-24`) jumps one-way north over the 72-tile Yanille wall (`m40_48.jm2`).

## 7. Code-read leads pending lockstep proof (UNVERIFIED)

Raw harness ready at `.practice/overall-opt/probe-round8-bottlenecks.ts`; none of the items below are included in `Route R6-Max` totals:

1. **Same-tick login-potion 1t combat (`CODE-READ`):** `E/engine/entity/PlayerLoading.ts:99` clamps boosted levels on login (`Math.min(sav.g1(), player.baseLevels[i])`), so pre-logout potions do not persist. `E/engine/World.ts:802` runs `decodeIn()` (`OpHeldHandler.ts:68`, potion `consume.rs2:97-108` has `eat_delay=null, skill_delay=null`) before `processInteraction()` (`World.ts:913`), allowing potion + prayer/spec + attack + logout within `USER_EVENT.limit = 5` (`ClientGameProtCategory.ts:6`) — including zero-quest Melee (`rune_2h_sword` + `amulet_of_strength`) and Lv 76–77 Stun (`4dose1magic` `3040` / WMB `1907`).
2. **Trawler 5-in-1 + Gold Superheat (`CODE-READ`):** Combined zero-extra-tick FM (`(3211, 3306)`) + Craft + Herb leaves `~404t` on boat for either `202` Dragon Bones or Superheat (`C/skill_magic/scripts/spells/superheat.rs2:67`), plus potential 3t Zoo Iron + Dragon Bone hybrid (`Tick A`: `knife+log+Make1 + Bury` -> `A+2`: `Mine`) freeing Woodcutting from Prayer.
3. **2-tick Multiway Necromancer Willows (`CODE-READ`):** `m41_50.jm2` and `multiway.csv` contain 3 adjacent multiway Willows (`1308`) at `(2670, 3227)`, `(2672, 3226)`, and `(2674, 3228)` near `necromancer` (`2671, 3240`), which spawns unlimited melee `summonedzombie`s (`C/areas/area_ardougne_east/scripts/necromancer_tower.rs2:54-66`). With arrowless Shortbow Rapid and auto-retaliate ON, `playerhit_n_retaliate` (`C/skill_combat/scripts/player/auto_retaliate.rs2:1-26`) sets `%action_delay = map_clock + 1` while `player_ranged_check_ammo` (`C/skill_combat/scripts/player/player_ranged.rs2:76-86`) aborts without killing the zombies.
4. **Brimhaven remaining obstacle measurements (`CODE-READ`):** `agilityarena.rs2:86-502` and `agilityarena_clerk.rs2:88-105` indicate shorter cycles on off-cycle `timedblade` runs (`map_clock % 7 = 0`), `agilityarena_ropeswing`, and `agilityarena_plank` than the `12-16t` placeholder edges in the MDP.
5. **Varrock West 4t-trade Smithing & early stalls (`CODE-READ`):** Dropping 3 finished plates before burst-trade to hit `~29 t/pack`, plus boxed early Ardougne stalls (`m41_51.jm2`: Cake `2657,3311`, Silk `2656,3304`, Fur `2662,3296`, Silver `2657,3313`) to test skipping Fight Arena.
