import { parseStep } from '../../../core/src/chain-step';
import type { CatalogAccept, ProgressionCatalog, WorkIntent } from '../../../core/src/progression-adapter';
import {
    AIO_CATEGORIES,
    AIO_WRAPPER_RE,
    PROGRESSION_SKILLS,
    entryNameOf,
    finiteLevel,
    key,
    matchingProgressionRoutes,
    optionalProgressionCatalog,
    positiveItems,
    scriptPath,
    scriptStem,
    setting,
    whole,
} from './catalog';
import {
    cannonFightIntent,
    coinTransferIntent,
    geProofIntent,
    handoffInputsIntent,
    jewelleryTripIntent,
    makeWineOrderIntent,
    microbotBankSellerIntent,
    microbotGeTripIntent,
    rangedLivePrepIntent,
    shopToBidIntent,
    trainPrayerIntent,
    trainingIntent,
    type EnvRecord,
} from './intent-contracts';
import {
    aioBankJobIntent,
    entryNameServiceIntent,
    shopBuyerIntent,
    smeltOrProductionIntent,
} from './intent-entries';

const SPECIALIST_GATHERING = new Map<string, string>([
    ['fletching-specialist', 'fletching'],
    ['fishing-specialist', 'fishing'],
    ['mining-specialist', 'mining'],
    ['thieving-specialist', 'thieving'],
    ['cooking-specialist', 'cooking'],
    ['firemaking-specialist', 'firemaking'],
    ['woodcutting-specialist', 'woodcutting'],
]);

const FAST_SKILL_SPECIALISTS: Readonly<Record<string, { skill: string; cap: number }>> = {
    'crafting-specialist': { skill: 'crafting', cap: 250 },
    'herblore-specialist': { skill: 'herblore', cap: 600 },
    'prayer-specialist': { skill: 'prayer', cap: 1350 },
    'smithing-specialist': { skill: 'smithing', cap: 1350 },
    'runecraft-specialist': { skill: 'runecraft', cap: 2300 },
    'magic-specialist': { skill: 'magic', cap: 1300 },
};

const FIXED_SPECIALIST_TRAINS: Readonly<Record<string, { skill: string; targetLevel: number }>> = {
    'hp-specialist': { skill: 'hitpoints', targetLevel: 99 },
    'strength-specialist': { skill: 'strength', targetLevel: 99 },
    'defence-specialist': { skill: 'defence', targetLevel: 99 },
    'ranged-starter': { skill: 'ranged', targetLevel: 5 },
};

const TRAINER_DEFAULTS: Readonly<Record<string, { skill: string; target: number; cap: number; minimumCap: number }>> = {
    'generated/fishing30': { skill: 'fishing', target: 30, cap: 3000, minimumCap: 1 },
    'generated/thieving60': { skill: 'thieving', target: 60, cap: 2500, minimumCap: 240 },
    'generated/woodcutting': { skill: 'woodcutting', target: 45, cap: 3000, minimumCap: 1 },
};

function specialistSkillIntent(
    stem: string | null,
    args: readonly string[],
    env: EnvRecord,
): WorkIntent | null | undefined {
    if (!stem) return undefined;
    const gathering = SPECIALIST_GATHERING.get(stem);
    if (gathering) return { kind: 'service', objective: `fresh-clock ${gathering} 99 specialist`, units: 1 };
    const spec = FAST_SKILL_SPECIALISTS[stem];
    if (!spec) return undefined;
    const cap = Number(setting(env, args, 'CAP') ?? (/^\d+$/.test(args[0] ?? '') ? args[0] : String(spec.cap)));
    const target = Number(setting(env, args, 'TARGET') ?? setting(env, args, 'TARGET_LEVEL') ?? '99');
    if (!whole(cap) || cap < 1 || !finiteLevel(target)) return null;
    return { kind: 'service', objective: `specialist:${spec.skill}:${target}`, units: 1 };
}

function fixedPreCatalogIntent(
    stem: string | null,
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
): WorkIntent | null | undefined {
    if (!stem) return undefined;
    const fixedTrain = FIXED_SPECIALIST_TRAINS[stem];
    if (fixedTrain) return { kind: 'train', ...fixedTrain };
    if (stem === 'generated/rcair') return { kind: 'service', objective: 'craft current carried rune essence into air runes once', units: 1 };
    if (stem === 'pvp-kit-stage') {
        const cap = Number(args[0] ?? 1800);
        return whole(cap) && cap >= 1 && cap <= 2000 ? { kind: 'acquire', items: { 1985: 2 }, consumer } : null;
    }
    if (stem === 'gather-spawn') {
        const id = Number(args[0]);
        const count = Number(args[1] ?? 27);
        const ticks = Number(env.TICKS ?? 6000);
        return whole(id) && id > 0 && whole(count) && count > 0 && Number.isFinite(ticks) && ticks > 0
            ? { kind: 'acquire', items: { [id]: count }, consumer }
            : null;
    }
    if (stem === 'microbot-a-cannonballs') {
        const bars = Number(args[0] ?? 1);
        const cap = Number(args[1] ?? 1200);
        const xp = Number(env.CANNON_XP_RATE ?? 1);
        const reserve = Number(env.CANNON_RESERVE ?? 0);
        return whole(bars) && bars >= 1 && bars <= 100000 && whole(cap) && cap >= 1 && cap <= 10000 && whole(xp) && xp >= 1 && xp <= 1000 && whole(reserve)
            ? { kind: 'produce', items: { 2: bars * 4 }, consumer }
            : null;
    }
    const trainer = TRAINER_DEFAULTS[stem];
    if (trainer) {
        const target = Number(env.TARGET ?? trainer.target);
        const cap = Number(env.CAP ?? trainer.cap);
        return finiteLevel(target) && whole(cap) && cap >= trainer.minimumCap ? { kind: 'train', skill: trainer.skill, targetLevel: target } : null;
    }
    if (stem === 'ranged-train') {
        const num = (value: string | undefined, fallback: number) => value === undefined || value === '' ? fallback : Number(value);
        const target = num(args[0] ?? env.TARGET_LEVEL, 10);
        const cap = num(args[1] ?? env.CAP, 3000);
        return finiteLevel(target) && target >= 2 && whole(cap) && cap >= 800 ? { kind: 'train', skill: 'ranged', targetLevel: target } : null;
    }
    return undefined;
}

function catalogEntryIntent(
    stem: string | null,
    script: string,
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    accept: CatalogAccept | undefined,
    data: ProgressionCatalog | undefined,
): WorkIntent | null | undefined {
    if (stem === 'aio-market') {
        const mode = args[0]?.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '');
        if (!mode) return null;
        const modeArgs: string[] = [];
        const modeEnv: Record<string, string | undefined> = { ...env };
        for (const token of args.slice(1)) {
            const match = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
            if (match) modeEnv[match[1]!] = match[2]!;
            else modeArgs.push(token);
        }
        switch (mode) {
            case 'shop-buy':
                return shopBuyerIntent(script, modeArgs, modeEnv, consumer, data);
            case 'earth-shop':
                return catalogEntryIntent('earth-shop', script, modeArgs, modeEnv, consumer, accept, data);
            case 'buy-sword':
                return { kind: 'service', objective: 'buy-owned-sword', units: 1 };
            case 'shop-trip':
            case 'shop-sell':
                return modeArgs[0]?.endsWith('.json')
                    ? { kind: 'service', objective: `market:${mode}:${modeArgs[0]}`, units: 1 }
                    : null;
            case 'ge-buy':
                return catalogEntryIntent('buy-owned-ge-item', script, modeArgs, modeEnv, consumer, accept, data);
            case 'ge-sell':
                return catalogEntryIntent('sell-owned-ge-item', script, modeArgs, modeEnv, consumer, accept, data);
            case 'ge-trip':
                return microbotGeTripIntent(modeArgs);
            case 'bank-seller':
                return microbotBankSellerIntent(modeArgs);
            case 'shop-to-bid':
                return shopToBidIntent(modeArgs, modeEnv);
            case 'ge-buy-list':
            case 'ge-plan':
                return modeArgs[0]?.endsWith('.json')
                    ? { kind: 'service', objective: `market:${mode}:${modeArgs[0]}`, units: 1 }
                    : null;
            default:
                return null;
        }
    }
    if (stem === 'buy-owned-ge-item') {
        const item = Number(setting(env, args, 'ITEM_ID'));
        const quantity = Number(setting(env, args, 'QUANTITY'));
        const owned = Number(setting(env, args, 'EXPECTED_OWNED') ?? 0);
        if (whole(item) && item > 0 && whole(quantity) && quantity > 0 && whole(owned) && whole(owned + quantity)) {
            return { kind: 'acquire', items: { [item]: owned + quantity }, consumer };
        }
        return undefined;
    }
    if (stem === 'sell-owned-ge-item') {
        const item = Number(setting(env, args, 'ITEM_ID'));
        const quantity = Number(setting(env, args, 'QUANTITY'));
        const price = Number(setting(env, args, 'SELL_PRICE'));
        const floor = Number(setting(env, args, 'FLOOR_PRICE'));
        const reserve = Number(setting(env, args, 'RESERVE_ITEMS') ?? 0);
        const wait = Number(setting(env, args, 'FILL_WAIT_TICKS') ?? 40);
        const capText = setting(env, args, 'CAP') ?? setting(env, args, 'TICKS');
        if (
            whole(item) && item > 0 && item !== 995 && whole(quantity) && quantity > 0 && whole(price) && whole(floor) && floor > 0 && price >= floor
            && whole(price * quantity) && price * quantity <= 2147483647 && whole(reserve) && whole(wait) && wait <= 200
            && (capText === undefined || (whole(Number(capText)) && Number(capText) > 0))
        ) {
            return { kind: 'service', objective: `sell-owned-ge-item:${item}:${quantity}:${price}`, units: 1 };
        }
        return undefined;
    }
    if (stem === 'microbot-ge-trip') return microbotGeTripIntent(args);
    if (stem === 'microbot-bank-seller') return microbotBankSellerIntent(args);
    if (stem === 'shop-to-bid') return shopToBidIntent(args, env);
    if (stem === 'earth-shop') {
        const profile = args[0];
        const cap = Number(args[1]);
        const target = Number(setting(env, args, 'STOCK_TARGET'));
        const maximum = Number(setting(env, args, 'MAX_ITEMS'));
        const spend = Number(setting(env, args, 'MAX_SPEND'));
        const reserve = Number(setting(env, args, 'COIN_RESERVE'));
        const seedUsed = Number(setting(env, args, 'EARTH_SEED_USED') ?? 0);
        return (profile === 'aubury' || profile === 'betty') && [cap, target, maximum, spend, reserve].every(whole) && [0, 1].includes(seedUsed) && cap >= 1 && cap <= 16000 && target >= 1 && maximum >= 1 && maximum <= target
            ? { kind: 'acquire', items: { 557: target }, consumer }
            : null;
    }
    if (stem === 'earth-production') {
        const mode = args[0];
        const cap = Number(args[1]);
        const target = Number(setting(env, args, 'STOCK_TARGET'));
        const reserve = Number(setting(env, args, 'COIN_RESERVE'));
        const kills = Number(setting(env, args, 'HUNT_KILLS_PER_TARGET') ?? 0);
        return (mode === 'talismans' || mode === 'craft') && [cap, target, reserve, kills].every(whole) && cap >= 1 && cap <= 20000 && target >= 1 && kills >= 0 && kills <= 3
            ? { kind: 'acquire', items: { 557: target }, consumer }
            : null;
    }
    if (stem === 'shop-buyer') return shopBuyerIntent(script, args, env, consumer, data);
    if (stem === 'chain') {
        const steps = args.map(a => parseStep(a));
        if (!steps.length) return null;
        const resolved = steps.map(st => intentForEntry(st.script, st.args, { ...env, ...st.env }, accept, data));
        if (resolved.some(r => !r)) return null;
        const last = resolved.at(-1)!;
        return last.kind === 'service' || last.kind === 'observe'
            ? { kind: 'service', objective: `chain:${steps.map(s => s.script).join('+')}`, units: steps.length }
            : last;
    }
    if (stem === 'aio-logistics') {
        const rawRole = args[0]?.toLowerCase().replace(/^--role=/, '') ?? '';
        const rest = args.slice(1);
        if (rawRole === 'charge-glory' || rawRole === 'food-courier' || rawRole === 'supply-bootstrap') {
            const mapped = rawRole === 'food-courier' ? 'foodcourier' : rawRole;
            const routes = data ? matchingProgressionRoutes(script, args, env, data) : [];
            const direct = entryNameServiceIntent(mapped, script, rest, env, consumer, routes);
            if (direct !== undefined) return direct;
        }
        const serviceRoles = new Set([
            'banker', 'give-to-banker', 'take-from-banker', 'supply-holder',
            'supply-chain', 'loadout', 'loadout-import', 'bank-sort',
            'walk-to', 'walk-edge', 'relocate-bank', 'relocate-knight', 'arrive-draynor',
            'restore-prayer', 'cure-poison', 'recover-trapped', 'food-chain',
        ]);
        if (serviceRoles.has(rawRole)) {
            return { kind: 'service', objective: `logistics:${rawRole}`, units: 1 };
        }
        if (['coin-fanout', 'item-fanin', 'note-courier'].includes(rawRole)) {
            return rest.length > 0 ? { kind: 'service', objective: `logistics:${rawRole}`, units: 1 } : null;
        }
        if (!rawRole && env.REQUIRE_BANK === '1') {
            return { kind: 'observe', objective: 'logistics:inspect', units: 1 };
        }
        return null;
    }
    if (stem === 'fleet-trade' || stem === 'courier-handoff') {
        const file = args.find(a => a.endsWith('.json') && !a.includes('='));
        return file ? { kind: 'service', objective: 'finite owned order ' + file } : null;
    }
    if (stem === 'microbot-production' || stem === 'smelt-bars') {
        const produced = smeltOrProductionIntent(stem, script, args, env, consumer, data);
        if (produced !== undefined) return produced;
    }
    if (stem === 'aio-skiller' && args[0] === 'bank-job') {
        const bankJob = aioBankJobIntent(args, consumer, data);
        if (bankJob !== undefined) return bankJob;
    }
    const target = Number(setting(env, args, 'TARGET_LEVEL'));
    if (stem === 'aio-skiller' && args[0] && finiteLevel(target)) {
        return PROGRESSION_SKILLS.includes(key(args[0]) as typeof PROGRESSION_SKILLS[number])
            ? { kind: 'train', skill: key(args[0]), targetLevel: target }
            : null;
    }
    return undefined;
}

/** Resolves the finite work intent for a script invocation and optional parent acceptance. */
// Declared finite output owns the intent. Side XP never changes a quest or item order into a trainer.
export function intentForEntry(
    script: string,
    args: readonly string[] = [],
    env: EnvRecord = {},
    accept?: CatalogAccept,
    catalog?: ProgressionCatalog,
): WorkIntent | null {
    script = scriptPath(script);
    const stem = scriptStem(script);
    if (stem === 'aio-logistics') {
        const rawRole = args[0]?.toLowerCase().replace(/^--role=/, '') ?? '';
        const rest = args.slice(1);
        if (rawRole === 'coin-courier') return coinTransferIntent(rest, env);
        if (rawRole === 'wine-stock') return makeWineOrderIntent(rest, accept);
        if (rawRole === 'specialist-supplier') return { kind: 'service', objective: 'stage or hand off specialist supply kit', units: 1 };
        if (rawRole === 'gathering-supplier') return { kind: 'service', objective: 'hand off gathering specialist supply kit', units: 1 };
        if (rawRole === 'inspect') return { kind: 'observe', objective: 'logistics:inspect', units: 1 };
        if (rawRole === 'fleet-trade') {
            const file = rest.find(a => !a.includes('=') && !a.startsWith('-'));
            return file && file.endsWith('.json') && !file.includes('\0')
                ? { kind: 'service', objective: `finite owned order ${file}` }
                : null;
        }
    }
    if (stem === 'coin-courier') return coinTransferIntent(args, env);
    const consumer = setting(env, args, 'CONSUMER') ?? setting(env, args, 'GOAL') ?? script;
    if (stem === 'make-wine-order') return makeWineOrderIntent(args, accept);
    const requestedItems = positiveItems(accept?.bank);
    if (stem === 'train-prayer' && requestedItems && accept) {
        const prayer = trainPrayerIntent(args, env, accept, requestedItems);
        if (prayer) return prayer;
    }
    if (requestedItems) return { kind: 'acquire', items: { ...requestedItems }, consumer };
    if (accept?.quests?.length === 1 && accept.quests[0]?.trim()) return { kind: 'quest', quest: accept.quests[0] };
    const specialist = specialistSkillIntent(stem, args, env);
    if (specialist !== undefined) return specialist;
    const acceptedSkills = Object.entries(accept?.skills ?? {});
    if (stem === 'cannon-fight') return cannonFightIntent(args, env, consumer, acceptedSkills, accept);
    if (stem === 'attack-specialist') {
        const skills = accept?.skills ? Object.entries(accept.skills) : [];
        if ((!skills.length || (skills.length === 1 && skills[0]![0].toLowerCase() === 'attack' && skills[0]![1] === 99)) && !Object.keys(accept?.bank ?? {}).length && !(accept?.quests?.length)) {
            return { kind: 'service', objective: 'fresh-clock Attack 99 specialist route', units: 1 };
        }
    }
    if (stem === 'ranged-specialist') {
        const skills = accept?.skills ? Object.entries(accept.skills) : [];
        if ((!skills.length || (skills.length === 1 && key(skills[0]![0]) === 'ranged' && skills[0]![1] === 99)) && !Object.keys(accept?.bank ?? {}).length && !(accept?.quests?.length)) {
            return { kind: 'service', objective: 'fresh-clock Ranged 99 specialist route', units: 1 };
        }
    }
    if (stem === 'specialist-supplier') return { kind: 'service', objective: 'stage or hand off specialist supply kit', units: 1 };
    if (stem === 'gathering-supplier') return { kind: 'service', objective: 'hand off gathering specialist supply kit', units: 1 };
    if (stem === 'ranged-live-prep') return rangedLivePrepIntent(args, env);
    if (stem === 'agility-specialist') return { kind: 'service', objective: 'skiller:agility:specialist', units: 1 };
    if (acceptedSkills.length) return trainingIntent(accept!.skills!);
    // Native GE counterparties have finite fixture work, admitted only on local practice.
    if (script === 'packages/practice/src/ge-bulk-order-proof.ts') return geProofIntent(args);
    if (stem === 'handoff-inputs') return handoffInputsIntent(args, env);
    if (stem === 'aio') {
        const category = args[0];
        const entry = category && (AIO_CATEGORIES as readonly string[]).includes(category) ? category : args[1];
        if (entry) return intentForEntry('scripts/aio-' + entry + '.ts', args.slice(entry === category ? 1 : 2), env, accept, catalog);
    }
    const fixed = fixedPreCatalogIntent(stem, args, env, consumer);
    if (fixed !== undefined) return fixed;
    const trainingSkill = setting(env, args, 'TRAIN_SKILL');
    let target = Number(setting(env, args, 'TARGET_LEVEL'));
    if (trainingSkill && finiteLevel(target) && PROGRESSION_SKILLS.includes(key(trainingSkill) as typeof PROGRESSION_SKILLS[number])) {
        return { kind: 'train', skill: key(trainingSkill), targetLevel: target };
    }
    const data = catalog ?? optionalProgressionCatalog();
    if (stem === 'microbot-jewellery-trip') return jewelleryTripIntent(args, env, consumer, data);
    if (AIO_WRAPPER_RE.test(script) && data) {
        const matches = matchingProgressionRoutes(script, args, env, data);
        if (matches.length === 1) {
            const route = matches[0]!;
            const skip = route.category === 'skiller' ? 2 : 1;
            const supplied = parseStep([route.script, ...args.slice(skip).map(a => JSON.stringify(a))].join(' '));
            if (route.script !== script) {
                return intentForEntry(route.script, supplied.args.length ? supplied.args : route.args, { ...env, ...route.env, ...supplied.env }, accept, data);
            }
        }
    }
    const matching = data?.entries.find(e => e.script === script);
    const routes = data?.routes.filter(r => r.script === script) ?? [];
    const entryOrder = catalogEntryIntent(stem, script, args, env, consumer, accept, data);
    if (entryOrder !== undefined) return entryOrder;
    const quest = data?.quests.find(q => q.script === script || (stem === 'quest-sweep' && args.includes(q.id)));
    if (quest) return { kind: 'quest', quest: quest.name };
    const singleSkill = matching?.skills.length === 1 ? matching.skills[0] : undefined;
    if (singleSkill && matching?.intents.includes('train')) {
        const positional = routes.find(r => r.skills.includes(singleSkill))?.name;
        target = Number(setting(env, args, 'TARGET_LEVEL') ?? setting(env, args, 'TARGET') ?? (/agility|runecraft|prayer|alch|splash/.test(positional ?? '') ? args.find(a => /^\d+$/.test(a)) : undefined));
        if (finiteLevel(target)) return { kind: 'train', skill: singleSkill, targetLevel: target };
    }
    const entryName = entryNameOf(script);
    const service = entryNameServiceIntent(entryName, script, args, env, consumer, routes);
    if (service !== undefined) return service;
    if (matching?.intents.includes('pvp')) return { kind: 'pvp', objective: routes[0]?.id ?? script };
    if (matching?.intents.length === 1 && matching.intents[0] === 'observe') return { kind: 'observe', objective: routes[0]?.id ?? script };
    if (matching?.intents.length === 1 && matching.intents[0] === 'service') return { kind: 'service', objective: routes[0]?.id ?? script };
    return null;
}
