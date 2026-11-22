// Job resource admission decoding across chains, AIO wrappers, skiller routes, and direct worker scripts.
import { parseStep, tokenizeStep, type Step } from '../../../../core/src/chain-step';
import { validateBankRouteJob, type BankRouteJob } from '../../../../core/src/bank-trip';
import { resolveRouteStep, resolveSkillerMethod } from '../../../../core/src/route-step';
import { AIO_PLACES, BLACK_CAVE, COW_FIELD, KNIGHT_SPOTS, SPLASH_FENCE, STRIKE_TILE, TROOPER_FIELD } from './capacity';

type ResourceJob = { script?: string; args?: string[]; env?: Record<string, string>; resources?: string[];
    host?: boolean; orchestrate?: boolean; accounts?: string[]; envByAccount?: Record<string, Record<string, string>> };

// Only location-bearing routes are decoded here. These lightweight contracts avoid
// loading game workers into the planner; their tests compare the actual AIO resolvers.
function resourceSteps(step: Step, inherited: Record<string, string>, depth = 0): Step[] {
    if (depth > 8) throw Error('resource admission: nested chain or AIO pipeline too deep');
    const file = step.script.replace(/\\/g, '/').replace(/^\.\//, ''), env = { ...inherited, ...step.env };
    if (file === 'scripts/chain.ts') return step.args.flatMap(text => resourceSteps(parseStep(text), env, depth + 1));
    const wrapper = /^scripts\/aio-(skiller|fighter|boss|market)\.ts$/.exec(file);
    if (file !== 'scripts/aio.ts' && !wrapper) return [{ script: file, args: step.args, env }];
    const [categoryInput, ...categoryArgs] = wrapper ? [wrapper[1]!, ...step.args] : step.args;
    const category = categoryInput?.toLowerCase().replace(/^--category=/, '');
    if (category === 'pipeline') return categoryArgs.flatMap(text => {
        const [head, ...rest] = tokenizeStep(text);
        if (!head) throw Error('resource admission: empty AIO pipeline step');
        const [cat, ...route] = head.includes(':') ? head.split(':') : [head];
        if (cat === 'quester' && route[0] === 'mode') route.shift();
        return resourceSteps({ script: 'scripts/aio.ts', args: [cat!, ...route, ...rest], env: {} }, env, depth + 1);
    });
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
        // Inline profiles are self-contained; resource admission never reads job files.
        if (skill === 'bank-job') return [{ script: 'scripts/aio-skiller.ts', args: ['bank-job', ...categoryArgs.slice(1)], env }];
        const { method, args } = resolveSkillerMethod(skill ?? '', methodInput, extra);
        rest = args;
        const workers: Readonly<Record<string, string>> = {
            'woodcutting:yews': 'scripts/gather-yews.ts', 'foraging:flax': 'scripts/gather-flax.ts',
            'foraging:feathers': 'scripts/gather-feathers.ts', 'mining:ore': 'scripts/gather-ore.ts',
            'mining:essence': 'scripts/gather-essence.ts', 'runecraft:air': 'scripts/generated/rcair.ts',
            'runecraft:bank-craft': 'scripts/rune-bank-craft.ts', 'thieving:blood-chest': 'scripts/blood-chest.ts',
            'thieving:knights': 'scripts/goldfarm.ts', 'magic:alch-train': 'scripts/alch-train.ts',
            'magic:splash': 'scripts/splash-train.ts', 'magic:splash-coop': 'scripts/splash-train.ts',
        };
        const route = workers[`${skill}:${method}`] ? [`${skill}:${method}`, workers[`${skill}:${method}`]!] :
            Object.entries(workers).find(([key, worker]) => key.startsWith(`${skill}:`) && worker.endsWith(`${method}.ts`));
        if (route) spec = { script: route[1]!, ...(route[0] === 'magic:splash-coop' ? { defaultEnv: { SPLASH_SITE: 'coop' } } : {}) };
        if (skill === 'fishing' && (method === 'cage' || method === 'harpoon' || method === 'gather-fish')) spec = { script: 'scripts/gather-fish.ts', defaultArgs: [method === 'gather-fish' ? 'cage' : method] };
    }
    return spec ? resourceSteps(resolveRouteStep(spec, rest), env, depth + 1) : [];
}

// Resources are per worker. A hosted job runs one worker for each account, with
// its own environment; an orchestrator is one cooperative worker and keeps its list.
export function jobResources(job: ResourceJob): string[] {
    if (job.host && !job.orchestrate && Array.isArray(job.accounts)) return job.accounts.flatMap(account => jobResources({
        ...job, host: false, accounts: undefined, env: { ...job.env, ...job.envByAccount?.[account] }, envByAccount: undefined,
    }));
    const script = String(job.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (Array.isArray(job.resources) && script !== 'scripts/ranged-train.ts') return job.resources.filter(r => typeof r === 'string');
    const chained = script === 'scripts/chain.ts';
    let direct: Step = { script, args: job.args ?? [], env: {} };
    // Preserve the direct-job metadata convention, while AIO gets its own argv so
    // route defaults and explicit KEY=value options keep the execution precedence.
    if (!chained && !/^scripts\/aio(?:-[a-z]+)?\.ts$/.test(script)) {
        direct = { script, args: [], env: {} };
        for (const token of job.args ?? []) { const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/); if (m) direct.env[m[1]!] = m[2]!; else direct.args.push(token); }
    }
    const steps = resourceSteps(direct, job.env ?? {});
    const cheb = (s: string, x: number, z: number) => { const [sx, sz] = s.split(',').map(Number); return Math.max(Math.abs(sx! - x), Math.abs(sz! - z)); };
    const out: string[] = [];
    for (const step of steps) {
        const file = step.script, env = step.env, args = step.args;
        if (file === 'scripts/aio-skiller.ts' && args[0] === 'bank-job') for (const argument of args.slice(1)) {
            if (!argument.startsWith('--job=')) continue;
            const profile = JSON.parse(decodeURIComponent(argument.slice(6))) as BankRouteJob;
            validateBankRouteJob(profile);
            if (profile.family === 'mining' && profile.site?.x === 3286 && profile.site.z === 3368 && profile.site.level === 0
                && profile.bank?.x === 3253 && profile.bank.z === 3420 && profile.bank.level === 0) out.push(AIO_PLACES.ore);
        }
        if (file === 'scripts/goldfarm.ts') {
            const m = (env.KNIGHT_SPOT ?? '2653,3302').match(/^(\d+),(\d+)$/), x = Number(m?.[1] ?? 2653), z = Number(m?.[2] ?? 3302);
            out.push(`knight:${KNIGHT_SPOTS.reduce((b, s) => cheb(s, x, z) < cheb(b, x, z) ? s : b)}`);
        }
        if (file === 'scripts/gather-feathers.ts') {
            const pen = (env.PEN ?? '').match(/^(\d+),(\d+)$/);
            out.push(pen ? `pen:${Number(pen[1])},${Number(pen[2])}` : 'pen:3229,3298');
        }
        if (file === 'scripts/ranged-train.ts') {
            const method = env.PROGRESSION_METHOD;
            if (method === 'ranged/chickens' || method === 'ranged/chickens-oak') out.push('pen:3229,3298');
            else if (method === 'ranged/troopers' || method === 'ranged/troopers-oak' || method === 'ranged/troopers-willow' || method === 'ranged/troopers-maple' || method === 'ranged/guild-willow-mithril') out.push(TROOPER_FIELD);
            else out.push('pen:3229,3298', TROOPER_FIELD);
        }
        if (file === 'scripts/aio-market.ts' && args[0] === 'shop-buy') out.push(`shop:${(args[1] ?? env.PROFILE ?? 'catherby').toLowerCase()}`);
        if (file === 'scripts/shop-buyer.ts') out.push(`shop:${(args[0] ?? env.PROFILE ?? 'catherby').toLowerCase()}`);
        if (file === 'scripts/gather-fish.ts' && (args[0] ?? env.METHOD ?? 'cage').toLowerCase() === 'cage') out.push('catherby:lobster');
        if (file === 'scripts/gather-combat.ts') {
            const target = (args[1] ?? env.TARGET ?? 'druid').toLowerCase();
            if (target === 'trooper') out.push(TROOPER_FIELD);
            // North/south select the return bank; both profiles fight the same field.
            if (target === 'cow') out.push(COW_FIELD);
        }
        if (file === 'scripts/train-chickens.ts') out.push((env.TRAIN_BANK ?? 'varrock') === 'ardougne' ? 'pen:2691,3277' : 'pen:3229,3298');
        if (file === 'scripts/black-dragon-camp.ts') out.push(BLACK_CAVE);
        if (file === 'scripts/gather-flax.ts') out.push(AIO_PLACES.flax);
        if (file === 'scripts/gather-yews.ts' && env.REGION !== 'lumbridge' && env.REGION !== 'draynor'
            && (env.WOOD_GROVE === undefined || env.WOOD_GROVE === 'native-processing' && ['yew', 'maple'].includes(env.TREE ?? 'yew'))) out.push(AIO_PLACES.yews);
        if (file === 'scripts/gather-ore.ts' && (env.ORE_PROFILE ?? 'mixed') === 'mixed') out.push(AIO_PLACES.ore);
        if (file === 'scripts/gather-essence.ts') out.push(AIO_PLACES.essence);
        if (file === 'scripts/generated/rcair.ts') out.push(AIO_PLACES.air);
        if (file === 'scripts/rune-bank-craft.ts' && env.RUNE_ALTAR === 'air') out.push(AIO_PLACES.air);
        if (file === 'scripts/blood-chest.ts') out.push(AIO_PLACES.blood);
        if (file === 'scripts/splash-train.ts') out.push((env.SPLASH_SITE ?? 'ardougne') === 'coop' ? 'pen:3229,3298' : SPLASH_FENCE);
        // An unknown account can need Wind Strike before alchemy, even with target99.
        // Qualified planner alchemists carry an explicit empty resource override.
        if (file === 'scripts/alch-train.ts' && Number(args[0]) >= 2 && Number(args[0]) <= 99) out.push(STRIKE_TILE);
    }
    return [...new Set([...out, ...(script === 'scripts/ranged-train.ts' && Array.isArray(job.resources) ? job.resources.filter(r => typeof r === 'string' && r !== 'pen:3229,3298' && r !== TROOPER_FIELD) : [])])];
}
