// Dragon longswords from Jakut, the dragon weapon seller in the Zanaris market.
// bun scripts/jakut-swords.ts <account>      SWORDS=2 (how many to buy), WAIT=0 (ticks to wait inside for the shelf)
// Server facts (vendor/rs-sdk/server/content/scripts/areas/area_lostcity):
// - The shed door in the Lumbridge swamp (zanarisdoor 2406 at 3202,3169) takes a player who wields a dramen staff to
//   Zanaris. An account gets the staff in Lost City, and only one that finished the quest may wield a dragon weapon
//   (skill_combat levelrequire_zanaris_quest).
// - Jakut (npc 564, spawn 3252,9572, Trade) owns `dragonswordshop`: 2 dragon longswords at 100,000 coins and 2 dragon
//   daggers at 30,000, one back every 500 ticks (configs/lostcity.inv).
// - Jakut stands in the market, east of the door zanarismarketdoor 2411 at 3238,9558. From the west the door asks the
//   doormen's tax, one cut diamond (1601), in a dialogue ("Okay..."); from the inside it opens free (doorman.rs2). The
//   engine refuses a walk round the door: practice, a walk from the entry to Jakut stopped on 3237,9560.
// - The ladder in the market (zanarisladderout 2410 at 3253,9591, attendant 3253,9590, "Yes, I'm ready to leave.")
//   puts the player on 3260,3171 in Al Kharid, 9 tiles from the bank (ladder_fairy.rs2).
// The run stages at the Draynor bank (the staff, one diamond and the coins), wields the staff with its own weapon in
// the pack, goes in by the shed, pays the door, buys, leaves by the ladder, wields its weapon again and banks the
// swords and the staff at Al Kharid. It keeps JAKUT_RESERVE coins of what it took.
import { openQuest } from './generated/quest-lib';
import { walkTargetPersist } from './walk-to';

export const JAKUT = { npc: /^jakut$/i, x: 3252, z: 9572, sword: 1305, swordName: /^dragon longsword$/i, price: 100_000 };
export const DRAMEN_STAFF = 772, DIAMOND = 1601, COINS = 995;
// What a sword may cost over its base price: the shop asks more as its shelf empties (shop_delta 10 on 2 in stock).
export const JAKUT_MARGIN = 5_000, JAKUT_RESERVE = 1_000;
export const jakutCoins = (swords: number) => swords * (JAKUT.price + JAKUT_MARGIN) + JAKUT_RESERVE;
const DRAYNOR_BANK = { x: 3092, z: 3243, level: 0 }, AL_KHARID_BANK = { x: 3269, z: 3167, level: 0 };
const SHED_DOOR = { id: 2406, x: 3202, z: 3169 }, MARKET_DOOR = { id: 2411, x: 3238, z: 9558 }, LADDER = { id: 2410, x: 3253, z: 9591 };
// How many swords a visit buys: what was asked, what the shelf holds and what the coins pay for at the shelf's price.
export function swordsToBuy(want: number, stock: number, price: number, coins: number): number {
    if (![want, stock, price, coins].every(Number.isSafeInteger) || price <= 0) return 0;
    return Math.max(0, Math.min(want, stock, Math.floor((coins - JAKUT_RESERVE) / price)));
}

if (import.meta.main) {
    const want = Number(process.env.SWORDS ?? 2), wait = Number(process.env.WAIT ?? 0);
    const q = await openQuest({ cap: 3000 + wait, eatAt: 50, lumbridgeOk: true });
    try {
        if (!Number.isSafeInteger(want) || want < 1 || want > 20 || !Number.isSafeInteger(wait) || wait < 0 || wait > 20000) await q.fail('SWORDS 1-20 and WAIT 0-20000');
        const s = q.s, p = () => q.pos(), x = () => p()?.worldX ?? 0, z = () => p()?.worldZ ?? 0;
        const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const worn = (id: number) => s.sdk.getEquipment().some(i => i.id === id);
        const underground = () => z() > 9000, inMarket = () => underground() && x() >= MARKET_DOOR.x;
        const openBank = async (label: string) => {
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !await q.waitUntil(() => !!q.st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, 20)) await q.fail(`${label}: bank did not open`);
        };
        const closeBank = async () => { await s.bot.closeBank(); await q.waitUntil(() => !q.st()?.bank?.isOpen, 10); await q.waitTicks(2); };
        const banked = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const take = async (id: number, n: number) => {
            const need = n - held(id);
            if (need < 1) return;
            const row = (q.st()?.bank?.items ?? []).find((i: { id: number }) => i.id === id);
            if (!row || banked(id) < need) await q.fail(`stage: ${need} of item ${id} short in the bank (${banked(id)} banked)`);
            if (!(await s.bot.withdrawItem(row!, need, { asNote: false })).success || !await q.waitUntil(() => held(id) >= n, 10)) await q.fail(`stage: withdraw ${need} of item ${id}`);
        };
        // 1. The kit, at the Draynor bank unless the account already carries it.
        const weapon = s.sdk.getEquipment().find(i => i.slot === 3 && i.id !== DRAMEN_STAFF);
        if (!underground() && (!(worn(DRAMEN_STAFF) || held(DRAMEN_STAFF)) || held(DIAMOND) < 1 || held(COINS) < jakutCoins(1))) {
            const there = await walkTargetPersist(s, DRAYNOR_BANK);
            if (!there.ok) await q.fail(`route to the Draynor bank: ${there.reason ?? ''} ${there.detail ?? ''}`);
            await openBank('stage');
            if (!worn(DRAMEN_STAFF)) await take(DRAMEN_STAFF, 1);
            await take(DIAMOND, 1);
            await take(COINS, Math.min(jakutCoins(want), held(COINS) + banked(COINS)));
            await closeBank();
            if (held(COINS) < jakutCoins(1)) await q.fail(`stage: ${held(COINS)} coins, a sword needs ${jakutCoins(1)}`);
        }
        if (!worn(DRAMEN_STAFF)) {
            const staff = s.sdk.getInventory().find(i => i.id === DRAMEN_STAFF);
            if (!staff || !(await s.bot.equipItem(staff)).success || !await q.waitUntil(() => worn(DRAMEN_STAFF), 8)) await q.fail('dramen staff not wielded');
        }
        q.milestone('staged');
        // 2. In by the shed.
        if (!underground()) {
            const there = await walkTargetPersist(s, { x: SHED_DOOR.x - 1, z: SHED_DOOR.z, level: 0 });
            if (!there.ok) await q.fail(`route to the shed: ${there.reason ?? ''} ${there.detail ?? ''}`);
            await q.step('shed door', () => q.opLoc(SHED_DOOR, 1), underground, 10, 4);
        }
        q.milestone('zanaris');
        // 3. The market door and its tax.
        if (!inMarket()) {
            if (held(DIAMOND) < 1) await q.fail('no diamond for the market door');
            await q.walk('to market door', [{ x: MARKET_DOOR.x - 1, z: MARKET_DOOR.z, tol: 0 }]);
            for (let i = 0; i < 4 && !inMarket(); i++) {
                await q.opLoc(MARKET_DOOR, 1);
                await q.waitUntil(() => q.dialogOpen() || inMarket(), 10);
                if (!inMarket()) await q.converse([/^okay/i], inMarket, 30);
            }
            if (!inMarket()) await q.fail('market door did not open');
        }
        q.milestone('market');
        // 4. Jakut. A shelf that is short is waited for inside, WAIT ticks at most.
        await q.walk('to jakut', [{ x: JAKUT.x - 1, z: JAKUT.z + 1, tol: 2 }]);
        const start = s.tick();
        let bought = 0, spent = 0, shelf = -1;
        while (bought < want) {
            const shop = await s.bot.openShop(JAKUT.npc);
            if (!shop.success) await q.fail(`jakut shop: ${shop.message}`);
            const row = q.st()?.shop?.shopItems?.find((i: { name: string }) => JAKUT.swordName.test(i.name));
            shelf = row?.count ?? 0;
            const price = Math.max(JAKUT.price, row?.buyPrice ?? JAKUT.price), n = swordsToBuy(want - bought, shelf, price, held(COINS));
            if (n > 0) {
                if (price > JAKUT.price + JAKUT_MARGIN) await q.fail(`jakut asks ${price} a sword, over ${JAKUT.price + JAKUT_MARGIN}`);
                const coins = held(COINS), swords = held(JAKUT.sword);
                await s.bot.buyFromShop(JAKUT.swordName, 1);
                await q.waitUntil(() => held(JAKUT.sword) > swords, 6);
                if (held(JAKUT.sword) <= swords) await q.fail('jakut: no sword after the buy');
                bought += held(JAKUT.sword) - swords; spent += coins - held(COINS);
                continue;
            }
            await s.bot.closeShop();
            if (shelf > 0 || s.tick() - start >= wait) break;
            await q.waitTicks(Math.min(50, wait - (s.tick() - start)));
        }
        if (q.st()?.shop?.isOpen) await s.bot.closeShop();
        await q.waitTicks(2);
        q.milestone(`bought ${bought}`);
        // 5. Out by the ladder to Al Kharid.
        await q.walk('to ladder', [{ x: LADDER.x - 1, z: LADDER.z - 1, tol: 1 }]);
        for (let i = 0; i < 4 && underground(); i++) {
            await q.opLoc(LADDER, 1);
            await q.waitUntil(() => q.dialogOpen() || !underground(), 10);
            if (underground()) await q.converse([/ready to leave/i], () => !underground(), 30);
        }
        if (underground()) await q.fail('ladder out of the market did not take the account');
        q.milestone('al kharid');
        // 6. The account's own weapon on again; the swords, the staff and the coins left to the bank.
        if (weapon) {
            const own = s.sdk.getInventory().find(i => i.id === weapon.id);
            if (own && (await s.bot.equipItem(own)).success) await q.waitUntil(() => worn(weapon.id), 8);
        }
        const bank = await walkTargetPersist(s, AL_KHARID_BANK);
        if (!bank.ok) await q.fail(`route to the Al Kharid bank: ${bank.reason ?? ''} ${bank.detail ?? ''}`);
        await openBank('bank');
        for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
            const row = s.sdk.getInventory().find(i => i.id === id);
            if (row && (!(await s.bot.depositItem(row, held(id))).success || !await q.waitUntil(() => held(id) === 0, 10))) await q.fail(`bank: deposit of item ${id}`);
        }
        const swords = banked(JAKUT.sword);
        await closeBank();
        q.milestone('banked');
        await q.end(bought > 0, `swords=${bought} banked=${swords} spent=${spent} shelf=${shelf} wanted=${want} weapon=${s.sdk.getEquipment().find(i => i.slot === 3)?.id ?? 0}`);
    } catch (e) { await q.fail(String(e)); }
}
