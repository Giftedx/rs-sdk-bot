import { existsSync } from 'node:fs';
import {
    accountOwnedItemCount,
    preflightFail,
    preflightOk,
    type PreflightBlocker,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../contracts';
import type { Session } from '../../../core/src/inprocess';
import { nativeNpcSpell, nativeTeleport } from '../../../core/src/magic-data';
import { QUEST_NAMES, questShortfall, runQuestChainFromAccount } from './chain';
import { nativeGuardianClue, runGuardianClue } from './clue-guardian';
import { nativePuzzleRecipe, solveNativeCluePuzzle } from './clue-puzzle';
import { nativeClueSteps, runNativeClueStep } from './clues';
import { parseCookJobArgs, runQuestCookJob, runQuestHettyJob } from './cook-job';
import { runDustyKey, runSeaslugLeave } from './helpers';
import { QUEST_ITEM_RECIPES, runQuestItemsOrder } from './items-order';
import { assessQuestReadiness, listGeneratedQuestScripts, resolveQuestScript } from './modes';
import { QUEST_ORDERS, runQuestOrder } from './order';
import { resolveOpenQuest } from './runtime';
import { handOver, presetFor, sweep } from './sweep';

import type { QuestConfig } from './types';
import { REPO_ROOT } from './types';
import { join } from 'node:path';

function accountSkillLevels(acct: WorkerAccountView): Record<string, number> {
    const skills: Record<string, number> = {};
    for (const [k, v] of Object.entries(acct.skills)) skills[k] = v.level;
    return skills;
}

function accountOwnedItems(acct: WorkerAccountView): Record<number, number> {
    const owned: Record<number, number> = {};
    for (const bag of [acct.inventory, acct.equipment, acct.bank.items]) {
        for (const [idStr, count] of Object.entries(bag)) {
            if (count > 0) owned[Number(idStr)] = (owned[Number(idStr)] ?? 0) + count;
        }
    }
    return owned;
}

function completedQuestSet(acct: WorkerAccountView): Set<string> {
    const out = new Set<string>();
    for (const [name, state] of Object.entries(acct.quests)) {
        if (state === 'complete') out.add(name);
    }
    return out;
}

function preflightQuest(acct: WorkerAccountView, cfg: QuestConfig, _world: WorkerWorldView): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: `${acct.name} clock is protected` });
        return preflightFail(blockers);
    }

    switch (cfg.operation) {
        case 'sweep':
        case 'generated':
        case 'tbwt-owned':
        case 'watchtower-owned': {
            const q = cfg.quest;
            if (!q?.trim()) {
                blockers.push({ kind: 'invalid_config', message: `${cfg.operation} requires quest` });
                break;
            }
            if ((cfg.operation === 'sweep' || cfg.operation === 'generated') && (q === 'hero' || q === 'heroes')) {
                blockers.push({ kind: 'invalid_config', message: 'Heroes requires hero-owned order file' });
                break;
            }
            if (cfg.operation === 'tbwt-owned' || q === 'tbwt') {
                const invReady = (acct.skills.Prayer?.level ?? 1) >= 43;
                if (!invReady) {
                    blockers.push({ kind: 'skill_level', skill: 'Prayer', required: 43, current: acct.skills.Prayer?.level ?? 1 });
                }
                if (acct.quests['Jungle Potion'] !== 'complete' && acct.quests.junglepotion !== 'complete') {
                    blockers.push({ kind: 'quest_incomplete', quest: 'Jungle Potion', requiredState: 'complete' });
                }
                if (acct.quests['Shilo Village'] !== 'complete' && acct.quests.zombiequeen !== 'complete') {
                    blockers.push({ kind: 'quest_incomplete', quest: 'Shilo Village', requiredState: 'complete' });
                }
                break;
            }
            if (cfg.operation === 'watchtower-owned' || q === 'itwatchtower') {
                const needSkills = { Magic: 14, Thieving: 15, Agility: 25, Herblore: 14, Mining: 40 };
                for (const [skill, req] of Object.entries(needSkills)) {
                    const cur = acct.skills[skill]?.level ?? 1;
                    if (cur < req) blockers.push({ kind: 'skill_level', skill, required: req, current: cur });
                }
                break;
            }
            try {
                const readiness = assessQuestReadiness(q, accountOwnedItems(acct), completedQuestSet(acct), accountSkillLevels(acct));
                if (readiness.alreadyComplete) {
                    blockers.push({ kind: 'invalid_config', message: `${readiness.slug} already complete` });
                    break;
                }
                for (const b of readiness.blockers) {
                    const skillMatch = b.match(/^skill (\w+) (\d+)\/(\d+)$/);
                    if (skillMatch) {
                        blockers.push({
                            kind: 'skill_level',
                            skill: skillMatch[1]!,
                            current: Number(skillMatch[2]),
                            required: Number(skillMatch[3]),
                        });
                        continue;
                    }
                    const questMatch = b.match(/^quest (.+) incomplete or unknown$/);
                    if (questMatch) {
                        blockers.push({ kind: 'quest_incomplete', quest: questMatch[1]!, requiredState: 'complete' });
                        continue;
                    }
                    blockers.push({ kind: 'invalid_config', message: b });
                }
                for (const [idStr, short] of Object.entries(readiness.missingItems)) {
                    const id = Number(idStr);
                    const avail = accountOwnedItemCount(acct, id);
                    blockers.push({ kind: 'missing_supply', itemId: id, required: avail + short, available: avail, reserved: 0 });
                }
            } catch (err) {
                blockers.push({ kind: 'invalid_config', message: String(err) });
            }
            break;
        }
        case 'order': {
            const key = cfg.quest ?? '';
            if (!Object.hasOwn(QUEST_ORDERS, key)) {
                blockers.push({ kind: 'invalid_config', message: `unknown quest order "${key}"` });
                break;
            }
            if (cfg.savePath && !existsSync(cfg.savePath)) {
                blockers.push({ kind: 'invalid_config', message: `save not found: ${cfg.savePath}` });
            }
            const spec = QUEST_ORDERS[key]!;
            for (const item of spec.items) {
                const avail = accountOwnedItemCount(acct, item.id);
                if (avail < item.count) {
                    blockers.push({
                        kind: 'missing_supply',
                        itemId: item.id,
                        itemName: item.name,
                        required: item.count,
                        available: avail,
                        reserved: 0,
                    });
                }
            }
            break;
        }
        case 'chain': {
            if (!cfg.quests?.length) {
                blockers.push({ kind: 'invalid_config', message: 'quest chain requires quests[]' });
                break;
            }
            const skills = Object.entries(accountSkillLevels(acct)).map(([name, level]) => ({ name, level }));
            for (const q of cfg.quests) {
                try {
                    resolveQuestScript(q);
                } catch (err) {
                    blockers.push({ kind: 'invalid_config', message: String(err) });
                    continue;
                }
                for (const s of questShortfall(q, skills)) {
                    const m = s.match(/^(\w+) (\d+)\/(\d+)$/);
                    if (m) blockers.push({ kind: 'skill_level', skill: m[1]!, current: Number(m[2]), required: Number(m[3]) });
                }
            }
            break;
        }
        case 'items':
        case 'cook-job': {
            const key = cfg.quest ?? 'cook';
            if (!Object.hasOwn(QUEST_ITEM_RECIPES, key)) {
                blockers.push({ kind: 'invalid_config', message: `unsupported quest ${cfg.operation}: ${key}` });
            }
            if (cfg.operation === 'items' && cfg.savePath && !existsSync(cfg.savePath)) {
                blockers.push({ kind: 'invalid_config', message: `save not found: ${cfg.savePath}` });
            }
            break;
        }
        case 'seaslug-leave':
        case 'dusty-key': {
            break;
        }
        case 'clue': {
            if (!Number.isSafeInteger(cfg.clueId) || (cfg.clueId ?? 0) <= 0) {
                blockers.push({ kind: 'invalid_config', message: 'clue requires valid clueId' });
                break;
            }
            const step = nativeClueSteps().find((v) => v.id === cfg.clueId);
            if (!step || step.kind === 'unsupported') {
                blockers.push({ kind: 'invalid_config', message: step?.gap ?? `unsupported clueId ${cfg.clueId}` });
                break;
            }
            for (const toolId of step.tools) {
                const avail = accountOwnedItemCount(acct, toolId);
                if (avail < 1) blockers.push({ kind: 'missing_supply', itemId: toolId, required: 1, available: avail, reserved: 0 });
            }
            break;
        }
        case 'clue-puzzle': {
            if (!Number.isSafeInteger(cfg.puzzleId) || (cfg.puzzleId ?? 0) <= 0) {
                blockers.push({ kind: 'invalid_config', message: 'clue-puzzle requires valid puzzleId' });
                break;
            }
            try {
                nativePuzzleRecipe(cfg.puzzleId!);
            } catch (err) {
                blockers.push({ kind: 'invalid_config', message: String(err) });
            }
            break;
        }
        case 'clue-guardian': {
            if (!Number.isSafeInteger(cfg.clueId) || (cfg.clueId ?? 0) <= 0) {
                blockers.push({ kind: 'invalid_config', message: 'clue-guardian requires valid clueId' });
                break;
            }
            try {
                const g = nativeGuardianClue(cfg.clueId!);
                const spell = nativeNpcSpell(cfg.spell ?? 'fire_blast');
                const tele = nativeTeleport('varrock');
                const hp = acct.skills.Hitpoints?.level ?? 1;
                const prayer = acct.skills.Prayer?.level ?? 1;
                const magic = acct.skills.Magic?.level ?? 1;
                if (hp < 70) blockers.push({ kind: 'combat_survivability', reason: 'hitpoints', required: 70, current: hp });
                if (prayer < 40) blockers.push({ kind: 'combat_survivability', reason: 'prayer', required: 40, current: prayer });
                const needMagic = Math.max(spell.level, tele.level);
                if (magic < needMagic) blockers.push({ kind: 'skill_level', skill: 'Magic', required: needMagic, current: magic });
                for (const toolId of g.tools) {
                    const avail = accountOwnedItemCount(acct, toolId);
                    if (avail < 1) blockers.push({ kind: 'missing_supply', itemId: toolId, required: 1, available: avail, reserved: 0 });
                }
            } catch (err) {
                blockers.push({ kind: 'invalid_config', message: String(err) });
            }
            break;
        }
        case 'hero-owned':
        case 'legends-owned': {
            if (!cfg.orderPath?.trim() || !existsSync(cfg.orderPath)) {
                blockers.push({ kind: 'invalid_config', message: `${cfg.operation} requires existing orderPath` });
            }
            break;
        }
        default: {
            blockers.push({ kind: 'invalid_config', message: `unknown quest operation ${String((cfg as { operation: unknown }).operation)}` });
        }
    }

    return blockers.length ? preflightFail(blockers) : preflightOk({ travelCoins: 0, travelTicks: 40 });
}

function estimateQuest(_acct: WorkerAccountView, cfg: QuestConfig, _world: WorkerWorldView): RateEstimate {
    const setupTicks = cfg.operation === 'clue' || cfg.operation === 'clue-puzzle' ? 10 : 60;
    const estTicks = cfg.cap ?? (cfg.operation === 'clue' || cfg.operation === 'clue-puzzle' ? 80 : 1200);
    const unitsPerTick = 1 / Math.max(1, estTicks);
    return {
        xpPerTick: cfg.operation === 'clue-guardian' ? 4 : 2,
        unitsPerTick,
        gpPerTick: 0,
        setupTicks,
        minBatchUnits: 1,
        confidence: 'practice',
    };
}

function failOutcome(activityId: string, account: string, ticksElapsed: number, durationMs: number, message: string): RunOutcome {
    const lower = message.toLowerCase();
    if (/died|death|isdead/.test(lower)) {
        return { kind: 'death', activityId, account, ticksElapsed, durationMs, faultSignature: `${activityId}:death`, detail: message };
    }
    const missingMatch = message.match(/missing (\d+):(\d+)/);
    if (missingMatch) {
        return {
            kind: 'missing_supply',
            activityId,
            account,
            ticksElapsed,
            durationMs,
            missing: [{ itemId: Number(missingMatch[1]), required: Number(missingMatch[2]), available: 0 }],
            summary: message,
        };
    }
    if (/walk|route|unreachable|unobserved arrival|strand/.test(lower)) {
        return { kind: 'location_stranded', activityId, account, ticksElapsed, durationMs, detail: message };
    }
    if (/logout|settle|unsettled/.test(lower)) {
        return { kind: 'session_unsettled', activityId, account, ticksElapsed, durationMs, reason: 'settlement', detail: message };
    }
    return { kind: 'worker_defect', activityId, account, ticksElapsed, durationMs, faultSignature: `${activityId}:error`, detail: message };
}

async function runQuest(sessionCore: SessionCore, cfg: QuestConfig): Promise<RunOutcome> {
    const session = sessionCore as unknown as Session;
    const t0 = Date.now();
    const startTick = sessionCore.tick();
    const elapsed = () => Math.max(0, sessionCore.tick() - startTick);
    const ms = () => Math.max(0, Date.now() - t0);
    const activityId = cfg.quest ? `quest:${cfg.operation}:${cfg.quest}` : `quest:${cfg.operation}`;

    try {
        switch (cfg.operation) {
            case 'clue': {
                const r = await runNativeClueStep(session, cfg.clueId ?? 0, cfg.cap ?? 200);
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: r.ticks, durationMs: ms(), unitsCompleted: 1, summary: `${r.clue} ${r.effect.outcome}` }
                    : failOutcome(activityId, sessionCore.name, r.ticks, ms(), r.detail || 'clue failed');
            }
            case 'clue-puzzle': {
                const r = await solveNativeCluePuzzle(session, cfg.puzzleId ?? 0, cfg.cap ?? 200, 25000, cfg.npcIndex);
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: r.ticks, durationMs: ms(), unitsCompleted: 1, summary: r.puzzle }
                    : failOutcome(activityId, sessionCore.name, r.ticks, ms(), r.detail || 'clue-puzzle failed');
            }
            case 'clue-guardian': {
                const r = await runGuardianClue(session, cfg.clueId ?? 0, {
                    spell: cfg.spell ?? 'fire_blast',
                    maximumCasts: cfg.maxCasts ?? 30,
                    cap: cfg.cap ?? 350,
                    ambientDamage: cfg.ambientDamage,
                });
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: r.ticks, durationMs: ms(), unitsCompleted: 1, xpGained: { Magic: r.magicXp }, summary: r.clue }
                    : failOutcome(activityId, sessionCore.name, r.ticks, ms(), r.detail || 'clue-guardian failed');
            }
            case 'generated': {
                const scriptRel = resolveQuestScript(cfg.quest ?? '');
                const abs = join(REPO_ROOT, scriptRel);
                const fresh = cfg.fresh ?? `run=${sessionCore.name.toLowerCase()}-${Date.now()}`;
                await handOver(session, abs, fresh);
                return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 };
            }
            case 'seaslug-leave': {
                const openQuest = await resolveOpenQuest();
                void openQuest;
                await runSeaslugLeave(cfg.cap ?? 600, sessionCore.name);
                return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 };
            }
            case 'dusty-key': {
                await runDustyKey(cfg.cap ?? 3000, sessionCore.name);
                return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 };
            }
            case 'sweep':
            case 'tbwt-owned':
            case 'watchtower-owned': {
                const questSlug = cfg.operation === 'tbwt-owned' ? 'tbwt' : cfg.operation === 'watchtower-owned' ? 'itwatchtower' : (cfg.quest ?? '');
                await sweep(sessionCore.name, questSlug, cfg.fresh, cfg.apiOptions);
                return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 };
            }
            case 'order': {
                const r = await runQuestOrder(sessionCore.name, cfg.quest ?? '', { save: cfg.savePath, timeoutMs: cfg.timeoutMs ?? 300_000 });
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 }
                    : failOutcome(activityId, sessionCore.name, elapsed(), ms(), String((r as { refused?: string; failed?: string }).refused ?? (r as { failed?: string }).failed ?? 'quest order failed'));
            }
            case 'chain': {
                const r = await runQuestChainFromAccount(sessionCore.name, [...(cfg.quests ?? [])]);
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: cfg.quests?.length ?? 0, summary: r.result }
                    : failOutcome(activityId, sessionCore.name, elapsed(), ms(), r.result);
            }
            case 'items': {
                const r = await runQuestItemsOrder(sessionCore.name, cfg.quest ?? 'cook', { save: cfg.savePath, cap: cfg.cap ?? 2400 });
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), unitsCompleted: 1 }
                    : failOutcome(activityId, sessionCore.name, elapsed(), ms(), String((r as { refused?: string; detail?: string }).refused ?? (r as { detail?: string }).detail ?? 'quest items failed'));
            }
            case 'cook-job': {
                const q = cfg.quest === 'hetty' ? 'hetty' : 'cook';
                const parsed = parseCookJobArgs(q === 'hetty' ? [sessionCore.name, 'hetty'] : [sessionCore.name], String(cfg.cap ?? (q === 'hetty' ? 6000 : 2400)));
                const r = 'quest' in parsed ? await runQuestHettyJob(parsed.name, parsed.cap) : await runQuestCookJob(parsed.name, parsed.cap);
                return r.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: r.ticks, durationMs: ms(), unitsCompleted: 1, summary: r.detail }
                    : failOutcome(activityId, sessionCore.name, r.ticks, ms(), r.detail);
            }
            default: {
                return { kind: 'worker_defect', activityId, account: sessionCore.name, ticksElapsed: elapsed(), durationMs: ms(), faultSignature: `${activityId}:unsupported`, detail: `unsupported quest operation ${cfg.operation}` };
            }
        }
    } catch (err) {
        return failOutcome(activityId, sessionCore.name, elapsed(), ms(), String(err));
    }
}

export const questModule: WorkerModule<QuestConfig> = {
    id: 'quest:unified',
    family: 'quest',
    kind: 'quest',
    trust: 'practice_passed',
    protectedAllowed: false,
    preflight: preflightQuest,
    estimate: estimateQuest,
    run: runQuest,
};

export function questCatalogSummary() {
    return {
        generatedScripts: listGeneratedQuestScripts().length,
        namedQuests: Object.keys(QUEST_NAMES).length,
        presetsAvailable: (() => {
            try {
                return !!presetFor('cook');
            } catch {
                return false;
            }
        })(),
    };
}
