// Pickpocket cycle test: after a failed pick, wait K ticks from the fail before the next try (K=1 is the
// generated scripts' behaviour). Usage: bun scripts/measure/pick-cycle.ts <bot> <npcRegex> <K> [ticks=300]
// The stun is 8 ticks after the fail (skill_thieving/scripts/thieving.rs2:49-50). Prints RATE and a cycle summary.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const [bot, re, kArg, tArg] = process.argv.slice(2);
const TARGET = new RegExp(`^${re}$`, 'i');
const K = Number(kArg ?? 1);
const CAP = Number(tArg ?? 300);
const FOOD = /lobster|bread|shrimps/i;
const s = await openBot(bot!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const eatAt = Math.ceil((s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10) / 2);
    const xp0 = xp();
    // EATSTUN=1: top up inside the 8-tick stun after each fail. Each eat adds 3 to %action_delay (consume.rs2:129-130), so it is not free.
    const eatStun = process.env.EATSTUN === "1";
    const maxHp = s.sdk.getSkill("Hitpoints")?.baseLevel ?? 10;
    const onFail = async () => {
        if (eatStun && hp() <= maxHp - 3 && countItems(s, FOOD) > 0 && (await s.bot.eatFood(FOOD)).success) eaten++;
        await waitTicks(s, K);
    };
    const t0 = s.tick();
    let ok = 0, fail = 0, other = 0, eaten = 0;
    const otherWhy: Record<string, number> = {};
    while (s.tick() - t0 < CAP) {
        if (hp() <= eatAt && countItems(s, FOOD) > 0) { if ((await s.bot.eatFood(FOOD)).success) eaten++; continue; }
        const npc = s.sdk.findNearbyNpc(TARGET, { reachable: true });
        if (!npc) { await waitTicks(s, 1); continue; }
        // DIRECT=1: the leader's rhythm (Jackalopett1, recorded): a pickpocket click every 2 ticks, sent
        // straight to the client. The server drops clicks that land in a stun, so no stun tracking is needed.
        if (process.env.DIRECT === '1') {
            const op = (npc as any).optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text))!.opIndex;
            const x1 = xp();
            await s.direct({ type: 'interactNpc', npcIndex: (npc as any).index, optionIndex: op, reason: 'SDK' });
            await waitTicks(s, 2);
            if (xp() > x1) ok++; else other++;
            continue;
        }
        const before = xp();
        const r = await s.bot.pickpocketNpc(npc);
        if (xp() > before) { ok++; continue; }
        if (/fail to pick|stunned/i.test(r.message ?? '') && r.reason !== 'stunned') { fail++; await onFail(); continue; }
        if (r.reason === 'stunned' || /stun/i.test(r.message ?? '')) { fail++; await onFail(); continue; }
        other++; otherWhy[r.reason ?? r.message ?? '?'] = (otherWhy[r.reason ?? r.message ?? '?'] ?? 0) + 1;
        await waitTicks(s, 1);
    }
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE thieving ${gained} ${ticks}`);
    await finish([s], gained > 0 && hp() > 0, `direct=${process.env.DIRECT === '1'} K=${K} eatStun=${eatStun} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} ok=${ok} fail=${fail} other=${other} ${JSON.stringify(otherWhy)} eaten=${eaten} hp=${hp()}`);
} catch (e) { await finish([s], false, String(e)); }
