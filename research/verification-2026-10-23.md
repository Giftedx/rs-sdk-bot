# Verification of finished work, 2026-10-23

Scope: six items that other agents reported as done. Each claim was checked against the code, the content
files (`vendor/rs-sdk/server`, rev 289) or the local result files. No live run, no practice run.
Evidence level of this file: CODE-READ, plus the local result files (`.practice/results.jsonl`,
`.practice/status/*.json`, `.practice/vault-log.jsonl`) for the measured claims.

Checks run in this session:

- `bunx tsc --noEmit -p .`: exit 0.
- `bun test packages`: `188 pass, 3 skip, 1 fail`. The fail is in the uncommitted
  `packages/core/test/randomevents.test.ts:114` (genie case). It is outside these six items.
- `bun test` from the root also runs the vendor tests (`951 pass, 56 fail, 32 errors`). Most fails are missing
  vendor packages (`Cannot find package 'fflate'`). Do not use the root run as a signal.

## WRONG findings, ranked by impact on the 24-board goal

| Rank | Finding | File:line | Fix |
|---|---|---|---|
| 1 | fishing30 uses the wrong XP model. `xpFor` is the OSRS curve `2^(l/7)`. This server uses `2^(l/10)` (`Player.ts:77-85`, `packages/planner/src/curve.ts`). The script also counts 50 XP per feather. At 25x a trout gives 1,250 XP and a salmon 1,750 (`fishing.struct` productexp 500/700 tenths; `Player.ts:1889`). Script `XPT(99)` = 13,034,431, server 998,458. Script `XPT(30)` = 13,363, server 7,345. Effects: `feathersWanted()` is always the 200 cap, and the refill test is true on every full pack. So the bot walks to Port Sarim and back (about 350 ticks) even when its feathers can finish the target | `scripts/generated/fishing30.ts:21-24`, `:247`, `:478` | Import `xpForLevel` from `packages/planner/src/curve.ts`. Use 1,250 XP per feather below level 30 and 1,750 from 30 (or measure the XP gained per feather used). Refill only when `feathers * xpPerCatch < need`. When the pack is full and the feathers are enough, drop the fish and do not walk |
| 2 | The live job runs a path that no proof ran. `swarm.json:5` enables Mightyrod with `TARGET=99 CAP=15000` and the note "proved 2/2 on practice". The proofs were resume runs to 40 with `trips=0 events=0` and one fresh run to 31 with `trips=1` (the first rod trip). These paths never ran in a game: the feather refill trip, rod rebuy, river troll, big fish, whirlpool, salmon, and a 15,000-tick run. ESTIMATE: about 21 fish per pack (7 slots kept) gives about 32 packs to 99. At one trip per pack that is about 11,000 trip ticks plus about 8,300 fishing ticks (3-tick rate 105-140 XP/tick, `research/tricks-plan.md:10`). The total is more than CAP 15,000, so the run ends at the tick cap and `supervise.ts` restarts it | `swarm.json:5`; `scripts/generated/fishing30.ts:478-489` | Fix rank 1 first. Then prove the refill path on practice: `fish_resume` with `TARGET=50` forces at least one refill trip. Prove it 3 times before the live job runs again. Set CAP from the measured ticks per pack |
| 3 | The banker's 6-second serving window also limits the whole donor trade. `serveTrades` gives the session `min(tradeTimeout, deadline - now)` (`vendor/rs-sdk/sdk/actions.ts:2509`). At the deadline the session fails with "Trade timed out on the offer screen" and declines (`:2603`). A donor whose request arrives late in the 6 s window gets less than 6 s for offer, accept and confirm. Then it is declined. The banker logs only successful trades, so the vault log shows 4/4 live donor trades and hides the failures | `scripts/banker.ts:76` | First wait for the request alone, for example `sdk.waitForTradeRequest({ timeout: 6000 })` with a name filter. Only when a request from one of our accounts arrives, call `serveTrades` with `timeout` of 60 s or more. Log failed sessions as WARN |
| 4 | A stale payout request blocks the banker forever. `payOut` deletes the request file only after a successful trade (`banker.ts:67`). `take-from-banker.ts` deletes it on its own failure (`:173`, `:176`), but not when the process is killed. A file that remains makes the banker withdraw, wait 120 s, and bank again on every pass. During that time donors cannot trade, and the stop file waits (it is checked only between passes, `:71`) | `scripts/banker.ts:50-72` | Delete a request file that is older than about 10 minutes, or that failed 2 times. Check the stop file inside the payout loop |
| 5 | fishing30's death detector reports false deaths. The rule is "a jump of more than 20 tiles in one tick". Practice results show `fail died in Lumbridge ... hpMin=10 died=true` 2 times on 2026-10-23 (05:54Z and 05:55Z, `.practice/results.jsonl` lines 32 and 36): HP never fell. `supervise.ts:23` treats `died=true` as final, so a false death ends the live job for good. Event teleports (maze and others) would also trip the rule. Not verified: whether the code that ran then had the same cause. The rule is the same in the commit | `scripts/generated/fishing30.ts:92-98`; `packages/practice/src/supervise.ts:23` | Count a death only when HP fell to 0, or when the bot jumps to the respawn tile (3222,3218) with HP at max after an HP drop. Log the jump as WARN in all other cases and continue |
| 6 | The dashboard compares pace with an old #1. Pace and the board gaps read `research/hiscores-2026-10-22.json` (taken 2026-10-22T06:17Z), not the live #1 (`server.ts:291`, `:541`, `:566`). The XP rate is the sum of all skills' XP (`track`, `server.ts:136`), divided against the goal skill's XP left (`:537`). Hitpoints XP from combat makes the ETA too short. `xpLeft` always counts to level 99 and does not use `env.target` (`:535-537`) | `packages/dashboard/server.ts:136`, `:291`, `:535-541`, `:566` | Scrape the #1 row of each skill board on each `refreshRanks` pass (the code already fetches each player page). Track the goal skill's XP, not the sum. Use `xpForLevel(target)` |
| 7 | The dashboard vault undercounts the banker. When no bank snapshot is newer than the banker's last logged transfer, its holdings are only the sum of the log (received minus paid). Items it held before the log started are not counted | `packages/dashboard/server.ts:378-380` | Start from the newest banker snapshot and add only the transfers after it. Mark the value "log only" when there is no snapshot |
| 8 | 185 items have no dashboard icon. `items.png` is 2048x1952, so 64 x 61 = 3,904 slots (ids 0-3903). Rev 289 `obj.pack` goes to id 4088. The ids themselves are correct: the 274 and 289 `obj.pack` files are the same (diff: 0 lines) | `packages/dashboard/server.ts:309-314`, `packages/dashboard/items.png` | Show a fallback for ids of 3904 and up, or make a sheet from the 289 cache |
| 9 | Minor text errors. (a) fishing30's comment says "5 clicks" on a whirlpool delete the tool. In the code it is 5 fish rolls on a whirlpool spot (`fishing.rs2:40-43`, `macro_event_whirlpool.rs2:10-19`), and the count is a varp. The code is still correct: it never clicks a whirlpool. (b) The `run-learnings` line numbers drifted: `woodcutting.ts:127` is now `:134` (`hp() >= 3`), and `waterfall.ts:96` is now `:97`. The file warns that line numbers drift | `scripts/generated/fishing30.ts:168-170`; `research/run-learnings-2026-10-23.md:161,167` | Fix the comment. Use the current line numbers when you act on the fix list |

## Item 1: 81f31bb fishing30 (resume, eat, sell, feathers to TARGET, random events)

| Claim | Verdict | Evidence |
|---|---|---|
| Whirlpool spots are npc ids 403-406 | CONFIRMED | `content/pack/npc.pack:404-407`: 403 `macro_whirlpool_freshfish`, 404 saltfish, 405 rarefish, 406 memberfish. `NearbyNpc.id` is the npc.pack id (`vendor/rs-sdk/sdk/types.ts:83-86`) |
| A whirlpool deletes the tool after 5 tries; a big fish throws it on the ground; a river troll attacks | CONFIRMED (code), with the wording issue in rank 9 | `macro_event_whirlpool.rs2:10-19`, `fishing.rs2:40-43`, `macro_event_big_fish.rs2:24-29` (drops the tool 1-7 tiles away: the script searches 9). Names "Big fish" and "River troll": `antimacro.npc:1409,1422` |
| "Feathers to TARGET" | WRONG (rank 1) | `fishing30.ts:23-24,247,478` against `curve.ts` and `fishing.struct` |
| Resume skips the steps that are done; eats; sells junk; pickpockets only at HP 5+ when coins are short | CONFIRMED (code) | `fishing30.ts:298` `coinsNeeded`, `:302` eat, `:311` sellJunk, `:314-344` loop with `hp() < 5`, a full-pack drop at `:319-325`, reachable filter `:328`, direct 2-tick click `:336`. These were run-learnings fixes 3a-3c, now done |
| A full pack with no fish no longer spins | CONFIRMED (code) | `fishing30.ts:493-500`: it drops junk, then spare logs, then ends with a reason. It waits 1 tick each time |
| Proved 2/2 fish_resume TARGET=40 and 1/1 fresh TARGET=30 on practice | CONFIRMED as results, UNVERIFIABLE as "this commit" | `.practice/results.jsonl`: 3 resume runs ok at 06:01-06:02Z (lines 30, 34, 37: `fishing=40 ... trips=0`, one at 41) and the fresh run at 06:06:11Z (line 35: `ok fishing=31 xp=8500 ticks=1448 ... trips=1 ... events=0`), before the commit at 06:06:43Z. The same day also has 3 fails (lines 28, 32, 36) and 6 earlier ok runs. Results do not record the code version. Every proof had `events=0`, so the event handling never ran in a game |
| The preset matches the live Mightyrod state | CONFIRMED with a gap the commit names | `presets.ts` diff: 28 items, Fishing 22, Thieving 50. HP is 10, not the live 2, so the HP-2 rest path was not run |

## Item 2: 14ef247 dashboard

| Claim | Verdict | Evidence |
|---|---|---|
| Vault from status files and vault-log | CONFIRMED, with rank 7 | `server.ts:360-420`. Non-banker: pack + bank snapshot + transfers after the status time. Banker: log only |
| Inferred roles | CONFIRMED | `server.ts:341-352`: the highest-level skill except Hitpoints, else the best hiscore row. It is shown with `*` (`:551`) |
| Item icons from the lostcity-markets sheet | CONFIRMED, with rank 8 | `server.ts:309-314`. The 274 and 289 obj ids are the same, so the icons are correct below id 3904 |
| Pace vs #1 | WRONG (rank 6) | Old snapshot, total-XP rate, fixed level 99 |
| Rank history | CONFIRMED | `server.ts:258-292`: it appends to `.practice/rank-history.jsonl` only on a change. The delta is against the first record in the last 24 h |
| Note | - | `server.ts` and `index.html` have uncommitted edits. The checks above read the working tree |

## Item 3: cbbe5ae research/INDEX.md and docs/agent-brief.md

| Claim | Verdict | Evidence |
|---|---|---|
| 12 contradictions, 25 facts | CONFIRMED | C1-C12 and facts 1-25 in `research/INDEX.md` |
| C1 citations (`fly.toml:25` random events false, `:26` tick 300, `:37` 100 per IP) | CONFIRMED | `vendor/rs-sdk/fly.toml:25,26,37` |
| C3: 99 = 998,458, the deep-dive figure 1,070,140 is wrong | CONFIRMED | `Player.ts:77-85` (`floor(acc / 4) * 10`); `xpForLevel(99)` = 998,458 (run in this session); `rs-sdk-deep-dive.md:351` |
| Fact 4: 25x on every XP source, quests too | CONFIRMED | The one `addXp` caller from scripts is `PlayerOps.ts:817` (multiplier on). Only the `::` cheat passes `false` (`ClientCheatHandler.ts:483`) |
| Fact 6: 3-tick woodcutting and fly fishing +29% | CONFIRMED (source) | `research/tricks-plan.md:9-10`: fishing means 93.6 vs 121.4 XP/tick = +29.7% |
| Fact 14: "a dryad at the willows" | CONFIRMED, with a note | npc 438-443 are `macro_dryhadguardian_1..6` (`npc.pack:439-444`). Their in-game name is "Tree spirit" (`antimacro.npc:984-1164`), so a log search for "dryad" finds nothing. Search for "Tree spirit" |
| Fact 22: an unfinished logout keeps the account in the world up to 500 ticks | CONFIRMED | `World.ts:150` `TIMEOUT_NO_CONNECTION = 500` |
| Fact 5 / C2: practice tick 150 ms, live 399.8 ms | CONFIRMED (source); UNVERIFIABLE (the measurement itself) | `owner-requests.md:69` (e053e28). 742.0 s / 1,856 = 0.3998 s. The Mightyrod status file of that run was not checked |

## Item 4: research/tick-tricks-web.md (in 5032b16)

| Claim | Verdict | Evidence |
|---|---|---|
| 5 user events per tick; only successful ones count | CONFIRMED | `ClientGameProtCategory.ts:6` (USER_EVENT limit 5); `NetworkPlayer.ts:69,141` |
| `p_delay(n)` accepts the next input n+2 ticks later | CONFIRMED | `PlayerOps.ts:378` `delayedUntil = tick + 1 + n`; input is decoded first (`World.ts:402`) and the handlers drop it while delayed (`OpNpcHandler.ts`, `InvButtonHandler.ts:15`); the flag clears later in the tick (`World.ts:776`) |
| The board stamp is the account's total playtime at the level-up | CONFIRMED, with 2 details | `Player.ts:1904-1905` `levelPlaytime[stat] = playtime` (cite correct); `LoginServer.ts:162-181`. Details: a row is written only at `baseLevel >= 15` (`:160`), and a row whose level did not change keeps its old playtime (`:171`) |
| Flinch 2-tick via auto_retaliate.rs2:9-22 | CONFIRMED (code), UNVERIFIED live | `auto_retaliate.rs2:7-25`: shortbow attackrate 4 / 2 = 2, minus 1 on rapid = `map_clock + 1`. It also needs `busy2 = false` (`:7`) and issues `p_opnpc(2)`, which the bot's click must replace |
| 3-tick on all spots (delayed click) via rarefish/memberfish/saltfish | CONFIRMED (code), UNVERIFIED live | `saltfish.rs2:37-51`, `rarefish.rs2:60-73`: the `%action_delay = map_clock` branch rolls. The knife sets `map_clock + 2` (`cut_logs.rs2:83-84`). The spot click clears the fletch weakqueue when the packet is decoded (`OpNpcHandler.ts:47` -> `Player.ts:1027-1029` -> `closeModal` `:817-819`), so no log is used |
| Sacred-oil pyre logs: the level is not checked (`mortton_pyre.rs2:18`) | CONFIRMED | `mortton_pyre.rs2:15-41`: `$level_req` is read and never used. The quest gate `%morttonquest` (`:6`) is in the doc too. 39,938 base XP / 300 per tick = 133 ticks |

## Item 5: research/run-learnings-2026-10-23.md

| Claim | Verdict | Evidence |
|---|---|---|
| Tick totals of the top 10 | CONFIRMED (arithmetic) | #1: 1072+1080+1096+561+866+1111+1072+1119 = 7,977. #2: 517+520+529+724+768 = 3,058. #3: 1300+1645 = 2,945. #6: 1556+1586-2x957 = 1,228. #7: 978. #8: 809 |
| Fire giants max hit 11 against 10 HP | CONFIRMED | Fire giant strength 65, strengthbonus 31 (npc config). floor(0.5 + 73 x 95 / 640) = 11 |
| Fix 3 for fishing30 (reachable filter, full pack, direct click, fish_resume proof) | CONFIRMED done in 81f31bb | See item 1 |
| Fix L `bot.ts:98-101` | CONFIRMED in HEAD | `git show HEAD:packages/core/src/bot.ts` 96-101. The working tree has uncommitted edits, so the lines move |
| Other file:line cites | WRONG in detail (rank 9b) | `woodcutting.ts:127` -> `:134`; `waterfall.ts:96` -> `:97` |

## Item 6: banker.ts, give-to-banker.ts, take-from-banker.ts, swarm.ts

| Claim / check | Verdict | Evidence |
|---|---|---|
| Banker serving window | WRONG (rank 3) | `banker.ts:76`, `actions.ts:2509,2603` |
| Payout request lifetime | WRONG (rank 4) | `banker.ts:61-68`, `take-from-banker.ts:173-176` |
| Race: payout vs donor serving | CONFIRMED, low impact | The requester writes its file (`take-from-banker.ts:162`) after the banker builds `pending` (`banker.ts:74`). The banker then serves it as a donor and gives nothing. The requester's `want` is not met, so the session waits to the deadline and declines. The requester tries again (8 tries, `:167`). It recovers, but it costs time |
| Donor waits while the banker pays out | CONFIRMED, low impact | During `payOut`, `serveTrades` accepts only the requester (`banker.ts:61`). A donor's 60 s trade (`give-to-banker.ts:129`) fails, waits 5 ticks and tries again, at most 6 times |
| Stop files | CONFIRMED works, 1 gap | swarm writes `stop-<account>` (`swarm.ts:61`) and deletes it on start (`:30`). The banker reads the same name (`banker.ts:37`) and ends with `RESULT ok stop file`, which supervise counts as `done` (`supervise.ts:20`). The gap: if the banker is started by hand after a stop, the stop file is still there and it exits at once |
| swarm: an ended non-repeat job cannot start again | CONFIRMED, low impact | `swarm.ts:63`: `ended` is kept in memory. Turning the job off and on again does not clear it. Restart the swarm, or clear `ended` when `enabled` goes from false to true |
| swarm: no second login on an account that runs outside the swarm | CONFIRMED | `swarm.ts:64`: a status file younger than 30 s blocks the start |
| give-to-banker `GIVE=` mode | CONFIRMED | `give-to-banker.ts:101,124,128`: one trade with only the named items, and no bank step |
| Payout of more than 28 unstackable items | Risk, not verified | `banker.ts:56-59` withdraws `w.count` with no check for the 28 pack slots |

## Contradictions to add to INDEX

| Claim A | Claim B | What settles it |
|---|---|---|
| `swarm.json:5` "fix 81f31bb proved 2/2 on practice" for a TARGET=99 live job | Proofs were to 40 with `trips=0 events=0` (`.practice/results.jsonl` lines 30, 34, 37) | A practice proof that runs at least one feather refill trip, 3 times |
| `fishing30.ts:22-23` "the standard table: level 30 = 13363" | `packages/planner/src/curve.ts`: level 30 = 7,345 on this server | Settled by code: use `curve.ts` |
