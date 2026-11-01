# Microbot ports

## Scope and coverage

Port gameplay behaviour from both public production namespaces. Reuse existing rs-sdk workers when they meet the same need.
The [generated inventory](microbot-ports.json) includes every Java file, including files without `Script` or `Plugin` suffixes.
Tests, resources and unrelated RuneLite plugins are outside its scope. Private and third-party repositories are not covered.

| Source | Commit | Java files | Modules | Script-suffix files |
|---|---|---:|---:|---:|
| [Microbot](https://github.com/chsami/Microbot) | `13b518350c4c81d64e4cfbb45b3d5d2f38488825` | 1,444 | 44 | 11 |
| [Microbot-Hub](https://github.com/chsami/Microbot-Hub) | `cd648f48d536c01c58aa82aa4d353fb31ce6e102` | 1,567 | 173 | 212 |

Both recursive tree responses report `truncated=false`. Inventory coverage is complete within this scope.
Behaviour review and ports are incomplete. One Hub script has a behaviour rewrite with unit and simulated SDK adapter proof.
The remaining modules are explicitly `unreviewed`. Candidate worker matches do not claim parity.
Root Java files appear as individual inventory entries. Module counts are namespace groups, not a count of runnable bots.

## Rewrite method

1. Pin the commit. Read the script, config, helper calls and licence. Keep attribution for adapted logic.
2. Find the local worker and its finite consumer. Extend that worker when it already serves the job.
3. Trace each game action through SDK dispatch to the pinned server handler and its item or XP effect.
4. Map items, NPCs, objects, interfaces, coordinates and requirements from local content. Do not copy OSRS IDs or routes without checks.
5. Replace scheduled Java loops and sleeps with tick waits, bounded actions, cancellation and observed state.
6. Replace mouse, overlay and client injection code with structured SDK calls. Keep gameplay decisions separate from client presentation.
7. Check input debits, product credits, XP, protected items and fresh bank receipts. A command success is not a product receipt.
8. Run focused regressions, then native practice through the existing admission lock. Keep failed evidence.
9. Qualify a bounded live consumer under its account owner and exact worker release. Two useful live results precede batch release.

Some scripts depend on game content absent from the older server. Each such port needs an explicit content gap.
A TypeScript stub cannot replace a missing boss, skill, region, spell or minigame.
Do not mark source retrieval, a filename match, or successful compilation as a working port.

## Existing consumers to compare

| Donor behaviour | Existing path | Action |
|---|---|---|
| Mining, fishing, woodcutting | `scripts/gather-ore.ts`, `scripts/fishcook.ts`, `scripts/wc-loop.ts` | Compare profiles and state transitions before adding code |
| Smelting and anvil work | `scripts/smelt-batch.ts`, smithing workers | Check recipes, ingredient accounting and bounded banking |
| Flax spinning, cooking, wine | `scripts/spin-bowstrings.ts`, `scripts/cook-stock.ts`, `scripts/cook-wine.ts` | Reuse bank/travel paths and compare recovery |
| Thieving, Agility, Magic | `scripts/goldfarm.ts`, `scripts/agility-order.ts`, `scripts/magic-order.ts` | Check exact methods, requirements and targets |
| Bank and walker utilities | `packages/core/src/deposit.ts`, `packages/core/src/walk.ts` | Keep existing observation generations, paired receipts and cancellation |

These are source review leads. They are not adopted Microbot code or proved equivalent implementations.
See [project use map](project-use-map.md) for the existing utility source decisions.

## Bones to Bananas

Source: [BonesToBananasScript.java](https://github.com/chsami/Microbot-Hub/blob/cd648f48d536c01c58aa82aa4d353fb31ce6e102/src/main/java/net/runelite/client/plugins/microbot/bonestobananas/BonesToBananasScript.java).
Local consumer: [finite bank worker](../scripts/microbot-bones.ts).
Decision: rewrite the withdraw, cast and bank cycle. Replace timer polling and sleeps with exact receipts and a finite target.
The original withdraws all runes and bones. The rewrite withdraws each cast's runes and caps bone withdrawal by remaining demand and free slots.
The [BSD notice](microbot-ports-LICENSE.txt) applies to this behaviour adaptation.

Server evidence at SDK commit `db0cc51e0a8f9f0d6a7d60c44e534412bb0601bb`:

- `content/scripts/skill_magic/configs/magic_spells.dbrow`, `magic_spell_bones_to_bananas`: Magic 15, 2 earth, 2 water, 1 nature, 25 base XP.
- `content/scripts/skill_magic/scripts/spells/convert_bones.rs2`: converts all regular bones in the pack, then deletes runes and grants XP.
- `content/pack/obj.pack`: bones 526 and banana 1963.
- `content/scripts/skill_magic/scripts/magic.rs2`: equipped elemental staves change rune costs.

Acceptance: convert exactly `MAX_MAKE` owned bones, observe every cast's rune and bone debits, banana credits and XP rise, then prove matching bank credits.
Useful output: a finite owned banana order and Magic XP. No account assignment or demand is created by this port.
Cost: 2 earth, 2 water and 1 nature per cast. Each cast converts all held regular bones.
Scope: staged bank-side start, Magic 15, plain runes, no water/earth/lava staff equipped.
The staff preflight prevents spending against an incompatible receipt. Staff substitution support remains open.
Existing pack bananas must be banked before entry. The worker never buys inputs or enables a swarm job.

```powershell
$env:MAX_MAKE='25'
$env:CAP='500'
bun scripts/microbot-bones.ts <owned-account>
```

Live execution also requires the normal release and admission gates. Do not use the main account for qualification.
The caller owns travel, staging, account leases and demand. Tick limits bound production. Bank cleanup can exceed that limit.
Proof: `scripts/microbot-bones.test.ts` checks exact and partial receipts, target bounds, failed casts and the SDK banking adapter.
The simulated adapter converts 5 bones, spends one cast and proves a 5-banana bank increase while retaining 2 bank bones.
Gap: native practice, saved-state audit, live pilot, equipment substitution, broader profiles and fleet capability registration are unverified.
Owner: `codex/microbot-ports`, [draft PR](https://github.com/Giftedx/rs-sdk-bot/pull/114).
Next action: qualify this finite consumer when the shared practice slot is free, then compare the supported existing workers above.

## Reproduce the inventory

Save each pinned GitHub recursive tree as `{sha,truncated,paths}`, where `paths` contains all blob paths.
Run the generator against those two files. A truncated tree fails instead of silently dropping scripts.

```powershell
bun scripts/microbot-catalog.ts <core-tree.json> <hub-tree.json> research/microbot-ports.json
bun test scripts/microbot-catalog.test.ts scripts/microbot-bones.test.ts
```

Raw tree responses, inspected donor source and licence are under `.practice/microbot-ports/` in the main checkout.
Retained donor-file SHA-256: `c0913d4558f67ce9ad8eb3c28f94f974642c44f2b372a13b38c973927a1103ef`.
The immutable source link identifies the upstream bytes. The retained-file hash identifies the local saved copy.
