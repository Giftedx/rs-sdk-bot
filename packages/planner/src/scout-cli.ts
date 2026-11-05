import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchBoard, type BoardRow } from './scout';

// Usage: bun packages/planner/src/scout-cli.ts [base=https://rs-sdk-demo.fly.dev] [--out=path]
// Saves a complete snapshot of the time-ranked boards. One request per board,
// one second apart. Category ids: skill index + 1 from server/engine/src/web/utils.ts:80 SKILL_NAMES
// (indices 18 and 19 are empty); Quest Points is 100 (utils.ts:91).
const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', null, null, 'Runecraft'];
const args = process.argv.slice(2);
const base = args.find(a => !a.startsWith('--')) ?? 'https://rs-sdk-demo.fly.dev';
const output = args.find(a => a.startsWith('--out='))?.slice('--out='.length);
const tickMs = 400;
const boards: { board: string; category: number }[] = [{ board: 'Overall', category: 0 }];
SKILLS.forEach((s, i) => { if (s) boards.push({ board: s, category: i + 1 }); });
boards.push({ board: 'Quest Points', category: 100 });

const out: { board: string; category: number; rows: BoardRow[] }[] = [];
const takenAt = new Date().toISOString();
for (const b of boards) {
    out.push({ ...b, rows: await fetchBoard(base, b.category, 'main', tickMs) });
    await Bun.sleep(1000);
}
const file = output ? resolve(output) : join(resolve(import.meta.dir, '..', '..', '..'), 'research', `hiscores-${takenAt.slice(0, 10)}.json`);
const temporary = file + '.' + process.pid + '.tmp';
try {
    writeFileSync(temporary, JSON.stringify({ base, takenAt, tickMs, boards: out }, null, 2) + '\n');
    renameSync(temporary, file);
} finally { rmSync(temporary, { force: true }); }
for (const b of out) {
    const top = b.rows[0];
    console.log(`${b.board.padEnd(12)} #1 ${top ? `${top.name} lvl ${top.level} ${top.ticks} ticks (${(top.ticks * tickMs / 60_000).toFixed(1)} min at ${tickMs} ms)` : 'empty'}`);
}
console.log(`saved ${file}`);
