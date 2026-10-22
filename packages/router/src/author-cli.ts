import { okPass, proveInProcess } from '../../practice/src/prove';
import { authorLoop, fileExists, runClaude, type AuthorTask } from './author';

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
    rcair: {
        id: "rcair",
        goal: "Craft air runes from all rune essence in the pack at the air altar. Pass when the pack holds air runes, no rune essence is left, and Runecraft XP rose. Print \"RATE runecraft <xpGained> <ticks>\" before finish.",
        preset: "rc_air_inside",
        spot: "Already inside the air altar area (arrival tile 2841,4830, runecraft_table in knowledge/dbtables.json). The altar is a nearby loc; use its craft option. Air talisman and 27 rune essence in the pack.",
    },
};
Object.assign(TASKS, MORE);
const task = TASKS[process.argv[2] ?? ''];
if (!task) { console.log(`tasks: ${Object.keys(TASKS).join(', ')}`); process.exit(2); }
const r = await authorLoop(task, { maxFixes: 2, proveRuns: 3 }, {
    runModel: async p => { const m = await runClaude(p); console.log(`MODEL ok=${m.ok} cost=$${m.costUsd.toFixed(3)} ${m.text.slice(0, 200).replace(/\n/g, ' ')}`); return m; },
    prove: async (file, t, runs) => {
        const p = await proveInProcess({ bot: `g${t.id.slice(0, 4)}`, script: file, runs, preset: t.preset, pass: okPass });
        const tail = p.results.map((x, i) => `run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'}: ${x.tail.replace(/\n/g, ' | ')}`).join('\n');
        console.log(`PROOF ${p.passes}/${p.runs}\n${tail}`);
        return { passes: p.passes, runs: p.runs, tail };
    },
    exists: fileExists,
});
console.log(`AUTHOR ${JSON.stringify(r)}`);
process.exit(r.ok ? 0 : 1);
