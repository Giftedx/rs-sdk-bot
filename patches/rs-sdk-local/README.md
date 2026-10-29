# Local rs-sdk changes (not in upstream)

These 43 files were in the working copy of `vendor/rs-sdk` (pinned to `b565f2d9`) but are not part of that upstream commit. They are our work: engine networking, playtime and migration, web transport, memory diagnostics, benchmarks, and a performance-patch record.

They are kept here, in the parent repo, so they are versioned. Nothing under `vendor/` is committed, so the submodule pin is unchanged.

Paths mirror the rs-sdk layout (for example `server/engine/src/web/WebTransport.ts` here maps to the same path in rs-sdk). They are not applied automatically. To use one, copy it back into `vendor/rs-sdk` at the same path, and record the decision in `patches/rs-sdk.md`.

Snapshot taken from the submodule working copy. Checksums matched the working copy at copy time.
