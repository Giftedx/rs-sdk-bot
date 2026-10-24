// Shades of Mort'ton from preset quest_mortton (Herbi Flax's house in Mort'ton beside the shelf; every skill 99; Priest
// in Peril done; a hammer, a tinderbox, logs, a tarromin, a vial of water, ashes, a helper serum 207, coins).
// Reward: 3 QP, 2,000 Crafting and 2,000 Herblore XP (quests/quest_mortton/scripts/quest_mortton.rs2:136-142).
// Varp %morttonquest (quest_mortton.constant:17-34): 5 the diary read, 10 the serum, 15 Razmire's task, 20-40 the 5
// shades, 45 Razmire takes 2 remains, 47 Ulsquire sees 1, 50 the temple talk, 55 the first repair, 60 the temple at
// 100%, 65 the sacred oil, 70 the pyre logs, 75 the logs on a pyre, 80 the pyre lit, then Ulsquire.
// Server truth: quests/quest_mortton/scripts/*.rs2, minigames/game_mortton/scripts/flamtaer_temple.rs2,
// mortton_shades.rs2, mortton_pyre.rs2; skill_herblore/scripts/herblore.rs2:16-17 (the serum stage).
// The temple state is world-wide (flamtaer_temple.vars: %current_temple_build; the wall locs change for 9000 ticks,
// flamtaer_temple.rs2:138-153), so the script logs the wall levels it finds at the temple (TEMPLE line).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = {
    book: 3395, remains: 3396, serum: [3414, 3412, 3410, 3408], tarromin: 253, vial: 227, ashes: 592, unf: 95,
    plank: 960, brick: 3420, paste: 1941, hammer: 2347, tinderbox: 590, logs: 1511, olive: [3424, 3422, 3426, 3428],
    sacred: [3432, 3430, 3434, 3436], pyreLogs: 3438, coins: 995,
};
const SHELF = { id: 4062, x: 3481, z: 3279 };
const RAZMIRE = { x: 3489, z: 3296 };
const ULSQUIRE = { x: 3496, z: 3289 };
const ALTAR = { x: 3506, z: 3316 };
const PYRE = { id: 4093, x: 3504, z: 3275 };
// The 15 temple walls (maps/m54_51.jm2): templewall_base..10 (4068-4078) and templewallcorner_base..10 (4079-4089).
const WALLS: Array<[number, number]> = [[3504, 3314], [3504, 3315], [3504, 3316], [3504, 3317], [3504, 3318], [3505, 3314], [3505, 3318], [3506, 3318],
    [3507, 3314], [3507, 3318], [3508, 3314], [3508, 3315], [3508, 3316], [3508, 3317], [3508, 3318]];
const wallLevel = (id: number): number => (id >= 4068 && id <= 4078 ? id - 4068 : id >= 4079 && id <= 4089 ? id - 4079 : -1);

const q = await openQuest({ cap: 5000 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/completed a quest|quest complete/i) > 0) questDone = true; });
    const client: any = (q.s as any).client;
    const repairedP = (): number => client.var?.[343] ?? 0;   // %temple_repaired_p (transmit=yes, quest_mortton.varp)
    const resourcesP = (): number => client.var?.[344] ?? 0;  // %temple_resources_p
    const sanctityP = (): number => client.var?.[345] ?? 0;   // %temple_sanctity_p
    const serum = (): number | undefined => ITEM.serum.find(id => q.has(id));
    const first = (ids: number[]): number | undefined => ids.find(id => q.has(id));
    const shut = () => q.converse([], () => !q.dialogOpen(), 12);
    // One dialog page per tick; on an option page the LAST pattern that matches an option wins (a later step beats
    // an earlier one), or pick() decides.
    let lastPage = '';
    const DLG = process.env.MT_DLG !== '0';
    const chat = async (pats: RegExp[], ok: () => boolean, maxTicks: number, pick?: (opts: string[]) => RegExp | undefined): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !q.stats.died; i++) {
            if (ok()) return true;
            const d: any = q.s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opts: any[] = d.options ?? [];
                const page = [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' | ');
                if (page !== lastPage) { lastPage = page; if (DLG) console.log(`DLG ${q.T()} ${page.slice(0, 260)}${opts.length ? ` OPTS ${opts.map(o => `${o.index}:${o.text}`).join(' / ')}` : ''}`); }
                let idx: number | undefined;
                const want = pick?.(opts.map(o => o.text));
                if (want) idx = opts.find(o => want.test(o.text))?.index;
                if (idx === undefined) for (const re of [...pats].reverse()) { const o = opts.find(o => re.test(o.text)); if (o) { idx = o.index; break; } }
                if (idx === undefined && opts.some(o => !/click here to continue/i.test(o.text))) console.log(`WARN no option match: ${opts.map(o => o.text).join(' | ')}`);
                void q.s.sdk.sendClickDialog(idx ?? 0);
            }
            await q.waitTicks(1);
        }
        return ok();
    };
    const npcOf = (who: 'razmire' | 'ulsquire') => q.npc(who === 'razmire' ? /razmire/i : /ulsquire/i);
    const visible = (who: 'razmire' | 'ulsquire') => !/^afflicted/i.test(npcOf(who)?.name ?? 'Afflicted');
    // Opens a talk: the serum on the afflicted form (the NPC turns for 200 ticks, razmire_keelgan.rs2:33-48), or
    // Talk-to while the serum still works.
    const open = async (label: string, who: 'razmire' | 'ulsquire', op = 1) => {
        const home = who === 'razmire' ? RAZMIRE : ULSQUIRE;
        for (let i = 0; i < 4 && !q.dialogOpen() && !q.st()?.shop?.isOpen; i++) {
            await q.guard(label);
            if (!npcOf(who) || q.cheb(home.x, home.z) > 10) await q.walk(`${label} approach`, [{ x: home.x, z: home.z + 1, tol: 3 }]);
            let n = npcOf(who);
            if (!n) { await q.waitTicks(1); continue; }
            // Razmire and Ulsquire stand in different houses: a use or talk from the other house cannot route
            // (the client's cant_reach), so the bot walks next to the NPC first (walkPath opens doors).
            if (n.distance > 2 || i > 0) { await q.walk(`${label} to npc`, [{ x: n.x, z: n.z, tol: 1 }]); n = npcOf(who) ?? n; }
            if (op === 1 && !visible(who)) {
                const sv = serum();
                if (!sv) await q.fail(`${label}: no serum`);
                await q.useOnNpc(sv!, n);
            } else {
                await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: op, reason: 'SDK' });
            }
            const r: any = await q.waitUntil(() => q.dialogOpen() || !!q.st()?.shop?.isOpen, 20);
            if (!q.dialogOpen() && !q.st()?.shop?.isOpen) console.log(`WARN open ${label} try ${i}: npc=${n.name}@${n.x},${n.z} d=${n.distance} serum=${serum()} msg=${(q.st()?.gameMessages ?? []).slice(-1)[0]?.text} op=${JSON.stringify(q.st()?.opFeedback ?? {}).slice(0, 120)}`);
        }
        if (!q.dialogOpen() && !q.st()?.shop?.isOpen) await q.fail(`open ${label}`);
    };

    // Razmire's builders' store (razmire_keelgan.rs2:99-111,201-243).
    const buy = async (label: string) => {
        // One trip: as many sets as the free slots hold (1 plank, 1 limestone brick, 5 swamp paste), the add_temple_resources set
        // (flamtaer_temple.rs2:274-278).
        if (!q.st()?.shop?.isOpen) await open(label, 'razmire', visible('razmire') ? 4 : 1);
        // From stage 55 Razmire's talk menu has "Can you open a store for me?" before the store menu (razmire_keelgan.rs2:205-208).
        if (!q.st()?.shop?.isOpen) await chat([/open a store for me/i, /building store/i], () => !!q.st()?.shop?.isOpen, 40);
        if (!q.st()?.shop?.isOpen) await q.fail(`${label}: store not open`);
        const free = 28 - q.inv().length;
        const sets = Math.max(1, Math.floor((free - 1) / 7));
        for (const [re, id, n] of [[/^plank$/i, ITEM.plank, sets], [/limestone brick/i, ITEM.brick, sets], [/swamp paste/i, ITEM.paste, 5 * sets]] as Array<[RegExp, number, number]>) {
            for (let k = 0; k < 4 && q.cnt(id) < n; k++) {
                const r: any = await q.s.bot.buyFromShop(re, n - q.cnt(id));
                if (!r.success) console.log(`WARN buy ${re}: ${r.message}`);
            }
        }
        await q.s.bot.closeShop();
        await q.waitTicks(1);
        if (label === 'store 1' && !first(ITEM.olive)) {
            // Olive oil for the sacred oil from the general store on the same visit (razmire_keelgan.rs2:192-193).
            await open(`${label} general`, 'razmire', 1);
            await chat([/open a store for me/i, /general store/i], () => !!q.st()?.shop?.isOpen, 40);
            await q.s.bot.buyFromShop(/olive oil/i, 1);
            await q.s.bot.closeShop();
            await q.waitTicks(1);
        }
        console.log(`BUY ${label} olive=${first(ITEM.olive) ?? 0} planks=${q.cnt(ITEM.plank)} bricks=${q.cnt(ITEM.brick)} paste=${q.cnt(ITEM.paste)} coins=${q.cnt(ITEM.coins)} at ${q.T()}`);
    };
    // MT_FROM=ulsquire (debug preset quest_mortton_ulsquire): the state after Ulsquire sees a remains (47).
    const FROM = process.env.MT_FROM ?? '';
    if (FROM !== 'ulsquire') {
        // 1. The diary from Herbi Flax's shelf (quest_mortton.rs2:1-11); read to the last page with the forward button book:com_86 (5, serum_book.rs2:3-29, book.rs2:31-48).
        await q.step('shelf', () => q.opLoc(SHELF), () => q.has(ITEM.book), 15, 4);
        await shut();
        await q.step('read', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.book)!, optionIndex: 1, reason: 'SDK' }), () => q.dialogOpen() || q.st()?.modalInterface > 0, 10, 3);
        await chat([], () => q.st()?.modalInterface > 0 && !q.dialogOpen(), 10);
        for (let i = 0; i < 12; i++) { await q.s.direct({ type: 'clickComponent', componentId: componentId('book:com_86'), reason: 'SDK' }); await q.waitTicks(1); }
        await q.s.sdk.sendCloseModal();
        await q.waitTicks(1);
        q.milestone(5);
        // 2. Serum 207: tarromin into the water, then the ashes (10, brew_potion.struct:286-300, herblore.rs2:16-17).
        await q.step('unf', () => q.useOnItem(ITEM.tarromin, ITEM.vial), () => q.has(ITEM.unf), 8, 3);
        await shut();
        const s0 = q.cnt(3410);
        await q.step('serum', () => q.useOnItem(ITEM.ashes, ITEM.unf), () => q.cnt(3410) > s0, 8, 3);
        await shut();
        q.milestone(10);
        await q.step('drop book', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.book)!, optionIndex: 5, reason: 'SDK' }), () => !q.has(ITEM.book), 6, 3);
        await shut();

        // 3. Razmire: "What are all these shadow creatures?", "Yes, I'll dispatch those dark and evil creatures." (15,
        // razmire_keelgan.rs2:85-93,149-184).
        await open('razmire 1', 'razmire');
        await chat([/what are all these shadow/i, /yes, i'll dispatch/i], () => q.sawText(/that's what i wanted to hear/i) && !q.dialogOpen(), 80);
        q.milestone(15);

        // 4. Five Loar shades (a Loar Shadow turns when attacked, mortton_shades.rs2:81-111) and their remains (20-40,
        // :7-46). Auto retaliate is off, so the bot attacks each one that is on it.
        const shadeOn = () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^loar shade$/i.test(n.name) && n.targetIndex >= 0 && (n.hp ?? 1) > 0).sort((a: any, b: any) => a.distance - b.distance)[0];
        const shadow = () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^loar shad(ow|e)$/i.test(n.name) && n.reachable !== false && (n.hp ?? 1) > 0).sort((a: any, b: any) => a.distance - b.distance)[0];
        let kills = 0, patrol = 0;
        // The shadows wander 30 tiles from their spawns (mortton_shades.npc) and drift to the temple (proof logs).
        const PATROL = [{ x: 3488, z: 3285 }, { x: 3487, z: 3274 }, { x: 3480, z: 3280 }, { x: 3484, z: 3297 }, { x: 3497, z: 3292 }, { x: 3499, z: 3306 }, { x: 3500, z: 3316 }, { x: 3496, z: 3279 }];
        for (let i = 0; i < 80 && q.cnt(ITEM.remains) < 5; i++) {
            await q.guard('shades');
            const ground = (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.remains && g.distance <= 8);
            if (ground) {
                const r0 = q.cnt(ITEM.remains);
                await q.s.bot.pickupItem(ground);
                await q.waitUntil(() => q.cnt(ITEM.remains) > r0, 6);
                continue;
            }
            const t = shadeOn() ?? shadow();
            if (!t) {
                // No shade in view: walk the next point of a loop through the town's spawns (maps/m54_51.jm2).
                const pt = PATROL[patrol++ % PATROL.length]!;
                if (patrol % 4 === 1) console.log(`NOSHADE ${q.T()} to ${pt.x},${pt.z} loar=${JSON.stringify((q.st()?.nearbyNpcs ?? []).filter((n: any) => /loar/i.test(n.name)).map((n: any) => [n.name, n.x, n.z, n.reachable, n.hp]))}`);
                await q.walk('shades', [{ ...pt, tol: 2 }]);
                await q.waitTicks(2);
                continue;
            }
            await q.s.direct({ type: 'interactNpc', npcIndex: t.index, optionIndex: q.opIndex(t, /attack/i), reason: 'SDK' });
            const idx = t.index;
            await q.waitUntil(() => !(q.st()?.nearbyNpcs ?? []).some((n: any) => n.index === idx && /loar/i.test(n.name) && (n.hp ?? 1) > 0) || (q.st()?.groundItems ?? []).some((g: any) => g.id === ITEM.remains && g.distance <= 3), 40);
            kills++;
            // The remains drop after the death animation (obj_add after npc_death, mortton_shades.rs2:7-13).
            await q.waitUntil(() => (q.st()?.groundItems ?? []).some((g: any) => g.id === ITEM.remains && g.distance <= 4), 6);
            if (kills <= 12) console.log(`SHADE ${q.T()} t=${t.name}@${t.x},${t.z} reach=${t.reachable} after=${JSON.stringify((q.st()?.nearbyNpcs ?? []).filter((n: any) => n.index === idx).map((n: any) => [n.name, n.hp, n.maxHp]))} ground=${JSON.stringify((q.st()?.groundItems ?? []).filter((g: any) => g.distance <= 6).map((g: any) => [g.id, g.name]))} msg=${(q.st()?.gameMessages ?? []).slice(-1)[0]?.text}`);
        }
        if (q.cnt(ITEM.remains) < 5) await q.fail(`remains ${q.cnt(ITEM.remains)}`);
        console.log(`SHADES remains=${q.cnt(ITEM.remains)} tries=${kills} at ${q.T()}`);
        q.milestone(40);

        await open('razmire 2', 'razmire');
        await chat([/building store/i], () => !!q.st()?.shop?.isOpen, 60);
        if (q.cnt(ITEM.remains) > 3) await q.fail('razmire kept the remains');
        q.milestone(45);
        await buy('store 1');

        // 6. Ulsquire sees a remains (47, ulsquire_shauncy.rs2:73-87).
        await open('ulsquire 1', 'ulsquire');
        await chat([], () => q.cnt(ITEM.remains) <= 2 && !q.dialogOpen(), 40);
        q.milestone(47);
    } else {
        await buy('store 1');
    }
    // "What can you tell me about that temple?" sets 50 after the player's "How can you rebuild" line (:171-180).
    let told = false;
    for (let t = 0; t < 3 && !told; t++) {
        await shut();
        await open(`ulsquire 2.${t}`, 'ulsquire');
        told = await chat([], () => q.sawText(/how can you rebuild a totally destroyed temple/i) && !q.dialogOpen(), 60,
            () => q.sawText(/how can you rebuild a totally destroyed temple/i) ? /^ok thanks/i : /about that temple/i);
        if (!told) console.log(`WARN ulsquire 2.${t} no temple talk at ${q.T()}`);
    }
    if (!told) await q.fail('ulsquire temple talk');
    q.milestone(50);

    // 7. The temple: Repair on each wall until all 15 are templewall_10 (temple_repaired_p 100, flamtaer_temple.rs2:
    // 236-252); one build every 3 ticks while the bot stands (:21-46,155-156); the stages need %current_temple_build
    // (:138-153). A trip ends when the pack has no set left and the pool is under 100 (:27-33,64-66).
    const wallAt = (x: number, z: number) => q.findLoc((l: any) => l.x === x && l.z === z && wallLevel(l.id) >= 0);
    const levels = () => WALLS.map(([x, z]) => wallLevel(wallAt(x, z)?.id ?? -1));
    await q.walk('to temple', [{ x: 3506, z: 3313, tol: 1 }]);
    console.log(`TEMPLE start levels=${levels().join(',')} repaired=${repairedP()} resources=${resourcesP()} sanctity=${sanctityP()} at ${q.T()}`);
    let trips = 1, ops = 0;
    const hasSet = () => q.has(ITEM.plank) && q.has(ITEM.brick) && q.cnt(ITEM.paste) >= 5;
    // Done when the overlay counts all 15 walls (temple_repaired_p 100, :236-252), a build saw it and moved the stage
    // to 60 (the message, :80-84), and the sanctity holds the 10% that the altar and the oil need (:176,290) after the
    // drain of 30 a 100 ticks (:160-164). A temple that another player built still needs that build.
    const allowed = () => q.msgCount(/allowed to light the holy fire/i) > 0;
    for (let i = 0; i < 400 && !(repairedP() >= 100 && allowed() && sanctityP() >= 40); i++) {
        await q.guard('temple');
        if (!hasSet() && resourcesP() < 1) {
            // Out of resources: the next trip to the builders' store.
            trips++;
            await buy(`store ${trips}`);
            await q.walk('to temple', [{ x: 3506, z: 3313, tol: 1 }]);
            continue;
        }
        const lv = levels();
        // The lowest wall first (a shade knocks down walls above what the build supports, mortton_shades.rs2:284-312).
        let k = -1;
        for (let j = 0; j < WALLS.length; j++) if (lv[j]! >= 0 && lv[j]! < 10 && (k < 0 || lv[j]! < lv[k]!)) k = j;
        if (k < 0) {
            // All 15 at level 10: Repair still builds (stage and sanctity) without a wall change.
            k = 0;
        }
        const [wx, wz] = WALLS[k]!;
        const w = wallAt(wx, wz);
        if (!w) { await q.walk('to temple', [{ x: 3506, z: 3313, tol: 1 }]); continue; }
        const l0 = wallLevel(w.id);
        if (q.dialogOpen()) {
            const d: any = q.s.sdk.getDialog();
            if (ops < 4) console.log(`WARN temple page: ${[d?.text ?? '', ...(d?.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' | ').slice(0, 300)}`);
            await shut();
        }
        await q.opLoc(w, q.opIndex(w, /repair/i));
        ops++;
        await q.waitUntil(() => wallLevel(wallAt(wx, wz)?.id ?? -1) !== l0 || q.dialogOpen() || (repairedP() >= 100 && allowed() && sanctityP() >= 40), l0 === 10 ? 6 : 14);
        if (i % 10 === 0) console.log(`TEMPLE ${q.T()} levels=${levels().join(',')} repaired=${repairedP()} resources=${resourcesP()} sanctity=${sanctityP()} sets=${q.cnt(ITEM.plank)}`);
    }
    if (repairedP() < 100 || !allowed()) await q.fail(`temple ${repairedP()} allowed=${allowed()}`);
    console.log(`TEMPLE done ops=${ops} trips=${trips} sanctity=${sanctityP()} at ${q.T()}`);
    q.milestone(60);

    // 8. The altar lit with the tinderbox (flamtaer_temple.rs2:167-234); olive oil from Razmire's general store,
    // sanctified in the flame (65, :280-304); the sacred oil on the logs (70, mortton_pyre.rs2:1-42).
    await shut();
    const altar = () => q.findLoc((l: any) => l.x === ALTAR.x && l.z === ALTAR.z && l.id >= 4090 && l.id <= 4092);
    await q.step('light altar', () => { const a = altar(); return a ? q.opLoc(a, q.opIndex(a, /light/i)) : q.waitTicks(1); }, () => altar()?.id === 4090, 20, 4);
    q.milestone('altar');
    if (!first(ITEM.olive)) {
        await open('general store', 'razmire', visible('razmire') ? 3 : 1);
        if (!q.st()?.shop?.isOpen) await chat([/open a store for me/i, /general store/i], () => !!q.st()?.shop?.isOpen, 40);
        await q.s.bot.buyFromShop(/olive oil/i, 1);
        await q.s.bot.closeShop();
        await q.waitTicks(1);
        await q.walk('to temple', [{ x: 3506, z: 3313, tol: 1 }]);
    }
    await q.step('sacred oil', () => { const a = altar(); return a ? q.useOnLoc(first(ITEM.olive)!, a) : q.waitTicks(1); }, () => !!first(ITEM.sacred), 15, 4);
    await shut();
    q.milestone(65);
    await q.step('pyre logs', () => q.useOnItem(first(ITEM.sacred)!, ITEM.logs), () => q.has(ITEM.pyreLogs), 8, 3);
    q.milestone(70);

    // 9. A funeral pyre: the pyre logs (75), a remains, the tinderbox (80, mortton_pyre.rs2:44-209).
    await q.walk('to pyre', [{ x: PYRE.x + 1, z: PYRE.z + 1, tol: 1 }]);
    const pyreLoc = (ids: number[]) => q.findLoc((l: any) => ids.includes(l.id) && Math.abs(l.x - PYRE.x) <= 1 && Math.abs(l.z - PYRE.z) <= 1);
    await q.step('logs on pyre', () => q.useOnLoc(ITEM.pyreLogs, pyreLoc([4093]) ?? PYRE), () => !q.has(ITEM.pyreLogs), 12, 4);
    q.milestone(75);
    await q.step('remains on pyre', () => { const p = pyreLoc([4094]); return p ? q.useOnLoc(ITEM.remains, p) : q.waitTicks(1); }, () => !!pyreLoc([4100]), 12, 4);
    await q.step('light pyre', () => { const p = pyreLoc([4100]); return p ? q.opLoc(p, q.opIndex(p, /light/i)) : q.waitTicks(1); }, () => !pyreLoc([4100]), 20, 4);
    q.milestone(80);

    // 10. Ulsquire: "I've put the Shade's spirit to rest!" queues the completion (ulsquire_shauncy.rs2:106-110).
    await open('ulsquire 3', 'ulsquire');
    await chat([], () => questDone, 40);
    await shut();
    q.milestone(85);
    off();
    await q.end(questDone, `qp=3 ops=${ops} trips=${trips}`);
} catch (e) { await q.fail(String(e)); }
