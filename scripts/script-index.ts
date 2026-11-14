// The index of every script: one line for each file under scripts/ and for each command file under packages/, with
// its group and what it does. Usage:
//   bun scripts/script-index.ts [word ...]   lines that hold every word (no word: all lines)
//   bun scripts/script-index.ts --json       the records, with the source of each description
// No worker imports this file or scripts/script-descriptions.ts, so an edit to either changes no worker release
// (packages/core/src/worker-release.ts).
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {aioCatalog,AIO_CATEGORIES,type AioCategory} from './aio';
import {listGeneratedQuestScripts} from './aio-quester';
import {SCRIPT_DESCRIPTIONS} from './script-descriptions';

const repo = resolve(import.meta.dir, '..');

// Scripts that are not game work a route can start. Each entry gives the cause. A new game script gets a route in
// its aio-<category>.ts file and not an entry here.
export const OUTSIDE_CATALOG: Readonly<Record<string, string>> = {
 'scripts/autopilot.ts': 'fleet control: writes the planner jobs into swarm.json',
 'scripts/check-no-diary.ts': 'developer tool: checks the docs for history wording',
 'scripts/check-pin.ts': 'developer tool: checks the commit of vendor/rs-sdk',
 'scripts/ci-gate.ts': 'developer tool: runs the CI checks on this PC',
 'scripts/claim-account.ts': 'fleet control: registers a new account name',
 'scripts/cloud-recover.ts': 'fleet control: recovers held live sessions',
 'scripts/cloud-launch.ts': 'fleet control: starts Claude Code and Codex cloud sessions for silent cloud sides',
 'scripts/cloud-side.ts': 'fleet control: sets up a cloud side and keeps its swarm, fleet agent and planner running',
 'scripts/fleet-vault.ts': 'fleet control: seals and restores account credentials in the fleet vault',
 'scripts/firemaking-line.ts': 'multi-account worker: one runner and its log-dropping helpers, named on the command line; bench case extra:firemaking-line',
 'scripts/courier-route-evidence.ts': 'evidence check for one recorded courier return; it starts no game work',
 'scripts/fleet-agent.ts': 'fleet control: syncs fleet data and runs this side of each order',
 'scripts/fleet-inspect.ts': 'fleet tool: refreshes the saved state of one account',
 'scripts/fleet-order.ts': 'fleet control: places a transfer order between two sides',
 'scripts/route-stage.ts': 'fleet control: places the fleet orders of one route step at the bank the route account visits next',
 'scripts/fleet-owner-claim.ts': 'fleet control: reserves an account name for a side',
 'scripts/fleet-sync.ts': 'fleet control: shares orders, receipts and snapshots between the sides',
 'scripts/fleet.ts': 'fleet control: job templates and account credentials',
 'scripts/generated/boatardy.ts': 'practice measurement from a preset; scripts/generated/thieving60.ts holds a copy of its route',
 'scripts/generated/cakestall.ts': 'practice measurement of 300 ticks from a preset; an example of packages/router/src/author-cli.ts',
 'scripts/generated/copper5.ts': 'practice measurement from a preset; an example of packages/router/src/author-cli.ts',
 'scripts/generated/gecourier.ts': 'practice measurement from a preset; scripts/foodcourier.ts holds a copy of its route',
 'scripts/generated/thieve300.ts': 'practice measurement of 300 ticks from a preset; an example of packages/router/src/author-cli.ts',
 'scripts/generated/thieveguards.ts': 'practice measurement of 300 ticks from a preset; an example of packages/router/src/author-cli.ts',
 'scripts/generated/thieveknights.ts': 'practice measurement of 300 ticks from a preset; an example of packages/router/src/author-cli.ts',
 'scripts/goal-readiness.ts': 'report: the quest unlocks that an account holds',
 'scripts/haggis-gate.ts': 'the launch gate of the main account',
 'scripts/heavy-admission.ts': 'developer tool: sizes a test or type check job by the free memory',
 'scripts/learn.ts': 'report: reads the run records on disk',
 'scripts/loop-watch.ts': 'report: finds accounts that repeat work with no result',
 'scripts/market-cache.ts': 'fleet control: saves the live market prices for the loot job and the value guard; the fleet agent starts it',
 'scripts/market-snapshot.ts': 'report: fetches the supply prices',
 'scripts/microbot-action-replay.ts': 'replays a recorded action list; it needs a recording file and a bindings file, and no route supplies them',
 'scripts/microbot-catalog.ts': 'report: lists the Microbot plugins and the port decisions',
 'scripts/monitor.ts': 'fleet control: the watchdog of the machine and the swarm',
 'scripts/now.ts': 'developer tool: prints the state of this PC and the fleet on one screen; it changes nothing',
 'scripts/pk-live/walk-edge.ts': 'hand tool: walks one account to Edgeville bank with a long route budget',
 'scripts/pk-sim.ts': 'offline fight simulator; it starts no game work',
 'scripts/preparation-report.ts': 'report: owned gear and supplies against the inputs of the workers',
 'scripts/preparation-route-state.ts': 'helper of scripts/preparation-report.ts',
 'scripts/provision-readiness.ts': 'fleet control: checks the crew of an account provision',
 'scripts/route-audit-components.ts': 'helper of scripts/route-audit.ts',
 'scripts/route-audit.ts': 'developer tool: offline navigation audit',
 'scripts/script-descriptions.ts': 'helper of scripts/script-index.ts',
 'scripts/script-index.ts': 'developer tool: prints one line for every script, with its group and what it does',
 'scripts/serve-rsworld.ts': 'developer tool: serves the rs-world viewer',
 'scripts/session-check.ts': 'fleet control: the login and logout check of a session recovery',
 'scripts/shot.ts': 'developer tool: takes a screenshot of a page',
 'scripts/swarm.ts': 'fleet control: the controller that starts each live job',
 'scripts/test-shards.ts': 'developer tool: runs the test files in several processes',
 'scripts/tick-waste.ts': 'report: idle and walking ticks for each script family',
 'scripts/typecheck-narrow.ts': 'developer tool: type-checks the changed files',
 'scripts/where.ts': 'practice tool: prints the position of a bot (packages/practice/src/prove.ts)',
 'scripts/worktree-setup.ts': 'developer tool: prepares a new git worktree',
};

// The folders that the reach rule covers (scripts/aio-reach.test.ts).
export const CATALOG_FOLDERS = ['scripts', 'scripts/generated', 'scripts/pk-live'] as const;

const posix = (p: string) => p.replace(/\\/g, '/');
const isScript = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

function tree(root: string, folder: string): string[] {
 if (!existsSync(join(root, folder))) return [];
 return readdirSync(join(root, folder), {withFileTypes: true}).flatMap(e =>
  e.name === 'node_modules' ? [] : e.isDirectory() ? tree(root, `${folder}/${e.name}`) : isScript(e.name) ? [`${folder}/${e.name}`] : []);
}

export interface AioRoute {
 category: AioCategory;
 name: string;
 script: string;
 description: string;
}

export function aioRoutes(): AioRoute[] {
 const c = aioCatalog().categories;
 return [
  ...c.skiller.routes.map(r => ({category: 'skiller' as const, name: `${r.skill}:${r.method}`, script: r.script, description: r.description})),
  ...c.fighter.profiles.map(r => ({category: 'fighter' as const, name: r.target, script: r.script, description: r.description})),
  ...c.boss.encounters.map(r => ({category: 'boss' as const, name: r.boss, script: r.script, description: r.description})),
  ...c.pvp.modes.map(r => ({category: 'pvp' as const, name: r.mode, script: r.script, description: r.description})),
  ...c.quester.modes.map(r => ({category: 'quester' as const, name: r.mode, script: r.script, description: r.description})),
  ...c.market.modes.map(r => ({category: 'market' as const, name: r.mode, script: r.script, description: r.description})),
  ...c.logistics.roles.map(r => ({category: 'logistics' as const, name: r.role, script: r.script, description: r.description})),
 ];
}

// The scripts in `folders` that a route reaches. A script is reached when a route names it, or when a reached script
// imports it or names its path in code.
export function reachedScripts(folders: readonly string[] = CATALOG_FOLDERS, root = repo): {files: string[]; reached: Set<string>} {
 const files = folders.flatMap(folder => readdirSync(join(root, folder)).filter(isScript).map(f => `${folder}/${f}`));
 const known = new Set(files);
 const links = (file: string) => {
  const text = code(readFileSync(join(root, file), 'utf8')), out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
   const target = posix(relative(root, resolve(root, dirname(file), m[1]!)));
   out.push(target.endsWith('.ts') ? target : `${target}.ts`);
  }
  for (const m of text.matchAll(/scripts\/[A-Za-z0-9_\-/]+\.ts/g)) out.push(m[0]);
  return out.filter(f => known.has(f));
 };
 const reached = new Set<string>(), queue = ['scripts/aio.ts', ...aioRoutes().map(r => r.script), ...listGeneratedQuestScripts(root)];
 while (queue.length) {
  const file = queue.pop()!;
  if (reached.has(file) || !known.has(file)) continue;
  reached.add(file);
  queue.push(...links(file));
 }
 return {files, reached};
}

export function unreachedScripts(root = repo): string[] {
 const {files, reached} = reachedScripts(CATALOG_FOLDERS, root);
 return files.filter(f => !reached.has(f)).sort();
}

const HEADER_MIN = 60, HEADER_MAX = 240;
// A sentence that records a proof, a measurement or a licence. The description starts after it.
const RECORD_SENTENCE = /^(?:PROOF|MEASURED|Behaviou?r source|BSD attribution)\b/;

function sentences(paragraph: string): string[] {
 const out: string[] = [];
 let start = 0;
 for (const m of paragraph.matchAll(/\.(?=\s)/g)) {
  const head = paragraph.slice(start, m.index);
  // Not an end: an abbreviation, a list number that starts the sentence, or a full stop inside an open double quote.
  if (/(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|cf)$/i.test(head) || /^\s*\d+$/.test(head) || (head.split('"').length - 1) % 2 === 1) continue;
  out.push(paragraph.slice(start, m.index + 1).trim());
  start = m.index + 1;
 }
 const rest = paragraph.slice(start).trim();
 return rest ? [...out, rest] : out;
}

// The description that the header comment of a file gives, or '' when the file has no header comment. It is the
// first sentence of the comment that starts the file; when that sentence is shorter than HEADER_MIN characters, the
// sentences after it in the same paragraph follow, up to HEADER_MAX characters. A usage line, a command line, a list
// and an empty comment line end the paragraph. Not a header: a line that switches a checker off or on, and one
// comment line directly above a declaration (it documents that declaration).
export function headerSentence(source: string): string {
 const lines = source.replace(/^﻿/, '').split(/\r?\n/);
 let i = 0, comments = 0, block = false, open = true;
 if (lines[0]?.startsWith('#!')) i++;
 const words: string[] = [];
 for (; i < lines.length; i++) {
  const raw = lines[i]!.trim();
  let text: string;
  if (block) {
   const end = raw.indexOf('*/');
   text = (end < 0 ? raw : raw.slice(0, end)).replace(/^\*+\s?/, '');
   if (end >= 0) block = false;
  } else if (raw.startsWith('//')) text = raw.replace(/^\/\/+\s?/, '');
  else if (raw.startsWith('/*')) {
   const end = raw.indexOf('*/', 2);
   text = (end < 0 ? raw.slice(2) : raw.slice(2, end)).replace(/^\*+\s?/, '');
   block = end < 0;
  } else if (!raw && !comments) continue;
  else break;
  text = text.trim();
  if (/^(?:@ts-|eslint-|biome-|prettier-|istanbul |c8 )/.test(text)) continue;
  comments++;
  if (!open) continue;
  const usage = /^(?:usage|run|example|examples|env)\b[^.:]{0,25}:|\busage:\s/i.exec(text);
  if (!text || /^(?:\d+[.)]|[-*])\s/.test(text) || /^(?:bun|[A-Z_]+=\S+) /.test(text) || usage?.index === 0) {
   if (words.length) open = false;
   continue;
  }
  if (usage) {
   words.push(text.slice(0, usage.index));
   open = false;
  } else words.push(text);
 }
 const next = (lines[i] ?? '').trim();
 if (comments === 1 && next && !/^(?:import\b|export\s*(?:\*|\{|type\s*\{)|['"]use )/.test(next)) return '';
 let parts = sentences(words.join(' ').replace(/\s+/g, ' ').trim());
 while (parts.length > 1 && RECORD_SENTENCE.test(parts[0]!)) parts = parts.slice(1);
 let out = parts[0] ?? '';
 for (const s of parts.slice(1)) {
  if (out.length >= HEADER_MIN || out.length + 1 + s.length > HEADER_MAX) break;
  out += ` ${s}`;
 }
 return out.replace(/:$/, '');
}

export type ScriptGroup = AioCategory | 'helpers' | 'tools' | 'quests' | 'measure' | 'packages';
export const SCRIPT_GROUPS: readonly ScriptGroup[] = [...AIO_CATEGORIES, 'helpers', 'tools', 'quests', 'measure', 'packages'];
export const SCRIPT_GROUP_TITLES: Readonly<Record<ScriptGroup, string>> = {
 skiller: 'the skiller entry and the scripts that its routes start',
 fighter: 'the fighter entry and the scripts that its routes start',
 boss: 'the boss entry and the scripts that its routes start',
 pvp: 'the pvp entry and the scripts that its routes start',
 quester: 'the quester entry and the scripts that its routes start',
 market: 'the market entry and the scripts that its routes start',
 logistics: 'the logistics entry and the scripts that its routes start',
 helpers: 'helpers that a route reaches',
 tools: 'tools, reports and fleet control',
 quests: 'generated quest scripts (quester sweep, order and chain run them)',
 measure: 'practice measurements (scripts/measure)',
 packages: 'commands under packages/',
};

export type DescriptionSource = 'route' | 'outside' | 'header' | 'table' | 'none';
export interface ScriptLine {
 path: string;
 group: ScriptGroup;
 source: DescriptionSource;
 description: string;
}

// The command files under packages/: a file with `import.meta.main` in code under packages/<name>/src, and under
// packages/dashboard and packages/dashboard/tools.
export function packageCommands(root = repo): string[] {
 const packages = readdirSync(join(root, 'packages'), {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name);
 const flat = (folder: string) => existsSync(join(root, folder)) ? readdirSync(join(root, folder)).filter(isScript).map(f => `${folder}/${f}`) : [];
 const files = [...packages.flatMap(p => tree(root, `packages/${p}/src`)), ...flat('packages/dashboard'), ...flat('packages/dashboard/tools')];
 return files.filter(f => code(readFileSync(join(root, f), 'utf8')).includes('import.meta.main')).sort();
}

export function scriptIndex(root = repo, table: Readonly<Record<string, string>> = SCRIPT_DESCRIPTIONS): ScriptLine[] {
 const routes = aioRoutes(), quests = new Set(listGeneratedQuestScripts(root));
 // The reach rule covers three folders. The index also follows the imports into the other script folders.
 const folders = [...new Set(tree(root, 'scripts').map(f => dirname(f)))].filter(f => f !== 'scripts/measure');
 const {reached} = reachedScripts(folders, root);
 const line = (path: string, packaged: boolean): ScriptLine => {
  const mine = routes.filter(r => r.script === path);
  const category = /^scripts\/aio-([a-z]+)\.ts$/.exec(path)?.[1] as AioCategory | undefined;
  const group: ScriptGroup = packaged ? 'packages'
   : mine.length ? mine[0]!.category
   : category && AIO_CATEGORIES.includes(category) ? category
   : path.startsWith('scripts/measure/') ? 'measure'
   : quests.has(path) ? 'quests'
   : reached.has(path) && !(path in OUTSIDE_CATALOG) ? 'helpers'
   : 'tools';
  const header = headerSentence(readFileSync(join(root, path), 'utf8'));
  if (mine.length) return {path, group, source: 'route', description: mine.map(r => `${r.category} ${r.name}: ${r.description}`).join('; ')};
  if (path in OUTSIDE_CATALOG) return {path, group, source: 'outside', description: OUTSIDE_CATALOG[path]!};
  if (header) return {path, group, source: 'header', description: header};
  if (path in table) return {path, group, source: 'table', description: table[path]!};
  return {path, group, source: 'none', description: ''};
 };
 const lines = [...tree(root, 'scripts').map(f => line(f, false)), ...packageCommands(root).map(f => line(f, true))];
 const order = (l: ScriptLine) => SCRIPT_GROUPS.indexOf(l.group);
 return lines.sort((a, b) => order(a) - order(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The table entries to delete: the file is gone, or a source that comes before the table describes it.
export function staleDescriptions(root = repo, table: Readonly<Record<string, string>> = SCRIPT_DESCRIPTIONS): {path: string; cause: string}[] {
 const lines = new Map(scriptIndex(root, table).map(l => [l.path, l]));
 const causes: Record<DescriptionSource, string> = {route: 'a route describes it', outside: 'OUTSIDE_CATALOG describes it', header: 'its header comment describes it', table: '', none: ''};
 return Object.keys(table).flatMap(path => {
  const l = lines.get(path);
  if (!l) return [{path, cause: existsSync(join(root, path)) ? 'the index does not list the file' : 'the file is gone'}];
  return l.source === 'table' ? [] : [{path, cause: causes[l.source]}];
 });
}

// Plain text: a title line for each group, then one line a script with its group, its path and its description.
export function formatScriptIndex(lines: readonly ScriptLine[]): string {
 const out: string[] = [];
 for (const group of SCRIPT_GROUPS) {
  const rows = lines.filter(l => l.group === group);
  if (!rows.length) continue;
  out.push(`# ${group}: ${SCRIPT_GROUP_TITLES[group]} (${rows.length})`);
  for (const l of rows) out.push(`${group}\t${l.path}\t${l.description || '(no description)'}`);
 }
 return out.join('\n');
}

export function sourceCounts(lines: readonly ScriptLine[]): Record<DescriptionSource, number> {
 const counts: Record<DescriptionSource, number> = {route: 0, outside: 0, header: 0, table: 0, none: 0};
 for (const l of lines) counts[l.source]++;
 return counts;
}

if (import.meta.main) {
 const args = process.argv.slice(2), all = scriptIndex();
 if (args[0] === '--json') console.log(JSON.stringify(all, null, 1));
 else {
  const words = args.map(a => a.toLowerCase());
  const lines = all.filter(l => words.every(w => `${l.group} ${l.path} ${l.description}`.toLowerCase().includes(w)));
  console.log(formatScriptIndex(lines));
  const n = sourceCounts(lines);
  console.log(`# ${lines.length} of ${all.length} scripts; description from a route ${n.route}, the outside-catalog cause ${n.outside}, a header comment ${n.header}, the table ${n.table}, none ${n.none}`);
 }
}
