// A shop run against a second buyer at the same shelf (practice only): the partner account stands at the shop and
// buys the profile's first item, while `scripts/aio-market.ts` runs for the account with the arguments that follow.
// Usage: bun scripts/measure/shop-rival.ts <bot> <rival> <first|last> <blind|look> <aio-market arguments...>
//   first|last: the rival logs in before or after the account. The engine runs the players of one address in login
//     order (World.ts playerLoop), so the earlier login buys first inside a tick.
//   blind: the rival sends one buy request each tick. look: it sends one in each tick that its shelf shows stock.
// The account's output passes through; the rival's lines start with `MILESTONE rival`.
import { resolve } from 'node:path';

const [bot, rivalName, order, mode, ...args] = process.argv.slice(2);
if (!bot || !rivalName || !/^(first|last)$/.test(order ?? '') || !/^(blind|look)$/.test(mode ?? '') || args[0] !== 'shop-buy' || !args[1]) {
    console.log('RESULT fail usage: bun scripts/measure/shop-rival.ts <bot> <rival> <first|last> <blind|look> shop-buy <profile> [arguments...]');
    process.exit(2);
}
// The rival waits at the shelf for the whole run; the stall watch of a session reads this at import.
process.env.STALL_TICKS = '0';
const { openBot } = await import('../../packages/core/src/bot');
const { waitTicks } = await import('../../packages/core/src/ticks');
const { PROFILES } = await import('../shop-buyer');
const conf = PROFILES[args[1]!.toLowerCase()];
if (!conf) { console.log(`RESULT fail unknown shop profile ${args[1]}`); process.exit(2); }
const root = resolve(import.meta.dir, '..', '..');

let workerDone = false, started: () => void = () => {};
const workerStarted = new Promise<void>(done => { started = done; });
const runWorker = async (): Promise<number> => {
    const proc = Bun.spawn(['bun', resolve(root, 'scripts/aio-market.ts'), bot!, ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: { ...process.env } });
    let rest = '';
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
        rest += decoder.decode(chunk, { stream: true });
        const lines = rest.split('\n');
        rest = lines.pop()!;
        for (const line of lines) { console.log(line.replace(/\r$/, '')); if (line.startsWith('START ')) started(); }
    }
    if (rest) console.log(rest);
    const code = await proc.exited;
    workerDone = true;
    started();
    return code;
};

let worker: Promise<number> | undefined;
if (order === 'last') { worker = runWorker(); await workerStarted; }
const rival = await openBot(rivalName, { log: line => console.log(`MILESTONE rival ${line}`), onStop: async () => {} });
worker ??= runWorker();

const wanted = conf.items[0]!.re;
const held = () => rival.sdk.getInventory().filter(i => wanted.test(i.name)).reduce((n, i) => n + i.count, 0);
// `seen` is the highest count read: a pack read can miss items for a tick.
let seen = held(), bought = 0, requests = 0, ended = false;
void rival.ended.then(() => { ended = true; });
while (!workerDone && !ended) {
    const shop = rival.sdk.getState()?.shop;
    if (!shop?.isOpen) {
        const opened = await rival.bot.openShop(conf.npc);
        if (!opened.success) await waitTicks(rival, 2);
        continue;
    }
    const now = held();
    if (now > seen) { bought += now - seen; console.log(`MILESTONE rival bought=${bought} t=${rival.tick()} requests=${requests} held=${now} coins=${rival.sdk.getInventory().filter(i => /^coins$/i.test(i.name)).reduce((n, i) => n + i.count, 0)}`); }
    seen = Math.max(seen, now);
    const item = shop.shopItems.find(i => wanted.test(i.name));
    if (item && (mode === 'blind' || item.count > 0)) {
        const sent = await rival.direct({ type: 'shopBuy', slot: item.slot, amount: 1, reason: 'SDK' }) as { success?: boolean } | null;
        if (sent?.success) requests++;
    }
    await waitTicks(rival, 1);
}
const code = await worker;
console.log(`MILESTONE rival end order=${order} mode=${mode} bought=${bought} requests=${requests}`);
if (!ended) await rival.close().catch(() => {});
process.exit(code);
