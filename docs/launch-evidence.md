# Main launch evidence

Game execution remains paused. Local records do not prove live competition conditions or authorize a resumed run.

`bun scripts/haggis-gate.ts --check` prints readiness without writing. The default writes `.practice/haggis-readiness.json`; it cannot replace `.practice/haggis-go.json` authorization. After execution resumes, `--authorize` can issue permission only when every gate passes. Main login also requires `HAGGIS_RUN=1`.

Version 2 file references contain repository-relative `path` and lowercase `sha256`. Context binds runnable source, planner data, item catalog, upstream pin and target rules/leaders. A timestamp-only target refresh preserves rehearsal context. Changed evidence bytes invalidate permission.

- **Plan:** the realistic schedule with all tricks wins Overall by at least 2% of its deadline, and every activity that starts before the Overall finish has MEASURED inputs. Other boards do not gate the launch.
- **Supplies:** `.practice/haggis-supplies.json`: `version`, `context`, `at`, `allocations`. Each allocation has `item`, `itemId`, `count`, `holder`, `recipient:"haggis"`, `bank` and `delivery` references. Quantities exactly cover the sum of resolved planner requirements that share one base stock key. Bank staging checks the total quantity. The worker checks the required item form at handoff.
- **Bank:** `name`, `server`, `bankAt`, `bank` items with numeric `id` or `baseId` and `count`. The holder is owned; server is `rs-sdk-demo.fly.dev`.
- **Delivery:** `ok:true`, `observed:true`, live `server`, distinct owned `from`/`to`, `at`, and `items`, `before`, `after` arrays. Recipient delta matches transferred quantities. Delivery precedes bank observation. Name-only logs are insufficient.
- **Rehearsals:** three distinct practice actors/runs in `.practice/rehearsals/*.json`. Fields: `version`, `context`, `runId`, `actor`, `server`, `at`, `startPlaytime:0`, `endPlaytime`, `planTicks`, `boardTicks`, `ok:true`, `died:false`, `logout:"logged-out"`, `log` reference. Raw log contains one matching `REHEARSAL {json}` record and `RESULT ok`. No preset clock credit.

Supplies and targets expire after one hour; rehearsals after seven days. Permission expires at the earliest evidence deadline, at most ten minutes. Machine evidence expires after two minutes and is checked again at login. Future timestamps fail.

Current producers do not supply this complete set. Do not convert old summaries into successful receipts. Add receipt output with the authorized real experiment. Hashes establish consistency, not independent attestation.
