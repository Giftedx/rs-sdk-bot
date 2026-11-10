// AIO Quester ("Quest Helper & Clue Solver"): unified entry for all 68 quests, quest sweeps, quest chains, item staging, and clue scrolls.
// Usage:
//   bun scripts/aio-quester.ts <account> <mode|quest-slug> [arg ...] [KEY=value ...]
import {existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runDirectChild} from '../packages/core/src/run-child';
import {parseStep,type Step} from '../packages/core/src/chain-step';
import {QUEST_NAMES} from './quest-chain';
import {QUEST_ORDERS,questSpec,questPreflight,questSavedChecks} from './quest-order';
import {presetFor} from './quest-sweep';
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
}

export const QUESTER_MODES: readonly QuesterModeSpec[] = [
 {mode:'sweep',script:'scripts/quest-sweep.ts',description:'Stage required items from nearest bank, walk to start tile, and complete quest'},
 {mode:'order',script:'scripts/quest-order.ts',description:'Save-verified finite quest order (hetty, cook) with preflight and post-quest bank reconciliation'},
 {mode:'chain',script:'scripts/quest-chain.ts',description:'Run a sequence of quests in order on one account'},
 {mode:'items',script:'scripts/quest-items-order.ts',description:'Acquire and bank prerequisite items for upcoming quests'},
 {mode:'cook-job',script:'scripts/quest-cook-job.ts',description:'Self-contained Cook\'s Assistant acquisition + completion'},
 {mode:'runemysteries-route',script:'scripts/rune-mysteries-route.ts',description:'Self-contained Rune Mysteries route'},
 {mode:'totem-route',script:'scripts/tribal-totem-route.ts',description:'Self-contained Tribal Totem route'},
 {mode:'zanaris-plan',script:'scripts/quest-zanaris-plan.ts',description:'Lost City / Zanaris quest preparation and execution'},
 {mode:'ghost-exit',script:'scripts/ghost-basement-exit.ts',description:'Recover from Wizards\' Tower basement with/without Restless Ghost skull'},
 {mode:'ghost-skull',script:'scripts/ghost-skull-entry.ts',description:'Restless Ghost basement skull entry and escape'},
 {mode:'seaslug-leave',script:'scripts/seaslug-leave.ts',description:'Return from Fishing Platform after Sea Slug'},
 {mode:'mm-puzzle',script:'scripts/generated/mm-puzzle.ts',description:'Monkey Madness sliding puzzle solver'},
 {mode:'hero-owned',script:'scripts/generated/quest-hero-owned.ts',description:'Two-account owned Heroes\' Quest runner'},
 {mode:'legends-owned',script:'scripts/generated/quest-legends-owned.ts',description:'Owned-account Legends\' Quest runner'},
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

export function assessQuestReadiness(questInput: string, ownedItems: Readonly<Record<number, number>>, completedQuests: ReadonlySet<string> = new Set()) {
 const slug = questInput.toLowerCase().replace(/^quest[-_]/, '').replace(/\.ts$/, '');
 const script = resolveQuestScript(slug);
 if (completedQuests.has(slug)) {
  return { slug, script, alreadyComplete: true, ready: false, missingItems: {} as Record<number, number>, startTile: null };
 }
 try {
  const preset = presetFor(slug);
  const missingItems: Record<number, number> = {};
  for (const item of preset.inventory ?? []) {
   const have = ownedItems[item.id] ?? 0;
   if (have < item.count) missingItems[item.id] = item.count - have;
  }
  if (preset.coins && (ownedItems[995] ?? 0) < preset.coins) {
   missingItems[995] = preset.coins - (ownedItems[995] ?? 0);
  }
  return {
   slug,
   script,
   alreadyComplete: false,
   ready: Object.keys(missingItems).length === 0,
   missingItems,
   startTile: preset.position,
  };
 } catch {
  return { slug, script, alreadyComplete: false, ready: true, missingItems: {} as Record<number, number>, startTile: null };
 }
}

// Scan a list of quest slugs (defaults to QUEST_NAMES) against an account's owned items and completed quests,
// partitioning into quests ready to sweep immediately vs quests sorted by fewest missing item types.
export function prioritizeQuestsForAccount(
 ownedItems: Readonly<Record<number, number>>,
 completedQuests: ReadonlySet<string> = new Set(),
 candidates: readonly string[] = Object.keys(QUEST_NAMES),
) {
 const evaluations = candidates
  .map(slug => assessQuestReadiness(slug, ownedItems, completedQuests))
  .filter(e => !e.alreadyComplete);
 const readyNow = evaluations
  .filter(e => e.ready)
  .map(e => ({ ...e, step: resolveQuesterStep('sweep', [e.slug]) }));
 const needsItems = evaluations
  .filter(e => !e.ready)
  .sort((a, b) => Object.keys(a.missingItems).length - Object.keys(b.missingItems).length);
 return { readyNow, needsItems };
}

export function resolveQuesterStep(modeOrQuest: string, rest: readonly string[] = [], root = resolve(import.meta.dir, '..')): Step {
 const key = modeOrQuest.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
 const modeSpec = QUESTER_MODES.find(m => m.mode === key);
 if (modeSpec) {
  return parseStep([modeSpec.script, ...rest].join(' '));
 }
 if (key === 'quest' && rest[0]) {
  const script = resolveQuestScript(rest[0], root);
  return parseStep([script, ...rest.slice(1)].join(' '));
 }
 const script = resolveQuestScript(key, root);
 return parseStep([script, ...rest].join(' '));
}

export async function runAioQuester(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-quester requires account');
 const [first, ...rest] = args;
 if (!first) throw Error('aio-quester requires <mode|quest>');
 const step = resolveQuesterStep(first, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
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
