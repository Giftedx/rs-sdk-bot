import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchBoard, type BoardRow } from './scout';

// Usage: bun packages/planner/src/scout-cli.ts [base=https://rs-sdk-demo.fly.dev]
// Saves the top rows of every time-ranked board to research/hiscores-<date>.json. One request per board,
// one second apart. Category ids: skill index + 1 from server/engine/src/web/utils.ts:80 SKILL_NAMES
// (indices 18 and 19 are empty); Quest Points is 100 (utils.ts:91).
const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', null, null, 'Runecraft'];
const base = process.argv[2] ?? 'https://rs-sdk-demo.fly.dev';
const boards: { board: string; category: number }[] = [{ board: 'Overall', category: 0 }];
SKILLS.forEach((s, i) => { if (s) boards.push({ board: s, category: i + 1 }); });
boards.push({ board: 'Quest Points', category: 100 });

const out: { board: string; category: number; rows: BoardRow[] }[] = [];
for (const b of boards) {
    try { out.push({ ...b, rows: await fetchBoard(base, b.category) }); } catch (e) { console.log(`${b.board}: ${String(e)}`); }
    await Bun.sleep(1000);
}
const date = new Date().toISOString().slice(0, 10);
const file = join(resolve(import.meta.dir, '..', '..', '..'), 'research', `hiscores-${date}.json`);
writeFileSync(file, JSON.stringify({ base, takenAt: new Date().toISOString(), boards: out }, null, 1) + '\n');
for (const b of out) {
    const top = b.rows[0];
    console.log(`${b.board.padEnd(12)} #1 ${top ? `${top.name} lvl ${top.level} ${top.ticks} ticks (${(top.ticks * 0.3 / 60).toFixed(1)} min at 300 ms)` : 'empty'}`);
}
console.log(`saved ${file}`);
