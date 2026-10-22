# Demo smoke test, 2026-10-22 (first live run)

Command: `DEMO_OK=1 bun scripts/demo/smoke.ts mmsmk1232` (fresh account from `vendor/rs-sdk/bots/create-bot.ts`,
TELEMETRY=false, SHOW_CHAT=false). Server: rs-sdk-demo.fly.dev.

Output:
```
START 3094 3106 0
SMOKE {"tutorialOk":true,"tutorialTicks":13,"chops":3,"logs":3,"wcXp":1875,"sessionTicks":94,"msPerTickIncludingLogin":539,"at":[3235,3229,0]}
RESULT ok tutorial true in 13 ticks, 3 chops, 94 session ticks
LOGOUT logged-out
```

What it shows:
- The in-process client logs in to the live server. The in-game logout ends the session.
- Tutorial skip: 13 ticks live, 10 on the practice copy.
- 3 logs gave 1875 Woodcutting XP (625 each = 25 x 25), the same 25x rate as the practice copy.
- 539 ms per tick, login included. The live tick is likely slower than the practice 300 ms. Measure it
  without login before converting practice tick counts to live time.
- Pathfinding init took 13.8 s on this machine before START.
