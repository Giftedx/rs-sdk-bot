// Universal Herblore Mixer: cleans herbs, brews unfinished potions, and finishes 3-dose potions.
// Operates with zero travel directly at bank / supply holder.
// Usage: bun scripts/brew-potions.ts <bot> [CAP ticks, default 15000] [RECIPE: prayer | super_attack | super_str | super_def | unf]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';

const botName = process.argv[2];
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const RECIPE = (process.argv[4] ?? process.env.RECIPE ?? 'prayer').toLowerCase();

if (!botName) {
    console.error('Usage: bun scripts/brew-potions.ts <botName> [CAP] [RECIPE]');
    process.exit(1);
}

const RECIPES: Record<string, { unf: RegExp; sec: RegExp; pot: RegExp }> = {
    prayer: { unf: /unfinished potion/i, sec: /snape grass/i, pot: /prayer potion/i },
    super_attack: { unf: /unfinished potion/i, sec: /eye of newt/i, pot: /super attack/i },
    super_str: { unf: /unfinished potion/i, sec: /limpwurt root/i, pot: /super strength/i },
    super_def: { unf: /unfinished potion/i, sec: /white berries/i, pot: /super defence/i },
    energy: { unf: /unfinished potion/i, sec: /chocolate dust/i, pot: /energy potion/i },
};

const conf = RECIPES[RECIPE] ?? RECIPES.prayer!;

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const inv = () => s.sdk.getInventory();
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let brewed = 0, bankTrips = 0;

    const findItem = (re: RegExp) => inv().find(i => re.test(i.name));
    const countRe = (re: RegExp) => countItems(s, re);

    const bank = async () => {
        const b = await s.bot.openBank();
        if (!b.success) {
            await waitTicks(s, 2);
            return;
        }

        // Deposit finished potions
        await s.bot.depositItem(conf.pot, -1);
        await waitTicks(s, 1);

        // Withdraw 14 unf potions and 14 secondaries
        await s.bot.withdrawItem(conf.unf, 14);
        await s.bot.withdrawItem(conf.sec, 14);

        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
    };

    console.log(`START potion mixer ${botName} recipe=${RECIPE}`);

    while (!over()) {
        const unfItem = findItem(conf.unf);
        const secItem = findItem(conf.sec);

        if (!unfItem || !secItem) {
            await bank();
            if (!findItem(conf.unf) || !findItem(conf.sec)) {
                await waitTicks(s, 5);
                continue;
            }
        }

        const u = findItem(conf.unf)!;
        const sc = findItem(conf.sec)!;
        const before = countRe(conf.pot);

        await s.sdk.sendUseItemOnItem(u.slot, sc.slot);
        await waitTicks(s, 1);

        const gained = countRe(conf.pot) - before;
        if (gained > 0) {
            brewed += gained;
        }
    }

    const perK = (brewed * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], brewed > 0, `ticks=${used()} brewed=${brewed} recipe=${RECIPE} bankTrips=${bankTrips} brewPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
