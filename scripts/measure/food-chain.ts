// Practice proofs for the food chain (research/food-chain.md). LOCAL practice server only: every bot here is made by
// packages/practice (bot.env SERVER=localhost), so openBot refuses any other server without DEMO_OK=1.
// Usage:
//   bun scripts/measure/food-chain.ts fish [runs=3] [cooking=1]   fishcook.ts for TICKS (default 1500) from the live
//                                                                 Mightyrod kit at the Lumbridge river
//   bun scripts/measure/food-chain.ts handoff                     courier gives 60 noted trout to a food-less farmer
//                                                                 (give-to-banker.ts GIVE=, goldfarm.ts FOOD_FROM=
//                                                                 FOOD_ONLY_TRADE=1); the farmer banks and eats them
//   bun scripts/measure/food-chain.ts courier                     foodcourier.ts Ardougne -> Draynor -> Ardougne with a
//                                                                 fishcook.ts HANDOFF_ONLY partner at Draynor bank
//   bun scripts/measure/food-chain.ts alone                       FOOD_ONLY_TRADE=1 farmer with no food and no trade:
//                                                                 it must log out, not steal
// Each run uses new account names, prints the RESULT lines, and deletes the bots afterwards.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBot } from '../../packages/practice/src/bots';
import { applyPreset, type SaveConfig } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { rsSdkRoot } from '../../packages/practice/src/paths';

const repo = resolve(import.meta.dir, '..', '..');
const logDir = process.env.LOG_DIR ?? join(repo, '.practice', 'foodchain');
mkdirSync(logDir, { recursive: true });
const [mode, a1, a2] = process.argv.slice(2);

const fly = { x: 3239, z: 3251, level: 0 };
const ardyBank = { x: 2654, z: 3283, level: 0 };
const logs = (n: number) => Array.from({ length: n }, () => ({ id: 1511, count: 1 }));

async function prep(name: string, p: SaveConfig) { await createBot(name); await applyPreset(name, p); }
function cleanup(name: string) { rmSync(join(rsSdkRoot(), 'bots', name), { recursive: true, force: true }); }

async function run(script: string, bot: string, env: Record<string, string>, args: string[] = [], timeoutMs = 900_000) {
    const proc = Bun.spawn(['bun', resolve(repo, script), bot, ...args], { cwd: rsSdkRoot(), env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    const text = (out + err).replace(/^.*PASSWORD.*$/gm, '[redacted]');
    writeFileSync(join(logDir, `${bot}.log`), text);
    return text;
}
const show = (who: string, text: string) => {
    for (const l of text.split(/\r?\n/)) if (/^(START|RESULT|MILESTONE|WARN|BANK|COOK|CHICKENS|TRADE|LEDGER)/.test(l) || /Error/.test(l)) console.log(`${who} | ${l}`);
};

if (mode === 'fish') {
    const runs = Number(a1 ?? 3), cooking = Number(a2 ?? 1);
    for (let i = 1; i <= runs; i++) {
        const bot = runBotName('fishcook', i);
        try {
            // The live Mightyrod kit (status file 2026-10-23): rod, knife, 2 logs; 300 feathers instead of 27.
            await prep(bot, { position: fly, skills: { Fishing: 99, Cooking: cooking, Attack: 5, Thieving: 51, Fletching: 18 },
                inventory: [{ id: 309, count: 1 }, { id: 314, count: 300 }, { id: 946, count: 1 }, ...logs(2)] });
            const out = await run('scripts/fishcook.ts', bot, { TICKS: process.env.TICKS ?? '1500' });
            show(`run ${i}`, out);
        } finally { cleanup(bot); }
    }
} else if (mode === 'handoff') {
    const farmer = runBotName('farm', 1), courier = runBotName('cour', 1);
    try {
        await prep(farmer, { position: ardyBank, skills: { Thieving: 99 } });
        // 60 noted trout (cert_trout 334) and the coins for boat fares.
        await prep(courier, { position: { x: 2655, z: 3283, level: 0 }, inventory: [{ id: 334, count: 60 }], coins: 200 });
        const fa = run('scripts/goldfarm.ts', farmer, { TICKS: process.env.TICKS ?? '1200', FOOD_FROM: courier, FOOD_ONLY_TRADE: '1' });
        // The farmer walks to the bank spot and starts serving after its first bank visit; give it a few seconds.
        await Bun.sleep(8000);
        const co = run('scripts/give-to-banker.ts', courier, { GIVE: 'Trout:60' }, [farmer]);
        const [f, c] = await Promise.all([fa, co]);
        show('courier', c);
        show('farmer', f);
    } finally { cleanup(farmer); cleanup(courier); }
} else if (mode === 'courier') {
    const cook = runBotName('mrod', 1), courier = runBotName('cour', 1);
    try {
        // Mightyrod after some packs: 100 cooked trout in the Draynor bank.
        await prep(cook, { position: { x: 3092, z: 3243, level: 0 }, skills: { Fishing: 99, Cooking: 50 }, inventory: [{ id: 309, count: 1 }, { id: 314, count: 100 }], bank: [{ id: 333, count: 100 }] });
        await prep(courier, { position: { x: 2655, z: 3283, level: 0 }, coins: 500 });
        const ck = run('scripts/fishcook.ts', cook, { GIVE_TO: courier, HANDOFF_ONLY: '1', WAIT: '2000' });
        const co = run('scripts/foodcourier.ts', courier, { FROM: cook, CAP: '2500', FEATHERS: '100' });
        const [k, c] = await Promise.all([ck, co]);
        show('courier', c);
        show('cook', k);
    } finally { cleanup(cook); cleanup(courier); }
} else if (mode === 'alone') {
    // FOOD_ONLY_TRADE end path: no food anywhere and nobody trades, so the farmer must log out, not steal.
    const farmer = runBotName('farm', 1);
    try {
        await prep(farmer, { position: ardyBank, skills: { Thieving: 99 }, coins: 300 });
        show('farmer', await run('scripts/goldfarm.ts', farmer, { TICKS: '3000', FOOD_FROM: 'nobodyhere', FOOD_ONLY_TRADE: '1' }));
    } finally { cleanup(farmer); }
} else {
    console.log('usage: food-chain.ts fish [runs] [cooking] | handoff | courier | alone');
    process.exit(2);
}
