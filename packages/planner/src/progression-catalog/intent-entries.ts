import { readFileSync } from 'node:fs';
import type {
    CatalogMethod,
    CatalogRoute,
    ProgressionCatalog,
    WorkIntent,
} from '../../../core/src/progression-adapter';
import { finiteLevel, positiveItems, setting, whole } from './catalog';
import type { EnvRecord } from './intent-contracts';

export function shopBuyerIntent(
    script: string,
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    data?: ProgressionCatalog,
): WorkIntent | null {
    const profile = args[0] && !args[0].includes('=') && !/^\d+$/.test(args[0]) ? args[0].toLowerCase() : undefined;
    const explicitTarget = setting(env, args, 'STOCK_TARGET') ?? setting(env, args, 'MAX_ITEMS');
    const explicitItems = setting(env, args, 'ITEMS');
    const bareDefault = (!profile || profile === 'catherby') && !explicitItems && !explicitTarget;
    const count = bareDefault ? 500 : Number(explicitTarget);
    const pattern = bareDefault ? 'arrowtips' : (explicitItems ?? (profile === 'jukat' ? '^dragon longsword$' : undefined));
    if (!whole(count) || count < 1 || !pattern) return null;
    let matches: CatalogMethod[] = [];
    try {
        const re = new RegExp(pattern, 'i');
        matches = (data?.methods ?? []).filter(m => {
            const matchesScript = m.step.script === script
                || (script === 'scripts/shop-buyer.ts' && m.step.script === 'scripts/aio-market.ts')
                || (script === 'scripts/aio-market.ts' && m.step.script === 'scripts/shop-buyer.ts');
            const methodProfile = m.step.script === 'scripts/aio-market.ts' && m.step.args[0] === 'shop-buy'
                ? m.step.args[1]
                : m.step.args[0];
            return matchesScript
                && methodProfile === (profile ?? 'catherby')
                && m.step.env.ITEMS
                && re.test(m.step.env.ITEMS.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1'));
        });
    } catch {
        return null;
    }
    const ids = [...new Set(matches.flatMap(m => Object.keys(m.effects.items ?? {})))];
    if (ids.length === 1) return { kind: 'acquire', items: { [Number(ids[0])]: count }, consumer };
    return { kind: 'service', objective: `finite shop order ${profile ?? 'catherby'} ${pattern} stock ${count} for ${consumer}` };
}

export function smeltOrProductionIntent(
    stem: string,
    script: string,
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    data?: ProgressionCatalog,
): WorkIntent | null | undefined {
    if (stem === 'smelt-bars' && (setting(env, args, 'ORDER_ACTION') === 'smith' || setting(env, args, 'PRODUCT_ID') !== undefined)) {
        const product = Number(setting(env, args, 'PRODUCT_ID'));
        const maximum = Number(setting(env, args, 'MAX_MAKE'));
        if (whole(product) && product > 0 && whole(maximum) && maximum > 0) {
            return { kind: 'service', objective: `smith-anvil:${product}:${maximum}`, units: 1 };
        }
        return null;
    }
    const recipe = stem === 'microbot-production'
        ? args.find(a => !a.includes('=') && !/^\d+$/.test(a))
        : setting(env, args, 'BAR_TYPE') ?? args[1];
    const maximum = Number(setting(env, args, 'MAX_MAKE'));
    const method = data?.methods.find(m => {
        const job = m.execution?.bankJob;
        return stem === 'microbot-production'
            ? !!job && job.family === 'inventory' && job.recipe === recipe
            : m.step.script === script && m.step.args[1] === recipe;
    });
    const items = method && Object.fromEntries(Object.entries(method.effects.items ?? {}).map(([id, n]) => [id, n * maximum]));
    if (whole(maximum) && maximum > 0 && positiveItems(items)) return { kind: 'produce', items: items!, consumer };
    if (stem === 'smelt-bars') {
        // A smelt order with no product count: its tick cap is the bound.
        const bar = setting(env, args, 'BAR_TYPE') ?? args.find(a => !/^\d+$/.test(a) && !a.includes('=')) ?? 'bronze';
        const capText = setting(env, args, 'CAP') ?? args.find(a => /^\d+$/.test(a));
        const cap = capText === undefined ? 15000 : Number(capText);
        if (whole(cap) && cap > 0) return { kind: 'service', objective: `smelt:${bar}`, units: 1 };
    }
    return undefined;
}

export function aioBankJobIntent(
    args: readonly string[],
    consumer: string,
    data?: ProgressionCatalog,
): WorkIntent | null | undefined {
    try {
        const raw = args[1] ?? '';
        const job = JSON.parse(raw.startsWith('--job=') ? decodeURIComponent(raw.slice(6)) : readFileSync(raw, 'utf8'));
        const method = data?.methods.find(m => {
            const profile = m.execution?.bankJob;
            return !!profile && profile.family === job.family && profile.recipe === job.recipe;
        });
        const skill = method && Object.keys(method.effects.xp ?? {})[0];
        if (skill && finiteLevel(job.targetLevel)) return { kind: 'train', skill, targetLevel: job.targetLevel };
        const product = method && Object.keys(method.effects.items ?? {})[0];
        if (product && whole(job.target) && job.target > 0) return { kind: 'produce', items: { [Number(product)]: job.target }, consumer };
        // A catalog recipe with no product row: the count of the job is the bound.
        if (method && whole(job.target) && job.target > 0) return { kind: 'service', objective: `bank-job:${job.family}:${job.recipe}`, units: job.target };
        return undefined;
    } catch {
        return null;
    }
}

const PROGRESSIVE_TRIP_ENTRIES = new Set([
    'microbot-village-fishing',
    'microbot-mining-progressive',
    'microbot-production-progressive',
    'microbot-magic-trip',
    'microbot-pickpocket-trip',
    'microbot-rune-trip',
    'microbot-shade-trip',
    'microbot-loot-trip',
    'microbot-shop-trip',
    'fletch-worker',
]);

// These nine workers run to their own default tick cap, so a bare entry is finite.
const DEFAULT_CAP_SERVICE_ENTRIES = [
    'gather-flax', 'spin-bowstrings', 'fletch-arrows', 'gather-fish', 'cook-food', 'gather-yews', 'gather-ore', 'gather-essence', 'blood-chest',
] as const;

const DEFAULT_CAP_ENTRIES = new Set<string>(DEFAULT_CAP_SERVICE_ENTRIES);

const BOUNDED_SERVICE_ENTRIES = new Set<string>([
    ...DEFAULT_CAP_SERVICE_ENTRIES,
    'craft-jewelry', 'shark-supply', 'cook-stock', 'cook-wine', 'microbot-b-cooking', 'microbot-glass', 'druid-meats', 'goldfarm-stable', 'microbot-c-stalls',
    'collect-wool', 'fishcook', 'microbot-b-fishing', 'microbot-wine', 'microbot-b-mining', 'microbot-mining-drop', 'microbot-b-mining-loot', 'microbot-b-jewellery',
    'microbot-c-tanner', 'soften-clay', 'microbot-magic-npc', 'microbot-magic-teleport', 'microbot-c-orbs', 'microbot-bones', 'microbot-a-pickpocket',
    'microbot-b-nature-chest', 'microbot-c-care', 'microbot-misc-coffer', 'microbot-c-qol', 'grapes', 'agility-order', 'magic-order', 'alch-train', 'splash-train',
    'train-prayer', 'microbot-prayer-flick', 'firemaking-order', 'firemaking-line', 'rune-bank-craft', 'rune-supply',
    'cannon-fight', 'gather-fire-combat', 'gather-fire-giants', 'gather-imps', 'gather-ranged', 'microbot-a-ranged-camp', 'microbot-chompy-trip', 'microbot-a-chompy',
    'microbot-b-kbd', 'microbot-trawler-trip', 'microbot-b-trawler', 'pvp-kit-stage', 'buy-owned-sword', 'sell-owned-ge-item', 'foodcourier', 'supply-bootstrap',
    'microbot-c-clues', 'microbot-c-clue-guardian', 'microbot-c-clue-puzzle', 'quest-cook-job', 'quest-order', 'quest-items-order', 'quest-sweep',
    'generated/quest-hero-owned', 'generated/quest-legends-owned', 'generated/quest-tbwt-owned', 'generated/quest-itwatchtower-owned',
    'owned-logistics-entry', 'ranged-progression-case', 'crystal-chest', 'charge-glory',
]);

export function entryNameServiceIntent(
    entryName: string,
    script: string,
    args: readonly string[],
    env: EnvRecord,
    consumer: string,
    routes: readonly CatalogRoute[],
): WorkIntent | null | undefined {
    if (entryName === 'edgeville-woodcut-order') {
        const stall = env.STALL_TICKS === undefined ? 0 : Number(env.STALL_TICKS);
        return whole(stall) ? { kind: 'train', skill: 'woodcutting', targetLevel: 36 } : null;
    }
    if (entryName === 'microbot-magic-items') {
        const mode = args[0] ?? '';
        const count = Number(args[2] ?? 1);
        const cap = Number(args[3] ?? 200);
        return /^(?:low-alch|high-alch|enchant:\w+|superheat:(?:bronze|iron|silver|steel|gold|mithril|adamantite|runite))$/.test(mode)
            && whole(count) && count >= 1 && count <= 10000
            && whole(cap) && cap >= 1 && cap <= 100000
            ? { kind: 'service', objective: `magic-items:${mode}:${count}`, units: 1 }
            : null;
    }
    if (entryName === 'dusty-key') return { kind: 'acquire', items: { 1590: 1 }, consumer };
    if (entryName === 'quest-chain') {
        const quests = (args[0] || '').split(',').filter(Boolean);
        if (quests.length) return { kind: 'service', objective: 'quest-chain:' + quests.join(','), units: quests.length };
    }
    if (entryName === 'goldfarm') {
        const ticks = Number(env.TICKS ?? 9000);
        if (whole(ticks) && ticks > 0) return { kind: 'service', objective: `goldfarm:${env.KNIGHT_SPOT ?? '2653,3302'}`, units: 1 };
    }
    if (entryName === 'gather-feathers') {
        const feathers = Number(env.TARGET ?? 2000);
        const ticks = Number(env.TICKS ?? 3000);
        if (whole(feathers) && feathers > 0 && whole(ticks) && ticks > 0) return { kind: 'acquire', items: { 314: feathers }, consumer };
    }
    if (entryName === 'black-dragon-camp') {
        const kills = Number(setting(env, args, 'KILLS') ?? 9);
        if (whole(kills) && kills > 0) return { kind: 'service', objective: 'black-dragon-camp', units: kills };
    }
    if (entryName === 'black-dhide-sets') return { kind: 'service', objective: 'black-dhide-sets', units: 1 };
    if (entryName === 'gather-combat' && setting(env, args, 'GIANT_BURY') === '1') {
        const kills = Number(setting(env, args, 'GIANT_KILLS'));
        if (whole(kills) && kills > 0) return { kind: 'service', objective: 'trooper-bury', units: kills };
    }
    if (entryName === 'gather-combat') {
        const combatTarget = setting(env, args, 'TARGET') ?? args[1];
        const capText = setting(env, args, 'CAP') ?? args[0];
        const cap = capText === undefined ? 6000 : Number(capText);
        if (combatTarget && combatTarget !== 'trooper' && whole(cap) && cap > 0) {
            return { kind: 'service', objective: 'gather-combat:' + combatTarget, units: 1 };
        }
        return null;
    }
    if (PROGRESSIVE_TRIP_ENTRIES.has(entryName)) {
        const jobFile = args.find(a => a.endsWith('.json'));
        if (jobFile || entryName === 'microbot-rune-trip') {
            return { kind: 'service', objective: `${script}:${jobFile ?? 'default'}`, units: 1 };
        }
    }
    if (entryName === 'rune-bank-craft' && args.some(a => a.startsWith('--staged='))) {
        return { kind: 'service', objective: 'rune-carriers', units: 1 };
    }
    if (entryName === 'pvp-relog-combat') {
        const capText = setting(env, args, 'CAP') ?? (args[0] === '--companion-tank' ? args[4] : undefined);
        const cap = capText === undefined ? 5000 : Number(capText);
        if (whole(cap) && cap > 0 && cap <= 20000) {
            if (args[0] === '--companion-tank') return { kind: 'service', objective: 'pvp-relog-tank', units: 1 };
            return { kind: 'service', objective: 'pvp-relog-combat:' + (args[0] ?? 'combat'), units: 1 };
        }
        return null;
    }
    if (BOUNDED_SERVICE_ENTRIES.has(entryName)) {
        // The entry states its bound: a CAP or TICKS setting, or a count among its positional arguments. No number, a zero
        // or a fraction is no finite goal.
        // A bound in a flag is a stated bound too: quest-order states its time limit as --timeout-ms=<ms>.
        const stated = [
            setting(env, args, 'CAP'),
            setting(env, args, 'TICKS'),
            ...args.filter(a => /^-?\d+(?:\.\d+)?$/.test(a)),
            ...args.flatMap(a => /^--timeout-ms=(.*)$/.exec(a)?.[1] ?? []),
        ].filter(v => v !== undefined);
        if ((!stated.length && !DEFAULT_CAP_ENTRIES.has(entryName)) || stated.some(v => !whole(Number(v)) || Number(v) <= 0)) {
            return null;
        }
        const label = args.find(a => !/^\d+$/.test(a) && !a.includes('=') && !a.startsWith('-')) ?? routes[0]?.id ?? script;
        return { kind: 'service', objective: `${entryName}:${label}`, units: 1 };
    }
    return undefined;
}
