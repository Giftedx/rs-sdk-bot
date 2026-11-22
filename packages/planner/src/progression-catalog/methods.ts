import type { Step } from '../../../core/src/chain-step';
import type {
    CatalogGap,
    CatalogMethod,
    CatalogOptions,
    ObservedAccount,
    ProgressionCatalog,
    ProgressionMethod,
    WorkIntent,
} from '../../../core/src/progression-adapter';
import { levelForXp, xpForLevel } from '../curve';
import { trainingTargets } from '../progression';
import { rangedProgressionMethods } from '../progression-ranged';
import { key, loadProgressionCatalog, scriptPath, scriptStem, whole } from './catalog';

function desiredUnits(intent: WorkIntent, account: ObservedAccount, method: ProgressionMethod): number {
    const targets = trainingTargets(intent);
    if (targets) {
        return Math.max(1, ...Object.entries(targets).map(([skill, target]) => {
            const effect = Object.entries(method.effects.xp ?? {}).find(([name]) => key(name) === skill)?.[1] ?? 0;
            const have = Object.entries(account.skills).find(([name]) => key(name) === skill)?.[1].xp ?? 0;
            return effect > 0 ? Math.ceil((xpForLevel(target) - have) / effect) : 1;
        }));
    }
    if (intent.kind === 'produce' || intent.kind === 'acquire') {
        return Math.max(1, ...Object.entries(intent.items).flatMap(([id, n]) =>
            method.effects.items?.[Number(id)] ? [Math.ceil(n / method.effects.items[Number(id)]!)] : [],
        ));
    }
    return 1;
}

function trainingStop(step: Step, intent: WorkIntent): Step {
    const targets = trainingTargets(intent);
    if (scriptStem(scriptPath(step.script)) !== 'cannon-fight' || intent.kind !== 'train-all' || !targets) return step;
    const { STOP_LEVEL: _level, STOP_SKILL: _skill, ...env } = step.env;
    return { ...step, env: { ...env, STOP: Object.entries(targets).map(([skill, target]) => `${skill}=${target}`).join(',') } };
}

function materialize(
    method: CatalogMethod,
    intent: WorkIntent,
    account: ObservedAccount,
    requestedUnits?: number,
): ProgressionMethod {
    const unitSized = !!(
        method.execution?.bankJob
        || method.execution?.unitEnv?.length
        || method.execution?.stockEnv?.length
        || method.execution?.unitArg !== undefined
    );
    const cap = method.maxBatch ?? (unitSized ? 1000 : Infinity);
    const targets = trainingTargets(intent);
    const skill = Object.keys(method.effects.xp ?? {}).find(s => targets?.[key(s)] !== undefined);
    const units = Math.min(cap, requestedUnits ?? desiredUnits(intent, account, method));
    const target = skill ? targets?.[key(skill)] : undefined;
    const step: Step = { script: method.step.script, args: [...method.step.args], env: { ...method.step.env } };
    if (method.execution?.bankJob) {
        const job = {
            ...method.execution.bankJob,
            target: units * (method.execution.outputPerUnit ?? 1),
            batch: Math.min(Number(method.execution.bankJob.batch ?? 13), units),
            ...(target && method.execution.bankJob.family === 'cooking' ? { targetLevel: target } : {}),
        };
        step.args = ['bank-job', '--job=' + encodeURIComponent(JSON.stringify(job))];
    }
    for (const name of method.execution?.targetEnv ?? []) if (target) step.env[name] = String(target);
    for (const name of method.execution?.unitEnv ?? []) step.env[name] = String(units);
    for (const name of method.execution?.stockEnv ?? []) {
        const id = Number(Object.keys(method.effects.items ?? {})[0]);
        const owned = [account.inventory, account.equipment, account.bank].reduce((n, o) => n + (o?.value[id] ?? 0), 0);
        step.env[name] = String(owned + units * (method.effects.items?.[id] ?? 1));
    }
    if (target && method.execution?.targetArg !== undefined) step.args[method.execution.targetArg] = String(target);
    if (method.execution?.unitArg !== undefined) step.args[method.execution.unitArg] = String(units);
    if (method.execution?.spendPerUnit) {
        step.env.MAX_SPEND = String(Math.ceil(units * method.execution.spendPerUnit));
        step.env.FLOAT = String(Math.ceil(units * method.execution.spendPerUnit) + 1000);
    }
    const level = method.modelRates && Object.entries(account.skills).find(([s]) => key(s) === key(method.modelRates!.skill))?.[1].level;
    const rate = level && method.modelRates ? { ...method.rate, unitsPerTick: method.modelRates.perLevel[level - 1] ?? null } : method.rate;
    return { ...method, step: trainingStop(step, intent), rate, ...(unitSized ? { maxUnits: Math.min(method.maxUnits ?? Infinity, cap) } : {}) };
}

/** Materializes the concrete worker step for a chosen progression method and unit count. */
export function progressionStep(
    method: ProgressionMethod,
    units: number,
    intent: WorkIntent,
    account: ObservedAccount,
    _catalog: ProgressionCatalog = loadProgressionCatalog(),
): Step {
    if (intent.kind === 'train-all') {
        const targets = trainingTargets(intent);
        if (!targets || !whole(units) || units < 1) throw Error('compound progression step needs finite observed targets and units');
        const boundary: Record<string, number> = {};
        for (const [skill, target] of Object.entries(targets)) {
            const own = Object.entries(account.skills).find(([name]) => key(name) === skill)?.[1];
            if (!own || !Number.isFinite(own.xp) || own.xp < 0) throw Error('compound progression step needs an observed ' + skill + ' state');
            const gain = Object.entries(method.effects.xp ?? {}).find(([name]) => key(name) === skill)?.[1] ?? 0;
            boundary[skill] = Math.min(target, levelForXp(own.xp + gain * units));
        }
        intent = { kind: 'train-all', targets: boundary };
    }
    const declaration = (method as CatalogMethod).execution ? (method as CatalogMethod) : undefined;
    if (!declaration?.execution) return trainingStop(method.step, intent);
    const unitSized = !!(
        declaration.execution.bankJob
        || declaration.execution.unitEnv?.length
        || declaration.execution.stockEnv?.length
        || declaration.execution.unitArg !== undefined
    );
    const cap = Math.min(declaration.maxUnits ?? Infinity, declaration.maxBatch ?? (unitSized ? 1000 : Infinity));
    if (!whole(units) || units < 1 || units > cap) throw Error('selected progression units exceed the executable batch');
    return materialize(declaration, intent, account, units).step;
}

/** Selects catalog and dynamic progression methods that satisfy an intent and reports unresolved gaps. */
export function progressionMethods(
    intent: WorkIntent,
    account: ObservedAccount,
    catalog: ProgressionCatalog = loadProgressionCatalog(),
    options: CatalogOptions = {},
): { methods: ProgressionMethod[]; gaps: CatalogGap[] } {
    const all = new Map<string, ProgressionMethod>(catalog.methods.map(m => [m.id, materialize(m, intent, account)]));
    const targets = trainingTargets(intent);
    if (targets?.ranged !== undefined) {
        for (const method of rangedProgressionMethods(account, targets.ranged)) {
            all.set(method.id, materialize(method as CatalogMethod, intent, account));
        }
    }
    if ((intent.kind === 'acquire' || intent.kind === 'produce') && [849, 888].some(id => intent.items[id])) {
        for (const method of rangedProgressionMethods(account, 99, intent.items)) {
            if (Object.keys(method.effects.items ?? {}).some(id => intent.items[Number(id)])) all.set(method.id, method);
        }
    }
    for (const method of options.extraMethods ?? []) all.set(method.id, method);
    const skills = new Set(Object.keys(targets ?? {}));
    const items = new Set(intent.kind === 'produce' || intent.kind === 'acquire' ? Object.keys(intent.items).map(Number) : []);
    const quests = new Set(intent.kind === 'quest' ? [key(intent.quest)] : []);
    const chosen = new Set<string>();
    for (let pass = 0; pass < 6; pass++) {
        let grew = false;
        for (const method of all.values()) {
            const useful = Object.keys(method.effects.xp ?? {}).some(s => skills.has(key(s)))
                || Object.keys(method.effects.items ?? {}).some(id => items.has(Number(id)))
                || (method.effects.quests ?? []).some(q => quests.has(key(q)))
                || ('objective' in intent && method.effects.outcome === intent.objective);
            if (!useful || chosen.has(method.id)) continue;
            chosen.add(method.id);
            grew = true;
            for (const id of Object.keys({ ...method.inputs, ...method.requirements?.items })) items.add(Number(id));
            for (const skill of Object.keys(method.requirements?.levels ?? {})) {
                if (!Object.entries(account.skills).some(([s, k]) => key(s) === key(skill) && k.level >= method.requirements!.levels![skill]!)) {
                    skills.add(key(skill));
                }
            }
            for (const q of method.requirements?.quests ?? []) quests.add(key(q));
        }
        if (!grew) break;
    }
    const gaps: CatalogGap[] = [];
    const methods: ProgressionMethod[] = [];
    const consumer = intent.kind === 'train'
        ? `${intent.skill} ${intent.targetLevel}`
        : intent.kind === 'train-all'
            ? Object.entries(intent.targets).map(([skill, target]) => `${skill} ${target}`).join(', ')
            : intent.kind === 'quest'
                ? intent.quest
                : 'consumer' in intent
                    ? intent.consumer
                    : intent.objective;
    for (const id of chosen) {
        const original = all.get(id)!;
        const source = options.sources?.[id] ?? options.sources?.[original.step.script] ?? original.source;
        const qualification = options.qualifications?.[id];
        const method = { ...original, source, ...(qualification?.source === source ? { qualification } : {}) };
        if (qualification?.source !== source && method.qualification?.source !== source) delete method.qualification;
        methods.push(method);
        if (method.rate.unitsPerTick === null || Object.values(method.costs).some(v => v === null)) {
            gaps.push({
                method: id,
                action: 'measure',
                consumer,
                source,
                reason: 'Measure whole-job rate and unresolved setup, travel, acquisition or unlock time at this account state',
            });
        }
        if (!method.qualification) {
            gaps.push({
                method: id,
                action: 'build',
                consumer,
                source,
                reason: 'Qualify this executable adapter on matching source and account state bands',
            });
        }
    }
    for (const missing of catalog.unmapped ?? []) {
        if (skills.has(key(missing.skill))) {
            gaps.push({
                method: missing.id,
                action: 'build',
                consumer,
                source: missing.source,
                reason: 'Native method has no exact executable adapter; source substring coverage is not qualification',
            });
        }
    }
    if (!methods.length) {
        gaps.push({ method: 'consumer:' + consumer, action: 'build', consumer, reason: 'No executable catalog method serves the finite consumer' });
    }
    return { methods, gaps };
}
