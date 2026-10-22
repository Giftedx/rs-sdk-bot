# Runecraft ladder (model, 2026-10-22)

Sources:
- Altar rows: `vendor/lostcity-content/scripts/skill_runecraft/configs/runecraft.dbrow`.
- Craft logic: `vendor/lostcity-content/scripts/skill_runecraft/scripts/runecraft.rs2:48-100`.
  XP = essence count x altar experience. Rune count does not change XP. All altars take the same `blankrune`.
- Measured cycle: 19 ticks per pack (rates.json `craft_air_runes_trade_loop`).

Every pack costs the same 19 ticks at any altar, so the crafter always uses the highest altar it can.
XP per essence (x25): air 125, fire 175, body 187.5, chaos 212.5, nature 225, law 237.5.

| Altars used | Ticks to 99 | Minutes at 600 ms |
|---|---|---|
| air only | 5,621 | 56 |
| free altars (air to body) | 3,749 | 37 |
| + chaos, nature, law | 2,976 | 30 |

`bun research/runecraft-ladder.ts` reprints the table. 28 essence instead of 27 (drop the talisman
inside) saves about 3.6%.

Access:
- Death (65): not usable. Its enter and exit coords equal the altar coord (0_50_50_21_18), so no ruins lead in.
- Cosmic (27): ruins in Zanaris. Zanaris needs the Lost City quest. Cosmic (80) is below chaos (85) at 35, so skip it.
- Chaos (35): exit coords are at z 3584+, in the Wilderness. PvP risk on the demo server. Not verified.
- Nature (44): Karamja. Law (54): Entrana (no weapons or armour allowed on the boat).
- Members altars need a members world. `vendor/rs-sdk/fly.toml` sets `NODE_MEMBERS = "true"`. I have not
  verified that this is the demo server's config.

Hidden cost (not in the 19-tick rate):
- The helper holds only one pack. The measured 12-tick resupply assumed the helper already has essence.
  A helper must bank and come back each pack. So the 19-tick cycle needs a rotation of several helpers.
  The helper trip time is not measured.
- Each altar needs a talisman to enter, for the crafter and for each helper inside.
