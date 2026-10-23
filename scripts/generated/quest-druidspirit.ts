// Nature Spirit from preset quest_druidspirit (the mausoleum beside Drezel; every skill 99; The Restless Ghost and
// Priest in Peril done; amulet of ghostspeak worn; the wolfbane dagger and a silver sickle in the pack). Reward: 2 QP,
// Crafting, Hitpoints and Defence XP (quests/quest_druidspirit/scripts/quest_druidspirit.rs2:421-429).
// Varp %druidspirit (307, quest_druidspirit.constant): 5 Drezel, 10 into Mort Myre, 20 Filliman with the amulet, 25 the
// mirror, 30 the journal, 35 the bloom spell, 40 Drezel's blessing, 45 the spell cast, 50 the fungus, 55 Filliman,
// 60 the stones, 65 the grotto, 70 the transformation, 75 the blessed sickle, 80 the sickle bloom, 85 a harvest picked,
// 90 the pouch filled, 95-105 three ghasts, 110 done.
// Server truth: areas/area_mausoleum/scripts/drezel.rs2:1-19,138-147,160-332, holy_barrier.rs2, quests/quest_druidspirit/
// scripts/quest_druidspirit.rs2, filliman.rs2, ghast.rs2, swamp_decay.rs2.
import { openQuest } from './quest-lib';

const DREZEL = { x: 3440, z: 9895 };
const BARRIER = { id: 3443, x: 3440, z: 9886 };            // pip_underground_wall_side_withportal -> 3423,3485
const TRAPDOOR = { id: 3432, x: 3422, z: 3485 };           // pipeastsidetrapdoor (open 3433) -> 3440,9887
const GATE_L = { id: 3506, x: 3444, z: 3458 };             // mortmyre_metalgateclosed_l (r: 3507 at 3443,3458)
const BRIDGE = { id: 3522, x: 3440, z: 3329 };             // druidjump_loc, 3440-3441,3329-3331; the only way into the camp
const SOUTH = { x: 3440, z: 3327 };                        // south of the bridge (the walk reaches it from the gate)
const BOWL = { id: 2964, x: 3437, z: 3337 };               // bowl_empty_filliman on the table; the mirror appears under it
const GROTTO_DOOR = { id: 3516, x: 3440, z: 3337 };
const GROTTO_TREE = { id: 3517, x: 3439, z: 3338 };        // Search: the journal
const STONE_NATURE = { id: 3527, x: 3439, z: 3336 };
const STONE_FAITH = { x: 3440, z: 3335 };                  // the player stands here for the puzzle (filliman.rs2:390)
const STONE_SPIRIT = { id: 3529, x: 3441, z: 3336 };
const GROTTO = { id: 3520, x: 3441, z: 9740 };             // druidic_spirit_grotto, Search spawns Filliman
const ROOTWALL = { id: 3525, x: 3442, z: 9733 };           // exit -> 3440,3339
// Bloom spot west of the bridge: the rotting log 3508 at 3429,3331 and the small bush 3512 at 3431,3329 are both next
// to 3430,3330 (maps/m53_52.jm2); the bloom grows the 8 tiles round the player (quest_druidspirit.rs2:209-230,252-273).
const BLOOM = { x: 3430, z: 3330 };
const ITEM = {
    dagger: 2952, sickle: 2961, blessed: 2963, pouchEmpty: 2957, pouch: 2958, bowl: 2964, mirror: 2966, journal: 2967,
    spell: 2968, usedSpell: 2969, mushroom: 2970, stem: 2972, pear: 2974,
};
const GROWN = [3509, 3511, 3513];                          // log_druidicspirit2, branch_druidicspirit2, peartree_druidicspirit2

const q = await openQuest({ cap: 5000, food: [379, 2327, 2323] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const under = () => z() > 9000;
    const inCamp = () => !under() && x() >= 3434 && x() <= 3448 && z() >= 3330 && z() <= 3344;
    const filliman = /^filliman tarlock$|^nature spirit$/i;
    const drezel = /^drezel$/i;

    const pickup = async (label: string, id: number, at: { x: number; z: number }): Promise<void> => {
        await q.step(label, () => {
            const g = (q.st()?.groundItems ?? []).find((o: any) => o.id === id);
            return q.s.direct({ type: 'pickupItem', x: g?.x ?? at.x, z: g?.z ?? at.z, itemId: id, reason: 'SDK' });
        }, () => q.has(id), 10, 4);
    };
    const useItem = (id: number, op: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: op, reason: 'SDK' });
    const closeDialog = async (): Promise<void> => { await q.converse([/^ok,? thanks/i], () => !q.dialogOpen(), 30); };

    // The bridge jump: Agility 99 fails about 1 in 64 (stat_random(agility, 60, 252), quest_druidspirit.rs2:38); a fall
    // leaves the bot on the same side, so it jumps again.
    const jump = async (label: string, north: boolean): Promise<void> => {
        const across = () => north ? inCamp() : (z() <= 3329 && !under());
        for (let i = 0; i < 6 && !across(); i++) {
            await q.guard(label);
            if (north && z() > 3328) await q.walk(`${label} to bridge`, [{ x: SOUTH.x, z: SOUTH.z, tol: 1 }]);
            if (!north && z() > 3332) await q.dash(`${label} to bridge`, 3440, 3332, 0, 12);
            // The bridge end on the bot's side: 3440,3329 from the south, 3440,3331 from the camp ("I can't reach that!"
            // from the camp on the far end).
            const bz = north ? BRIDGE.z : BRIDGE.z + 2;
            const b = q.findLoc(l => l.id === BRIDGE.id && l.x === BRIDGE.x && l.z === bz) ?? { ...BRIDGE, z: bz };
            await q.opLoc(b, q.opIndex(b, /jump/i));
            await q.waitUntil(across, 14);
        }
        if (!across()) await q.fail(`jump ${label}`);
    };
    const gateIn = async (label: string): Promise<void> => {
        await q.walk(`${label} to gate`, [{ x: 3443, z: 3459, tol: 1 }]);
        await q.step(`${label} gate`, () => { const g = q.findLoc(l => (l.id === 3506 || l.id === 3507) && l.distance <= 4) ?? GATE_L; return q.opLoc(g, q.opIndex(g, /^open$/i)); },
            () => z() <= 3457, 12, 5);
    };
    const gateOut = async (label: string): Promise<void> => {
        await q.walk(`${label} to gate`, [{ x: 3443, z: 3457, tol: 1 }]);
        await q.step(`${label} gate`, () => { const g = q.findLoc(l => (l.id === 3506 || l.id === 3507) && l.distance <= 4) ?? GATE_L; return q.opLoc(g, q.opIndex(g, /^open$/i)); },
            () => z() >= 3458, 12, 5);  // the gate walls lie on the south edge of 3443-3444,3458 (angle 3)
    };
    // The grotto entrance: below 60 it spawns Filliman at 3440,3336 and opens his dialog (quest_druidspirit.rs2:92-100).
    const enterDoor = async (label: string, ok: () => boolean): Promise<void> => {
        await q.step(label, () => { const d = q.locAt(GROTTO_DOOR.x, GROTTO_DOOR.z) ?? GROTTO_DOOR; return q.opLoc(d, q.opIndex(d, /enter/i)); }, ok, 15, 4);
    };
    const fillimanNear = () => !!q.npc(filliman);
    const ensureFilliman = async (label: string): Promise<void> => {
        if (fillimanNear()) return;
        await enterDoor(`${label} door`, () => q.dialogOpen() || fillimanNear());
        await closeDialog();
    };

    // 1. Drezel: the barrier talk (302 = 61, drezel.rs2:138-147), then "Is there anything else interesting to do around
    // here?", "Well, what is it, I may be able to help?", "Yes, I'll go and look for him.", "Yes, I'm sure." (5,
    // drezel.rs2:275-332); he hands over 3 meat pies and 3 apple pies.
    await q.talk('drezel barrier', drezel, [], () => q.sawText(/keep it equipped whenever i fight werewolves/i), DREZEL, 80);
    await q.talk('drezel start', drezel, [/anything else interesting/i, /what is it, i may be able to help/i, /yes, i'll go and look for him/i, /yes, i'm sure/i],
        () => q.has(2327), DREZEL, 80);
    q.milestone(5);
    // 2. The holy barrier to 3423,3485; the Mort Myre gate (10, quest_druidspirit.rs2:4-16); the walk round the swamp to
    // the south side of the camp; the bridge jump.
    await q.walk('to barrier', [{ x: BARRIER.x, z: BARRIER.z + 1, tol: 1 }]);
    await q.climb('barrier', () => q.findLoc(l => l.id === BARRIER.id && l.distance <= 6) ?? BARRIER, /pass/i, () => !under(), 4);
    await gateIn('in 1');
    q.milestone(10);
    await jump('camp 1', true);
    q.milestone('camp');
    // 3. The bowl (opobj3 at 3437,3337) puts the mirror under it (quest_druidspirit.rs2:63-78).
    await pickup('bowl', ITEM.bowl, BOWL);
    await pickup('mirror', ITEM.mirror, BOWL);
    // 4. The grotto: Filliman appears; "How long have you been a ghost?" (20, filliman.rs2:255-261).
    await enterDoor('door 1', () => q.dialogOpen());
    await q.converse([/how long have you been a ghost/i], () => q.sawText(/pull one over on me/i), 60);
    await closeDialog();
    q.milestone(20);
    // 5. The mirror on Filliman (25, filliman.rs2:271-293); the grotto tree gives the journal (quest_druidspirit.rs2:84-
    // 90); the journal on Filliman (30) and "How can I help?" gives the bloom spell (35, filliman.rs2:294-348).
    await ensureFilliman('mirror');
    // The mirror stays in the pack (filliman.rs2:284-291 has no inv_del).
    await q.step('mirror on filliman', () => { const n = q.npc(filliman); return n ? q.useOnNpc(ITEM.mirror, n) : q.waitTicks(1); }, () => q.dialogOpen() || q.sawText(/where did i put my journal/i), 15, 4);
    await q.converse([], () => q.sawText(/where did i put my journal/i), 40);
    await closeDialog();
    q.milestone(25);
    await q.step('grotto tree', () => { const t = q.locAt(GROTTO_TREE.x, GROTTO_TREE.z) ?? GROTTO_TREE; return q.opLoc(t, q.opIndex(t, /search/i)); }, () => q.has(ITEM.journal), 12, 4);
    await q.converse([], () => !q.dialogOpen(), 10);
    await ensureFilliman('journal');
    await q.step('journal on filliman', () => { const n = q.npc(filliman); return n ? q.useOnNpc(ITEM.journal, n) : q.waitTicks(1); }, () => q.dialogOpen() || !q.has(ITEM.journal), 15, 4);
    await q.converse([/^how can i help/i], () => q.has(ITEM.spell), 80);
    await closeDialog();
    q.milestone(35);
    // 6. Back to Drezel for the blessing (40, drezel.rs2:228-245): the bridge, the gate, the trapdoor by the barrier
    // exit (to 3440,9887, holy_barrier.rs2:11-20).
    await jump('out 1', false);
    await gateOut('out 1');
    await q.walk('to trapdoor', [{ x: TRAPDOOR.x + 1, z: TRAPDOOR.z, tol: 1 }]);
    // Open (3432 -> 3433), then Climb-down on the open trapdoor; one click each, no 15-tick wait between them.
    for (let i = 0; i < 8 && !under(); i++) {
        await q.guard('trapdoor');
        const t = q.findLoc(l => (l.id === 3432 || l.id === 3433) && l.distance <= 6) ?? TRAPDOOR;
        await q.opLoc(t, 1);
        await q.waitUntil(() => under() || (t.id === 3432 && !!q.findLoc(l => l.id === 3433 && l.distance <= 6)), 6);
    }
    if (!under()) await q.fail('trapdoor');
    await q.talk('drezel bless', drezel, [], () => q.sawText(/you're now blessed/i), DREZEL, 80);
    q.milestone(40);
    await q.walk('to barrier 2', [{ x: BARRIER.x, z: BARRIER.z + 1, tol: 1 }]);
    await q.climb('barrier 2', () => q.findLoc(l => l.id === BARRIER.id && l.distance <= 6) ?? BARRIER, /pass/i, () => !under(), 4);
    await gateIn('in 2');
    // 7. The bloom spell by the rotting log west of the bridge (45), the fungus picked (50).
    await q.walk('to bloom', [{ x: BLOOM.x, z: BLOOM.z, tol: 0 }]);
    const grown = () => q.findLoc(l => GROWN.includes(l.id) && Math.max(Math.abs(l.x - x()), Math.abs(l.z - z())) <= 1);
    await q.step('cast bloom', () => useItem(ITEM.spell, 1), () => q.has(ITEM.usedSpell), 8, 5);
    await q.step('pick fungus', () => { const g = grown(); return g ? q.opLoc(g, q.opIndex(g, /pick/i)) : q.waitTicks(1); }, () => q.has(ITEM.mushroom), 8, 5);
    q.milestone(50);
    // 8. Filliman (55); the fungus on the nature stone, the used spell on the spirit stone, the bot on the faith stone,
    // "I think I've solved the puzzle!" (60, quest_druidspirit.rs2:135-194, filliman.rs2:384-407).
    await jump('camp 2', true);
    await enterDoor('door 2', () => q.dialogOpen());
    await q.converse([], () => q.sawText(/other components of the spell/i), 40);
    await closeDialog();
    q.milestone(55);
    await q.step('fungus on stone', () => q.useOnLoc(ITEM.mushroom, q.locAt(STONE_NATURE.x, STONE_NATURE.z) ?? STONE_NATURE), () => !q.has(ITEM.mushroom), 10, 4);
    await q.step('spell on stone', () => q.useOnLoc(ITEM.usedSpell, q.locAt(STONE_SPIRIT.x, STONE_SPIRIT.z) ?? STONE_SPIRIT), () => !q.has(ITEM.usedSpell), 10, 4);
    await q.converse([], () => !q.dialogOpen(), 10);
    await ensureFilliman('puzzle');
    await q.dash('faith stone', STONE_FAITH.x, STONE_FAITH.z, 0, 10);
    await q.step('talk puzzle', () => { const n = q.npc(filliman); return n ? q.talkTo(n) : q.waitTicks(1); }, () => q.dialogOpen(), 8, 4);
    await q.converse([/solved the puzzle/i], () => q.sawText(/come through now into the grotto/i), 40);
    await q.converse([], () => !q.dialogOpen(), 10);
    if (!q.sawText(/come through now into the grotto/i)) await q.fail('puzzle');
    q.milestone(60);
    // 9. The grotto (65); its Search spawns Filliman, who transforms (70); a second Search with the sickle blesses it
    // and gives the empty pouch (75, filliman.rs2:165-195).
    await enterDoor('door 3', under);
    q.milestone(65);
    const search = () => { const g = q.findLoc(l => l.id === GROTTO.id && l.distance <= 12) ?? GROTTO; return q.opLoc(g, q.opIndex(g, /search/i)); };
    await q.step('grotto search 1', search, () => q.dialogOpen(), 12, 4);
    await q.converse([], () => q.sawText(/bring to me a silver sickle/i), 60);
    await closeDialog();
    q.milestone(70);
    await q.step('grotto search 2', search, () => q.dialogOpen(), 12, 4);
    await q.converse([], () => q.has(ITEM.pouchEmpty), 60);
    await q.converse([], () => !q.dialogOpen(), 20);
    if (!q.has(ITEM.blessed)) await q.fail('no blessed sickle');
    q.milestone(75);
    // 10. Out, the bridge, the sickle's bloom by the log and the bush (80); three harvests picked (85); the pouch (90).
    await q.step('rootwall', () => { const r = q.findLoc(l => l.id === ROOTWALL.id && l.distance <= 12) ?? ROOTWALL; return q.opLoc(r, q.opIndex(r, /exit/i)); }, () => !under(), 12, 4);
    await jump('out 2', false);
    await q.walk('to bloom 2', [{ x: BLOOM.x, z: BLOOM.z, tol: 0 }]);
    const harvest = () => q.cnt(ITEM.mushroom) + q.cnt(ITEM.stem) + q.cnt(ITEM.pear);
    for (let i = 0; i < 12 && harvest() < 3; i++) {
        await q.guard('harvest');
        if (!grown()) { await useItem(ITEM.blessed, 3); await q.waitUntil(() => !!grown(), 4); }
        // A pear (3 charges, quest_druidspirit.rs2:302-305) before a stem (2) or a fungus (1): In Search of the Myreque
        // needs a pouch with 5 charges or more (quests/quest_routequest/scripts/routequest_morton.rs2:191-200).
        const g = [3513, 3511, 3509].map(id => q.findLoc(l => l.id === id && Math.max(Math.abs(l.x - x()), Math.abs(l.z - z())) <= 1)).find(Boolean);
        if (!g) continue;
        const h0 = harvest();
        await q.opLoc(g, q.opIndex(g, /pick|take/i));
        await q.waitUntil(() => harvest() > h0, 6);
    }
    if (harvest() < 3) await q.fail('harvest');
    q.milestone(85);
    await q.step('fill pouch', () => useItem(ITEM.pouchEmpty, 1), () => q.has(ITEM.pouch), 6, 4);
    q.milestone(90);
    // 11. Three ghasts: a ghast that attacks while the pouch holds a charge turns visible (ghast.rs2:24-26,204-216), or
    // the pouch used on one nearby; the visible ghast is attacked until it dies (95, 100, 105, ghast.rs2:131-142).
    const kills = () => q.msgCount(/that's one ghast|that's two ghasts|that's all three ghasts/i);
    const visible = () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^ghast$/i.test(n.name) && n.combatLevel > 0).sort((a: any, b: any) => a.distance - b.distance)[0];
    const hidden = () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^ghast$/i.test(n.name) && !(n.combatLevel > 0) && n.distance <= 6).sort((a: any, b: any) => a.distance - b.distance)[0];
    for (let i = 0; i < 60 && kills() < 3; i++) {
        await q.guard('ghasts');
        const v = visible();
        if (v) {
            const k0 = kills();
            await q.s.bot.attack(v as any);
            await q.waitUntil(() => kills() > k0 || !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === v.index && m.combatLevel > 0), 40);
            continue;
        }
        const h = hidden();
        if (h && q.has(ITEM.pouch)) { await q.useOnNpc(ITEM.pouch, h); await q.waitUntil(() => !!visible(), 4); continue; }
        await q.waitTicks(2);
    }
    if (kills() < 3) await q.fail('ghasts');
    q.milestone(105);
    // 12. Back in the grotto: the Nature Spirit queues the completion (filliman.rs2:129-160).
    await jump('camp 3', true);
    await enterDoor('door 4', under);
    await q.step('grotto search 3', search, () => q.dialogOpen() || questDone, 12, 4);
    await q.converse([], () => questDone, 60);
    await q.converse([], () => !q.dialogOpen(), 20);
    q.milestone(110);
    off();
    await q.end(questDone, `qp=2 pouch=${q.cnt(ITEM.pouch)}`);
} catch (e) { await q.fail(String(e)); }
