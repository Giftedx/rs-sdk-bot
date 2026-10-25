// The Fremennik Trials from preset quest_viking (beside Brundt in the Rellekka longhall; every skill 99; nothing worn;
// helper items below). Reward: 3 QP, 28,124 XP in 10 skills before 25x (quest_viking.rs2:117-133).
// %viking (varp 347) is 1 + the votes; Brundt completes the quest at 7 votes (viking_brundt.rs2:16-31). The 7 trials
// set ranges of %viking_bits (varp 348, quest_viking.constant): Swensen 10-11, Manni 12-13, Sigli 14-15, Thorvald
// 16-17, Peer 18-19, Olaf 20-22, Sigmund 23-26 (the trade chain, 13 merchants out and back).
// All quest items are untradeable (viking.obj). Helper items (tradeable): 5,300 coins (Askeladden's promise 5,000,
// viking_askelapen.rs2:105-125; the low-alcohol keg 250, poison_salesman.rs2:92-115), a beer for the council workman's
// firecracker (vt_council_workman.rs2:22-30), a tinderbox, a rune axe and a knife for the lyre (viking_olaf.rs2:146-170),
// a cabbage, a potato and an onion for Lalli's stew (viking_troll.rs2:96-125), a raw shark for Fossegrimen
// (viking_olaf.rs2:172-208), 4 sharks.
// Peer banks everything worn and carried (viking_peer.rs2:160-215), so his trial is near the end and Thorvald's fight
// (no weapons or armour, viking_thorvald.rs2:435-481) follows it. Koschei's fourth form hits 0-1 every tick; at 0 hp the
// bot passes (viking_honour_death, viking_thorvald.rs2:386-423).
// VK_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = {
    coins: 995, beer: 1917, tinderbox: 590, axe: 1359, knife: 946, cabbage: 1965, potato: 1942, onion: 1957, rawShark: 383,
    lyreUnstrung: 3688, lyreStrung: 3689, lyreEnchanted: 3690, branch: 3692, fleece: 3693, wool: 3694, rock: 3695,
    talisman: 3696, talismanUn: 3697, flower: 3698, song: 3699, boots: 3700, huntMap: 3701, bowstring: 3702, fish: 3703,
    fishMap: 3704, forecast: 3705, token: 3706, cocktail: 3707, note1: 3708, note2: 3709, note3: 3710, keg: 3711,
    kegLow: 3712, cracker: 3713, crackerLit: 3714,
    bucket5: 3722, bucket4: 3723, bucket2: 3725, bucket0: 3727, jug3: 3729, jug2: 3730, jug0: 3732, vase: 3734,
    vaseWater: 3735, lid: 3737, vaseLidWater: 3740, keyIce: 3741, herring: 3742, redCoin: 3743, plainCoin: 3744,
    key: 3745, splat: 3746,
};
const NPC = {
    brundt: { re: /^brundt the chieftain$/i, at: { x: 2659, z: 3669 } },
    manni: { re: /^manni the reveller$/i, at: { x: 2660, z: 3673 } },
    thora: { re: /^thora the barkeep$/i, at: { x: 2662, z: 3673 } },
    askel: { re: /^askeladden$/i, at: { x: 2658, z: 3660 } },
    sigli: { re: /^sigli the huntsman$/i, at: { x: 2660, z: 3653 } },
    swensen: { re: /^swensen the navigator$/i, at: { x: 2646, z: 3660 }, door: { out: { x: 2645, z: 3664 }, x: 2645, z: 3663, in: { x: 2645, z: 3661 } } },
    peer: { re: /^peer the seer$/i, at: { x: 2634, z: 3668 } },
    yrsa: { re: /^yrsa$/i, at: { x: 2625, z: 3675 }, door: { via: { x: 2636, z: 3672 }, out: { x: 2628, z: 3675 }, x: 2627, z: 3675, in: { x: 2625, z: 3675 } } },
    sigmund: { re: /^sigmund the merchant$/i, at: { x: 2641, z: 3680 } },
    sailor: { re: /^sailor$/i, at: { x: 2629, z: 3693 } },
    fisherman: { re: /^fisherman$/i, at: { x: 2641, z: 3699 } },
    skul: { re: /^skulgrimen$/i, at: { x: 2663, z: 3694 } },
    thorvald: { re: /^thorvald the warrior$/i, at: { x: 2666, z: 3693 } },
    olaf: { re: /^olaf the bard$/i, at: { x: 2673, z: 3683 } },
    lalli: { re: /^lalli$/i, at: { x: 2770, z: 3622 } },
    workman: { re: /^council workman$/i, at: { x: 2655, z: 3592 } },
    salesman: { re: /^poison salesman$/i, at: { x: 2737, z: 3491 } },
};
type Who = keyof typeof NPC;
type Door = { via?: { x: number; z: number }; out: { x: number; z: number }; x: number; z: number; in: { x: number; z: number } };
const LOC = {
    mazeTop: { id: 4158, x: 2644, z: 3657 },
    mazeExit: { id: 4160, x: 2665, z: 10037 },
    tree: { id: 4142, x: 2738, z: 3638 },
    cauldron: { id: 4149, x: 2772, z: 3623 },
    wheel: { id: 2644, x: 2711, z: 3471 },               // level 1
    altar: { id: 4141, x: 2626, z: 3598 },
    pipe: { id: 4162, x: 2663, z: 3674 },
    backstage: { id: 4148, x: 2667, z: 3683 },
    warriorLadder: { id: 4187, x: 2667, z: 3694 },
    warriorDown: { id: 4189, x: 2667, z: 3694 },          // level 1
    door1: { id: 4165, x: 2631, z: 3667 },
    door2: { id: 4166, x: 2636, z: 3667 },
    upLadder: { id: 4163, x: 2631, z: 3663 },
    downLadder: { id: 4164, x: 2636, z: 3663 },           // level 0, east room; climbs to level 2
    mural: { id: 4179, x: 2634, z: 3663 },
    cupboard: { id: 4177, x: 2629, z: 3660 },             // level 2
    tap: { id: 4176, x: 2629, z: 3661 },
    drain: { id: 4175, x: 2629, z: 3662 },
    range: { id: 4172, x: 2629, z: 3663 },
    unicorn: { id: 4181, x: 2632, z: 3660 },
    bull: { id: 4182, x: 2634, z: 3660 },
    scales: { id: 4170, x: 2632, z: 3665 },
    bookcase: { id: 4171, x: 2634, z: 3665 },
    chest: { id: 4167, x: 2635, z: 3660 },
    frozen: { id: 4169, x: 2638, z: 3665 },
    trapdoor: { id: 4174, x: 2636, z: 3663 },
};
// Swensen's maze (viking_hallifred.rs2:117-287, level 0 at 2624-2687,9984-10047): portal N moves the bot to the tile
// beside portal N+1; every other portal sends it to a random spot.
const PORTALS = [
    { id: 4150, x: 2631, z: 10002 }, { id: 4151, x: 2639, z: 10015 }, { id: 4152, x: 2656, z: 10004 },
    { id: 4153, x: 2665, z: 10018 }, { id: 4154, x: 2630, z: 10023 }, { id: 4155, x: 2656, z: 10037 },
    { id: 4156, x: 2666, z: 10029 },
];
// The tile each portal sends the bot to (its p_telejump plus the p_walk).
const LANDS = [
    { x: 2642, z: 10017 }, { x: 2651, z: 10004 }, { x: 2667, z: 10015 }, { x: 2630, z: 10028 }, { x: 2653, z: 10035 },
    { x: 2668, z: 10026 }, { x: 2665, z: 10038 },
];
// The combination lock (viking_peer.rs2:338-405): riddle id (the first riddle line) -> letters, A = 0.
const RIDDLES: Array<[RegExp, number[]]> = [
    [/first is in mage/i, [12, 8, 13, 3]],     // MIND
    [/first is in tar/i, [19, 17, 4, 4]],      // TREE
    [/first is in the well/i, [11, 8, 5, 4]],  // LIFE
    [/first is in fish/i, [5, 8, 17, 4]],      // FIRE
    [/first is in water/i, [19, 8, 12, 4]],    // TIME
    [/first is in wizard/i, [22, 8, 13, 3]],   // WIND
];
const DRAUGEN = 1279;
const KOSCHEI = [1290, 1291, 1292, 1293];
const DIRS: Record<string, [number, number]> = {
    'north-west': [-1, 1], 'north-east': [1, 1], 'south-west': [-1, -1], 'south-east': [1, -1],
    north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0],
};

const FROM = process.env.VK_FROM ?? 'start';
const STAGES = ['start', 'olaf1', 'chain', 'east2', 'draugen', 'manni', 'olaf', 'peer', 'thorvald', 'end'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 9000, eatAt: 40, food: [385] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+trials/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const lv = () => q.lvl();
    const lastMsg = (): string => ((q.st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-1)[0]?.text ?? '');
    const msgs = (re: RegExp) => q.msgCount(re);
    const loc = (l: { id: number; x: number; z: number }) => q.findLoc((k: any) => k.id === l.id && Math.abs(k.x - l.x) <= 1 && Math.abs(k.z - l.z) <= 1) ?? q.locAt(l.x, l.z) ?? l;
    const opNo = (l: any, re: RegExp, def = 1) => (l?.optionsWithIndex ?? []).find((o: any) => re.test(o.text))?.opIndex ?? def;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 20); };
    const op = async (label: string, l: { id: number; x: number; z: number }, re: RegExp, done: () => boolean, ticks = 15, tries = 4) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); const k = loc(l); return q.opLoc(k, opNo(k, re)); }, done, ticks, tries);
    };
    const useItem = async (label: string, a: number, b: number, done: () => boolean, ticks = 6) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.useOnItem(a, b); }, done, ticks, 4);
        await closeDlg();
    };
    const useLoc = async (label: string, item: number, l: { id: number; x: number; z: number }, done: () => boolean, ticks = 15) => {
        await q.step(label, async () => { if (q.dialogOpen()) await closeDlg(); return q.useOnLoc(item, loc(l)); }, done, ticks, 4);
        await closeDlg();
    };
    // An inventory op by its text (iop1 Play / Locate); the SDK optionIndex comes from optionsWithIndex.
    const invOp = (id: number, re: RegExp) => {
        const it: any = q.inv().find((i: any) => i.id === id);
        const n = (it?.optionsWithIndex ?? []).find((o: any) => re.test(o.text))?.opIndex ?? 1;
        if (!it) console.log(`WARN invOp: no ${id}`);
        return q.s.direct({ type: 'useInventoryItem', slot: it?.slot ?? 0, optionIndex: n, reason: 'SDK' });
    };
    // One talk: the dialog options matching `pats`, until ok() and the dialog shut.
    // A house door the walker does not open (Swensen's, 2645,3663): the outside tile, the door by tile, the inside tile.
    const enter = async (label: string, d: Door) => {
        if (q.near(d.in.x, d.in.z, 2)) return;
        await q.walk(`${label} door`, [...(d.via ? [{ x: d.via.x, z: d.via.z, tol: 2 }] : []), { x: d.out.x, z: d.out.z, tol: 0 }]);
        await q.openDoor(`${label} door`, d.x, d.z);
        await q.walk(`${label} in`, [{ x: d.in.x, z: d.in.z, tol: 1 }]);
    };
    const talk = async (label: string, who: Who, pats: RegExp[], ok: () => boolean, maxTicks = 120) => {
        await closeDlg();
        const d = (NPC[who] as any).door as Door | undefined;
        if (d) await enter(label, d);
        await q.talk(label, NPC[who].re, pats, ok, NPC[who].at, maxTicks);
        await closeDlg();
        console.log(`STEP ${label} ${q.T()}`);
    };
    const MERCHANT = /merchant's trial/i;
    const BECOME = /becoming a fremennik/i;
    const YES = /^yes\.?$/i;
    // The merchant's step: the "Merchant's trial" option; `ok` is the NPC's line for the step or the new item.
    const merchant = (label: string, who: Who, ok: () => boolean) => talk(`m ${label}`, who, [MERCHANT, YES], ok);
    const got = (id: number) => () => q.has(id);
    // Peer's doors are locked until his trial: the walker plans through them and stalls (trial 3: 82 ticks at 2636,3667).
    q.blockDoor(0, LOC.door1.x, LOC.door1.z);
    q.blockDoor(0, LOC.door2.x, LOC.door2.z);

    if (from('start')) {
        // 1. Brundt: "Do you have any quests?", "Yes, I am interested.", "I want to become a Fremennik!" (%viking 1).
        await talk('brundt start', 'brundt', [/do you have any quests/i, /yes, i am interested/i, /i want to become a fremennik/i], () => q.sawText(/where and how do i start/i));
        q.milestone('started');
        // 2. Manni's trial: "Yes" (viking_reveller.rs2:77-89).
        await talk('manni start', 'manni', [YES], () => q.sawText(/set them up, and i'll knock them back/i));
        // 3. Sigli's trial: "What's a Draugen?", "Yes": the uncharged talisman (viking_sigil.rs2:66-90).
        await talk('sigli start', 'sigli', [/what's a draugen/i, YES], got(ITEM.talismanUn));
        // 4. Swensen's trial: "Yes" (viking_hallifred.rs2:25-48); his maze below the house.
        await talk('swensen start', 'swensen', [YES], () => q.sawText(/sure, it sounds simple enough/i));
        await op('maze ladder', LOC.mazeTop, /climb/i, () => z() > 9000, 15);
        for (let i = 0; i < PORTALS.length; i++) {
            const p = PORTALS[i]!;
            const land = LANDS[i]!;
            const arrived = () => q.near(land.x, land.z, 2);
            for (let k = 0; k < 4 && !arrived(); k++) {
                await q.guard(`portal ${i + 1}`);
                if (k > 0) console.log(`WARN portal ${i + 1} retry at ${x()},${z()}`);
                await q.opLoc(loc(p), 1);
                await q.waitUntil(arrived, 20);
            }
            await q.waitTicks(2);   // a click in the landing walk is dropped
            if (!arrived()) await q.fail(`portal ${i + 1}`);
        }
        let mazeDone = false;
        for (let k = 0; k < 4 && !mazeDone; k++) {
            await q.opLoc(loc(LOC.mazeExit), 1);
            await q.waitUntil(() => z() < 4000, 15);
            mazeDone = z() < 4000;
        }
        if (!mazeDone) await q.fail('maze exit');
        await q.waitUntil(() => q.sawText(/finished my maze/i), 6);
        await closeDlg();
        q.milestone('swensen');
    }
    if (from('olaf1')) {
        // 5. Olaf's trial: "Yes" (viking_olaf.rs2:52-61). Thorvald's trial: "Yes" (viking_thorvald.rs2:56-66).
        await talk('olaf start', 'olaf', [YES], () => q.sawText(/i'll have your vote in no time/i));
        await talk('thorvald start', 'thorvald', [YES], () => q.sawText(/what combat's all about/i));
        // 6. The musical tree (axe, Woodcutting 40): a branch; the knife on it: the unstrung lyre (Crafting 40).
        await q.walk('to tree', [{ x: LOC.tree.x, z: LOC.tree.z - 1, tol: 2 }]);
        await op('tree', LOC.tree, /cut/i, got(ITEM.branch), 12);
        await useItem('lyre', ITEM.knife, ITEM.branch, got(ITEM.lyreUnstrung));
        // 7. Lalli: "Other human?" (olaf 2, viking_troll.rs2:62-70).
        await talk('lalli 1', 'lalli', [/other human/i], () => q.sawText(/human call itself askeladden/i));
        // 8. Askeladden: the pet rock (olaf 3, viking_askelapen.rs2:31-58).
        await talk('askeladden rock', 'askel', [BECOME], got(ITEM.rock));
        q.milestone('olaf1');
    }
    if (from('chain')) {
        // 9. The merchant's trade chain out (viking_sigmund.rs2:45-61 and each NPC's merchant label).
        await talk('sigmund start', 'sigmund', [YES], () => q.sawText(/where to start looking for this flower/i));
        await merchant('sailor', 'sailor', () => q.sawText(/musical bone in my entire body/i));
        await merchant('olaf', 'olaf', () => q.sawText(/sturdy boots to replace/i));
        await merchant('yrsa', 'yrsa', () => q.sawText(/sturdy boots for olaf/i));
        await merchant('brundt', 'brundt', () => q.sawText(/let the entire tribe know/i));
        await merchant('sigli', 'sigli', () => q.sawText(/custom bowstring, balanced/i));
        await merchant('skulgrimen', 'skul', () => q.sawText(/this fish is unique/i));
        await merchant('fisherman', 'fisherman', () => q.sawText(/secret map of the/i));
        await merchant('swensen', 'swensen', () => q.sawText(/no less than a weather forecast/i));
        await merchant('peer', 'peer', () => q.sawText(/require a bodyguard/i));
        await merchant('thorvald', 'thorvald', () => q.sawText(/give up their champions/i));
        await merchant('manni', 'manni', () => q.sawText(/she might change her mind/i));
        await merchant('thora', 'thora', () => q.sawText(/nothing but a pest/i));
        await merchant('askeladden', 'askel', got(ITEM.note2));
        q.milestone('promise');
        // 10. And back: each NPC swaps the item (the item checks come first in each merchant label).
        await merchant('thora cocktail', 'thora', got(ITEM.cocktail));
        await merchant('manni token', 'manni', got(ITEM.token));
        await merchant('thorvald note', 'thorvald', got(ITEM.note3));
        await merchant('peer forecast', 'peer', got(ITEM.forecast));
        await merchant('swensen map', 'swensen', got(ITEM.fishMap));
        await merchant('fisherman fish', 'fisherman', got(ITEM.fish));
        await merchant('skulgrimen string', 'skul', got(ITEM.bowstring));
        await merchant('sigli map', 'sigli', got(ITEM.huntMap));
        await merchant('brundt note', 'brundt', got(ITEM.note1));
        await merchant('yrsa boots', 'yrsa', got(ITEM.boots));
        await merchant('olaf song', 'olaf', got(ITEM.song));
        await merchant('sailor flower', 'sailor', got(ITEM.flower));
        await talk('sigmund vote', 'sigmund', [], () => !q.has(ITEM.flower));
        q.milestone('sigmund');
    }
    if (from('east2')) {
        // 11. Lalli's cauldron: the rock, cabbage, potato and onion (olaf 5, viking_troll.rs2:96-125); Lalli: the fleece.
        await q.walk('to cauldron', [{ x: LOC.cauldron.x - 1, z: LOC.cauldron.z, tol: 2 }]);
        for (const id of [ITEM.rock, ITEM.cabbage, ITEM.potato, ITEM.onion]) await useLoc(`stew ${id}`, id, LOC.cauldron, () => !q.has(id));
        await talk('lalli fleece', 'lalli', [], got(ITEM.fleece));
        // 12. Seers' Village: the poison salesman's low-alcohol keg ("Talk about the Fremennik Trials", "Yes").
        await talk('salesman keg', 'salesman', [/fremennik trials/i, YES], got(ITEM.kegLow), 200);
        // 13. The spinning wheel: golden wool; on the lyre: the strung lyre (Fletching 25).
        // The wheel is upstairs (level 1) in the house east of the bank: door 2716,3472, ladder 2715,3470.
        await enter('wheel house', { out: { x: 2717, z: 3472 }, x: 2716, z: 3472, in: { x: 2715, z: 3471 } });
        await op('wheel ladder', { id: 1747, x: 2715, z: 3470 }, /climb-up/i, () => lv() === 1, 10);
        await useLoc('spin', ITEM.fleece, LOC.wheel, got(ITEM.wool), 12);
        await useItem('string lyre', ITEM.wool, ITEM.lyreUnstrung, got(ITEM.lyreStrung));
        // 14. Down and north: the council workman takes the beer for the firecracker; the raw shark on Fossegrimen's
        // altar enchants the lyre (the strung lyre's Play only says a line, viking_olaf.rs2:212-214).
        await op('wheel ladder down', { id: 1746, x: 2715, z: 3470 }, /climb-down/i, () => lv() === 0, 10);
        await q.openDoor('wheel house door', 2716, 3472);
        await q.step('workman', async () => {
            const n = q.npc(NPC.workman.re);
            if (!n) return q.walk('to workman', [{ x: NPC.workman.at.x, z: NPC.workman.at.z + 1, tol: 3 }]);
            return q.useOnNpc(ITEM.beer, n);
        }, got(ITEM.cracker), 20, 4);
        await closeDlg();
        await q.walk('to altar', [{ x: LOC.altar.x, z: LOC.altar.z + 1, tol: 1 }]);
        await useLoc('altar', ITEM.rawShark, LOC.altar, got(ITEM.lyreEnchanted));
        q.milestone('east2');
    }
    if (from('draugen')) {
        // 16. The talisman points toward the Draugen's butterfly (viking_sigil.rs2:192-237); within 3 tiles the Draugen
        // (level 69) appears; dead, it charges the talisman. Sigli takes it.
        // The Butterfly NPC near the bot is not the one the talisman tracks (proof trial 1: it sat on the bot's tile),
        // so only the talisman's direction is used: hops of 14 tiles, halved each time the direction turns back.
        const dr = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => n.id === DRAUGEN);
        let seen = false, hop = 14, prev: [number, number] | undefined;
        for (let i = 0; i < 120 && !q.has(ITEM.talisman); i++) {
            await q.guard('draugen');
            const d = dr();
            if (d) {
                seen = true;
                await q.s.bot.attack(d as any);
                await q.waitUntil(() => !dr() || q.has(ITEM.talisman), 8);
                continue;
            }
            if (seen) { await q.waitUntil(() => q.has(ITEM.talisman) || !!dr(), 4); if (q.has(ITEM.talisman)) break; }
            const m0 = msgs(/talisman guides you|draugen is here|moved elsewhere/i);
            await invOp(ITEM.talismanUn, /locate/i);
            await q.waitUntil(() => msgs(/talisman guides you|draugen is here|moved elsewhere/i) > m0 || !!dr(), 4);
            await q.waitTicks(1);
            const m = (q.st()?.gameMessages ?? []).filter((g: any) => g.type === 0).map((g: any) => g.text).reverse().find((t: string) => /talisman guides you|draugen is here/i.test(t)) ?? '';
            console.log(`DRAUGEN ${q.T()} ${x()},${z()} hop=${hop} ${m}`);
            if (/draugen is here/i.test(m) || dr()) { await q.waitUntil(() => !!dr(), 5); continue; }
            if (/moved elsewhere/i.test(lastMsg())) { hop = 14; prev = undefined; }
            const g = m.match(/guides you ([a-z-]+)/i)?.[1]?.toLowerCase();
            const v = g ? DIRS[g] : undefined;
            if (!v) { await q.waitTicks(2); continue; }
            if (prev && prev[0] * v[0] + prev[1] * v[1] < 0) hop = Math.max(2, Math.floor(hop / 2));
            prev = v;
            // The client routes round water and trees (no fail on a blocked goal).
            const hx = x() + v[0] * hop, hz = z() + v[1] * hop;
            await q.s.direct({ type: 'walkTo', x: hx, z: hz, running: true, reason: 'SDK' });
            let still = 0, at0 = '';
            await q.waitUntil(() => { const at = `${x()},${z()}`; still = at === at0 ? still + 1 : 0; at0 = at; return q.near(hx, hz, 1) || still >= 3 || !!dr(); }, 30);
        }
        if (!q.has(ITEM.talisman)) await q.fail(`draugen seen=${seen}`);
        q.milestone('draugen');
        await talk('sigli vote', 'sigli', [], () => !q.has(ITEM.talisman));
        q.milestone('sigli');
    }
    if (from('manni')) {
        // 17. The firecracker lit (tinderbox) and put in the longhall pipe (viking_reveller.rs2:240-290); the table's
        // keg (2660,3676) emptied for the low-alcohol keg (:205-238); Manni's contest: "Yes" (:52-64,163-185).
        await q.walk('to pipe', [{ x: LOC.pipe.x + 1, z: LOC.pipe.z, tol: 1 }]);
        await useItem('light cracker', ITEM.tinderbox, ITEM.cracker, got(ITEM.crackerLit));
        await op('pipe', LOC.pipe, /put/i, () => !q.has(ITEM.crackerLit), 12);
        await closeDlg();
        await q.walk('to keg', [{ x: 2660, z: 3675, tol: 1 }]);
        await q.step('take keg', () => {
            const g = (q.st()?.groundItems ?? []).find((o: any) => o.id === ITEM.keg);
            return q.s.direct({ type: 'pickupItem', x: g?.x ?? 2660, z: g?.z ?? 3676, itemId: ITEM.keg, reason: 'SDK' });
        }, got(ITEM.keg), 8, 4);
        await useItem('swap keg', ITEM.keg, ITEM.kegLow, () => !q.has(ITEM.kegLow), 8);
        await talk('manni contest', 'manni', [YES], () => q.sawText(/mighty fine drinking legs|you can probably outdrink me/i), 160);
        q.milestone('manni');
    }
    if (from('olaf')) {
        // 18. The backstage door (with the enchanted lyre, viking_olaf.rs2:488-500); the lyre played on the stage
        // (2655-2662,3682-3685, :226-232,385-425).
        await q.walk('to backstage', [{ x: LOC.backstage.x, z: LOC.backstage.z, tol: 0 }]);
        await op('backstage door', LOC.backstage, /open/i, () => x() < LOC.backstage.x, 10);
        await closeDlg();
        await q.walk('to stage', [{ x: 2660, z: 3683, tol: 1 }]);
        await q.step('play', () => invOp(ITEM.lyreEnchanted, /play/i), () => msgs(/completed the bard's trial/i) > 0, 40, 3);
        await closeDlg();
        q.milestone('olaf');
    }
    if (from('peer')) {
        // 19. Peer: "Ask about becoming a Fremennik", "Yes", "Yes": the riddle set and everything banked
        // (viking_peer.rs2:18-45,160-215).
        await talk('peer start', 'peer', [BECOME, YES], () => (q.inv().length === 0) && !(q.st()?.equipment ?? []).some((e: any) => e?.id > 0));
        q.milestone('banked');
        // 20. The door: "Read the riddle"; the lock set from A A A A; "You have solved the riddle!".
        await q.walk('to seer door', [{ x: LOC.door1.x, z: LOC.door1.z, tol: 0 }]);
        const btn = (n: number) => q.s.direct({ type: 'clickComponent', componentId: componentId(`combolockdoor:com_${n}`), reason: 'SDK' });
        for (let k = 0; k < 3 && msgs(/solved the riddle/i) === 0; k++) {
            await q.guard('riddle');
            await q.opLoc(loc(LOC.door1), 1);
            await q.waitUntil(() => q.dialogOpen(), 10);
            await q.converse([/read the riddle/i], () => !q.dialogOpen() && q.sawText(/what am i/i), 30);
            await q.waitTicks(2);
            const r = RIDDLES.find(([re]) => q.sawText(re));
            if (!r) { console.log('WARN riddle text not seen'); continue; }
            for (let lock = 0; lock < 4; lock++) {
                const t = r[1][lock]!;
                const up = t <= 13;
                for (let i = 0; i < (up ? t : 26 - t); i++) { await btn(47 + lock * 2 + (up ? 1 : 0)); await q.waitTicks(1); }
            }
            await btn(57);
            await q.waitUntil(() => msgs(/solved the riddle|failed to solve/i) > 0, 4);
        }
        if (msgs(/solved the riddle/i) === 0) await q.fail('riddle');
        q.milestone('riddle');
        await op('seer door in', LOC.door1, /open/i, () => z() <= 3666, 10);
        // 21. Up the ladder (level 2): the coins, the red herring cooked to the red goop, the jug and bucket.
        await op('seer ladder up', LOC.upLadder, /climb/i, () => lv() === 2, 10);
        await op('unicorn', LOC.unicorn, /study/i, got(ITEM.redCoin), 10);
        await op('bull', LOC.bull, /study/i, got(ITEM.plainCoin), 10);
        await op('bookcase', LOC.bookcase, /search/i, got(ITEM.herring), 10);
        await useLoc('herring', ITEM.herring, LOC.range, got(ITEM.splat));
        await useItem('red coin', ITEM.splat, ITEM.plainCoin, () => q.cnt(ITEM.redCoin) >= 2);
        await op('chest open', LOC.chest, /open/i, () => !!q.findLoc((l: any) => l.x === LOC.chest.x && l.z === LOC.chest.z && /search/i.test((l.options ?? []).join(' '))), 10);
        await op('chest search', LOC.chest, /search/i, got(ITEM.jug0), 10);
        await op('cupboard open', LOC.cupboard, /open/i, () => !!q.findLoc((l: any) => l.x === LOC.cupboard.x && l.z === LOC.cupboard.z && /search/i.test((l.options ?? []).join(' '))), 10);
        await op('cupboard search', LOC.cupboard, /search/i, got(ITEM.bucket0), 10);
        // 22. 4 gallons: bucket 5 -> jug (bucket 2), jug emptied, bucket 2 -> jug (jug 2), bucket 5 -> jug (bucket 4);
        // bucket 4 on the chest with scales: the vase (viking_peer.rs2:559-575). The vase filled at the tap.
        await useLoc('fill bucket', ITEM.bucket0, LOC.tap, got(ITEM.bucket5));
        await useItem('bucket to jug', ITEM.bucket5, ITEM.jug0, got(ITEM.bucket2));
        await useLoc('empty jug', ITEM.jug3, LOC.drain, got(ITEM.jug0));
        await useItem('bucket to jug 2', ITEM.bucket2, ITEM.jug0, got(ITEM.jug2));
        await useLoc('fill bucket 2', ITEM.bucket0, LOC.tap, got(ITEM.bucket5));
        await useItem('bucket to jug 3', ITEM.bucket5, ITEM.jug2, got(ITEM.bucket4));
        await useLoc('scales', ITEM.bucket4, LOC.scales, got(ITEM.vase));
        await useLoc('fill vase', ITEM.vase, LOC.tap, got(ITEM.vaseWater));
        // 23. Down the trapdoor to the east room: the 2 red coins in the mural give the lid (:1000-1022).
        await op('trapdoor open', LOC.trapdoor, /open/i, () => !!q.findLoc((l: any) => l.x === LOC.trapdoor.x && l.z === LOC.trapdoor.z && /climb/i.test((l.options ?? []).join(' '))), 10);
        await op('trapdoor down', LOC.trapdoor, /climb/i, () => lv() === 0, 10);
        await useLoc('mural 1', ITEM.redCoin, LOC.mural, () => q.cnt(ITEM.redCoin) <= 1);
        await useLoc('mural 2', ITEM.redCoin, LOC.mural, got(ITEM.lid));
        // 24. Up again: the lid on the vase, the frozen table (the key in ice), the range (the key).
        await op('seer ladder up 2', LOC.downLadder, /climb/i, () => lv() === 2, 10);
        await useItem('lid', ITEM.lid, ITEM.vaseWater, got(ITEM.vaseLidWater));
        await useLoc('freeze', ITEM.vaseLidWater, LOC.frozen, got(ITEM.keyIce));
        await useLoc('thaw', ITEM.keyIce, LOC.range, got(ITEM.key));
        // 25. Down and out of the east door with the key (%viking + 1, :1035-1057).
        await op('trapdoor open 2', LOC.trapdoor, /open|climb/i, () => lv() === 0 || !!q.findLoc((l: any) => l.x === LOC.trapdoor.x && l.z === LOC.trapdoor.z && /climb/i.test((l.options ?? []).join(' '))), 10);
        if (lv() !== 0) await op('trapdoor down 2', LOC.trapdoor, /climb/i, () => lv() === 0, 10);
        await q.walk('to seer door 2', [{ x: LOC.door2.x, z: LOC.door2.z - 1, tol: 0 }]);
        await useLoc('seer door out', ITEM.key, LOC.door2, () => z() >= LOC.door2.z, 10);
        await closeDlg();
        q.milestone('peer');
    }
    if (from('thorvald')) {
        // 26. Thorvald's ladder (level 2 arena); Koschei after 20-70 ticks; 4 forms; the bot fights until its own
        // "death", which passes the trial and puts it on the balcony (2667,3692 level 1).
        await q.walk('to warrior ladder', [{ x: LOC.warriorLadder.x, z: LOC.warriorLadder.z - 1, tol: 1 }]);
        await op('warrior ladder', LOC.warriorLadder, /climb-down/i, () => z() > 9000, 12);
        const ko = () => (q.st()?.nearbyNpcs ?? []).find((n: any) => KOSCHEI.includes(n.id));
        const t1 = q.T();
        let lastId = 0, lastHit = -99;
        while (z() > 9000 && q.T() - t1 < 1500) {
            await q.guard('koschei');
            if (q.dialogOpen()) { await closeDlg(); continue; }
            const n = ko();
            if (!n) { await q.waitTicks(1); continue; }
            if (n.id !== lastId || q.T() - lastHit >= 6) {
                if (n.id !== lastId) console.log(`KOSCHEI ${n.id} at ${q.T()} hp=${q.hp()}`);
                lastId = n.id; lastHit = q.T();
                await q.s.bot.attack(n as any);
            }
            await q.waitTicks(1);
        }
        if (z() > 9000) await q.fail('koschei');
        q.milestone('koschei');
        await q.waitTicks(4);
        await closeDlg();
        await op('balcony down', LOC.warriorDown, /climb-down/i, () => lv() === 0, 10);
        q.milestone('thorvald');
    }
    // 27. Brundt: 7 votes; he queues the completion (viking_brundt.rs2:26-31).
    await talk('brundt end', 'brundt', [], () => questDone, 60);
    await q.waitUntil(() => questDone, 10);
    off();
    if (!questDone) await q.fail('no quest complete message');
    q.milestone('done');
    await q.end(true, 'qp=3');
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
