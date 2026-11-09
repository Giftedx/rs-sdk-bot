// Fleet templates and credential provisioning. swarm.json owns current operating decisions.
// `validate` checks templates; `generate [out]` exports a candidate; `apply` only creates a missing swarm.json.
// New accounts are disabled until their bot.env exists and the operator enables them. Bot passwords are never printed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
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
    foodSourceAccounts?: string[];
    sourceFoodMinimum?: number;
}

export interface FleetPlan { maxBots: number; minFreeGB: number; jobs: Job[]; }

// Every member meets the knight requirement. mmsmk1232 reached 55 in its live training run
// (788 ticks, hpMin=5, died=false); the farm still checks the skill before any walk.
const THIEVES = ['Pocketrocket', 'mmtha0205', 'mmthv2350', 'Pocketpython', 'mmsmk1232'];

// Active live accounts first. New accounts are disabled until an operator creates their bot.env and flips enabled.
export const FLEET: FleetAccount[] = [
    {
        name: 'Mightyrod', server: 'rs-sdk-demo.fly.dev', role: 'combat',
        goal: 'Kill Fire Giants in Waterfall Dungeon, bank loot, and return forever',
        // One credited kill and bank return per batch. The controller repeats it;
        // food, attribution, door, damage and life guards can block a failed batch.
        script: 'scripts/gather-fire-combat.ts', enabled: true, repeat: true,
        env: { CAP: '1600', RANDOM_EVENTS: '0' },
        note: 'One Fire Giant per guarded batch. Native bronze-sword pilot killed1, banked its drops and preserved owned assets on 2026-10-25; the controller repeats from the bank with owned food.',
    },
    // The four uniform farmers share pathfinding. The courier's funding lead
    // keeps its own environment and process. Live handoff waits for owned work
    // to end; session, failure and RAM admission rules still apply per account.
    ...THIEVES.map(name => {
        // Release each thief's accumulated client state through normal repeat
        // rather than retaining a roughly hour-long session on the shared PC.
        const env:Record<string,string>={TICKS:'3000',BANK_AT:'25000',FOOD_FROM:'Bigpackage'};
        if(name==='Pocketrocket')env.FUND_COURIER='Bigpackage';
        return {
        name, server: 'rs-sdk-demo.fly.dev', role: 'thieving' as const,
        goal: 'Pickpocket Ardougne Knights for max gp/hr forever; bank coins and refill food',
        script: 'scripts/goldfarm-stable.ts', enabled: true, repeat: true,
        env,
        hostGroup: name==='Pocketrocket'?undefined:'knights',
        note: name==='Pocketrocket'
            ?'Independent funding lead; banks coins and refills food from its bank or owned courier.'
            :'Shared knight host; banks coins and refills food from its bank or owned courier.',
    };}),
    {
        name: 'Masterbaiter', server: 'rs-sdk-demo.fly.dev', role: 'fishing',
        goal: 'Fly fish and cook best food (trout & salmon) forever, bank and supply courier',
        script: 'scripts/fishcook.ts', enabled: true, repeat: true,
        env: { TICKS: '9000', GIVE_TO: 'Bigpackage', TARGETED_COLLECTION: '1' },
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
        goal: 'Collect from either active cook and deliver food on demand to the thieves',
        script: 'scripts/foodcourier.ts', enabled: true, repeat: true,
        env: { FROM: 'Masterbaiter,FishAndChips', FEATHERS: '500', FARMERS: THIEVES.join(','), CAP: '9000', FUND_FROM: 'Pocketrocket' },
        whenFoodLowFrom: [...THIEVES], foodLowBelow: 80, foodSourceAccounts: ['Masterbaiter','FishAndChips'],
        sourceFoodMinimum: 1,
        note: 'On-demand food courier & walking bank: carries food notes from Draynor to Ardougne when any farmer or combat account drops below safe food buffer.',
    },
    {
        name: 'Shaftmaker', server: 'rs-sdk-demo.fly.dev', role: 'fletching',
        goal: 'Gather and bank normal logs at Seers for arrow-shaft production',
        script: 'scripts/gather-yews.ts', enabled: true, repeat: true,
        env: { TREE: 'normal', MAX_TRIPS: '1', BANK_AT: '25', CAP: '1200' },
    },
    {
        name: 'Bigchopper', server: 'rs-sdk-demo.fly.dev', role: 'woodcutting',
        goal: 'Collect and bank oak logs for the fletching supply chain',
        script: 'scripts/gather-yews.ts', enabled: true, repeat: true,
        env: { REGION: 'draynor', TREE: 'oak', MAX_MAKE: '25', CAP: '1800' },
    },
    {
        name: 'Woodpecker', server: 'rs-sdk-demo.fly.dev', role: 'mining',
        goal: 'Gather and bank mixed ores at Varrock East in three-load batches',
        script: 'scripts/gather-ore.ts', enabled: true, repeat: true,
        env: { CAP: '1800', BANK_AT: '25', MAX_TRIPS: '3' },
        note: 'Requires combat13. Exact owned-pickaxe practice qualified without damage and banked75ores in3loads on 2026-10-25; live admission follows the bounded qualification and mining pilot.',
    },
    {
        name: 'Ballspinner', server: 'rs-sdk-demo.fly.dev', role: 'crafting',
        goal: 'Restock and bank flax at Seers for the next bow-string batch',
        script: 'scripts/gather-flax.ts', enabled: true, repeat: true,
        env: { CAP: '1800', BANK_AT: '28' },
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
    // Legacy proposed accounts. New names follow AGENTS.md: task-based penis joke, optionally Scottish.
    { name: 'AFKnight', server: 'rs-sdk-demo.fly.dev', role: 'combat', goal: 'Combat support: cowhides, bones and beef near Lumbridge', script: 'scripts/gather-combat.ts', enabled: false },
    { name: 'OreElse', server: 'rs-sdk-demo.fly.dev', role: 'mining', goal: 'Gather and bank mixed ores at Varrock East in three-load batches', script: 'scripts/gather-ore.ts', enabled: true, repeat: true, env: { CAP: '1800', BANK_AT: '25', MAX_TRIPS: '3' }, note: 'Qualified at combat13. Live three-load trial banked75ores in1169ticks, hpMin=16, died=false on 2026-10-25. The mixed-mine entry guard requires combat13; emergency owned-load recovery remains available.' },
    { name: 'FishAndChips', server: 'rs-sdk-demo.fly.dev', role: 'fishing', goal: 'Fish, cook and supply the food courier from Draynor', script: 'scripts/fishcook.ts', enabled: true, repeat: true, env: { TICKS: '9000', GIVE_TO: 'Bigpackage', TARGETED_COLLECTION: '1' } },
    { name: 'BowBeforeMe', server: 'rs-sdk-demo.fly.dev', role: 'fletching', goal: 'Gather25 normal logs and bank375 arrow shafts in each production batch', script: 'scripts/fletch-worker.ts', enabled: true, repeat: true, env: { RANDOM_EVENTS: '1',BANK_KNIFE:'1',NORMAL_GROVE:'north' }, note: 'Separate northern normal-tree grove passed the two-client practice trial with full health and preserved kit; live recovery qualification follows before the failed epoch is cleared.' },
    { name: 'MineYourBiz', server: 'rs-sdk-demo.fly.dev', role: 'mining', goal: 'Essence supply: mine rune/pure essence via Aubury', script: 'scripts/gather-essence.ts', enabled: false },
    { name: 'YewFirst', server: 'rs-sdk-demo.fly.dev', role: 'woodcutting', goal: 'Gather and bank normal logs at Draynor in two-load batches', script: 'scripts/gather-yews.ts', enabled: true, repeat: true, env: { REGION: 'draynor', TREE: 'normal', MAX_TRIPS: '2', BANK_AT: '25', CAP: '1800' }, note: 'Live pilot banked 50 logs in 1144 ticks, hpMin=10, died=false on 2026-10-25.' },
];

// A host group runs all its accounts in one process; singles run one account per job. Conditions come from the group's first row.
export function toPlan(accounts: readonly FleetAccount[], maxBots = 17, minFreeGB = 8): FleetPlan {
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
        if (a.foodSourceAccounts) base.foodSourceAccounts = a.foodSourceAccounts;
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
        if (first.foodSourceAccounts) job.foodSourceAccounts = first.foodSourceAccounts;
        if (first.sourceFoodMinimum !== undefined) job.sourceFoodMinimum = first.sourceFoodMinimum;
        jobs.push(job);
        void group;
    }
    // Admission follows this order. Grouping must not move the first member
    // behind every single-account job and starve its shared startup budget.
    const priority=new Map(accounts.map((a,i)=>[a.name,i]));
    const rank=(j:Job)=>Math.min(...(j.host?j.accounts!:[j.account!]).map(name=>priority.get(name)!));
    jobs.sort((a,b)=>rank(a)-rank(b));
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
    if (!existsSync(envFile)) writeFileSync(envFile, `SERVER=${server}\nPASSWORD=${accountPassword(name, server)}\n`);
    return dir;
}

// The game server accepts 1-20 character passwords; base64url of 15 bytes is exactly 20. A machine that loses its
// files after each session (the cloud fleet side) sets FLEET_SEED, a secret kept in its environment settings: the
// password is then HMAC-SHA256(seed, server:name), so any later session rebuilds the same bot.env with `create`.
export function accountPassword(name: string, server: string, seed = process.env.FLEET_SEED): string {
    if (!seed) return randomBytes(15).toString('base64url');
    return createHmac('sha256', seed).update(`${server.toLowerCase()}:${name.toLowerCase()}`).digest().subarray(0, 15).toString('base64url');
}

export function writeFleetPlan(out:string,plan:FleetPlan,liveFile=swarmFile):void {
    // Exclusive create prevents stale templates replacing current decisions, even in a race.
    writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{flag:resolve(out)===resolve(liveFile)?'wx':'w'});
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
        writeFleetPlan(out,plan);
        console.log(`FLEET wrote ${out} jobs=${plan.jobs.length}`);
    } else if (cmd === 'create' && arg) {
        const dir = createAccount(arg, server);
        console.log(`FLEET created ${arg} at ${dir} (bot.env password not printed)`);
    } else {
        console.log('usage: bun scripts/fleet.ts list|validate|generate [out]|apply|create <name> [server]');
        process.exit(2);
    }
}
