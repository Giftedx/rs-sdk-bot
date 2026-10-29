> Authority (owner decision): all gameplay techniques are authorized. Wine, cocktails, pyre oil, Charge, relogs and tick manipulation need no further approval. Missing supplies create acquisition work, never a route exclusion. See [AGENTS.md](../AGENTS.md).

# Bug report draft for Max Bittker (rs-sdk): wine fermentation at login has no level check

Status: SENT as https://github.com/MaxBittker/rs-sdk/issues/102. This mechanic is authorized for the demo server.

## Summary
A new account with Cooking level 1 and unfermented wine in its bank reaches 99 Cooking about 22 ticks after logging
in, with no action of its own.

## Cause (content at rs-sdk b565f2d9)
- `login_logout/login.rs2:70` calls `~ferment_wines_login` on every login.
- `skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2:72` (`[proc,ferment_wines_login]`) sets the
  `fermenting_wine` timer for 20 ticks. There is no Cooking level check.
- When the timer fires, the `[timer,fermenting_wine]` handler ferments every `jug_unfermented_wine` in the bank in
  15 batches of `bank_total / 15`, each success giving `stat_advance(cooking, 1100 * batch)`.
- Making wine by hand needs Cooking 35 (`[label,make_wine]`), but the login path skips that check.
- The file's own note at line 6: `//todo: Finish wines, jug of bad wine, proper queue clearing`.

## Reproduction (local server, NODE_TICKRATE=300, NODE_XPRATE=25)
1. Save for a fresh account: no Cooking levels, 600 `jug_unfermented_wine` (id 1995) in the bank.
2. Log in and do nothing.
3. Two runs: Cooking 0 -> 99 at session tick 22 (+1,650,000 and +1,320,000 XP).

## Effect
The Cooking board ranks by the playtime at which 99 was reached. Any account fed unfermented wine by other
accounts can reach 99 in roughly the login time plus 20 ticks.

## Possible fixes (for the maintainer to choose)
- Check `stat(cooking) >= 35` (or the original rules) in `ferment_wines_login`, or only ferment wines the account made.
- Award per-wine XP with the same success rule as the hand-made path.
