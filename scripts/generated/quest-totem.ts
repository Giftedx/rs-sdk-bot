// Tribal Totem from preset quest_totem (beside Kangai Mau, Brimhaven; every skill 99, Thieving 21+ for the stairs trap;
// Plague City done for Ardougne Teleport). Reward: 1 QP, 1,775 Thieving XP before 25x, 5 swordfish
// (quest_totem/scripts/quest_totem.rs2:211-217).
// Varp %totemquest (200): 1 Kangai Mau (kangai_mau.rs2:50-54); the horn crate's label (quest_totem.rs2:8-16) on the
// teleport crate in the RPDT depot sets 2 (:18-31); the RPDT employee "So, when are you going to deliver this crate?"
// 3 (rdpt_employee.rs2:3-8); Wizard Cromperty's teleport lands in Handelmort's mansion and sets 4
// (wizard_cromperty.rs2:66-81); the combination KURT (quest_totem.rs2:35-47), the stairs trap found with Search
// (:142-154), the chest on level 1 (:156-170); Kangai Mau takes the totem and queues completion (kangai_mau.rs2:66-74).
import { openQuest, teleportRefusal } from './quest-lib';
import { BARNABY_BRIMHAVEN, onKaramja, totemTravel } from '../tribal-totem-route';
import { questFlags } from '../../packages/core/src/quest-status';
import { loadTravel } from '../../packages/core/src/travel';
import { walkRoute } from '../../packages/core/src/walk';
import { componentId } from '../../packages/core/src/logout';
import { surplusForSlots } from '../tribal-totem-route';
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
const ITEM = { label: 1858, totem: 1857 };

// Stage text comes from totem_journal.rs2; the quest list alone cannot distinguish stages 1-4.
export function totemJournalStage(body: string): number | undefined {
    const text = body.replace(/@[a-z0-9]+@/gi, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (/QUEST COMPLETE!/i.test(text)) return 5;
    if (/teleported myself inside/i.test(text)) return 4;
    if (/I should get Wizard Cromperty to teleport me inside now/i.test(text)) return 3;
    if (/to deliver the crate now/i.test(text)) return 2;
    if (/I need to get into Lord Handelmorts Mansion/i.test(text)) return 1;
    if (/I can start this quest by speaking to Kangai Mau/i.test(text)) return 0;
    return undefined;
}

type Quest = Awaited<ReturnType<typeof openQuest>>;
export async function readTotemStage(q: Pick<Quest, 's' | 'waitUntil'>): Promise<number> {
    const c = q.s.client as any;
    const close = async () => {
        if (c.mainModalId !== -1) await q.s.direct({type:'closeModal',reason:'SDK'});
        if (!await q.waitUntil(() => c.mainModalId === -1, 5)) throw Error('Totem journal close unobserved');
    };
    if (q.s.sdk.getDialog()?.isOpen) throw Error('Totem journal blocked by dialogue');
    await close();
    await q.s.direct({type:'clickComponent',componentId:componentId('questlist:totem'),reason:'SDK'});
    const body = () => Array.from({length:50}, (_,i) => c.ifType(8145+i+(i>0?1:0))?.text ?? '').join(' ');
    let stage: number | undefined;
    const seen = await q.waitUntil(() => {
        if (c.mainModalId !== 8134 || !/Tribal Totem/i.test(c.ifType(8144)?.text ?? '')) return false;
        stage = totemJournalStage(body()); return stage !== undefined;
    }, 10);
    await close();
    if (!seen || stage === undefined) throw Error('Tribal Totem stage unobserved within deadline');
    console.log('TOTEM_STAGE '+JSON.stringify({stage}));
    return stage;
}

// A refused teleport needs a boat, not a ground path across the sea.
export async function totemBoat(q: Pick<Quest,'s'|'walk'|'guard'|'cnt'|'lvl'|'near'>, id: string, route = walkRoute) {
    const t = loadTravel().find(t => t.id === id);
    if (!t?.from) throw Error('Totem boat unavailable: '+id);
    if (q.cnt(995) < t.coins) throw Error('Totem missing fare '+t.coins);
    await q.guard('Totem boat');
    await q.walk('Totem boat approach', [{x:t.from.x,z:t.from.z,tol:2}]);
    if (q.lvl() !== t.from.level || !q.near(t.from.x,t.from.z,8)) throw Error('Totem boat approach unobserved');
    const before = q.cnt(995);
    const r = await route(q.s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
    await q.guard('Totem boat arrival');
    if (!r.ok || q.lvl() !== t.to.level || !q.near(t.to.x,t.to.z,8) || q.cnt(995) !== before-t.coins)
        throw Error('Totem boat arrival/fare unobserved: '+id);
    console.log('TOTEM_BOAT '+JSON.stringify({id,coins:t.coins,before,after:q.cnt(995)}));
}

export async function completeTotem(q: Quest, boat = totemBoat) {
    const state = () => questFlags(q.s.client)?.find(f => f.name === 'Tribal Totem')?.state ?? 'unknown';
    if (!await q.waitUntil(() => state() !== 'unknown' && !!q.pos() && Array.isArray(q.st()?.inventory),20))
        throw Error('Totem entry state unobserved');
    if (state() === 'complete') throw Error('Tribal Totem already complete');
    let stage = await readTotemStage(q);
    if (stage === 5) throw Error('Tribal Totem already complete');
    if ((q.s.sdk.getSkill('Thieving')?.level ?? 0) < 21) throw Error('Totem requires Thieving 21');
    const magic = q.s.sdk.getSkill('Magic')?.level ?? 0, law = q.cnt(563);
    const plagueCity = questFlags(q.s.client)?.find(f => f.name === 'Plague City')?.state ?? 'unknown';
    const position = q.pos();
    if (!position) throw Error('Totem position unobserved');
    const karamja = onKaramja({x:position.worldX, z:position.worldZ});
    const travel = totemTravel({karamja, started:stage>0, plagueCity, magic, law, water:q.cnt(555), coins:q.cnt(995)});
    if (!q.has(ITEM.totem) && travel.how === 'missing') throw Error(travel.detail);
    const xp0 = q.xp('Thieving'), fish0 = q.cnt(373);
    const done = () => state() === 'complete';
    const lv = () => q.lvl();
    const btn = (n: number) => q.s.direct({ type: 'clickComponent', componentId: componentId(`tribal_door2:com_${n}`), reason: 'SDK' });

    // 1. Kangai Mau: "I'm in search of adventure!", "Ok, I will get it back." sets 1.
    if (stage === 0) {
        if (travel.how === 'sail-to-kangai') await boat(q, BARNABY_BRIMHAVEN);
        await q.talk('kangai 1', /^kangai mau$/i, [/in search of adventure/i, /ok, i will get it back/i], () => state() === 'started', KANGAI, 60);
        stage = await readTotemStage(q);
        if (stage !== 1) throw Error('Totem opening stage unobserved');
        q.milestone(1);
    }
    if (!q.has(ITEM.totem)) {

    // 2. Ardougne Teleport; the RPDT depot: the label from the horn crate onto the teleport crate (2), the employee (3).
    if (travel.how === 'boat' || travel.how === 'sail-to-kangai') {
        const refusal = teleportRefusal('magic:ardougne_teleport', magic, law) ?? 'Ardougne teleport requirements not met';
        console.log('TOTEM_TELEPORT_REFUSED '+refusal);
        await boat(q, 'npc:customs_officer:ardougne@2772,3231');
    } else if (travel.how === 'teleport') await q.teleport('ardougne teleport', 'magic:ardougne_teleport', 2661, 3301);
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
    if (stage < 3) {
        await q.walk('to depot', [{ x: 2649, z: 3272, tol: 1 }]);
        if (stage < 2) {
            await q.step('take label', () => { const g = dropped(ITEM.label); return g ? q.s.bot.pickupItem(g) : q.opLoc(q.locAt(HORNCRATE.x, HORNCRATE.z) ?? HORNCRATE, 2); }, () => q.has(ITEM.label), 10, 4);
            await q.converse([], () => !q.dialogOpen(), 6);
            await q.step('label on crate', () => q.useOnLoc(ITEM.label, q.locAt(TELECRATE.x, TELECRATE.z) ?? TELECRATE), () => !q.has(ITEM.label), 10, 4);
            await q.converse([], () => !q.dialogOpen(), 8);
            stage = await readTotemStage(q);
            if (stage !== 2) throw Error('Totem crate marked stage unobserved');
            q.milestone(2);
        }
        await q.talk('rpdt', /^rpdt employee$/i, [/when are you going to deliver this crate/i], () => q.sawText(/we could do it now/i), RPDT, 40);
        stage = await readTotemStage(q);
        if (stage !== 3) throw Error('Totem crate delivery stage unobserved');
        q.milestone(3);
    }

    // 3. Wizard Cromperty: "So what have you invented?", "Can I be teleported please?", "Yes, that sounds good."
    await q.walk('to cromperty', [{ x: CROMPERTY.x, z: CROMPERTY.z - 1, tol: 2 }]);
    await q.talk('cromperty', /^wizard cromperty$/i, [/so what have you invented/i, /can i be teleported please/i, /yes, that sounds good/i],
        () => q.sawText(/okey dokey/i) || q.near(ARRIVE.x, ARRIVE.z, 2), CROMPERTY, 60);
    // The teleport closes the dialog and runs p_delay(4) (wizard_cromperty.rs2:66-81); a talk retry in it found no NPC.
    await q.waitUntil(() => q.near(ARRIVE.x, ARRIVE.z, 2), 12);
    if (!q.near(ARRIVE.x, ARRIVE.z, 2)) await q.fail('cromperty teleport');
    stage = await readTotemStage(q);
    if (stage !== 4) throw Error('Totem mansion stage unobserved');
    q.milestone(4);

    // 4. The mansion: the crate room door (loc_1533 2636,3323), the combination lock: K U R T from A A A A
    // (lock 1 +10 with com_48; locks 2-4 -6 / -9 / -7 with com_49 / com_51 / com_53; enter com_57).
    await q.openDoor('crate room door', 2636, 3323);
    await q.dash('to combo door', 2635, 3323, 0);
    let unlocked = false;
    const comboOk = () => unlocked || q.msgCount(/combination seems correct/i) > 0;
    for (let k = 0; k < 3 && !comboOk(); k++) {
        await q.guard('combo');
        await q.opLoc(q.locAt(COMBO.x, COMBO.z) ?? COMBO, 1);   // opens tribal_door2 with the locks at A (:115-120)
        await q.waitUntil(() => (q.s.client as any).mainModalId === componentId('tribal_door2') || !q.shutAt(COMBO.x, COMBO.z), 8);
        if ((q.s.client as any).mainModalId !== componentId('tribal_door2')) {
            unlocked = !q.shutAt(COMBO.x, COMBO.z);
            if (unlocked) break;
            throw Error('Totem combination interface unobserved');
        }
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
    await boat(q, 'npc:captain_barnaby:brimhaven@2679,3275');
    }

    // 7. Kangai Mau takes the totem.
    await q.walk('to kangai', [{ x: KANGAI.x, z: KANGAI.z, tol: 3 }]);
    await q.talk('kangai 2', /^kangai mau$/i, [], () => done() && !q.has(ITEM.totem), KANGAI, 40);
    await q.waitUntil(done, 10);
    if (!done() || q.has(ITEM.totem) || q.cnt(373) !== fish0+5 || q.xp('Thieving') <= xp0)
        throw Error('Totem completion/rewards unobserved');
    q.milestone(100);
    await q.end(true, 'qp=1 flag=complete totemUsed=true swordfish=5');
}

if (import.meta.main || (globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION) {
    const cap = Number(process.env.CAP ?? 2500);
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('Totem CAP must be a positive integer');
    // Food: sharks, swordfish, lobsters, salmon, trout and cake, whatever the pack holds (an account at Hitpoints 17 fell to 8
    // on the mansion stairs trap with sharks it never ate under the library's lobster-only default).
    const q = await openQuest({cap,food:[385,373,379,329,333,1891,1893,1895]});
    try { await completeTotem(q); } catch (e) { await q.fail(String(e)); }
}
