// Woodcutting to TARGET (default 45) with the 3-tick knife reset, under CAP game ticks (default 3000), without dying.
// Preset wc_fresh: a fresh account (bronze axe, Hitpoints 10, Lumbridge 3222,3218). Bench extra:woodcut-bury-block5:
// Woodcutting 1 and Prayer 1 at the Draynor bank with a rune axe, a knife and banked dragon bones; extra:woodcut-givers-
// block5: the same with a giver account that brings the bones.
// Plan: coins from Lumbridge men, the knife (ground spawn 3224,3202) and a better axe from Bob (3232,3203), each only
// when the account lacks it; then 3-tick woodcutting at the site (WC_SITE): the trees with the most XP a tick for the
// held axe. With bones in the pack, one bone is buried in each 3-tick cycle with no roll lost. Each cycle drops one
// spare log (an oak or better log, or a normal log above 4; above 1 with givers).
// Env: TARGET, CAP; WC_SITE=lumbridge (default) | draynor; PRAYER_TARGET (default 0: none); WC_BURY=0 never buries;
// WC_BANK_BONES=1 takes more bones from the site bank when the pack has none (a site with a bank: draynor);
// WC_GIVERS=<name>[,<name>...] has helper accounts bring the bones to the trees by trade (scripts/site-givers.ts; the
// helpers hold the bones in the site bank), WC_GIVER_PACK caps their pack; WC_KNIFE=0 chops with no knife reset;
// WC_QUICK=0 walks to each new tree before the next knife cycle.
// Code-read facts (vendor/rs-sdk/server/content/scripts):
// - The server gives 25x XP: a normal log is 625 XP, oak 937.5, willow 1687.5 (skill_woodcutting/configs/trees.dbrow
//   productexp, in tenths). A dragon bone is 1800 Prayer XP (skill_prayer/configs/bones.obj bone_exp 720).
// - The best axe in the pack or worn is used, with no level check (woodcut.rs2:220-240 woodcutting_axe_checker).
//   The content has bronze to rune axes and no dragon axe (skill_woodcutting/configs/axes/axes.obj).
// - A pickpocket fail on a man hits for 1 and stuns 8 ticks (pickpocket.dbrow; success 180-240 of 256). With 10 HP
//   the bot can take about 8 fails, so about 24 successes (72 coins): enough for the iron axe (56), seldom the steel
//   axe (200). The bot aims for steel only when its Hitpoints can pay for it. Bob sells no axe above steel
//   (areas/area_lumbridge/configs/lumbridge.inv [axeshop]).
// - Shops pay little for logs (general store 400/1000 with delta 30: oak logs 8 coins, then less), so no log sales.
// - The bury cycle. The engine runs every client message of a tick before the players' turns (engine World.ts
//   processClientsIn, then processPlayers). Bury (bury_bone.rs2) clears the interaction and the weak queue
//   (OpHeldHandler.ts clearPendingAction, p_stopaction) and sets p_delay(0): delayed until the next tick
//   (PlayerOps.ts P_DELAY, delayedUntil = tick + 1). A delayed player's next-tick messages are refused
//   (OpLocHandler.ts, OpHeldUHandler.ts), and the delay ends in that tick's player turn (World.ts processPlayers).
//   Cycle: tick A knife on log + Make 1 (%action_delay = A + 2, cut_logs.rs2:83-85) + Bury; A+1 refused, the bone
//   goes and its XP lands; A+2 Chop rolls at once (%action_delay = map_clock, woodcut.rs2:97-99); A+3 the next
//   cycle. One roll and one bone each 3 ticks, and the fletch never runs, so no log is used.
// - Sites (danger from bun research/route-danger.ts on the walk paths):
//   Lumbridge: the box x 3214-3239, z 3226-3250 (normal trees and the castle willow pair 3233,3244 and 3234,3238).
//   Giant spiders at 3200,3238 and 3203,3239 and a brown bear at 3176,3223 are outside it.
//   Draynor: the box x 3078-3110, z 3224-3258 beside the bank at 3092,3243: willows 3082,3237, 3085,3235, 3087,3231,
//   3088,3227 and 3088,3234, normal trees 3083,3242, 3086,3243, 3099,3242, 3099,3247, 3101,3252, 3106,3256 and
//   3109,3256 (maps/m48_50.jm2, locs 1308 and 1278). Dark wizards (young_dark_wizard, vislevel 7) at 3084,3236 and
//   3085,3238 hunt an account of combat 14 or less outside the Wilderness (all.hunt [ranged] check_nottoostrong;
//   engine Npc.ts: combat > 2 x vislevel is skipped), so the site needs combat 15. A jail guard (aggressive_melee
//   with no nottoostrong check, all.hunt; huntrange 5, draynor.npc) spawns at 3109,3237 and wanders to 3107,3241,
//   where the bench engine trace shows it hunt the bot at a tree 6 tiles away and the giver on its path. The bot uses
//   no tree within 12 tiles of the spawn: that leaves out both oaks (3102,3242, 3106,3247), the normal trees at
//   3099,3242 and 3099,3247, and the trees at 3104-3110,3228-3244.
import { openBot, finish, countItems, releasePrayerGuard, sessionDied } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';
import {runWoodSupply} from '../woodcut-supply';
import { componentId } from '../../packages/core/src/logout';
import { xpForLevel } from '../../packages/planner/src/curve';
import { newGiver, stage, refollow, beside, handOver, staged, giverStats, type Giver } from '../site-givers';

const CAP = Number(process.env.CAP ?? 3000);
const TARGET = Number(process.env.TARGET ?? 45);
const PRAYER_TARGET = Number(process.env.PRAYER_TARGET ?? 0);
const BURY = process.env.WC_BURY !== '0';
const BANK_BONES = process.env.WC_BANK_BONES === '1';
const GIVERS = (process.env.WC_GIVERS ?? '').split(',').map(n => n.trim()).filter(Boolean);
// The largest pack a giver brings (default: the free slots); a smaller pack means more trades of the same cost.
const GIVER_PACK = Number(process.env.WC_GIVER_PACK ?? 28);
const LUMBRIDGE = { x: 3222, z: 3218 };
const KNIFE_AT = { x: 3224, z: 3202 };
const BOB_AT = { x: 3230, z: 3203 };
const COINS = /^coins$/i;
const NORMAL_LOGS = /^logs$/i;
const DROP_LOGS = /^(oak|willow|maple|yew|magic) logs$/i;

type Pt = { x: number; z: number };
type Site = { anchor: Pt; more?: Pt[]; box: { x0: number; x1: number; z0: number; z1: number }; bank?: Pt; avoid: (Pt & { r: number })[]; minCombat: number };
const SITES: Record<string, Site> = {
    lumbridge: { anchor: { x: 3226, z: 3237 }, box: { x0: 3214, x1: 3239, z0: 3226, z1: 3250 }, avoid: [], minCombat: 0 },
    draynor: { anchor: { x: 3088, z: 3238 }, more: [{ x: 3072, z: 3254 }, { x: 3080, z: 3266 }], box: { x0: 3060, x1: 3110, z0: 3224, z1: 3274 }, bank: { x: 3092, z: 3243 }, avoid: [{ x: 3109, z: 3237, r: 12 }], minCombat: 15 },
};
const siteName = process.env.WC_SITE ?? 'lumbridge';
const SITE = SITES[siteName];

// Axes, weakest first: the server picks the best one held (woodcut.rs2:220-240).
const AXES = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune'] as const;
type Axe = (typeof AXES)[number];
type Chance = Record<Axe, [number, number]>;
// trees.dbrow: [levelrequired, productexp / 10, logs before it falls, successchance low/high per axe]. A normal tree
// (respawnrate 0) falls on every log; the others fall on 1 log in 8 (woodcut.rs2:168-174, 184).
const TREES: { re: RegExp; kind: string; level: number; xp: number; logs: number; chance: Chance }[] = [
    { re: /^(tree|dead tree|evergreen)$/i, kind: 'tree', level: 1, xp: 25, logs: 1, chance: { bronze: [64, 200], iron: [96, 300], steel: [128, 400], black: [144, 450], mithril: [160, 500], adamant: [192, 600], rune: [224, 700] } },
    { re: /^oak$/i, kind: 'oak', level: 15, xp: 37.5, logs: 8, chance: { bronze: [32, 100], iron: [48, 150], steel: [64, 200], black: [72, 225], mithril: [80, 250], adamant: [96, 300], rune: [112, 350] } },
    { re: /^willow$/i, kind: 'willow', level: 30, xp: 67.5, logs: 8, chance: { bronze: [16, 50], iron: [24, 75], steel: [32, 100], black: [36, 112], mithril: [40, 125], adamant: [48, 150], rune: [56, 175] } },
    { re: /^maple tree$/i, kind: 'maple', level: 45, xp: 100, logs: 8, chance: { bronze: [8, 25], iron: [12, 37], steel: [16, 50], black: [18, 56], mithril: [20, 62], adamant: [24, 75], rune: [28, 87] } },
    { re: /^yew$/i, kind: 'yew', level: 60, xp: 175, logs: 8, chance: { bronze: [4, 12], iron: [6, 19], steel: [8, 25], black: [9, 28], mithril: [10, 31], adamant: [12, 37], rune: [14, 44] } },
    { re: /^magic tree$/i, kind: 'magic', level: 75, xp: 250, logs: 8, chance: { bronze: [2, 6], iron: [3, 9], steel: [4, 12], black: [5, 13], mithril: [5, 15], adamant: [6, 18], rune: [7, 21] } },
];
// The bones a bank restock takes, most Prayer XP first: dragon (bone_exp 720), babydragon (300), big (150), bones,
// burnt bones, bat bones and wolf bones (45) (skill_prayer/configs/bones.obj; object ids from pack/obj.pack). In the
// pack the bot buries any item with a Bury option (bury_bone.rs2 [opheld1,_bones]).
const BONE_IDS = [536, 534, 532, 526, 528, 530, 2859];

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
const givers: Giver[] = [];
const sessions = () => [s, ...givers.map(g => g.s)];
try {
    // A giver waits by design (beside the trees, or once Prayer needs no more bones), so its no-progress stop is not a
    // fault; a death, a stop file or a lost lease ends the run.
    for (const name of GIVERS) {
        const g: Giver = newGiver(await openBot(name, { onStop: async (_gs, why) => { if (!/^no progress/.test(why)) g.failure ??= why; } }));
        givers.push(g);
    }
    await waitTicks(s, 5);
    if(process.env.SUPPLY_LOGS!==undefined){const r=await runWoodSupply(s,Number(process.env.SUPPLY_LOGS),Number(process.env.SUPPLY_HEADLESS??0),CAP);await finish([s],r.ok,'wood-supply '+JSON.stringify(r));}
    if (!SITE) await finish([s], false, `unknown WC_SITE ${siteName}: ${Object.keys(SITES).join(', ')}`);
    const site = SITE!;

    // A new live account starts on Tutorial Island (3094,3106); skip it before the clock starts.
    const p0 = s.sdk.getState()?.player;
    if (p0 && p0.worldX < 3160 && p0.worldZ < 3130) {
        const t = await s.bot.skipTutorial();
        console.log(`MILESTONE tutorial ${t.success ? 'ok' : 'fail'}`);
        if (!t.success) await finish([s], false, `tutorial skip failed: ${t.message}`);
    }
    const st = () => s.sdk.getState();
    const pos = () => st()?.player;
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const lvl = () => s.sdk.getSkill('Woodcutting')?.baseLevel ?? 0;
    const pxp = () => s.sdk.getSkillXp('Prayer') ?? 0;
    const plvl = () => s.sdk.getSkill('Prayer')?.baseLevel ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const coins = () => countItems(s, COINS);
    const invLen = () => st()?.inventory?.length ?? 0;
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    const held = () => [...(st()?.inventory ?? []), ...((st() as any)?.equipment ?? [])].filter((i: any) => i);
    const has = (re: RegExp) => held().some((i: any) => re.test(i.name));
    const axeHeld = (): Axe | null => { for (let k = AXES.length - 1; k >= 0; k--) if (has(new RegExp(`^${AXES[k]} axe$`, 'i'))) return AXES[k]!; return null; };
    const tier = (a: Axe | null) => (a ? AXES.indexOf(a) : -1);
    const bone = () => (s.sdk.getInventory() ?? []).map((i: any) => ({ slot: i.slot, op: i.optionsWithIndex?.find((o: any) => /^bury$/i.test(o.text))?.opIndex }))
        .find(b => b.op !== undefined) as { slot: number; op: number } | undefined;
    const boneCount = () => (s.sdk.getInventory() ?? []).filter((i: any) => i.optionsWithIndex?.some((o: any) => /^bury$/i.test(o.text))).length;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const xp0 = xp(), pxp0 = pxp();
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const left = () => CAP - 20 - now();

    // Death: HP 0 once the stats are known, or a jump of more than 20 tiles in one tick (a respawn). Bones: a drop in
    // the pack count outside the bank is a bury.
    let hpMin = hp();
    let died = false;
    // A death is the server's (sessionDied): a blank state in a disconnect reads HP 0 and no position.
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    let banking = false, buried = 0, bones = boneCount();
    const off = s.onTick(() => {
        hpMin = Math.min(hpMin, hp());
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
        const b = boneCount();
        if (!banking && b < bones) buried += bones - b;
        bones = b;
    });

    const marks: string[] = [];
    const mark = (name: string) => {
        if (marks.some(m => m.startsWith(`${name}@`))) return;
        marks.push(`${name}@${now()}`);
        console.log(`MILESTONE ${name} ${now()}`);
    };
    const checkLevels = () => {
        const l = lvl();
        for (const m of [15, 30, 45]) if (l >= m) mark(`level${m}`);
        for (let m = 55; m <= l; m += 10) mark(`level${m}`);
        for (let m = 10; m <= plvl() && pxp() > pxp0; m += 10) mark(`prayer${m}`);
        if (plvl() >= 99) mark('prayer99');
        if (l >= 99) mark('level99');
    };

    let walkTicks = 0, thiefTicks = 0, shopTicks = 0, chopTicks = 0, dropTicks = 0, approachTicks = 0, bankTicks = 0, noTreeTicks = 0;
    let tries = 0, stuns = 0, cycles = 0, buryCycles = 0, plainClicks = 0, approaches = 0, drops = 0, bans = 0, dialogs = 0, banks = 0, quick = 0, cycleDrops = 0, modalCloses = 0, trades = 0, tradeTicks = 0;
    let axe: Axe | null = axeHeld();
    // Bones left in the site bank: -1 until the bank is seen.
    let bankBones = -1;
    let lastFail = '';
    const kinds: Record<string, number> = {};
    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const gained = xp() - xp0;
        console.log(`RATE woodcutting ${gained} ${ticks}`);
        if (pxp() > pxp0) console.log(`RATE prayer ${pxp() - pxp0} ${ticks}`);
        const p = pos();
        const detail = `woodcutting=${lvl()} target=${TARGET} xp=${gained} prayer=${plvl()} prayerXp=${pxp() - pxp0} buried=${buried} ticks=${ticks} site=${siteName} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} died=${died} axe=${axe} `
            + `walkTicks=${walkTicks} thiefTicks=${thiefTicks} shopTicks=${shopTicks} chopTicks=${chopTicks} approachTicks=${approachTicks} dropTicks=${dropTicks} bankTicks=${bankTicks} noTreeTicks=${noTreeTicks} `
            + `tries=${tries} stuns=${stuns} cycles=${cycles} buryCycles=${buryCycles} plainClicks=${plainClicks} approaches=${approaches} quick=${quick} drops=${drops} cycleDrops=${cycleDrops} modalCloses=${modalCloses} banks=${banks} bans=${bans} dialogs=${dialogs} `
            + `trees=${JSON.stringify(kinds)} coins=${coins()} logs=${countItems(s, NORMAL_LOGS)} bankBones=${bankBones} trades=${trades} tradeTicks=${tradeTicks} givers=${JSON.stringify(giverStats(givers))} milestones=${marks.join(',')}`;
        return finish(sessions(), ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
    };
    const check = async (where: string) => {
        if (died) await end(false, `died ${where}`);
        if (left() <= 0) await end(false, `tick cap ${where}`);
    };

    const walk = async (x: number, z: number, tol: number): Promise<boolean> => {
        const w0 = now();
        try {
            for (let i = 0; i < 3 && !died; i++) {
                const p = pos();
                if (p && p.level === 0 && cheb({ x, z }, p) <= tol + 1) return true;
                const r = await s.bot.walkTo(x, z, tol);
                if (!r.success) lastFail = `walk ${x},${z}: ${r.message}`;
            }
            const p = pos();
            return !died && !!p && cheb({ x, z }, p) <= tol + 1;
        } finally { walkTicks += now() - w0; }
    };

    const closeDialog = async (): Promise<boolean> => {
        if (!s.sdk.getDialog()?.isOpen) return false;
        await s.sdk.sendClickDialog(0);
        dialogs++;
        await waitTicks(s, 1);
        return true;
    };

    // ---- Step 0: at a site with a bank, a knife and a better axe that the bank holds come into the pack first. A fleet
    // trade banks what it brings (scripts/fleet-trade.ts), so a staged account holds its tools in the bank: live,
    // the worker saw no axe in the pack, pickpocketed and walked to the Lumbridge knife spawn for 313 ticks.
    if (site.bank && (slotOf(/^knife$/i) === undefined || tier(axeHeld()) < tier('rune'))) {
        const p = pos();
        if (!p || cheb(site.bank, p) > 14) await walk(site.bank.x, site.bank.z, 3);
        const o = await s.bot.openBank();
        if (o.success) {
            const items = () => (st()?.bank?.items ?? []) as any[];
            const knife = slotOf(/^knife$/i) === undefined ? items().find(i => /^knife$/i.test(i.name) && i.count > 0) : undefined;
            if (knife) { const w = await s.bot.withdrawItem(knife, 1, { asNote: false }); if (!w.success) lastFail = `withdraw knife: ${w.message}`; }
            for (let k = AXES.length - 1; k >= 0 && tier(AXES[k]!) > tier(axeHeld()); k--) {
                const a = items().find(i => new RegExp(`^${AXES[k]} axe$`, 'i').test(i.name) && i.count > 0);
                if (!a) continue;
                const w = await s.bot.withdrawItem(a, 1, { asNote: false });
                if (!w.success) lastFail = `withdraw ${a.name}: ${w.message}`;
                break;
            }
            await waitTicks(s, 1);
            await s.bot.closeBank();
        } else lastFail = `openBank: ${o.message}`;
        axe = axeHeld();
        console.log(`WC_TOOLS_FROM_BANK ${JSON.stringify({ axe, knife: slotOf(/^knife$/i) !== undefined })}`);
    }

    // ---- Step 1: coins from Lumbridge men, one direct click every 2 ticks (thieving60.ts), only while the axe the
    // coins buy is better than the axe held. A fail costs 1 HP, so the bot only tries at HP 3 or more. Goal: 200
    // (steel) while the HP left can pay for it, else 56 (iron). About 3 coins per HP at 75% success: steel is in
    // reach when coins + 9 x (HP - 2) >= 200.
    const SHOP: { name: Axe; re: RegExp; cost: number }[] = [{ name: 'iron', re: /^iron axe$/i, cost: 56 }, { name: 'steel', re: /^steel axe$/i, cost: 200 }];
    const goal = () => (coins() + 9 * Math.max(0, hp() - 2) >= 200 ? 200 : 56);
    const buys = (c: number) => [...SHOP].reverse().find(a => c >= a.cost) ?? null;
    const better = (c: number) => tier(SHOP.find(a => a.cost === c)!.name) > tier(axeHeld());
    const th0 = now();
    for (let i = 0; i < 400 && better(goal()) && coins() < goal() && hp() >= 3 && !died && now() - th0 < 500 && left() > 0; i++) {
        if (await closeDialog()) continue;
        const p = pos();
        const man = (st()?.nearbyNpcs ?? [])
            .filter((n: any) => /^(man|woman)$/i.test(n.name) && n.optionsWithIndex?.some((o: any) => /pickpocket/i.test(o.text))
                && (!p || Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= 15))
            .sort((a: any, b: any) => a.distance - b.distance)[0] as any;
        if (!man) {
            if (p && cheb(LUMBRIDGE, p) > 15) await walk(LUMBRIDGE.x, LUMBRIDGE.z, 3);
            else await waitTicks(s, 1);
            continue;
        }
        tries++;
        const op = man.optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text)).opIndex;
        const hp0 = hp();
        await s.direct({ type: 'interactNpc', npcIndex: man.index, optionIndex: op, reason: 'SDK' });
        await waitTicks(s, 2);
        // An HP drop is a fail: the server drops clicks for the rest of the 8-tick stun.
        if (hp() < hp0) { stuns++; await waitTicks(s, 6); }
    }
    thiefTicks += now() - th0;
    await check('pickpocketing');
    await closeDialog();

    // ---- Step 2: the knife (ground spawn south of the castle), unless the account holds one.
    if (slotOf(/^knife$/i) === undefined) {
        if (!(await walk(KNIFE_AT.x, KNIFE_AT.z, 1))) lastFail = `walk to knife: ${lastFail}`;
        for (let i = 0; i < 15 && slotOf(/^knife$/i) === undefined && !died; i++) {
            const g = s.sdk.findGroundItem(/^knife$/i);
            if (!g || g.distance > 6) { await waitTicks(s, 2); continue; }
            const r = await s.bot.pickupItem(g);
            if (!r.success) { lastFail = `pickup knife: ${r.message}`; await waitTicks(s, 1); }
        }
        if (slotOf(/^knife$/i) !== undefined) mark('knife');
        else console.log('WARN no knife: chopping without the 3-tick trick');
        await check('at the knife');
    }

    // ---- Step 3: the best axe the coins buy at Bob's, when it is better than the axe held.
    const q0 = now();
    const want = buys(coins());
    if (want && tier(want.name) > tier(axeHeld())) {
        await walk(BOB_AT.x, BOB_AT.z, 2);
        const o = await s.bot.openShop(/^bob$/i);
        if (!o.success) lastFail = `openShop bob: ${o.message}`;
        else {
            const b = await s.bot.buyFromShop(want.re, 1);
            if (!b.success) lastFail = `buy ${want.name} axe: ${b.message}`;
            await s.bot.closeShop();
        }
        if (has(want.re)) {
            // Wielding is optional: the pack axe works the same (woodcutting_axe_checker).
            const e = await s.bot.equipItem(want.re);
            if (!e.success) lastFail = `equip ${want.name} axe: ${e.message}`;
            mark(`${want.name}axe`);
        }
        shopTicks += now() - q0;
        await check('at Bob');
    } else if (tier(axeHeld()) < tier('iron')) console.log(`WARN only ${coins()} coins: keeping the ${axeHeld() ?? 'no'} axe`);
    axe = axeHeld();
    if (!axe) await end(false, 'no axe');

    const combat = pos()?.combatLevel ?? 0;
    if (combat < site.minCombat) await end(false, `site ${siteName} needs combat ${site.minCombat}, the account has ${combat}`);

    // ---- Step 4: chop at the site to TARGET. Every 3 ticks, in one tick: knife on a normal log, "Make 1",
    // chop the tree (scripts/measure/wc-3tick.ts). With a bone: knife, Make 1 and Bury in one tick, Chop 2 ticks
    // later (the bury cycle above). Without a knife or a normal log: one click, the server chains.
    // The prayer guard stops here. Once Prayer has points it flicks a prayer (two clicks) before the cycle's inputs; the
    // server reads 5 user inputs a player a tick (ClientGameProtCategory USER_EVENT), so the rest of the cycle spills
    // into the next tick, and a Chop before the knife lets the fletch use a log. No site here needs a prayer.
    await releasePrayerGuard(s);
    if (!(await walk(site.anchor.x, site.anchor.z, 2))) lastFail = `walk to trees: ${lastFail}`;
    const make1 = componentId('skill_multi3:make1_a');
    // stat_random(level, low, high): chance about (low x (99 - L) + high x (L - 1)) / 98 / 256.
    const chance = (t: (typeof TREES)[number]) => {
        const [lo, hi] = t.chance[axe!];
        const L = lvl();
        return Math.min(1, (lo * (99 - L) + hi * (L - 1)) / 98 / 256);
    };
    const banned = new Map<string, number>();
    const key = (l: { x: number; z: number }) => `${l.x},${l.z}`;
    const typeOf = (l: any) => TREES.find(t => t.re.test(l.name) && l.optionsWithIndex?.some((o: any) => /chop/i.test(o.text)));
    const standing = (c: any) => (st()?.nearbyLocs ?? []).some((l: any) => l.x === c.x && l.z === c.z && l.id === c.id);
    const inSite = (l: Pt) => l.x >= site.box.x0 && l.x <= site.box.x1 && l.z >= site.box.z0 && l.z <= site.box.z1
        && site.avoid.every(a => Math.max(Math.abs(l.x - a.x), Math.abs(l.z - a.z)) > a.r);
    // XP per tick for the expected stay at the tree, with the walk counted (run: 2 tiles a tick).
    const choose = (): any => {
        const p = pos();
        if (!p) return null;
        // Spare normal logs first, up to the count the cycles keep: one with givers, KEEP_LOGS in a bank run (the bank
        // takes the rest), three in a plain run. A higher mark makes the bot choose normal trees over willows.
        const fewLogs = countItems(s, NORMAL_LOGS) < (givers.length ? 1 : BANK_BONES ? KEEP_LOGS : 3) && slotOf(/^knife$/i) !== undefined;
        let best: any = null, bestScore = 0;
        for (const l of (st()?.nearbyLocs ?? []) as any[]) {
            const t = typeOf(l);
            if (!t || lvl() < t.level || !inSite(l)) continue;
            if ((banned.get(key(l)) ?? 0) > now()) continue;
            const pc = chance(t);
            const walkT = Math.max(0, cheb(l, p) - 1) / 2;
            let score = (t.xp * t.logs) / (walkT + 2 + (3 * t.logs) / pc);
            // Spare normal logs first: a missed 3-tick click can fletch one.
            if (fewLogs && t.kind === 'tree') score *= 3;
            if (score > bestScore) { bestScore = score; best = { ...l, kind: t.kind, op: l.optionsWithIndex.find((o: any) => /chop/i.test(o.text)).opIndex }; }
        }
        return best;
    };
    // Normal logs above 4, and every better log, go on the ground.
    const dropLogs = async () => {
        const d0 = now();
        await closeDialog();
        for (let r = 0; r < 6 && !died; r++) {
            const inv = (s.sdk.getInventory() ?? []) as any[];
            const normal = inv.filter(i => NORMAL_LOGS.test(i.name)).slice(4);
            const slots = [...inv.filter(i => DROP_LOGS.test(i.name)), ...normal].map(i => i.slot);
            if (slots.length === 0) break;
            for (const sl of slots.slice(0, 10)) await s.direct({ type: 'dropItem', slot: sl, reason: 'SDK' });
            await waitTicks(s, 1);
        }
        drops++;
        dropTicks += now() - d0;
    };
    // At the site bank: the better logs and the normal logs above 2 go in, and the best bones come out. With a knife
    // and a normal log they fill the pack: the bury of the first cycle frees a slot before its Chop rolls (a chop needs
    // one, woodcut.rs2:41-47), and each cycle then drops a spare log, so the pack only gets smaller. With no knife or
    // normal log the plain chain adds logs with no bury, so the bones come out to 25 items. The bot takes no more bones
    // than PRAYER_TARGET needs, at the Prayer XP a bone gave in this run.
    const KEEP_LOGS = 2;
    let boneXp = 0;
    const canBank = () => BANK_BONES && !!site.bank && bankBones !== 0;
    const spareLogs = () => (s.sdk.getInventory() ?? []).filter((i: any) => DROP_LOGS.test(i.name)).length + Math.max(0, countItems(s, NORMAL_LOGS) - KEEP_LOGS);
    const restock = async () => {
        const b0 = now();
        banking = true;
        try {
            await closeDialog();
            // openBank walks to the nearest booth in view; from farther away the walker goes first.
            const p = pos();
            if (!p || cheb(site.bank!, p) > 14) {
                if (!(await walk(site.bank!.x, site.bank!.z, 3))) { lastFail = `walk to bank: ${lastFail}`; return; }
            }
            const o = await s.bot.openBank();
            if (!o.success) { lastFail = `openBank: ${o.message}`; bankBones = 0; return; }
            const inv = (s.sdk.getInventory() ?? []) as any[];
            for (const id of [...new Set(inv.filter(i => DROP_LOGS.test(i.name)).map(i => i.id))]) {
                const item = (s.sdk.getInventory() ?? []).find((i: any) => i.id === id);
                if (item) { const d = await s.bot.depositItem(item, -1); if (!d.success) lastFail = `deposit ${item.name}: ${d.message}`; }
            }
            const extra = countItems(s, NORMAL_LOGS) - KEEP_LOGS;
            const normal = (s.sdk.getInventory() ?? []).find((i: any) => NORMAL_LOGS.test(i.name));
            if (extra > 0 && normal) await s.bot.depositItem(normal, extra);
            const items = () => (st()?.bank?.items ?? []) as any[];
            // Past PRAYER_TARGET the bones left in the pack go back in, so the pack has room for logs.
            if (!buryOn()) {
                for (const id of BONE_IDS) {
                    const item = (s.sdk.getInventory() ?? []).find((i: any) => i.id === id);
                    if (item) await s.bot.depositItem(item, -1);
                }
            }
            if (buried > 0) boneXp = (pxp() - pxp0) / buried;
            const fill = slotOf(/^knife$/i) !== undefined && slotOf(NORMAL_LOGS) !== undefined;
            const free = 28 - invLen();
            const need = PRAYER_TARGET > 0 && boneXp > 0 ? Math.ceil((xpForLevel(PRAYER_TARGET) - pxp()) / boneXp) - boneCount() : Infinity;
            const room = !buryOn() ? 0 : Math.min(need, (fill ? 28 : 25) - invLen());
            const best = BONE_IDS.map(id => items().find(i => i.id === id && i.count > 0)).find(i => i);
            const before = boneCount();
            if (best && room > 0) {
                // Withdraw-All (-1) fills the free slots with no amount dialog; the SDK reports it as a partial withdrawal.
                const all = room >= free && best.count >= free;
                const w = await s.bot.withdrawItem(best, all ? -1 : Math.min(room, best.count), { asNote: false });
                if (!w.success && !all) lastFail = `withdraw ${best.name}: ${w.message}`;
            }
            bankBones = items().filter(i => BONE_IDS.includes(i.id)).reduce((n, i) => n + i.count, 0);
            // A withdrawal that gives no bone ends the restocks, so the bot does not walk the bank loop for nothing.
            if (room > 0 && boneCount() <= before) {
                console.log(`WARN restock gave no bones: bank ${JSON.stringify(items().slice(0, 8).map(i => [i.id, i.count]))} room=${room} ${lastFail}`);
                bankBones = 0;
            }
            await s.bot.closeBank();
            banks++;
        } finally {
            bones = boneCount();
            banking = false;
            bankTicks += now() - b0;
        }
        // No walk back: the next approach walks to the tree it picks, and with no tree in view the loop walks to the anchor.
    };
    // Bones go in the ground until Prayer reaches PRAYER_TARGET (no target: every bone held).
    const buryOn = () => BURY && (PRAYER_TARGET <= 0 || plvl() < PRAYER_TARGET);
    // Givers (WC_GIVERS, scripts/site-givers.ts) bring the bones to the trees, so the bot never banks for them. A pack
    // is the free slots of the bot's pack less two logs (the knife's normal log, held or to come, and the log of the
    // roll before the trade, which arrives too late to drop), and no more than PRAYER_TARGET needs less the bones held
    // and on the way. With givers the cycles keep one normal log, not four. When the pack has no bone, the bot trades with a ready
    // giver that stands next to it, right after a roll: the trade window stops the tree, so each trade costs its
    // ticks, and one full pack a trade gives the fewest trades.
    const giverSite = site.bank ? { bank: site.bank, ids: BONE_IDS } : undefined;
    if (givers.length && !giverSite) await end(false, `site ${siteName} has no bank for the givers`);
    const isLog = (i: any) => NORMAL_LOGS.test(i.name) || DROP_LOGS.test(i.name);
    const isBone = (i: any) => i.optionsWithIndex?.some((o: any) => /^bury$/i.test(o.text));
    const packSlots = () => Math.min(GIVER_PACK, 28 - (s.sdk.getInventory() ?? []).filter((i: any) => !isLog(i) && !isBone(i)).length - 2);
    const bonesLeft = () => {
        if (buried > 0) boneXp = (pxp() - pxp0) / buried;
        const need = PRAYER_TARGET > 0 && boneXp > 0 ? Math.ceil((xpForLevel(PRAYER_TARGET) - pxp()) / boneXp) : Infinity;
        return need - boneCount() - staged(givers);
    };
    const giverLeft = () => givers.some(g => !g.empty && (g.ready || g.flight)) || givers.some(g => !g.empty) && bonesLeft() > 0;
    const takeBones = async (g: Giver) => {
        const t0 = now();
        // Room for the whole pack: the logs go but one normal log (5 inputs a tick at most), and an open dialog closes.
        for (let r = 0; r < 4 && 28 - invLen() < g.n; r++) {
            const inv = (s.sdk.getInventory() ?? []) as any[];
            const keep = inv.find(i => NORMAL_LOGS.test(i.name));
            const slots = inv.filter(i => isLog(i) && i !== keep).map(i => i.slot).slice(0, 5);
            if (!slots.length) break;
            for (const sl of slots) await s.direct({ type: 'dropItem', slot: sl, reason: 'SDK' });
            await waitTicks(s, 1);
        }
        if (28 - invLen() < g.n) await end(false, `no room for a giver pack of ${g.n}`);
        // A dialog makes the bot busy, and the server holds its trade request until the dialog closes (engine trace:
        // `act target=NetworkPlayer ... access=false modal=2` for 10 ticks, then a trade that did not reconcile). A
        // Woodcutting level from the last roll can still have its dialog queued, and two levels queue two dialogs.
        for (let r = 0; r < 4 && (s.sdk.getDialog()?.isOpen || lvl() > lastLvl); r++) {
            lastLvl = lvl();
            if (s.sdk.getDialog()?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
            await waitTicks(s, 1);
        }
        await handOver(s, g, () => died || left() <= 0);
        trades++;
        tradeTicks += now() - t0;
        bones = boneCount();
    };
    const prayerLeft = () => PRAYER_TARGET > 0 && buryOn() && (boneCount() > 0 || canBank() || giverLeft());

    let cur: any = null, moved = false, lastLvl = lvl(), spot = 0;
    const spots = [site.anchor, ...(site.more ?? [])];
    let lastXp = xp(), lastGain = now();
    for (let i = 0; i < 20000 && (lvl() < TARGET || prayerLeft()) && !died && left() > 0; i++) {
        checkLevels();
        const x = xp();
        if (x > lastXp) { lastXp = x; lastGain = now(); }
        const failed = givers.find(g => g.failure);
        if (failed) await end(false, `giver ${failed.s.name}: ${failed.failure}`);
        if (givers.length && buryOn()) {
            for (const g of givers) if (!g.ready && !g.flight && !g.empty && bonesLeft() > 0) void stage(g, giverSite!, Math.min(packSlots(), bonesLeft()), s);
            if (boneCount() === 0) {
                const g = givers.find(g => g.ready);
                if (g && beside(g, s)) { await takeBones(g); lastGain = now(); continue; }
                if (g) refollow(g, s);
            }
        }
        if (!givers.length && buryOn() && boneCount() === 0 && canBank()) { await restock(); cur = null; lastGain = now(); continue; }
        // A full pack with bones to bury empties itself: each bury cycle takes a bone before its Chop. With one slot
        // free and no normal log yet, the plain chain fills that slot with the knife's log.
        const knifeAndLog = slotOf(/^knife$/i) !== undefined && slotOf(NORMAL_LOGS) !== undefined;
        if (invLen() >= 27 && !(buryOn() && boneCount() > 0 && (knifeAndLog || invLen() < 28))) {
            // The bank when bones are wanted or held (past PRAYER_TARGET they go back in); else the logs go on the
            // ground, which takes fewer ticks than the walk to the bank.
            if (canBank() && (buryOn() || boneCount() > 0) && spareLogs() > 0) await restock(); else await dropLogs();
            if (invLen() >= 27) await end(false, 'pack full with no log to bank or drop');
            cur = null; continue;
        }
        if (cur && !standing(cur)) cur = null;
        // About 5 expected logs' worth of rolls (3 ticks each) with none: willow with an iron axe is 15% a roll, so a
        // fixed 30 ticks would leave a good tree one time in five.
        const stall = cur ? Math.max(30, Math.ceil(15 / chance(TREES.find(t => t.kind === cur.kind)!)) + 10) : 0;
        if (cur && now() - lastGain > stall) {
            // No log for that long: the tree is out of reach (or a bad pick). Leave it for 100 ticks.
            banned.set(key(cur), now() + 100);
            bans++;
            lastFail = `no xp in ${stall} ticks at ${cur.kind} ${key(cur)}`;
            cur = null;
        }
        if (!cur) {
            const t = choose();
            // Away from the main spot, a tree kind better than the best in view sends the bot back to the main spot,
            // which holds the site's best trees.
            const unlocked = Math.max(...TREES.filter(k => k.level <= lvl()).map(k => k.level));
            if (spot !== 0 && t && (TREES.find(k => k.kind === t.kind)?.level ?? 0) < unlocked) {
                spot = 0;
                await walk(site.anchor.x, site.anchor.z, 2);
                continue;
            }
            if (!t) {
                // No tree in view: the next spot of the site (the trees respawn meanwhile), or a wait at a site of one.
                const p = pos(), a = spots[spot]!;
                if (!p || cheb(a, p) > 4) await walk(a.x, a.z, 2);
                else if (spots.length > 1) { spot = (spot + 1) % spots.length; await walk(spots[spot]!.x, spots[spot]!.z, 2); }
                else { await waitTicks(s, 1); noTreeTicks++; }
                continue;
            }
            // A tree 4 tiles or less away: the next knife cycle clicks it. Knife and Make 1 set %action_delay to 2
            // ticks ahead; the run (2 tiles a tick) reaches the tree in that time, and the Chop rolls on time. That
            // cycle has no bury, which would drop the walk.
            const p = pos();
            if (p && process.env.WC_QUICK !== '0' && cheb(t, p) <= 4 && process.env.WC_KNIFE !== '0' && slotOf(/^knife$/i) !== undefined && slotOf(NORMAL_LOGS) !== undefined) {
                cur = t;
                moved = true;
                quick++;
                kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
                lastGain = now();
                continue;
            }
            // The server walks to the tree on a direct click; wait until the bot stands still beside it.
            const a0 = now();
            await closeDialog();
            await s.direct({ type: 'interactLoc', x: t.x, z: t.z, locId: t.id, optionIndex: t.op, reason: 'SDK' });
            approaches++;
            let prev = pos();
            for (let k = 0; k < 25 && !died; k++) {
                await waitTicks(s, 1);
                const p = pos();
                if (k >= 1 && p && prev && p.worldX === prev.worldX && p.worldZ === prev.worldZ) break;
                prev = p;
            }
            approachTicks += now() - a0;
            cur = t;
            kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
            lastGain = now();
            continue;
        }
        const knife = process.env.WC_KNIFE === '0' ? undefined : slotOf(/^knife$/i), log = slotOf(NORMAL_LOGS);
        // A Woodcutting level from the last roll queues its level-up dialog (levelup.rs2, engine queue). The queue runs
        // only when the player is not delayed and has no window open (Player.ts canAccess), so after a bury it runs in
        // tick A+1 and holds back the Prayer level-up of the same bury to tick A+2, after the Chop's input: the dialog
        // then blocks the roll. This cycle has no bury, and the dialog is closed in tick A+1 (CloseModal is read while
        // delayed and acted on before the interaction, Player.ts processQueues), so the roll in A+2 runs.
        const levelled = lvl() > lastLvl;
        lastLvl = lvl();
        const b = buryOn() && !moved && !levelled ? bone() : undefined;
        moved = false;
        // One spare log goes on the ground at the start of each cycle (drop.rs2 has no delay; the OpHeld drops only the
        // interaction, which the cycle sets again), so the pack never fills. The server reads 5 user inputs a tick
        // (ClientGameProtCategory USER_EVENT); a cycle sends 4 at most.
        const inv = (s.sdk.getInventory() ?? []) as any[];
        const spare = (inv.find(i => DROP_LOGS.test(i.name)) ?? inv.filter(i => NORMAL_LOGS.test(i.name))[givers.length ? 1 : 4])?.slot as number | undefined;
        const k0 = now();
        if (spare !== undefined && knife !== undefined && log !== undefined) { await s.direct({ type: 'dropItem', slot: spare, reason: 'SDK' }); cycleDrops++; }
        if (knife === undefined || log === undefined) {
            // Click-once chain: click again only after a level-up dialog closed it.
            if (await closeDialog()) {
                await s.direct({ type: 'interactLoc', x: cur.x, z: cur.z, locId: cur.id, optionIndex: cur.op, reason: 'SDK' });
                plainClicks++;
            }
            await waitTicks(s, 1);
        } else if (b) {
            // The bury cycle: the bury drops the interaction and the fletch, the delay holds one tick, the Chop rolls.
            await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
            await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
            await s.direct({ type: 'useInventoryItem', slot: b.slot, optionIndex: b.op, reason: 'SDK' });
            await waitTicks(s, 2);
            await s.direct({ type: 'interactLoc', x: cur.x, z: cur.z, locId: cur.id, optionIndex: cur.op, reason: 'SDK' });
            cycles++;
            buryCycles++;
            await waitTicks(s, 1);
        } else {
            // The knife-on-log also closes a level-up dialog.
            await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
            await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
            await s.direct({ type: 'interactLoc', x: cur.x, z: cur.z, locId: cur.id, optionIndex: cur.op, reason: 'SDK' });
            cycles++;
            await waitTicks(s, 1);
            // A level-up dialog that opened after the cycle's inputs blocks the tree until it closes.
            if (s.sdk.getDialog()?.isOpen) { await s.direct({ type: 'closeModal', reason: 'SDK' }); modalCloses++; }
            await waitTicks(s, 2);
        }
        chopTicks += now() - k0;
    }
    await closeDialog();
    checkLevels();
    const ok = lvl() >= TARGET && (PRAYER_TARGET <= 0 || plvl() >= PRAYER_TARGET) && !died;
    await end(ok, died ? 'died' : lvl() < TARGET ? `woodcutting ${lvl()} < ${TARGET}` : `prayer ${plvl()} < ${PRAYER_TARGET}`);
} catch (e) { await finish(sessions(), false, String(e)); }
