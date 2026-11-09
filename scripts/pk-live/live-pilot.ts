// Live PK run for one account: stage its best kit from the nearest bank, walk to Edgeville, hunt with the roamer
// (radar, cut-off, freeze, pk.ts tribrid fight, value loot, Edgeville banking), leave.
// usage: DEMO_OK=1 STANDING=1 bun .practice/pk-hunt/live-pilot.ts <account> [minutes=10] [maxWild=56]
// Stop: touch .practice/stop-<account> (or .practice/stop-pk-hunt for every PK run).
import { existsSync } from 'node:fs';
import { accountOf, getWorld, openBot, settle } from '../../packages/core/src/bot';
import { goTo } from '../../packages/core/src/walk';
import { waitUntil } from '../../packages/core/src/ticks';
import { huntOnce, restockPlan } from './pk-hunt';

// Depth 30 by default: a glory works to Wilderness level 30.
const [name, minutes = '10', maxWild = '30'] = process.argv.slice(2);
if (!name) throw Error('usage: live-pilot.ts <account> [minutes] [maxWild]');
const stopped = () => existsSync('.practice/stop-' + name) || existsSync('.practice/stop-pk-hunt');
if (stopped()) throw Error('PK stop file present');

// Best first. Attack level each needs (content levelrequire); dragon weapons also need Lost City.
const MELEE: [RegExp, number][] = [[/^dragon dagger(\(p\+*\))?$/i, 60], [/^dragon (scimitar|longsword|mace)$/i, 60], [/^rune scimitar$/i, 40],
    [/^rune (longsword|sword|mace|battleaxe)$/i, 40], [/^adamant scimitar$/i, 30], [/^adamant (longsword|sword|mace)$/i, 30],
    [/^mithril scimitar$/i, 20], [/^black scimitar$/i, 10], [/^steel scimitar$/i, 5]];
const BOWS: [RegExp, number][] = [[/^magic shortbow$/i, 50], [/^yew shortbow$/i, 40], [/^maple shortbow$/i, 30], [/^willow shortbow$/i, 20], [/^oak shortbow$/i, 5], [/^shortbow$/i, 1]];
const ARROWS: [RegExp, number][] = [[/^rune arrow$/i, 40], [/^adamant arrow$/i, 30], [/^mithril arrow$/i, 20], [/^steel arrow$/i, 5], [/^iron arrow$/i, 1], [/^bronze arrow$/i, 1]];
const FOOD = [/^shark$/i, /^swordfish$/i, /^lobster$/i, /^tuna$/i, /^salmon$/i, /^trout$/i];
const RUNES = /^(air|fire|earth|water|mind|chaos|death|blood|nature|law) rune$/i;
// Escape and prayer supplies: the best-charged glory, prayer potions (4 dose first), super restores.
const GLORY = [/^amulet of glory\(4\)$/i, /^amulet of glory\(3\)$/i, /^amulet of glory\(2\)$/i, /^amulet of glory\(1\)$/i];
const POTIONS = [/^prayer potion\(4\)$/i, /^prayer potion\(3\)$/i, /^super restore\(4\)$/i, /^prayer potion\(2\)$/i];
const STAFF = /^(staff of fire|fire battlestaff|mystic fire staff)$/i;
// Best armour per slot by Defence level (content levelrequire). The server refuses a quest item the account lacks
// (rune platebody needs Dragon Slayer); the next tier is tried then.
const tiers = (kind: string): [RegExp, number][] => [['rune', 40], ['adamant', 30], ['mithril', 20], ['black', 10], ['steel', 5], ['iron', 1], ['bronze', 1]]
    .map(([metal, need]) => [new RegExp(`^${metal} ${kind}$`, 'i'), need as number]);
const ARMOUR: [RegExp, number][][] = [
    tiers('full helm'), [...tiers('platebody'), ...tiers('chainbody')].sort((a, b) => b[1] - a[1]),
    [...tiers('platelegs'), ...tiers('plateskirt')].sort((a, b) => b[1] - a[1]), [...tiers('kiteshield'), ...tiers('sq shield')].sort((a, b) => b[1] - a[1]),
];
// A skulled death loses everything worn; the dragonfire shield stays banked unless PK_RISK_DFS=1.
if (process.env.PK_RISK_DFS === '1') ARMOUR[3]!.unshift([/^dragonfire shield$/i, 75]);

const s = await openBot(name);
const log = (e: object) => console.log('PK_EVENT ' + JSON.stringify({ t: s.tick(), ...e }));
const inv = () => s.sdk.getInventory();
const worn = () => s.sdk.getEquipment();
const level = (n: string) => s.sdk.getSkill(n)?.baseLevel ?? 1;
let ok = false, failure: string | undefined, result: unknown;
try {
    const p = s.sdk.getState()!.player!;
    log({ e: 'start', at: [p.worldX, p.worldZ], hp: p.hp, combat: p.combatLevel, worn: worn().map(i => i.name), carried: inv().map(i => i.name + 'x' + i.count) });
    const openBankHere = async () => (await s.bot.openBank()).success && await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 });
    // Live, after a Varrock Teleport (3213,3424) no bank opened from there: walk to Edgeville bank and try again.
    if (!(await openBankHere())) {
        const r = await goTo(s, await getWorld(), { x: 3094, z: 3492, level: 0 }, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: 180_000 });
        log({ e: 'bank-walk', ok: r.ok, at: [s.sdk.getState()?.player?.worldX, s.sdk.getState()?.player?.worldZ] });
        if (!(await openBankHere())) throw Error('bank did not open');
    }
    // Heal before any trip. The restock scripts (shop-buyer, buy-owned-ge-item) do not eat. Live: Mightyrod left on a
    // shop trip at 48 HP after a fight with a poisoned-dagger PKer, kept losing HP, and was at 30 HP when the owner stopped it.
    const hpNow = () => s.sdk.getState()?.player?.hp ?? 0, hpMax = () => s.sdk.getState()?.player?.maxHp ?? 99;
    const edible = () => inv().filter(i => FOOD.some(re => re.test(i.name)));
    let poisoned = false;
    {
        const bankItems = () => s.bankObservation?.()?.items ?? [];
        if (hpNow() < hpMax() * 0.9) {
            for (const re of FOOD) {
                const want = 8 - edible().length;
                if (want <= 0) break;
                if (bankItems().some(b => re.test(b.name))) { await s.bot.withdrawItem(re, want); await s.sdk.waitForTicks(1); }
            }
        }
        const antipoison = /^antipoison\([1-4]\)$/i;
        if (bankItems().some(b => antipoison.test(b.name)) && !inv().some(i => antipoison.test(i.name))) await s.bot.withdrawItem(antipoison, 1);
        await s.bot.closeBank();
        for (let i = 0; i < 20 && hpNow() < hpMax() * 0.9 && edible().length; i++) { await s.bot.eatFood(edible()[0]!); await s.sdk.waitForTicks(2); }
        // Poison: HP falls while the account stands idle at the bank.
        const before = hpNow();
        await s.sdk.waitForTicks(15);
        if (hpNow() < before) {
            const potion = inv().find(i => antipoison.test(i.name));
            if (potion) {
                const op = potion.optionsWithIndex?.find((o: any) => /^drink$/i.test(o.text));
                await s.sdk.sendUseItem(potion.slot, op?.opIndex ?? 1);
                await s.sdk.waitForTicks(3);
                log({ e: 'antipoison', hp: hpNow() });
            } else poisoned = true;
        }
        log({ e: 'healed', hp: hpNow(), max: hpMax(), poisoned });
        if (!(await openBankHere())) throw Error('bank did not reopen after healing');
    }
    // Restock before staging, from what the bank and pack hold. The buys run as separate scripts with this job's
    // environment after a logout; then this run ends "restocked" and the standing job's next run stages with them.
    // A poisoned account with no antipoison skips the restock trips: those scripts do not eat. The hunt eats.
    if (!poisoned) {
        const all = [...(s.bankObservation?.()?.items ?? []), ...inv()];
        const held = (re: RegExp) => all.filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
        const hasGlory = held(/^amulet of glory\([1-4]\)$/i) > 0;
        const plan = restockPlan({ law: hasGlory ? 99 : held(/^law rune$/i), nature: held(/^nature rune$/i), water: held(/^water rune$/i),
            coins: held(/^coins$/i), magic: level('Magic'),
            food: FOOD.reduce((n, re) => n + held(re), 0), sharks: held(/^shark$/i), ranged: level('Ranged'), defence: level('Defence'),
            magicShortbow: held(/^magic shortbow$/i) + worn().filter(i => /^magic shortbow$/i.test(i.name)).length > 0,
            runeBody: held(/^rune (platebody|chainbody)$/i) + worn().filter(i => /^rune (platebody|chainbody)$/i.test(i.name)).length > 0 });
        if (plan.length && process.env.PK_NO_RESTOCK !== '1') {
            log({ e: 'restock', plan });
            await s.bot.closeBank();
            const out = await settle([s], true, 'restock: ' + JSON.stringify(plan));
            const steps: { step: unknown; code: number | null }[] = [];
            for (const step of plan) {
                const [cmd, env] = step.kind === 'ge'
                    ? [['scripts/buy-owned-ge-item.ts', name], { ITEM_ID: String(step.item), QUANTITY: String(step.quantity), LIMIT_PRICE: String(step.limit),
                        CASH_RESERVE: '1000', EXPECTED_OWNED: String(step.owned), ORDER_KEY: `${name.toLowerCase()}-pk-${step.item}-${Date.now()}` }]
                    : [['scripts/shop-buyer.ts', name, step.profile, '3000'], { MAX_SPEND: String(step.maxSpend), COIN_RESERVE: '1000', NO_BUY_TICKS: '25' }];
                const child = Bun.spawn([process.execPath, ...cmd], { env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
                const code = await child.exited;
                steps.push({ step, code });
                if (code !== 0) break;
            }
            const ok = steps.length === plan.length && steps.every(x => x.code === 0);
            console.log('PK_PILOT ' + JSON.stringify({ ok, restocked: steps, loggedOut: out }));
            process.exit(ok ? 0 : 1);
        }
    }
    // Start clean: deposit the whole pack (worn gear stays).
    for (const item of [...inv()]) if (inv().some(i => i.id === item.id)) await s.bot.depositItem(item, -1);
    await s.sdk.waitForTicks(2);
    const bank = () => s.bankObservation?.()?.items ?? [];
    const best = (list: [RegExp, number][], lvl: number) => list.find(([re, need]) => lvl >= need && bank().some(b => re.test(b.name)))?.[0];
    const take = async (re: RegExp, n: number) => {
        const b = bank().find(x => re.test(x.name));
        if (!b) return false;
        const r = await s.bot.withdrawItem(re, n < 0 ? b.count : Math.min(n, b.count));
        await s.sdk.waitForTicks(1);
        return r.success;
    };
    // The worn weapon counts too: live, a worn dragon dagger was skipped (only the bank was searched), an adamant
    // scimitar came out of the bank, and the dagger was banked as spare gear.
    const rank = (name: string | undefined) => name === undefined ? MELEE.length : MELEE.findIndex(([re, need]) => level('Attack') >= need && re.test(name));
    const wornWeapon = worn().find(i => i.slot === 3)?.name;
    const wornRank = rank(wornWeapon) < 0 ? MELEE.length : rank(wornWeapon);
    const bankMelee = best(MELEE, level('Attack'));
    const bankRank = bankMelee ? MELEE.findIndex(([re]) => re === bankMelee) : MELEE.length;
    const keepWorn = wornRank < MELEE.length && wornRank <= bankRank;
    const melee = keepWorn ? MELEE[wornRank]![0] : bankMelee;
    const bow = best(BOWS, level('Ranged')), arrows = bow ? best(ARROWS, level('Ranged')) : undefined;
    const mage = level('Magic') >= 35 && !melee;
    if (melee && !keepWorn) await take(melee, 1);
    if (bow) await take(bow, 1);
    if (arrows) await take(arrows, -1);
    if (mage) await take(STAFF, 1);
    for (const b of [...bank()]) if (RUNES.test(b.name)) await take(new RegExp('^' + b.name + '$', 'i'), -1);
    const glory = GLORY.find(re => bank().some(b => re.test(b.name)));
    if (glory) await take(glory, 1);
    // Up to 3 prayer potions: Protect Item and a protect prayer drain fast.
    let pots = 0;
    for (const re of POTIONS) while (pots < 3 && bank().some(b => re.test(b.name)) && await take(re, 1)) pots++;
    // One antipoison per trip, against poisoned-dagger PKers (Goondelf's fight left Mightyrod losing HP after it).
    const ANTIPOISON = /^antipoison\([1-4]\)$/i;
    if (bank().some(b => ANTIPOISON.test(b.name)) && !inv().some(i => ANTIPOISON.test(i.name))) await take(ANTIPOISON, 1);
    // No escape item, no trip: a glory works to Wilderness 30, Varrock Teleport (1 law, 3 air, 1 fire) to 20.
    const lawRunes = inv().filter(i => /^law rune$/i.test(i.name)).reduce((n, i) => n + i.count, 0);
    const teleport = lawRunes > 0 && level('Magic') >= 25;
    if (!glory && !teleport) {
        await s.bot.closeBank();
        throw Error('no escape item: bank an amulet of glory, or law runes with Magic 25+, before a PK trip');
    }
    // Armour: every tier the Defence level allows, best first, so a refused piece falls back to the next.
    const armour: RegExp[] = [];
    for (const slot of ARMOUR) {
        const options = slot.filter(([re, need]) => level('Defence') >= need && bank().some(b => re.test(b.name))).map(([re]) => re);
        for (const re of options) if (inv().length < 27 && await take(re, 1)) armour.push(re);
    }
    // Food: fill the pack with every food type held, best first; one slot stays free for loot.
    for (const re of FOOD) {
        const room = 28 - inv().length - 1;
        if (room <= 0) break;
        await take(re, room);
    }
    await s.bot.closeBank();
    // Wear the best armour piece per slot; a refused piece (quest requirement) leaves the next one to try.
    for (const re of armour) {
        if (!inv().some(i => re.test(i.name))) continue;
        const r = await s.bot.equipItem(re);
        log({ e: 'wear', item: re.source, ok: r.success, msg: r.success ? undefined : r.message });
    }
    // Wield: the melee weapon (or the staff for a mage), then arrows. The bow stays in the pack for the fight loop's switch.
    if (melee && !keepWorn) await s.bot.equipItem(melee);
    else if (mage && inv().some(i => STAFF.test(i.name))) await s.bot.equipItem(STAFF);
    else if (bow) await s.bot.equipItem(bow);
    if (arrows) await s.bot.equipItem(arrows);
    await s.sdk.waitForTicks(2);
    // Gear the switch left in the pack (a staff swapped for the dagger, robes) is not kit: bank it, so a death cannot lose it.
    const spare = inv().filter(i => ![melee, bow, arrows, mage ? STAFF : undefined, ...FOOD, RUNES, ...GLORY, ...POTIONS, ANTIPOISON].some(re => re && (re as RegExp).test(i.name)));
    if (spare.length && (await s.bot.openBank()).success) {
        for (const item of spare) if (inv().some(i => i.id === item.id)) await s.bot.depositItem(item, -1);
        await s.bot.closeBank();
    }
    const kit = { worn: worn().map(i => i.name), carried: inv().map(i => i.name + 'x' + i.count) };
    log({ e: 'kit', ...kit });
    const foodCount = inv().filter(i => FOOD.some(re => re.test(i.name))).length;
    if (!foodCount) throw Error('no food in bank: buy or bank food first');
    if (stopped()) throw Error('stopped before travel');
    // The planned walk (route search, travel, doors). Live, the first try from Ardougne stood 114 ticks and failed with
    // no reason logged: log the planner's whole outcome and try once more.
    let walk: any = { ok: false };
    for (let attempt = 1; attempt <= 2 && !walk.ok && !stopped(); attempt++) {
        // Planning budget 180 s: the default 45 s (world.ts ROUTE_BUDGET_MS) is short of the 117 s the route from
        // Ardougne takes to plan offline; live it gave up after 114 ticks with "no route".
        walk = await goTo(s, await getWorld(), { x: 3094, z: 3503, level: 0 }, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: 180_000 });
        log({ e: 'walked', attempt, ok: walk.ok, outcome: walk, at: [s.sdk.getState()?.player?.worldX, s.sdk.getState()?.player?.worldZ] });
    }
    if (!walk.ok) throw Error('walk to Edgeville failed: ' + JSON.stringify(walk).slice(0, 300));
    result = await huntOnce(s, { maxMs: Number(minutes) * 60_000, maxWild: Number(maxWild), eatAt: 50, fleeAt: 35, spell: 'AUTO', loot: true, freeze: true,
        ranged: bow }, stopped, log);
    ok = true;
} catch (error) { failure = String(error); }
const loggedOut = await settle([s], ok, failure ?? 'PK run ' + JSON.stringify(result));
console.log('PK_PILOT ' + JSON.stringify({ ok, failure, result, loggedOut }));
process.exit(ok && loggedOut ? 0 : 1);
