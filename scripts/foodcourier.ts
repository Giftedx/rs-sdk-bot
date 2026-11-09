import {courierFoodAllocation} from './courier-allocation';
// Food courier (research/food-chain.md): Ardougne south bank -> Draynor bank, takes the cooked-fish notes that
// scripts/fishcook.ts (GIVE_TO=<this bot>) hands over, and back to the Ardougne south bank; then gives each farmer in
// FARMERS its share (the farmer serves the trade: scripts/goldfarm.ts FOOD_FROM=<this bot>).
// Route and boats copied from scripts/generated/gecourier.ts: Barnaby (Ardougne) -> Brimhaven, walk to Musa Point,
// customs officer -> Port Sarim, walk to Draynor, and back the same way (fare 30 each, four fares per cycle).
// Env: FROM=<cook[,cook...]> (required): choose the active owned cook with the most banked food.
// Multi-source cooks use TARGETED_COLLECTION=1 and GIVE_TO=<this courier>. WAIT (default 1500) ticks at Draynor.
// FARMERS=<a,b,...>: wake below 80 fish, refill toward 160. PER=<n> optionally caps each fish type per farm.
// CAP (default 3000) ticks. Held notes resume delivery before another collection trip.
// FEATHERS=<n>: buy at most n feathers toward the cook's1000-feather buffer. Unknown stock retains the configured purchase.
// START=draynor skips the outbound legs (the courier already stands at Draynor bank).
// OUTBOUND_ONLY=1 ends at Draynor with the owned supplies still held; no collection or return trip.
import { openBot, finish, countItems, serverFromEnv } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import {requestCourierFunding} from './courier-funding';
import { awaitCollectionOffer, collectHandoff, sendHandoff } from './courier-handoff';
import {featherBatchAmount,featherPurchaseEffect,courierIslandProblem} from './courier-purchase';
import {depositObserved} from '../packages/core/src/deposit';
import { sail as sailBoat, disembark as disembarkBoat } from '../packages/core/src/boat';
import { ARDY_BANK, BOAT_FARES_OUT, BOAT_FARES_ROUND, NORTH_BANK, NORTH_TO_SOUTH, SARIM, deliveryResume, deliveryRecipientAtBank, draynorApproach, featherPurchaseAmount, onKaramja, outboundStart } from './courier-route';
import { COOKED_FOOD, cookedFoodRestock as foodRestockAmount, selectCookedFoodSource as selectFoodSource } from '../packages/core/src/bank-demand';

type Pt = [number, number, number];
const DRAYNOR = { x: 3092, z: 3243 };
const LUMBRIDGE = { x: 3222, z: 3218 };
const BRIM_DECK = { x: 2775, z: 3234 };
const SARIM_DECK = { x: 3032, z: 3217 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };
const SOURCES = (process.env.FROM ?? '').split(',').map(n=>n.trim()).filter(Boolean);
let FROM = SOURCES[0] ?? '';
const WAIT = Number(process.env.WAIT ?? 1500);
const CAP = Number(process.env.CAP ?? 3000);
const FARMERS = (process.env.FARMERS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const PER = process.env.PER ? Number(process.env.PER) : 0;
const TOTAL_PER = Number(process.env.TOTAL_PER ?? 0);
courierFoodAllocation([],0,PER,TOTAL_PER);
// HOME_ONLY=1: an account near Lumbridge or Draynor (a respawn) walks to Draynor bank, takes fares from its bank,
// and goes home to Ardougne on the same boats; no trade.
const HOME_ONLY = process.env.HOME_ONLY === '1';
const OUTBOUND_ONLY = process.env.OUTBOUND_ONLY === '1';
const START_DRAYNOR = process.env.START === 'draynor' || HOME_ONLY;
const FEATHERS = Number(process.env.FEATHERS ?? 0);
const FUND_FROM=process.env.FUND_FROM?.trim()||'';
const FUND_ONLY=process.env.FUND_ONLY==='1';
const RESERVE_OPENING_CASH=process.env.RESERVE_OPENING_CASH==='1';
const FISH = COOKED_FOOD;
// Port Sarim <-> Draynor bank: north round the water, then the x 3089-3092 lane (fishing30.ts BANK_TO_SARIM).
const SARIM_TO_DRAYNOR: Pt[] = [[3047, 3237, 3], [3060, 3265, 3], [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR.x, DRAYNOR.z, 2]];
const DRAYNOR_TO_SARIM: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]];

if (OUTBOUND_ONLY && START_DRAYNOR) { console.log('RESULT fail OUTBOUND_ONLY requires an Ardougne start'); process.exit(1); }
if (!FROM && !HOME_ONLY && !OUTBOUND_ONLY && !FUND_ONLY) { console.log('RESULT fail FROM=<fish cook account> is required'); process.exit(1); }
if(FUND_ONLY&&(!FUND_FROM||HOME_ONLY||OUTBOUND_ONLY||START_DRAYNOR)||RESERVE_OPENING_CASH&&!FUND_ONLY){console.log('RESULT fail funding-only requires FUND_FROM at the destination bank');process.exit(1);}
if (SOURCES.some(n=>!/^[A-Za-z0-9_ -]{1,12}$/.test(n))) { console.log('RESULT fail invalid food source account'); process.exit(1); }
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const courierServer=serverFromEnv(readFileSync(join(import.meta.dir,'..','vendor/rs-sdk/bots',s.name,'bot.env'),'utf8'));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = () => s.sdk.getState()?.player;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const inv = () => (s.sdk.getState()?.inventory ?? []) as any[];
    const notes = () => inv().filter(i => FISH.test(i.name) && !(i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
    const fishNotes = () => notes().reduce((n, i) => n + i.count, 0);
    const coins = () => countItems(s, /^coins$/i);
    await waitTicks(s, 3);
    let hpMin = hp(), died = false;
    const jumps: string[] = [];
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if (hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) {
            jumps.push(`${s.tick()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (cheb(LUMBRIDGE, p) <= 15) died = true;
        }
        last = p;
    });
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;
    let walkTicks = 0, boatTicks = 0, waitTicksAt = 0, giveTicks = 0, received = 0, handed = 0;
    const legs: string[] = [];
    const leg = (name: string) => { legs.push(`${name}@${used()}`); console.log(`MILESTONE ${name} ${used()}`); };
    const timed = async <T>(add: (n: number) => void, f: () => Promise<T>): Promise<T> => {
        const a = s.tick();
        try { return await f(); } finally { add(s.tick() - a); }
    };
    const detail = () => `ticks=${used()} received=${received} handed=${handed} fishNotes=${fishNotes()} coins=${coins()} walkTicks=${walkTicks} boatTicks=${boatTicks} waitTicks=${waitTicksAt} giveTicks=${giveTicks} featherTicks=${featherTicks} feathersBought=${feathersBought} feathersLeft=${countItems(s, /^feather$/i)} legs=${legs.join(',')} hpMin=${hpMin} died=${died} jumps=${jumps.join(';')}`;
    const fail = async (why: string): Promise<never> => {
        off();
        const p = pos();
        return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} ${detail()}`);
    };

    const walk = (points: Pt[]): Promise<boolean> => timed(n => walkTicks += n, async () => {
        const [gx, gz, gtol] = points[points.length - 1]!;
        let left = points.map(([x, z, tol]) => ({ x, z, tol }));
        for (let i = 0; i < 3 && !died && !over(); i++) {
            const p = pos();
            if (p && p.level === 0 && cheb({ x: gx, z: gz }, p) <= gtol + 1) break;
            const r = await walkPath(await sessionWalker(s), left, { stop: () => died || over() });
            if (!r.ok) { console.log(`WALK fail ${r.detail} ticks=${r.ticks}`); await waitTicks(s, 1); }
            left = left.slice(Math.min(r.next, left.length - 1));
        }
        const p = pos();
        return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
    });
    // packages/core/src/boat.ts owns the bounded boat legs; the courier keeps its death and CAP stop.
    const stopBoat = () => died || over();
    const disembark = (): Promise<boolean> => timed(n => boatTicks += n, async () =>
        (await disembarkBoat(s, { stop: stopBoat })).ok);
    const sail = (npc: RegExp, pats: RegExp[], deck: { x: number; z: number }): Promise<boolean> => timed(n => boatTicks += n, async () =>
        (await sailBoat(s, { npc, choices: pats, deck, stop: stopBoat, onTalkFail: m => console.log(`TALK fail ${m}`) })).ok);
    const CUSTOMS = [/journey on this ship/i, /search away/i, /^ok\.?$/i];
    const SAILOR = [/^yes please/i];

    // Feathers for the cook's fly fishing (1 per fish) from Gerrant, Port Sarim (port_sarim.inv fishingshop: stock
    // 1000, base price2). Public depletion can make the price higher than this
    // trip's purchases suggest. Bound each batch by the maximum price and keep both return fares.
    const FEATHER = /^feather$/i;
    let featherTicks = 0, feathersBought = 0;
    const buyFeathers = () => timed(n => featherTicks += n, async () => {
        let source: any;
        if (/^[A-Za-z0-9_ -]{1,12}$/.test(FROM)) try { source = JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'status', `${FROM}.json`), 'utf8')); } catch { /* unknown stock keeps the configured amount */ }
        const wanted = featherPurchaseAmount(FEATHERS, FROM, source, Date.now());
        if (wanted <= 0) { console.log(`MILESTONE feathers-sufficient t=${used()}`); return; }
        if (!(await walk([[3014, 3224, 2]]))) { console.log('WARN walk to Gerrant failed'); return; }
        const o = await s.bot.openShop(/^gerrant$/i);
        if (!o.success) { console.log(`WARN openShop ${o.message}`); await waitTicks(s, 1); return; }
        const f0 = countItems(s, FEATHER);
        for (let i = 0; i < 20 && countItems(s, FEATHER) - f0 < wanted; i++) {
            const n = featherBatchAmount(coins(), wanted - (countItems(s, FEATHER) - f0));
            if (n <= 0) break;
            const before = countItems(s, FEATHER),coinsBefore=coins(),tickBefore=s.tick();
            const b = await s.bot.buyFromShop(FEATHER, n);
            const effect=featherPurchaseEffect(coinsBefore,before,coins(),countItems(s,FEATHER),n);
            console.log('FEATHER_PURCHASE_RECEIPT '+JSON.stringify({account:s.name,server:courierServer,supplier:FROM,requested:n,
                coinsBefore,coinsAfter:coins(),feathersBefore:before,feathersAfter:countItems(s,FEATHER),...effect,tickBefore,tickAfter:s.tick(),sdkSuccess:b.success}));
            if(effect.bought===0){console.log(`WARN buy feathers ${b.message}`);break;}
        }
        feathersBought = countItems(s, FEATHER) - f0;
        await s.bot.closeShop();
        console.log(`MILESTONE feathers ${feathersBought} coins=${coins()} t=${used()}`);
    });

    const p0 = pos();
    // A failed hand-out still owns its notes. Deliver them before paying for another collection trip.
    const resume = !HOME_ONLY && !OUTBOUND_ONLY ? deliveryResume(p0, fishNotes(), FARMERS.length) : null;
    const islandProblem=courierIslandProblem(p0?.combatLevel);
    // Check before funding, purchases or travel. Held cargo at the destination
    // bank needs no island crossing and can still be handed over.
    if(resume!=='bank'&&islandProblem)await fail(islandProblem);
    if (SOURCES.length > 1 && !resume && !HOME_ONLY) {
        const statuses = SOURCES.flatMap(name=>{
            try { return [JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'status', `${name}.json`), 'utf8'))]; }
            catch { return []; }
        });
        const selected = selectFoodSource(SOURCES,statuses,ownedAccounts('rs-sdk-demo.fly.dev'),Date.now());
        if (!selected) await fail('no active owned cook with banked food');
        FROM = selected!;
    }
    if(OUTBOUND_ONLY && (!p0 || p0.level!==0 || cheb(ARDY_BANK,p0)>10))
        await fail('outbound supply trip requires Ardougne bank start');
    if(FUND_ONLY&&RESERVE_OPENING_CASH){
        if(!p0||p0.level!==0||cheb(ARDY_BANK,p0)>6)await fail('opening cash reservation requires the funding bank');
        const amount=coins();
        if(amount>0){
            if(!(await s.bot.openBank()).success)await fail('opening cash bank unavailable');
            const item=s.sdk.getInventory().find(i=>i.id===995);
            if(!item||await depositObserved(s,item)!==amount)await fail('opening cash reservation unconfirmed');
            await s.bot.closeBank();
        }
        console.log('OPENING_CASH_RESERVED '+JSON.stringify({account:s.name,server:courierServer,amount,held:coins(),tick:s.tick()}));
    }
    let funding:{received:number;reason:string}|undefined;
    if(FUND_FROM){
        funding=await requestCourierFunding(s,FUND_FROM,courierServer);
        console.log(`FUNDING_RECEIPT received=${funding.received} reason=${funding.reason} coins=${coins()}`);
    }
    if(FUND_ONLY){
        if(!funding||!['paid','sufficient'].includes(funding.reason)||coins()<BOAT_FARES_ROUND)await fail('consumer funding unavailable');
        off();await finish([s],true,`fundingOnly=true received=${funding!.received} coins=${coins()} at=${p0?.worldX},${p0?.worldZ},${p0?.level}`);
    }
    console.log(`FOODCOURIER from=${FROM} farmers=${FARMERS.join(',') || '-'} coins=${coins()} fishNotes=${fishNotes()} at=${p0?.worldX},${p0?.worldZ}`);
    // Outbound start (scripts/courier-route.ts): sail from either Ardougne bank, walk only from east of White Wolf
    // Mountain. A branch that runs only for a start away from the south bank lets a south-bank start
    // skip Draynor, and a North-bank start walks over the mountain and dies.
    const start = START_DRAYNOR || resume ? null : outboundStart(p0);
    // "no courier progress" makes the supervisors block the account instead of logging it in again (supervise.ts).
    if (start === 'refuse') await fail('no courier progress: start is not an Ardougne bank or east of White Wolf Mountain');
    if (start === 'boat-north' || resume === 'bank' && outboundStart(p0) === 'boat-north') {
        if (!(await walk([[NORTH_TO_SOUTH.x, NORTH_TO_SOUTH.z, 2], [ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('walk to Ardougne south bank');
    }
    if (start !== null) {
        const requiredFare = OUTBOUND_ONLY ? BOAT_FARES_OUT : BOAT_FARES_ROUND;
        // Fares come from the bank when the pack is short (a live trip spent the pack on feathers, and
        // scripts/banker.ts banks the coins a donor gives).
        if (coins() < requiredFare) {
            const o = await s.bot.openBank();
            if (o.success) {
                for (const item of [...new Set(inv().filter(i => !/^coins$/i.test(i.name) && !notes().some(n => n.slot === i.slot)).map(i => i.name as string))]) {
                    await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                }
                await s.bot.withdrawItem(/^coins$/i, 500);
                await s.bot.closeBank();
            }
            console.log(`MILESTONE fares from bank coins=${coins()} t=${used()}`);
        }
        if (start === 'land') {
            // East of the mountain: walk to Port Sarim (one level-2 spider in reach from Varrock West).
            console.log(`MILESTONE east start; land route to Port Sarim`);
            if (!(await walk([[SARIM.x, SARIM.z, 3]]))) await fail('land route to Port Sarim');
            leg('land-sarim');
        } else if (coins() < requiredFare) {
            // At Ardougne without fares: never walk over White Wolf Mountain (the death). Stop and log out.
            await fail(`no courier progress: needs ${requiredFare} coins for the boat fares; refusing the White Wolf Mountain land route`);
        } else {
        if (!(await walk([[2679, 3275, 3]]))) await fail('walk to Barnaby');
        if (!(await sail(/^captain barnaby$/i, SAILOR, BRIM_DECK))) await fail('sail to Brimhaven');
        if (!(await disembark())) await fail('Brimhaven gangplank');
        if (!(await walk([[2774, 3228, 3], [2800, 3200, 5], [2850, 3175, 5], [2920, 3160, 5], [2956, 3146, 3]]))) await fail('walk to Musa Point');
        if (!(await sail(/^customs officer$/i, CUSTOMS, SARIM_DECK))) await fail('sail to Port Sarim');
        if (!(await disembark())) await fail('Port Sarim gangplank');
        leg('sarim');
        }
        if (FEATHERS > 0) await buyFeathers();
        if (!(await walk(SARIM_TO_DRAYNOR))) await fail('walk to Draynor bank');
        leg('draynor');
    }

    if(OUTBOUND_ONLY) {
        off();
        const p=pos();
        await finish([s],!died&&!!p&&p.level===0&&cheb(DRAYNOR,p)<=4,
            `outboundOnly=true ${detail()} coins=${coins()} at=${p?.worldX},${p?.worldZ},${p?.level}`);
    }

    // HOME_ONLY from Karamja: a session that ended between the boats goes on from the island (scripts/courier-route.ts).
    const fromKaramja = (HOME_ONLY || resume === 'karamja') && onKaramja(pos());
    if (START_DRAYNOR && !fromKaramja) {
        // From a Lumbridge respawn, the lane north of the jail guards (scripts/courier-route.ts draynorApproach).
        if (!(await walk(draynorApproach(pos())))) await fail('walk to Draynor bank');
        if (coins() < 60) {
            const o = await s.bot.openBank();
            if (o.success) {
                for (const item of [...new Set(inv().filter(i => !/^coins$/i.test(i.name) && !notes().some(n => n.slot === i.slot)).map(i => i.name as string))]) {
                    await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                }
                await s.bot.withdrawItem(/^coins$/i, 200);
                await s.bot.closeBank();
            }
        }
        leg(`draynor coins=${coins()}`);
    }
    // Take the notes: the cook starts the trade when it sees this bot (fishcook.ts handOff).
    const before = fishNotes();
    const who = new RegExp(`^${FROM.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
    if (!resume) await timed(n => waitTicksAt += n, async () => {
        console.log(`MILESTONE collecting ${FROM}`);
        const deadline = s.tick() + (HOME_ONLY ? 0 : WAIT);
        while (fishNotes() <= before && s.tick() < deadline && !died) {
            await awaitCollectionOffer(s,FROM,courierServer,Math.max(1,deadline-s.tick()));
            const give = countItems(s, FEATHER) > 0 ? [{ item: FEATHER, amount: -1 }] : [];
            const collection = await collectHandoff(s,FROM,courierServer,
                () => s.bot.serveTrades({ from: who, maxTrades: 1, give, timeout:Math.max(1000, (deadline - s.tick()) * 400) }));
            received += collection.received;
            const r = collection.result;
            if (fishNotes() <= before) { console.log(`TRADE ${r.reason} ${r.message}`); await waitTicks(s, 1); }
        }
    });
    leg(`received${received}`);
    if (received <= 0 && !HOME_ONLY && !resume) await fail('no fish notes from the cook');
    if (resume) leg(`resumed-cargo-${resume}`);

    // Home fares come from the Draynor bank. The land route home crosses White Wolf Mountain (scripts/courier-route.ts),
    // so without two fares the courier logs out here at the bank, notes kept, instead of walking it.
    if (resume !== 'bank') {
    const fareNeed = fromKaramja ? BOAT_FARES_OUT / 2 : BOAT_FARES_OUT;
    if (coins() < fareNeed && !fromKaramja) {
        const o = await s.bot.openBank();
        if (o.success) { await s.bot.withdrawItem(/^coins$/i, 200); await s.bot.closeBank(); }
        console.log(`MILESTONE home fares from Draynor bank coins=${coins()} t=${used()}`);
    }
    if (coins() < fareNeed) {
        await fail(`no courier progress: needs ${fareNeed} coins for the boats home; refusing the White Wolf Mountain land route`);
    } else {
    if (!fromKaramja) {
        if (!(await walk(DRAYNOR_TO_SARIM))) await fail('walk to Port Sarim');
        if (!(await sail(/^(seaman|captain tobias)/i, SAILOR, MUSA_DECK))) await fail('sail to Karamja');
        if (!(await disembark())) await fail('Musa Point gangplank');
    } else console.log(`MILESTONE resume on Karamja t=${used()}`);
    // Only the waypoints still ahead: from the middle of the island the first ones would walk back east.
    const toBrim: Pt[] = [[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]];
    const px = pos()?.worldX ?? 9999;
    if (!(await walk(toBrim.filter(([x], i) => i === toBrim.length - 1 || x < px)))) await fail('walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, CUSTOMS, ARDY_DECK))) await fail('sail to Ardougne');
    if (!(await disembark())) await fail('Ardougne gangplank');
    if (!(await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('walk to Ardougne bank');
    leg('ardougne');
    }
    }

    // Use the controller's wake level, then refill above it. Fed, offline and unknown farms get no trade window.
    const recipients = FARMERS.flatMap(name => {
        if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return [];
        try {
            const status = JSON.parse(readFileSync(join(import.meta.dir, '..', '.practice', 'status', `${name}.json`), 'utf8'));
            const need = foodRestockAmount(name, status, Date.now(),courierServer);
            return need !== undefined && need > 0 ? [{ name, need }] : [];
        } catch { return []; }
    }).sort((a, b) => b.need - a.need);
    console.log(`MILESTONE delivery-demand ${recipients.map(r => `${r.name}:${r.need}`).join(',') || 'none'} t=${used()}`);
    await timed(n => giveTicks += n, async () => {
        for (const { name: f, need } of recipients) {
            const cargo = notes();
            const amounts = courierFoodAllocation(cargo.map(i => i.count), need, PER, TOTAL_PER);
            const give = cargo.map((i, index) => {
                const amount = amounts[index]!;

                return { item: new RegExp(`^${i.name}$`, 'i'), amount };
            }).filter(g => g.amount > 0);
            if (give.length === 0) break;
            const n0 = fishNotes();
            const isNorth = /^mightyrod$/i.test(f);
            if (isNorth) {
                await walk([[2644, 3293, 2], [NORTH_BANK.x, NORTH_BANK.z, 2]]);
            } else {
                // Healthy farms meet actual cargo at this bank. Chasing them to the knights hides the cargo from
                // courierFoodReady and leaves both sides waiting for the other to move.
                if (!(await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('delivery bank rendezvous');
            }
            const meetBank=isNorth?NORTH_BANK:ARDY_BANK,meetDeadline=s.tick()+180;
            const ready=()=>deliveryRecipientAtBank(pos(),s.sdk.getState()?.nearbyPlayers??[],f,meetBank);
            for (let tryN = 0; tryN < 3 && fishNotes() === n0 && !died; tryN++) {
                if (!(await walk([[meetBank.x,meetBank.z,2]]))) break;
                // tradeWith walks after partners more than 12 tiles away. Keep cargo visible at the bank until
                // the farmer arrives and serves its trade; a visible farmer at the knights is not ready.
                if (!ready() && s.tick()<meetDeadline) await waitUntil(s,()=>ready()||died||over(),{timeoutTicks:meetDeadline-s.tick()});
                if (!ready()||died||over()) { console.log(`WARN rendezvous ${f} not at delivery bank`); break; }
                const expected = give.map(g => ({ id: notes().find(i => g.item.test(i.name))!.id, count: g.amount }));
                const delivered = await sendHandoff(s, f, courierServer, expected,
                    () => s.bot.trade(new RegExp(`^${f}$`, 'i'), { give, timeout: 60_000, requestTimeout: 30_000, retryOnBusy: false }));
                handed += delivered;
                console.log(`MILESTONE gave ${f} ${delivered} t=${used()}`);
                break;
            }
        }
    });
    // A north-bank hand-out returns to a known bank before the next run.
    { const q = pos(); if (q && cheb(ARDY_BANK, q) > 6 && cheb(NORTH_BANK, q) > 6) await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]); }
    off();
    const p = pos();
    const ok = !died && (received > 0 || HOME_ONLY || !!resume) && !!p && (cheb(ARDY_BANK, p) <= 6 || cheb(NORTH_BANK, p) <= 6) && (FARMERS.length === 0 || handed > 0 || recipients.length === 0);
    await finish([s], ok, `${detail()} at=${p?.worldX},${p?.worldZ},${p?.level}`);
} catch (e) { await finish([s], false, String(e)); }
