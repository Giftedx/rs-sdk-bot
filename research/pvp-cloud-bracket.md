# Cloud combat-15 tribrid candidate

Consumer: the cloud fleet operator's uncovered level-14–16 shallow-Wilderness bracket. Merged PRs #426, #428 and #430 cover combat 20, 6 and 9. PR #440 owns local combat 12, Steelrod and `scripts/pvp-standby.ts`. This qualification owns no live account or controller resource.

Claim: a seeded combat-15 build can withdraw its exact kit at Varrock East, switch bow/melee equipment, reach `(3134,3526,0)` in Wilderness level 1, preserve its assets and XP, and obtain a confirmed logout. The native proof covers staging only. Fresh training, player combat, attack/escape policy, saved-position relog and live admission remain open.

## Build and bracket price

Pinned source: `70fcbce` master, reservation commit `fac0199`; SDK `db0cc51e` with the checked-in setup patch. `player/scripts/combat_level.rs2` calculates integer base plus the maximum melee/ranged/magic contribution, divided by 40. `skill_combat/scripts/pvp/pvp_combat.rs2` uses the shallower player's Wilderness level for the attackable level difference.

| Candidate | Attack / Strength / Defence / Prayer | Ranged / Magic | HP interval for combat 15 | Decision |
|---|---|---|---|---|
| Balanced, selected | 1 / 20 / 1 / 1 | 20 / 13 | 20–23 | Lowest Ranged target here, with room for melee and training HP |
| Ranged 21 | 1 / 20 / 1 / 1 | 21 / 13 | 19–22 | Less HP headroom for 305 more Ranged XP |
| Ranged 22 | 1 / 20 / 1 / 1 | 22 / 13 | 17–20 | Less HP headroom for 631 more Ranged XP |

The selected proof seeds HP 23: base `10*(1+23+floor(1/2))=240`, ranged `13*floor(3*20/2)=390`, melee `13*(1+20)=273`, Magic `13*floor(3*13/2)=247`; `floor((240+390)/40)=15`. HP 24 makes combat 16. HP 23 starts at 4,086 XP; HP 24 starts at 4,461, leaving only 375 HP XP. Skills and raw XP must be checked during training and fighting; a level target alone cannot preserve the bracket.

Native level thresholds use `2^(level/10)`. `Player.ts` and the save generator give Strength 20 and Ranged 20 at 3,105 XP each, Magic 13 at 1,471, fresh HP 10 at 980. At 25x, ordinary melee/ranged pay approximately 0.3325 HP XP per selected-skill XP; damage Magic approximately 0.665 HP XP per damage-derived Magic XP, plus base cast XP that grants no HP. A conservative continuous estimate is `980 + 0.3325*(3105+3105) + 0.665*1471 = 4023.04` HP XP, below HP 23. Integer rounding, kill overshoot and cast selection require a complete training proof. This estimate does not qualify a fresh account.

## Exact staging inputs and replacement exposure

| Item | ID | Count | Native base value each | Conservative replacement ceiling |
|---|---:|---:|---:|---:|
| Oak shortbow | 843 | 1 | 100 | 600 GP |
| Steel arrow | 886 | 32 | 12 | 2,304 GP |
| Air rune | 556 | 8 | 4 | 192 GP |
| Mind rune | 558 | 4 | 3 | 72 GP |
| Fire rune | 554 | 12 | 4 | 288 GP |
| Cheese | 1985 | 2 | 4 | 48 GP |
| Bronze sword | 1277 | 1 | 26 | 156 GP |
| Wooden shield | 1171 | 1 | 20 | 120 GP |
| **Total kit** | | | **630 GP** | **3,780 GP** |

These are source prices and budget ceilings, not observed purchases or a full training bill. The ceiling uses six times base value, the existing `maximumUnitCost` rule for a shop with sell multiplier 1000. Observe shelf, multiplier, cash and owned stock before acquisition; a missing source stays a prerequisite. The proof retains an additional 1,000 GP in the bank; no purchases, fares, food, arrows or runes are consumed. Lost-kit exposure excludes that bank reserve.

`ranged/bows.obj` requires Ranged 5 for oak shortbow; `ranged/arrows.obj` requires level 5 for steel arrows. Lowe stocks both. The existing ranged worker enforces arrow requirement at or below both bow and player level. A willow shortbow is a stronger alternative at Ranged 20 but is absent from Lowe's pinned shelf. Mithril arrows additionally require members access. The selected oak/steel kit avoids those acquisition prerequisites. Bronze sword and wooden shield need no trained Attack or Defence. The two-handed bow puts the shield back in the pack; the native proof verifies this and restores sword/shield.

`magic_combat_spells.dbrow` defines the exact unstaffed options:

| Spell | Required Magic | Runes per cast | Maximum hit |
|---|---:|---|---:|
| Wind Strike | 1 | 1 air + 1 mind | 2 |
| Water Strike | 5 | 1 air + 1 water + 1 mind | 4 |
| Earth Strike | 9 | 1 air + 2 earth + 1 mind | 6 |
| Fire Strike | 13 | 2 air + 3 fire + 1 mind | 8 |

The kit funds exactly four Fire Strikes, or four Wind Strikes with four air left, without a staff. It funds no Water/Earth Strike. Fire Strike's base award is 11.5 XP before the server multiplier. These cast counts are supply limits, not permission to exhaust the HP budget. The existing standby worker has no combat-15 profile or Fire rune check and must not receive this account until its owning session integrates and qualifies the profile.

## Evidence and operator handoff

Generated [proof](pvp-cloud-bracket-proof.json); raw evidence under `.practice/cloud-tribrid-bracket/native-1794175801816/`: `before.sav`, `after.sav`, `worker.log`, `worker.err`, `proof.json`. Temporary `run.ts` and `worker.ts` reside in the same task folder. The evidence archive includes the generated report, harness, raw saves/logs and lifecycle receipt; credentials are excluded. SHA-256 bindings are in the generated report.

Conditions: isolated checkout, loopback server `127.0.0.1:22459`, 150 ms ticks, 25x XP, one practice stack under the shared host practice lock, generated fixture `flcloux6yh00`. The fixture process uses the default local fixture ownership; it has no demo authorization. Useful output: staged kit in 214 ticks, combat 15 and HP 23, no XP change, exact total item reconciliation including banked coins, and confirmed lifecycle attempt `1794175805479-0000001533-0000000001`. The stack is stopped. This is one native staging result; no speed comparison is claimed.

Source → local consumer → decision → check: pinned combat/XP/spell/arrow/shop definitions → cloud combat-15 candidate → reuse the existing core bank, equipment, walking, threat and lifecycle helpers → saved native state, unchanged assets/skills and confirmed logout. No external implementation is copied.

Operator inputs: retain combat-15 ownership on the cloud side; acquire the table's kit only against observed stock; qualify fresh Strength/Ranged/Magic training with exact HP XP and combat bounds; integrate the profile through the standby worker's owner; qualify bounded player attacks, emergency exit, interruption and relog on owned practice accounts. Then use the cloud operator's existing admission, release and supply gates for any live pilot. No live name, registration, account claim, lease or plan change is part of this result.
