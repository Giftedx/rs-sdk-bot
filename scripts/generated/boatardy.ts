// Travel Lumbridge -> Ardougne market (2654,3304,0) by boat: Port Sarim -> Musa Point -> Brimhaven -> Ardougne.
// Preset boat_ardougne (Lumbridge, 60 coins, 10 HP, no food). The land route kills a fresh account, so it sails.
// Fares and dialog text from lostcity-content sailors.rs2 and customs_officer.rs2 (30 coins each).
// Each ship lands on its deck (level 1); the "Gangplank" loc (op Cross) puts the bot back on level 0.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const MARKET = { x: 2654, z: 3304 };
const LUMBRIDGE = { x: 3222, z: 3218 };
const MUSA_DECK = { x: 2956, z: 3143 };
const ARDY_DECK = { x: 2683, z: 3268 };

console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const pos = () => s.sdk.getState()?.player;
    const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
    let hpMin = hp();
    let died = false;
    const jumps: string[] = [];
    let last = pos();
    // A boat trip also jumps more than 20 tiles, so only a jump that lands near the Lumbridge spawn (or HP 0) is a death.
    const off = s.onTick(() => {
        const p = pos();
        hpMin = Math.min(hpMin, hp());
        if (hp() <= 0) died = true;
        if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) {
            jumps.push(`${s.tick()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (cheb(LUMBRIDGE, p) <= 15) died = true;
        }
        last = p;
    });
    const t0 = s.tick();
    const fail = async (why: string): Promise<never> => {
        off();
        const p = pos();
        console.log(`TRAVEL ${s.tick() - t0} ${hpMin}`);
        return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} hpMin=${hpMin} died=${died} coins=${countItems(s, /^coins$/i)} jumps=${jumps.join(';')}`);
    };

    // Walks through waypoints; each waypoint gets up to 3 walkTo tries from wherever the bot is.
    const walk = async (points: [number, number, number][]): Promise<boolean> => {
        for (const [x, z, tol] of points) {
            for (let i = 0; i < 3 && !died; i++) {
                const p = pos();
                if (p && p.level === 0 && cheb({ x, z }, p) <= tol + 1) break;
                await s.bot.walkTo(x, z, tol);
            }
            const p = pos();
            if (died || !p || cheb({ x, z }, p) > tol + 1) return false;
        }
        return true;
    };

    // Answers a dialog: clicks the first option that matches a pattern, else "continue". Stops when done() holds.
    const converse = async (pats: RegExp[], done: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !died; i++) {
            if (done()) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return done();
    };

    // Crosses the deck gangplank to level 0 after a landing.
    const disembark = async (): Promise<boolean> => {
        for (let i = 0; i < 4 && !died; i++) {
            if (pos()?.level === 0) return true;
            const d = s.sdk.getDialog();
            if (d?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); continue; }
            const plank = s.sdk.findNearbyLoc(/^gangplank$/i);
            if (!plank) { await waitTicks(s, 2); continue; }
            await s.bot.interactLoc(plank, 'Cross');
            await waitUntil(s, st => st?.player?.level === 0, { timeoutTicks: 10 });
        }
        return pos()?.level === 0;
    };

    // Takes a ship: talks to the NPC, answers the dialog, waits for the landing on the deck near `deck`.
    const sail = async (npc: RegExp, pats: RegExp[], deck: { x: number; z: number }): Promise<boolean> => {
        const landed = () => { const p = pos(); return !!p && p.level === 1 && cheb(deck, p) <= 8; };
        for (let tryN = 0; tryN < 3 && !died && !landed(); tryN++) {
            const t = await s.bot.talkTo(npc);
            if (!t.success) { console.log(`TALK fail ${t.message}`); await waitTicks(s, 2); continue; }
            await converse(pats, landed, 60);
        }
        return landed();
    };

    // Leg 1: Lumbridge -> Port Sarim seamen (3028,3221 / 3026,3217) through Draynor.
    if (!(await walk([[3225, 3240, 3], [3180, 3258, 3], [3100, 3285, 3], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]]))) await fail('walk to Port Sarim');
    if (!(await sail(/^(seaman|captain tobias)/i, [/^yes please/i], MUSA_DECK))) await fail('sail to Karamja');
    if (!(await disembark())) await fail('Musa Point gangplank');

    // Leg 2: Musa Point -> Brimhaven customs officer (2772,3225-3231) along the Karamja road.
    if (!(await walk([[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]]))) await fail('walk to Brimhaven');
    if (!(await sail(/^customs officer$/i, [/journey on this ship/i, /search away/i, /^ok\.?$/i], ARDY_DECK))) await fail('sail to Ardougne');
    if (!(await disembark())) await fail('Ardougne gangplank');

    // Leg 3: Ardougne docks -> market.
    if (!(await walk([[2654, 3304, 3]]))) await fail('walk to market');

    off();
    const p = pos();
    const dist = p ? cheb(MARKET, p) : 999;
    const ticks = s.tick() - t0;
    console.log(`TRAVEL ${ticks} ${hpMin}`);
    const ok = !!p && p.level === 0 && dist <= 10 && !died;
    await finish([s], ok, `at=${p?.worldX},${p?.worldZ},${p?.level} dist=${dist} ticks=${ticks} hpMin=${hpMin} died=${died} coins=${countItems(s, /^coins$/i)} jumps=${jumps.join(';')}`);
} catch (e) { await finish([s], false, String(e)); }
