// Lockpick door benchmark: spam "Pick Lock" on one door for N ticks. Outside, it is a lock attempt (no stun or
// damage on a fail: skill_thieving/scripts/doors/locked_door.rs2:168); inside, the same option walks back out
// ("The door is already unlocked"). Usage: bun scripts/measure/door-bench.ts <bot> <x> <z> [ticks=300]
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const [bot, xs, zs, tArg] = process.argv.slice(2);
const DX = Number(xs), DZ = Number(zs), CAP = Number(tArg ?? 300);
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const xp0 = xp();
    const p0 = s.sdk.getState()!.player!;
    const OUT = { x: p0.worldX, z: p0.worldZ };
    const t0 = s.tick();
    let clicks = 0, picks = 0, noDoor = 0;
    while (s.tick() - t0 < CAP) {
        const door = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.x === DX && l.z === DZ && l.optionsWithIndex.some((o: any) => /pick lock/i.test(o.text)));
        // Open door after a success (no Pick Lock option): walk back out to the start tile through the open doorway.
        if (!door) { noDoor++; await s.sdk.sendWalk(OUT.x, OUT.z, true); await waitTicks(s, 1); continue; }
        const op = door.optionsWithIndex.find((o: any) => /pick lock/i.test(o.text))!.opIndex;
        const before = xp();
        await s.sdk.sendInteractLoc(door.x, door.z, door.id, op);
        clicks++;
        await waitTicks(s, 1);
        if (xp() > before) picks++;
    }
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE thieving ${gained} ${ticks}`);
    await finish([s], gained > 0, `door ${DX},${DZ} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} clicks=${clicks} picks=${picks} noDoor=${noDoor} lvl=${s.sdk.getSkill('Thieving')?.baseLevel}`);
} catch (e) { await finish([s], false, String(e)); }
