// Eat to full: eats the meals in the pack, cheapest first, until the hitpoints reach the base level (or AT=<level>) or
// the pack holds no meal. The session eat guard eats only in a fight, so an account with few hitpoints stays at that
// level out of combat until it eats. Usage: bun scripts/eat-to-full.ts <account> [AT=<level>] (an argument or the AT
// environment variable, which .practice/mock-run/run.ts sets from a KEY=value argument).
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';

// Meals by hitpoints healed (consume_effects.dbrow): trout 7, salmon 9, tuna 10, lobster 12, swordfish 14, shark 20.
export const MEALS_BY_HEAL: readonly { id: number; heal: number }[] = [
    { id: 333, heal: 7 }, { id: 329, heal: 9 }, { id: 361, heal: 10 }, { id: 379, heal: 12 }, { id: 373, heal: 14 }, { id: 385, heal: 20 },
];

// The next meal to eat: the cheapest one in the pack whose heal does not waste more than half of itself, else the
// cheapest at all (the last bite to full).
export function nextMeal(pack: readonly { id: number }[], missing: number): number | undefined {
    const held = MEALS_BY_HEAL.filter(m => pack.some(i => i.id === m.id));
    return (held.find(m => m.heal <= missing * 2) ?? held[0])?.id;
}

// The AT level from an `AT=<level>` argument, else from the AT environment variable; undefined for none.
export function parseAt(args: readonly string[], env: string | undefined): number | undefined {
    const text = args.find(a => /^AT=\d+$/.test(a))?.slice(3) ?? env;
    if (text === undefined || text === '') return undefined;
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1 || n > 99) throw Error(`AT=${text} is not a level from 1 to 99`);
    return n;
}

export async function eatToFull(s: Session, target?: number): Promise<{ ok: boolean; eaten: number; hp: number; detail: string }> {
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0, base = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const want = Math.min(target ?? base(), base());
    let eaten = 0;
    for (let i = 0; i < 28 && hp() < want; i++) {
        const id = nextMeal(s.sdk.getInventory(), want - hp());
        if (id === undefined) break;
        const item = s.sdk.getInventory().find(x => x.id === id)!;
        const before = hp(), count = s.sdk.getInventory().filter(x => x.id === id).length;
        try { await s.bot.eatFood(item); } catch { /* the HP and pack below decide */ }
        if (await waitUntil(s, () => hp() > before || s.sdk.getInventory().filter(x => x.id === id).length < count, { timeoutTicks: 6 })) eaten++;
    }
    return { ok: hp() >= want, eaten, hp: hp(), detail: `hp ${hp()} of ${want} after ${eaten} meals` };
}

if (import.meta.main) {
    const [account] = process.argv.slice(2);
    if (!account) { console.log('RESULT fail usage: bun scripts/eat-to-full.ts <account> [AT=<level>]'); process.exit(2); }
    let at: number | undefined;
    try { at = parseAt(process.argv.slice(3), process.env.AT); } catch (e) { console.log(`RESULT fail ${String(e)}`); process.exit(2); }
    const s = await openBot(account);
    try {
        const r = await eatToFull(s, at);
        await finish([s], r.ok, `eat-to-full ${r.detail}`);
    } catch (e) { await finish([s], false, String(e)); }
}
