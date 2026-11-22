// Trade order selection, swarm plan job/resource claim extraction, and Brain spot-allocation claims.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateBankRouteJob, type BankRouteJob } from '../../core/src/bank-trip';
import { parseStep, tokenizeStep, type Step } from '../../core/src/chain-step';
import type { Order, Receipt, TradeRole } from '../../core/src/fleet-trade-settlement';
import { repoRoot } from '../../core/src/practice-paths';
import { resolveRouteStep, resolveSkillerMethod } from '../../core/src/route-step';

export const CLAIM_MAX_AGE_MS = 2 * 3600_000;

export const KNIGHT_SPOTS = ['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'];
export const COW_FIELD = 'cow:ardougne-north';
export const TROOPER_FIELD = 'trooper:battlefield';
export const BLACK_CAVE = 'cave:taverley-black-dragons';
export const SPLASH_FENCE = 'splash:ardougne-cow-fence';
export const STRIKE_TILE = 'strike:ardougne-guard-dog';
export const AIO_PLACES = {
    flax: 'aio:seers-flax',
    yews: 'aio:seers-yews',
    ore: 'aio:varrock-east-mine',
    essence: 'aio:essence-mine',
    air: 'aio:air-altar',
    blood: 'aio:ardougne-blood-chests',
} as const;

export type ResourceJob = {
    script?: string;
    args?: string[];
    env?: Record<string, string>;
    resources?: string[];
    host?: boolean;
    orchestrate?: boolean;
    accounts?: string[];
    envByAccount?: Record<string, Record<string, string>>;
};

export function jobAccounts(job: { account?: unknown; accounts?: unknown } | null | undefined): string[] {
    if (!job) return [];
    if (Array.isArray(job.accounts)) return job.accounts.filter((n): n is string => typeof n === 'string' && n.length > 0);
    return typeof job.account === 'string' && job.account ? [job.account] : [];
}

function resourceSteps(step: Step, inherited: Record<string, string>, depth = 0): Step[] {
    if (depth > 8) throw Error('resource admission: nested chain or AIO pipeline too deep');
    const file = step.script.replace(/\\/g, '/').replace(/^\.\//, ''), env = { ...inherited, ...step.env };
    if (file === 'scripts/chain.ts') return step.args.flatMap(text => resourceSteps(parseStep(text), env, depth + 1));
    const wrapper = /^scripts\/aio-(skiller|fighter|boss|market)\.ts$/.exec(file);
    if (file !== 'scripts/aio.ts' && !wrapper) return [{ script: file, args: step.args, env }];
    const [categoryInput, ...categoryArgs] = wrapper ? [wrapper[1]!, ...step.args] : step.args;
    const category = categoryInput?.toLowerCase().replace(/^--category=/, '');
    if (category === 'pipeline') {
        return categoryArgs.flatMap(text => {
            const [head, ...rest] = tokenizeStep(text);
            if (!head) throw Error('resource admission: empty AIO pipeline step');
            const [cat, ...route] = head.includes(':') ? head.split(':') : [head];
            if (cat === 'quester' && route[0] === 'mode') route.shift();
            return resourceSteps({ script: 'scripts/aio.ts', args: [cat!, ...route, ...rest], env: {} }, env, depth + 1);
        });
    }
    let spec: { script: string; defaultArgs?: readonly string[]; defaultEnv?: Readonly<Record<string, string>> } | undefined;
    let rest: string[] = [];
    if (category === 'fighter') {
        const [target, ...extra] = categoryArgs, key = target?.toLowerCase().replace(/^--target=/, '');
        if (key === 'cow' || key === 'giant' || key === 'druid' || key === 'trooper') spec = { script: 'scripts/gather-combat.ts', defaultEnv: { TARGET: key } };
        if (key === 'chicken') spec = { script: 'scripts/train-chickens.ts', defaultEnv: { TRAIN_BANK: 'draynor' } };
        if (key === 'ranged') spec = { script: 'scripts/ranged-train.ts' };
        rest = extra;
    } else if (category === 'boss') {
        if (categoryArgs[0]?.toLowerCase().replace(/^--boss=/, '') === 'black-dragon') spec = { script: 'scripts/black-dragon-camp.ts' };
        rest = categoryArgs.slice(1);
    } else if (category === 'market') {
        const mode = categoryArgs[0]?.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '');
        if (!mode) return [];
        const resolved = resolveRouteStep({ script: 'scripts/aio-market.ts' }, categoryArgs.slice(1));
        return [{ script: 'scripts/aio-market.ts', args: [mode, ...resolved.args], env: { ...resolved.env, ...env } }];
    } else if (category === 'skiller') {
        const [skillInput, methodInput, ...extra] = categoryArgs, skill = skillInput?.toLowerCase().replace(/^--skill=/, '');
        if (skill === 'bank-job') return [{ script: 'scripts/aio-skiller.ts', args: ['bank-job', ...categoryArgs.slice(1)], env }];
        if (skill === 'gather') {
            const [, gSkill, gMethod, ...gRest] = categoryArgs;
            const parsed = resolveRouteStep({ script: 'scripts/aio-skiller.ts' }, gRest);
            return [{ script: 'scripts/aio-skiller.ts', args: ['gather', gSkill ?? '', gMethod ?? '', ...parsed.args], env: { ...inherited, ...parsed.env, ...step.env } }];
        }
        const { method, args } = resolveSkillerMethod(skill ?? '', methodInput, extra);
        rest = args;
        const aliases: Readonly<Record<string, string>> = {
            'woodcutting:gather-yews': 'woodcutting:yews',
            'foraging:gather-flax': 'foraging:flax',
            'foraging:gather-feathers': 'foraging:feathers',
            'mining:gather-ore': 'mining:ore',
            'mining:gather-essence': 'mining:essence',
            'thieving:blood-chest': 'thieving:blood-chest',
            'thieving:goldfarm': 'thieving:knights',
            'runecraft:rcair': 'runecraft:air',
            'runecraft:rune-bank-craft': 'runecraft:bank-craft',
        };
        const routeKey = aliases[`${skill}:${method}`] ?? `${skill}:${method}`;
        const workers: Readonly<Record<string, { script: string; gather?: readonly [string, string]; sub?: readonly [string, string] }>> = {
            'woodcutting:yews': { script: 'scripts/aio-skiller.ts', gather: ['woodcutting', 'yews'] },
            'foraging:flax': { script: 'scripts/aio-skiller.ts', gather: ['foraging', 'flax'] },
            'foraging:feathers': { script: 'scripts/aio-skiller.ts', gather: ['foraging', 'feathers'] },
            'mining:ore': { script: 'scripts/aio-skiller.ts', gather: ['mining', 'ore'] },
            'mining:essence': { script: 'scripts/aio-skiller.ts', gather: ['mining', 'essence'] },
            'runecraft:air': { script: 'scripts/aio-skiller.ts', sub: ['runecraft', 'air'] },
            'runecraft:bank-craft': { script: 'scripts/aio-skiller.ts', sub: ['runecraft', 'bank-craft'] },
            'thieving:blood-chest': { script: 'scripts/aio-skiller.ts', gather: ['thieving', 'blood-chest'] },
            'thieving:knights': { script: 'scripts/aio-skiller.ts', gather: ['thieving', 'knights'] },
            'magic:alch-train': { script: 'scripts/alch-train.ts' },
            'magic:splash': { script: 'scripts/splash-train.ts' },
            'magic:splash-coop': { script: 'scripts/splash-train.ts' },
        };
        const route = workers[routeKey]
            ? ([routeKey, workers[routeKey]!] as const)
            : Object.entries(workers).find(([key, entry]) => !entry.gather && !entry.sub && key.startsWith(`${skill}:`) && entry.script.endsWith(`${method}.ts`));
        if (route) {
            const entry = route[1];
            if (entry.gather) {
                const parsed = resolveRouteStep({ script: entry.script }, rest);
                return [{ script: entry.script, args: ['gather', ...entry.gather, ...parsed.args], env: { ...env, ...parsed.env } }];
            }
            if (entry.sub) {
                const parsed = resolveRouteStep({ script: entry.script }, rest);
                return [{ script: entry.script, args: [...entry.sub, ...parsed.args], env: { ...env, ...parsed.env } }];
            }
            spec = { script: entry.script, ...(route[0] === 'magic:splash-coop' ? { defaultEnv: { SPLASH_SITE: 'coop' } } : {}) };
        }
        if (skill === 'fishing' && (method === 'cage' || method === 'harpoon' || method === 'gather-fish')) {
            const sub = method === 'gather-fish' ? 'cage' : method;
            const parsed = resolveRouteStep({ script: 'scripts/aio-skiller.ts' }, rest);
            const gArgs = parsed.args.length ? parsed.args : [sub];
            return [{ script: 'scripts/aio-skiller.ts', args: ['gather', 'fishing', sub, ...gArgs], env: { ...env, ...parsed.env } }];
        }
    }
    return spec ? resourceSteps(resolveRouteStep(spec, rest), env, depth + 1) : [];
}

export function jobResources(job: ResourceJob): string[] {
    if (job.host && !job.orchestrate && Array.isArray(job.accounts)) {
        return job.accounts.flatMap(account => jobResources({
            ...job,
            host: false,
            accounts: undefined,
            env: { ...job.env, ...job.envByAccount?.[account] },
            envByAccount: undefined,
        }));
    }
    const script = String(job.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (Array.isArray(job.resources) && script !== 'scripts/ranged-train.ts') return job.resources.filter(r => typeof r === 'string');
    const chained = script === 'scripts/chain.ts';
    let direct: Step = { script, args: job.args ?? [], env: {} };
    if (!chained && !/^scripts\/aio(?:-[a-z]+)?\.ts$/.test(script)) {
        direct = { script, args: [], env: {} };
        for (const token of job.args ?? []) {
            const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
            if (m) direct.env[m[1]!] = m[2]!; else direct.args.push(token);
        }
    }
    const steps = resourceSteps(direct, job.env ?? {});
    const cheb = (s: string, x: number, z: number) => {
        const [sx, sz] = s.split(',').map(Number);
        return Math.max(Math.abs(sx! - x), Math.abs(sz! - z));
    };
    const out: string[] = [];
    for (const step of steps) {
        const file = step.script, env = step.env, args = step.args;
        if (file === 'scripts/aio-skiller.ts' && args[0] === 'bank-job') {
            for (const argument of args.slice(1)) {
                if (!argument.startsWith('--job=')) continue;
                const profile = JSON.parse(decodeURIComponent(argument.slice(6))) as BankRouteJob;
                validateBankRouteJob(profile);
                if (
                    profile.family === 'mining' && profile.site?.x === 3286 && profile.site.z === 3368 && profile.site.level === 0
                    && profile.bank?.x === 3253 && profile.bank.z === 3420 && profile.bank.level === 0
                ) out.push(AIO_PLACES.ore);
            }
        }
        if (file === 'scripts/aio-skiller.ts' && args[0] === 'gather') {
            const [, gSkill, gMethod, ...gArgs] = args;
            if (gSkill === 'thieving' && gMethod === 'knights') {
                const m = (env.KNIGHT_SPOT ?? '2653,3302').match(/^(\d+),(\d+)$/), x = Number(m?.[1] ?? 2653), z = Number(m?.[2] ?? 3302);
                out.push(`knight:${KNIGHT_SPOTS.reduce((b, s) => cheb(s, x, z) < cheb(b, x, z) ? s : b)}`);
            }
            if (gSkill === 'foraging' && gMethod === 'feathers') {
                const pen = (env.PEN ?? '').match(/^(\d+),(\d+)$/);
                out.push(pen ? `pen:${Number(pen[1])},${Number(pen[2])}` : 'pen:3229,3298');
            }
            if (gSkill === 'fishing' && (gMethod === 'cage' || gMethod === 'harpoon')) {
                const fishMethod = gArgs.find(a => /^(cage|harpoon)$/i.test(a)) ?? env.METHOD ?? gMethod;
                if (fishMethod.toLowerCase() === 'cage') out.push('catherby:lobster');
            }
            if (gSkill === 'foraging' && gMethod === 'flax') out.push(AIO_PLACES.flax);
            if (gSkill === 'woodcutting' && gMethod === 'yews' && env.REGION !== 'lumbridge' && env.REGION !== 'draynor'
                && (env.WOOD_GROVE === undefined || env.WOOD_GROVE === 'native-processing' && ['yew', 'maple'].includes(env.TREE ?? 'yew'))) out.push(AIO_PLACES.yews);
            if (gSkill === 'mining' && gMethod === 'ore' && (env.ORE_PROFILE ?? 'mixed') === 'mixed') out.push(AIO_PLACES.ore);
            if (gSkill === 'mining' && gMethod === 'essence') out.push(AIO_PLACES.essence);
            if (gSkill === 'thieving' && gMethod === 'blood-chest') out.push(AIO_PLACES.blood);
        }
        if (file === 'scripts/ranged-train.ts') {
            const method = env.PROGRESSION_METHOD;
            if (method === 'ranged/chickens' || method === 'ranged/chickens-oak') out.push('pen:3229,3298');
            else if (
                method === 'ranged/troopers' || method === 'ranged/troopers-oak'
                || method === 'ranged/troopers-willow' || method === 'ranged/troopers-maple'
                || method === 'ranged/guild-willow-mithril'
            ) out.push(TROOPER_FIELD);
            else out.push('pen:3229,3298', TROOPER_FIELD);
        }
        if (file === 'scripts/aio-market.ts' && args[0] === 'shop-buy') out.push(`shop:${(args[1] ?? env.PROFILE ?? 'catherby').toLowerCase()}`);
        if (file === 'scripts/shop-buyer.ts') out.push(`shop:${(args[0] ?? env.PROFILE ?? 'catherby').toLowerCase()}`);
        if (file === 'scripts/gather-combat.ts') {
            const target = (args[1] ?? env.TARGET ?? 'druid').toLowerCase();
            if (target === 'trooper') out.push(TROOPER_FIELD);
            if (target === 'cow') out.push(COW_FIELD);
        }
        if (file === 'scripts/train-chickens.ts') out.push((env.TRAIN_BANK ?? 'varrock') === 'ardougne' ? 'pen:2691,3277' : 'pen:3229,3298');
        if (file === 'scripts/black-dragon-camp.ts') out.push(BLACK_CAVE);
        if (file === 'scripts/aio-skiller.ts' && args[0] === 'runecraft' && (args[1] === 'air' || (args[1] === 'bank-craft' && env.RUNE_ALTAR === 'air'))) {
            out.push(AIO_PLACES.air);
        }
        if (file === 'scripts/splash-train.ts') out.push((env.SPLASH_SITE ?? 'ardougne') === 'coop' ? 'pen:3229,3298' : SPLASH_FENCE);
        if (file === 'scripts/alch-train.ts' && Number(args[0]) >= 2 && Number(args[0]) <= 99) out.push(STRIKE_TILE);
    }
    const extra = script === 'scripts/ranged-train.ts' && Array.isArray(job.resources)
        ? job.resources.filter(r => typeof r === 'string' && r !== 'pen:3229,3298' && r !== TROOPER_FIELD)
        : [];
    return [...new Set([...out, ...extra])];
}

export function claimFor(
    jobs: readonly any[],
    side: string,
    sideOf: (account: string) => string,
    now = Date.now(),
    active: (account: string) => boolean = () => true,
): { side: string; at: number; resources: string[] } {
    const held = jobs
        .filter(j => j?.enabled !== false && jobAccounts(j).length > 0 && jobAccounts(j).every(a => sideOf(a) === side) && jobAccounts(j).some(active))
        .flatMap(j => jobResources(j.host && !j.orchestrate ? { ...j, accounts: jobAccounts(j).filter(active) } : j));
    return { side, at: now, resources: held.sort() };
}

export function pickOrder(
    orders: readonly Order[],
    receipts: readonly Receipt[],
    account: string,
    now: number,
    lead = 10 * 60_000,
): { order: Order; role: 'from' | 'to' } | null {
    const me = account.toLowerCase();
    for (const order of [...orders].sort((a, b) => a.start - b.start)) {
        const role = order.from.toLowerCase() === me ? 'from' : order.to.toLowerCase() === me ? 'to' : null;
        if (!role || now >= order.end || order.start - now > lead) continue;
        const other: TradeRole = role === 'from' ? 'to' : 'from';
        if (receipts.some(r => r.id === order.id && (r.role === role || (r.role === other && r.version === 2 && r.state === 'failed')))) continue;
        return { order, role };
    }
    return null;
}

export const tradePlanFile = (base = repoRoot) => resolve(process.env.SWARM_PLAN ?? join(base, 'swarm.json'));

export function readTradePlan(file = tradePlanFile(repoRoot)) {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(plan?.jobs)) throw Error('fleet trade: invalid swarm plan');
    return plan;
}

export function readAgentJobs(file = tradePlanFile(repoRoot)): readonly any[] {
    return readTradePlan(file).jobs;
}

export function swarmBusy(jobs: readonly any[]): Set<string> {
    return new Set(
        jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])])
            .filter((n): n is string => typeof n === 'string')
            .map(n => n.toLowerCase()),
    );
}
