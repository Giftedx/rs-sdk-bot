// Murder Mystery from preset quest_murder (beside the guard in the Sinclair Mansion, north of Camelot; every skill 99;
// 3 pots of flour and the runes for one Camelot Teleport from a helper). Reward: 3 QP, 14,060 Crafting XP before 25x,
// 2,000 coins (quest_murder.rs2:423-431).
// The guard's start picks the murderer at random (%murdersus 1-6, murder_guard.rs2:8-14) and the bot cannot read varps,
// so the script finds the murderer from the evidence: the window thread's colour names two suspects
// (quest_murder.rs2:228-256), and the dagger's print matches one suspect's print (:292-337). Then it gets the three
// proofs the guard asks for (murder_guard.rs2:36-53,132-152): the thread bit, the fingerprint bit, and the poison proof
// (%murder_poisonproof_progress 3): the poison salesman's "Who did you sell Poison to at the house?" (1,
// area_seers/scripts/poison_salesman.rs2:32-36), the murderer's "Why'd you buy poison the other day?" (2, anna.rs2:34-39
// and the same in each suspect's script), and a search of the murderer's own loc (3, quest_murder.rs2:1-103).
import { openQuest } from './quest-lib';

// at: the tile to stand on; the barrels sit against walls and the client route can end on the wrong side (trial 1).
type Lvl = { id: number; x: number; z: number; l: number; at?: { x: number; z: number } };
interface Sus { name: string; npc: RegExp; home: { x: number; z: number; l: number }; barrel: Lvl; item: number; dust: number; print: number; poison: Lvl }
const SUS: Record<string, Sus> = {
    anna: { name: 'Anna', npc: /^anna$/i, home: { x: 2734, z: 3575, l: 0 }, barrel: { id: 2656, x: 2733, z: 3575, l: 0, at: { x: 2734, z: 3575 } }, item: 1796, dust: 1797, print: 1816, poison: { id: 2650, x: 2730, z: 3572, l: 0 } },
    bob: { name: 'Bob', npc: /^bob$/i, home: { x: 2748, z: 3559, l: 0 }, barrel: { id: 2657, x: 2733, z: 3578, l: 0, at: { x: 2734, z: 3578 } }, item: 1798, dust: 1799, print: 1817, poison: { id: 2651, x: 2730, z: 3559, l: 0 } },
    carol: { name: 'Carol', npc: /^carol$/i, home: { x: 2734, z: 3581, l: 1 }, barrel: { id: 2658, x: 2733, z: 3581, l: 1, at: { x: 2734, z: 3581 } }, item: 1800, dust: 1801, print: 1818, poison: { id: 2652, x: 2736, z: 3573, l: 0 } },
    david: { name: 'David', npc: /^david$/i, home: { x: 2739, z: 3581, l: 0 }, barrel: { id: 2659, x: 2733, z: 3578, l: 1, at: { x: 2734, z: 3578 } }, item: 1802, dust: 1803, print: 1819, poison: { id: 2653, x: 2740, z: 3574, l: 1, at: { x: 2740, z: 3575 } } },
    elizabeth: { name: 'Elizabeth', npc: /^elizabeth$/i, home: { x: 2746, z: 3581, l: 1 }, barrel: { id: 2660, x: 2747, z: 3581, l: 1, at: { x: 2746, z: 3581 } }, item: 1804, dust: 1805, print: 1820, poison: { id: 2654, x: 2747, z: 3563, l: 0 } },
    frank: { name: 'Frank', npc: /^frank$/i, home: { x: 2742, z: 3577, l: 0 }, barrel: { id: 2661, x: 2747, z: 3577, l: 1, at: { x: 2746, z: 3577 } }, item: 1806, dust: 1807, print: 1821, poison: { id: 2655, x: 2746, z: 3573, l: 0 } },
};
// The thread colour names two suspects (quest_murder.rs2:250-256); the first has its barrel on level 0 where it can.
const PAIRS: Record<number, [string, string]> = { 1809: ['anna', 'david'], 1808: ['bob', 'carol'], 1810: ['frank', 'elizabeth'] };
const GUARD_IN = { x: 2739, z: 3577 };
const WINDOW = { id: 2666, x: 2747, z: 3577 };
const DAGGER_AT = { x: 2746, z: 3578 };
const SACKS = { id: 2663, x: 2731, z: 3582 };
const LADDER = { x: 2737, z: 3582 };
const SALESMAN = { x: 2737, z: 3491 };
const ITEM = { flour: 1933, pot: 1931, paper: 1811, dagger: 1813, daggerDust: 1814, print1: 1822, printOk: 1815 };

const q = await openQuest({ cap: 3500 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lv = () => q.lvl();
    const loc = (l: { id: number; x: number; z: number }) => q.locAt(l.x, l.z) ?? l;
    const closeDlg = async () => { if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 10); };
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => q.cheb(a.x, a.z) - q.cheb(b.x, b.z))[0];
    const ladder = (re: RegExp) => () => q.findLoc(l => l.x === LADDER.x && l.z === LADDER.z && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
    const toLevel = async (l: number) => {
        if (lv() === l) return;
        await q.walk(`to ladder ${l}`, [{ x: LADDER.x, z: LADDER.z - 1, tol: 1 }]);
        if (l === 1) await q.climb('ladder up', ladder(/climb-up/i), /climb-up/i, () => lv() === 1);
        else await q.climb('ladder down', ladder(/climb-down/i), /climb-down/i, () => lv() === 0);
    };
    const goto = async (label: string, p: { x: number; z: number; l: number }, tol = 1) => { await toLevel(p.l); if (!q.near(p.x, p.z, tol)) await q.walk(label, [{ x: p.x, z: p.z, tol }]); };
    // The server keys these item-on-item scripts on one side (quest_murder.rs2:292-308); both orders are tried.
    const combine = async (label: string, a: number, b: number, ok: () => boolean) => {
        for (let i = 0; i < 4 && !ok(); i++) {
            await closeDlg();
            // A mesbox pauses the script before its inv_del (quest_murder.rs2:336-337); trial 2 failed here.
            await q.waitTicks(1);
            if (ok()) break;
            if (!q.has(a) || !q.has(b)) await q.fail(`${label}: missing ${a} or ${b}`);
            await (i % 2 === 0 ? q.useOnItem(a, b) : q.useOnItem(b, a));
            await q.waitUntil(ok, 4);
        }
        if (!ok()) await q.fail(`step ${label}`);
        await closeDlg();
    };
    const search = async (label: string, l: Lvl, ok: () => boolean, pats: RegExp[] = []) => {
        await goto(`to ${label}`, l.at ? { ...l.at, l: l.l } : l, l.at ? 0 : 1);
        for (let i = 0; i < 4 && !ok(); i++) {
            await closeDlg();
            await q.opLoc(loc(l), 2);
            await q.waitUntil(() => ok() || q.dialogOpen(), 8);
            await q.converse(pats, () => ok() && !q.dialogOpen(), 12);
        }
        if (!ok()) await q.fail(`step ${label}`);
        await closeDlg();
    };

    // 1. The guard: "Sure, I'll help." starts the quest and picks the murderer. A debug preset with the quest started
    // (quest_murder_<suspect>) gets the started menu instead (murder_guard.rs2:22).
    // The hall door 2741,3576 (loc 1533): the nearest guard can be in the hall south of it ("I can't reach that!").
    await q.openDoor('hall door', 2741, 3576);
    await q.talk('guard', /^guard$/i, [/sure, i'll help/i, /what should i be doing to help again/i], () => q.sawText(/thanks a lot|look around and investigate/i), GUARD_IN, 40);
    q.milestone(1);

    // 2. The study: the dagger (a mesbox) and the thread on the window.
    await goto('to dagger', { ...DAGGER_AT, l: 0 }, 1);
    await q.step('dagger', () => { const g = ground(ITEM.dagger); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.dagger), 10, 5);
    await closeDlg();
    const thread = () => [1808, 1809, 1810].find(id => q.has(id));
    await search('window', { ...WINDOW, l: 0 }, () => thread() !== undefined);
    const pair = PAIRS[thread()!]!;
    console.log(`MILESTONE thread ${pair.join('/')} ${q.T()}`);

    // 3. Flypaper from the sacks: one for the dagger, one per suspect checked.
    const paperFor = async (n: number) => {
        while (q.cnt(ITEM.paper) < n) {
            const c0 = q.cnt(ITEM.paper);
            await search('sacks', { ...SACKS, l: 0 }, () => q.cnt(ITEM.paper) > c0, [/yes, it might be useful/i]);
        }
    };
    await paperFor(2);
    await combine('flour dagger', ITEM.dagger, ITEM.flour, () => q.has(ITEM.daggerDust));
    await combine('print dagger', ITEM.daggerDust, ITEM.paper, () => q.has(ITEM.print1));
    q.milestone('print1');

    // 4. The suspects' prints: the first of the pair, then the second if the first does not match.
    let murderer: Sus | undefined;
    for (const [i, k] of pair.entries()) {
        const s = SUS[k]!;
        if (i > 0) await paperFor(1);
        await search(`${s.name} barrel`, s.barrel, () => q.has(s.item));
        await combine(`flour ${s.name}`, s.item, ITEM.flour, () => q.has(s.dust));
        await combine(`print ${s.name}`, s.dust, ITEM.paper, () => q.has(s.print));
        await combine(`match ${s.name}`, s.print, ITEM.print1, () => q.has(ITEM.printOk) || !q.has(s.print));
        if (q.has(ITEM.printOk)) { murderer = s; break; }
    }
    if (!murderer) await q.fail('no print match');
    const m = murderer!;
    console.log(`MILESTONE murderer ${m.name} ${q.T()}`);

    // 5. Camelot Teleport, the poison salesman, the walk back.
    await toLevel(0);
    await q.teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
    await q.talk('salesman', /^poison salesman$/i, [/who did you sell poison/i], () => q.sawText(/they bought the last of my supplies/i), SALESMAN, 60);
    q.milestone('salesman');
    await q.walk('back to mansion', [{ x: 2740, z: 3520, tol: 3 }, { x: 2741, z: 3550, tol: 2 }, { x: m.home.l === 0 ? m.home.x : 2739, z: m.home.l === 0 ? m.home.z : 3577, tol: 3 }]);

    // 6. The murderer's poison talk, then the search of the murderer's loc.
    await toLevel(m.home.l);
    await q.talk(`${m.name} poison`, m.npc, [/why'd you buy poison/i], () => q.sawText(/why'd you buy poison/i), m.home, 60);
    q.milestone('murderer talk');
    await search(`${m.name} poison loc`, m.poison, () => q.sawText(/nobody's used poison here|nobody's cleaned it recently|definitely don't seem poisoned/i));
    q.milestone('poison proof');

    // 7. The guard: "I know who did it!" with all three proofs completes the quest.
    await toLevel(0);
    await q.talk('guard end', /^guard$/i, [/i know who did it/i], () => questDone, GUARD_IN, 120);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=3');
} catch (e) { await q.fail(String(e)); }
