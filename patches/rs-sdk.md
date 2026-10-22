# Changes and workarounds for vendored rs-sdk

rs-sdk is pinned in `rs-sdk.pin`. `bun scripts/check-pin.ts` checks it. We do not edit files under `vendor/` from package code. Each item below says how we deal with an rs-sdk behavior.

1. **LF line endings are required.** `bots/create-bot.ts --local` replaces `SERVER=localhost\n`. With CRLF checkouts (`core.autocrlf=true`, the Windows default) the match fails, and the bot env keeps `SERVER=localhost` with no `GATEWAY_URL`. Fix: `scripts/clone-vendor.sh` clones with `-c core.autocrlf=false`. Seen 2026-10-22.
2. **Telemetry is on by default.** `bot.env` from the template has `TELEMETRY=true`, and `sdk/bug-report.ts` posts to `https://rs-sdk-demo.fly.dev/bug-report`. Our `createBot` rewrites it to `TELEMETRY=false`.
3. **Cheats are off locally.** `server/engine/src/server/login/LoginThread.ts:60` sets `staffmodlevel = 0`. Not patched. Practice presets use `sdk/test/utils/save-generator.ts` instead.
