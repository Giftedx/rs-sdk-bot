import { okPass, proveInProcess } from '../../practice/src/prove';
import { authorLoop, fileExists, runClaude, type AuthorTask } from './author';
import {deliveryTask,runDeliveryTask,runDiagnosticTask} from './delivery-cli';

// Usage: bun packages/router/src/author-cli.ts <taskId>
// Needs a running practice stack (bun packages/practice/src/cli.ts up). Claude writes scripts/generated/<id>.ts,
// the harness proves it, and failures go back to Claude (at most 2 fixes).
const TASKS: Record<string, AuthorTask> = {
    copper5: {
        id: 'copper5',
        goal: 'Mine copper ore until at least 5 copper ore are in the pack. Pass when the pack holds 5 or more copper ore and Mining XP rose.',
        preset: 'measure_mine',
        spot: 'SE Varrock mine (3285, 3365), copper, tin and iron rocks (vendor/rs-sdk/learnings/mining.md). Bronze pickaxe in the pack.',
    },
    shrimp5: {
        id: 'shrimp5',
        goal: 'Net fish until at least 5 raw shrimps are in the pack. Pass when the pack holds 5 or more raw shrimps and Fishing XP rose.',
        preset: 'measure_shrimp',
        spot: 'Draynor net fishing spot (3087, 3230) (vendor/rs-sdk/learnings/fishing.md). Small fishing net in the pack. Dark wizards nearby.',
    },
};
const MORE: Record<string, AuthorTask> = {
    thieve300: {
        id: "thieve300",
        goal: "Pickpocket men and women for 300 game ticks, eating shrimps when Hitpoints is low. Print a line \"RATE thieving <xpGained> <ticks>\" before finish. Pass when Thieving XP rose and the bot never died.",
        preset: "thieve_varrock",
        spot: "South Varrock: man at (3237,3406) and (3223,3398), woman at (3223,3401) (knowledge/npcs.json). Pickpocket level 1, 8 XP; failing stuns and hits. 5 shrimps in the pack.",
    },
    thieveguards: {
        id: "thieveguards",
        goal: "Pickpocket guards for 300 game ticks, eating shrimps when Hitpoints is low. Print a line \"RATE thieving <xpGained> <ticks>\" before finish. Pass when Thieving XP rose and the bot never died.",
        preset: "thieve_guards",
        spot: "Outside Varrock palace: guards at (3206,3462), (3211,3463), (3212,3462), (3213,3465) (knowledge/npcs.json). Thieving 40 is the guard level; a fail stuns and hits harder than a man. 20 shrimps in the pack, Hitpoints 30.",
    },
    thieveknights: {
        id: "thieveknights",
        goal: "Pickpocket knights of Ardougne for 300 game ticks, eating lobsters when Hitpoints is low. Print a line \"RATE thieving <xpGained> <ticks>\" before finish. Pass when Thieving XP rose and the bot never died.",
        preset: "thieve_knights",
        spot: "Ardougne market: knight_of_ardougne spawns at (2652,3318) and (2653,3300) (knowledge/npcs.json); knights wander. Thieving 55 is the knight level; a fail stuns 8 ticks and hits for 3. 20 lobsters in the pack, Hitpoints 50. scripts/generated/thieveguards.ts is a proven script for guards.",
    },
    boatardy: {
        id: "boatardy",
        goal: "Travel from Lumbridge to Ardougne market (2654,3304,0) by boat, without dying. Print a line \"TRAVEL <ticks> <hpMin>\" before finish. Pass when the bot stands within 10 tiles of (2654,3304,0) and never died (a death respawns it in Lumbridge, so a jump of more than 20 tiles in one tick is a death).",
        preset: "boat_ardougne",
        spot: "Route from game scripts: (1) walk to the Port Sarim seamen, seaman_lorris (3028,3221) or seaman_thresnor (3026,3217); talk, pay 30 coins (vendor/lostcity-content/scripts/areas/area_port_sarim/scripts/sailors.rs2); the ship lands at Musa Point on Karamja, on the ship deck (level 1): cross the gangplank to level 0. (2) Walk to the Brimhaven customs officer (2772,3225-3231); talk, choose to journey, pay 30 coins (areas/area_karamja/scripts/customs_officer.rs2). (3) The ship lands at Ardougne (2683,3268, level 1); cross the gangplank, walk to the market. The bot has 10 HP and no food; the land route kills it (measured), so do not walk overland. Use bot.talkTo and sdk.getDialog / clickDialogByText (vendor/rs-sdk/sdk/API.md, vendor/rs-sdk/learnings/dialogs.md). 60 coins in the pack.",
    },
    thieving60: {
        id: "thieving60",
        timeoutMs: 1_200_000,
        goal: "From a fresh account (Thieving 1, 10 Hitpoints, no items, in Lumbridge), reach Thieving level 60 as fast as possible in game ticks, without dying. Steps: (1) pickpocket men in Lumbridge until the pack has at least 60 coins; (2) travel to the Ardougne market by boat (copy scripts/generated/boatardy.ts, proven: 380 ticks); (3) in Ardougne pickpocket the best target for the current level: men below 40, guards from 40, knights from 55 (copy the loops of scripts/generated/thieve300.ts, thieveguards.ts, thieveknights.ts); (4) eat bread when Hitpoints is 5 or less: buy bread from the Baker (baker_merchant at 2654,3311, shop 'bakery': bread 12 coins, 10 in stock) with the coins you steal; keep 3-5 bread. Print a line \"MILESTONE <name> <tick>\" at: coins60, ardougne, level40, level55, level60. Print \"RATE thieving <xpGained> <ticks>\" before finish. Pass when Thieving is 60 or more and the bot never died (a death respawns it in Lumbridge: a jump of more than 20 tiles in one tick that is not a boat ride; the boat rides land on level 1 near (2956,3143) and (2683,3268)). Hard cap: 2500 game ticks.",
        preset: "floors_lumbridge",
        spot: "Lumbridge men: knowledge/npcs.json 'man' spawns near (3222,3218). Ardougne: ardougnian_male1 (2614,3318), (2621,3293); ardougne_guard (2651-2665, 3300-3318); knight_of_ardougne (2652,3318), (2653,3300), (2669,3298), (2671,3313). Pickpocket levels: man 1, guard 40, knight 55 (vendor/lostcity-content/scripts/skill_thieving/configs/pickpocking/pickpocket.dbrow). Shops: vendor/rs-sdk/learnings/shops.md.",
    },
    cakestall: {
        id: "cakestall",
        goal: "Steal food from the Ardougne baker's stall for 300 game ticks without being attacked. Print \"RATE thieving <xpGained> <ticks>\" and a line \"FOOD <cakes> <bread> <chocolateSlices> <ticks>\" before finish. Pass when at least 6 food items were stolen, the bot was never attacked (Hitpoints never fell), and it never died.",
        preset: "cake_stall",
        spot: "Rules from vendor/lostcity-content/scripts/skill_thieving/scripts/stalls/stealing.rs2:98-121 and configs/stalls/stealing.dbrow [stealing_bakery_stall]: a steal is refused when the owner (baker_merchant) is within 5 tiles with line of sight, and an ardougne_guard within 5 tiles with line of sight shouts and attacks. So only steal when no baker_merchant and no ardougne_guard is within 5 tiles; otherwise wait or step to another stall side. Stalls: bakers_stall_stealing, one touching (2654,3310) and one touching (2654,3311); bakers stand at (2654,3311) and (2669,3310) and may wander; guards spawn at (2651,3307), (2659-2661,3309), (2663,3301), (2665,3300), (2664,3318). The stall refills 8 ticks after a steal. Loot: cake 13/20, bread 5/20, chocolate slice 2/20. Thieving 5 is the stall level, HP 10. Find the stall with sdk.getState().nearbyLocs and its steal option.",
    },
    fishing30: {
        id: "fishing30",
        timeoutMs: 900_000,
        goal: "From a fresh account (no items, 10 Hitpoints, in Lumbridge at 3222,3218), reach Fishing level 30 as fast as possible in game ticks, without dying. Plan: (1) get a small fishing net and net shrimps at the Draynor spot (3086,3228) to Fishing 20; (2) sell the raw fish at the Port Sarim fishing shop (Gerrant, area_port_sarim, inv 'fishingshop') and buy a fly fishing rod (5 coins stock) and about 200 feathers; (3) fly fish ('Lure') at the Lumbridge river spot (3238,3252) with the 3-tick trick below. Print \"MILESTONE <name> <tick>\" at: net, fishing20, rod, fishing30. Print \"RATE fishing <xpGained> <ticks>\" before finish. Pass when Fishing is 30 or more and the bot never died. Hard cap: 3000 game ticks.",
        preset: "floors_lumbridge",
        spot: "Measured facts on this server (do not re-derive): (a) Send game actions with s.direct({type, ..., reason: 'SDK'}): useItemOnItem {sourceSlot,targetSlot}, clickComponent {componentId}, interactNpc {npcIndex,optionIndex}, interactLoc {x,z,locId,optionIndex}. The normal sdk/bot actions run one at a time and can land in different ticks; bot.interactNpc and bot.mineRock walking to a water tile can freeze the whole process, so do not use bot.interactNpc for fishing spots. (b) Net fishing: one direct Net click starts a chain the server keeps going on its own; clicking again breaks it. A level-up dialog stops the chain: close it at once (sdk.getDialog(); send the continue click) and click the spot again. (c) 3-tick fly fishing, measured +29%: every 3 ticks send, in the same tick and in this order: useItemOnItem knife on logs, clickComponent componentId('skill_multi3:make1_a') (import componentId from packages/core/src/logout.ts), interactNpc on the spot with its Lure option. Keep a knife and several logs (normal 'Logs') in the pack: a missed click lets the fletch finish and uses a log. See scripts/measure/fish-3tick.ts (proven). This also closes level-up dialogs. (d) Danger: the Lumbridge-Draynor-Port Sarim walk is safe on the route in scripts/generated/thieving60.ts (walk points 3225,3240 -> 3180,3258 -> 3100,3285 -> 3060,3265 -> 3047,3237 -> 3029,3217), clear of the jail guards at Draynor. Ground spawns (map data): a knife at (3224,3202,0) in Lumbridge, logs at (3089,3265,0) and (3089,3266,0) next to the Draynor net spot; pick them up with the take option. The Port Sarim fishing shop sells the small net (5), fly fishing rod (5) and feathers (1000). Shops: vendor/rs-sdk/learnings/shops.md. Use counters (shopTicks, walkTicks, fishTicks) in the RESULT line.",
    },
    waterfall: {
        id: "waterfall",
        timeoutMs: 1_200_000,
        goal: "Complete Waterfall Quest from the preset start (next to Almera at Baxtorian Falls, 10 HP, 2 ropes, 6 air/earth/water runes, 10 lobsters, 500 coins), as fast as possible in game ticks, without dying. At 25x the reward is 343,750 Attack XP and 343,750 Strength XP. Print \"MILESTONE <step> <tick>\" at each quest step (when %waterfall_quest advances: read the quest journal or watch the reward). Print \"RATE attack <xpGained> <ticks>\" before finish. Pass when Attack XP rose by at least 300,000 and the bot never died. Hard cap: 4000 game ticks.",
        preset: "quest_waterfall",
        spot: "Two sources, use both: (1) the community step guide vendor/quest-helper/src/main/java/com/questhelper/helpers/quests/waterfallquest/WaterfallQuest.java (steps, exact coordinates, item uses, the Tree Gnome Village maze path, the pillar order); (2) this server's own quest scripts vendor/rs-sdk/server/content/scripts/quests/quest_waterfall/scripts/*.rs2 and the varp values in its configs: the server script is the truth when they differ (2004 content; no games necklace exists). Measured facts on this server: send same-tick clicks with s.direct({type:'interactNpc'|'interactLoc'|'useItemOnItem'|'useItemOnLoc'|'clickComponent', ..., reason:'SDK'}); bot.* actions run one at a time. Dialogs: sdk.getDialog() and sdk.clickDialogByText / sendClickDialog. Run is unlimited. Danger: check routes with bun research/route-danger.ts x,z x,z ... and avoid aggressive NPCs; at 10 HP eat lobsters early. Death respawns in Lumbridge (a jump of more than 20 tiles that is not a known teleport, ladder or barrel ride).",
    },
    woodcutting: {
        id: "woodcutting",
        timeoutMs: 1_200_000,
        goal: "From a fresh account in Lumbridge (3222,3218; Tutorial Island skipped on live; the preset gives a bronze axe), reach the Woodcutting level in env TARGET (default 45) as fast as possible in game ticks, without dying. Use the proven 3-tick trick the whole way. Plan: (1) pick up the knife on the ground at (3224,3202,0); (2) chop normal trees around Lumbridge with 3-tick until you have a few spare logs; (3) get 200+ coins (pickpocket a Lumbridge man, 3 coins each, or sell logs) and buy a steel axe (200 coins) from Bob's axe shop (Bob at 3232,3203, shop 'axeshop'), wield it at Woodcutting 6; (4) oaks from 15 (oaktree locs around Lumbridge, e.g. 3190,3210 / 3200,3240-3245 / 3215,3205); (5) willows from 30 at the castle river (willowtree at 3230,3235-3240, 34 safe tiles from the castle) or the cluster at (3160-3180,3265-3270). Drop logs when the pack fills (keep knife, axe and 3 normal logs). Print \"MILESTONE <name> <tick>\" at knife, steelaxe, level15, level30, level45 and every 10 levels after. Print \"RATE woodcutting <xpGained> <ticks>\" before finish. Pass when Woodcutting reaches TARGET and the bot never died. Hard cap: env CAP (default 3000) game ticks.",
        preset: "wc_fresh",
        spot: "Proven on this server (scripts/measure/wc-3tick.ts, +29%, read it and copy its core): every 3 ticks send in ONE tick with s.direct, in this order: {type:'useItemOnItem', sourceSlot: knife, targetSlot: a normal 'Logs'}, {type:'clickComponent', componentId: componentId('skill_multi3:make1_a')} (import componentId from packages/core/src/logout.ts), {type:'interactLoc', x, z, locId, optionIndex: the tree's Chop down op}. No log is used up when the tree click follows in the same tick; a missed click can use one, so keep 3+ normal logs. The knife-on-log also closes level-up dialogs. Woodcutting success depends on the axe a lot (skill_woodcutting/configs/trees.dbrow: bronze 64-200, steel 128-400 on normal trees; oak 32-100 bronze vs 64-200 steel). A tree falls with 1 chance in 8 per log (normal trees always fall): move to the nearest standing tree at once. Stand next to the tree before the first click (a loc click runs in the arrival tick only if the bot did not move). Do not use bot.chopTree or bot.walkTo near water if a direct sendWalk works; bot.* actions run one at a time. Shops: bot.openShop / buyFromShop; wield: bot.equipItem. Danger: check paths with bun research/route-danger.ts; the castle willows are clear.",
    },
    gecourier: {
        id: "gecourier",
        timeoutMs: 1_500_000,
        goal: "Food courier for the Thieving specialist. From the Ardougne market (start tile in the preset, coins in the pack), travel to the Grand Exchange in Varrock, buy env LOBSTERS (default 120) lobsters (item 379) at env PRICE (default 170) coins each, collect them as notes, travel back to the Ardougne market, and stand at (2655,3304). With env DRY=1 (the practice server has no sellers), skip the buy and only do the round trip, the exchange open and the offer screen. Print \"MILESTONE <name> <tick>\" at: sarim, ge, bought (or dry), back. Print \"RESULT ok ...\" with lobsterNotes=<n> coins=<n> ticks=<n>. Pass when the bot is back within 6 tiles of (2655,3304), never died, and (DRY=1 or lobster notes >= 1). Hard cap: 4000 game ticks.",
        preset: "courier_ardougne",
        spot: "Route, all measured or danger-checked on this server: (1) Ardougne market -> Captain Barnaby at the Ardougne dock (2679,3275), fare 30, sails to Brimhaven (vendor/rs-sdk/server/content/scripts/areas/area_ardougne_east/scripts/captain_barnaby.rs2); cross the gangplank. (2) Brimhaven -> Musa Point on Karamja: copy the walk in scripts/generated/boatardy.ts in reverse (2774,3228 -> 2800,3200 -> 2850,3175 -> 2920,3160 -> 2956,3146); the customs officer near Musa Point (2953-2955,3146-3147) sails to Port Sarim for 30 (areas/area_karamja/scripts/customs_officer.rs2:81-85). (3) Port Sarim (3029,3217) -> Grand Exchange: walk points 3047,3237 -> 3060,3265 -> 3100,3285 -> 3180,3258 -> 3225,3240 -> 3235,3300 -> 3210,3380 -> 3181,3440 (590 tiles, checked with research/route-danger.ts: only a level-2 spider near Lumbridge). GE: bot.openGE() walks to the stand (3181,3443) and opens it; bot.placeGEOffer({ item: 379, side: 'buy', quantity, price }); then bot.collectGE() collects as notes (vendor/rs-sdk/sdk/API.md 'Grand Exchange', vendor/rs-sdk/sdk/MARKET.md). (4) Back the same way: Port Sarim seamen (3026-3028,3217-3221) to Musa Point, walk to the Brimhaven customs officer (2772,3225-3231) to Ardougne (scripts/generated/boatardy.ts does this exact leg; copy it). Facts: bot.walkTo works on land; bot.* actions run one at a time; dialogs via sdk.getDialog / clickDialogByText; run is unlimited. Use counters (walkTicks, boatTicks, geTicks) in the RESULT line.",
    },
    rcair: {
        id: "rcair",
        goal: "Craft air runes from all rune essence in the pack at the air altar. Pass when the pack holds air runes, no rune essence is left, and Runecraft XP rose. Print \"RATE runecraft <xpGained> <ticks>\" before finish.",
        preset: "rc_air_inside",
        spot: "Already inside the air altar area (arrival tile 2841,4830, runecraft_table in knowledge/dbtables.json). The altar is a nearby loc; use its craft option. Air talisman and 27 rune essence in the pack.",
    },
};
Object.assign(TASKS, MORE);
const capability=process.argv[2]==='--task'?deliveryTask(process.argv[3]??''):undefined;
const task:AuthorTask|undefined=capability?{id:capability.id,goal:capability.goal,preset:'delivery-owned',delivery:capability}:TASKS[process.argv[2] ?? ''];
if (!task) { console.log(`tasks: ${Object.keys(TASKS).join(', ')}`); process.exit(2); }
const r = await authorLoop(task, { maxFixes: 2, proveRuns: 3 }, {
    runModel: async p => { const m = await runClaude(p); console.log(`MODEL ok=${m.ok} cost=$${m.costUsd.toFixed(3)} ${m.text.slice(0, 200).replace(/\n/g, ' ')}`); return m; },
    prove: async (file, t, runs) => {
        const p = await proveInProcess({ bot: `g${t.id.slice(0, 4)}`, script: file, runs, preset: t.preset, pass: okPass, outcome: t.id === 'rcair' ? 'rcair' : undefined, timeoutMs: t.timeoutMs, parallel: 1 });
        const tail = p.results.map((x, i) => `run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'}: ${x.tail.replace(/\n/g, ' | ')}`).join('\n');
        console.log(`PROOF ${p.passes}/${p.runs}\n${tail}`);
        return { passes: p.passes, runs: p.runs, tail };
    },
    exists: fileExists,
    deliver:runDeliveryTask,
    diagnose:runDiagnosticTask,
});
console.log(`AUTHOR ${JSON.stringify(r)}`);
// Exit 3 distinguishes a successful exercise from a delivered capability.
process.exit(r.complete ? 0 : r.ok ? 3 : 1);
