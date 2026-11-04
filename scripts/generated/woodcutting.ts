// Fresh account (bronze axe, Hitpoints 10, Lumbridge 3222,3218) to Woodcutting TARGET (default 45), without dying,
// under CAP game ticks (default 3000). Preset wc_fresh.
// Plan: coins from Lumbridge men, knife (ground spawn 3224,3202), a better axe from Bob (3232,3203), then 3-tick
// woodcutting north of the castle: normal trees, then willows from 30 (castle river pair 3233,3244 and 3234,3238).
// Code-read facts:
// - The server gives 25x XP: a normal log is 625 XP, oak 937.5, willow 1687.5 (skill_woodcutting/configs/trees.dbrow).
// - The best axe in the pack or worn is used, with no level check (woodcut.rs2 woodcutting_axe_checker).
// - A pickpocket fail on a man hits for 1 and stuns 8 ticks (pickpocket.dbrow; success 180-240 of 256). With 10 HP
//   the bot can take about 8 fails, so about 24 successes (72 coins): enough for the iron axe (56), seldom the steel
//   axe (200). The bot aims for steel only when its Hitpoints can pay for it.
// - Shops pay little for logs (general store 400/1000 with delta 30: oak logs 8 coins, then less), so no log sales.
// - Danger (bun research/route-danger.ts): giant spiders at 3200,3238 and 3203,3239, a brown bear at 3176,3223.
//   The bot only chops trees in the box x 3214-3239, z 3226-3250 (clear, 0 danger spawns on the checked path).
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';
import {runWoodSupply} from '../woodcut-supply';
import { componentId } from '../../packages/core/src/logout';

const CAP = Number(process.env.CAP ?? 3000);
const TARGET = Number(process.env.TARGET ?? 45);
const LUMBRIDGE = { x: 3222, z: 3218 };
const KNIFE_AT = { x: 3224, z: 3202 };
const BOB_AT = { x: 3230, z: 3203 };
const ANCHOR = { x: 3226, z: 3237 };
const BOX = { x0: 3214, x1: 3239, z0: 3226, z1: 3250 };
const COINS = /^coins$/i;
const NORMAL_LOGS = /^logs$/i;
const DROP_LOGS = /^(oak|willow) logs$/i;
type Axe = 'bronze' | 'iron' | 'steel';
// trees.dbrow: [levelrequired, xp, logs before it falls (normal 1, else 8 on average), success low/high per axe].
const TREES: { re: RegExp; kind: string; level: number; xp: number; logs: number; chance: Record<Axe, [number, number]> }[] = [
    { re: /^tree$/i, kind: 'tree', level: 1, xp: 25, logs: 1, chance: { bronze: [64, 200], iron: [96, 300], steel: [128, 400] } },
    { re: /^oak$/i, kind: 'oak', level: 15, xp: 37.5, logs: 8, chance: { bronze: [32, 100], iron: [48, 150], steel: [64, 200] } },
    { re: /^willow$/i, kind: 'willow', level: 30, xp: 67.5, logs: 8, chance: { bronze: [16, 50], iron: [24, 75], steel: [32, 100] } },
];

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    if(process.env.SUPPLY_LOGS!==undefined){const r=await runWoodSupply(s,Number(process.env.SUPPLY_LOGS),Number(process.env.SUPPLY_HEADLESS??0),CAP);await finish([s],r.ok,'wood-supply '+JSON.stringify(r));}

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
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const coins = () => countItems(s, COINS);
    const invLen = () => st()?.inventory?.length ?? 0;
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    const has = (re: RegExp) => [...(st()?.inventory ?? []), ...((st() as any)?.equipment ?? [])].some((i: any) => i && re.test(i.name));
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    const xp0 = xp();
    const t0 = s.tick();
    const now = () => s.tick() - t0;
    const left = () => CAP - 20 - now();

    // Death: HP 0 once the stats are known, or a jump of more than 20 tiles in one tick (a respawn).
    let hpMin = hp();
    let died = false;
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if ((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0) > 0 && hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) died = true;
        last = p;
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
    };

    let walkTicks = 0, thiefTicks = 0, shopTicks = 0, chopTicks = 0, dropTicks = 0, approachTicks = 0;
    let tries = 0, stuns = 0, cycles = 0, plainClicks = 0, approaches = 0, drops = 0, bans = 0, dialogs = 0;
    let axe: Axe = 'bronze';
    let lastFail = '';
    const kinds: Record<string, number> = {};
    const end = async (ok: boolean, why: string): Promise<never> => {
        off();
        const ticks = now();
        const gained = xp() - xp0;
        console.log(`RATE woodcutting ${gained} ${ticks}`);
        const p = pos();
        const detail = `woodcutting=${lvl()} target=${TARGET} xp=${gained} ticks=${ticks} at=${p?.worldX},${p?.worldZ},${p?.level} hp=${hp()} hpMin=${hpMin} died=${died} axe=${axe} `
            + `walkTicks=${walkTicks} thiefTicks=${thiefTicks} shopTicks=${shopTicks} chopTicks=${chopTicks} approachTicks=${approachTicks} dropTicks=${dropTicks} `
            + `tries=${tries} stuns=${stuns} cycles=${cycles} plainClicks=${plainClicks} approaches=${approaches} drops=${drops} bans=${bans} dialogs=${dialogs} `
            + `trees=${JSON.stringify(kinds)} coins=${coins()} logs=${countItems(s, NORMAL_LOGS)} milestones=${marks.join(',')}`;
        return finish([s], ok, ok ? detail : `${why} ${detail} last=${lastFail}`);
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

    // ---- Step 1: coins from Lumbridge men, one direct click every 2 ticks (thieving60.ts). A fail costs 1 HP, so
    // the bot only tries at HP 3 or more. Goal: 200 (steel) while the HP left can pay for it, else 56 (iron).
    // About 3 coins per HP at 75% success: steel is in reach when coins + 9 x (HP - 2) >= 200.
    const goal = () => (coins() + 9 * Math.max(0, hp() - 2) >= 200 ? 200 : 56);
    const th0 = now();
    for (let i = 0; i < 400 && coins() < goal() && hp() >= 3 && !died && now() - th0 < 500 && left() > 0; i++) {
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

    // ---- Step 2: the knife (ground spawn south of the castle).
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

    // ---- Step 3: the best axe the coins buy at Bob's.
    const q0 = now();
    const want: { name: Axe; re: RegExp; cost: number } | null = coins() >= 200 ? { name: 'steel', re: /^steel axe$/i, cost: 200 }
        : coins() >= 56 ? { name: 'iron', re: /^iron axe$/i, cost: 56 } : null;
    if (want) {
        await walk(BOB_AT.x, BOB_AT.z, 2);
        const o = await s.bot.openShop(/^bob$/i);
        if (!o.success) lastFail = `openShop bob: ${o.message}`;
        else {
            const b = await s.bot.buyFromShop(want.re, 1);
            if (!b.success) lastFail = `buy ${want.name} axe: ${b.message}`;
            await s.bot.closeShop();
        }
        if (has(want.re)) {
            axe = want.name;
            // Wielding is optional: the pack axe works the same (woodcutting_axe_checker).
            const e = await s.bot.equipItem(want.re);
            if (!e.success) lastFail = `equip ${want.name} axe: ${e.message}`;
            mark(`${want.name}axe`);
        }
    } else console.log(`WARN only ${coins()} coins: keeping the bronze axe`);
    shopTicks += now() - q0;
    await check('at Bob');

    // ---- Step 4: chop north of the castle to TARGET. Every 3 ticks, in one tick: knife on a normal log, "Make 1",
    // chop the tree (scripts/measure/wc-3tick.ts). Without a knife or a normal log: one click, the server chains.
    if (!(await walk(ANCHOR.x, ANCHOR.z, 2))) lastFail = `walk to trees: ${lastFail}`;
    const make1 = componentId('skill_multi3:make1_a');
    // stat_random(level, low, high): chance about (low x (99 - L) + high x (L - 1)) / 98 / 256.
    const chance = (t: (typeof TREES)[number]) => {
        const [lo, hi] = t.chance[axe];
        const L = lvl();
        return Math.min(1, (lo * (99 - L) + hi * (L - 1)) / 98 / 256);
    };
    const banned = new Map<string, number>();
    const key = (l: { x: number; z: number }) => `${l.x},${l.z}`;
    const typeOf = (l: any) => TREES.find(t => t.re.test(l.name) && l.optionsWithIndex?.some((o: any) => /chop/i.test(o.text)));
    const standing = (c: any) => (st()?.nearbyLocs ?? []).some((l: any) => l.x === c.x && l.z === c.z && l.id === c.id);
    // XP per tick for the expected stay at the tree, with the walk counted (run: 2 tiles a tick).
    const choose = (): any => {
        const p = pos();
        if (!p) return null;
        const fewLogs = countItems(s, NORMAL_LOGS) < 3 && slotOf(/^knife$/i) !== undefined;
        let best: any = null, bestScore = 0;
        for (const l of (st()?.nearbyLocs ?? []) as any[]) {
            const t = typeOf(l);
            if (!t || lvl() < t.level) continue;
            if (l.x < BOX.x0 || l.x > BOX.x1 || l.z < BOX.z0 || l.z > BOX.z1) continue;
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
    // Normal logs above 4, and every oak and willow log, go on the ground.
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

    let cur: any = null;
    let lastXp = xp(), lastGain = now();
    const c0 = now();
    for (let i = 0; i < 6000 && lvl() < TARGET && !died && left() > 0; i++) {
        checkLevels();
        const x = xp();
        if (x > lastXp) { lastXp = x; lastGain = now(); }
        if (invLen() >= 27) { await dropLogs(); cur = null; continue; }
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
            if (!t) {
                const p = pos();
                if (!p || cheb(ANCHOR, p) > 4) await walk(ANCHOR.x, ANCHOR.z, 2);
                else await waitTicks(s, 1);
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
        const knife = slotOf(/^knife$/i), log = slotOf(NORMAL_LOGS);
        const k0 = now();
        if (knife === undefined || log === undefined) {
            // Click-once chain: click again only after a level-up dialog closed it.
            if (await closeDialog()) {
                await s.direct({ type: 'interactLoc', x: cur.x, z: cur.z, locId: cur.id, optionIndex: cur.op, reason: 'SDK' });
                plainClicks++;
            }
            await waitTicks(s, 1);
        } else {
            // The knife-on-log also closes a level-up dialog.
            await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
            await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
            await s.direct({ type: 'interactLoc', x: cur.x, z: cur.z, locId: cur.id, optionIndex: cur.op, reason: 'SDK' });
            cycles++;
            await waitTicks(s, 3);
        }
        chopTicks += now() - k0;
    }
    await closeDialog();
    checkLevels();
    const ok = lvl() >= TARGET && !died;
    await end(ok, died ? 'died' : `woodcutting ${lvl()} < ${TARGET}`);
} catch (e) { await finish([s], false, String(e)); }
