// Lost City from preset quest_zanaris or quest_zanaris_partner (beside the warrior of the adventurers' camp, Lumbridge
// swamp; nothing worn; bronze axe, knife, prayer potions, Lumbridge teleport runes, lobsters). Reward: 3 QP
// (quest_zanaris.rs2:103-106). Woodcutting 36 for the dramen tree (:37), Crafting 31 for the staff (:78).
// Varp %zanaris (147): 1 the warrior; 2 Shamus; 3 the tree spirit dead; 4 the branch; 5 the staff; 6 the shed door with
// the staff worn (queued completion).
// Server truth: areas/area_lumbridge/scripts/warrior_zanaris.rs2, quests/quest_zanaris/scripts/*.rs2,
// areas/area_port_sarim/scripts/monk_of_entrana.rs2, areas/area_entrana/scripts/cave_monk.rs2 and entrana_dungeon.rs2,
// drop tables/scripts/zombie.rs2:102-111 (the Entrana zombie drops a bronze axe 50/128).
import { componentId } from '../../packages/core/src/logout';
import { lostCityRoute } from '../quest-zanaris-plan';
import { openQuest } from './quest-lib';

const WARRIOR = { x: 3145, z: 3202 };
const SHAMUS_TREE = { id: 2409, x: 3138, z: 3212 };        // leprechauntree, maps/m49_50.jm2 0 2 12
const MONKS = { x: 3046, z: 3235 };                         // shipmonk spawns 3045-3049,3234-3236, maps/m47_50.jm2
const CAVE_MONK = { x: 2822, z: 3374 };                     // cave_monk beside entranaladdertop 2820,3374
const DUNGEON = { x: 2822, z: 9774 };                       // cave_monk.rs2:13 0_44_152_6_46
const ZOMBIES = { x: 2845, z: 9761 };                       // zombie_entranan spawns 2842-2849,9756-9766
const TREE = { id: 1292, x: 2860, z: 9734 };                // dramentree, maps/m44_152.jm2 0 44 6
const MAGIC_DOOR = { id: 2407, x: 2874, z: 9750 };          // zanarismagicdoor -> 0_50_58_50_60 (3250,3772)
const SHED_DOOR = { id: 2406, x: 3202, z: 3169 };           // zanarisdoor, maps/m50_49.jm2 0 2 33
const ITEM = { axe: 1351, knife: 946, branch: 771, staff: 772, prayerPot: [2434, 139, 141, 143] };
const PFM = 14, ULT_STR = 10, INC_REF = 11;     // skill_prayer/configs/prayers.dbrow order (quest-grail.ts)

const route = lostCityRoute(process.env.LOST_CITY_ROUTE);
const windBolt = route.windBolt;
const q = await openQuest({ cap: 3000, eatAt: route.eatAt, food: [route.food], lumbridgeOk: true });
try {
    if (windBolt) {
        const casts = windBolt.axeCasts + windBolt.spiritCasts;
        const skill = (name: 'Magic' | 'Woodcutting' | 'Crafting' | 'Hitpoints') =>
            q.s.sdk.getSkill(name)?.baseLevel ?? 0;
        if (skill('Magic') < 31 || skill('Woodcutting') < 36 || skill('Crafting') < 31 ||
            skill('Hitpoints') < 52 || q.cnt(562) < casts || q.cnt(556) < casts * 2 + 3 ||
            !q.has(557) || !q.has(563) || !q.has(ITEM.axe) || !q.has(ITEM.knife) ||
            q.cnt(route.food) < windBolt.sharks) {
            await q.fail('Wind Bolt Lost City entry kit or skills missing');
        }
    }
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const z = () => q.pos()?.worldZ ?? 0;
    const shut = () => q.converse([], () => !q.dialogOpen(), 12);
    const lvl0 = () => q.lvl() === 0;
    const points = (): number => q.st()?.prayers?.prayerPoints ?? 0;
    const prayOn = (i: number): boolean => !!q.st()?.prayers?.activePrayers?.[i];
    const setPrayer = async (i: number, on: boolean) => {
        if (prayOn(i) === on || (on && points() <= 0)) return;
        const required = i === PFM ? 43 : i === ULT_STR ? 31 : 34;
        if (windBolt && on && (q.s.sdk.getSkill('Prayer')?.baseLevel ?? 0) < required) return;
        await q.step(`prayer ${i} ${on}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: i, reason: 'SDK' }), () => prayOn(i) === on, 3, 3);
    };
    const keepPrayer = async () => {
        if (points() > 6) return;
        const pot = ITEM.prayerPot.find(id => q.has(id));
        if (!pot) return;
        const p0 = points();
        await q.step('prayer potion', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(pot)!, optionIndex: 1, reason: 'SDK' }), () => points() > p0, 3, 2);
    };
    const attack = (n: any) => q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    const castWindBolt = (npcIndex: number) => q.s.direct({
        type: 'spellOnNpc', npcIndex, spellComponent: componentId('magic:wind_bolt'), reason: 'SDK',
    });
    const wield = async (id: number) => {
        const worn = () => (q.st()?.equipment ?? []).some((e: any) => e.id === id);
        await q.step(`wield ${id}`, () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: 2, reason: 'SDK' }), worn, 3, 3);
    };
    const disembark = async (label: string) => {
        for (let i = 0; i < 8 && !lvl0(); i++) {
            await q.guard(label);
            if (q.dialogOpen()) { await shut(); continue; }
            const plank = q.findLoc(l => /^gangplank$/i.test(l.name));
            if (!plank) { await q.waitTicks(2); continue; }
            await q.opLoc(plank, q.opIndex(plank, /cross/i));
            await q.waitUntil(lvl0, 10);
        }
        if (!lvl0()) await q.fail(label);
    };

    // 1. The warrior: "What are you camped here for?", "What makes you think it's out here?", "If it's hidden how are
    // you planning to find it?", "Looks like you don't know either." sets 1 (warrior_zanaris.rs2:30-72).
    await q.talk('warrior', /^warrior$/i, [/what are you camped here for/i, /what makes you think it's out here/i, /if it's hidden how are you planning/i, /looks like you don't know either/i],
        () => q.sawText(/so a leprechaun knows where zanaris is/i), WARRIOR, 80);
    q.milestone(1);

    // 2. Chop Shamus's tree with an axe in the pack: Shamus appears and walks 10 tiles east (quest_zanaris.rs2:11-26);
    // "How does it fit in a shed then?" sets 2 (shamus.rs2:15-25,146-153).
    await q.step('shamus tree', () => q.opLoc(SHAMUS_TREE, 1), () => !!q.npc(/^shamus$/i), 10, 4);
    await q.talk('shamus', /^shamus$/i, [/how does it fit in a shed then/i], () => q.sawText(/ship from port sarim to entrana/i), SHAMUS_TREE, 60);
    q.milestone(2);

    // 3. No axe on Entrana (monk_of_entrana.rs2:26-53): drop it. The monk at Port Sarim: "Yes, okay, I'm ready to go."
    if (q.has(ITEM.axe)) { await q.s.direct({ type: 'dropItem', slot: q.slot(ITEM.axe)!, reason: 'SDK' }); await q.waitTicks(1); }
    await q.walk('to monks', [{ x: MONKS.x, z: MONKS.z + 2, tol: 3 }]);
    await q.talk('ship monk', /^monk of entrana$/i, [/yes, okay, i'm ready to go/i], () => q.lvl() === 1 && q.near(2834, 3331, 6), MONKS, 60, true);
    await shut();
    await disembark('entrana gangplank');
    q.milestone('entrana');

    // 4. The cave monk: "Well that is a risk I will have to take." puts the bot in the dungeon and drains Prayer by 95%
    // (cave_monk.rs2:3-15).
    await q.talk('cave monk', /^cave monk$/i, [/well that is a risk i will have to take/i], () => z() > 9000, CAVE_MONK, 60, true);
    await shut();
    q.milestone('dungeon');

    // 5. Zombies until a bronze axe drops (zombie.rs2:102-111).
    const axeOnGround = (): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === ITEM.axe).sort((a: any, b: any) => (a.distance ?? 0) - (b.distance ?? 0))[0];
    let zombies = 0;
    let lastZombie = -1;
    const axeRuneFloor = windBolt ? Math.max(windBolt.spiritCasts, q.cnt(562) - windBolt.axeCasts) : 0;
    for (let t = 0; t < 600 && !q.has(ITEM.axe); t++) {
        await q.guard('zombies');
        const g = axeOnGround();
        if (g) { if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); }
        else {
            const n = q.npc(/^zombie$/i);
            if (!n) { if (t % 10 === 0) await q.dash('to zombies', ZOMBIES.x, ZOMBIES.z, 3); }
            else if (windBolt ? q.cnt(562) > axeRuneFloor && t % 5 === 0 :
                q.pos()?.targetIndex !== n.index && t % 4 === 0) {
                if (n.index !== lastZombie) zombies++;
                lastZombie = n.index;
                if (windBolt) await castWindBolt(n.index);
                else await attack(n);
            }
        }
        await q.waitTicks(1);
    }
    if (windBolt) console.log('AXE_HUNT '+JSON.stringify({
        zombieTargets: zombies, chaosRemaining: q.cnt(562), axe: q.has(ITEM.axe),
    }));
    if (!q.has(ITEM.axe)) await q.fail('no bronze axe');
    q.milestone('axe');
    await wield(ITEM.axe);

    // 6. The dramen tree spawns the tree spirit (2860,9737), which attacks; kill it under Protect from Melee (3), then
    // chop a branch (4), the knife on the branch makes the staff (5).
    await q.walk('to tree', [{ x: TREE.x, z: TREE.z + 2, tol: 1 }]);
    await q.step('tree', () => q.opLoc(TREE, 1), () => !!q.npc(/^tree spirit$/i), 10, 4);
    // The spirit hits up to 10 (attack 90, strength 95): Protect from Melee first (a trial without it fell to 37 HP of
    // 99 and ate 3 lobsters), then Ultimate Strength and Incredible Reflexes while the points last.
    const fightPrayers = [PFM, ULT_STR, INC_REF];
    const retaliate = () => q.s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    await retaliate();
    let spiritDead = false;
    for (let t = 0; t < 600 && !spiritDead; t++) {
        await q.guard('tree spirit');
        if (q.sawText(/tree spirit defeated/i)) { spiritDead = true; break; }
        await keepPrayer();
        for (const i of fightPrayers) if (!prayOn(i) && points() > 0) await setPrayer(i, true);
        const n = q.npc(/^tree spirit$/i);
        if (n && windBolt && q.cnt(562) > 0) {
            if (t % 5 === 0) await castWindBolt(n.index);
        } else if (n && q.pos()?.targetIndex !== n.index && t % 4 === 0) await attack(n);
        await q.waitTicks(1);
    }
    await retaliate();
    if (!spiritDead) await q.fail('tree spirit');
    await shut();
    for (const i of fightPrayers) await setPrayer(i, false);
    q.milestone(3);
    // The axe is worn: the woodcutting check accepts a worn axe (woodcutting_axe_checker).
    await q.step('branch', () => q.opLoc(TREE, 1), () => q.has(ITEM.branch), 10, 4);
    q.milestone(4);
    await q.step('staff', () => q.useOnItem(ITEM.knife, ITEM.branch), () => q.has(ITEM.staff), 5, 3);
    await wield(ITEM.staff);
    q.milestone(5);

    // 7. The magic door to the Wilderness (3250,3772, level 32), south to level 20 (z 3679), Lumbridge teleport, the
    // swamp shed with the staff worn (quest_zanaris.rs2:89-101).
    await q.walk('to magic door', [{ x: MAGIC_DOOR.x - 1, z: MAGIC_DOOR.z, tol: 1 }]);
    await q.step('magic door', () => q.opLoc(MAGIC_DOOR, 1), () => z() < 9000, 8, 4);
    q.milestone('wilderness');
    await q.walk('wilderness south', [{ x: 3250, z: 3676, tol: 2 }]);
    await q.teleport('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
    // The SDK route goes round the castle's north side and in by the west of the swamp (96-118 ticks): a trial with
    // waypoints south of the castle met a dead end at 3232,3215.
    await q.walk('to shed', [{ x: SHED_DOOR.x - 1, z: SHED_DOOR.z, tol: 0 }]);
    await q.step('shed door', () => q.opLoc(SHED_DOOR, 1), () => questDone, 10, 4);
    await shut();
    q.milestone(6);
    off();
    await q.end(questDone, `qp=3 zombies=${zombies}`);
} catch (e) { await q.fail(String(e)); }
