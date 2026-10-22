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
