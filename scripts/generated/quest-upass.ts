// Underground Pass from preset quest_upass (King Lathas's room, Ardougne castle level 1; every skill 99; Plague City
// and Biohazard done; shortbow, 5 iron arrows, tinderbox, rope, bucket and 14 lobsters from a helper). Reward: 5 QP,
// 30,000 Agility and 30,000 Attack XP before 25x (quests/quest_upass/scripts/quest_upass.rs2:798-801).
// Varps (quest_upass.constant): %upass (161) 1 Koftik, 2 the bridge, 3 the well, 4 the unicorn, 5 the main cavern,
// 6 Nilhoof, 7 the doll, 8 Iban's temple, 9 Iban dead, 10 complete; %ibanmulti (162) holds the bits (orbs, badges,
// doll elements) and the grid path in bits 22-31 (upass_grid.rs2:47-60).
// Every Agility and Thieving roll here is stat_random(skill, >=100, >=260) on 256, so at level 99 none fails.
// Server truth: quests/quest_upass/scripts/*.rs2, areas/area_ardougne_east/scripts/king_lathas.rs2:74-110.
// UP_FROM=<stage> starts at a debug preset (packages/practice/src/presets-long.ts).
import { openQuest } from './quest-lib';

const ITEM = { bow: 841, arrow: 884, unlit: 2532, lit: 2533, tinderbox: 590, rope: 954, bucket: 1925, cloth: 1485,
    orb1: 1481, orb2: 1482, orb3: 1483, orb4: 1484, railing: 1486, horn: 1487, badge1: 1488, badge2: 1489, badge3: 1490,
    cat: 1491, doll: 1492, gauntlets: 1495, dove: 1496, amuletO: 1497, amuletD: 1498, amuletH: 1499, shadow: 1500,
    brew: 1501, ashes: 1502, spade: 952, robeBottom: 1033, robeTop: 1035, scimitar: 1333 };
const LATHAS = { x: 2578, z: 3293 };
const KOFTIK1 = { x: 2436, z: 3315 };
const ENTRANCE = { id: 3213, x: 2433, z: 3313 };          // upass_caveentrance2, 4x2 (maps/m38_51.jm2)
const KOFTIK2 = { x: 2449, z: 9716 };
const ROPE = { id: 3340, x: 2443, z: 9718 };              // oldbridge_guiderope: shoot from x > 2443, z >= 9720
const SWING = { id: 2276, x: 2460, z: 9699 };             // rope on it: 2462,9699 -> 2466,9699 (upass_obstacles.rs2:94-131)
const LEVER = { id: 3337, x: 2466, z: 9672 };             // portcullis_lever_up (upass_bridge.rs2:81-123)
const HOLDS = { id: 3365, x: 2395, z: 9559 };             // upass_grilltrap_hand_holds in the spike pit -> 2477,9677

const FROM = process.env.UP_FROM ?? 'start';
const STAGES = ['start', 'bridge', 'grid', 'orbs', 'area2', 'paladins', 'main', 'witch', 'demons'];
const from = (s: string) => STAGES.indexOf(FROM) <= STAGES.indexOf(s);

const q = await openQuest({ cap: 9000, eatAt: 50 });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const x = () => q.pos()?.worldX ?? 0;
    const z = () => q.pos()?.worldZ ?? 0;
    const use = (id: number, op: number) => q.s.direct({ type: 'useInventoryItem', slot: q.slot(id)!, optionIndex: op, reason: 'SDK' });
    const wield = async (label: string, id: number) => {
        const op = (q.inv().find((i: any) => i.id === id)?.optionsWithIndex ?? []).find((o: any) => /wield|wear/i.test(o.text))?.opIndex ?? 2;
        await q.step(label, () => use(id, op), () => !q.has(id), 4, 3);
    };
    // Rockslide (rockslide2_obstacle_upass 3309): "Climb-over" steps to the far side (upass_obstacles.rs2:1-30).
    const slide = async (label: string, lx: number, lz: number) => {
        const n0 = q.msgCount(/step down the other side/i);
        await q.step(label, () => q.opLoc(q.locAt(lx, lz) ?? { id: 3309, x: lx, z: lz }, 1), () => q.msgCount(/step down the other side/i) > n0, 20, 4);
        await q.waitTicks(3);
    };

    const cross = async (label: string, lx: number, lz: number, id: number, op: RegExp, done: () => boolean, ticks = 15) => {
        await q.step(label, () => { const l = q.locAt(lx, lz) ?? q.findLoc((k: any) => k.id === id && Math.abs(k.x - lx) <= 1 && Math.abs(k.z - lz) <= 1) ?? { id, x: lx, z: lz }; return q.opLoc(l, q.opIndex(l, op)); }, done, ticks, 4);
        await q.waitTicks(1);
    };
    const pickup = async (label: string, id: number, gx?: number, gz?: number) => {
        if (gx !== undefined && gz !== undefined) await q.walk(`to ${label}`, [{ x: gx, z: gz, tol: 1 }]);
        for (let i = 0; i < 15 && !q.has(id); i++) {
            await q.guard(label);
            const g = (q.st()?.groundItems ?? []).filter((o: any) => o.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
            await q.waitTicks(1);
        }
        if (!q.has(id)) await q.fail(`pickup ${label}`);
    };
    // Attacks the nearest NPC matching re until it dies; then picks up `drop` (if given) from the floor.
    const kill = async (label: string, re: RegExp, drop?: number, home?: { x: number; z: number }) => {
        for (let i = 0; i < 6; i++) {
            await q.guard(label);
            let n = q.npc(re);
            if (!n && home) { await q.walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 4 }]); n = q.npc(re); }
            if (!n) { await q.waitTicks(2); continue; }
            await q.s.bot.attack(n as any);
            await q.waitUntil(() => !(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index), 80);
            if (!(q.st()?.nearbyNpcs ?? []).some((m: any) => m.index === n.index)) break;
        }
        await q.waitTicks(2);
        if (drop !== undefined) await pickup(label, drop);
    };
    // A broken bridge (bridgecollapsed1 3254 / bridgecollapsed2 3255, length 3): from the approach tile (ax, az) on
    // this side, "Cross" jumps to the far side (upass_obstacles.rs2:353-406).
    const bridge = async (label: string, lx: number, lz: number, ax: number, az: number) => {
        await q.walk(`${label} approach`, [{ x: ax, z: az, tol: 0 }]);
        const n0 = q.msgCount(/manage to cross safely/i);
        await cross(label, lx, lz, 3255, /cross/i, () => q.msgCount(/manage to cross safely/i) > n0, 25);
        await q.waitTicks(2);
    };

    if (from('start')) {
        // 1. King Lathas sets the started bit and the grid path (king_lathas.rs2:90-110). Ranged 25 needed (:94).
        await q.talk('lathas', /^king lathas$/i, [], () => q.sawText(/go meet my main tracker, koftik/i), LATHAS, 80);
        q.milestone('lathas');
        // His door (loc_1536 at 2575,3293, west edge, level 1), the stairs (stairstop at 2571,3295).
        await q.walk('to lathas door', [{ x: 2576, z: 3293, tol: 0 }]);
        await q.openDoor('lathas door', 2575, 3293);
        await q.climb('castle stairs', () => q.findLoc((l: any) => /stair/i.test(l.name) && l.distance <= 12), /climb-down|^climb$|walk-down/i, () => q.lvl() === 0);
        // The West Ardougne doors (ardougnewalldoor 2048/2049 at 2557-2558,3299-3300) open after Biohazard
        // (areas/area_ardougne_west/scripts/doors.rs2:24-40).
        await q.walk('to city doors', [{ x: 2559, z: 3300, tol: 1 }]);
        await q.step('city doors', () => { const d = q.findLoc((l: any) => /door/i.test(l.name) && l.x >= 2557 && l.x <= 2558 && l.z >= 3299 && l.z <= 3300); return d ? q.opLoc(d, q.opIndex(d, /open/i)) : q.waitTicks(1); }, () => x() <= 2556, 12, 4);
        await q.walk('to koftik', [{ x: KOFTIK1.x + 1, z: KOFTIK1.z, tol: 3 }]);
        // 2. Koftik: "I'll take my chances." sets 1 (koftik.rs2:34-57).
        await q.talk('koftik', /^koftik$/i, [/i'll take my chances/i], () => q.sawText(/catch up with you by the bridge/i), KOFTIK1, 60);
        q.milestone(1);
        await q.step('cave', () => q.opLoc(q.locAt(ENTRANCE.x, ENTRANCE.z) ?? ENTRANCE, 1), () => z() > 9000, 15, 4);
        // 3. Three rockslides west to the bridge (the swamp south of the entrance drops the bot into the lower cave).
        await slide('slide 1', 2478, 9721);
        await slide('slide 2', 2467, 9723);
        await slide('slide 3', 2460, 9720);
    }
    if (from('bridge')) {
        // 4. Koftik at the bridge gives the damp cloth (koftik.rs2:76-98); cloth on an arrow, the tinderbox on that
        // (upass_bridge.rs2:1-31, skill_firemaking/scripts/firemaking.rs2:15-17); bow and lit arrow worn; "Fire-at" the
        // guide rope from x > 2443, z >= 9720 drops the bridge and sets 2 (upass_bridge.rs2:33-79).
        await q.talk('koftik 2', /^koftik$/i, [/probably just litter/i], () => q.has(ITEM.cloth), KOFTIK2, 60);
        await q.step('cloth arrow', () => q.useOnItem(ITEM.arrow, ITEM.cloth), () => q.has(ITEM.unlit), 4, 3);
        await q.step('light arrow', () => q.useOnItem(ITEM.tinderbox, ITEM.unlit), () => q.has(ITEM.lit), 4, 3);
        await wield('bow', ITEM.bow);
        await wield('lit arrow', ITEM.lit);
        await q.walk('to shot', [{ x: 2447, z: 9722, tol: 0 }]);
        await q.step('shoot rope', () => q.opLoc(q.locAt(ROPE.x, ROPE.z) ?? ROPE, 1), () => x() <= 2442, 20, 3);
        await wield('scimitar', ITEM.scimitar);
        q.milestone(2);
        // 5. The rope on the hanging rock swings the bot east (upass_obstacles.rs2:94-131), then rockslides north-east
        // round to the spike grid.
        await q.walk('to swing', [{ x: 2462, z: 9699, tol: 1 }]);
        await q.step('swing', () => q.useOnLoc(ITEM.rope, q.locAt(SWING.x, SWING.z) ?? SWING), () => x() >= 2465, 15, 3);
        await slide('slide 4', 2491, 9691);
        await slide('slide 5', 2482, 9679);
        q.milestone('swing');
    }
    if (from('grid')) {
        // 6. The spike grid (zone 2467-2476, 9673-9682): 3 column pairs, each safe on one 2-row band; the path is
        // random per player and not sent to the client, so the bot finds it by trial: a wrong band drops it into the
        // pit (15 damage) and the hand holds put it back at 2477,9677 (upass_grid.rs2:62-106).
        const band = (r: number) => 9673 + 2 * (r - 1);
        const fell = () => z() < 9600;
        const climbOut = async () => {
            await q.waitTicks(2);
            await q.step('hand holds', () => q.opLoc(q.findLoc((l: any) => l.id === HOLDS.id) ?? HOLDS, 1), () => z() > 9600, 10, 4);
            await q.waitTicks(1);
        };
        // Walks the tiles one by one (no running: a 2-tile run step is checked only on its end tile); true if it fell.
        const tread = async (tiles: Array<[number, number]>): Promise<boolean> => {
            for (const [tx, tz] of tiles) {
                await q.guard('grid');
                for (let k = 0; k < 6 && !(x() === tx && z() === tz) && !fell(); k++) {
                    await q.s.direct({ type: 'walkTo', x: tx, z: tz, running: false, reason: 'SDK' });
                    await q.waitUntil(() => (x() === tx && z() === tz) || fell(), 4);
                }
                await q.waitTicks(1);
                if (fell()) return true;
                if (!(x() === tx && z() === tz)) await q.fail(`grid step ${tx},${tz}`);
            }
            await q.waitTicks(2);
            return fell();
        };
        const east = async (zz: number) => {
            if (fell()) await climbOut();
            for (let k = 0; k < 6 && !(x() === 2477 && z() === zz); k++) { await q.s.direct({ type: 'walkTo', x: 2477, z: zz, running: false, reason: 'SDK' }); await q.waitUntil(() => x() === 2477 && z() === zz, 8); }
        };
        // Column 1 band: x 2476..2474; column 3: x 2473..2470; column 5: x 2469..2467. A change of band is made on
        // the last tile of a column (x 2474, 2470), which lies in both columns' zones.
        const XS = [[2476, 2475, 2474], [2473, 2472, 2471, 2470], [2469, 2468, 2467]];
        const seg = (c: number, r: number, prev?: number): Array<[number, number]> => {
            const t: Array<[number, number]> = [];
            if (prev !== undefined && prev !== r) { const px = XS[c - 1]![XS[c - 1]!.length - 1]!; const d = r > prev ? 1 : -1; for (let zz = band(prev) + d; zz !== band(r) + d; zz += d) t.push([px, zz]); }
            for (const xx of XS[c]!) t.push([xx, band(r)]);
            return t;
        };
        const path: number[] = [];
        let falls = 0;
        for (let col = 0; col < 3; col++) {
            const prev = path[col - 1];
            const lo = prev === undefined ? 1 : Math.max(1, prev - 1), hi = prev === undefined ? 5 : Math.min(5, prev + 1);
            let found = 0;
            for (let r = lo; r <= hi && !found; r++) {
                if (fell() || x() > 2476) {
                    // Back on the known path from the east edge.
                    await east(band(path[0] ?? r));
                    let replay: Array<[number, number]> = [];
                    for (let c = 0; c < path.length; c++) replay = replay.concat(seg(c, path[c]!, path[c - 1]));
                    if (replay.length && await tread(replay)) await q.fail('grid replay fell');
                }
                if (await tread(seg(col, r, prev))) { falls++; console.log(`GRID col ${col + 1} band ${r} fell`); continue; }
                found = r;
            }
            if (!found) await q.fail(`grid col ${col + 1}`);
            path.push(found);
            console.log(`GRID col ${col + 1} = ${found} falls=${falls}`);
        }
        // Out west of the grid on the same row to x 2466 (outside the zone), down that column to the lever's tile.
        // A server-routed walk from the grid crosses wrong tiles (a trial fell at 2467,9677 on the way to the lever).
        const r3 = band(path[2]!);
        const out: Array<[number, number]> = [[2466, r3]];
        for (let zz = r3 - 1; zz >= 9673; zz--) out.push([2466, zz]);
        if (await tread(out)) await q.fail('grid exit fell');
        q.milestone('grid');
        // The lever lifts the portcullis and moves the bot to 2464,9677 (upass_bridge.rs2:81-123).
        await q.step('lever', () => q.opLoc(q.locAt(LEVER.x, LEVER.z) ?? LEVER, 1), () => x() <= 2464, 15, 3);
        q.milestone('portcullis');
    }
    if (from('orbs')) {
        // 7. The 4 orbs of light: orb 1 under the log trap's flat rock ("Search", disarm, upass_obstacles.rs2:214-232),
        // orbs 2-4 on the floor (maps/m37_151.jm2); each into the furnace (furnace_upass 3294 at 2454,9682,
        // skill_smithing/scripts/smelting/smelting.rs2:16-18, quest_upass.rs2:110-117); then the well (2416,9674) takes
        // the bot down to 2423,9660 and sets 3 (quest_upass.rs2:119-131).
        const pickup = async (label: string, id: number, gx: number, gz: number) => {
            await q.walk(`to ${label}`, [{ x: gx, z: gz, tol: 1 }]);
            for (let i = 0; i < 12 && !q.has(id); i++) {
                await q.guard(label);
                const g = (q.st()?.groundItems ?? []).find((o: any) => o.id === id);
                if (g && i % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
                await q.waitTicks(1);
            }
            if (!q.has(id)) await q.fail(`pickup ${label}`);
        };
        await pickup('orb 4', ITEM.orb4, 2416, 9698);
        await pickup('orb 2', ITEM.orb2, 2386, 9677);
        await pickup('orb 3', ITEM.orb3, 2385, 9685);
        await q.walk('to log trap', [{ x: 2383, z: 9669, tol: 1 }]);
        await q.step('orb 1', () => q.dialogOpen() ? q.converse([/yes, i'll give it a go/i], () => q.has(ITEM.orb1), 4) : q.opLoc(q.locAt(2382, 9668, /flat rock/i) ?? { id: 3339, x: 2382, z: 9668 }, 1), () => q.has(ITEM.orb1), 12, 5);
        q.milestone('orbs');
        await q.walk('to furnace', [{ x: 2454, z: 9683, tol: 2 }]);
        const FURNACE = { id: 3294, x: 2454, z: 9682 };
        for (const o of [ITEM.orb1, ITEM.orb2, ITEM.orb3, ITEM.orb4]) {
            await q.step(`furnace ${o}`, () => q.useOnLoc(o, q.findLoc((l: any) => l.id === FURNACE.id) ?? FURNACE), () => !q.has(o), 10, 3);
        }
        await q.walk('to well', [{ x: 2416, z: 9676, tol: 2 }]);
        await q.step('well', () => q.opLoc(q.findLoc((l: any) => l.id === 3264) ?? { id: 3264, x: 2416, z: 9674 }, 1), () => z() < 9665, 12, 3);
        q.milestone(3);
    }
    if (from('area2')) {
        // 8. The cells: the lock of the cell wall at 2393,9655 (cave_railings2, "Pick-lock", quest_upass.rs2:226-240);
        // the spade on the mud in the cell (upass_mud 2393,9650) drops the bot into the tunnel at 2392,9646 (:210-224);
        // west along it, the ledge (upass_ledge, level-1 bridge locs at 2374,9639-9644, "if x < loc x" refused) to
        // 2374,9638 (upass_obstacles.rs2:234-280); the two Thieving 50 cage doors (cave_railings5 2380,9619 and
        // 2404,9620, quest_upass.rs2:247-266); the pipe (upass_pipe6 2417,9605, west) to the unicorn's side
        // (upass_obstacles.rs2:316-350).
        await q.walk('to cell', [{ x: 2393, z: 9656, tol: 0 }]);
        await cross('cell lock', 2393, 9655, 3266, /pick|open/i, () => z() <= 9654);
        await q.step('mud', () => q.useOnLoc(ITEM.spade, q.findLoc((l: any) => l.id === 3216) ?? { id: 3216, x: 2393, z: 9650 }), () => z() <= 9647, 12, 3);
        await q.walk('to ledge', [{ x: 2375, z: 9644, tol: 0 }]);
        await cross('ledge', 2374, 9644, 3238, /.*/, () => z() <= 9639, 20);
        await q.walk('to cage door 1', [{ x: 2379, z: 9619, tol: 0 }]);
        await cross('cage door 1', 2380, 9619, 3268, /pick|open/i, () => x() >= 2381);
        await q.walk('to cage door 2', [{ x: 2403, z: 9620, tol: 0 }]); // west edge of 2404: through is x 2404
        await cross('cage door 2', 2404, 9620, 3268, /pick|open/i, () => x() >= 2404);
        await q.walk('to pipe', [{ x: 2419, z: 9605, tol: 0 }]);
        await cross('pipe', 2417, 9605, 3237, /.*/, () => x() <= 2413, 25);
        q.milestone('unicorn side');
        await q.walk('to cage', [{ x: 2397, z: 9606, tol: 1 }]);
        await q.step('railing', () => { const c = q.findLoc((l: any) => /^cage$/i.test(l.name) && l.z === 9605 && l.distance <= 5); return c ? q.opLoc(c, q.opIndex(c, /search/i)) : q.waitTicks(1); }, () => q.has(ITEM.railing), 10, 4);
        await q.walk('to boulder', [{ x: 2397, z: 9598, tol: 2 }]);
        await q.step('boulder', () => { const b = q.npc(/^boulder$/i); return b ? q.useOnNpc(ITEM.railing, b) : q.waitTicks(1); }, () => x() < 2385, 15, 3);
        await q.converse([], () => !q.dialogOpen(), 6);
        q.milestone(4);
        await q.walk('to smashed cage', [{ x: 2372, z: 9600, tol: 2 }]);
        await q.step('horn', () => q.opLoc(q.findLoc((l: any) => /smashed cage/i.test(l.name)) ?? { id: 3308, x: 2371, z: 9603 }, 1), () => q.has(ITEM.horn), 10, 3);
        await q.converse([], () => !q.dialogOpen(), 6);
        await q.walk('to tunnel 2', [{ x: 2375, z: 9610, tol: 1 }]);
        await q.step('tunnel 2', () => q.opLoc(q.findLoc((l: any) => (l.id === 3218 || l.id === 3219) && l.z === 9611 && l.x < 2380) ?? { id: 3219, x: 2375, z: 9611 }, 1), () => z() > 9660, 12, 3);
        q.milestone('paladins');
    }
    if (from('paladins')) {
        // 9. The 3 paladins (Sir Jerro, Sir Carl, Sir Harry, level 62, 2422-2426,9718-9721) each drop a coat of arms
        // (sir_jerro.rs2, sir_carl.rs2, sir_harry.rs2); the 3 coats and the horn into the well (bloodwell_upass
        // 2373,9718) unlock the skull door (quest_upass.rs2:348-388); the door (cavetempledoor2l 2368,9717) puts the
        // bot in the main cavern at 2173,4725,1 and sets 5 (:390-405).
        await kill('sir jerro', /^sir jerro$/i, ITEM.badge1, { x: 2424, z: 9719 });
        await kill('sir carl', /^sir carl$/i, ITEM.badge2, { x: 2422, z: 9718 });
        await kill('sir harry', /^sir harry$/i, ITEM.badge3, { x: 2426, z: 9718 });
        q.milestone('badges');
        await q.walk('to blood well', [{ x: 2375, z: 9719, tol: 2 }]);
        for (const o of [ITEM.horn, ITEM.badge1, ITEM.badge2, ITEM.badge3]) {
            await q.step(`well ${o}`, () => q.useOnLoc(o, q.findLoc((l: any) => l.id === 3305) ?? { id: 3305, x: 2373, z: 9718 }), () => !q.has(o), 10, 3);
        }
        await q.waitUntil(() => q.msgCount(/click from nearby/i) > 0, 5);
        await cross('skull door', 2368, 9717, 3220, /open/i, () => q.lvl() === 1, 15);
        q.milestone(5);
    }
    if (from('main')) {
        // 10. Down the tunnel (cavewalltunnel_upass_down 2150,4545,1 -> 2336,9794,0); Koftik, gone mad, talks
        // (quest_upass.rs2:407-415, koftik.rs2:146-158); Nilhoof gives food and sets 6 (nilhoof.rs2).
        await q.walk('to tunnel down', [{ x: 2150, z: 4547, tol: 2 }]);
        await cross('tunnel down', 2150, 4545, 3222, /descend/i, () => q.lvl() === 0, 15);
        await q.converse([], () => !q.dialogOpen(), 30);
        await q.talk('nilhoof', /^nilhoof$/i, [], () => q.msgCount(/gives you some food/i) > 0, { x: 2315, z: 9805 }, 60);
        q.milestone(6);
    }
    if (from('witch')) {
        // 11. Up the tunnel (2336,9793 -> 2150,4546,1); over the broken bridges (bridgecollapsed1/2 "Cross",
        // upass_obstacles.rs2:353-406) to the witch's cat (2131,4602, "Pick-up", kardia.rs2:42-61); the cat on the
        // witch's door (2158,4566) draws her off (kardia.rs2:28-36,69-78); the door, then the chest (2157,4564) gives
        // the doll, the journal and 2 potions and sets 7 (kardia.rs2:1-14,80-113).
        await cross('tunnel up', 2336, 9793, 3223, /ascend/i, () => q.lvl() === 1, 15);
        await bridge('bridge witch', 2156, 4582, 2159, 4582);
        await bridge('bridge cat', 2147, 4583, 2150, 4583);
        await q.step('cat', () => { const c = q.npc(/^witches cat$/i); return c ? q.s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: 1, reason: 'SDK' }) : q.walk('to cat', [{ x: 2131, z: 4602, tol: 4 }]); }, () => q.has(ITEM.cat), 20, 4);
        await bridge('bridge cat back', 2147, 4583, 2146, 4583);
        await q.walk('to witch door', [{ x: 2159, z: 4566, tol: 1 }]);
        await q.step('cat on door', () => q.useOnLoc(ITEM.cat, q.findLoc((l: any) => l.id === 3270) ?? { id: 3270, x: 2158, z: 4566 }), () => !q.has(ITEM.cat), 15, 3);
        await q.waitUntil(() => q.msgCount(/witch takes the cat inside/i) > 0, 12);
        // The drop walks the bot round the corner to 2157,4568 (kardia.rs2:69-78); the door (west edge of 2158,4566)
        // opens from 2158,4566 into the room (2155-2157,4565-4566).
        await q.walk('back to witch door', [{ x: 2158, z: 4566, tol: 0 }]);
        await cross('witch door', 2158, 4566, 3270, /open/i, () => x() <= 2157 && z() <= 4566, 12);
        await q.step('witch chest', () => q.dialogOpen() ? q.converse([], () => q.has(ITEM.doll), 3) : q.opLoc(q.findLoc((l: any) => l.id === 3272 || l.id === 3273) ?? { id: 3272, x: 2157, z: 4564 }, 1), () => q.has(ITEM.doll), 12, 4);
        await q.converse([], () => !q.dialogOpen(), 6);
        q.milestone(7);
    }
    if (from('demons')) {
        // 12. Out of the witch's room; the 3 demons (Doomion 2134,4565, Holthion 2132,4554, Othainian 2122,4562,
        // level 91) drop their amulets while %upass is 7 (doomion.rs2, holthion.rs2, othainian.rs2); the 3 amulets open
        // the chest (upassshutchest1 2136,4578) for Iban's shadow (quest_upass.rs2:524-545), poured on the doll
        // (:547-562).
        if (x() <= 2157 && z() <= 4566) await cross('witch door out', 2158, 4566, 3270, /open/i, () => x() >= 2158, 12);
        await bridge('bridge cat 2', 2147, 4583, 2150, 4583);
        await bridge('bridge demons', 2142, 4562, 2142, 4565);
        await kill('doomion', /^doomion$/i, ITEM.amuletD, { x: 2134, z: 4563 });
        await kill('holthion', /^holthion$/i, ITEM.amuletH, { x: 2133, z: 4556 });
        q.milestone('demons 2');
        await bridge('bridge demons back', 2142, 4562, 2142, 4561);
        await bridge('bridge west 1', 2127, 4592, 2130, 4592);
        console.log(`AT after west 1 ${x()},${z()}`);
        await bridge('bridge west 2', 2123, 4582, 2123, 4585);
        console.log(`AT after west 2 ${x()},${z()}`);
        await kill('othainian', /^othainian$/i, ITEM.amuletO, { x: 2123, z: 4562 });
        q.milestone('demons 3');
    }
    off();
    await q.end(false, 'stage end');
} catch (e) { await q.fail(String(e)); }
