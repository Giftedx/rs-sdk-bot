// Waterfall Quest from preset quest_waterfall (2522,3494,0 beside Almera; 10 HP, 2 ropes, 6 air/earth/water runes,
// 10 lobsters, 500 coins). Reward at 25x: 343,750 Attack and 343,750 Strength XP.
// Server truth: vendor/rs-sdk/server/content/scripts/quests/quest_waterfall/scripts/*.rs2 (%waterfall_quest 0..10).
// Loc origins come from the maps (m39_53, m39_54, m39_149, m39_153, m40_154 .jm2); ids from pack/loc.pack and obj.pack.
// The SDK state has no varps, so each MILESTONE is printed on the observed effect of the step that sets the varp.
// Route notes (bun research/route-danger.ts, 2026-10-23): the gnome cellar (hobgoblins), Glarial's tomb (skeletons,
// zombies, moss giants) and the falls (shadow spiders, skeletons, fire giants max hit about 7) have aggressive NPCs
// with hunt range 1-2. The bot never fights; it eats a lobster at 7 HP or less.
import type { Session } from '../../packages/core/src/inprocess';
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { sessionWalker, walkPath, type PathPoint } from '../../packages/core/src/walk';

const LOC = {
    raft: { id: 1987, x: 2509, z: 3493 },
    bookcase: { id: 1989, x: 2520, z: 3426 },
    golrieCrate: { id: 1990, x: 2548, z: 9565 },
    golrieGate: { id: 1991, x: 2515, z: 9575 },
    tombstone: { id: 1992, x: 2558, z: 3444 },
    coffin: { id: 1993, x: 2542, z: 9811 },
    chestClosed: 1994,
    chestOpen: 1995,
    chest: { x: 2530, z: 9844 },
    rock: { id: 1996, x: 2512, z: 3468 },
    ledgeDoor: { id: 2010, x: 2511, z: 3464 },
    tree: { id: 2020, x: 2512, z: 3465 },
    barrel: { id: 2022, x: 2512, z: 3463 },
    baxCrate: { id: 1999, x: 2589, z: 9888 },
    giantDoor: { id: 2002, x: 2568, z: 9893 },
    puzzleDoor: { id: 2002, x: 2566, z: 9901 },
    pillar: 2004,
    statue: { id: 2006, x: 2565, z: 9916 },
    chalice: { id: 2014, x: 2603, z: 9910 },
};
const ITEM = { book: 292, golrieKey: 293, pebble: 294, amulet: 295, urn: 296, baxKey: 298, rope: 954, lobster: 379, air: 556, earth: 557, water: 555 };
// waterfall_pillars.rs2: one air, earth and water rune on each of these six pillars sets bits 1-18.
const PILLARS: [number, number][] = [[2569, 9910], [2569, 9912], [2569, 9914], [2562, 9910], [2562, 9912], [2562, 9914]];
// Quest-helper path through the Tree Gnome Village maze, used only when one walkTo does not arrive.
const MAZE: [number, number][] = [[2505, 3190], [2512, 3190], [2512, 3188], [2532, 3188], [2532, 3182], [2523, 3181], [2523, 3185], [2521, 3185],
    [2520, 3179], [2514, 3179], [2514, 3177], [2527, 3177], [2527, 3179], [2529, 3179], [2529, 3177], [2531, 3177], [2531, 3179], [2533, 3179],
    [2533, 3177], [2544, 3177], [2544, 3174], [2549, 3174], [2549, 3165], [2545, 3165], [2545, 3159], [2550, 3159], [2550, 3156], [2548, 3156],
    [2548, 3145], [2538, 3145], [2538, 3150], [2541, 3150], [2541, 3148], [2544, 3148], [2544, 3150], [2545, 3150], [2545, 3155], [2533, 3156]];
const LUMBRIDGE = { x: 3222, z: 3218 };
const CAP = 4000;
// Max hits on the route before the fire giants are 3-5 (hobgoblins, zombies, skeletons, moss and giant skeletons,
// shadow spiders). Each lobster can only fill 10 HP, so a low threshold makes the 10 lobsters last.
const EAT_AT = 6;
const TRACE = process.env.WF_TRACE === "1";

export function waterfallFood(kind = 'lobster', eatAt?: number, count = 16) {
    const foods: Record<string, { id: number; heal: number }> = { lobster: { id: 379, heal: 12 }, salmon: { id: 329, heal: 9 }, trout: { id: 333, heal: 7 } };
    const food = foods[kind.toLowerCase()];
    if (!food || !Number.isSafeInteger(count) || count < 1 || count > 16) throw new Error('invalid Waterfall food/count');
    const threshold = eatAt ?? (food.id === 379 ? 6 : 30);
    if (!Number.isSafeInteger(threshold) || threshold < 1 || (food.id !== 379 && threshold < 23)) throw new Error('Waterfall fish threshold must retain a two-fire-giant-hit margin (>=23)');
    return { ...food, count, eatAt: threshold, crossAt: food.id === 379 && eatAt === undefined ? 9 : threshold };
}
const WF_BANK = { x: 2654, z: 3283 };
export function waterfallAssets(s: Session): Map<number, number> {
    const counts = new Map<number, number>();
    for (const i of [...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...(s.sdk.getState()?.bank?.items ?? [])]) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count);
    return counts;
}
export async function bankWaterfallPack(s: Session) {
    if (!(await s.bot.openBank()).success) throw new Error('Waterfall bank open failed');
    for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
        const item = s.sdk.getInventory().find(i => i.id === id)!;
        await s.bot.depositItem(item, -1);
        if (s.sdk.getInventory().some(i => i.id === id)) throw new Error(`Waterfall bank deposit incomplete id=${id}`);
    }
    await waitTicks(s, 1);
}
export async function prepareWaterfallPack(s: Session, food: ReturnType<typeof waterfallFood>) {
    const p = s.sdk.getState()?.player;
    if (!p || p.level !== 0 || Math.max(Math.abs(p.worldX - WF_BANK.x), Math.abs(p.worldZ - WF_BANK.z)) > 8) throw new Error('Waterfall Mighty preparation requires Ardougne south bank start');
    if (!(await s.bot.openBank()).success) throw new Error('Waterfall initial bank failed');
    await waitTicks(s, 1);
    const initial = waterfallAssets(s);
    await bankWaterfallPack(s); await s.bot.closeBank();
    for (const item of [...s.sdk.getEquipment()]) if (!(await s.bot.unequipItem(item)).success) throw new Error(`Waterfall cannot store worn ${item.name}`);
    await bankWaterfallPack(s);
    try {
        for (const [id, count] of [[954, 2], [556, 6], [557, 6], [555, 6], [food.id, food.count]]) {
            const item = s.sdk.getState()?.bank?.items.find(i => i.id === id);
            if (!item || item.count < count) throw new Error(`Waterfall owned input shortfall id=${id} need=${count}`);
            await s.bot.withdrawItem(item, count, { asNote: false });
            const actual = s.sdk.getInventory().filter(i => i.id === id).reduce((n,i) => n+i.count, 0);
            if (actual !== count) throw new Error(`Waterfall withdrawal shortfall id=${id} actual=${actual}`);
        }
        if (s.sdk.getInventory().length > 23) throw new Error('Waterfall staged pack exceeds23slots');
    } catch (e) { await bankWaterfallPack(s); throw e; }
    finally { await s.bot.closeBank(); }
    return initial;
}
export function waterfallConserved(initial: ReadonlyMap<number, number>, final: ReadonlyMap<number, number>, foodId: number, eaten: number) {
    return [...initial].every(([id,n]) => (final.get(id) ?? 0) >= n - ([556,557,555].includes(id) ? 6 : id === foodId ? eaten : 0));
}

export function waterfallResumeAtBookcase(p: { worldX: number; worldZ: number; level: number } | undefined) {
    return !!p && p.level === 1 && Math.abs(p.worldX - 2519) <= 3 && Math.abs(p.worldZ - 3427) <= 3;
}

// A shut chat window does not prove that the server reached a quest assignment. These
// mandatory conversations require a line AFTER that assignment and a closed final page.
export async function waterfallDialogue(s: Session, opts: { proof: RegExp; choices?: RegExp[]; maxTicks: number; stop?: () => boolean }) {
    let proofSeen = false;
    const trace: unknown[] = [];
    let last = '';
    // Capture on publication too: an awaited click can span several observations.
    const observe = () => {
        const d: any = s.sdk.getDialog();
        const text = d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ') : '';
        if (opts.proof.test(text)) proofSeen = true;
        const page = { tick: s.tick(), pageId: d?.pageId, open: !!d?.isOpen, waiting: !!d?.isWaiting, text,
            options: d?.options ?? [] };
        const key = JSON.stringify({ ...page, tick: 0 });
        if (key !== last) { trace.push(page); last = key; }
    };
    const off = s.onTick(observe);
    try {
    for (let tick = 0; tick < opts.maxTicks; tick++) {
        const d: any = s.sdk.getDialog();
        observe();
        if (opts.stop?.()) return { ok: false, proofSeen, reason: 'stopped', trace };
        if (proofSeen && !d?.isOpen && !d?.isWaiting) return { ok: true, proofSeen, reason: 'proved', trace };
        if (d?.isOpen && !d.isWaiting) {
            const options: any[] = d.options ?? [];
            // BUTTON_OK=1 is a choice; BUTTON_CONTINUE=6 is a pause page
            // (lite/actions.ts). Never send bare RESUME to an unanswered choice.
            const choices = options.filter(o => o.buttonType === 1 || !/^\s*(click here to )?continue\s*$/i.test(o.text ?? '') && o.buttonType !== 6);
            const selected = choices.find(o => opts.choices?.some(re => re.test(o.text ?? '')));
            if (choices.length && !selected) return { ok: false, proofSeen, reason: 'unexpected choice', trace };
            const index = selected?.index ?? options.find(o => o.buttonType === 6)?.index ?? 0;
            const reply = await s.sdk.sendClickDialog(index);
            trace.push({ tick: s.tick(), index, reply });
        }
        await waitTicks(s, 1);
    }
    return { ok: false, proofSeen, reason: 'mandatory progress not observed', trace };
    } finally { off(); }
}

async function main() {
const MIGHTY = process.env.WF_MIGHTY === '1';
const RESUME_HUDON = process.env.WF_RESUME_HUDON === '1';
if (RESUME_HUDON && !MIGHTY) throw new Error('WF_RESUME_HUDON requires WF_MIGHTY=1');
const FOOD = waterfallFood(process.env.WF_FOOD ?? 'lobster', process.env.WF_EAT_AT ? Number(process.env.WF_EAT_AT) : undefined, Number(process.env.WF_FOOD_COUNT ?? 16));
if (!process.argv[2] || /^(haggis|main)$/i.test(process.argv[2])) throw new Error('explicit non-reserved Waterfall account required');
const s = await openBot(process.argv[2]!);
try {
    await waitTicks(s, 5);
    const st = (): any => s.sdk.getState();
    const pos = (): any => st()?.player;
    const inv = (): any[] => st()?.inventory ?? [];
    const hp = (): number => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const atkXp = (): number => s.sdk.getSkillXp('Attack') ?? 0;
    const strXp = (): number => s.sdk.getSkillXp('Strength') ?? 0;
    const cnt = (id: number): number => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const has = (id: number): boolean => cnt(id) > 0;
    const cheb = (x: number, z: number): number => { const p = pos(); return p ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : 999; };
    const near = (x: number, z: number, r: number): boolean => cheb(x, z) <= r;
    const inBox = (x0: number, z0: number, x1: number, z1: number): boolean => {
        const p = pos();
        return !!p && p.worldX >= x0 && p.worldX <= x1 && p.worldZ >= z0 && p.worldZ <= z1;
    };
    const inBoxXZ = (x: number, z: number, x0: number, z0: number, x1: number, z1: number): boolean => x >= x0 && x <= x1 && z >= z0 && z <= z1;
    const dialogOpen = (): boolean => !!s.sdk.getDialog()?.isOpen;
    const pages: string[] = [];
    const capturePage = (): void => {
        const d: any = s.sdk.getDialog();
        if (!d?.isOpen) return;
        const text = [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ');
        if (text && pages[pages.length - 1] !== text) { pages.push(text); if (pages.length > 400) pages.shift(); }
    };
    const sawText = (re: RegExp): boolean => {
        capturePage();
        if (pages.some(p => re.test(p))) return true;
        const d: any = s.sdk.getDialog();
        if (d?.text && re.test(d.text)) return true;
        return (st()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    // Counts matching game messages; a step is done when the count rises past a count taken before the send.
    const msgCount = (re: RegExp): number => (st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).length;

    // Auto retaliate off (controls:com_3 = component 151): a hit never turns a walk or a loc click into a fight.
    if (MIGHTY) {
        if (st()?.autoRetaliateEnabled === undefined) throw new Error('Waterfall needs observed auto-retaliate state');
        if (st()?.autoRetaliateEnabled) await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
        if (!await waitUntil(s, () => st()?.autoRetaliateEnabled === false, { timeoutTicks: 5 })) throw new Error('Waterfall auto-retaliate off not observed');
    } else await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    const atk0 = atkXp();
    const str0 = strXp();
    const p0 = pos();
    const life0 = p0?.lifeId;
    const respawn0 = p0?.respawnCount ?? 0;
    const t0 = s.tick();
    const T = (): number => s.tick() - t0;
    let died = false;
    let hpMin = hp();
    let eats = 0;
    let lastEat = -10;
    let last = p0;
    const jumps: string[] = [];
    const done = new Set<number>();
    const milestone = (step: number): void => {
        if (done.has(step)) return;
        done.add(step);
        console.log(`MILESTONE ${step} ${T()}`);
    };

    // Fire giants max hit 11 (str 65, bonus 31) against 10 HP. While `crossing` their room, eat at any lost HP.
    let crossing = false;
    // The server drops an eat sent during a scripted delay (ladder, coffin, gate) with no message, and every eat
    // clears the pending interaction. So an eat counts only when the lobster count falls; `lastEat` is that tick.
    // An eat that did not land is sent again after 2 ticks.
    let eatSentAt = -99;
    let eatCount0 = 0;
    const eatPending = (): boolean => eatSentAt >= 0;
    const eatNow = (): boolean => {
        const food = inv().find(i => i.id === FOOD.id);
        if (!food || eatPending()) return false;
        const op = food.optionsWithIndex?.find((o: any) => /^eat$/i.test(o.text))?.opIndex ?? 1;
        eatSentAt = s.tick();
        eatCount0 = cnt(FOOD.id);
        void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: op, reason: 'SDK' });
        return true;
    };
    const eatCheck = (): void => {
        if (!eatPending()) return;
        if (cnt(FOOD.id) < eatCount0) { eats++; lastEat = s.tick(); eatSentAt = -99; }
        else if (s.tick() - eatSentAt >= 2) eatSentAt = -99;
    };

    // Every tick: death watch, jump log, and the eat reflex (a direct op, so it never waits behind a bot.* action).
    const off = s.onTick(() => {
        capturePage();
        const p = pos();
        const h = hp();
        if (h > 0 && h < hpMin && h <= 4) {
            const ns = (st()?.nearbyNpcs ?? []).filter((n: any) => n.distance <= 3).map((n: any) => `${n.name}@${n.tileX ?? n.x},${n.tileZ ?? n.z}${n.inCombat ? "*" : ""}`).join(" ");
            console.log(`WARN hp ${h} at ${T()} ${p?.worldX},${p?.worldZ},${p?.level} foodId=${FOOD.id} foodLeft=${cnt(FOOD.id)} lobsters=${cnt(379)} near: ${ns}`);
        }
        if (h > 0) hpMin = Math.min(hpMin, h);
        if (p?.isDead || (p && p.respawnCount > respawn0) || (p && life0 !== undefined && p.lifeId !== life0)) died = true;
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) {
            jumps.push(`${T()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (Math.max(Math.abs(p.worldX - LUMBRIDGE.x), Math.abs(p.worldZ - LUMBRIDGE.z)) <= 15) died = true;
        }
        if (p) last = p;
        if (TRACE && crossing && p) {
            const ns = (st()?.nearbyNpcs ?? []).filter((n: any) => n.distance <= 8).map((n: any) => `${n.name[0]}${n.index}@${n.tileX ?? n.x},${n.tileZ ?? n.z}${n.inCombat ? '*' : ''}t${n.targetIndex}`).join(' ');
            const hits = (st()?.combatEvents ?? []).filter((e: any) => e.tick >= s.tick() - 1 && e.type === 'damage_taken').map((e: any) => `${e.sourceIndex}:${e.damage}`).join(',');
            console.log(`TRACE ${T()} ${p.worldX},${p.worldZ} hp=${h} hits=${hits} ${ns}`);
        }
        eatCheck();
        if (h > 0 && h <= (crossing ? FOOD.crossAt : FOOD.eatAt)) eatNow();
    });

    const detail = (): string => {
        const p = pos();
        const msgs = (st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-4).map((m: any) => m.text).join(' / ');
        return `at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${T()} hpMin=${hpMin} eats=${eats} foodId=${FOOD.id} foodLeft=${cnt(FOOD.id)} lobsters=${cnt(379)} died=${died} milestones=${[...done].join(',')} jumps=${jumps.join(';')} msgs=${msgs}`;
    };
    const fail = async (why: string): Promise<never> => {
        off();
        console.log(`RATE attack ${atkXp() - atk0} ${T()}`);
        return finish([s], false, `${why} ${detail()}`);
    };
    const guard = async (label: string): Promise<void> => {
        if (died) await fail(`died during ${label}`);
        if (T() > CAP) await fail(`tick cap during ${label}`);
    };

    const opLoc = (l: { id: number; x: number; z: number }, op = 1) =>
        s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' });
    const useOnLoc = (item: number, l: { id: number; x: number; z: number }) => {
        const it = inv().find(i => i.id === item);
        if (!it) return Promise.resolve(null);
        return s.direct({ type: 'useItemOnLoc', itemSlot: it.slot, x: l.x, z: l.z, locId: l.id, reason: 'SDK' });
    };
    const findLoc = (pred: (l: any) => boolean): any =>
        (st()?.nearbyLocs ?? []).filter(pred).sort((a: any, b: any) => a.distance - b.distance)[0];
    const opIndex = (l: any, re: RegExp): number => l?.optionsWithIndex?.find((o: any) => re.test(o.text))?.opIndex ?? 1;

    // Scripted actions (p_delay) drop eats, so top up first when one hit could leave too little.
    const topUp = async (label: string, at = FOOD.eatAt + 1): Promise<void> => {
        for (let i = 0; i < 6 && hp() > 0 && hp() <= at && has(FOOD.id); i++) {
            await guard(label);
            eatNow();
            await waitTicks(s, 1);
        }
    };
    // Sends, then waits up to `ticks` for `ok`; retries. An eat clears the pending interaction, so a landed eat
    // after the send ends the wait early and the send repeats without using a try (2 ticks later, after a re-check,
    // so an action that already ran is not sent twice). A stray dialog page is clicked through between tries.
    const step = async (label: string, send: () => unknown, ok: () => boolean, ticks = 20, tries = 3): Promise<void> => {
        let resends = 0;
        for (let i = 0; i < tries; i++) {
            await guard(label);
            if (ok()) return;
            await topUp(label);
            if (ok()) return;
            const sentAt = s.tick();
            await send();
            await waitUntil(s, () => ok() || died || lastEat > sentAt, { timeoutTicks: ticks });
            if (ok()) return;
            if (lastEat > sentAt && !died && resends < 15) {
                resends++;
                i--;
                await waitTicks(s, 2);
                continue;
            }
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // Clicks through dialog pages: the first option matching a pattern, else "continue". Stops when ok() holds.
    const converse = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died; i++) {
            if (ok()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = (d.options ?? []).find((o: any) => pats.some(re => re.test(o.text)));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return ok();
    };

    // Each waypoint gets up to 4 walkTo tries from wherever the bot is.
    // Click-ahead walker (packages/core/src/walk.ts, research/walking.md): one click per tick at most, 20 tiles ahead,
    // opens shut doors on the path. bot.walkTo stays as the fallback for a leg it cannot finish.
    const walker = await sessionWalker(s as any);
    let walkTicks = 0;
    const fast = async (pts: PathPoint[]): Promise<number> => {
        const r = await walkPath(walker, pts, { stop: () => died || T() > CAP });
        walkTicks += r.ticks;
        return r.ok ? pts.length : r.next;
    };
    const walkPt = async (x: number, z: number, tol: number): Promise<boolean> => {
        if (!near(x, z, tol + 1)) await fast([{ x, z, tol }]);
        for (let i = 0; i < 4 && !near(x, z, tol + 1); i++) {
            await guard(`walk ${x},${z}`);
            await s.bot.walkTo(x, z, tol, { timeout: 400_000 });
        }
        return near(x, z, tol + 1);
    };
    const walk = async (label: string, pts: [number, number, number][]): Promise<void> => {
        const next = await fast(pts.map(([x, z, tol]) => ({ x, z, tol })));
        for (const [x, z, tol] of pts.slice(next)) if (!(await walkPt(x, z, tol))) await fail(`walk ${label} ${x},${z}`);
    };
    // Client-routed run through waypoints: one walk click per leg, sent again when the bot stands still for 2 ticks or
    // an eat landed. bot.walkTo stalled 26 ticks at 2581,9875 among the falls spiders (MEASURED practice 2026-10-23).
    // Falls back to bot.walkTo for a leg the client cannot route.
    const dash = async (label: string, pts: [number, number][]): Promise<void> => {
        const end = pts[pts.length - 1]!;
        if (near(end[0], end[1], 1)) return;
        for (const [x, z] of pts) {
            let sent = -99, prev = '', still = 0;
            for (let i = 0; i < 40 && !near(x, z, 0); i++) {
                await guard(`dash ${label}`);
                const at = `${pos()?.worldX},${pos()?.worldZ}`;
                still = at === prev ? still + 1 : 0;
                prev = at;
                if (sent < 0 || still >= 2 || lastEat > sent) {
                    sent = s.tick();
                    still = 0;
                    const w: any = await s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
                    if (w && w.success === false) { await walk(label, [[x, z, 0]]); break; }
                }
                await waitTicks(s, 1);
            }
            if (!near(x, z, 1)) await fail(`dash ${label} ${x},${z}`);
        }
    };
    // One long walkTo; if it stops short, follow the maze waypoints from the nearest one.
    const walkMaze = async (label: string, x: number, z: number, path: [number, number][], via: [number, number, number][] = []): Promise<void> => {
        if (!near(x, z, 2)) await fast([...via.map(([vx, vz, tol]) => ({ x: vx, z: vz, tol })), { x, z, tol: 1 }]);
        for (let i = 0; i < 2 && !near(x, z, 2); i++) {
            await guard(label);
            await s.bot.walkTo(x, z, 1, { timeout: 400_000 });
        }
        if (near(x, z, 2)) return;
        let k = 0;
        for (let i = 1; i < path.length; i++) if (cheb(path[i]![0], path[i]![1]) < cheb(path[k]![0], path[k]![1])) k = i;
        for (let i = k; i < path.length; i++) if (!(await walkPt(path[i]![0], path[i]![1], 1))) await fail(`maze ${label} ${path[i]}`);
        await walk(label, [[x, z, 2]]);
    };

    // Ladder or staircase with an option matching `re`, nearest to (x, z); waits for the plane or the z band to change.
    const climb = async (label: string, x: number, z: number, re: RegExp, arrived: () => boolean): Promise<void> => {
        await step(label, async () => {
            const l = findLoc(k => /ladder|stair/i.test(k.name) && Math.max(Math.abs(k.x - x), Math.abs(k.z - z)) <= 3 && k.optionsWithIndex?.some((o: any) => re.test(o.text)));
            if (!l) { await s.bot.walkTo(x, z, 2); return; }
            await opLoc(l, opIndex(l, re));
        }, arrived, 20, 4);
    };

    // A run that starts inside the falls (preset quest_waterfall_falls: %waterfall_quest 5, amulet, urn, runes) resumes at
    // step 6, so the fire giant crossing can be tested on its own.
    const inFalls = () => inBox(2550, 9855, 2610, 9925);
    const RUNES = [ITEM.air, ITEM.earth, ITEM.water];
    let initialAssets: Map<number, number> | undefined;
    if (MIGHTY) {
        if (RESUME_HUDON) {
            if (!waterfallResumeAtBookcase(pos())) await fail('Hudon resume requires observed Hadley upstairs bookcase start');
            console.log(`WATERFALL_RESUME_HUDON ${detail()} questStage=unknown; repair via Almera and Hudon proof`);
            await climb('resume Hadley down', 2518, 3429, /climb-down/i, () => pos()?.level === 0);
            await walk('resume Ardougne bank', [[WF_BANK.x, WF_BANK.z, 1]]);
        }
        initialAssets = await prepareWaterfallPack(s, FOOD);
        console.log(`WATERFALL_PREP ${JSON.stringify({ food: FOOD, slots: inv().length, storedKnife: initialAssets.get(946) ?? 0, storedShafts: initialAssets.get(52) ?? 0 })}`);
        await walk('Ardougne to Almera', [[2522,3494,2]]);
    }
    const resume = inFalls();
    if (resume) console.log(`MILESTONE resume-falls ${T()}`);
    if (!resume) {
        // 1. Almera: "How can I help?" sets %waterfall_quest = 1 (almera.rs2:14).
        const talk = await s.bot.talkTo(/^almera$/i);
        if (!talk.success) await fail(`talk Almera: ${talk.message}`);
        const almera = await waterfallDialogue(s, { proof: /you are kind|small raft out back|you can't be too careful these days|tourist centre south/i,
            choices: [/how can i help/i], maxTicks: 60, stop: () => died || T() > CAP });
        console.log(`WATERFALL_DIALOG Almera ${JSON.stringify(almera)}`);
        if (!almera.ok) await fail('no Waterfall progress: mandatory Almera dialogue');
        milestone(1);

        // 2. The raft lands on Hudon's island (2512,3481); Hudon's forced dialogue sets 2 (quest_waterfall.rs2:178).
        const onIsland = () => inBox(2510, 3476, 2514, 3481);
        await walk('raft', [[2511, 3494, 1]]);
        await step('raft 1', () => opLoc(LOC.raft), onIsland, 20);
        milestone(1);
        const hudonProof = /fine alone|so you're still here|find that treasure soon/i;
        let hudon = await waterfallDialogue(s, { proof: hudonProof, maxTicks: 36, stop: () => died || T() > CAP });
        console.log(`WATERFALL_DIALOG Hudon-forced ${JSON.stringify(hudon)}`);
        // No forced dialogue (Hudon wandered more than 5 tiles off): talk to him from the island (hudon.rs2:22).
        for (let i = 0; i < 2 && !hudon.ok && !dialogOpen(); i++) {
            await guard('talk Hudon');
            // hudon.rs2 accepts speech only in x2510..2514,z3476..3481.
            if (!await walkPt(2512, 3481, 0) || !onIsland()) await fail('Hudon acoustic island position');
            const h = s.sdk.findNearbyNpc(/^hudon$/i);
            if (h) await s.direct({ type: 'interactNpc', npcIndex: h.index, optionIndex: h.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
            await waitUntil(s, () => dialogOpen() || died, { timeoutTicks: 8 });
            hudon = await waterfallDialogue(s, { proof: hudonProof, maxTicks: 36, stop: () => died || T() > CAP });
            console.log(`WATERFALL_DIALOG Hudon-manual-${i + 1} ${JSON.stringify(hudon)}`);
        }
        if (!hudon.ok) await fail('no Waterfall progress: mandatory Hudon dialogue');
        milestone(2);

        // Off the island: rope on the rock, rope on the dead tree to the ledge, then the barrel washes the bot to 2527,3413.
        const onTreeIsland = () => inBox(2512, 3465, 2513, 3475);
        const onLedge = () => inBox(2510, 3462, 2513, 3464);
        const ropeAcross = async (label: string): Promise<void> => {
            await walkPt(2512, 3477, 0);
            await step(`${label} rope rock`, async () => {
                const roped = findLoc(l => l.id === 1997 && l.x === LOC.rock.x && l.z === LOC.rock.z);
                if (roped) { await waitTicks(s, 3); return; }
                await useOnLoc(ITEM.rope, LOC.rock);
            }, () => near(LOC.rock.x + 1, LOC.rock.z, 0), 15, 5);
            // The rope script ends with two forcemoves to 2513,3468; a click during them can be dropped.
            await waitTicks(s, 1);
            if (!onTreeIsland()) await fail(`${label} not on the tree island after the rope`);
            await step(`${label} rope tree`, () => useOnLoc(ITEM.rope, LOC.tree), onLedge, 15, 4);
        };
        await ropeAcross('trip 1');
        const washed = () => near(2527, 3413, 4);
        await step('barrel', () => opLoc(LOC.barrel), washed, 12, 3);

        // 3. The south-east bookcase upstairs in Hadley's house; reading the book sets 3 (baxtorian_book.rs2:7).
        await walk('Hadley', [[2517, 3427, 2]]);
        await climb('Hadley up', 2517, 3428, /climb-up/i, () => pos()?.level === 1);
        await step('bookcase', () => opLoc(LOC.bookcase), () => has(ITEM.book), 15, 3);
        milestone(2);
        const BOOK_MSG = /book is old/i;
        const read0 = msgCount(BOOK_MSG);
        // A missed message is not fatal here: the Golrie crate only gives its key at 3 or more, which proves it later.
        for (let i = 0; i < 2 && msgCount(BOOK_MSG) <= read0; i++) {
            await guard('read book');
            const b = inv().find(x => x.id === ITEM.book);
            if (b) await s.direct({ type: 'useInventoryItem', slot: b.slot, optionIndex: b.optionsWithIndex?.find((o: any) => /read/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
            await waitUntil(s, () => msgCount(BOOK_MSG) > read0 || died, { timeoutTicks: 5 });
        }
        if (msgCount(BOOK_MSG) > read0) milestone(3);
        else console.log(`WARN book message not seen at ${T()}`);
        await s.direct({ type: 'closeModal', reason: 'SDK' });
        await climb('Hadley down', 2518, 3429, /climb-down/i, () => pos()?.level === 0);

        // Golrie under the Tree Gnome Village: key from the east crate (needs 3), key on the gate, pebble from Golrie.
        await walkMaze('maze in', 2533, 3156, MAZE, [[2505, 3190, 2]]);
        const inCellar = () => (pos()?.worldZ ?? 0) > 9500 && (pos()?.worldZ ?? 0) < 9600;
        await climb('gnome cellar down', 2533, 3155, /climb-down/i, inCellar);
        await step('golrie crate', () => opLoc(LOC.golrieCrate), () => has(ITEM.golrieKey), 40, 3);
        milestone(3);
        const inGolrieRoom = () => inBox(2502, 9576, 2523, 9593);
        // The key only opens the gate from its own tile row (check_axis: z 9575), so stand south of it first; the key
        // script is p_delay(3) and a door move, about 5 ticks.
        if (!has(ITEM.golrieKey)) await fail('no Golrie key after the crate');
        await walk('golrie gate', [[2515, 9574, 0]]);
        await step('golrie gate', async () => {
            if (!near(2515, 9574, 1)) await s.bot.walkTo(2515, 9574, 0);
            await useOnLoc(ITEM.golrieKey, LOC.golrieGate);
        }, inGolrieRoom, 10, 6);
        // golrie.rs2 closes the dialogue for p_delay(2) when he takes the key, then talks again: wait for his last line,
        // or for 5 shut ticks, so the gate click does not land inside that gap.
        let golrieShut = 0;
        const gotPebble = () => {
            golrieShut = dialogOpen() ? 0 : golrieShut + 1;
            return has(ITEM.pebble) && !has(ITEM.golrieKey) && ((sawText(/take care golrie/i) && !dialogOpen()) || golrieShut >= 5);
        };
        await step('Golrie', async () => {
            const g = s.sdk.findNearbyNpc(/^golrie$/i);
            if (g) await s.direct({ type: 'interactNpc', npcIndex: g.index, optionIndex: g.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
            await converse([], gotPebble, 40);
        }, gotPebble, 3, 3);
        await step('gate out', () => opLoc(LOC.golrieGate), () => inCellar() && !inGolrieRoom(), 15, 3);
        await walk('cellar ladder', [[2533, 9556, 2]]);
        await climb('gnome cellar up', 2533, 9555, /climb-up/i, () => (pos()?.worldZ ?? 0) < 4000);

        // 4. Glarial's tombstone: runes are refused in the tomb (quest_waterfall.rs2:70), so they wait on the ground
        // (300-tick drop timer). The pebble opens the tomb and sets 4.
        await walkMaze('maze out', 2557, 3444, [...MAZE].reverse());
        // All three stacks in one tick (the server takes 5 inputs per tick); bot.dropItem cost about 15 idle ticks here.
        const runeDrop = { x: pos()?.worldX, z: pos()?.worldZ };
        for (let i = 0; i < 4 && RUNES.some(has); i++) {
            for (const r of inv().filter(x => RUNES.includes(x.id))) void s.direct({ type: 'dropItem', slot: r.slot, reason: 'SDK' });
            await waitUntil(s, () => !RUNES.some(has) || died, { timeoutTicks: 2 });
        }
        if (RUNES.some(has)) await fail('could not drop the runes');
        const dropTick = T();
        const inTomb = () => inBox(2520, 9795, 2560, 9850);
        await step('pebble', () => useOnLoc(ITEM.pebble, LOC.tombstone), inTomb, 15, 3);
        milestone(4);
        // The chest can be open or shut (another player); open it if shut, then search the open one in the same try.
        const chestLoc = (id: number) => findLoc(l => l.id === id && l.x === LOC.chest.x && l.z === LOC.chest.z);
        await step('chest', async () => {
            if (!chestLoc(LOC.chestOpen) && !chestLoc(LOC.chestClosed)) { await s.bot.walkTo(LOC.chest.x, LOC.chest.z + 1, 1); return; }
            const shut = chestLoc(LOC.chestClosed);
            if (shut) {
                await opLoc({ id: shut.id, x: shut.x, z: shut.z }, opIndex(shut, /open/i));
                await waitUntil(s, () => !!chestLoc(LOC.chestOpen) || died, { timeoutTicks: 25 });
            }
            const open = chestLoc(LOC.chestOpen);
            if (open) await opLoc({ id: open.id, x: open.x, z: open.z }, opIndex(open, /search/i));
        }, () => has(ITEM.amulet), 10, 5);
        await step('coffin', () => opLoc(LOC.coffin), () => has(ITEM.urn), 30, 3);
        await climb('tomb ladder', 2556, 9844, /climb-up/i, () => (pos()?.worldZ ?? 0) < 4000);
        // One pickup per tick, the next one sent as soon as the last stack lands.
        for (let i = 0; i < 20 && RUNES.some(id => cnt(id) < 6); i++) {
            await guard('pick runes');
            const id = RUNES.find(r => cnt(r) < 6)!;
            const g = (st()?.groundItems ?? []).filter((x: any) => x.id === id && (!MIGHTY || x.x === runeDrop.x && x.z === runeDrop.z)).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g) await s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
            await waitUntil(s, () => cnt(id) >= 6 || died, { timeoutTicks: 3 });
        }
        if (RUNES.some(id => cnt(id) < 6)) await fail(`runes not picked up: ${RUNES.map(cnt).join('/')}`);
        console.log(`WARN runes back after ${T() - dropTick} ticks on the ground`);

        // 5. Raft again, rope across, the ledge door with the amulet sets 5 (quest_waterfall.rs2:270).
        await walk('raft 2', [[2511, 3494, 1]]);
        await step('raft 2', () => opLoc(LOC.raft), onIsland, 20);
        await ropeAcross('trip 2');
        await step('ledge door', () => opLoc(LOC.ledgeDoor), inFalls, 12, 3);
        milestone(5);
    }

    // 6. Key from the crate in the east room, through the fire giant room, key on the puzzle-room door sets 6.
    await dash('falls crate', [[2574, 9873], [2584, 9876], [2589, 9887]]);
    await step('falls crate', () => opLoc(LOC.baxCrate), () => has(ITEM.baxKey), 12, 3);
    // Cause of the 8 failed runs (MEASURED practice 2026-10-23, quest_waterfall_falls preset): the fire giant room is
    // shut by a closed large double door (loc 1516/1519 at 2564-2565,9881, maps/m40_154.jm2). The SDK collision masks
    // doors, so bot.walkTo plans through it, but the client route stops at it: a key use from the south room gets
    // "I can't reach that!" and a walk click is client_rejected. The bot then stood in the south room until the shadow
    // spiders and giants killed it. Fix: open the double door from its south tile, run to the door's own tile
    // (2568,9893), and use the key there. The tiles 2568,9892-9893 are a 1-wide corridor that a size-2 giant cannot enter.
    const DOUBLE_DOOR = { x: 2564, z: 9881 };
    const DOOR_TILE = { x: 2568, z: 9893 };
    const pastGiantDoor = () => inBox(2562, 9894, 2572, 9901);
    const npcs = (): any[] => st()?.nearbyNpcs ?? [];
    const giants = (): any[] => npcs().filter(n => /^fire giant$/i.test(n.name));
    // Chebyshev gap from a tile to the nearest giant footprint (size 2, SW tile).
    const giantGap = (x: number, z: number): number => {
        let best = 99;
        for (const g of giants()) {
            const gx = g.tileX ?? g.x, gz = g.tileZ ?? g.z, sz = g.size ?? 2;
            const dx = x < gx ? gx - x : x > gx + sz - 1 ? x - (gx + sz - 1) : 0;
            const dz = z < gz ? gz - z : z > gz + sz - 1 ? z - (gz + sz - 1) : 0;
            best = Math.min(best, Math.max(dx, dz));
        }
        return best;
    };
    const doorShut = () => !!findLoc(l => (l.id === 1516 || l.id === 1519) && l.z === DOUBLE_DOOR.z && Math.abs(l.x - 2564.5) <= 1);
    await dash('double door', [[2584, 9876], [2569, 9876], [DOUBLE_DOOR.x, DOUBLE_DOOR.z - 1]]);
    await step('open double door', async () => {
        const d = findLoc(l => (l.id === 1516 || l.id === 1519) && l.z === DOUBLE_DOOR.z && Math.abs(l.x - 2564.5) <= 1);
        if (d) await opLoc({ id: d.id, x: d.x, z: d.z }, opIndex(d, /^open$/i));
    }, () => !doorShut(), 6, 4);
    await topUp('top up', FOOD.crossAt);
    crossing = true;
    // Shield: in single-way combat no NPC attacks a player that another NPC attacked in the last 8 ticks
    // (npc_check_notcombat, npc_combat.rs2:382-391). The run from here to the 1-wide corridor (2568,9891) takes about
    // 6 ticks. So the bot starts it on the tick after a hit from a spider or rat, never with no shield when one can be
    // had. Without it a giant hit for 7 in the room (MEASURED practice: `WARN hp 3 at 957 2565,9887`, giant in combat).
    const giantIdx = () => new Set(giants().map(g => g.index));
    const shieldHit = (): boolean => (st()?.combatEvents ?? []).some((e: any) => e.type === 'damage_taken' && e.sourceType === 'npc'
        && !giantIdx().has(e.sourceIndex) && e.tick >= s.tick() - 1);
    let shieldWait = 0;
    for (; shieldWait < 12 && !shieldHit() && !died; shieldWait++) { await guard('shield'); await waitTicks(s, 1); }
    await topUp('top up', FOOD.crossAt);
    console.log(`MILESTONE crossing ${T()} hp=${hp()} shield=${shieldHit()} waited=${shieldWait} gap=${giantGap(2564, 9885)}`);
    let lastSend = -99;
    let still = 0;
    let prevAt = '';
    let keySent = -99;
    let rejected = 0;
    for (let i = 0; i < 60 && !pastGiantDoor(); i++) {
        await guard('giant door');
        const at = `${pos()?.worldX},${pos()?.worldZ}`;
        still = at === prevAt ? still + 1 : 0;
        prevAt = at;
        if (near(DOOR_TILE.x, DOOR_TILE.z, 0)) {
            if (s.tick() - keySent >= 2) { keySent = s.tick(); await useOnLoc(ITEM.baxKey, LOC.giantDoor); }
        } else if (lastSend < 0 || lastEat > lastSend || still >= 2) {
            lastSend = s.tick();
            still = 0;
            const w: any = await s.direct({ type: 'walkTo', x: DOOR_TILE.x, z: DOOR_TILE.z, running: true, reason: 'SDK' });
            if (w && w.success === false) {
                rejected++;
                // The double door shut again (another player, or its timer): open it from wherever the bot is.
                const d = findLoc(l => (l.id === 1516 || l.id === 1519) && l.z === DOUBLE_DOOR.z && Math.abs(l.x - 2564.5) <= 1);
                if (d) await opLoc({ id: d.id, x: d.x, z: d.z }, opIndex(d, /^open$/i));
            }
            if (TRACE) console.log(`TRACE walk ${JSON.stringify(w)?.slice(0, 160)}`);
        }
        await waitTicks(s, 1);
    }
    if (rejected) console.log(`WARN giant door walk rejected ${rejected} times`);
    crossing = false;
    await guard('giant door');
    if (!pastGiantDoor()) await fail('step giant door');
    const inPuzzle = () => inBox(2561, 9902, 2570, 9917);
    await step('puzzle door', () => useOnLoc(ITEM.baxKey, LOC.puzzleDoor), inPuzzle, 15, 4);
    milestone(6);

    // 7. One rune of each type on each pillar; every use deletes one rune, a repeat only prints "You remember".
    for (const [px, pz] of PILLARS) {
        for (const id of RUNES) {
            const before = cnt(id);
            const seen0 = msgCount(/remember putting that type/i);
            await step(`pillar ${px},${pz} rune ${id}`, () => useOnLoc(id, { id: LOC.pillar, x: px, z: pz }),
                () => cnt(id) < before || msgCount(/remember putting that type/i) > seen0, 15, 3);
            if (TRACE) console.log(`TRACE pillar ${px},${pz} rune ${id} at ${T()} pos=${pos()?.worldX},${pos()?.worldZ}`);
        }
    }
    // A short pillar set makes the statue drop a boulder for 20 damage (quest_waterfall.rs2:435): never risk it.
    if (RUNES.some(has)) await fail(`runes left after the pillars: ${RUNES.map(cnt).join('/')}`);

    // 8. Amulet on Glarial's statue raises the floor (teleport to 2603,9914) and sets 8.
    const raised = () => inBox(2598, 9895, 2610, 9920);
    await step('statue', () => useOnLoc(ITEM.amulet, LOC.statue), raised, 15, 3);
    milestone(8);

    // 10. Urn on the chalice (never op1: that floods the cavern). The reward queue sets 10 and grants the XP.
    // The reward needs 5 free slots. The danger is over here, so spare lobsters go first.
    for (let i = 0; !MIGHTY && i < 6 && inv().length > 23 && has(FOOD.id); i++) {
        const l = inv().find(x => x.id === FOOD.id);
        if (l) await s.direct({ type: 'dropItem', slot: l.slot, reason: 'SDK' });
        await waitTicks(s, 1);
    }
    if (inv().length > 23) await fail(`needs 5 free slots, has ${28 - inv().length}`);
    await step('chalice', () => useOnLoc(ITEM.urn, LOC.chalice), () => atkXp() > atk0, 15, 3);
    milestone(10);

    if (!MIGHTY) off();
    const gained = atkXp() - atk0;
    const strGained = strXp() - str0;
    console.log(`RATE attack ${gained} ${T()}`);
    console.log(`INFO walkPath ticks=${walkTicks}`);
    let preserved = true, rewardsBanked = false;
    if (MIGHTY && !died) {
        // quest_waterfall.rs2:392 returns the raised chamber to the original room;
        // door2000:287 exits to the ledge, barrel:291 washes safely to2527,3413.
        await walk('raised room exit', [[2604,9901,1]]);
        await step('raised room key exit', () => useOnLoc(ITEM.baxKey, { id: 2002, x: 2604, z: 9900 }), () => inBox(2562,9894,2572,9901), 15, 4);
        await step('south key door return', () => useOnLoc(ITEM.baxKey, LOC.giantDoor), () => !findLoc(l => l.id === 2002 && l.x === LOC.giantDoor.x && l.z === LOC.giantDoor.z), 12, 4);
        await dash('return through giant room', [[2568,9891],[2565,9883]]);
        await step('return double door', async () => { const d = findLoc(l => [1516,1519].includes(l.id) && l.z === 9881); if (d) await opLoc(d, opIndex(d,/^open$/i)); }, () => !doorShut(), 8, 4);
        await dash('return to ledge exit', [[2564,9880],[2584,9876],[2575,9863]]);
        await step('falls exit', () => opLoc({ id: 2000, x: 2575, z: 9861 }), () => near(2511,3463,3), 15, 4);
        await step('return barrel', () => opLoc(LOC.barrel), () => near(2527,3413,4), 15, 4);
        await walk('Waterfall reward return to bank', [[WF_BANK.x,WF_BANK.z,2]]);
        await bankWaterfallPack(s);
        const final = waterfallAssets(s);
        preserved = !!initialAssets && waterfallConserved(initialAssets, final, FOOD.id, eats);
        rewardsBanked = [ [1601,2], [2357,2], [299,40] ].every(([id,n]) => (final.get(id) ?? 0) - (initialAssets?.get(id) ?? 0) === n);
        console.log(`WATERFALL_BANK ${JSON.stringify({ attackXp: gained, strengthXp: strGained, preserved, rewardsBanked, foodId: FOOD.id, eaten: eats, foodLeft: final.get(FOOD.id) ?? 0, diamonds: final.get(1601) ?? 0, goldBars: final.get(2357) ?? 0, seeds: final.get(299) ?? 0, hpMin, died })}`);
        await s.bot.closeBank();
        off();
    }
    const ok = (MIGHTY ? gained === 343750 && strGained === 343750 && preserved && rewardsBanked : gained >= 300_000) && !died;
    await finish([s], ok, `attackXp=${gained} strengthXp=${strGained} preserved=${preserved} rewardsBanked=${rewardsBanked} ${detail()}`);
} catch (e) { await finish([s], false, String(e)); }

}
if (import.meta.main) await main();
