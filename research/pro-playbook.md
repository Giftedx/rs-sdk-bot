> Current authority: all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. Where a restriction or model total below conflicts with this, this applies. See [AGENTS.md](../AGENTS.md).

# Pro playbook for this server

Scope: historical rs-sdk observations and source assumptions (rev 289, XP 25x, 400 ms ticks). Live configuration needs verification. Skill boards
rank by logged-in ticks to reach a level. Sources: web research on OSRS speedrun and efficiency play (wiki, EHP
tables), checked against this server's code (`vendor/rs-sdk/server`), plus our own measurements. Companion files:
`research/tricks-plan.md` (every trick and its status), `research/quest-xp.md` (quest XP at 25x).

## How pros plan, and what that means here

### Current allocation review

[Saved-state audit](../.practice/fleet-review/audit.json): 22 non-main live credential folders, 21 observed logins, five active earners against a 17-account cap; about 15 GiB free before practice. Counts exclude `_template`. These are observations, not exhaustive live skill/bank refreshes. No account is missing from the config. Eighteen template rows differ from current decisions: `swarm.json` wins; `fleet.ts apply` now refuses to overwrite an existing plan (exclusive creation); templates still need review before reuse.

Seven of 19 supported skills have an observed helper 99: Thieving, Crafting, Fletching, Mining, Fishing, Cooking and Woodcutting. A 99 is completion of a level target, not a board win. No observed 99 in combat, Prayer, Magic, Ranged, Runecraft, Agility, Herblore, Smithing or Firemaking. Missing/stale observations are not verified level 1.

| Allocation | Next useful work | What must pass |
|---|---|---|
| OreElse → Smithing | Convert existing copper/tin; then bars → useful gear | [Live eight-bar proof](../.practice/fleet-review/smith-live-proof.json): two batches level1→17,16 bars, exact assets; next qualify iron/gear |
| Bigchopper → Heroes partner | Quest unlocks instead of more oak | Current flags and saved-state quest entry; resolve Arrav timing |
| Ballspinner / Shaftmaker | Jewelry, bows and ammo from stock | Item-level demand and production/transfer receipts |
| Shaftsinker | Feed Runecraft specialist | Altar/quest access, owned handoff, whole-clock route |
| Shaftshooter / Polevaulter | Fresh Ranged / Agility attempts | Local credentials only; first-login route and supplies unproved |
| Mightyrod | Combat, bones, drops → Prayer/Herblore | Gear/delivery and survival first; preserve zero-kill block |
| Swordinhand | Defence20 reached; alternate Arrav donor candidate | Two live cow batches preserved assets; [latest receipt](../.practice/combat-expansion/next/live-proof.json). Qualify Black Arm entry with Bigchopper |
| Five thieves + courier/cooks | Fund named gear, quest and supply budgets | Reconcile lots; unknown opening food costs remain unknown |

Critical conflicts: main stays gated, but the proposed partner waits for its Arrav certificate from main. Prove an owned alternate donor or a staged early-main handoff; do not require an impossible fully finished partner before main starts. Equipment's local score ceiling ties leaders; strict first is unresolved. Main's current model misses the timed target by 8,950 ticks; specialist wins do not close this gap. GE is authorized again: refresh old purchase/sale proposals under the [market policy](supply-logistics.md#market-policy-current). Competition needs live evidence even after practice passes.

Expansion order: convert existing stock → unlock partner/gear → qualify uncovered skills → claim prepared fresh specialists → scale proved bottlenecks. Keep qualification moving across lanes; do not add another thief while uncovered lanes have a better proved use of capacity. Account creation, reserved names and source-only scripts do not count as wins.

These are candidates, not a fixed route order. Compare quest time, travel and unlock value against every affected shared-clock deadline. Unlimited run is a source-default assumption, not verified live configuration. Numeric rates below apply only to their original test conditions.

1. **Compare quest routes.** Efficient players use quest XP to skip slow low levels and choose the order by unlocks and
   travel ([OSRS optimal quest guide](https://oldschool.runescape.wiki/w/Optimal_quest_guide)). Here quest XP is
   multiplied by 25 in the recorded configuration. [Quest XP](quest-xp.md) contains extracted totals, not a proved route or complete reward model.
2. **Tick manipulation for gathering.** Knife on a log + "Make 1" + a click on the resource in one tick sets a
   2-tick delay without using the log. **Proven: woodcutting +29%.** Same code path for fishing (5-6 -> 3 ticks)
   and mining below a rune pickaxe. Herb tar did not exist in 2004; knife-on-log does the same job.
3. **Zero-delay production.** Herblore, bow stringing, arrows and darts (15 per action), gem cutting have no
   delay here; up to 5 actions run per tick. Supply, not time, limits them.
4. **Exact inputs on exact ticks.** The SDK runs actions one at a time (`packages/core/src/inprocess.ts` pump);
   `s.direct` sends several in one tick. Loc clicks run in the arrival tick only if the bot took no steps
   (`Player.ts:1348`), so stand still before clicking.
5. **Travel.** Check run energy and server configuration. `Player.updateEnergy` bypasses depletion only with `NODE_INFINITE_RUN`. Historical teleport candidates: Varrock 25, Lumbridge 31, Falador 37, Camelot 45,
   Ardougne 51 (Plague City), Watchtower 58; amulet of glory (Edgeville, Karamja, Draynor, Al Kharid); ring of
   dueling; spirit trees (Tree Gnome Village); gnome gliders (The Grand Tree); Karamja and Brimhaven boats. Not yet
   in the game: charter ships, fairy rings, carpets, canoes, games necklace, home teleport.
6. **Danger.** NPCs hunt players whose combat level is at most 2x theirs outside the Wilderness (`Npc.ts:1011`);
   they stop after about 1,000 ticks in one area (`Player.ts:2189-2217`). Melee NPCs path naively, so safespots work.
   Never walk White Wolf Mountain at low level. Check routes with `research/route-danger.ts`.
7. **Watch the leaders.** The live world feed (`wss://rs-sdk-demo.fly.dev/worldfeed`) shows every player tick by
   tick. Observed on the feed: Jackalopett1 (Thieving #8) pickpockets knights about every 2 ticks at 10 HP and eats
   after a stun; Jackalopeth2 (Thieving #3) loops the level-61 Ardougne castle lock doors (loc_2555, upstairs at
   2572,3288 and 2572,3305) and the castle chests (12,500 XP each).

## Board plans (leader ticks from the hiscores snapshot)

| Board | Leader | Plan | Status |
|---|---|---|---|
| Thieving | 2,935 | Knights at a 2-tick rhythm, full-pack food, eat in stuns; study the castle door + chest loop | We hold #9 (41m 12s); 3 accounts at 99 |
| Woodcutting | 3,329 | 3-tick + rune axe from 41 (model 2,922; steel + adamant 3,286) | Trick proven; needs a rune axe and a fresh account |
| Fishing | 3,425 | 3-tick fly fishing (rod, feathers, knife, log) | Fishing test script broken; fix and measure |
| Attack / Strength / Defence | 4,728 / 4,966 / 7,974 | Quest route: Waterfall, Tree Gnome Village, Grand Tree, Fight Arena, Dragon Slayer, Holy Grail, Haunted Mine | Need quest requirement map and timings |
| Agility | 6,772 | Regicide + Grand Tree + Underground Pass quest XP, then Brimhaven arena / Wilderness course | Plan |
| Mining | 3,964 | The Dig Site (382,500) + 3-tick iron with an adamant pickaxe at 3-rock spots | Plan |
| Magic | 1,513 | Watchtower (382,500) + Grand Tree; then alching or teleports | Plan |
| Herblore, Crafting, Fletching | 447 / 197 / 58 | Quest XP + zero-delay production at 5 per tick | Supply limited. Use owned stock or permitted NPC shops. |
| Smithing | 1,337 | The Knight's Sword (318,125) + platebodies | Plan |
| Prayer, Ranged, Hitpoints | 1,281 / 5,595 / 17,058 | Holy Grail; Temple of Ikov + cannon; quests + combat | Plan |
| Runecraft | 2,354 | Highest altar + helper trades | Needs money and helpers |
| Cooking | 38 | Historical target includes login wine, now authorized | Authorized. Compare all methods in [cooking-board](cooking-board.md). |

## Apply a candidate
- Follow the [script contract](../docs/script-contract.md). Use existing code before external ideas.
- Use `s.direct` only for a verified same-tick requirement. Confirm effects and cancellation through the existing session owner.
- Record useful output, costs and tick counters. Compare matched runs before claiming a rate gain.
- Allocate specialists under current ownership, admission and pause rules. One account can advance several compatible goals.
