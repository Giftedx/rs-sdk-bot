# Player fight loop

The PK army's fight loop is `fightPlayer` in `scripts/pk.ts`; `scripts/measure/pk-duel.ts` measures it on practice.
Source -> local consumer -> reuse -> check: the pinned server's PvP scripts (`vendor/rs-sdk/server/content/scripts/skill_combat/scripts/pvp/`) and the
in-process client's player entities (`webclient/src/dash3d/ClientPlayer.ts`, `ClientEntity.ts`) -> `scripts/pk.ts` -> reuse the SDK sends
(`sendInteractPlayer`, `sendSpellOnPlayer`, `sendTogglePrayer`, `sendUseItem`) and read head icons, worn items and the health bar from
`Session.client`, which leaves the SDK state and the swarm's launch release unchanged -> `scripts/pk.test.ts` and the duels below.

## Server rules the loop follows

- Protect prayers cut a player's max hit by 40%, not 100% (`pvp_melee.rs2:32`, `pvp_ranged.rs2:38`, `pvp_magic.rs2:182`).
- The attackable gap is the shallower player's Wilderness level, (z - 3520) / 8 + 1 on the surface (`wilderness_levels.rs2:4-16`, `pvp_combat.rs2:32-48`).
- The killer gets one of eleven messages naming the loser (`pvp_combat.rs2:203-222`); the SDK emits no kill event for a player.
- Head icon bits (`player/configs/headicon.constant`): 0 skull, 3 Protect from Melee, 4 Protect from Missiles, 5 Protect from Magic.
- A glory rubbed from the inventory teleports up to Wilderness level 30 (`amulet_of_glory.rs2`); the content has no Teleblock, Vengeance or Ancient Magicks.
- Dragon weapons need Lost City complete (`%zanaris` 6, `levelrequire.rs2:156`).
- `PlayerState.x` and `z` are scene-local; `worldX` and `worldZ` are tiles.

## Findings

Conditions for every duel: practice server at 150 ms ticks; both accounts 99 Attack, Strength, Defence, Ranged, Magic, Prayer
and Hitpoints, rune full helm, platebody, platelegs, kiteshield, glory, cape of legends, ranger boots, Lost City done; both at
(3094/3096, 3555), Wilderness level 5. The tribrid carries a mystic fire staff, a magic shortbow with rune arrows, a dragon dagger (p),
Fire Wave runes, 2 prayer potions and 18-19 sharks, and rotates magic, ranged and melee. The dummy has no food and only
auto-retaliates with a dragon dagger (p). Times are ticks from the first tick to the kill message.

1. **The loop kills a maxed player.** 32 of 32 duels with food ended in a kill; the tribrid ate 0-7
   sharks (one outlier of 14). Evidence: `.practice/pk/*.txt` in the Claude cloud container that ran them. Gap: the dummy neither
   eats nor switches; no mirror match; no live fight.
2. **Hitting off the opponent's overhead prayer kills sooner.** Dummy on Protect from Magic: reading the overhead (the loop then
   casts no magic) 191, 224, 180 ticks; ignoring it 379, 214, 331. Medians 191 against 331. Gap: three runs each, wide spread.
3. **Protecting from the opponent's worn weapon cuts food use.** Against the dagger dummy, Protect from Melee chosen from the
   worn weapon: 2, 3, 2 sharks eaten; Protect from Magic at range: 7, 7, 0. Gap: the second set also froze, so the two changes are
   confounded; food use, not survival, is measured.
4. **A freeze in a stand-up duel does not speed the kill.** Freeze whenever the dummy is free: 358, 312, 706; no freeze: 305, 381, 244.
   The loop freezes only when asked (`freeze`). Gap: chases and escapes, where a freeze should matter, are not measured.
5. **The dragon dagger special fires but shows no gain.** Full energy, special at the dummy's health bar 50% or less: 4-5 specials
   a fight, energy 1000 -> 750 -> 500 -> 250; times 323, 289, 241 against 239, 369, 254 without. In one logged duel the health bar
   read 47/99 before and after four specials in a row. Gap: whether the specials hit, and whether the bar refreshes on every hit.
6. **The glory escape works.** No food, escape at 60 HP: the loop rubbed the glory at 59 HP, chose Edgeville and left the
   Wilderness 82 ticks into the fight. One run.
7. **The hunter runs a whole trip.** `scripts/pk-hunt.ts` on practice: start at Edgeville bank with the kit banked, restock
   (18 sharks, runes, potions, glory, staff, bow), walk to (3094, 3540), engage a maxed dummy at Wilderness level 4, kill it in
   174 ticks and loot 5 piles (rune arrows, rune scimitar, rune full helm, shark) at the dummy's last tile until the inventory
   was full, then hunt on to the tick cap and log out. One clean run after four fixes:
   - wait for the drop;
   - loot at the target's last tile, not where the fight began;
   - heal before a new fight;
   - move a hunt spot that rejected walks.

   Gap: no live run; no opponent that eats, prays or flees; a death ends the run.
8. **A range pure runs the hunter from Ardougne.** Practice, one run. A combat-78 pure (Attack 69, Strength 1, Defence 1,
   Ranged 99, Magic 48, Prayer 75, Hitpoints 83) in coif, black d'hide chaps and vambraces, with a magic shortbow. It started at
   Ardougne with a glory, rubbed to Edgeville, and restocked a staff of fire, a rune scimitar and Fire Bolt runes (`PK_KIT`,
   `PK_TRIP`, `PK_SPELL`). It killed a combat-76 melee dummy at Wilderness level 4 in 128 ticks and looted 4 piles. Gap: one
   run; no live run.
9. **Without a glory, a teleport spell travels and escapes.** The live market has no sellers of glories, d'hide, coif, staff
   of fire or rune scimitars (claude-cloud's market read of `/api/market/items/<id>`), so a pure may have none of them.
   Practice, one run each, Varrock Teleport (1 law, 3 air, 1 fire; up to Wilderness level 20, `teleport.rs2:17`):
   - The hunter started a range pure at Ardougne with only a magic shortbow, rune arrows and the teleport runes. It
     teleported, walked to Edgeville bank, restocked sharks, killed the combat-76 dummy with ranged alone in 113 ticks and
     looted 4 piles.
   - With no food and no glory, the fight loop cast the teleport at 53 HP and left the Wilderness 136 ticks into the fight.

   Gap: one run each; the walk from Varrock to Edgeville is not checked live.
10. **Live: the hunter's trip works, and the shallow Wilderness by Edgeville had no target.** UnderMyKilt (claude-cloud),
    one run of 1,500 ticks:
    - Kit: magic shortbow, 66 rune arrows, sharks and Varrock Teleport runes, bought for 478,785 coins.
    - Trip: it cast Varrock Teleport, walked to Edgeville, restocked once and cycled the three spots at Wilderness levels 3-7.
    - Result: 0 fights and 0 deaths; it ended at the cap and logged out (`RESULT ok hunt cap kills 0`).
    - Evidence: `.practice/pk-pilot/pk-hunt.log` in the claude-cloud container.
    - Gap: the run logged no seen players, so it cannot tell an empty area from out-of-range or busy players. The hunter
      now logs every player it sees with its verdict (`HUNT seen`).
11. **Deeper than a teleport reaches, the loop runs south first.** Practice, one duel at Wilderness level 36 with no food:
    it ran south, rubbed the glory at 48 HP once at level 30, and left the Wilderness 199 ticks into the fight.
12. **The SDK reports an NPC's damage from someone else as `damage_taken`** with `targetType` npc and `sourceIndex` -1. A
    hunter that read it as an attack started a fight in watch-only mode. Only `damage_taken` with `targetType` player and a
    player source index counts as an attack.
