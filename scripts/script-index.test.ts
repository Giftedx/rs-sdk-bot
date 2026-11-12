// The script index (scripts/script-index.ts) prints one line for every script. This test fails when a script has no
// description, and when the table of scripts/script-descriptions.ts holds an entry that another source replaces.
import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {AIO_CATEGORIES} from './aio';
import {SCRIPT_DESCRIPTIONS} from './script-descriptions';
import {OUTSIDE_CATALOG,SCRIPT_GROUPS,aioRoutes,formatScriptIndex,headerSentence,packageCommands,scriptIndex,sourceCounts,staleDescriptions} from './script-index';

const root = resolve(import.meta.dir, '..');
const index = scriptIndex();

test('every script has a description from a route, the outside-catalog cause, a header comment or the table', () => {
 // A script with no description: give it a route, a header comment (a new file) or a line in SCRIPT_DESCRIPTIONS.
 expect(index.filter(l => l.source === 'none').map(l => l.path)).toEqual([]);
 for (const l of index) expect(l.description.length, l.path).toBeGreaterThan(10);
 expect(new Set(index.map(l => l.path)).size).toBe(index.length);
 for (const l of index) expect(SCRIPT_GROUPS, l.path).toContain(l.group);
});

test('the table holds only scripts that have no other description', () => {
 // An entry for a file that is gone, or that a route, an outside-catalog cause or a header comment describes:
 // delete the entry.
 expect(staleDescriptions()).toEqual([]);
 for (const [path, text] of Object.entries(SCRIPT_DESCRIPTIONS)) expect(text.length, path).toBeGreaterThan(30);
});

test('a table entry fails when its file is gone, has a header comment, has a route or has an outside-catalog cause', () => {
 const routed = aioRoutes()[0]!.script, outside = Object.keys(OUTSIDE_CATALOG)[0]!;
 const headed = index.find(l => l.source === 'header' && l.group !== 'packages')!.path;
 const kept = Object.keys(SCRIPT_DESCRIPTIONS)[0]!;
 const table = {'scripts/no-such-script.ts': 'x', [routed]: 'x', [outside]: 'x', [headed]: 'x', [kept]: 'x'};
 expect(staleDescriptions(root, table).map(s => s.path).sort()).toEqual(['scripts/no-such-script.ts', routed, outside, headed].sort());
 expect(staleDescriptions(root, table).find(s => s.path === 'scripts/no-such-script.ts')!.cause).toBe('the file is gone');
});

test('the index covers scripts/ in every folder and the command files under packages/', () => {
 const paths = new Set(index.map(l => l.path));
 for (const f of ['scripts/aio.ts', 'scripts/coin-courier.ts', 'scripts/generated/quest-hetty.ts', 'scripts/measure/fleet-cow-path.ts', 'scripts/pk-live/live-pilot.ts',
  'scripts/proven/gather.ts', 'scripts/demo/smoke.ts', 'packages/router/src/coordinator-cli.ts', 'packages/router/src/coverage.ts', 'packages/router/src/live-update.ts', 'packages/dashboard/publish.ts'])
  expect(paths.has(f), f).toBe(true);
 expect([...paths].filter(f => f.endsWith('.test.ts'))).toEqual([]);
 for (const f of packageCommands()) expect(index.find(l => l.path === f)!.group).toBe('packages');
 // A package file with no main block is not a command.
 expect(paths.has('packages/core/src/bot.ts')).toBe(false);
 for (const f of paths) expect(existsSync(join(root, f)), f).toBe(true);
});

test('a script takes the group of its first route, and a route description comes before every other source', () => {
 const line = (path: string) => index.find(l => l.path === path)!;
 expect(line('scripts/coin-courier.ts')).toMatchObject({group: 'logistics', source: 'route'});
 expect(line('scripts/coin-courier.ts').description).toStartWith('logistics coin-courier: ');
 expect(line('scripts/gather-fish.ts').description).toContain('; skiller fishing:harpoon: ');
 expect(line('scripts/swarm.ts')).toMatchObject({group: 'tools', source: 'outside', description: OUTSIDE_CATALOG['scripts/swarm.ts']!});
 expect(line('scripts/generated/quest-lib.ts')).toMatchObject({group: 'helpers', source: 'header'});
 expect(line('scripts/generated/quest-cook.ts')).toMatchObject({group: 'quests', source: 'header'});
 expect(line('scripts/measure/gather.ts')).toMatchObject({group: 'measure', source: 'header'});
 for (const category of AIO_CATEGORIES) expect(line(`scripts/aio-${category}.ts`).group).toBe(category);
 for (const r of aioRoutes()) expect(index.some(l => l.path === r.script), r.script).toBe(true);
});

test('the printed index has one line a script, with its group, its path and its description', () => {
 const text = formatScriptIndex(index).split('\n'), rows = text.filter(t => !t.startsWith('#'));
 expect(rows.length).toBe(index.length);
 for (const row of rows) expect(row.split('\t').length).toBe(3);
 expect(text.filter(t => t.startsWith('#')).length).toBe(SCRIPT_GROUPS.length);
 const n = sourceCounts(index);
 expect(n.route + n.outside + n.header + n.table + n.none).toBe(index.length);
 expect(n.table).toBe(Object.keys(SCRIPT_DESCRIPTIONS).length);
});

test('the header description is the first sentence of the comment that starts the file', () => {
 expect(headerSentence('// Walks one account to the bank and deposits the logs it holds. A second sentence.\nimport x from "y";')).toBe('Walks one account to the bank and deposits the logs it holds.');
 expect(headerSentence('/**\n * Counts the ticks that a route loses to refused actions (e.g. a shut door).\n * Usage: bun x.ts\n */\nconst a = 1;')).toBe('Counts the ticks that a route loses to refused actions (e.g. a shut door).');
 // A short first sentence takes the sentences after it.
 expect(headerSentence('// Proof entry only. Runs scripts/x.ts on a preset account.\n// It checks the bank.\nimport a from "b";')).toBe('Proof entry only. Runs scripts/x.ts on a preset account. It checks the bank.');
 // A usage line, a command line and a list end the description.
 expect(headerSentence('// 3-tick fishing benchmark. Usage: bun scripts/measure/fish-3tick.ts <bot>\n// Preset shrimp_3tick.\nimport a from "b";')).toBe('3-tick fishing benchmark.');
 expect(headerSentence('// The catalog of all categories:\n//   1. skiller\n//   2. fighter\nimport a from "b";')).toBe('The catalog of all categories');
 // A proof, measurement or licence sentence is not the description.
 expect(headerSentence('// PROOF 3/3 on practice: 937 ticks.\n// Scorpion Catcher from preset quest_scorpion, beside Thormac at the top of the tower.\nimport a from "b";')).toBe('Scorpion Catcher from preset quest_scorpion, beside Thormac at the top of the tower.');
 // No header: code first, a checker switch, or one comment line directly above a declaration.
 expect(headerSentence('import a from "b";\n// A comment after the imports.\n')).toBe('');
 expect(headerSentence('// @ts-nocheck\nimport a from "b";')).toBe('');
 expect(headerSentence('// Keep the cap of each type.\nexport function f(){}')).toBe('');
 expect(headerSentence('// Bridge for the spell action.\n// It mirrors the item action.\nexport function f(){}')).toBe('Bridge for the spell action. It mirrors the item action.');
});

test('the index reads a tree that is not this repository: sources in order, groups by folder', () => {
 const dir = mkdtempSync(join(tmpdir(), 'script-index-'));
 const put = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), {recursive: true}); writeFileSync(join(dir, path), text); };
 try {
  put('scripts/aio.ts', '// The dispatcher of the catalog routes for every category.\n');
  put('scripts/plain.ts', 'export const a = 1;\n');
  put('scripts/headed.ts', '// Prints the position of one account on the practice server.\nimport {a} from "./plain";\nexport const b = a;\n');
  put('scripts/skip.test.ts', '// A test file.\n');
  put('scripts/measure/bench.ts', 'export const a = 1;\n');
  put('packages/tool/src/cli.ts', 'export const a = 1;\nif (import.meta.main) console.log(a);\n');
  put('packages/tool/src/lib.ts', '// import.meta.main is named only in this comment.\nexport const a = 1;\n');
  const lines = scriptIndex(dir, {'scripts/plain.ts': 'Exports a, the number one, for the test tree.'});
  const line = (path: string) => lines.find(l => l.path === path);
  expect(lines.map(l => l.path).sort()).toEqual(['packages/tool/src/cli.ts', 'scripts/aio.ts', 'scripts/headed.ts', 'scripts/measure/bench.ts', 'scripts/plain.ts']);
  expect(line('scripts/plain.ts')).toMatchObject({group: 'tools', source: 'table'});
  expect(line('scripts/headed.ts')).toMatchObject({group: 'tools', source: 'header', description: 'Prints the position of one account on the practice server.'});
  expect(line('scripts/aio.ts')).toMatchObject({group: 'helpers', source: 'header'});
  expect(line('scripts/measure/bench.ts')).toMatchObject({group: 'measure', source: 'none'});
  expect(line('packages/tool/src/cli.ts')).toMatchObject({group: 'packages', source: 'none'});
 } finally {
  rmSync(dir, {recursive: true, force: true});
 }
});
