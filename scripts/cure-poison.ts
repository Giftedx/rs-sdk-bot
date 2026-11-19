// Cure poison: drinks one antipoison, from the pack or else from the nearest bank. Poison from the gang's daggers lasts
// until an antipoison is drunk or the account dies (it goes on through a logout), and the SDK state shows no poison flag,
// so a session that starts poisoned looks like an account whose Hitpoints fall with no fight. A kit step needs a constant
// Hitpoints level (scripts/microbot-owned-loadout.ts) and aborts on the first poison hit, so the cure runs first.
// Usage: bun scripts/cure-poison.ts <account>
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import { BANK_MEETS } from './coin-courier';
import { ITEMS } from './pk';
import { walkTarget } from './walk-to';

export type Row = { id: number; count: number };
const ANTIPOISON: readonly number[] = ITEMS.antipoison;
// ITEMS.antipoison lists each family from four doses down to one: [4, 3, 2, 1] twice.
export const dosesOf = (id: number): number => 4 - (ANTIPOISON.indexOf(id) % 4);

// The antipoison to drink: the pack first, else the bank; of several the one with the fewest doses (the partial potion
// goes before a full one).
export function chooseAntipoison(pack: readonly Row[], bank: readonly Row[]): { where: 'pack' | 'bank'; id: number } | null {
    for (const [where, rows] of [['pack', pack], ['bank', bank]] as const) {
        const held = rows.filter(r => ANTIPOISON.includes(r.id) && r.count > 0).sort((a, b) => dosesOf(a.id) - dosesOf(b.id))[0];
        if (held) return { where, id: held.id };
    }
    return null;
}

// The bank of BANK_MEETS nearest to a tile, with the tile beside its booth where a bank action works.
export function nearestBank(at: { x: number; z: number }) {
    const cheb = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - at.x), Math.abs(t.z - at.z));
    return [...BANK_MEETS].sort((a, b) => cheb(a.meet[0]) - cheb(b.meet[0]))[0]!;
}

export async function cureWithAntipoison(s: Session): Promise<{ ok: boolean; detail: string }> {
    const hp = () => s.sdk.getState()?.player?.hp ?? 0, held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    let choice = chooseAntipoison(s.sdk.getInventory(), []);
    if (!choice) {
        const p = s.sdk.getState()?.player, bank = nearestBank({ x: p?.worldX ?? 0, z: p?.worldZ ?? 0 });
        const walk = await walkTarget(s, bank.meet[0], false) as { ok: boolean; reason?: string; detail?: string };
        if (!walk.ok) return { ok: false, detail: `walk to the ${bank.bank} bank: ${walk.reason ?? ''} ${walk.detail ?? ''}`.trim() };
        if (!(await s.bot.openBank()).success) return { ok: false, detail: `the ${bank.bank} bank did not open` };
        choice = chooseAntipoison([], s.sdk.getBankItems());
        const row = choice ? s.sdk.getBankItems().find(r => r.id === choice!.id && r.count > 0) : undefined;
        if (!choice || !row) { await s.bot.closeBank(); return { ok: false, detail: 'no antipoison in the pack or in the bank' }; }
        await s.bot.withdrawItem(row, 1, { asNote: false });
        await s.bot.closeBank();
        if (!held(choice.id)) return { ok: false, detail: `the withdrawal of the antipoison ${choice.id} failed` };
    }
    const potion = s.sdk.getInventory().find(i => i.id === choice!.id), drink = potion?.optionsWithIndex?.find(o => /^drink$/i.test(o.text));
    if (!potion || !drink) return { ok: false, detail: `no Drink option on the antipoison ${choice.id}` };
    const hp0 = hp(), before = held(potion.id);
    await s.sdk.sendUseItem(potion.slot, drink.opIndex);
    const drunk = await waitUntil(s, () => held(potion.id) < before, { timeoutTicks: 8 });
    return drunk ? { ok: true, detail: `drank ${potion.name} from the ${choice.where} (hp ${hp0}, then ${hp()})` } : { ok: false, detail: `the ${potion.name} was not drunk` };
}

if (import.meta.main) {
    const [account] = process.argv.slice(2);
    if (!account) { console.log('RESULT fail usage: bun scripts/cure-poison.ts <account>'); process.exit(2); }
    const s = await openBot(account);
    try {
        const r = await cureWithAntipoison(s);
        await finish([s], r.ok, `cure-poison ${r.detail}`);
    } catch (e) { await finish([s], false, String(e)); }
}
