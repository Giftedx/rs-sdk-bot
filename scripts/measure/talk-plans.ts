// Moves recorded talk plans into scripts/generated/talk-plans.json.
// Usage: bun scripts/measure/talk-plans.ts <record-dir> [quest ...]   (no quest names: every file in the directory)
//        bun scripts/measure/talk-plans.ts --drop <quest> [quest ...]
// A record comes from a run with TALK_RECORD=<record-dir>: `bun run bench '^quester:quest:' --set TALK_RECORD=<dir>
// --set TALK_PLANS=off --no-keep`. Keep the plan of a quest only when the bench shows the quest passes at every seed
// and takes no more ticks with it.
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const file = resolve(import.meta.dir, '..', 'generated', 'talk-plans.json');
const plans: Record<string, Record<string, (string | number)[]>> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const args = process.argv.slice(2);
if (args[0] === '--drop') {
  for (const quest of args.slice(1)) delete plans[quest.startsWith('quest-') ? quest : `quest-${quest}`];
} else {
  const [dir, ...only] = args;
  if (!dir) throw Error('usage: talk-plans.ts <record-dir> [quest ...] | --drop <quest> ...');
  const wanted = new Set(only.map(q => (q.startsWith('quest-') ? q : `quest-${q}`)));
  for (const name of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const quest = name.slice(0, -5);
    if (wanted.size && !wanted.has(quest)) continue;
    const recorded = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, (string | number)[]>;
    // A talk of one or two clicks gains nothing from a plan.
    const useful = Object.fromEntries(Object.entries(recorded).filter(([, clicks]) => clicks.length >= 3));
    if (Object.keys(useful).length) plans[quest] = useful;
  }
}
writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(plans).sort()), null, 1) + '\n');
console.log(`talk-plans: ${Object.keys(plans).length} quests, ${Object.values(plans).reduce((n, p) => n + Object.keys(p).length, 0)} talks in ${file}`);
