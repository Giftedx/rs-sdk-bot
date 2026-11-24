import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Step } from '../../../core/src/chain-step';
import { QUEST_NAMES, questShortfall } from './chain';
import { QUEST_FINDS, PRAYER_POTIONS, needs, prayerCovers, presetFor, wornKitPlan } from './sweep-plan';
import { REPO_ROOT, type SweepApiOptions } from './types';

export interface QuesterModeSpec {
    mode: string;
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
    description: string;
    // The worker takes an order file that names its accounts as its first argument, and no account argument.
    orderFile?: true;
}

export const QUESTER_MODES: readonly QuesterModeSpec[] = [
    { mode: 'sweep', script: 'scripts/aio-quester.ts', defaultArgs: ['sweep'], description: 'Stage required items from nearest bank, walk to start tile, and complete quest' },
    { mode: 'order', script: 'scripts/aio-quester.ts', defaultArgs: ['order'], description: 'Save-verified finite quest order (hetty, cook) with preflight and post-quest bank reconciliation' },
    { mode: 'chain', script: 'scripts/aio-quester.ts', defaultArgs: ['chain'], description: 'Run a sequence of quests in order on one account' },
    { mode: 'items', script: 'scripts/aio-quester.ts', defaultArgs: ['items'], description: 'Acquire and bank prerequisite items for upcoming quests' },
    { mode: 'cook-job', script: 'scripts/aio-quester.ts', defaultArgs: ['cook-job'], description: "Self-contained Cook's Assistant acquisition + completion" },
    { mode: 'seaslug-leave', script: 'scripts/aio-quester.ts', defaultArgs: ['seaslug-leave'], description: 'Return from Fishing Platform after Sea Slug' },
    { mode: 'dusty-key', script: 'scripts/aio-quester.ts', defaultArgs: ['dusty-key'], description: 'Get the dusty key from Velrak (the Jailer, his cell, the dialogue) for the inner gate of Taverley dungeon' },
    { mode: 'hero-owned', script: 'scripts/generated/quest-hero-owned.ts', orderFile: true, description: "Two-account owned Heroes' Quest runner" },
    { mode: 'legends-owned', script: 'scripts/generated/quest-legends-owned.ts', orderFile: true, description: "Owned-account Legends' Quest runner" },
    { mode: 'tbwt-owned', script: 'scripts/generated/quest-tbwt-owned.ts', description: 'Owned-account Tai Bwo Wannai Trio runner' },
    { mode: 'watchtower-owned', script: 'scripts/generated/quest-itwatchtower-owned.ts', description: 'Owned-account Watchtower runner' },
    { mode: 'clue', script: 'scripts/aio-quester.ts', defaultArgs: ['clue'], description: 'Solve coordinate, anagram, map, and simple clue scroll steps' },
    { mode: 'clue-puzzle', script: 'scripts/aio-quester.ts', defaultArgs: ['clue-puzzle'], description: 'Solve sliding puzzle boxes for hard clue scrolls' },
    { mode: 'clue-guardian', script: 'scripts/aio-quester.ts', defaultArgs: ['clue-guardian'], description: 'Defeat Saradomin/Zamorak wizard clue guardians' },
];

export const QUEST_SCRIPT_ALIAS: Readonly<Record<string, string>> = {
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

export function listGeneratedQuestScripts(root = REPO_ROOT): string[] {
    const dir = join(root, 'scripts', 'generated');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => (f.startsWith('quest-') || f === 'dwarfcannon.ts' || f === 'waterfall.ts') && f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'quest-lib.ts')
        .map((f) => `scripts/generated/${f}`)
        .sort();
}

export function resolveQuestScript(questInput: string, root = REPO_ROOT): string {
    const clean = questInput.toLowerCase().replace(/^quest[-_]/, '').replace(/\.ts$/, '');
    if (QUEST_SCRIPT_ALIAS[clean]) return QUEST_SCRIPT_ALIAS[clean]!;
    const collapsed = clean.replace(/_/g, '');
    if (QUEST_SCRIPT_ALIAS[collapsed]) return QUEST_SCRIPT_ALIAS[collapsed]!;
    const candidate = `scripts/generated/quest-${collapsed}.ts`;
    if (existsSync(join(root, candidate))) return candidate;
    throw Error(`aio-quester: unknown quest "${questInput}"`);
}

export const questKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export const QUEST_PREREQUISITES: Readonly<Record<string, readonly string[]>> = {
    grail: ['merlin'],
    upass: ['biohazard'],
    regicide: ['upass'],
    druidspirit: ['priest', 'priestperil'],
    troll: ['death'],
    trolllove: ['death', 'troll'],
    eadgar: ['druid', 'troll'],
    zombiequeen: ['junglepotion'],
    mortton: ['priestperil'],
    routequest: ['druidspirit'],
    hauntedmine: ['priestperil'],
    tbwt: ['junglepotion'],
    biohazard: ['elena'],
    horror: ['barcrawl'],
    mm: ['grandtree', 'tree'],
    hero: ['zanaris', 'dragon', 'merlin', 'arrav'],
    misc: ['hero', 'viking'],
    legends: ['hero', 'upass', 'waterfall', 'zombiequeen', 'crest'],
};

export function assessQuestReadiness(
    questInput: string,
    ownedItems: Readonly<Record<number, number>>,
    completedQuests: ReadonlySet<string> = new Set(),
    skills?: Readonly<Record<string, number>>,
) {
    const script = resolveQuestScript(questInput);
    const slug = script.slice(script.lastIndexOf('/') + 1).replace(/^quest-/, '').replace(/\.ts$/, '');
    const completed = new Set<string>();
    for (const name of completedQuests) {
        completed.add(questKey(name));
        try {
            const resolved = resolveQuestScript(name);
            completed.add(questKey(resolved.slice(resolved.lastIndexOf('/') + 1).replace(/^quest-/, '').replace(/\.ts$/, '')));
        } catch {
            /* ignore unresolved completed name */
        }
    }
    const isComplete = (q: string) => completed.has(questKey(q)) || (!!QUEST_NAMES[q] && completed.has(questKey(QUEST_NAMES[q]!)));
    const blockers: string[] = [];
    if (isComplete(slug) || completed.has(questKey(questInput))) {
        return { slug, script, alreadyComplete: true, ready: false, missingItems: {} as Record<number, number>, blockers, startTile: null };
    }
    let observedSkills: { name: string; level: number }[] | undefined;
    if (skills) {
        observedSkills = [];
        for (const name in skills) {
            if (!Object.prototype.hasOwnProperty.call(skills, name)) continue;
            const level = skills[name]!;
            if (Number.isFinite(level) && level >= 1) observedSkills.push({ name, level });
        }
    }
    const shortfalls = questShortfall(slug, observedSkills);
    for (let i = 0; i < shortfalls.length; i++) blockers.push(`skill ${shortfalls[i]!}`);
    for (const q of QUEST_PREREQUISITES[slug] ?? []) {
        if (!isComplete(q)) blockers.push(`quest ${QUEST_NAMES[q] ?? q} incomplete or unknown`);
    }
    if (slug === 'hero') blockers.push('Heroes requires an explicit owned pair order');
    if (slug === 'arrav') blockers.push('Shield of Arrav requires a pair partner (scripts/generated/quest-arrav.ts <main> <helper>)');
    try {
        const preset = presetFor(slug);
        const missingItems: Record<number, number> = {};
        const required = wornKitPlan(slug, needs(preset, false, slug), [], [], []).need;
        for (const id of QUEST_FINDS[slug] ?? []) required.delete(id);
        const prayerLevel = skills?.Prayer ?? skills?.prayer ?? 1;
        if (prayerCovers(slug, prayerLevel)) for (const id of PRAYER_POTIONS) required.delete(id);
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

export function prioritizeQuestsForAccount(
    ownedItems: Readonly<Record<number, number>>,
    completedQuests: ReadonlySet<string> = new Set(),
    candidates: readonly string[] = Object.keys(QUEST_NAMES),
    skills?: Readonly<Record<string, number>>,
) {
    const evaluations = candidates.map((slug) => assessQuestReadiness(slug, ownedItems, completedQuests, skills)).filter((e) => !e.alreadyComplete);
    const readyNow = evaluations.filter((e) => e.ready).map((e) => ({ ...e, step: resolveQuesterStep('sweep', [e.slug]) }));
    const needsItems = evaluations
        .filter((e) => !e.ready && !e.blockers.length)
        .sort((a, b) => Object.keys(a.missingItems).length - Object.keys(b.missingItems).length);
    return { readyNow, needsItems, blocked: evaluations.filter((e) => e.blockers.length > 0) };
}

export function resolveQuesterStep(modeOrQuest: string, rest: readonly string[] = [], root = REPO_ROOT): Step {
    const { resolveRouteStep } = require('../../../core/src/route-step') as typeof import('../../../core/src/route-step');
    const key = modeOrQuest.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
    const modeSpec = QUESTER_MODES.find((m) => m.mode === key);
    if (modeSpec) {
        if (modeSpec.orderFile) {
            const order = resolveRouteStep({ script: modeSpec.script, defaultArgs: modeSpec.defaultArgs, defaultEnv: modeSpec.defaultEnv }, rest);
            if (order.args.length !== 1) throw Error(`aio-quester ${key} requires <order.json>`);
            return { script: 'scripts/aio-quester.ts', args: [key, ...order.args], env: order.env };
        }
        const resolved = resolveRouteStep({ script: modeSpec.script, defaultArgs: [], defaultEnv: modeSpec.defaultEnv }, rest);
        return {
            script: modeSpec.script,
            args: [...(modeSpec.defaultArgs ?? []), ...resolved.args],
            env: resolved.env,
        };
    }
    if (key === 'quest' && rest[0]) {
        const script = resolveQuestScript(rest[0], root);
        return resolveRouteStep({ script }, rest.slice(1));
    }
    const script = resolveQuestScript(key, root);
    return resolveRouteStep({ script }, rest);
}

export async function dispatchQuesterCli(
    account: string,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<number> {
    if (!account) throw Error('aio-quester requires account');
    const [first, ...rest] = args;
    if (!first) throw Error('aio-quester requires <mode|quest>');
    const key = first.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
    const mode = QUESTER_MODES.find((m) => m.mode === key);
    if (!mode || mode.script !== 'scripts/aio-quester.ts') {
        const result = await runAioQuester(account, args, env);
        return /^RESULT ok(?: |$)/.test(result) ? 0 : 1;
    }
    const resolved = resolveQuesterStep(first, rest);
    const mergedEnv = { ...env, ...resolved.env };
    const prevEnv = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(resolved.env)) {
        prevEnv.set(k, process.env[k]);
        process.env[k] = v;
    }
    const subArgs = resolved.args.slice(1);
    const { finish, finishHooks, openBot, settle } = await import('../../../core/src/bot');
    try {
        switch (key) {
            case 'sweep': {
                const { apiOptions, sweep, sweepPreset } = await import('./sweep');
                const [quest, optionsPath] = subArgs;
                if (!quest) throw Error('usage: bun scripts/aio-quester.ts <account> sweep <quest> [api-options.json]');
                let options: SweepApiOptions | undefined;
                if ((quest === 'tbwt' || quest === 'itwatchtower') && optionsPath) {
                    const bytes = readFileSync(optionsPath);
                    if (bytes.length > 32768) throw Error('quest sweep options file too large');
                    let value: unknown;
                    try {
                        value = JSON.parse(bytes.toString('utf8'));
                    } catch {
                        throw Error('invalid quest sweep options JSON');
                    }
                    options = apiOptions(quest, value);
                }
                if ((globalThis as { __rsBotHost?: unknown }).__rsBotHost) {
                    finishHooks.set(account.toLowerCase(), (ok, detail) => {
                        void finish([], ok, detail);
                    });
                }
                const fresh = `run=${account.toLowerCase()}-${Date.now()}`;
                if ((quest === 'tbwt' || quest === 'itwatchtower') && !optionsPath) await sweepPreset(account, quest, fresh);
                else await sweep(account, quest, fresh, options);
                return 0;
            }
            case 'order': {
                const { QUEST_ORDERS, runQuestOrder } = await import('./order');
                const [questKeyArg] = subArgs.filter((a) => !a.startsWith('--'));
                const flag = (k: string) => subArgs.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
                if (!questKeyArg || !Object.hasOwn(QUEST_ORDERS, questKeyArg)) {
                    throw Error(`usage: bun scripts/aio-quester.ts <account> order <${Object.keys(QUEST_ORDERS).join('|')}> [--save=<path>] [--timeout-ms=300000]`);
                }
                const save = flag('save');
                const result = await runQuestOrder(account, questKeyArg, {
                    save: save ? resolve(save) : undefined,
                    timeoutMs: Number(flag('timeout-ms') ?? 300000),
                });
                console.log('QUEST_ORDER_RESULT ' + JSON.stringify(result));
                return result.ok ? 0 : 1;
            }
            case 'chain': {
                const { runQuestChainFromAccount } = await import('./chain');
                const list = subArgs.join(',');
                if (!list) throw Error('usage: bun scripts/aio-quester.ts <account> chain <quest,quest,...>');
                const res = await runQuestChainFromAccount(account, list.split(','));
                console.log(res.result);
                return res.ok ? 0 : 1;
            }
            case 'items': {
                const { runQuestItemsOrder } = await import('./items-order');
                const [questKeyArg] = subArgs.filter((a) => !a.startsWith('--'));
                const save = subArgs.find((a) => a.startsWith('--save='))?.slice(7);
                if (!questKeyArg) throw Error('usage: bun scripts/aio-quester.ts <account> items <quest> --save=<own-save>');
                const result = await runQuestItemsOrder(account, questKeyArg, {
                    save: save ? resolve(save) : undefined,
                    cap: Number(mergedEnv.CAP ?? 2400),
                });
                console.log('QUEST_ITEMS_ORDER_RESULT ' + JSON.stringify(result));
                return result.ok ? 0 : 1;
            }
            case 'cook-job': {
                const { parseCookJobArgs, runQuestCookJob, runQuestHettyJob } = await import('./cook-job');
                const parsed = parseCookJobArgs([account, ...subArgs], mergedEnv.CAP ?? (subArgs[0] === 'hetty' ? '6000' : '2400'));
                const result = 'quest' in parsed ? await runQuestHettyJob(parsed.name, parsed.cap) : await runQuestCookJob(parsed.name, parsed.cap);
                console.log('QUEST_COOK_JOB_RESULT ' + JSON.stringify(result));
                return result.ok ? 0 : 1;
            }
            case 'seaslug-leave': {
                const { runSeaslugLeave } = await import('./helpers');
                await runSeaslugLeave(Number(mergedEnv.CAP ?? 600), account);
                return 0;
            }
            case 'dusty-key': {
                const { runDustyKey } = await import('./helpers');
                await runDustyKey(Number(mergedEnv.CAP ?? 3000), account);
                return 0;
            }
            case 'clue': {
                const { runNativeClueStep } = await import('./clues');
                const clue = Number(subArgs[0]);
                const cap = Number(subArgs[1] ?? 200);
                if (!Number.isSafeInteger(clue) || !Number.isSafeInteger(cap) || cap < 1) {
                    throw Error('Usage (members world): bun scripts/aio-quester.ts <account> clue <native-clue-id> [ticks]');
                }
                let stopped = false;
                const onSig = () => {
                    stopped = true;
                };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                const s = await openBot(account);
                let ok = false;
                try {
                    const r = await runNativeClueStep(s, clue, cap, () => stopped);
                    console.log('NATIVE_CLUE_RESULT ' + JSON.stringify(r));
                    ok = r.ok;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    ok = await settle([s], ok, 'finite native clue step');
                }
                return ok ? 0 : 1;
            }
            case 'clue-puzzle': {
                const { solveNativeCluePuzzle } = await import('./clue-puzzle');
                const puzzle = Number(subArgs[0]);
                const cap = Number(subArgs[1] ?? 200);
                const npc = subArgs[2] === undefined ? undefined : Number(subArgs[2]);
                if (!Number.isSafeInteger(puzzle) || !Number.isSafeInteger(cap) || cap < 1 || (npc !== undefined && (!Number.isSafeInteger(npc) || npc < 0))) {
                    throw Error('Usage (members): bun scripts/aio-quester.ts <account> clue-puzzle <puzzle-id> [ticks] [exact-turn-in-npc-index]');
                }
                let stopped = false;
                const onSig = () => {
                    stopped = true;
                };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                const s = await openBot(account);
                let ok = false;
                try {
                    const r = await solveNativeCluePuzzle(s, puzzle, cap, 25000, npc, () => stopped);
                    console.log('NATIVE_PUZZLE_RESULT ' + JSON.stringify(r));
                    ok = r.ok;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    ok = await settle([s], ok, 'finite native clue puzzle');
                }
                return ok ? 0 : 1;
            }
            case 'clue-guardian': {
                const [{ nativeNpcSpell, nativeTeleport }, { runGuardianClue }] = await Promise.all([
                    import('../../../core/src/magic-data'),
                    import('./clue-guardian'),
                ]);
                const id = Number(subArgs[0]);
                const spell = subArgs[1] ?? 'fire_blast';
                const maximumCasts = Number(subArgs[2] ?? 30);
                const cap = Number(subArgs[3] ?? 350);
                if (!Number.isSafeInteger(id)) {
                    throw Error('Usage (members): bun scripts/aio-quester.ts <account> clue-guardian <native-clue-id> [standard-damage-spell] [max-casts] [ticks]');
                }
                nativeNpcSpell(spell);
                nativeTeleport('varrock');
                let stopped = false;
                const onSig = () => {
                    stopped = true;
                };
                process.once('SIGINT', onSig);
                process.once('SIGTERM', onSig);
                const s = await openBot(account);
                let ok = false;
                try {
                    const r = await runGuardianClue(s, id, {
                        spell,
                        maximumCasts,
                        cap,
                        ambientDamage: Number(mergedEnv.GUARDIAN_AMBIENT_DAMAGE ?? 0),
                        stop: () => stopped,
                    });
                    console.log('NATIVE_GUARDIAN_RESULT ' + JSON.stringify(r));
                    ok = r.ok;
                } finally {
                    process.off('SIGINT', onSig);
                    process.off('SIGTERM', onSig);
                    ok = await settle([s], ok, 'finite native guardian clue');
                }
                return ok ? 0 : 1;
            }
            default:
                throw Error(`aio-quester: unhandled mode ${key}`);
        }
    } finally {
        for (const [k, v] of prevEnv) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

export async function runAioQuester(
    account: string,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<string> {
    if (!account) throw Error('aio-quester requires account');
    const [first, ...rest] = args;
    if (!first) throw Error('aio-quester requires <mode|quest>');
    const key = first.toLowerCase().replace(/^--mode=/, '').replace(/^--quest=/, '');
    const mode = QUESTER_MODES.find((m) => m.mode === key);
    const resolved = resolveQuesterStep(first, rest);
    const [{ resolveRouteStep }, { runDirectChild }] = await Promise.all([
        import('../../../core/src/route-step'),
        import('../../../core/src/run-child'),
    ]);
    const step = mode?.orderFile ? resolveRouteStep({ script: mode.script, defaultArgs: mode.defaultArgs, defaultEnv: mode.defaultEnv }, rest) : resolved;
    const orderFile = mode?.orderFile;
    return runDirectChild(orderFile ? [step.script, ...step.args] : [step.script, account, ...step.args], { ...env, ...step.env });
}
