// Tai Bwo Wannai Trio from preset quest_tbwt (at Timfraku's ladder, Tai Bwo Wannai; every skill 99; Jungle Potion done;
// the tradeable kit from a helper). Reward: 2 QP, 2,000 coins (quests/quest_tbwt/scripts/quest_tbwt.rs2:265-269).
// Route, stage signals and dialogue answers are adapted from rs-stun-toolkit `q-tai-bwo-wannai-trio.ts` (MIT,
// research/stun-toolkit-LICENSE.txt), which passed 3 of 3 seeded chaos runs in their lockstep sim (1468-1509 ticks).
// %tbwt_main (varp 320) 3 started, 4 all brothers; brother completion is checked only inside the Tiadeche, Tamayu and
// Tinsay "complete" labels (quest_tbwt.rs2:35-40), so the last of those three finishes after Lubufu. Our SDK reads no
// varps, so every step gates on items, position and dialogue text.
//  - Timfraku (level 1 of his hut, ladder 1747 at 2782,3087): "Trufitus sent me." needs Jungle Potion (tbwt_timfraku.rs2:51).
//  - Tamayu: the vow, then a watched hunt (a cutscene off the map, z > 4000); only then he takes the agility potion and a
//    karambwan-poisoned spear (tbwt_tamayu.rs2:58-132); the killing hunt; he skins a monkey corpse (:32-57).
//  - Kp spear: raw karambwan on a fire comes out poorly cooked before the final reward (cooking.rs2:36-50), the pestle
//    makes poisonous paste, the paste goes on the iron spear (weapon_poison.rs2:10-13).
//  - Monkey corpse: a monkey killed after the start drops one; it dodges melee (monkey.rs2:97-170), so Fire Strike.
//  - Tiadeche (2905,3115) lives north of the Karamja stepping stones (2925,2948-2950): the loaded vessel, "No", and he
//    asks for a manual (tbwt_tiadeche.rs2:65-164); later the manual from Tinsay completes him.
//  - Lubufu (2770,3169): two talks, 20 raw karambwanji (small net, Holy Lake), three questions, apprentice
//    (tbwt_lubufu.rs2:148-368).
//  - Tinsay (2765,2977, Cairn Isle over the climbing rocks): banana rum, the seaweed sandwich, the marinated burnt jogre
//    bones, then the vessel for the manual (tbwt_tinsay.rs2). Burnt jogre bones: Superheat Item on jogre bones
//    (tbwt_jogre_bones.rs2:13-23); karambwanji paste on them, then the fire (cooking 30).
//  - Karamja rum is untradeable and sold by Zambo (karamja.inv:10). The glory rubs to Karamja 2918,3176
//    (amulet_of_glory.rs2, 0_45_49_38_40).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = {
    rawK: 3142, poorK: 3146, burntK: 3148, pPaste: 3153, pestle: 233, spear: 1239, kpSpear: 3171, agility: 3032, net: 303,
    jogre: 3125, burntJogre: 3127, jogrePaste: 3128, marinade: 3130, kji: 3150, kjiPaste: 3155, shrimp: 317,
    corpse: 3166, skin: 3167, seaweed: 401, sandwich: 3168, banana: 3162, rum: 431, bananaRum: 3164,
    loaded: 3159, vessel: 3157, manual: 3161, coins: 995, mind: 558, fire: 554, air: 556, nature: 561,
};
const GLORY = [1712, 1710, 1708, 1706];
const LADDER = { id: 1747, x: 2782, z: 3087 };
const LADDER_TOP = { id: 1746, x: 2782, z: 3087 };
const FIRE = { id: 2732, x: 2789, z: 3048 };
const T = {
    ladder: { x: 2782, z: 3086 }, fire: { x: 2789, z: 3047 }, monkeys: { x: 2833, z: 3030 }, tamayu: { x: 2844, z: 3042 },
    lake: { x: 2797, z: 3012 }, tiadeche: { x: 2905, z: 3115 }, zambo: { x: 2925, z: 3143 }, lubufu: { x: 2770, z: 3170 },
    tinsay: { x: 2765, z: 2977 },
};
const CLIMB = { id: 2231, x: 2794, z: 2979 };            // zqclimbingrocks (quest_zombiequeen.rs2:519-559)
const FIRE_STRIKE = componentId('magic:fire_strike');
const SUPERHEAT = componentId('magic:superheat_item');

const q = await openQuest({ cap: 4000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the.*tai bwo wannai/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    // Dialogue text with a mark: quest-lib sawText keeps every page, so a later step would match an earlier page.
    const texts: string[] = [];
    let lastText = '';
    q.s.onTick(() => {
        const d: any = q.s.sdk.getDialog();
        const t = d?.isOpen ? [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' ') : '';
        if (t && t !== lastText) { texts.push(t); lastText = t; }
        for (const m of (q.st()?.gameMessages ?? []).slice(-3)) { const k = `#${m.tick}:${m.text}`; if (!texts.includes(k)) texts.push(k); }
    });
    const mark = () => texts.length;
    const seen = (re: RegExp, m: number) => texts.slice(m).some(t => re.test(t)) || re.test(lastText);
    const glory = () => q.inv().find((i: any) => GLORY.includes(i.id));
    const drop = async (label: string, keep: Set<number>) => {
        for (let i = 0; i < 40; i++) {
            const it = q.inv().find((e: any) => !keep.has(e.id));
            if (!it) return;
            await q.guard(label);
            await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (q.inv().some((e: any) => !keep.has(e.id))) console.log(`WARN drop ${label}`);
    };
    const dropIds = (label: string, ids: number[]) => drop(label, new Set(q.inv().map((e: any) => e.id).filter((id: number) => !ids.includes(id))));
    // Use an item on an npc, then answer its dialogue until ok().
    const give = async (label: string, item: number, re: RegExp, at: { x: number; z: number }, pats: RegExp[], ok: () => boolean, ticks = 60) => {
        if (!q.npc(re)) await q.walk(`${label} approach`, [{ ...at, tol: 4 }]);
        for (let i = 0; i < 4 && !ok(); i++) {
            await q.guard(label);
            if (i > 0) q.stats.retries++;
            if (!q.dialogOpen() && q.has(item)) {
                const n = q.npc(re);
                if (n) await q.useOnNpc(item, n);
                await q.waitUntil(() => q.dialogOpen() || ok(), 20);
            }
            await q.converse(pats, () => ok() && !q.dialogOpen(), ticks);
        }
        if (!ok()) await q.fail(`give ${label}`);
    };
    const gloryKaramja = async (label: string) => {
        const g = glory();
        if (!g) await q.fail(`${label}: no glory`);
        const op = (g.optionsWithIndex ?? []).find((o: any) => /rub/i.test(o.text))?.opIndex ?? 4;
        const x0 = x(), z0 = z();
        await q.step(label, async () => {
            const h = glory();
            if (h) await q.s.direct({ type: 'useInventoryItem', slot: h.slot, optionIndex: op, reason: 'SDK' });
            await q.converse([/^karamja/i], () => Math.max(Math.abs(x() - x0), Math.abs(z() - z0)) > 8, 8);
        }, () => Math.max(Math.abs(x() - x0), Math.abs(z() - z0)) > 8 && q.near(2918, 3176, 6), 10, 3);
    };
    // Stepping stones south bank (2925,2947) -> north bank (z >= 2951), one stone per Cross (shortcuts.rs2:228-271).
    const stonesNorth = async () => {
        const across = () => z() >= 2951 && z() <= 2960 && x() >= 2918 && x() <= 2936;
        // Already in Tiadeche's part: within 40 tiles of him and north of the river (the Holy Lake is north too, but not his part).
        if (across() || (q.cheb(T.tiadeche.x, T.tiadeche.z) <= 40 && z() > 2960)) return;
        await q.walk('to stones', [{ x: 2925, z: 2947, tol: 0 }]);
        for (let i = 0; i < 16 && !across(); i++) {
            await q.guard('stones');
            if (x() !== 2925 || z() < 2947) {
                await q.waitTicks(8);
                if (across()) break;
                await q.walk('stones bank', [{ x: 2925, z: 2947, tol: 0 }]);
                continue;
            }
            const nz = z() + 1;
            const st = q.findLoc((l: any) => l.id >= 2333 && l.id <= 2335 && l.x === 2925 && l.z === nz);
            const z0 = z();
            if (st) await q.opLoc(st, 1);
            else await q.s.direct({ type: 'walkTo', x: 2925, z: nz, running: false, reason: 'SDK' });
            await q.waitUntil(() => z() !== z0 && !q.pos()?.isMoving, 8);
            await q.waitTicks(1);
        }
        if (!across()) await q.fail('stones');
    };
    // Cairn Isle: the climbing rocks from the east, the log bridge west (an Agility roll can drop the bot on the shore).
    // On Cairn Isle: set by the climb west, cleared by the climb back or a fall off the log bridge (the fall washes the
    // bot onto the main shore). Position alone does not tell: the mainland at 2781,2982 and the fire (2789,3047) are
    // west of the rocks too.
    let cairn = false;
    q.s.onTick(() => { if ((q.st()?.gameMessages ?? []).some((m: any) => m.tick === q.s.tick() && /you fall|fall and hurt/i.test(m.text))) cairn = false; });
    const onCairn = () => cairn;
    const toCairn = async (to: { x: number; z: number }) => {
        for (let k = 0; k < 4 && !q.near(to.x, to.z, 2); k++) {
            if (!onCairn()) {
                await q.walk('to cairn rocks', [{ x: CLIMB.x + 2, z: CLIMB.z, tol: 0 }]);
                for (let i = 0; i < 8 && x() > 2791; i++) {
                    await q.guard('cairn climb');
                    const lx = x() > 2794 ? 2794 : 2792;
                    const r = q.findLoc((l: any) => l.id === CLIMB.id && l.x === lx) ?? { id: CLIMB.id, x: lx, z: CLIMB.z };
                    await q.opLoc(r, 1);
                    await q.waitUntil(() => x() <= lx - 1, 12);
                    await q.waitTicks(1);
                }
                if (x() > 2791) await q.fail('cairn climb');
                cairn = true;
            }
            await q.walk('cairn bridge', [{ x: 2770, z: 2979, tol: 1 }, { ...to, tol: 2 }]);
        }
        if (!q.near(to.x, to.z, 2)) await q.fail('cairn walk');
    };
    const fromCairn = async () => {
        if (!onCairn()) return;
        await q.walk('cairn bridge back', [{ x: 2770, z: 2979, tol: 1 }, { x: 2791, z: 2979, tol: 0 }]);
        for (let i = 0; i < 6 && x() < 2795; i++) {
            await q.guard('cairn climb back');
            if (x() !== 2791 || z() !== 2979) await q.walk('cairn rocks west', [{ x: 2791, z: 2979, tol: 0 }]);
            const r = q.findLoc((l: any) => l.id === CLIMB.id && l.x === 2792 && l.z === 2979) ?? { id: CLIMB.id, x: 2792, z: 2979 };
            await q.opLoc(r, 1);
            await q.waitUntil(() => x() >= 2795, 12);
            await q.waitTicks(1);
        }
        if (x() < 2795) await q.fail('cairn climb back');
        cairn = false;
    };
    const timfraku = async (label: string, pats: RegExp[], ok: () => boolean) => {
        if (q.lvl() !== 1) {
            await q.walk(`${label} ladder`, [{ ...T.ladder, tol: 1 }]);
            await q.climb(`${label} up`, () => q.locAt(LADDER.x, LADDER.z) ?? LADDER, /climb-up/i, () => q.lvl() === 1);
        }
        await q.talk(label, /^timfraku$/i, pats, ok, T.ladder, 80);
    };

    // 0. Pack: the karambwanji later need 21 free slots, so only the kit stays.
    // 1. Timfraku: roving adventurer -> "Trufitus sent me." -> gratitude -> Yes sets %tbwt_main 3 (tbwt_timfraku.rs2:128-136).
    let m = mark();
    await timfraku('timfraku start', [/roving adventurer/i, /trufitus sent me/i, /your gratitude is all/i, /^yes$/i],
        () => seen(/we shall see, bwana/i, m) && !q.dialogOpen());
    await q.climb('ladder down', () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down/i, () => q.lvl() === 0);
    q.milestone(3);

    // 2. Village fire: a poorly cooked karambwan, poisonous paste, the kp spear; Superheat Item on the jogre bones.
    await q.walk('to fire', [{ ...T.fire, tol: 2 }]);
    for (let i = 0; i < 6 && !q.has(ITEM.poorK) && !q.has(ITEM.pPaste) && !q.has(ITEM.kpSpear); i++) {
        if (!q.has(ITEM.rawK)) await q.fail('every raw karambwan burnt');
        const r0 = q.cnt(ITEM.rawK);
        await q.step('cook karambwan', () => q.useOnLoc(ITEM.rawK, q.locAt(FIRE.x, FIRE.z) ?? FIRE), () => q.cnt(ITEM.rawK) < r0, 12, 4);
        await q.waitUntil(() => q.has(ITEM.poorK) || q.has(ITEM.burntK), 6);
        await q.converse([], () => !q.dialogOpen(), 4);
    }
    if (!q.has(ITEM.kpSpear)) {
        if (!q.has(ITEM.pPaste)) await q.step('poison paste', () => q.useOnItem(ITEM.poorK, ITEM.pestle), () => q.has(ITEM.pPaste), 6, 3);
        await q.step('kp spear', () => q.useOnItem(ITEM.pPaste, ITEM.spear), () => q.has(ITEM.kpSpear), 6, 3);
    }
    await q.step('superheat jogre bones', () => q.s.direct({ type: 'spellOnItem', slot: q.slot(ITEM.jogre)!, spellComponent: SUPERHEAT, reason: 'SDK' }),
        () => q.has(ITEM.burntJogre), 6, 4);
    q.milestone('kit');

    // 3. A monkey corpse with Fire Strike: one locked target; 3 casts with no Magic XP = no line of sight, next monkey.
    await q.walk('to monkeys', [{ ...T.monkeys, tol: 4 }]);
    {
        const skip = new Set<number>();
        let target = -1, tCasts = 0, tXp = q.xp('Magic'), last = -100;
        for (let t = 0; t < 250 && !q.has(ITEM.corpse); t++) {
            await q.guard('monkey');
            const g = (q.st()?.groundItems ?? []).find((i: any) => i.id === ITEM.corpse && i.distance <= 12);
            if (g) { await q.step('take corpse', () => q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: ITEM.corpse, reason: 'SDK' }), () => q.has(ITEM.corpse), 12, 3); break; }
            if (!q.has(ITEM.mind) && q.T() - last >= 8) await q.fail('monkey: out of mind runes');
            const all = (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === 132);
            let n = all.find((k: any) => k.index === target);
            if (!n && target >= 0) { target = -1; await q.waitTicks(2); continue; }
            if (!n) { n = all.filter((k: any) => k.distance <= 10 && !skip.has(k.index)).sort((a: any, b: any) => a.distance - b.distance)[0]; if (n) { target = n.index; tCasts = 0; tXp = q.xp('Magic'); } }
            if (!n) { if (skip.size) skip.clear(); await q.waitTicks(2); continue; }
            if (tCasts >= 3 && q.xp('Magic') === tXp) { console.log(`NOTE monkey ${target}: ${tCasts} casts, no xp`); skip.add(target); target = -1; continue; }
            if (q.T() - last >= 5) { last = q.T(); tCasts++; await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: FIRE_STRIKE, reason: 'SDK' }); }
            await q.waitTicks(1);
        }
        if (!q.has(ITEM.corpse)) await q.fail('no monkey corpse');
    }
    q.milestone('corpse');

    // 4. Tamayu: the vow, the watched hunt (cutscene), the potion, the kp spear, the killing hunt, then the skin.
    const tam = /^tamayu$/i;
    m = mark();
    await q.talk('tamayu 1', tam, [], () => seen(/pitiful whining tires me|tell me more of the shaikahan/i, m) && !q.dialogOpen(), T.tamayu, 40);
    let away = false;
    m = mark();
    await q.talk('tamayu 2', tam, [/when will you succeed/i, /^yes$/i], () => { if (z() > 4000) away = true; return away && z() < 4000 && seen(/healing too quickly|extremely sick|quite sick/i, m) && !q.dialogOpen(); }, T.tamayu, 120);
    q.milestone('hunt watched');
    m = mark();
    await give('tamayu potion', ITEM.agility, tam, T.tamayu, [], () => !q.has(ITEM.agility) && seen(/not sure whether i can match|agile enough to finally match/i, m), 40);
    await give('tamayu spear', ITEM.kpSpear, tam, T.tamayu, [], () => !q.has(ITEM.kpSpear), 30);
    away = false;
    await q.talk('tamayu 3', tam, [/take me on your next hunt/i], () => { if (z() > 4000) away = true; return away && z() < 4000 && !q.dialogOpen(); }, T.tamayu, 120);
    q.milestone('tamayu');
    await give('tamayu skin', ITEM.corpse, tam, T.tamayu, [], () => q.has(ITEM.skin), 30);
    await q.step('sandwich', () => q.useOnItem(ITEM.skin, ITEM.seaweed), () => q.has(ITEM.sandwich), 6, 3);

    // 5. Holy Lake: 21 karambwanji (one becomes paste on the burnt bones at once, so the pack holds the other 20).
    await q.walk('to holy lake', [{ ...T.lake, tol: 3 }]);
    await drop('before fishing', new Set([ITEM.net, ITEM.pestle, ITEM.kji, ITEM.kjiPaste, ITEM.burntJogre, ITEM.jogrePaste, ITEM.sandwich, ITEM.banana,
        ITEM.loaded, ITEM.coins, ...GLORY]));
    {
        const pasted = () => q.has(ITEM.jogrePaste);
        let lastSend = -100, lastCount = 0, lastGain = q.T();
        while (q.cnt(ITEM.kji) < 20 + (pasted() ? 0 : 1)) {
            await q.guard('karambwanji');
            if (q.T() > 3500) await q.fail(`karambwanji ${q.cnt(ITEM.kji)}`);
            if (q.has(ITEM.shrimp)) await dropIds('shrimp', [ITEM.shrimp]);
            if (q.has(ITEM.kji) && !pasted()) {
                if (!q.has(ITEM.kjiPaste)) await q.step('kji paste', () => q.useOnItem(ITEM.kji, ITEM.pestle), () => q.has(ITEM.kjiPaste), 6, 3);
                await q.step('paste on bones', () => q.useOnItem(ITEM.kjiPaste, ITEM.burntJogre), () => q.has(ITEM.jogrePaste), 6, 3);
                await dropIds('pestle', [ITEM.pestle]);
                lastSend = -100;
                continue;
            }
            if (q.cnt(ITEM.kji) > lastCount) { lastCount = q.cnt(ITEM.kji); lastGain = q.T(); }
            if (q.T() - lastSend >= 30 || (q.T() - lastGain >= 8 && q.T() - lastSend >= 8)) {
                const sp = (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === 1174 && n.distance <= 14).sort((a: any, b: any) => a.distance - b.distance)[0];
                if (sp) { lastSend = q.T(); await q.s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: 1, reason: 'SDK' }); }
            }
            await q.waitTicks(1);
        }
        await dropIds('net', [ITEM.net, ITEM.shrimp, ITEM.pestle]);
    }
    q.milestone('karambwanji');

    // 6. Tiadeche (north of the stepping stones): the intro, the loaded vessel, "No" -> he asks for a manual.
    const tia = /^tiadeche$/i;
    await stonesNorth();
    await q.walk('to tiadeche', [{ ...T.tiadeche, tol: 3 }]);
    m = mark();
    // The intro ends on a 4-way menu (tbwt_tiadeche.rs2:113-126); every answer is a dead end that closes the dialogue.
    await q.talk('tiadeche 1', tia, [/what is a karambwan/i], () => seen(/return only when i have caught a karambwan/i, m) && !q.dialogOpen(), T.tiadeche, 40);
    m = mark();
    await give('tiadeche vessel', ITEM.loaded, tia, T.tiadeche, [/^no$/i], () => !q.has(ITEM.loaded) && seen(/never mind/i, m), 80);
    q.milestone('tiadeche asks');

    // 7. Glory to Karamja; Zambo's rum with the sliced banana in it.
    await gloryKaramja('glory 1');
    await q.walk('to zambo', [{ x: T.zambo.x + 1, z: T.zambo.z, tol: 2 }]);
    for (let i = 0; i < 3 && !q.has(ITEM.rum); i++) {
        await q.guard('rum');
        const o = await q.s.bot.openShop(/^zambo$/i);
        if (!o.success) { console.log(`WARN openShop ${o.message}`); await q.waitTicks(2); continue; }
        const b = await q.s.bot.buyFromShop(/karamjan? rum/i, 1);
        if (!b.success) console.log(`WARN buy rum ${b.message}`);
    }
    await q.s.bot.closeShop();
    if (!q.has(ITEM.rum)) await q.fail('no rum');
    await q.step('banana rum', () => q.useOnItem(ITEM.rum, ITEM.banana), () => q.has(ITEM.bananaRum), 6, 3);
    q.milestone('rum');

    // 8. Lubufu: two talks (the second asks for 20 karambwanji), the hand-over, three questions, the apprenticeship.
    const lub = /^lubufu$/i;
    m = mark();
    await q.talk('lubufu 1', lub, [/i wasn't going anywhere/i], () => seen(/well then go away from here|now leave/i, m) && !q.dialogOpen(), T.lubufu, 40);
    m = mark();
    await q.talk('lubufu 2', lub, [/^talk about him/i, /^how old are you/i, /i could help collect the bait/i, /you sound like you could do with the help/i],
        () => seen(/return here as soon as you have caught 20 karambwanji/i, m) && !q.dialogOpen(), T.lubufu, 80);
    const k0 = q.cnt(ITEM.kji);
    await q.talk('lubufu karambwanji', lub, [], () => q.cnt(ITEM.kji) <= k0 - 20 && !q.dialogOpen(), T.lubufu, 60);
    for (let n = 0; n < 3 && !q.has(ITEM.vessel); n++) {
        m = mark();
        const ok = n < 2 ? () => seen(/octopus/i, m) && !q.dialogOpen()
            : () => (seen(/practise on my/i, m) || seen(/hands you a karambwan vessel/i, m) || q.has(ITEM.vessel)) && !q.dialogOpen();
        await q.talk(`lubufu q${n + 1}`, lub, [/what do you use to catch karambwan/i, /^yes!?$/i], ok, T.lubufu, 80);
    }
    if (!q.has(ITEM.vessel)) await q.fail('lubufu: no vessel');
    await dropIds('karambwanji', [ITEM.kji]);
    q.milestone('lubufu');

    // 9. Village fire: marinate the pasted burnt bones.
    await q.walk('to fire 2', [{ ...T.fire, tol: 2 }]);
    await q.step('marinate', () => q.useOnLoc(ITEM.jogrePaste, q.locAt(FIRE.x, FIRE.z) ?? FIRE), () => q.has(ITEM.marinade), 12, 4);
    await q.converse([], () => !q.dialogOpen(), 4);

    // 10. Tinsay: the intro, banana rum, the sandwich, the bones (his part done), then the vessel for the manual.
    const tin = /^tinsay$/i;
    await toCairn(T.tinsay);
    m = mark();
    await q.talk('tinsay intro', tin, [], () => seen(/i need banana in karamjan rum/i, m) && !q.dialogOpen(), T.tinsay, 60);
    m = mark();
    await give('tinsay rum', ITEM.bananaRum, tin, T.tinsay, [], () => !q.has(ITEM.bananaRum) && seen(/seaweed in monkey skin sandwich/i, m), 60);
    m = mark();
    await give('tinsay sandwich', ITEM.sandwich, tin, T.tinsay, [], () => !q.has(ITEM.sandwich) && seen(/marinated in karambwanji/i, m), 80);
    m = mark();
    await give('tinsay bones', ITEM.marinade, tin, T.tinsay, [], () => !q.has(ITEM.marinade) && seen(/meet you in the village once you have helped/i, m), 60);
    await give('tinsay manual', ITEM.vessel, tin, T.tinsay, [], () => q.has(ITEM.manual), 40);
    q.milestone('tinsay');
    await fromCairn();

    // 11. Tiadeche: the manual completes the last brother (%tbwt_main 4).
    await stonesNorth();
    await q.walk('to tiadeche 2', [{ ...T.tiadeche, tol: 3 }]);
    m = mark();
    await give('tiadeche manual', ITEM.manual, tia, T.tiadeche, [], () => !q.has(ITEM.manual) && seen(/meet you in the village once you have helped/i, m), 60);
    q.milestone(4);

    // 12. Glory to Karamja, Timfraku: the reward.
    await gloryKaramja('glory 2');
    await timfraku('timfraku reward', [/oh it was nothing really/i], () => questDone);
    off();
    await q.end(questDone, `qp=2`);
} catch (e) {
    await q.fail(`error ${(e as Error).message}`);
}
