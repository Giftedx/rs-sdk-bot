// The AIO catalog (scripts/aio.ts) is the index of the game scripts. This test fails when a script under scripts/,
// scripts/generated/ or scripts/pk-live/ is reached from no catalog route and is not in OUTSIDE_CATALOG with its cause.
// A script is reached when a route names it, or when a reached script imports it or names its path in code.
import {test,expect} from 'bun:test';
import {readdirSync,readFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {aioCatalog} from './aio';
import {listGeneratedQuestScripts} from './aio-quester';

const root = resolve(import.meta.dir, '..');
const FOLDERS = ['scripts', 'scripts/generated', 'scripts/pk-live'] as const;

// Scripts that are not game work a route can start. Each entry gives the cause. A new game script gets a route in
// its aio-<category>.ts file and not an entry here.
export const OUTSIDE_CATALOG: Readonly<Record<string, string>> = {
 'scripts/autopilot.ts': 'fleet control: writes the planner jobs into swarm.json',
 'scripts/check-no-diary.ts': 'developer tool: checks the docs for history wording',
 'scripts/check-pin.ts': 'developer tool: checks the commit of vendor/rs-sdk',
 'scripts/ci-gate.ts': 'developer tool: runs the CI checks on this PC',
 'scripts/claim-account.ts': 'fleet control: registers a new account name',
 'scripts/cloud-recover.ts': 'fleet control: recovers held live sessions',
 'scripts/courier-route-evidence.ts': 'evidence check for one recorded courier return; it starts no game work',
 'scripts/fleet-agent.ts': 'fleet control: syncs fleet data and runs this side of each order',
 'scripts/fleet-inspect.ts': 'fleet tool: refreshes the saved state of one account',
 'scripts/fleet-order.ts': 'fleet control: places a transfer order between two sides',
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
 'scripts/market-snapshot.ts': 'report: fetches the supply prices',
 'scripts/microbot-action-replay.ts': 'replays a recorded action list; it needs a recording file and a bindings file, and no route supplies them',
 'scripts/microbot-catalog.ts': 'report: lists the Microbot plugins and the port decisions',
 'scripts/monitor.ts': 'fleet control: the watchdog of the machine and the swarm',
 'scripts/pk-live/walk-edge.ts': 'hand tool: walks one account to Edgeville bank with a long route budget',
 'scripts/pk-sim.ts': 'offline fight simulator; it starts no game work',
 'scripts/preparation-report.ts': 'report: owned gear and supplies against the inputs of the workers',
 'scripts/preparation-route-state.ts': 'helper of scripts/preparation-report.ts',
 'scripts/provision-readiness.ts': 'fleet control: checks the crew of an account provision',
 'scripts/route-audit-components.ts': 'helper of scripts/route-audit.ts',
 'scripts/route-audit.ts': 'developer tool: offline navigation audit',
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

const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

export function unreachedScripts(): string[] {
 const files = FOLDERS.flatMap(folder => readdirSync(join(root, folder)).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => `${folder}/${f}`));
 const known = new Set(files);
 const links = (file: string) => {
  const text = code(readFileSync(join(root, file), 'utf8')), out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
   const target = relative(root, resolve(root, dirname(file), m[1]!)).replace(/\\/g, '/');
   out.push(target.endsWith('.ts') ? target : `${target}.ts`);
  }
  for (const m of text.matchAll(/scripts\/[A-Za-z0-9_\-/]+\.ts/g)) out.push(m[0]);
  return out.filter(f => known.has(f));
 };
 const c = aioCatalog().categories;
 const routes = [...c.skiller.routes, ...c.fighter.profiles, ...c.boss.encounters, ...c.pvp.modes, ...c.quester.modes, ...c.market.modes, ...c.logistics.roles].map(r => r.script);
 const reached = new Set<string>(), queue = ['scripts/aio.ts', ...routes, ...listGeneratedQuestScripts()];
 while (queue.length) {
  const file = queue.pop()!;
  if (reached.has(file) || !known.has(file)) continue;
  reached.add(file);
  queue.push(...links(file));
 }
 return files.filter(f => !reached.has(f)).sort();
}

test('every script is reached from an AIO route, or is listed outside the catalog with its cause', () => {
 const unreached = unreachedScripts();
 // A script with no route and no entry: give it a route, or add it to OUTSIDE_CATALOG with the cause.
 expect(unreached.filter(f => !(f in OUTSIDE_CATALOG))).toEqual([]);
 // An entry for a script that a route reaches, or that is gone: delete the entry.
 expect(Object.keys(OUTSIDE_CATALOG).filter(f => !unreached.includes(f))).toEqual([]);
 for (const cause of Object.values(OUTSIDE_CATALOG)) expect(cause.length).toBeGreaterThan(10);
});
