// Tribal Totem from preset quest_totem (beside Kangai Mau, Brimhaven; every skill 99, Thieving 21+ for the stairs trap;
// Plague City done for Ardougne Teleport). Reward: 1 QP, 1,775 Thieving XP before 25x, 5 swordfish
// (quest_totem/scripts/quest_totem.rs2:211-217).
// Varp %totemquest (200): 1 Kangai Mau (kangai_mau.rs2:50-54); the horn crate's label (quest_totem.rs2:8-16) on the
// teleport crate in the RPDT depot sets 2 (:18-31); the RPDT employee "So, when are you going to deliver this crate?"
// 3 (rdpt_employee.rs2:3-8); Wizard Cromperty's teleport lands in Handelmort's mansion and sets 4
// (wizard_cromperty.rs2:66-81); the combination KURT (quest_totem.rs2:35-47), the stairs trap found with Search
// (:142-154), the chest on level 1 (:156-170); Kangai Mau takes the totem and queues completion (kangai_mau.rs2:66-74).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';
import { questFlags } from '../../packages/core/src/quest-status';
import { loadTravel } from '../../packages/core/src/travel';
import { walkRoute } from '../../packages/core/src/walk';
import { BARNABY_BRIMHAVEN, CUSTOMS_OFFICER_ARDOUGNE, onKaramja, surplusForSlots, totemStartsAtKangai, totemTravel } from '../tribal-totem-route';
import { nearestBankTile } from '../rune-mysteries-route';
import travelData from '../../packages/planner/src/haggis-travel.json';

const KANGAI = { x: 2791, z: 3182 };
const HORNCRATE = { id: 2707, x: 2650, z: 3273 };
const TELECRATE = { id: 2708, x: 2650, z: 3271 };          // the depot one (another stands in the mansion)
const RPDT = { x: 2644, z: 3274 };
const CROMPERTY = { x: 2683, z: 3326 };
const ARRIVE = { x: 2638, z: 3321 };                       // 0_41_51_14_57 (wizard_cromperty.rs2:76)
const COMBO = { id: 2705, x: 2634, z: 3323 };
const STAIRS = { id: 2711, x: 2631, z: 3322 };
const STAIRSTOP = { id: 1723, x: 2631, z: 3322 };          // level 1
const CHEST = { x: 2638, z: 3324 };                        // level 1
const BARNABY = { x: 2679, z: 3275 };
const BRIM_DECK = { x: 2775, z: 3234 };                    // 1_43_50_23_34 (captain_barnaby.rs2:2)
const ITEM = { label: 1858, totem: 1857 };

// Food: sharks, swordfish, lobsters, salmon and trout, whatever the pack holds (an account at Hitpoints 17 fell to 8 on
// the mansion stairs trap with sharks it never ate under the library's lobster-only default).
const q = await openQuest({ cap: 2500, food: [385, 373, 379, 329, 333] });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const lv = () => q.lvl();
    const btn = (n: number) => q.s.direct({ type: 'clickComponent', componentId: componentId(`tribal_door2:com_${n}`), reason: 'SDK' });

    // The journal: a started quest skips Kangai Mau, who would only ask for the totem (kangai_mau.rs2 kangai_mau_totem_back).
    const flag = (name: string) => questFlags((q.s as any).client)?.find(f => f.name === name)?.state ?? 'unknown';
    await q.waitUntil(() => flag('Tribal Totem') !== 'unknown', 15);
    console.log(`NOTE tribal totem journal ${flag('Tribal Totem')}, plague city ${flag('Plague City')}`);

    // A boat leg from the travel data (scripts/quest-sweep.ts sails the same way): walk to the sailor, pay, land.
    const sail = async (label: string, id: string): Promise<void> => {
        const leg = loadTravel().find(t => t.id === id);
        if (!leg?.from) await q.fail(`travel leg ${id} unavailable`);
        await q.walk(`to ${label}`, [{ x: leg!.from!.x, z: leg!.from!.z, tol: 3 }]);
        const r = await walkRoute(q.s as any, [{ kind: 'travel', travel: leg!, at: leg!.from!, to: leg!.to }], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
        if (!r.ok || !q.near(leg!.to.x, leg!.to.z, 8)) await q.fail(`boat ${label}: ${r.ok ? 'arrival unobserved' : `${r.reason} ${r.detail}`}`);
    };

    // Where the bot stands decides the travel: quest-sweep stages it at Kangai Mau in Brimhaven; a direct run may start
    // anywhere on the mainland, where a started quest goes straight to the Ardougne depot.
    const p0 = q.pos(), karamja = onKaramja({ x: p0?.worldX ?? 0, z: p0?.worldZ ?? 0 });
    let travel = totemTravel({ karamja, started: !totemStartsAtKangai(flag('Tribal Totem')), plagueCity: flag('Plague City'), magic: q.s.sdk.getSkill('Magic')?.level ?? 1, law: q.cnt(563), water: q.cnt(555), coins: q.cnt(995) });
    console.log(`NOTE tribal totem ${karamja ? 'on karamja' : 'on the mainland'}, to ardougne by ${travel.how}`);
    if (travel.how === 'missing') await q.fail(travel.detail);
    if (travel.how === 'sail-to-kangai') { await sail('barnaby to brimhaven', BARNABY_BRIMHAVEN); travel = { how: 'boat' }; }

    // 1. Kangai Mau: "I'm in search of adventure!", "Ok, I will get it back." sets 1.
    if (totemStartsAtKangai(flag('Tribal Totem'))) {
        await q.talk('kangai 1', /^kangai mau$/i, [/in search of adventure/i, /ok, i will get it back/i], () => q.sawText(/best of luck with that/i) || q.sawText(/have you got our totem back/i), KANGAI, 60);
    }
    q.milestone(1);

    // 2. To Ardougne: the teleport when the account can cast it, the customs officer's boat from Brimhaven (30 coins,
    // lands on the Ardougne dock), or a walk from the mainland; the RPDT depot: the label from the horn crate onto the
    // teleport crate (2), the employee (3).
    if (travel.how === 'teleport') await q.teleport('ardougne teleport', 'magic:ardougne_teleport', 2661, 3301);
    else if (travel.how === 'boat') await sail('customs officer to ardougne', CUSTOMS_OFFICER_ARDOUGNE);
    // The label and the totem each need a free slot: a full pack drops them under the bot (InvOps INV_ADD overflow). Bank
    // the surplus first at the nearest bank (the Ardougne south bank from the depot), then take anything already dropped.
    const surplus = () => surplusForSlots(q.inv().filter((i: any) => i.count > 0).map((i: any) => ({ id: i.id, count: i.count })), 2, new Set([ITEM.label, ITEM.totem]));
    await q.waitUntil(() => q.inv().length > 0, 10);
    console.log(`NOTE tribal totem pack ${q.inv().length} of 28 slots, banking ${surplus().length} for the label and totem`);
    if (surplus().length) {
        const bank = nearestBankTile({ x: q.pos()?.worldX ?? 0, z: q.pos()?.worldZ ?? 0 }, Object.values((travelData as unknown as { banks: Record<string, { x: number; z: number; level: number }> }).banks));
        await q.walk('to bank for slots', [{ x: bank.x, z: bank.z, tol: 3 }]);
        const opened: any = await q.s.bot.openBank();
        if (!opened?.success) await q.fail('bank for slots did not open');
        for (const d of surplus()) { const item = q.inv().find((i: any) => i.id === d.id); if (item) await q.s.bot.depositItem(item, d.count); await q.waitTicks(1); }
        await q.s.bot.closeBank();
        console.log(`NOTE tribal totem freed slots: ${28 - q.inv().length} free`);
        if (surplus().length) await q.fail(`pack full: ${q.inv().length} of 28 slots after banking`);
    }
    const dropped = (id: number): any => { const g = (q.st()?.groundItems ?? []).filter((g: any) => g.id === id && g.distance <= 1).sort((a: any, b: any) => a.distance - b.distance)[0]; if (g) console.log(`NOTE tribal totem picks up dropped ${id}`); return g; };
    await q.walk('to depot', [{ x: 2649, z: 3272, tol: 1 }]);
    await q.step('take label', () => { const g = dropped(ITEM.label); return g ? q.s.bot.pickupItem(g) : q.opLoc(q.locAt(HORNCRATE.x, HORNCRATE.z) ?? HORNCRATE, 2); }, () => q.has(ITEM.label), 10, 4);
    await q.converse([], () => !q.dialogOpen(), 6);
    // Past stage 2 the crate keeps its new label and answers "already replaced" (quest_totem.rs2 oplocu,teleportcrate).
    const marked = () => !q.has(ITEM.label) || q.msgCount(/already replaced the delivery address label/i) > 0;
    await q.step('label on crate', () => q.useOnLoc(ITEM.label, q.locAt(TELECRATE.x, TELECRATE.z) ?? TELECRATE), marked, 10, 4);
    await q.converse([], () => !q.dialogOpen(), 8);
    q.milestone(2);
    // Past stage 2 the employee has no delivery option and only thanks the bot (rdpt_employee.rs2).
    await q.talk('rpdt', /^rpdt employee$/i, [/when are you going to deliver this crate/i], () => q.sawText(/we could do it now/i) || q.sawText(/thank you very much/i), RPDT, 40);
    q.milestone(3);

    // 3. Wizard Cromperty: "So what have you invented?", "Can I be teleported please?", "Yes, that sounds good."
    await q.walk('to cromperty', [{ x: CROMPERTY.x, z: CROMPERTY.z - 1, tol: 2 }]);
    await q.talk('cromperty', /^wizard cromperty$/i, [/so what have you invented/i, /can i be teleported please/i, /yes, that sounds good/i],
        () => q.sawText(/okey dokey/i) || q.near(ARRIVE.x, ARRIVE.z, 2), CROMPERTY, 60);
    // The teleport closes the dialog and runs p_delay(4) (wizard_cromperty.rs2:66-81); a talk retry in it found no NPC.
    await q.waitUntil(() => q.near(ARRIVE.x, ARRIVE.z, 2), 12);
    if (!q.near(ARRIVE.x, ARRIVE.z, 2)) await q.fail('cromperty teleport');
    q.milestone(4);

    // 4. The mansion: the crate room door (loc_1533 2636,3323), the combination lock: K U R T from A A A A
    // (lock 1 +10 with com_48; locks 2-4 -6 / -9 / -7 with com_49 / com_51 / com_53; enter com_57).
    await q.openDoor('crate room door', 2636, 3323);
    await q.dash('to combo door', 2635, 3323, 0);
    const comboOk = () => q.msgCount(/combination seems correct/i) > 0;
    for (let k = 0; k < 3 && !comboOk(); k++) {
        await q.guard('combo');
        await q.opLoc(q.locAt(COMBO.x, COMBO.z) ?? COMBO, 1);   // opens tribal_door2 with the locks at A (:115-120)
        await q.waitTicks(3);
        for (const [b, n] of [[48, 10], [49, 6], [51, 9], [53, 7]] as const) for (let i = 0; i < n; i++) { await btn(b); await q.waitTicks(1); }
        await btn(57);
        await q.waitUntil(() => comboOk() || q.msgCount(/combination is incorrect/i) > k, 4);
    }
    if (!comboOk()) await q.fail('combination');
    q.milestone('combo');
    await q.step('through combo door', () => q.opLoc(q.locAt(COMBO.x, COMBO.z) ?? COMBO, 1), () => (q.pos()?.worldX ?? 9999) <= 2633 || !q.shutAt(COMBO.x, COMBO.z), 8, 4);

    // 5. Search the stairs (Thieving 21) marks the trap; then climb to level 1 and take the totem from the chest.
    await q.step('search stairs', () => q.opLoc(q.locAt(STAIRS.x, STAIRS.z) ?? STAIRS, 2), () => q.sawText(/trained senses as a thief/i), 12, 4);
    await q.converse([], () => !q.dialogOpen(), 8);
    await q.step('climb stairs', () => q.opLoc(q.locAt(STAIRS.x, STAIRS.z) ?? STAIRS, 1), () => lv() === 1, 12, 4);
    await q.walk('to chest', [{ x: CHEST.x - 1, z: CHEST.z, tol: 1 }]);
    const chest = () => q.findLoc(l => l.x === CHEST.x && l.z === CHEST.z);
    await q.step('open chest', () => { const c = chest(); return c ? q.opLoc(c, 1) : q.waitTicks(1); }, () => q.has(ITEM.totem) || /open/i.test(String(chest()?.name ?? '')) || (chest()?.optionsWithIndex ?? []).some((o: any) => /search|close/i.test(o.text)), 8, 4);
    await q.step('take totem', () => { const g = dropped(ITEM.totem); if (g) return q.s.bot.pickupItem(g); const c = chest(); return c ? q.opLoc(c, 1) : q.waitTicks(1); }, () => q.has(ITEM.totem), 8, 5);
    await q.converse([], () => !q.dialogOpen(), 6);
    q.milestone('totem');

    // 6. Out: the stairs down, the totem door opens from inside (quest_totem.rs2:1-6); Captain Barnaby to Brimhaven.
    await q.walk('to stairs top', [{ x: STAIRSTOP.x, z: STAIRSTOP.z - 1, tol: 1 }]);
    await q.step('stairs down', () => q.opLoc(q.locAt(STAIRSTOP.x, STAIRSTOP.z) ?? STAIRSTOP, 1), () => lv() === 0, 10, 4);
    await q.step('combo door out', () => q.opLoc(q.locAt(COMBO.x, COMBO.z) ?? COMBO, 1), () => !q.shutAt(COMBO.x, COMBO.z) || (q.pos()?.worldX ?? 0) >= 2634, 8, 4);
    await q.dash('hall', 2635, 3322, 0);
    await q.openDoor('totem door', 2635, 3321);
    await q.walk('to barnaby', [{ x: BARNABY.x, z: BARNABY.z, tol: 3 }]);
    await q.talk('barnaby', /^captain barnaby$/i, [/^yes please/i], () => lv() === 1 && q.near(BRIM_DECK.x, BRIM_DECK.z, 8), BARNABY, 40, true);
    for (let i = 0; i < 6 && lv() !== 0; i++) {
        await q.guard('disembark');
        if (q.dialogOpen()) { await q.converse([], () => !q.dialogOpen(), 4); continue; }
        const plank = q.findLoc(l => /^gangplank$/i.test(l.name));
        if (!plank) { await q.waitTicks(2); continue; }
        await q.opLoc(plank, q.opIndex(plank, /cross/i));
        await q.waitUntil(() => lv() === 0, 10);
    }
    if (lv() !== 0) await q.fail('disembark');

    // 7. Kangai Mau takes the totem.
    await q.walk('to kangai', [{ x: KANGAI.x, z: KANGAI.z, tol: 3 }]);
    await q.talk('kangai 2', /^kangai mau$/i, [], () => questDone || !q.has(ITEM.totem), KANGAI, 40);
    await q.waitUntil(() => questDone, 10);
    q.milestone(100);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
