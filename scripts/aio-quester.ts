// AIO Quester ("Quest Helper & Clue Solver"): unified entry for all 68 quests, quest sweeps, quest chains, item staging, and clue scrolls.
// Usage:
//   bun scripts/aio-quester.ts <account> <mode|quest-slug> [arg ...] [KEY=value ...]
import {existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {resolveRouteStep} from './aio-route-step';
import {QUEST_NAMES,questShortfall} from './quest-chain';
import {QUEST_ORDERS,questSpec,questPreflight,questSavedChecks} from './quest-order';
import {presetFor,needs,wornKitPlan} from './quest-sweep';
import {walkQuestCorridor} from './quest-walk';
import {retainedGhostSkull,retainedGhostBankSkull,leaveGhostBasement,inGhostBasement} from './ghost-basement-exit';

export {
 QUEST_NAMES,QUEST_ORDERS,questSpec,questPreflight,questSavedChecks,
 presetFor,walkQuestCorridor,
 retainedGhostSkull,retainedGhostBankSkull,leaveGhostBasement,inGhostBasement,
};

export interface QuesterModeSpec {
 mode: string;
 script: string;
 description: string;
 // The worker takes an order file that names its accounts as its first argument, and no account argument.
 orderFile?: true;
}

export const QUESTER_MODES: readonly QuesterModeSpec[] = [
 {mode:'sweep',script:'scripts/quest-sweep.ts',description:'Stage required items from nearest bank, walk to start tile, and complete quest'},
 {mode:'order',script:'scripts/quest-order.ts',description:'Save-verified finite quest order (hetty, cook) with preflight and post-quest bank reconciliation'},
 {mode:'chain',script:'scripts/quest-chain.ts',description:'Run a sequence of quests in order on one account'},
 {mode:'items',script:'scripts/quest-items-order.ts',description:'Acquire and bank prerequisite items for upcoming quests'},
 {mode:'cook-job',script:'scripts/quest-cook-job.ts',description:'Self-contained Cook\'s Assistant acquisition + completion'},
 {mode:'seaslug-leave',script:'scripts/seaslug-leave.ts',description:'Return from Fishing Platform after Sea Slug'},
 {mode:'dusty-key',script:'scripts/dusty-key.ts',description:'Get the dusty key from Velrak (the Jailer, his cell, the dialogue) for the inner gate of Taverley dungeon'},
 {mode:'hero-owned',script:'scripts/generated/quest-hero-owned.ts',orderFile:true,description:'Two-account owned Heroes\' Quest runner'},
 {mode:'legends-owned',script:'scripts/generated/quest-legends-owned.ts',orderFile:true,description:'Owned-account Legends\' Quest runner'},
 {mode:'tbwt-owned',script:'scripts/generated/quest-tbwt-owned.ts',description:'Owned-account Tai Bwo Wannai Trio runner'},
 {mode:'watchtower-owned',script:'scripts/generated/quest-itwatchtower-owned.ts',description:'Owned-account Watchtower runner'},
 {mode:'clue',script:'scripts/microbot-c-clues.ts',description:'Solve coordinate, anagram, map, and simple clue scroll steps'},
 {mode:'clue-puzzle',script:'scripts/microbot-c-clue-puzzle.ts',description:'Solve sliding puzzle boxes for hard clue scrolls'},
 {mode:'clue-guardian',script:'scripts/microbot-c-clue-guardian.ts',description:'Defeat Saradomin/Zamorak wizard clue guardians'},
];

const QUEST_SCRIPT_ALIAS: Readonly<Record<string, string>> = {
 romeojuliet: 'scripts/generated/quest-rj.ts',
 rj: 'scripts/generated/quest-rj.ts',
 scorpcatcher: 'scripts/generated/quest-scorpion.ts',
 scorpion: 'scripts/generated/quest-scorpion.ts',
 blackarmgang: 'scripts/generated/quest-arrav.ts',
 arrav: 'scripts/generated/quest-arrav.ts',
 arthur: 'scripts/generated/quest-merlin.ts',
 merlin: 'scripts/generated/quest-merlin.ts',
 mcannon: 'scripts/generated/dwarfcannon.ts',
 dwarfcannon: 'scripts/generated/dwarfcannon.ts',
 itexam: 'scripts/generated/quest-dig.ts',
 dig: 'scripts/generated/quest-dig.ts',
 waterfall: 'scripts/generated/waterfall.ts',
 elemental_workshop: 'scripts/generated/quest-elemental.ts',
 elemental: 'scripts/generated/quest-elemental.ts',
};

export function listGeneratedQuestScripts(root = resolve(import.meta.dir, '..')): string[] {
 const dir = join(root, 'scripts', 'generated');
 if (!existsSync(dir)) return [];
 return readdirSync(dir)
  .filter(f => (f.startsWith('quest-') || f === 'dwarfcannon.ts' || f === 'waterfall.ts') && f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'quest-lib.ts')
  .map(f => `scripts/generated/${f}`)
  .sort();
}

export function resolveQuestScript(questInput: string, root = resolve(import.meta.dir, '..')): string {
 const clean = questInput.toLowerCase().replace(/^quest[-_]/, '').replace(/\.ts$/, '');
 if (QUEST_SCRIPT_ALIAS[clean]) return QUEST_SCRIPT_ALIAS[clean]!;
 const collapsed = clean.replace(/_/g, '');
 if (QUEST_SCRIPT_ALIAS[collapsed]) return QUEST_SCRIPT_ALIAS[collapsed]!;
 const candidate = `scripts/generated/quest-${collapsed}.ts`;
 if (existsSync(join(root, candidate))) return candidate;
 throw Error(`aio-quester: unknown quest "${questInput}"`);
}

const questKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// Explicit gates from pinned content: king_arthur.rs2:46-49, quest_upass.rs2:80-84,
// regicide_kings_messenger.rs2:1-3 and druidspirit_journal.rs2:23-35.
const QUEST_PREREQUISITES: Readonly<Record<string, readonly string[]>> = {
 grail: ['merlin'], upass: ['biohazard'], regicide: ['upass'], druidspirit: ['priest', 'priestperil'],
};

export function assessQuestReadiness(questInput: string, ownedItems: Readonly<Record<number, number>>, completedQuests: ReadonlySet<string> = new Set(), skills?: Readonly<Record<string, number>>) {
 const script = resolveQuestScript(questInput);
 const slug = script.split('/').at(-1)!.replace(/^quest-/, '').replace(/\.ts$/, '');
 const completed = new Set([...completedQuests].flatMap(name => {
  try { return [questKey(name), questKey(resolveQuestScript(name).split('/').at(-1)!.replace(/^quest-/, '').replace(/\.ts$/, ''))]; }
  catch { return [questKey(name)]; }
 }));
 const isComplete = (q: string) => completed.has(questKey(q)) || !!QUEST_NAMES[q] && completed.has(questKey(QUEST_NAMES[q]!));
 const blockers: string[] = [];
 if (isComplete(slug) || completed.has(questKey(questInput))) {
  return { slug, script, alreadyComplete: true, ready: false, missingItems: {} as Record<number, number>, blockers, startTile: null };
 }
 const observedSkills = skills && Object.entries(skills).filter(([, level]) => Number.isFinite(level) && level >= 1).map(([name, level]) => ({ name, level }));
 blockers.push(...questShortfall(slug, observedSkills).map(short => `skill ${short}`));
 for (const q of QUEST_PREREQUISITES[slug] ?? []) if (!isComplete(q)) blockers.push(`quest ${QUEST_NAMES[q] ?? q} incomplete or unknown`);
 if (slug === 'hero') blockers.push('Heroes requires an explicit owned pair order');
 try {
  const preset = presetFor(slug);
  const missingItems: Record<number, number> = {};
  // Share the sweep's required pack and worn kit; duplicate preset rows are summed,
  // while optional food and walking teleports do not block an otherwise ready quest.
  const required = wornKitPlan(slug, needs(preset, false, slug), [], [], []).need;
  for (const [id, count] of required) {
   const have = ownedItems[id] ?? 0;
   if (have < count) missingItems[id] = count - have;
  }
  return {
   slug,
   script,
   alreadyComplete: false,
   ready: blockers.length === 0 && Object.keys(missingItems).length === 0,
   missingItems,
   blockers,
   startTile: preset.position,
  };
 } catch {
  blockers.push('quest sweep preparation unavailable');
  return { slug, script, alreadyComplete: false, ready: false, missingItems: {} as Record<number, number>, blockers, startTile: null };
 }
}

// Scan a list of quest slugs (defaults to QUEST_NAMES) against an account's owned items and completed quests,
// partitioning into quests ready to sweep immediately vs quests sorted by fewest missing item types.
export function prioritizeQuestsForAccount(
 ownedItems: Readonly<Record<number, number>>,
 completedQuests: ReadonlySet<string> = new Set(),
 candidates: readonly string[] = Object.keys(QUEST_NAMES),
 skills?: Readonly<Record<string, number>>,
) {
 const evaluations = candidates
  .map(slug => assessQuestReadiness(slug, ownedItems, completedQuests, skills))
  .filter(e => !e.alreadyComplete);
 const readyNow = evaluations
  .filter(e => e.ready)
  .map(e => ({ ...e, step: resolveQuesterStep('sweep', [e.slug]) }));
 const needsItems = evaluations
  .filter(e => !e.ready && !e.blockers.length)
  .sort((a, b) => Object.keys(a.missingItems).length - Object.keys(b.missingItems).length);
 return { readyNow, needsItems, blocked: evaluations.filter(e => e.blockers.length > 0) };
}

export function resolveQuesterStep(modeOrQuest: string, rest: readonly string[] = [], root = resolve(import.meta.dir, '..')): Step {
 const key = modeOrQuest.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
 const modeSpec = QUESTER_MODES.find(m => m.mode === key);
 if (modeSpec) {
  // Generic pipelines and hosts prepend the account to every Step. Keep order-file
  // workers behind this adapter, which removes that account before raw dispatch.
  if (modeSpec.orderFile) {
   const order = resolveRouteStep(modeSpec, rest);
   if (order.args.length !== 1) throw Error(`aio-quester ${key} requires <order.json>`);
   return {script: 'scripts/aio-quester.ts', args: [key, ...order.args], env: order.env};
  }
  return resolveRouteStep(modeSpec, rest);
 }
 if (key === 'quest' && rest[0]) {
  const script = resolveQuestScript(rest[0], root);
  return resolveRouteStep({script}, rest.slice(1));
 }
 const script = resolveQuestScript(key, root);
 return resolveRouteStep({script}, rest);
}

export async function runAioQuester(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-quester requires account');
 const [first, ...rest] = args;
 if (!first) throw Error('aio-quester requires <mode|quest>');
 const key = first.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
 const mode = QUESTER_MODES.find(m => m.mode === key);
 const resolved = resolveQuesterStep(first, rest);
 const step = mode?.orderFile ? resolveRouteStep(mode, rest) : resolved;
 const orderFile = mode?.orderFile;
 return runDirectChild(orderFile ? [step.script, ...step.args] : [step.script, account, ...step.args], { ...env, ...step.env });
}

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify({ modes: QUESTER_MODES, quests: listGeneratedQuestScripts() }, null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-quester.ts <account> <sweep|order|chain|items|clue|quest-slug> [args...]');
  process.exit(2);
 }
 const result = await runAioQuester(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
