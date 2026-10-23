// Food chain lead (research/food-chain.md): runs the cook, the courier and the gold farmers without a person.
// Every 15 s it reads the status files and decides, by the rules proved live on 2026-10-23:
// - the cook (scripts/fishcook.ts, GIVE_TO=<courier>) and each farmer (scripts/goldfarm.ts, FOOD_FROM=<courier>
//   FOOD_ONLY_TRADE=1) restart when their run ends; a farmer only while it has food or fish wait at the courier;
// - the courier (scripts/foodcourier.ts) goes when the cook has MIN_FISH cooked fish banked and a farmer's food
//   (pack + bank) is under LOW, or a farmer waits for food;
// - a farmer that prints "waiting for food trade" gets every fish the courier holds (give-to-banker.ts
//   GIVE=Trout,Salmon: never without GIVE=, which also empties the giver's bank);
// - the courier's fares: under 240 coins, a logged-out farmer gives it 1,000 (banker.ts + give-to-banker.ts).
// Never two sessions on one account: an account runs only from here, and not while its status is fresh from another
// process. An account whose RESULT says it died is never started again. Stop: touch .practice/stop-foodchain.
// Usage: DEMO_OK=1 bun scripts/foodchain.ts [cook=Mightyrod] [courier=Bigpackage] [farmers=Pocketrocket,mmtha0205]
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const prac = join(root, '.practice');
const logDir = join(prac, 'foodchain-logs');
const COOK = process.argv[2] ?? 'Mightyrod';
const COURIER = process.argv[3] ?? 'Bigpackage';
const FARMERS = (process.argv[4] ?? 'Pocketrocket,mmtha0205').split(',').map(x => x.trim()).filter(Boolean);
const MIN_FISH = Number(process.env.MIN_FISH ?? 100);
const LOW = Number(process.env.LOW ?? 40);
if (process.env.DEMO_OK !== '1') { console.log('foodchain: set DEMO_OK=1 (live server)'); process.exit(2); }
if ([COOK, COURIER, ...FARMERS].some(a => /^haggis$/i.test(a))) { console.log('foodchain: the main account is never part of the chain'); process.exit(2); }

const FOOD = /^(trout|salmon|lobster|swordfish|shark|tuna|bread|cake|meat|cooked chicken)$/i;
type Status = { name: string; at: number; result?: string; phase?: string; inventory?: any[]; bank?: any[] | null; pos?: { x: number; z: number } };
const status = (a: string): Status | null => { try { return JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8')); } catch { return null; } };
const count = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter(i => re.test(i?.name ?? '')).reduce((n, i) => n + (i.count ?? 0), 0);
const say = (t: string) => { const l = `${new Date().toISOString().slice(11, 19)} ${t}`; console.log(l); appendFileSync(join(prac, 'foodchain.log'), l + '\n'); };

// One child process per account at most; `busy` marks the courier's multi-step jobs.
const running = new Map<string, { proc: ReturnType<typeof Bun.spawn>; log: string; started: number }>();
const dead = new Set<string>();
let courierBusy = false;

// DRY=1: print each decision and start nothing (a check of the rules against the live state).
const DRY = process.env.DRY === '1';
function start(account: string, script: string, env: Record<string, string>, tag = script): string {
    if (running.has(account)) throw new Error(`${account} already runs`);
    if (DRY) { say(`DRY would start ${account} ${tag} ${JSON.stringify(env)}`); return ''; }
    const log = join(logDir, `${account}-${Date.now()}.log`);
    rmSync(join(prac, `stop-${account}`), { force: true });
    const proc = Bun.spawn(['bun', script, account], { cwd: root, env: { ...process.env, DEMO_OK: '1', RANDOM_EVENTS: '0', ...env }, stdout: Bun.file(log), stderr: Bun.file(log + '.err') });
    running.set(account, { proc, log, started: Date.now() });
    say(`start ${account} ${tag} ${JSON.stringify(env)}`);
    void proc.exited.then(() => {
        running.delete(account);
        const res = (readLog(log).match(/^RESULT .*$/m) ?? [''])[0];
        say(`end ${account} ${res.slice(0, 160)}`);
        if (/died=true|fail died/.test(res)) { dead.add(account); say(`DEAD ${account}: never started again`); }
    });
    return log;
}
const readLog = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const until = async (f: () => boolean, ms: number) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await Bun.sleep(2000); return f(); };
// A process this lead did not start may hold the account: its status file changed in the last 30 s.
const external = (a: string) => !running.has(a) && (() => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs < 30_000; } catch { return false; } })();
const runOnce = async (account: string, script: string, env: Record<string, string>, ms: number) => {
    const log = start(account, script, env);
    await until(() => !running.has(account), ms);
    return readLog(log);
};

const farmerFood = (a: string) => { const s = status(a); return count(s?.inventory, FOOD) + count(s?.bank, FOOD); };
const courierFish = () => count(status(COURIER)?.inventory, /^(trout|salmon)$/i);
const courierCoins = () => count(status(COURIER)?.inventory, /^coins$/i);
const waitingFarmer = () => FARMERS.find(f => running.has(f) && /waiting for food trade/.test(String(status(f)?.phase ?? '')));

async function giveFish(farmer: string) {
    courierBusy = true;
    try { await runGive(COURIER, farmer, 'Trout,Salmon'); } finally { courierBusy = false; }
}
// give-to-banker.ts takes the partner as its second argument.
async function runGive(giver: string, receiver: string, give: string) {
    if (DRY) { say(`DRY would give ${giver} -> ${receiver} ${give}`); return false; }
    const log = join(logDir, `${giver}-give-${Date.now()}.log`);
    rmSync(join(prac, `stop-${giver}`), { force: true });
    const proc = Bun.spawn(['bun', 'scripts/give-to-banker.ts', giver, receiver], { cwd: root, env: { ...process.env, DEMO_OK: '1', RANDOM_EVENTS: '0', GIVE: give }, stdout: Bun.file(log), stderr: Bun.file(log + '.err') });
    running.set(giver, { proc, log, started: Date.now() });
    say(`give ${giver} -> ${receiver} ${give}`);
    await proc.exited;
    running.delete(giver);
    const out = readLog(log);
    say(`give done: ${(out.match(/^RESULT .*$/m) ?? ['no RESULT'])[0].slice(0, 120)}`);
    return /^RESULT ok/m.test(out);
}

async function topUpFares() {
    const donor = FARMERS.find(f => !running.has(f) && !external(f) && !dead.has(f));
    if (!donor) return false;
    courierBusy = true;
    try {
        const bankLog = start(COURIER, 'scripts/banker.ts', {}, 'banker (fares)');
        await until(() => /MILESTONE banking/.test(readLog(bankLog)) || !running.has(COURIER), 120_000);
        const ok = running.has(COURIER) && await runGive(donor, COURIER, 'Coins:1000');
        writeFileSync(join(prac, `stop-${COURIER}`), 'foodchain');
        await until(() => !running.has(COURIER), 200_000);
        say(`fares from ${donor}: ${ok ? 'ok' : 'failed'}`);
        return ok;
    } finally { courierBusy = false; }
}

async function tick() {
    if (existsSync(join(prac, 'stop-foodchain'))) {
        if (running.size === 0) { say('stopped (stop-foodchain)'); process.exit(0); }
        return;
    }
    // Cook: always running.
    if (!running.has(COOK) && !external(COOK) && !dead.has(COOK)) start(COOK, 'scripts/fishcook.ts', { TICKS: '9000', GIVE_TO: COURIER });
    if (courierBusy) return;
    // A farmer waits at the bank with no food: hand over the courier's fish.
    const w = waitingFarmer();
    if (w && courierFish() > 0 && !running.has(COURIER)) { void giveFish(w); return; }
    // Farmers: restart while they have food, or while the courier holds fish for them.
    for (const f of FARMERS) {
        if (running.has(f) || external(f) || dead.has(f)) continue;
        if (farmerFood(f) > 0 || courierFish() > 0) start(f, 'scripts/goldfarm.ts', { FOOD_FROM: COURIER, FOOD_ONLY_TRADE: '1' });
    }
    // Courier trip: fish ready at the cook and a farmer low (or waiting) and the courier holds none.
    if (running.has(COURIER) || external(COURIER) || dead.has(COURIER) || courierFish() > 0) return;
    const ready = count(status(COOK)?.bank, /^(trout|salmon)$/i);
    const low = FARMERS.filter(f => !dead.has(f)).some(f => farmerFood(f) < LOW);
    if (ready < MIN_FISH || !low) return;
    if (courierCoins() < 240) { if (!(await topUpFares())) return; }
    courierBusy = true;
    void runOnce(COURIER, 'scripts/foodcourier.ts', { FROM: COOK, FEATHERS: '0', WAIT: '1500' }, 3_600_000).finally(() => { courierBusy = false; });
}

if (import.meta.main) {
    mkdirSync(logDir, { recursive: true });
    say(`foodchain cook=${COOK} courier=${COURIER} farmers=${FARMERS.join(',')} minFish=${MIN_FISH} low=${LOW}`);
    let ticking = false;
    const loop = async () => { if (ticking) return; ticking = true; try { await tick(); } catch (e) { say(`error ${String(e)}`); } finally { ticking = false; } };
    void loop();
    setInterval(() => void loop(), 15_000);
}
