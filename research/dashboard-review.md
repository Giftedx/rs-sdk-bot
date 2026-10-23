# Dashboard review, 2026-10-23

Page: `packages/dashboard/index.html`, server: `packages/dashboard/server.ts`, `http://localhost:3100`.
Screenshots: `bun scripts/shot.ts <url> <out> <w> <h> 12000`, 0 `msedge.exe` with a `shot-` profile after each.

Screenshot folder (session scratchpad):
`E:\moved\temp\claude\F--dev-on-f-osrs-rs-research-rs-sdk-bot\72e3d252-d3cd-4626-9f3d-241dd42da82c\scratchpad\`

- Before: `deep-1.png` (1920 x 1080)
- After: `final-1920.png` (1920 x 1080), `final-2560.png` (2560 x 1440); steps `after-1.png` to `after-3.png`

## One source of truth for the main-account plan

The race now calls the planner with the options of
`bun packages/planner/src/haggis-cli.ts research/hiscores-live.json`, scenario a: `schedule(boards,
haggisActivities(), { travel: haggisTravel(), mode, tricks: new Set() })`. The old server code used
`applyLevers(...)` and no travel model. That gave -3,589.

The headline is the realistic plan. The floor plan shows next to it.

| Number on the page | Page value | Source value | Source |
|---|---|---|---|
| Overall gap, realistic | -8,676 | -8,676 LATE | CLI, Overall row |
| Overall gap, floor | -1,421 | -1,421 LATE | CLI, Overall row |
| Boards won, realistic / floor | 0 / 0 | 0 WIN rows in both columns | CLI table, scenario a |
| 19 skill rows, realistic and floor slack | e.g. Agility -37,820 / -30,565, Cooking -157 / -128 | same | CLI table (all 20 clock rows compared in `/api/state`) |
| Finishes last | Agility 44,592 | Agility realistic finish 44,592 | CLI table |
| Quest Points | 145 QP by tick 1,022,262, plan 142 QP, never | `leaderTicks 1022262`, "QP at end 142", NEVER | `loadSnapshot` rule, CLI route line |
| No-clock steps | Equipment 106,156, Bank 106,235, Runite 108,161 | same | CLI, NO-CLOCK rows |
| Go gates | 0 / 5 | 5 gates, `fresh targets` pass (shown green) | `.practice/haggis-go.json` |
| Unmeasured inputs | 92 (gate detail) | "92 inputs not MEASURED" | gate 1 detail |

The brief quoted 1,022,261 for Quest Points. The planner's rule says 1,022,262. The page shows the
planner's value.

Gap history: older points in `.practice/gap-history.jsonl` used the old model. The page shows only
points marked `m: "cli"`, so the sparkline starts again at 12:01.

## Sections

| Section | Before | After |
|---|---|---|
| Header | Gap -3,589 (wrong model). "Swarm XP per hour 8873K" counted level-99 gold farmers. 4 hero numbers mixed per-hour units. | Realistic gap -8,676 with floor -1,421, both named. Boards won realistic with floor. Coins per tick (per hour small). XP per tick only for bots below their target level ("0, no bot below its target" now). Tooltips give the time and the options. |
| Alerts | Red and pink badges with filled colour. | Status word with icon (✝ death in red, ⚠ in orange), no filled badges. "✔ no live alert in the last hour" when clear. |
| Live accounts | Main account row: "bad job: no script". Offline rows led with stale swarm notes ("moved into the goldfarm host" on accounts that died). Gold farmers showed gp/h and xp/h. Idle shown in red. | Main row first in the offline group: "reserved", name blurred. Offline rows lead with the newest RESULT and any death (with age), then the swarm note in dim text. When an account has a disabled entry and a host entry, the enabled host entry wins. Gold rows: c/tick, made, food with ticks to empty. Idle above 10% in orange with ⚠. |
| Practice | Unchanged layout. | Fail icon orange, death icon red. Empty state text. |
| Owner requests | 60 rows parsed: row 66 (appended without a header) was read as a header and lost. | 61 rows. A header row needs a separator row after it; headerless rows are read by position. When an id occurs twice, the row lower in the file wins. "Newest changes" shows the 3 newest changed rows from git (66, 45, 36). Muted status colours (NOT STARTED no longer red). |
| Machine | Red/orange CPU bars. 6 processes, last row clipped. | Gold bars, ⚠ in orange when CPU > 85 % or free RAM < 5 GB. 3 processes plus a "+N more" line, no clipping. |
| World | Unchanged (embedded viewer). | Unchanged. 2D map labels the main account as "main", never the name. |
| Main account race | 24 full-width red bars from 0 to the finish; every bar looked the same. | Diverging bars centred on the #1's time, slack in ticks, late to the left (red), ahead to the right (green). Bar = realistic, tick = floor. Sorted by realistic slack, nearest first, two columns. One symmetric scale (±40,000 ticks, nice-rounded, clamp 40,000; a clamped bar gets an arrow). Legend. Hover: #1 name and ticks, finish ticks, slack, inputs (MEASURED / ESTIMATE / CODE-READ). Quest Points row with its 145-QP rule. Equipment, Bank, Runite in a compact "no clock, rank by value" row. Header strip: headline, gap sparkline, the board that finishes last and its activity, the 5 gates. |
| Economy | Flow was 4.7 h old with no sign. Vault "1466K". | Flow age chip ("⚠ last 5.9h ago"); the flow is greyed out when older than 1 h. Millions shown as "1.15M". Farmers: c/tick, made, food with ticks to empty. Column headers name the units. |
| Account detail | Gold farmer led with "XP/HR 4822K" and "VS #1". 12 small tiles with clipped labels. | Layout picked from the role. Gold: coins/tick, made this run, food left (ticks to empty) as hero numbers; coins held, bank food, eat rate, HP, run up, last seen. Training: xp/tick, ticks to target, vs #1. Done: goal reached, vs #1, last run. Banker: vault value, coins, last transfer. Main: gates, realistic gap, boards won. Offline accounts show the result/death line. Stats in 3 columns, no clipped labels. |
| Activity | 120 rows, mostly practice runs. | Live accounts only in the list. Practice is one pinned line: last-hour counts (✔ / ✘ / ✝ / phase changes); a click opens it. |

## Art pass, whole page

- Tokens: one accent family (gold), status colours `--win`, `--warn`, `--late` only for state, each with an
  icon and a word. Ledger categories have their own tokens, with a legend in the detail panel.
- Red only for death and late.
- Hero numbers 22-24 px, proportional figures. Tables use tabular figures. Labels are 11 px small caps.
- Durations in ticks; game time in tooltips.
- Loading state in every panel before the first state; empty states in each list.
- 1920 x 1080: no clipped text found in `final-1920.png`. 2560 x 1440: wider side columns, roster without
  a height cap (`final-2560.png`).

## Not verified

- Hover tooltips were not seen in a screenshot (`scripts/shot.ts` does not hover). The tooltip HTML is in
  each race row's `data-tt` attribute.
- `scripts/swarm.ts` now writes `reserved` for an entry with no script (test in `scripts/swarm.test.ts`).
  The running swarm process still has the old code until it restarts. The dashboard reads the old
  `bad job: no script` state as a reservation too.
