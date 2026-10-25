// Single-source fleet manifest: every active account, role, goal, script, server and host group in one file.
// `bun scripts/fleet.ts validate` checks it; `generate [out]` writes a swarm plan; `apply` replaces swarm.json.
// New accounts are disabled until their bot.env exists and the operator enables them. Bot passwords are never printed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Job } from './swarm';

const repoRoot = resolve(import.meta.dir, '..');
const botsDir = join(repoRoot, 'vendor', 'rs-sdk', 'bots');
const swarmFile = join(repoRoot, 'swarm.json');
const NAME = /^[A-Za-z0-9_ -]{1,12}$/;

export type Role = 'combat' | 'thieving' | 'fishing' | 'mining' | 'courier' | 'fletching'
    | 'woodcutting' | 'crafting' | 'magic' | 'bank' | 'main' | 'practice' | 'unassigned';

export interface FleetAccount {
    name: string;
    server: string;
    role: Role;
    goal: string;
    script: string;
    enabled: boolean;
    repeat?: boolean;
    env?: Record<string, string>;
    hostGroup?: string;
    note?: string;
    whenFoodLowFrom?: string[];
    foodLowBelow?: number;
    foodSourceAccount?: string;
    sourceFoodMinimum?: number;
}

export interface FleetPlan { maxBots: number; minFreeGB: number; jobs: Job[]; }

// Thieving 99 accounts only. mmsmk1232 (Thieving 1, status 2026-10-25) idled 2400 ticks at the knights; the knights
// need 55 and goldfarm-stable.ts farmStartProblem refuses it, so it stays out of the pool until it is trained.
const THIEVES = ['Pocketrocket', 'mmtha0205', 'mmthv2350', 'Pocketpython'];

// Active live accounts first. New accounts are disabled until an operator creates their bot.env and flips enabled.
export const FLEET: FleetAccount[] = [
    {
        name: 'Mightyrod', server: 'rs-sdk-demo.fly.dev', role: 'combat',
        goal: 'Kill Fire Giants in Waterfall Dungeon, bank loot, and return forever',
        // Paused 2026-10-25: 0 credited kills in every live pilot. Best run: bronze sword (1277, the best weapon it
        // owns), 227 fight ticks, hpMin 29, HP guard retreat (.practice/swarm-logs/Mightyrod.log). The script is ONE
        // finite pilot, not a loop. Re-enable after it owns a real weapon (e.g. a rune scimitar) and a pilot kills.
        script: 'scripts/gather-fire-combat.ts', enabled: false, repeat: false,
        env: { CAP: '9000', RANDOM_EVENTS: '0', FOOD_FROM: 'Bigpackage' },
        note: 'Paused: one Fire Giant pilot per run; 0 kills with a bronze sword. Needs a better owned weapon first.',
    },
    // One job per thief, not a shared host: a host starts only the accounts that are free at that moment, and the others
    // then wait for that whole host to end (2026-10-25: two thieves sat offline "waiting: current mission still
    // running" for a full run). Four single processes cost about 2.2 GB, well inside the 8 GB floor.
    ...THIEVES.map(name => ({
        name, server: 'rs-sdk-demo.fly.dev', role: 'thieving' as const,
        goal: 'Pickpocket Ardougne Knights for max gp/hr forever; bank coins and refill food',
        script: 'scripts/goldfarm-stable.ts', enabled: true, repeat: true,
        env: { TICKS: '9000', BANK_AT: '25000', FOOD_FROM: 'Bigpackage' },
        note: '5 accounts hosted in one process (~700 MB total vs 2.75 GB separate); 50gp/pick (~18.8 gp/tick at 99); food supplied by courier.',
    })),
    {
        name: 'Masterbaiter', server: 'rs-sdk-demo.fly.dev', role: 'fishing',
        goal: 'Fly fish and cook best food (trout & salmon) forever, bank and supply courier',
        script: 'scripts/fishcook.ts', enabled: true, repeat: true,
        env: { TICKS: '9000', GIVE_TO: 'Bigpackage' },
        note: 'Continuous 3-tick fly fishing trout/salmon (~51 cooked food/1000 ticks, ~465/hr) at Lumbridge river, cooked at general store fireplace, banked at Draynor, and traded to courier.',
    },
    {
        name: 'Shaftsinker', server: 'rs-sdk-demo.fly.dev', role: 'mining',
        goal: 'Mine rune essence and pure essence via Aubury, bank at Varrock East forever',
        script: 'scripts/gather-essence.ts', enabled: true, repeat: true,
        env: { CAP: '15000', BANK_AT: '28' },
        note: 'Mine rune essence (and pure essence 30+) in the Rune Essence Mine via Aubury teleport, bank at Varrock East bank, and loop forever.',
    },
    {
        name: 'Bigpackage', server: 'rs-sdk-demo.fly.dev', role: 'courier',
        goal: 'Walking bank: collect cooked food from Masterbaiter and trade on demand to whoever needs it',
        script: 'scripts/foodcourier.ts', enabled: true, repeat: true,
        env: { FROM: 'Masterbaiter', FEATHERS: '500', FARMERS: THIEVES.join(','), CAP: '9000' },
        whenFoodLowFrom: [...THIEVES], foodLowBelow: 80, foodSourceAccount: 'Masterbaiter',
        sourceFoodMinimum: 1,
        note: 'On-demand food courier & walking bank: carries food notes from Draynor to Ardougne when any farmer or combat account drops below safe food buffer.',
    },
    {
        name: 'Shaftmaker', server: 'rs-sdk-demo.fly.dev', role: 'fletching',
        goal: 'Fletching99 complete; await useful advanced ammunition inputs',
        script: 'scripts/fletch-arrows.ts', enabled: false, repeat: false,
    },
    {
        name: 'Bigchopper', server: 'rs-sdk-demo.fly.dev', role: 'woodcutting',
        goal: 'Collect and bank oak logs for the fletching supply chain',
        script: 'scripts/gather-yews.ts', enabled: false, repeat: false,
    },
    {
        name: 'Woodpecker', server: 'rs-sdk-demo.fly.dev', role: 'mining',
        goal: 'Mining recovery paused',
        script: 'scripts/gather-ore.ts', enabled: false,
    },
    {
        name: 'Ballspinner', server: 'rs-sdk-demo.fly.dev', role: 'crafting',
        goal: 'Crafting99 complete; hold strings for owned production demand',
        script: 'scripts/spin-bowstrings.ts', enabled: false, repeat: false,
    },
    {
        name: 'Haggis', server: 'rs-sdk-demo.fly.dev', role: 'main',
        goal: '24 boards', script: '', enabled: false, note: 'reserved: runs only the final rehearsed route',
    },
    {
        name: 'Abracadickra', server: 'rs-sdk-demo.fly.dev', role: 'magic',
        goal: 'Bounded magic and potion supplies:40each owned target',
        script: 'scripts/shop-buyer.ts', enabled: false, repeat: false,
    },
    {
        name: 'Moneyshot', server: 'rs-sdk-demo.fly.dev', role: 'bank',
        goal: 'Receive owned cargo, bank it, then wait offline',
        script: 'scripts/banker.ts', enabled: false, repeat: false,
    },
    {
        name: 'Swordinhand', server: 'rs-sdk-demo.fly.dev', role: 'combat',
        goal: 'Practice-gated cowhides, bones and beef; then Strength/Defence progression',
        script: 'scripts/gather-combat.ts', enabled: false, repeat: false,
    },
    // Proposed clean-pun accounts. Disabled until created and reviewed; no sexual names are generated.
    {
        name: 'mmsmk1232', server: 'rs-sdk-demo.fly.dev', role: 'thieving',
        goal: 'Thieving 1: train to 55 before joining the knight pool',
        script: 'scripts/goldfarm-stable.ts', enabled: false, repeat: false,
    },
    { name: 'AFKnight', server: 'rs-sdk-demo.fly.dev', role: 'combat', goal: 'Combat support: cowhides, bones and beef near Lumbridge', script: 'scripts/gather-combat.ts', enabled: false },
    { name: 'OreElse', server: 'rs-sdk-demo.fly.dev', role: 'mining', goal: 'Mining supply: bank iron and coal for smithing', script: 'scripts/gather-ore.ts', enabled: false },
    { name: 'FishAndChips', server: 'rs-sdk-demo.fly.dev', role: 'fishing', goal: 'Fishing supply: fly fish and cook trout/salmon for the courier', script: 'scripts/fishcook.ts', enabled: false },
    { name: 'BowBeforeMe', server: 'rs-sdk-demo.fly.dev', role: 'fletching', goal: 'Fletching supply: cut shafts and fletch arrows for ranged', script: 'scripts/fletch-arrows.ts', enabled: false },
    { name: 'MineYourBiz', server: 'rs-sdk-demo.fly.dev', role: 'mining', goal: 'Essence supply: mine rune/pure essence via Aubury', script: 'scripts/gather-essence.ts', enabled: false },
    { name: 'YewFirst', server: 'rs-sdk-demo.fly.dev', role: 'woodcutting', goal: 'Woodcutting supply: bank oak/yew logs for fletching', script: 'scripts/gather-yews.ts', enabled: false },
];

// A host group runs all its accounts in one process; singles run one account per job. Conditions come from the group's first row.
export function toPlan(accounts: readonly FleetAccount[], maxBots = 10, minFreeGB = 8): FleetPlan {
    const jobs: Job[] = [];
    const groups = new Map<string, FleetAccount[]>();
    for (const a of accounts) {
        if (a.hostGroup) {
            const list = groups.get(a.hostGroup) ?? [];
            list.push(a);
            groups.set(a.hostGroup, list);
        }
    }
    for (const a of accounts) {
        if (a.hostGroup) continue;
        const base: Job = { account: a.name, script: a.script, role: a.role, goal: a.goal, enabled: a.enabled };
        if (a.repeat !== undefined) base.repeat = a.repeat;
        if (a.env) base.env = a.env;
        if (a.note) base.note = a.note;
        if (a.whenFoodLowFrom) base.whenFoodLowFrom = a.whenFoodLowFrom;
        if (a.foodLowBelow !== undefined) base.foodLowBelow = a.foodLowBelow;
        if (a.foodSourceAccount) base.foodSourceAccount = a.foodSourceAccount;
        if (a.sourceFoodMinimum !== undefined) base.sourceFoodMinimum = a.sourceFoodMinimum;
        jobs.push(base);
    }
    for (const [group, list] of groups) {
        const first = list[0]!;
        const job: Job = {
            accounts: list.map(a => a.name), host: true, script: first.script,
            role: first.role, goal: first.goal, enabled: first.enabled,
        };
        if (first.repeat !== undefined) job.repeat = first.repeat;
        if (first.env) job.env = first.env;
        if (first.note) job.note = first.note;
        if (first.whenFoodLowFrom) job.whenFoodLowFrom = first.whenFoodLowFrom;
        if (first.foodLowBelow !== undefined) job.foodLowBelow = first.foodLowBelow;
        if (first.foodSourceAccount) job.foodSourceAccount = first.foodSourceAccount;
        if (first.sourceFoodMinimum !== undefined) job.sourceFoodMinimum = first.sourceFoodMinimum;
        jobs.push(job);
        void group;
    }
    return { maxBots, minFreeGB, jobs };
}

export function validate(accounts: readonly FleetAccount[]): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const a of accounts) {
        const key = a.name.toLowerCase();
        if (!NAME.test(a.name)) errors.push(`${a.name}: name must be 1-12 letters, digits, spaces, _ or -`);
        if (seen.has(key)) errors.push(`${a.name}: duplicate account name`);
        seen.add(key);
        if (a.server !== 'rs-sdk-demo.fly.dev' && !a.server.startsWith('localhost')) errors.push(`${a.name}: unsupported server ${a.server}`);
        if (a.script && !existsSync(join(repoRoot, a.script))) errors.push(`${a.name}: script not found ${a.script}`);
        if (a.enabled && !a.script) errors.push(`${a.name}: enabled account needs a script`);
        if (a.enabled && !existsSync(join(botsDir, a.name, 'bot.env'))) errors.push(`${a.name}: enabled account has no bot.env`);
    }
    const groups = new Map<string, FleetAccount[]>();
    for (const a of accounts) {
        if (!a.hostGroup) continue;
        const list = groups.get(a.hostGroup) ?? [];
        list.push(a);
        groups.set(a.hostGroup, list);
    }
    for (const [group, list] of groups) {
        const scripts = new Set(list.map(a => a.script));
        if (scripts.size > 1) errors.push(`host group ${group}: mixed scripts ${[...scripts].join(', ')}`);
        if (list.length < 2) errors.push(`host group ${group}: needs at least two accounts to save memory`);
        if (new Set(list.map(a => a.server)).size > 1) errors.push(`host group ${group}: mixed servers`);
    }
    return errors;
}

export function createAccount(name: string, server = 'rs-sdk-demo.fly.dev'): string {
    if (!NAME.test(name)) throw new Error(`invalid account name: ${name}`);
    if (server !== 'rs-sdk-demo.fly.dev' && !server.startsWith('localhost')) throw new Error(`unsupported server: ${server}`);
    const dir = join(botsDir, name);
    mkdirSync(dir, { recursive: true });
    const envFile = join(dir, 'bot.env');
    if (!existsSync(envFile)) {
        // The game server accepts 1-20 character passwords; base64url of 15 bytes is exactly 20.
        const password = randomBytes(15).toString('base64url');
        writeFileSync(envFile, `SERVER=${server}\nPASSWORD=${password}\n`);
    }
    return dir;
}

if (import.meta.main) {
    const [cmd, arg, server] = process.argv.slice(2);
    if (cmd === 'list') {
        for (const a of FLEET) console.log(`${a.enabled ? 'ON ' : 'off'} ${a.name.padEnd(12)} ${a.role.padEnd(11)} ${a.server} ${a.script || '(reserved)'}`);
    } else if (cmd === 'validate') {
        const errors = validate(FLEET);
        if (errors.length) { for (const e of errors) console.error(`FLEET ERROR ${e}`); process.exit(1); }
        console.log(`FLEET OK ${FLEET.length} accounts, ${FLEET.filter(a => a.enabled).length} enabled`);
    } else if (cmd === 'generate' || cmd === 'apply') {
        const plan = toPlan(FLEET);
        const out = cmd === 'apply' ? swarmFile : resolve(repoRoot, arg || 'swarm.generated.json');
        writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
        console.log(`FLEET wrote ${out} jobs=${plan.jobs.length}`);
    } else if (cmd === 'create' && arg) {
        const dir = createAccount(arg, server);
        console.log(`FLEET created ${arg} at ${dir} (bot.env password not printed)`);
    } else {
        console.log('usage: bun scripts/fleet.ts list|validate|generate [out]|apply|create <name> [server]');
        process.exit(2);
    }
}
