// Regicide from preset quest_regicide (King Lathas's room, Ardougne castle level 1; every skill 99; Underground Pass
// done, %regicide_quest 1 with the King's summons: in a real run the messenger brings it during the quests before,
// regicide_kings_messenger.rs2:1-13, login_logout/login.rs2:74). Reward: 3 QP, 15,000 coins, 137,500 Agility XP before
// 25x (quest_regicide.rs2:850-855).
// %regicide_quest (varp 328, quest_regicide.constant): King Lathas 2 (king_lathas.rs2:30-37), Idris 3 (idris.rs2:6-72),
// Lord Iorwerth 4, the tracker 5, the pendant from Iorwerth, the tracker 6, the footprints 7, the tracker 8
// (lord_iorwerth.rs2, regicide_camp_tracker.rs2, quest_regicide.rs2:483-493), the guard that the 2232,3148 crossing
// spawns killed 9 (:464-466,602-610, tyras_guard.rs2:36-42), the Tyras camp crossing 10 (:467-471), Iorwerth and the
// Big Book o' Bangs 11, the fused barrel on the catapult 12 (:495-599), Iorwerth's message 13, Arianwyn by the castle 14
// (:792-830), King Lathas (king_lathas.rs2:6-16).
// Route. The way west: the whole Underground Pass again; with %regicide_quest >= 2 Iban's temple door puts the bot in
// the temple of the well of voyage (quest_upass.rs2:574-588); the well and the temple exit lead to Tirannwn
// (quest_regicide.rs2:10-29). The naphtha needs the fractionalizing still in the Rimmington chemist's house
// (2927,3212), and the gate at Arandar opens from the north only after Tyras dies (regicide_arandar_gate_guard.rs2:4-6),
// so the pass is crossed twice: once for stages 2-11 and the tar, once with the fused barrel. Between the two: the
// Falador teleport, the furnace there for the quicklime (any furnace: smelting.rs2:23), the Falador west bank (coal,
// the second rope, the rabbit, food), the still, the Ardougne teleport.
// Tirannwn traps (pits, the woodspring, the tripwire) trigger on their tiles (regicide_zones.rs2); the legs below come
// from a planner that keeps every shortest path between two waypoints off those tiles (scratchpad up/tir.ts).
// RG_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';

const ITEM = { summons: 3206, message: 3207, pendant: 3208, sulphur: 3209, limestone: 3211, quicklime: 3213, limeDust: 3214,
    sulphurDust: 3215, barrel: 3216, lid: 3218, fused: 3219, tar: 3220, naphtha: 3221, mixS: 3222, mixQ: 3223, cloth: 3224,
    rabbit: 3228, book: 3230, pestle: 233, pot: 1931, wool: 1759, coal: 453, bow: 841, unlit: 2532, lit: 2533,
    tinderbox: 590, rope: 954, spade: 952, scimitar: 1333, shark: 385, arrow: 884 };
// A stack of RANGED_ARROWS rune or iron arrows in the pack makes the bow the weapon of the quest (quest-upass.ts).
const RANGED_ARROWS = 50, FIGHT_ARROWS = [892, 884], FIGHT_BOW = 861;
const LATHAS = { x: 2578, z: 3293 };                        // level 1
const CASTLE_STAIRS = { id: 1722, x: 2571, z: 3295 };
const ENTRANCE = { id: 3213, x: 2433, z: 3313 };            // upass_caveentrance2
const ROPE = { id: 3340, x: 2443, z: 9718 };
const SWING = { id: 2276, x: 2460, z: 9699 };
const LEVER = { id: 3337, x: 2466, z: 9672 };
const HOLDS = { id: 3365, x: 2395, z: 9559 };
const VOYAGE_WELL = { id: 4004, x: 2008, z: 4711 };         // level 1 -> 2343,9622 level 0 (quest_regicide.rs2:10-17)
const TEMPLE_EXIT = { id: 4007, x: 2312, z: 9623 };         // -> 2312,3216 (quest_regicide.rs2:28-29)
const IORWERTH = { x: 2205, z: 3252 };
const TRACKER = { x: 2257, z: 3149 };
const FOOTPRINTS = { id: 3941, x: 2240, z: 3150 };
const TAR = { id: 3975, x: 2263, z: 3127 };
const LOOM = { id: 787, x: 2198, z: 3249 };
const FURNACE = { id: 2781, x: 2975, z: 3368 };             // Falador
const STILL = { id: 4026, x: 2927, z: 3212 };
const CATAPULT = { id: 3976, x: 2185, z: 3183 };

// Tirannwn legs (scratchpad up/tir.ts): "x,z" walk (every shortest path off trap tiles), "K:loc:from>to" a loc op:
// C cross_over (Agility 56, %regicide_quest >= 8, quest_regicide.rs2:388-477), L log balance (:341-386), J pit jump
// (:237-281), P woodspring pass (:31-77), W the tripwire walked onto (it pushes the bot 2 tiles on, 10 damage and
// poison: :171-188, regicide_zones.rs2:59-62).
const LEG = {
    E_IDRIS: '2298,3209 2284,3212 2270,3209 2267,3205 J:2267,3204:2267,3205>2267,3201 2266,3198',
    IDRIS_I: '2257,3186 2243,3182 2238,3181 P:2235,3181:2238,3181>2234,3181 2221,3184 2211,3198 2209,3201 J:2209,3202:2209,3201>2209,3205 2206,3219 2205,3233 2202,3237 L:2201,3237:2202,3237>2196,3237 2197,3251 2205,3251',
    I_T: '2196,3246 2196,3237 L:2197,3237:2196,3237>2202,3237 2203,3223 2208,3209 2209,3205 J:2209,3204:2209,3205>2209,3201 2219,3187 2231,3178 2239,3164 2253,3152 2257,3150',
    T_I: '2243,3160 2233,3174 2221,3183 2212,3197 2209,3201 J:2209,3202:2209,3201>2209,3205 2206,3219 2205,3233 2202,3237 L:2201,3237:2202,3237>2196,3237 2197,3251 2205,3251',
    T_FP: '2243,3150 2241,3151',
    FP_T: '2255,3151 2257,3150',
    T_TAR: '2257,3136 2263,3128',
    TAR_G: '2254,3142 2241,3148 2240,3149 C:2238,3148:2240,3149>2237,3149 C:2235,3148:2237,3149>2234,3149 C:2232,3148:2234,3149>2231,3149',
    G_CAMP: '2221,3151 2220,3152 W:2220,3153:2220,3152>2220,3155 2217,3159 2217,3160 C:2216,3161:2217,3160>2217,3163 C:2216,3164:2217,3163>2217,3166 C:2216,3167:2217,3166>2217,3169 2204,3178 2191,3176 2188,3171',
    CAMP_I: '2199,3178 2212,3174 2216,3170 2217,3169 C:2216,3167:2217,3169>2217,3166 C:2216,3164:2217,3166>2217,3163 C:2216,3161:2217,3163>2217,3160 2220,3155 W:2220,3153:2220,3155>2220,3152 2230,3148 2231,3149 C:2232,3148:2231,3149>2234,3149 C:2235,3148:2234,3149>2237,3149 C:2238,3148:2237,3149>2240,3149 2240,3163 2232,3177 2220,3186 2210,3200 2209,3201 J:2209,3202:2209,3201>2209,3205 2206,3219 2205,3233 2202,3237 L:2201,3237:2202,3237>2196,3237 2197,3251 2205,3251',
    E_CAMP: '2298,3209 2284,3212 2270,3209 2267,3205 J:2267,3204:2267,3205>2267,3201 2260,3187 2246,3183 2238,3181 P:2235,3181:2238,3181>2234,3181 2237,3167 2240,3153 2240,3150 2240,3149 C:2238,3148:2240,3149>2237,3149 C:2235,3148:2237,3149>2234,3149 C:2232,3148:2234,3149>2231,3149 2221,3151 2220,3152 W:2220,3153:2220,3152>2220,3155 2217,3159 2217,3160 C:2216,3161:2217,3160>2217,3163 C:2216,3164:2217,3163>2217,3166 C:2216,3167:2217,3166>2217,3169 2204,3178 2191,3176 2188,3171',
    CAT_I: '2194,3185 2208,3179 2216,3170 2217,3169 C:2216,3167:2217,3169>2217,3166 C:2216,3164:2217,3166>2217,3163 C:2216,3161:2217,3163>2217,3160 2220,3155 W:2220,3153:2220,3155>2220,3152 2230,3148 2231,3149 C:2232,3148:2231,3149>2234,3149 C:2235,3148:2234,3149>2237,3149 C:2238,3148:2237,3149>2240,3149 2240,3163 2232,3177 2220,3186 2210,3200 2209,3201 J:2209,3202:2209,3201>2209,3205 2206,3219 2205,3233 2202,3237 L:2201,3237:2202,3237>2196,3237 2197,3251 2205,3251',
};
const LOC_IDS: Record<string, number[]> = { C: [3937, 3938, 3939, 3998, 3999], L: [3931, 3932, 3933], J: [3925], P: [3922] };

// The still (regicide_fractionalizing_still.rs2): every 2 ticks the pressure needle moves by the valve (-2 at the
// middle setting) plus the tar regulator (+2 fully open), so one valve click and two regulator clicks hold it; the heat
// needle rises while %temp > 50 (by 3 above 80) and falls at 0; a coal click adds 60; the total gains 2 per step while
// the regulator is open and the heat is in bits 19-24; 26 gives the naphtha when the interface closes. A heat needle
// past its top resets everything. This coal schedule (one entry per 2-tick step) reaches 26 in 16 steps and stays
// safe when any click lands one step late (scratchpad up/still3.ts).
const COAL_PLAN = '1110001010101000';

const FROM = process.env.RG_FROM ?? 'start';
const STAGES = ['start', 'tir1', 't8', 'falador', 'up2', 'tir2', 'home'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 12000, eatAt: 50, food: [385, 379, 2309, 2003], resend: false });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete|you have completed the/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const at = (tx: number, tz: number) => x() === tx && z() === tz;
    const use = (id: number, op: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: op, reason: 'SDK' });
    const wield = async (label: string, id: number) => {
        const op = (q.inv().find((i: any) => i.id === id)?.optionsWithIndex ?? []).find((o: any) => /wield|wear/i.test(o.text))?.opIndex ?? 2;
        await q.step(label, () => use(id, op), () => !q.has(id), 4, 3);
    };
    const msgSince = (re: RegExp, t: number) => (q.st()?.gameMessages ?? []).some((m: any) => m.type === 0 && m.tick >= t && re.test(m.text));
    const drop = async (label: string, ids: number[]) => {
        for (let i = 0; i < 8 && ids.some(id => q.has(id)); i++) {
            const it = q.inv().find((e: any) => ids.includes(e.id));
            if (it) await q.s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (ids.some(id => q.has(id))) console.log(`WARN drop ${label}`);
    };
    const pickup = async (label: string, id: number, gx: number, gz: number, want = 1) => {
        const c0 = q.cnt(id);
        for (let i = 0; i < 20 && q.cnt(id) < c0 + want; i++) {
            await q.guard(label);
            const g = (q.st()?.groundItems ?? []).filter((o: any) => o.id === id && Math.abs(o.x - gx) <= 1 && Math.abs(o.z - gz) <= 1)[0]
                ?? (q.st()?.groundItems ?? []).filter((o: any) => o.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (q.cnt(id) < c0 + want) console.log(`WARN pickup ${label}: ${q.cnt(id) - c0}/${want}`);
    };
    const slide = async (label: string, lx: number, lz: number) => {
        const t0 = q.s.tick();
        await q.step(label, () => q.opLoc(q.locAt(lx, lz) ?? { id: 3309, x: lx, z: lz }, 1), () => msgSince(/step down the other side/i, t0), 20, 4);
        await q.waitTicks(3);
    };
    const cross = async (label: string, lx: number, lz: number, id: number, op: RegExp, done: () => boolean, ticks = 15) => {
        await q.step(label, () => { const l = q.locAt(lx, lz) ?? q.findLoc((k: any) => k.id === id && Math.abs(k.x - lx) <= 1 && Math.abs(k.z - lz) <= 1) ?? { id, x: lx, z: lz }; return q.opLoc(l, q.opIndex(l, op)); }, done, ticks, 4);
        await q.waitTicks(1);
    };
    const bridge = async (label: string, lx: number, lz: number, ax: number, az: number) => {
        await q.walk(`${label} approach`, [{ x: ax, z: az, tol: 0 }]);
        const t0 = q.s.tick();
        await cross(label, lx, lz, 3255, /cross/i, () => msgSince(/manage to cross safely/i, t0), 25);
        await q.waitTicks(2);
    };
    const kill = async (label: string, pick: () => any) => {
        for (let i = 0; i < 6; i++) {
            await q.guard(label);
            const n = pick();
            if (!n) { await q.waitTicks(2); continue; }
            const alive = () => (q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index);
            for (let k = 0; k < 25 && alive(); k++) {
                await q.guard(label);
                await q.s.bot.attack(n as any);
                await q.waitUntil(() => !alive(), 6);
            }
            if (!alive()) return;
        }
        await q.fail(`kill ${label}`);
    };
    // A dialog page (Idris's ambush, Arianwyn) is clicked through; the walk goes on after it closes.
    // Idris's queue needs the bot beside him (idris.rs2:37-41), so nothing is sent while he is here before his last line.
    const idrisWait = () => !!q.npc(/^idris$/i) && !q.sawText(/north west of the forest/i);
    const dialogs = async () => {
        if (!q.dialogOpen() && !idrisWait()) return;
        let shut = 0;
        for (let i = 0; i < 150 && shut < 4; i++) {
            if (q.dialogOpen()) { shut = 0; await q.converse([], () => !q.dialogOpen(), 1); } else if (!idrisWait()) shut++;
            await q.waitTicks(1);
        }
    };
    const goTo = async (label: string, tx: number, tz: number, running = true) => {
        for (let k = 0; k < 4 && !at(tx, tz); k++) {
            await q.guard(label);
            await dialogs();
            if (k > 0) q.stats.retries++;
            await q.s.direct({ type: 'walkTo', x: tx, z: tz, running, reason: 'SDK' });
            let still = 0, p0 = '';
            for (let w = 0; w < 30 && !at(tx, tz) && still < 4; w++) {
                await q.waitTicks(1);
                if (q.dialogOpen() || idrisWait()) break;
                const p = `${x()},${z()}`; still = p === p0 ? still + 1 : 0; p0 = p;
            }
        }
        if (!at(tx, tz)) await q.fail(`walk ${label} to ${tx},${tz}`);
    };
    const tw = async (label: string, leg: string) => {
        const t1 = q.T();
        for (const tok of leg.split(' ')) {
            const m = tok.match(/^([CLJPW]):(\d+),(\d+):(\d+),(\d+)>(\d+),(\d+)$/);
            if (!m) { const [tx, tz] = tok.split(',').map(Number); await goTo(label, tx!, tz!); continue; }
            const [k, lx, lz, fx, fz, dx, dz] = [m[1]!, ...m.slice(2).map(Number)] as [string, number, number, number, number, number, number];
            await goTo(label, fx, fz);
            if (k === 'W') { await goTo(`${label} wire`, dx, dz, false); continue; }
            await q.step(`${label} ${tok}`, async () => {
                await dialogs();
                if (at(dx, dz)) return;
                const l = q.findLoc((o: any) => o.x === lx && o.z === lz && (LOC_IDS[k] ?? []).includes(o.id)) ?? { id: LOC_IDS[k]![0]!, x: lx, z: lz };
                return q.opLoc(l, 1);
            // The woodspring trap rolls stat_random(agility, 30, 155) on 256 (quest_regicide.rs2:32): 46 in 100 at
            // Agility 69 and 60 in 100 at 99, so four tries fail 1 run in 12. A failed try leaves the bot on its tile.
            }, () => at(dx, dz), 14, k === 'P' ? 12 : 4);
            await q.waitTicks(1);
        }
        q.stats.walkTicks += q.T() - t1;
    };

    // The Underground Pass from West Ardougne to Tirannwn (quest-upass.ts route; the obstacles stay as they are after
    // the quest: a lit arrow for the bridge rope, a rope for the swing, the spike grid by trial, the orbs' well, the
    // cells, the unicorn's door at 2375,9611 straight to the paladins (quest_upass.rs2:318-327), the skull door with
    // the badges in the well (:340-405), then Iban's temple door).
    const pass = async (n: number) => {
        await q.walk(`to city doors ${n}`, [{ x: 2559, z: 3300, tol: 1 }]);
        await q.step(`city doors ${n}`, () => { const d = q.findLoc((l: any) => /door/i.test(l.name) && l.x >= 2557 && l.x <= 2558 && l.z >= 3299 && l.z <= 3300); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => x() <= 2556, 12, 4);
        await q.walk(`to entrance ${n}`, [{ x: 2435, z: 3313, tol: 2 }]);
        await q.step(`cave ${n}`, () => q.opLoc(q.locAt(ENTRANCE.x, ENTRANCE.z) ?? ENTRANCE, 1), () => z() > 9000, 15, 4);
        await slide(`slide 1.${n}`, 2478, 9721);
        await slide(`slide 2.${n}`, 2467, 9723);
        await slide(`slide 3.${n}`, 2460, 9720);
        await q.step(`light arrow ${n}`, () => q.useOnItem(ITEM.tinderbox, ITEM.unlit), () => q.has(ITEM.lit), 4, 3);
        await wield(`bow ${n}`, ITEM.bow);
        await wield(`lit arrow ${n}`, ITEM.lit);
        await q.walk(`to shot ${n}`, [{ x: 2447, z: 9722, tol: 0 }]);
        await q.step(`shoot rope ${n}`, () => q.opLoc(q.locAt(ROPE.x, ROPE.z) ?? ROPE, 1), () => x() <= 2442, 20, 3);
        // An account that brings RANGED_ARROWS arrows keeps a bow for the fights of the quest, in the style that trains
        // only Ranged (quest-upass.ts has the same rule).
        const arrows = FIGHT_ARROWS.find(id => q.cnt(id) >= RANGED_ARROWS);
        if (arrows !== undefined) {
            if (q.has(FIGHT_BOW)) await wield(`fight bow ${n}`, FIGHT_BOW);
            await wield(`arrows ${n}`, arrows);
            await q.styleOnly(`bow ${n}`, 'Ranged');
        } else await wield(`scimitar ${n}`, ITEM.scimitar);
        q.milestone(`bridge${n}`);
        await q.walk(`to swing ${n}`, [{ x: 2462, z: 9699, tol: 1 }]);
        await q.step(`swing ${n}`, () => q.useOnLoc(ITEM.rope, q.locAt(SWING.x, SWING.z) ?? SWING), () => x() >= 2465, 15, 3);
        await slide(`slide 4.${n}`, 2491, 9691);
        await slide(`slide 5.${n}`, 2482, 9679);
        // The spike grid (upass_grid.rs2:62-106): the path is kept in %ibanmulti bits 22-31 from the Underground Pass
        // run but is not sent to the client, so it is found by trial (quest-upass.ts).
        const band = (r: number) => 9673 + 2 * (r - 1);
        const fell = () => z() < 9600;
        const climbOut = async () => {
            await q.waitTicks(2);
            await q.step('hand holds', () => q.opLoc(q.findLoc((l: any) => l.id === HOLDS.id) ?? HOLDS, 1), () => z() > 9600, 10, 4);
            await q.waitTicks(1);
        };
        const tread = async (tiles: Array<[number, number]>): Promise<boolean> => {
            for (const [tx, tz] of tiles) {
                await q.guard('grid');
                for (let k = 0; k < 6 && !at(tx, tz) && !fell(); k++) {
                    await q.s.direct({ type: 'walkTo', x: tx, z: tz, running: false, reason: 'SDK' });
                    await q.waitUntil(() => at(tx, tz) || fell(), 4);
                }
                await q.waitTicks(1);
                if (fell()) return true;
                if (!at(tx, tz)) await q.fail(`grid step ${tx},${tz}`);
            }
            await q.waitTicks(2);
            return fell();
        };
        const east = async (zz: number) => {
            if (fell()) await climbOut();
            for (let k = 0; k < 6 && !at(2477, zz); k++) { await q.s.direct({ type: 'walkTo', x: 2477, z: zz, running: false, reason: 'SDK' }); await q.waitUntil(() => at(2477, zz), 8); }
        };
        const XS = [[2476, 2475, 2474], [2473, 2472, 2471, 2470], [2469, 2468, 2467]];
        const seg = (c: number, r: number, prev?: number): Array<[number, number]> => {
            const t: Array<[number, number]> = [];
            if (prev !== undefined && prev !== r) { const px = XS[c - 1]![XS[c - 1]!.length - 1]!; const d = r > prev ? 1 : -1; for (let zz = band(prev) + d; zz !== band(r) + d; zz += d) t.push([px, zz]); }
            for (const xx of XS[c]!) t.push([xx, band(r)]);
            return t;
        };
        const path: number[] = [];
        for (let col = 0; col < 3; col++) {
            const prev = path[col - 1];
            const lo = prev === undefined ? 1 : Math.max(1, prev - 1), hi = prev === undefined ? 5 : Math.min(5, prev + 1);
            let found = 0;
            for (let r = lo; r <= hi && !found; r++) {
                if (fell() || x() > 2476) {
                    await east(band(path[0] ?? r));
                    let replay: Array<[number, number]> = [];
                    for (let c = 0; c < path.length; c++) replay = replay.concat(seg(c, path[c]!, path[c - 1]));
                    if (replay.length && await tread(replay)) await q.fail('grid replay fell');
                }
                if (await tread(seg(col, r, prev))) { console.log(`GRID col ${col + 1} band ${r} fell`); continue; }
                found = r;
            }
            if (!found) await q.fail(`grid col ${col + 1}`);
            path.push(found);
        }
        const r3 = band(path[2]!);
        const out: Array<[number, number]> = [[2466, r3]];
        for (let zz = r3 - 1; zz >= 9673; zz--) out.push([2466, zz]);
        if (await tread(out)) await q.fail('grid exit fell');
        await q.step(`lever ${n}`, () => q.opLoc(q.locAt(LEVER.x, LEVER.z) ?? LEVER, 1), () => x() <= 2464, 15, 3);
        q.milestone(`grid${n}`);
        // The well takes the bot down while all 4 orb bits are set (quest_upass.rs2:119-131).
        await q.walk(`to well ${n}`, [{ x: 2416, z: 9676, tol: 2 }]);
        await q.step(`well ${n}`, () => q.opLoc(q.findLoc((l: any) => l.id === 3264) ?? { id: 3264, x: 2416, z: 9674 }, 1), () => z() < 9665, 12, 3);
        await q.walk(`to cell ${n}`, [{ x: 2393, z: 9656, tol: 0 }]);
        await cross(`cell lock ${n}`, 2393, 9655, 3266, /pick|open/i, () => z() <= 9654);
        await q.step(`mud ${n}`, () => q.useOnLoc(ITEM.spade, q.findLoc((l: any) => l.id === 3216) ?? { id: 3216, x: 2393, z: 9650 }), () => z() <= 9647, 12, 3);
        await q.walk(`to ledge ${n}`, [{ x: 2375, z: 9644, tol: 0 }]);
        await cross(`ledge ${n}`, 2374, 9644, 3238, /.*/, () => z() <= 9639, 20);
        await q.walk(`to cage door 1.${n}`, [{ x: 2379, z: 9619, tol: 0 }]);
        await cross(`cage door 1.${n}`, 2380, 9619, 3268, /pick|open/i, () => x() >= 2381);
        await q.walk(`to cage door 2.${n}`, [{ x: 2403, z: 9620, tol: 0 }]);
        await cross(`cage door 2.${n}`, 2404, 9620, 3268, /pick|open/i, () => x() >= 2404);
        await q.walk(`to pipe ${n}`, [{ x: 2419, z: 9605, tol: 0 }]);
        await cross(`pipe ${n}`, 2417, 9605, 3237, /.*/, () => x() <= 2413, 25);
        // The pipe ends at 2390,9605 by the unicorn's cage; its door (upass_unicorn_doorl 2375,9611, angle south) puts
        // the bot at 2371,9666 once the unicorn is dead (quest_upass.rs2:318-327).
        await q.walk(`to unicorn door ${n}`, [{ x: 2375, z: 9610, tol: 1 }]);
        await cross(`unicorn door ${n}`, 2375, 9611, 3219, /.*/, () => z() > 9660, 12);
        q.milestone(`area2.${n}`);
        await q.walk(`to skull door ${n}`, [{ x: 2370, z: 9718, tol: 1 }]);
        await cross(`skull door ${n}`, 2368, 9717, 3220, /open/i, () => q.lvl() === 1, 15);
        // Main cavern (2173,4725 level 1): the bridge east at 2121,4686, two bridges south, Iban's temple door.
        await q.walk(`to bridge north ${n}`, [{ x: 2120, z: 4686, tol: 0 }]);
        await bridge(`bridge north ${n}`, 2121, 4686, 2120, 4686);
        await bridge(`bridge temple 1.${n}`, 2162, 4663, 2162, 4666);
        await bridge(`bridge temple 2.${n}`, 2161, 4654, 2161, 4657);
        await q.walk(`to temple door ${n}`, [{ x: 2145, z: 4647, tol: 1 }]);
        await cross(`temple door ${n}`, 2143, 4647, 3334, /open/i, () => x() < 2100, 12);
        q.milestone(`temple${n}`);
        await q.step(`voyage well ${n}`, () => q.opLoc(q.findLoc((l: any) => l.id === VOYAGE_WELL.id) ?? VOYAGE_WELL, 1), () => z() > 9000, 15, 4);
        await q.step(`temple exit ${n}`, () => q.opLoc(q.findLoc((l: any) => l.id === TEMPLE_EXIT.id) ?? TEMPLE_EXIT, 1), () => z() < 4000, 20, 4);
        q.milestone(`tirannwn${n}`);
    };

    if (from('start')) {
        // 1. King Lathas (2, king_lathas.rs2:30-37).
        await q.talk('lathas', /^king lathas$/i, [], () => q.sawText(/kill my brother tyras/i), LATHAS, 80);
        q.milestone(2);
        await drop('summons', [ITEM.summons]);
        await q.walk('to lathas door', [{ x: 2576, z: 3293, tol: 0 }]);
        await q.openDoor('lathas door', 2575, 3293);
        await q.climb('castle stairs', () => q.findLoc((l: any) => /stair/i.test(l.name) && l.distance <= 12), /climb-down|^climb$|walk-down/i, () => q.lvl() === 0);
        await pass(1);
    }
    if (from('tir1')) {
        // 2. Idris comes 20-30 ticks after the bot enters map 35_49, 35_50 or 36_50 (music/scripts/move.rs2:21-41,
        // idris.rs2:6-30), beside the bot (map_findsquare radius 1-3 with line of walk); in a 1-tile forest path that
        // finds no square and he never comes (proof run 1). So the bot waits in the open ground at 2266,3198, just
        // inside map 35_49 (the timer starts again on that entry).
        await tw('to idris', LEG.E_IDRIS);
        for (let i = 0; i < 40 && !q.sawText(/north west of the forest/i); i++) { await dialogs(); await q.waitTicks(1); }
        await dialogs();
        await tw('to iorwerth', LEG.IDRIS_I);
        if (!q.sawText(/north west of the forest/i)) await q.fail('no idris');
        q.milestone(3);
        await q.talk('iorwerth 1', /^lord iorwerth$/i, [], () => q.sawText(/find one of our trackers/i), IORWERTH, 60);
        q.milestone(4);
        // The 2 empty barrels lie by his camp (maps/m34_50.jm2: 2205,3257 and 2208,3259); the 4 balls of wool on the
        // loom make the cloth (quest_regicide.rs2:672-691).
        await goTo('to barrel 1', 2205, 3257);
        await pickup('barrel 1', ITEM.barrel, 2205, 3257);
        await goTo('to barrel 2', 2208, 3259);
        await pickup('barrel 2', ITEM.barrel, 2208, 3259);
        await goTo('to loom', 2205, 3251);
        await q.step('loom', () => q.useOnLoc(ITEM.wool, q.findLoc((l: any) => l.id === LOOM.id) ?? LOOM), () => q.has(ITEM.cloth), 15, 3);
        await tw('to tracker 1', LEG.I_T);
        await q.talk('tracker 1', /^elf tracker$/i, [], () => q.sawText(/have no time for brigands or outlaws/i), TRACKER, 60);
        q.milestone(5);
        await tw('back to iorwerth', LEG.T_I);
        await q.talk('iorwerth 2', /^lord iorwerth$/i, [], () => q.has(ITEM.pendant), IORWERTH, 60);
        await tw('to tracker 2', LEG.I_T);
        await q.talk('tracker 2', /^elf tracker$/i, [], () => q.sawText(/come and tell me if you find anything/i), TRACKER, 60);
        q.milestone(6);
        await drop('pendant', [ITEM.pendant]);
        await tw('to footprints', LEG.T_FP);
        const t0 = q.s.tick();
        await q.step('footprints', () => q.opLoc(q.findLoc((l: any) => l.id === FOOTPRINTS.id) ?? FOOTPRINTS, 1), () => msgSince(/impassable woodland/i, t0), 10, 3);
        q.milestone(7);
        await tw('to tracker 3', LEG.FP_T);
        await q.talk('tracker 3', /^elf tracker$/i, [], () => q.sawText(/know what you're looking for/i), TRACKER, 60);
        q.milestone(8);
    }
    if (from('t8')) {
        // 3. The tar pit fills both barrels (quest_regicide.rs2:636-647); a piece of the sulphur formation, ground.
        await tw('to tar', LEG.T_TAR);
        for (let i = 0; i < 2 && q.has(ITEM.barrel); i++) {
            const c = q.cnt(ITEM.tar);
            await q.step(`tar ${i}`, () => q.useOnLoc(ITEM.barrel, q.locAt(TAR.x, TAR.z) ?? TAR), () => q.cnt(ITEM.tar) > c, 10, 3);
        }
        // Of the tar tiles only 2263,3127 is in reach (from 2263,3128); the formation at 2261,3130 from 2262,3130.
        await q.step('sulphur', () => q.opLoc(q.locAt(2261, 3130) ?? { id: 3963, x: 2261, z: 3130 }, 1), () => q.has(ITEM.sulphur), 12, 3);
        await q.step('grind sulphur', () => q.useOnItem(ITEM.pestle, ITEM.sulphur), () => q.has(ITEM.sulphurDust), 6, 3);
        q.milestone('tar');
        // 4. West over the 3 crossings: the last one spawns a Tyras guard at stage 8 (quest_regicide.rs2:464-466,602-610);
        // its death sets 9 (tyras_guard.rs2:36-42).
        await tw('to old camp crossing', LEG.TAR_G);
        await q.waitUntil(() => !!q.npc(/^tyras guard$/i), 6);
        await kill('old camp guard', () => q.npc(/^tyras guard$/i));
        q.milestone(9);
        await q.waitTicks(2);
        // 5. Through the tripwire and 3 crossings north to the Tyras camp; its crossing sets 10 (:467-471); back out.
        await tw('to tyras camp', LEG.G_CAMP);
        await q.step('camp crossing', () => q.opLoc(q.findLoc((l: any) => l.id === 3998 && l.x === 2187 && l.z === 3169) ?? { id: 3998, x: 2187, z: 3169 }, 1), () => at(2188, 3168), 14, 4);
        q.milestone(10);
        await q.waitTicks(1);
        await q.step('camp crossing back', () => q.opLoc(q.findLoc((l: any) => l.id === 3998 && l.x === 2187 && l.z === 3169) ?? { id: 3998, x: 2187, z: 3169 }, 1), () => at(2188, 3171), 14, 4);
        await tw('camp to iorwerth', LEG.CAMP_I);
        await q.talk('iorwerth 3', /^lord iorwerth$/i, [], () => q.has(ITEM.book), IORWERTH, 60);
        q.milestone(11);
        await drop('book', [ITEM.book]);
    }
    if (from('falador')) {
        // 6. Falador: the furnace makes the quicklime at stage 11 (quest_regicide.rs2:649-670; 8 damage without gloves),
        // ground into the empty pot (:696-712); the bank.
        if (z() < 3300 && x() < 2400) await q.teleport('falador teleport', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to furnace', [{ x: 2974, z: 3369, tol: 2 }]);
        await q.step('quicklime', () => q.useOnLoc(ITEM.limestone, q.findLoc((l: any) => l.id === FURNACE.id) ?? FURNACE), () => q.has(ITEM.quicklime), 12, 3);
        await q.step('grind quicklime', () => q.useOnItem(ITEM.pestle, ITEM.quicklime), () => q.has(ITEM.limeDust), 6, 3);
        await drop('pestle', [ITEM.pestle, ITEM.limestone]);
        await q.walk('to bank', [{ x: 2946, z: 3368, tol: 1 }]);
        const o = await q.s.bot.openBank();
        if (!o.success) await q.fail(`openBank ${o.message}`);
        // The sharks go in first: the pack is near full (8 coal, the rope and the rabbit come out).
        if (q.has(ITEM.shark)) { await q.s.bot.depositItem(/^shark$/i, -1); await q.waitTicks(1); }
        for (const [re, n] of [[/^rope$/i, 1], [/^cooked rabbit$/i, 1], [/^coal$/i, 8]] as Array<[RegExp, number]>) {
            const w = await q.s.bot.withdrawItem(re, n);
            if (!w.success) console.log(`WARN withdraw ${re}: ${w.message}`);
            await q.waitTicks(1);
        }
        const free = () => 28 - q.inv().length;
        if (free() > 0) { await q.s.bot.withdrawItem(/^shark$/i, free()); await q.waitTicks(1); }
        await q.s.bot.closeBank();
        await q.waitTicks(1);
        if (q.cnt(ITEM.coal) < 7 || !q.has(ITEM.rope) || !q.has(ITEM.rabbit)) await q.fail(`bank items coal=${q.cnt(ITEM.coal)}`);
        q.milestone('bank');
        // 7. The still in the chemist's house (door loc_1533 at 2932,3213, inner door 2928,3209).
        await q.walk('to rimmington', [{ x: 2932, z: 3214, tol: 1 }]);
        await q.openDoor('chemist door', 2932, 3213);
        await q.walk('to still', [{ x: 2927, z: 3211, tol: 1 }]);
        const click = (com: number) => q.s.direct({ type: 'clickComponent', componentId: componentId(`regicide_still:com_${com}`), reason: 'SDK' });
        for (let attempt = 0; attempt < 2 && !q.has(ITEM.naphtha) && q.has(ITEM.tar); attempt++) {
            const t0 = q.s.tick();
            await q.step(`still ${attempt}`, () => q.useOnLoc(ITEM.tar, q.findLoc((l: any) => l.id === STILL.id) ?? STILL), () => msgSince(/add the coal tar to the still/i, t0), 12, 3);
            await q.waitTicks(1);
            await click(130);                // pressure valve to the middle (-2)
            await q.waitTicks(1);
            await click(132);                // tar regulator half open
            await q.waitTicks(1);
            await click(132);                // fully open (+2)
            await q.waitTicks(2);
            for (const c of COAL_PLAN) {
                if (c === '1') await click(120);
                await q.waitTicks(2);
            }
            await q.waitTicks(12);
            await q.s.sdk.sendCloseModal();
            await q.waitUntil(() => q.has(ITEM.naphtha), 4);
            console.log(`STILL attempt ${attempt} naphtha=${q.has(ITEM.naphtha)} coal=${q.cnt(ITEM.coal)}`);
        }
        if (!q.has(ITEM.naphtha)) await q.fail('no naphtha');
        q.milestone('naphtha');
        // 8. The bomb (quest_regicide.rs2:717-788).
        await q.step('mix quicklime', () => q.useOnItem(ITEM.limeDust, ITEM.naphtha), () => q.has(ITEM.mixQ), 6, 3);
        await q.step('mix sulphur', () => q.useOnItem(ITEM.sulphurDust, ITEM.mixQ), () => q.has(ITEM.lid), 6, 3);
        await q.step('fuse', () => q.useOnItem(ITEM.cloth, ITEM.lid), () => q.has(ITEM.fused), 6, 3);
        await drop('still junk', [ITEM.tar, ITEM.barrel, ITEM.coal]);
        q.milestone('bomb');
        await q.teleport('ardougne teleport 1', 'magic:ardougne_teleport', 2661, 3301);
    }
    if (from('up2')) {
        await pass(2);
    }
    if (from('tir2')) {
        // 9. To the catapult clearing; the cooked rabbit to the lazy guard (regicide_tyras_lazy_guard.rs2:30-41) after the
        // last cross_over3 (a cross_over3 in map 34_49 clears the rabbit bit, quest_regicide.rs2:472-477); the fused
        // barrel on the catapult (12, :495-599).
        await tw('to catapult', LEG.E_CAMP);
        await q.walk('to lazy guard', [{ x: 2183, z: 3184, tol: 1 }]);
        // Three npc types share the name "Tyras guard"; the lazy one is type 1205 (npc.pack).
        const lazy = () => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === 1205).sort((a: any, b: any) => a.distance - b.distance)[0];
        // The rabbit leaves the pack on the guard's page after the bot's (regicide_tyras_lazy_guard.rs2:30-36).
        await q.step('rabbit', async () => {
            const g = lazy();
            if (!q.dialogOpen() && g) { await q.useOnNpc(ITEM.rabbit, g); await q.waitUntil(() => q.dialogOpen(), 12); }
            await q.converse([], () => !q.has(ITEM.rabbit), 8);
        }, () => !q.has(ITEM.rabbit), 4, 4);
        await q.converse([], () => !q.dialogOpen(), 20);
        await q.step('catapult', () => q.useOnLoc(ITEM.fused, q.findLoc((l: any) => l.id === CATAPULT.id) ?? CATAPULT), () => !q.has(ITEM.fused), 15, 3);
        await q.waitUntil(() => at(2183, 3185), 30);
        await q.waitTicks(4);
        q.milestone(12);
    }
    if (from('home')) {
        // 10. Iorwerth's message (13); the Ardougne teleport; Arianwyn in zone 2584-2591,3296-3303 (14); King Lathas.
        await tw('catapult to iorwerth', LEG.CAT_I);
        await q.talk('iorwerth 4', /^lord iorwerth$/i, [], () => q.has(ITEM.message), IORWERTH, 60);
        q.milestone(13);
        await q.teleport('ardougne teleport 2', 'magic:ardougne_teleport', 2661, 3301);
        // The zone fires on entry only; in proof trial 3 she never came (her spawn needs a free square in line of
        // sight, quest_regicide.rs2:798-800), so the bot steps out of the zone and in again.
        for (let k = 0; k < 4 && !q.sawText(/deliver your message, act normal/i); k++) {
            if (k > 0 && !q.npc(/^arianwyn$/i)) await goTo('out of arianwyn zone', 2595, 3297);
            await q.walk('to arianwyn zone', [{ x: 2589 - k, z: 3297, tol: 0 }]);
            for (let i = 0; i < 50 && !q.sawText(/deliver your message, act normal/i); i++) {
                if (q.dialogOpen()) await q.converse([], () => !q.dialogOpen(), 1);
                else if (i > 12 && !q.npc(/^arianwyn$/i)) break;
                await q.waitTicks(1);
            }
        }
        if (!q.sawText(/deliver your message, act normal/i)) await q.fail('no arianwyn');
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(14);
        await q.walk('to castle stairs', [{ x: CASTLE_STAIRS.x + 1, z: CASTLE_STAIRS.z, tol: 1 }]);
        await q.climb('castle stairs up', () => q.locAt(CASTLE_STAIRS.x, CASTLE_STAIRS.z) ?? CASTLE_STAIRS, /climb-up|^climb$|walk-up/i, () => q.lvl() === 1);
        await q.walk('to lathas door 2', [{ x: 2574, z: 3293, tol: 0 }]);
        await q.openDoor('lathas door 2', 2575, 3293);
        await q.talk('lathas 2', /^king lathas$/i, [], () => questDone, LATHAS, 120, true);
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(100);
        off();
        await q.end(questDone, 'qp=3');
    }
    off();
    await q.end(false, 'stage end');
} catch (e) { await q.fail(String(e)); }
