# Pro playbook for this server (2026-10-23)

Server: rs-sdk demo (LostCity rev 289, about October 2004, members, XP 25x, unlimited run, 400 ms ticks). Boards
rank by logged-in ticks to reach a level. Sources: web research on OSRS speedrun and efficiency play (wiki, EHP
tables), checked against this server's code (`vendor/rs-sdk/server`), plus our own measurements. Companion files:
`research/tricks-plan.md` (every trick and its status), `research/quest-xp.md` (quest XP at 25x).

## How pros plan, and what that means here

1. **Quests first.** Efficient players use quest XP to skip slow low levels and choose the order by unlocks and
   travel ([OSRS optimal quest guide](https://oldschool.runescape.wiki/w/Optimal_quest_guide)). Here quest XP is
   multiplied by 25 (`Player.addXp`), so quests are worth far more: all quests reach **99 Attack, 99 Strength,
   99 Defence, 93 Agility, 88 Mining, 88 Magic, 86 Herblore, 86 Crafting, 85 Hitpoints** (`research/quest-xp.md`).
2. **Tick manipulation for gathering.** Knife on a log + "Make 1" + a click on the resource in one tick sets a
   2-tick delay without using the log. **Proven: woodcutting +29%.** Same code path for fishing (5-6 -> 3 ticks)
   and mining below a rune pickaxe. Herb tar did not exist in 2004; knife-on-log does the same job.
3. **Zero-delay production.** Herblore, bow stringing, arrows and darts (15 per action), gem cutting have no
   delay here; up to 5 actions run per tick. Supply, not time, limits them.
4. **Exact inputs on exact ticks.** The SDK runs actions one at a time (`packages/core/src/inprocess.ts` pump);
   `s.direct` sends several in one tick. Loc clicks run in the arrival tick only if the bot took no steps
   (`Player.ts:1348`), so stand still before clicking.
5. **Travel.** Run always (infinite). Teleports by October 2004: Varrock 25, Lumbridge 31, Falador 37, Camelot 45,
   Ardougne 51 (Plague City), Watchtower 58; amulet of glory (Edgeville, Karamja, Draynor, Al Kharid); ring of
   dueling; spirit trees (Tree Gnome Village); gnome gliders (The Grand Tree); Karamja and Brimhaven boats. Not yet
   in the game: charter ships, fairy rings, carpets, canoes, games necklace, home teleport.
6. **Danger.** NPCs hunt players whose combat level is at most 2x theirs outside the Wilderness (`Npc.ts:1011`);
   they stop after about 1,000 ticks in one area (`Player.ts:2189-2217`). Melee NPCs path naively, so safespots work.
   Never walk White Wolf Mountain at low level. Check routes with `research/route-danger.ts`.
7. **Watch the leaders.** The live world feed (`wss://rs-sdk-demo.fly.dev/worldfeed`) shows every player tick by
   tick. Seen 2026-10-23: Jackalopett1 (Thieving #8) pickpockets knights about every 2 ticks at 10 HP and eats
   after a stun; Jackalopeth2 (Thieving #3) loops the level-61 Ardougne castle lock doors (loc_2555, upstairs at
   2572,3288 and 2572,3305) and the castle chests (12,500 XP each).

## Board plans (leader ticks from the 2026-10-22 snapshot)

| Board | Leader | Plan | Status |
|---|---|---|---|
| Thieving | 2,935 | Knights at a 2-tick rhythm, full-pack food, eat in stuns; study the castle door + chest loop | We hold #9 (41m 12s); 3 accounts at 99 |
| Woodcutting | 3,329 | 3-tick + rune axe from 41 (model 2,922; steel + adamant 3,286) | Trick proven; needs a rune axe and a fresh account |
| Fishing | 3,425 | 3-tick fly fishing (rod, feathers, knife, log) | Fishing test script broken; fix and measure |
| Attack / Strength / Defence | 4,728 / 4,966 / 7,974 | Quest route: Waterfall, Tree Gnome Village, Grand Tree, Fight Arena, Dragon Slayer, Holy Grail, Haunted Mine | Need quest requirement map and timings |
| Agility | 6,772 | Regicide + Grand Tree + Underground Pass quest XP, then Brimhaven arena / Wilderness course | Plan |
| Mining | 3,964 | The Dig Site (382,500) + 3-tick iron with an adamant pickaxe at 3-rock spots | Plan |
| Magic | 1,513 | Watchtower (382,500) + Grand Tree; then alching or teleports | Plan |
| Herblore, Crafting, Fletching | 447 / 197 / 58 | Quest XP + zero-delay production at 5 per tick | Supply limited; check the market |
| Smithing | 1,337 | The Knight's Sword (318,125) + platebodies | Plan |
| Prayer, Ranged, Hitpoints | 1,281 / 5,595 / 17,058 | Holy Grail; Temple of Ikov + cannon; quests + combat | Plan |
| Runecraft | 2,354 | Highest altar + helper trades | Needs money and helpers |
| Cooking | 38 | Only the login wine route is that fast | Owner decision pending |

## Rules for our code from now on
- Look up how pros do a task (web), find the code that governs it, then measure with at least 3 runs.
- Send same-tick inputs with `s.direct`; never rely on the SDK queue for timing.
- Every script prints its time counters (pickTicks, shopTicks, walkTicks, idle, waits) so the slowest part shows.
- Run specialists on different boards at the same time; one account per board.
