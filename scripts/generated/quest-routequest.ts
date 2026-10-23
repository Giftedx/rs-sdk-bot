// In Search of the Myreque from preset quest_routequest (the Hair of the Dog inn, Canifis, beside Vanstrom Klause; every
// skill 99; Nature Spirit done; the blessed sickle, a druid pouch, the 6 steel weapons, 6 planks, 30 nails, a hammer).
// Reward: 2 QP, Attack, Defence, Strength, Hitpoints and Crafting XP (quests/quest_routequest/scripts/
// quest_routequest.rs2:24-32).
// Varp %routequest (quest_routequest.constant): 5 Vanstrom, 10-15 Cyreg, 20 the planks, 25 the boat, 52 the tree, 55
// Curpile, 60 the door, 65 Veliaf, 70 the weapons, 80 the cutscene, 85 the hellhound, 90 the exit route, 95 the wall,
// 97 the ladder, 100 the stranger, then the completion.
// Server truth: quests/quest_routequest/scripts/routequest_vanstorm.rs2, routequest_morton.rs2, routequest_hollow.rs2,
// routequest_myreque.rs2, route_cutscene.rs2; quests/quest_druidspirit/scripts/quest_druidspirit.rs2 (the pouch).
import { openQuest } from './quest-lib';

const VANSTROM = { x: 3503, z: 3477 };
const BLOOM = { x: 3430, z: 3330 };                        // the Nature Spirit bloom spot (log 3429,3331, bush 3431,3329)
const CYREG = { x: 3522, z: 3284 };
const BOAT = { id: 5051, x: 3523, z: 3284 };               // route_rowboat, Mort'ton side -> 3498,3380
const TREE_S = { id: 5005, x: 3502, z: 3426 };             // harmless_dead_palm_mid, Climb up -> 3502,3427
const TREE_N = { id: 5005, x: 3502, z: 3431 };             // Climb down -> 3503,3432 (52)
const CURPILE = { x: 3508, z: 3440 };
const DOOR = { id: 5060, x: 3510, z: 3447 };               // freedomfighterentrancel (r: 5061 at 3509,3447) -> 3500,9811
const STALAGMITE = { id: 5050, x: 3492, z: 9824 };         // Squeeze-past -> 3505,9832 level 3 (before the ambush)
const TUNNEL = { id: 5046, x: 3505, z: 9831 };             // route_cavewalltunnel -> 3491,9824
const WALL = { id: 5052, x: 3480, z: 9837 };               // thrttavernbasementfalsewall
const LADDER = { id: 5054, x: 3477, z: 9846 };             // thrttavernbasementladder -> 3494,3464
const ITEM = { blessed: 2963, pouchEmpty: 2957, pouch: 2958, mushroom: 2970, stem: 2972, pear: 2974, plank: 960 };
// Curpile's 6 questions and their right answers (routequest_hollow.rs2:287-335).
const ANSWERS: Array<[RegExp, RegExp]> = [
    [/youngest member/i, /^ivan strom$/i], [/only female member/i, /^sani piliu$/i], [/leader of the myreque/i, /^veliaf hurtz$/i],
    [/scholar/i, /^polmafi ferdygris$/i], [/boatman's name/i, /^cyreg paddlehorn$/i], [/rumoured to rule morytania/i, /^drakan$/i],
];

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/completed|quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    // One dialog page per tick; on an option page the option matching the LAST pattern in `pats` that matches any
    // option is taken (so a later step beats an earlier one on a page that offers both).
    const chat = async (pats: RegExp[], ok: () => boolean, maxTicks: number, pick?: (opts: string[]) => number | undefined): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !q.stats.died; i++) {
            if (ok()) return true;
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opts: any[] = d.options ?? [];
                let idx: number | undefined;
                if (pick) idx = pick(opts.map(o => o.text));
                if (idx === undefined) for (const re of [...pats].reverse()) { const o = opts.find(o => re.test(o.text)); if (o) { idx = o.index; break; } }
                if (idx === undefined && opts.some(o => !/click here to continue/i.test(o.text))) console.log(`WARN no option match: ${opts.map(o => o.text).join(' | ')}`);
                void q.s.sdk.sendClickDialog(idx ?? 0);
            }
            await q.waitTicks(1);
        }
        return ok();
    };
    const talkChat = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, maxTicks = 80, pick?: (o: string[]) => number | undefined): Promise<void> => {
        for (let i = 0; i < 3 && !ok(); i++) {
            await q.guard(label);
            if (!q.npc(re)) await q.walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 3 }]);
            await q.step(`${label} talk`, () => { const n = q.npc(re); return n ? q.talkTo(n) : q.waitTicks(1); }, () => q.dialogOpen(), 20, 4);
            await chat(pats, () => ok() && !q.dialogOpen(), maxTicks, pick);
        }
        if (!ok()) await q.fail(`talk ${label}`);
    };
    const pouch = () => q.cnt(ITEM.pouch);

    // 1. Vanstrom: "Why do they need help?", "Perhaps I could help you out here.", "Yes, I'll do it!" (5,
    // routequest_vanstorm.rs2:90-153).
    await talkChat('vanstrom', /^vanstrom klause$/i, [/why do they need help/i, /perhaps i could help you out/i, /yes, i'll do it/i],
        () => q.sawText(/additional hero/i), VANSTROM, 120);
    q.milestone(5);
    // 2. The walk to Mort'ton through Mort Myre. Cyreg wants a pouch of 5 charges or more (routequest_morton.rs2:191-200)
    // and the ghasts on the way spend charges (ghast.rs2:24-26), so the bot tops the pouch up at the Nature Spirit bloom
    // spot on the way (quest_druidspirit.rs2:235-331).
    await q.walk('to bloom', [{ x: 3443, z: 3459, tol: 1 }]);
    await q.step('gate', () => { const g = q.findLoc(l => (l.id === 3506 || l.id === 3507) && l.distance <= 4) ?? { id: 3506, x: 3444, z: 3458 }; return q.opLoc(g, q.opIndex(g, /^open$/i)); },
        () => z() <= 3457, 12, 5);
    await q.walk('to bloom spot', [{ x: BLOOM.x, z: BLOOM.z, tol: 0 }]);
    const harvest = () => q.cnt(ITEM.mushroom) + q.cnt(ITEM.stem) + q.cnt(ITEM.pear);
    const grownNear = () => [3513, 3511, 3509].map(id => q.findLoc(l => l.id === id && Math.max(Math.abs(l.x - x()), Math.abs(l.z - z())) <= 1)).find(Boolean);
    for (let round = 0; round < 3 && pouch() < 12; round++) {
        for (let i = 0; i < 12 && harvest() < 3; i++) {
            await q.guard('harvest');
            if (!grownNear()) { await q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.blessed)!, optionIndex: 3, reason: 'SDK' }); await q.waitUntil(() => !!grownNear(), 4); }
            const g = grownNear();
            if (!g) continue;
            const h0 = harvest();
            await q.opLoc(g, q.opIndex(g, /pick|take/i));
            await q.waitUntil(() => harvest() > h0, 6);
        }
        const p0 = pouch();
        await q.step('fill pouch', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(q.has(ITEM.pouch) ? ITEM.pouch : ITEM.pouchEmpty)!, optionIndex: 1, reason: 'SDK' }), () => pouch() > p0, 6, 4);
    }
    console.log(`POUCH ${pouch()} at ${q.T()}`);
    q.milestone('pouch');
    await q.walk('to cyreg', [{ x: CYREG.x - 1, z: CYREG.z, tol: 2 }]);
    console.log(`POUCH ${pouch()} at ${q.T()}`);
    // 3. Cyreg: "Well, I guess they'll just die without weapons.", "Resourceful enough to get their own steel weapons?",
    // "If you don't tell me, their deaths are on your head!", "What kind of a man are you to say that you don't care?"
    // (15); the pouch and the planks, "Give wooden planks to Cyreg." (20, routequest_morton.rs2:57-221).
    await talkChat('cyreg', /^cyreg paddlehorn$/i, [/they'll just die without weapons/i, /resourceful enough/i, /deaths are on your head/i, /what kind of a man are you/i, /give wooden planks/i],
        () => q.cnt(ITEM.plank) <= 3, CYREG, 160);
    q.milestone(20);
    // 4. The boat, "Yes, I'll pay ten gold." (25, routequest_morton.rs2:1-55): 13 ticks to the Hollows.
    await q.step('boat', () => { const b = q.findLoc(l => l.id === BOAT.id && l.distance <= 8) ?? BOAT; return q.opLoc(b, q.opIndex(b, /board/i)); }, () => q.dialogOpen(), 15, 4);
    await chat([/yes, i'll pay ten gold/i], () => z() > 3370 && z() < 3400 && x() < 3510, 40);
    await chat([], () => !q.dialogOpen(), 10);
    q.milestone(25);
    // 5. The tree up to the rope bridge; the three broken rungs repaired (1 plank, 10 nails, a hammer each,
    // routequest_hollow.rs2:126-185); the tree down at the north end (52, routequest_hollow.rs2:48-97).
    await q.walk('to tree', [{ x: TREE_S.x, z: TREE_S.z - 1, tol: 1 }]);
    await q.climb('tree up', () => q.locAt(TREE_S.x, TREE_S.z) ?? TREE_S, /climb up/i, () => z() >= 3427, 4);
    for (let i = 0; i < 12 && z() < 3430; i++) {
        await q.guard('rungs');
        const z0 = z();
        const r = q.findLoc(l => l.x === 3502 && l.z === z0 + 1 && (l.id === 5002 || l.id === 5003));
        if (!r && i === 0) console.log(`WARN rung locs: ${q.locs().filter((l: any) => l.distance <= 3).map((l: any) => `${l.id}@${l.x},${l.z} ${(l.optionsWithIndex ?? []).map((o: any) => o.text).join('/')}`).join('; ')}`);
        // swamp_bridge1 Repair is op5; the broken rung (5003) has Repair as op1.
        await q.opLoc(r ?? { id: 5002, x: 3502, z: z0 + 1 }, r ? q.opIndex(r, /repair/i) : (i % 2 === 0 ? 5 : 1));
        await q.waitUntil(() => z() > z0, 8);
        await chat([], () => !q.dialogOpen(), 4);
    }
    if (z() < 3430) await q.fail('rungs');
    await q.climb('tree down', () => q.locAt(TREE_N.x, TREE_N.z) ?? TREE_N, /climb down/i, () => z() >= 3432, 4);
    q.milestone(52);
    // 6. Curpile: "I've come to help the Myreque, I've brought weapons.", three of his six questions (55).
    const answer = (opts: string[]): number | undefined => {
        const page = [q.s.sdk.getDialog()?.text ?? '', ...((q.s.sdk.getDialog() as any)?.allComponents ?? []).map((c: any) => c.text ?? '')].join(' ');
        for (const [qre, are] of ANSWERS) if (qre.test(page)) { const i = opts.findIndex(o => are.test(o.trim())); if (i >= 0) return (q.s.sdk.getDialog() as any).options[i].index; }
        return undefined;
    };
    await talkChat('curpile', /^curpile fyod$/i, [/i've come to help the myreque/i], () => q.sawText(/i'll unlock it for you/i), CURPILE, 120, answer);
    q.milestone(55);
    // 7. The door (60), the stalagmite to the members' room (routequest_hollow.rs2:1-29, routequest_myreque.rs2:118-136).
    await q.walk('to door', [{ x: 3509, z: 3446, tol: 1 }]);
    await q.climb('door', () => q.findLoc(l => (l.id === 5060 || l.id === 5061) && l.distance <= 4) ?? DOOR, /open|enter/i, () => z() > 9000, 4);
    q.milestone(60);
    await q.walk('to stalagmite', [{ x: STALAGMITE.x - 1, z: STALAGMITE.z, tol: 1 }]);
    await q.climb('stalagmite', () => q.findLoc(l => l.id === STALAGMITE.id && l.distance <= 4) ?? STALAGMITE, /squeeze/i, () => q.lvl() === 3, 4);
    await chat([], () => !q.dialogOpen() && q.lvl() === 3, 10);
    // 8. Veliaf (65); the five members, each "Ok, thanks." (the bits, routequest_myreque.rs2:160-407); Veliaf with the
    // weapons starts the cutscene (70-80, route_cutscene.rs2).
    const thanks = [/^ok,? thanks/i];
    await talkChat('veliaf 1', /^veliaf hurtz$/i, thanks, () => q.sawText(/introduce yourself to the others/i), { x: 3506, z: 9838 });
    q.milestone(65);
    const MEMBERS: Array<[string, RegExp, RegExp, { x: number; z: number }]> = [
        ['sani', /^sani piliu$/i, /my name is sani piliu/i, { x: 3508, z: 9837 }],
        ['harold', /^harold evans$/i, /my name's harold/i, { x: 3504, z: 9837 }],
        ['radigad', /^radigad ponfit$/i, /how can i be of service to you/i, { x: 3509, z: 9831 }],
        ['polmafi', /^polmafi ferdygris$/i, /observed proper protocol/i, { x: 3514, z: 9838 }],
        ['ivan', /^ivan strom$/i, /my name is ivan/i, { x: 3513, z: 9843 }],
    ];
    for (const [label, re, seen, home] of MEMBERS) await talkChat(label, re, thanks, () => q.sawText(seen), home);
    q.milestone('members');
    await talkChat('veliaf weapons', /^veliaf hurtz$/i, [], () => q.sawText(/these weapons look great/i), { x: 3506, z: 9838 }, 40);
    // The cutscene runs on its own; its pages are clicked through until the hellhound appears (route_cutscene.rs2:183-189).
    await chat([], () => q.lvl() === 0 && !!q.npc(/^skeleton hellhound$/i), 200);
    q.milestone(80);
    // 9. The hellhound (85, routequest_myreque.rs2:584-616).
    for (let i = 0; i < 8 && q.npc(/^skeleton hellhound$/i); i++) {
        await q.guard('hellhound');
        const h = q.npc(/^skeleton hellhound$/i);
        await q.s.bot.attack(h as any);
        await q.waitUntil(() => !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === h.index), 60);
    }
    if (q.npc(/^skeleton hellhound$/i)) await q.fail('hellhound');
    q.milestone(85);
    // 10. Veliaf: "How do I get out of here?" (90), "Ok, thanks." (routequest_myreque.rs2:502-527).
    const exitPick = (opts: string[]): number | undefined => {
        const d: any = q.s.sdk.getDialog();
        const want = q.sawText(/search the wall/i) ? /^ok,? thanks/i : /how do i get out of here/i;
        const i = opts.findIndex(o => want.test(o));
        return i >= 0 ? d.options[i].index : undefined;
    };
    await talkChat('veliaf exit', /^veliaf hurtz$/i, [], () => q.sawText(/search the wall/i), { x: 3506, z: 9838 }, 80, exitPick);
    q.milestone(90);
    // 11. Out by the tunnel; the wall (95) and the ladder to Canifis (97, routequest_myreque.rs2:43-53,100-112).
    await q.climb('tunnel', () => q.findLoc(l => l.id === TUNNEL.id && l.distance <= 10) ?? TUNNEL, /./, () => x() < 3495, 4);
    await q.walk('to wall', [{ x: WALL.x, z: WALL.z - 1, tol: 0 }]);
    await q.climb('wall', () => q.locAt(WALL.x, WALL.z) ?? WALL, /search/i, () => z() >= WALL.z, 4);
    q.milestone(95);
    await q.walk('to ladder', [{ x: LADDER.x, z: LADDER.z - 1, tol: 1 }]);
    await q.climb('ladder', () => q.findLoc(l => l.id === LADDER.id && l.distance <= 6) ?? LADDER, /climb/i, () => z() < 9000, 4);
    q.milestone(97);
    // 12. The stranger in the inn (Vanstrom's seat) queues the completion (routequest_vanstorm.rs2:33-72).
    await talkChat('stranger', /^stranger$|^vanstrom klause$/i, [], () => questDone, VANSTROM, 60);
    await chat([], () => !q.dialogOpen(), 20);
    q.milestone(110);
    off();
    await q.end(questDone, `qp=2 pouch=${pouch()}`);
} catch (e) { await q.fail(String(e)); }
