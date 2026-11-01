# RuneLite parity for the fleet dashboard

The dashboard (`packages/dashboard`) copies the RuneLite client's look and plugins. Our world is not RuneLite's world. RuneLite serves Old School RuneScape. We watch a fleet of bots on a LostCity 2004scape server (rs-sdk, cache rev 289). This topic records, for each part of the dashboard, the RuneLite source it follows and one of three decisions:

- **copy:** the feature works the same here.
- **adapt:** RuneLite's idea fits, but our data or our world differ.
- **reject:** the feature needs data or game content that this world does not have.

`packages/dashboard/parity.test.ts` fails when a sidebar plugin, a game tab or a HUD part has no row here.

## Method

Use this for every new or changed part.

1. **Find the RuneLite source.** List RuneLite's plugins and settings at the pinned commit:
   `bun packages/dashboard/tools/runelite-features.ts <plugin dir>`. For example, `xptracker hiscore`. Pinned commit: `runelite/runelite@7715a1d26e6cbbfdce7ad266a39c8c3c611211a0` (`RUNELITE_SHA` in the tool). Change the pin only on purpose, and check every row again.
2. **List RuneLite's features.** Use the setting names and the panel labels from step 1.
3. **Check each feature against our world** (the facts below). Ask: is the data in `/api/state`, in a status file, in a fleet-data snapshot, or in the world feed?
4. **Decide copy, adapt or reject** for each feature, with one reason.
5. **Record it** in the table here: the part's id in the first column, the RuneLite source, the decision, and the open gap. Check the license before you copy code (RuneLite is BSD-2-Clause, see `packages/dashboard/RUNELITE-LICENSE.txt`). The sidebar icons are RuneLite's own, listed in `packages/dashboard/client-assets/ATTRIBUTION.txt`.
6. **Run** `bun test ./packages/dashboard/parity.test.ts`.

## Our world (facts the decisions use)

| Fact | Evidence | RuneLite difference |
|---|---|---|
| 19 skills: Attack to Runecraft, with no Slayer, Farming, Construction, Hunter or Sailing. The status files also carry two unused slots, `Stat18` and `Stat19`. | `/api/state` bot `skills`; `SKILL_BOARDS` in `packages/dashboard/server.ts` | RuneLite has 24 skills (with Sailing). Skill lists must filter to reported skills (`reported()` in `client-shell.js`). |
| Hiscores: Overall, 19 skills, Quest Points, plus the demo's Equipment, Bank and Runite boards. Each row has rank, level and time. | `SKILL_BOARDS`, `EXTRA` in `server.ts`; `research/boards-special.md` | No bosses, minigames, clue scrolls or ironman endpoints. Our boards rank by time to level, not only by XP. |
| One game world. The fleet runs on three machines (sides: local, cloud, claude-cloud). | `fleet/owners.json`; fleet-data snapshots | RuneLite's world hopper has nothing to hop. Sides are not worlds. |
| A market API with ask, bid, stock and average for each item. There is no Grand Exchange interface or offer slots in our state. | `economy.supplies` in `/api/state` | RuneLite's GE plugin reads offer slots and wiki prices. |
| A world feed: every player's name, position, plane and combat level, and in 3D each player's animations and chat. | `wss://rs-sdk-demo.fly.dev/worldfeed`; `roster` in `server.ts` | RuneLite reads the local client. We see all players, but no client state (no run energy, special attack, active prayers or boosts). |
| Our bots' status files: skills with XP, HP, inventory, worn items, bank, quests, phase and results. Other sides share levels without XP. | `.practice/status/<name>.json`; `remoteBots` in `fleet-view.ts` | RuneLite sees one player live. We see many players, each from its last snapshot. |
| Spellbook and prayers of 2004: the standard spellbook and the 2004 prayer list. | `client-shell.js` (tabs removed: no active state is reported) | No Ancient, Lunar or Arceuus books, and no Piety, Rigour or Augury. |

## Parts

### Sidebar plugins

| Part | RuneLite source | Decision | What we use, and why | Open gap |
|---|---|---|---|---|
| `fleet` | `friendlist`, `party` | adapt | Every account on every side, with filters (working, attention, held, side), side sync age and cross-side orders. RuneLite has no fleet. Party is the nearest idea: shared status of a group. | none |
| `xp` | `xptracker` | adapt | XP gained, XP/hr, progress to level, time to level, reset, pause, hide maxed skills, saved between sessions (browser storage). XP comes from status snapshots, not per drop. | Reject "actions done/left/hr", because no per-action XP is reported. |
| `boards` | `hiscore` | adapt | Account view: RuneLite's layout (skill grid, overall, rank on hover) for fleet accounts. Fleet view: our scoreboard and the best fleet rank on each of the 24 boards. Rivals view: each board's top 10 from the demo hiscores, with our accounts marked and who is online now and where, and the Overtake planner: the XP and hours our best account needs to pass the next rows (or, at 99, the time a new account must beat, because board time stops at 99). RuneLite has no fleet or rivals view. | Reject the endpoint selector and the bounty lookup: there are no such boards here. |
| `ge` | `grandexchange` | adapt | Route supplies with the market's buy, sell and stock, and "We hold" from the fleet's banks. Our market has no offer slots. | Show our bots' open market offers once a status file reports them. Reject GE limits and the limit timer: no data. |
| `world` | `hiscore` (player lookup), `opponentinfo`, `playerindicators` | adapt | Look up any player: hiscore levels and ranks, combat level, online state and place from the world feed, a button to show them on the map; right-click any dot on the map to look that player up. Our spots: other players within 10 tiles of each tile our bots claim (fleet-data `claims`). Bot farms: three or more online players with one name pattern (a numbered series, or random names with the same first two characters and length), and how many stand at our spots. Online count. The local server reads the hiscores; the hosted page has the lookups the server keeps (the top 3 of each board and the players at our spots), because the demo hiscores send no CORS header. | Worn items of any player from the world feed's appearance block (needs a detail subscription and an appearance decoder). Named claims (`shop:aubury`) have no tile, so they have no count. |
| `stock` | `bank` (bank value), `loottracker` | adapt | Every bank or one bank, and the Transfers view (flow between fleet accounts). The value of the items shown and of each row, at the server's item value (the vault's: 7-day market average after 3 trades, else the shop price). RuneLite's loot tracker counts NPC drops; we have no drop events. | none |
| `account` | `account`, `info` | adapt | One account: status, HP, combat, total, bank coins, assignment, why it stopped, commands, linked jobs. | none |
| `activity` | `chathistory`, `loottracker` (history list) | adapt | Finished and stopped game runs, live or practice, as readable lines with repeats folded. | none |
| `operations` | none | own | The Command centre: one clickable number per fleet question. RuneLite has no fleet. | none |
| `jobs` | none | own | The coordinator queue. | none |
| `dispatch` | none | own | The Jobs desk: job form and script list. | none |
| `goals` | none | own | The plan's lanes, with blockers and next actions. | none |
| `prs` | none | own | Pull requests by agent. | none |
| `machine` | none | own | Bots running against the cap, RAM headroom, CPU and processes. | none |
| `manager` | `config` | copy | The plugin list with switches and search, notifications and sidebar width. | none |
| `raw` | `devtools` | adapt | The selected account's observed record as JSON. It is in the ⋮ menu, not the rail. | none |

### Game tabs

| Part | RuneLite source | Decision | What we use, and why | Open gap |
|---|---|---|---|---|
| `skills` | game Skills tab, `virtuallevels`, `combatlevel` | adapt | Reported skills only, with level and XP tooltips (XP, next level, remaining). Cloud accounts show levels only. The combat level line gives the levels each style needs for the next combat level; the 2004 formula matches the world feed's combat levels. | Reject virtual levels above 99: the boards stop at 99. |
| `quests` | `questlist` | adapt | The account's quest states, colour-coded, with a detail view, the snapshot age, a filter (done, started, to do) and search. | none |
| `inventory` | game Inventory tab, `itemprices` | adapt | The 28 slots from the snapshot, with item options. Hover shows the server's item value (the vault's: 7-day market average after 3 trades, else the shop price), and the market's buy and sell for route supplies. | Reject the high alchemy value: no alchemy data is checked for this world. |
| `equipment` | game Worn Equipment tab | adapt | The doll by slot. Cloud snapshots have no slot numbers, so those show as a list. | none |
| `friends` | `friendlist` | adapt | The fleet as a friends list: online accounts show their side (RuneLite shows the world). Click to follow. | none |
| `settings` | game Settings tab, `stretchedmode` | adapt | Display mode, render quality, chat and places buttons. | none |
| `logout` | game Logout tab | adapt | Signs the owner out of the hosted page. It never logs a bot out. | none |

### HUD and game view

| Part | RuneLite source | Decision | What we use, and why | Open gap |
|---|---|---|---|---|
| `orbs` | status orbs, `regenmeter` | adapt | HP and Prayer orbs from the snapshot. | Reject run energy and special attack orbs: not reported. Reject the regen meter: no regen timer. |
| `xp-drops` | `xpdrop` | copy | Skill icon and XP gained, rising under the XP button. | Reject prayer-coloured drops: no active prayer state. |
| `xp-globes` | `xpglobes` | copy | A progress ring per recently trained skill, with XP left and the goal skill's XP/hr in the tooltip. | none |
| `minimap` | `minimap` | adapt | One minimap for 2D and 3D: map art around the followed account (in 3D free camera, around the 3D camera). Fleet bots are green dots (bright when playing), other players from the world feed are white. In 3D it turns with the camera's yaw like RuneLite's, and the compass turns the camera north; in 2D it faces north and a click moves the camera there. The rs-world viewer's own minimap is hidden. | none |
| `places` | `worldmap` (destinations) | adapt | A place list (Go, Locate) for the camera; in 3D it also opens the viewer's world map of every player. | Reject fairy rings, teleports and the other OSRS map layers. |
| `overlay` | overlay panels (`xptracker` on-screen box) | adapt | The followed account's status, goal, phase, XP/hr and session; in free camera, fleet totals. | none |
| `infoboxes` | `timersandbuffs`, infobox manager | adapt | One box per playing bot (trained skill, session), or the followed account's session and goal time. | Reject buff timers: no buff state. |
| `chat` | game chat, `timestamp`, `chatcommands`, `chatnotifications` | adapt | Fleet events and results as game messages, timestamps, level-up and death messages, and `::` commands that control the fleet (not RuneLite's lookups). | none |
| `idle` | `idlenotifier` | adapt | "is now idle" after 3 idle snapshots of the followed account, and a low-hitpoints message at a quarter of the maximum. | Reject energy, oxygen and special attack thresholds. |
| `notify` | RuneLite notifier | copy | Desktop notifications for level-ups, deaths and idling, behind a Configuration switch. | none |
| `bank-window` | game bank, `bank` | adapt | The bank of the followed account in the game's bank frame, with the bank value (the server's item value (the vault's: 7-day market average after 3 trades, else the shop price)) and item values on hover. | none |
| `context-menu` | `menuentryswapper`, `examine` | adapt | Item options (Use, Wield/Wear/Eat/Drink, Drop, Examine) and map-dot options (Follow, Account, XP Tracker, Pause, Examine). They act on the dashboard, not the game. | none |
| `name-tags` | `playerindicators`, `tileindicators` | adapt | Name tags for fleet bots and a tile under the followed account on the 2D map. Other players on the ground floor are small grey dots; right-click one to look it up. | none |
| `3d` | none (the rs-world viewer) | own | The pinned rs-world viewer with the live world feed; the main account renamed "Hidden". | none |
| `screens` | `loginscreen` | adapt | The game's loading and connection-lost screens, driven by the state stream. | none |

## Not used

| RuneLite plugin | Reason |
|---|---|
| `worldhopper` | One world. Fleet sides are shown in Fleet. |
| `music` | No region or audio data in the state. |
| `statusbars` | A copy of the HP and Prayer orbs. |
| `prayer`, `spellbook`, `attackstyles` | No active prayer, spell or combat style is reported. |
| `loottracker` (NPC drops) | No drop events. Fleet transfers are in Supply ledger. |
| `boosts`, `timersandbuffs` (buffs), `poison`, `specialcounter` | No boost, buff, poison or special attack state. |
| Boss, raid and minigame plugins (`barrows`, `raids`, `corp`, `zalcano`, `wintertodt`, `tithefarm` and others) | That content is not in a 2004 world. |
| `slayer`, `herbiboars`, `hunter`, `poh` | Skills or content not in a 2004 world. |
| `screenshot`, `discord`, `twitch`, `gpu` settings | Client features; the page is a viewer, not the game client. |
