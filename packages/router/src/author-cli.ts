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
