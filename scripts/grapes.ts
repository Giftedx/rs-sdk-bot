// Grape picker: the 1-grape spawn on the Cooks' Guild top floor (3144,3450,2), banked at Varrock west.
// Spawn: maps/m49_53.jm2:10243 (OBJ section, `2 8 58: 1987 1`); respawnrate=80 (wine.obj), scaled by
// (4000 - players) / 4000 (World.ts:1750, 2061-2065). Entry needs Cooking 32 and a worn chef's hat (cooking_guild.rs2).
// The "10 grapes at (2509,3493)" in older notes is loc 1987 = lograft_waterfall_quest (LOC section of m39_54.jm2).
// Preset grapes_cooksguild. Usage: bun scripts/grapes.ts <bot> [CAP ticks, default 1500] [BANK_AT grapes, default 26]
// (env CAP / BANK_AT also work when argv leaves them out).
// Prints RESULT with picks, the tick gaps between picks, and grapes per 1,000 ticks.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

const SPAWN = { x: 3144, z: 3450, level: 2 };
const DOOR_OUT = { x: 3143, z: 3443 }; // outside the chefdoor (3143,3444)
const BANK = { x: 3185, z: 3436 };      // Varrock west bank booths
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 1500);
const BANK_AT = Number(process.argv[4] ?? process.env.BANK_AT ?? 26);

const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const pos = () => s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const grapes = () => countItems(s, /^grapes$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;
    let hp0 = 0;
    let hpMin = 99;
    const off = s.onTick(() => { if (hp0 > 0) hpMin = Math.min(hpMin, hp()); });
    let picks = 0, banked = 0, bankTrips = 0, walkTicks = 0, waitTicksN = 0, tries = 0, lost = 0;
    const gaps: number[] = [];
    let lastPick = -1;
    const counters = () => `picks=${picks} banked=${banked} held=${grapes()} bankTrips=${bankTrips} tries=${tries} lost=${lost} walkTicks=${walkTicks} waitTicks=${waitTicksN} gaps=${gaps.join(',')} hpMin=${hpMin}`;
    const fail = async (why: string): Promise<never> => { off(); const p = pos(); return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${used()} ${counters()}`); };
    const guard = async () => { if (hp() < hp0) await fail(`hp loss ${hp0}->${hp()}`); };

    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) { console.log(`WALK fail ${r.detail} ticks=${r.ticks}`); await waitTicks(s, 1); }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };
    // Climbs one ladder or staircase and waits for the level change.
    const climb = async (re: RegExp, op: string, toLevel: number): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && pos()?.level !== toLevel && !over(); i++) {
            const loc = s.sdk.findNearbyLoc(re);
            if (!loc) { await waitTicks(s, 1); continue; }
            await s.bot.interactLoc(loc, op);
            await waitUntil(s, st => st?.player?.level === toLevel, { timeoutTicks: 10 });
        }
        walkTicks += s.tick() - a;
        return pos()?.level === toLevel;
    };
    const goUp = async () => {
        if ((pos()?.level ?? 0) === 0) {
            if (!(await walk(DOOR_OUT.x, DOOR_OUT.z, 0))) await fail('walk to guild door');
            // walkPath opens the chefdoor on the way in (needs Cooking 32 + chef's hat).
            if (!(await walk(3143, 3448, 1))) await fail('enter guild');
            if (!(await climb(/^staircase$/i, 'Climb-up', 1))) await fail('stairs up');
        }
        if (pos()?.level === 1 && !(await climb(/^ladder$/i, 'Climb-up', 2))) await fail('ladder up');
    };
    const goDown = async () => {
        if (pos()?.level === 2 && !(await climb(/^ladder$/i, 'Climb-down', 1))) await fail('ladder down');
        if (pos()?.level === 1 && !(await climb(/^staircase$/i, 'Climb-down', 0))) await fail('stairs down');
    };
    const bank = async () => {
        await goDown();
        if (!(await walk(BANK.x, BANK.z, 2))) await fail('walk to bank');
        const o = await s.bot.openBank();
        if (!o.success) await fail(`openBank ${o.message}`);
        const n = grapes();
        await s.bot.depositItem(/^grapes$/i, -1);
        await waitTicks(s, 1);
        banked += n - grapes();
        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        console.log(`MILESTONE bank ${used()} banked=${banked}`);
        await goUp();
    };

    await waitTicks(s, 2);
    hp0 = hp();
    hpMin = hp0;
    console.log(`HP start ${hp0}`);
    await goUp();
    console.log(`MILESTONE spawn ${used()}`);
    while (!over()) {
        await guard();
        if (grapes() >= BANK_AT) { await bank(); continue; }
        const p = pos();
        if (!p || p.level !== 2) { await goUp(); continue; }
        const g = s.sdk.getGroundItems().find((i: { name: string; x: number; z: number }) => /^grapes$/i.test(i.name) && i.x === SPAWN.x && i.z === SPAWN.z);
        if (!g) { waitTicksN++; await waitTicks(s, 1); continue; }
        tries++;
        const before = grapes();
        await s.bot.pickupItem(g);
        await waitTicks(s, 1);
        if (grapes() > before) {
            picks++;
            if (lastPick >= 0) gaps.push(used() - lastPick);
            lastPick = used();
        } else {
            // Another player took it, or the mirror still shows the taken obj: back off a few ticks.
            lost++;
            await waitTicks(s, 3);
        }
    }
    off();
    const total = picks;
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], picks > 0, `ticks=${used()} ${counters()} grapesPer1kTicks=${perK}`);
} catch (e) { await finish([s], false, String(e)); }
