// Kit buy template builders, proportional batch sizing, progressive weapon/bow/ammo/armour/tool staging.
import type { CombatFocus } from '../../gear-progression';
import { ARMOUR_BAND, RANGED_ARMOUR_BAND, pairKey, questDone, type Acct, type Inputs, type KitLine, type KitStage, type Template } from '../world';
import {
    AMMO_STAGE, ARROWS, AXE_LADDER, BOWS, BOW_STAGE, DHIDE_ARMOUR_BAND, KIT_BUY, KIT_BUY_SCRIPT,
    KIT_CASH_RESERVE, KIT_COIN_MARGIN, PICKAXE_LADDER, RUNE_ARMOUR_BAND, WEAPON, WEAPON_STAGES,
} from '../pricing';
import { SKILL_STYLE, accountStyle } from './needs';

// A batch of several lines that the account cannot pay in full: the same share of every line's batch that the coins reach, never under
// the line's start. The cost counts each line at its price cap (`limit`). With less than the start it returns the start.
export function proportionalLines(full: readonly KitLine[], start: readonly KitLine[], budget: number): KitLine[] {
    const cost = (lines: readonly KitLine[]) => lines.reduce((n, l) => n + l.quantity * l.limit, 0), floor = cost(start);
    if (budget <= floor) return [...start];
    const extra = cost(full) - floor;
    if (extra <= 0) return [...start];
    const share = Math.min(1, (budget - floor) / extra);
    return full.map((l, i) => ({ ...l, quantity: start[i]!.quantity + Math.floor((l.quantity - start[i]!.quantity) * share) }));
}
// The job that buys an army account's missing kit for a goal band: one login, one capped order per item
// (scripts/chain.ts runs scripts/buy-owned-ge-item.ts once per line). The buy script keeps one journal per order key
// and never buys again under a settled key. The key names the account's kit-buy count (`seq`, which
// scripts/autopilot.ts raises when the account leaves a kit buy) and the holding before and after: a rerun of one buy
// continues its order, and a later top-up from the same holding is a new order. Not a trainer: it does not repeat, and
// the account takes the band on the pass after its RESULT.
export function kitBuyTemplate(band: Template, account: string, lines: readonly KitLine[], seq = 0, cashReserve = KIT_CASH_RESERVE): Template {
    const step = (l: KitLine) => [KIT_BUY_SCRIPT, 'ge-buy', `ITEM_ID=${l.id}`, `QUANTITY=${l.quantity}`, ...(l.held > 0 ? [`EXPECTED_OWNED=${l.held}`] : []), `LIMIT_PRICE=${l.limit}`,
        `CASH_RESERVE=${cashReserve}`, `ORDER_KEY=${account.toLowerCase()}-kit${seq}-${l.id}-${l.held}to${l.held + l.quantity}`, 'ORDER_MS=900000', 'FILL_WAIT_TICKS=200'].join(' ');
    return { id: KIT_BUY + band.id, family: 'kit-buy', script: 'scripts/chain.ts', args: lines.map(step), env: { ROUNDS: '1' }, role: 'supply',
        goal: `buy ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} on the Grand Exchange to ${band.goal}`, repeats: false, yields: () => [] };
}

const hasMarket = (inp: Inputs, item: string) => !!inp.market?.[item];
const hasStock = (inp: Inputs, item: string) => !!(inp.stock ?? []).some(s => (s.items[item] ?? 0) > 0);
export function weaponStageFor(a: Acct, inp: Inputs): { id: string; item: string; goal: string } | null {
    const att = a.skills.Attack ?? 1;
    for (const s of WEAPON_STAGES) {
        if (att < s.attack || (s.quest && !questDone(a, s.quest))) continue;
        if (s.held.some(w => (a.items[w] ?? 0) > 0)) return null;
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + s.id));
        const choices = [s.item, ...(s.fallbacks ?? [])];
        const available = choices.find(c => hasStock(inp, c) || (!buyRetired && hasMarket(inp, c)));
        if (available) return { id: s.id, item: available, goal: s.goal };
        if (s.id === WEAPON.id && !buyRetired) return { id: s.id, item: s.item, goal: s.goal };
    }
    return null;
}
// The kit stages follow the style that the account trains: a ranged trainer gets a bow, arrows and dragonhide, never
// the melee blade and rune armour (rune armour costs Ranged accuracy); a magic trainer gets no kit stage, so the gear pass
// (gear-want-jobs.ts) buys its staff and robes. An account with no band left keeps the melee kit and the dragonhide.
export type KitStyles = { melee: boolean; ranged: boolean };
const KIT_STAGE_STYLE: Readonly<Record<string, CombatFocus>> = Object.fromEntries([...WEAPON_STAGES.map(s => [s.id, 'melee']),
    [RUNE_ARMOUR_BAND, 'melee'], [DHIDE_ARMOUR_BAND, 'ranged'], [BOW_STAGE, 'ranged'], [AMMO_STAGE, 'ranged']] as [string, CombatFocus][]);
export function kitStyle(a: Acct, inp: Pick<Inputs, 'templates' | 'current' | 'running'>, bands: readonly { template: Template; lacks?: unknown }[] = []): CombatFocus | null {
    const lower = a.name.toLowerCase(), now = inp.current?.get(lower);
    // A kit buy that runs keeps the style of its own stage, so the account does not change its buy when its band changes.
    // A finished bow buy leads on to its arrows and dragonhide. A finished melee buy does not lead on to the rest of the rune
    // set: an account that left its melee band takes the style of its next band.
    const stage = now?.startsWith(KIT_BUY) ? KIT_STAGE_STYLE[now.slice(KIT_BUY.length)] : undefined;
    if (stage && (stage === 'ranged' || inp.running?.has(lower))) return stage;
    // The band that it runs now.
    const own = accountStyle(a, inp.templates, now, false);
    if (own) return own;
    // Else the first combat band that it can start now (its needs are met, or a kit buy supplies them), the one with no missing
    // kit first: a band whose level it lacks is no candidate, so a Magic 1 account is not a magic trainer for the Magic band
    // alone. `bands` are the goal candidates of the pass in band order.
    const combat = bands.filter(c => c.template.trains && SKILL_STYLE[c.template.trains.skill] && !c.template.filler);
    const first = combat.find(c => !c.lacks) ?? combat[0];
    if (first) return SKILL_STYLE[first.template.trains!.skill]!;
    return accountStyle(a, inp.templates, now, true);
}
export const kitStylesOf = (style: CombatFocus | null): KitStyles => ({ melee: style === null || style === 'melee', ranged: style === null || style === 'ranged' });
// The shortbows by Ranged level, the highest first (a shortbow fires faster than a longbow of its level).
const bowLadder = () => BOWS.filter(([bow]) => bow.endsWith('shortbow')).sort((x, y) => y[1] - x[1]);
// The Ranged level of the best bow that the account owns and can wear, or 0.
const ownedBowLevel = (a: Acct) => Math.max(0, ...BOWS.filter(([bow, level]) => level <= (a.skills.Ranged ?? 1) && (a.items[bow] ?? 0) > 0).map(([, level]) => level));
// A bow upgrade for a Ranged account: the best shortbow for its Ranged level that a market or owned stock supplies, unless it
// owns a bow of that level or better.
export function bowStageFor(a: Acct, inp: Inputs): (KitStage & { level: number }) | null {
    const ranged = a.skills.Ranged ?? 1, owned = ownedBowLevel(a), buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + BOW_STAGE));
    for (const [bow, level] of bowLadder()) {
        if (ranged < level) continue;
        if (owned >= level) return null;
        if (hasStock(inp, bow) || (!buyRetired && hasMarket(inp, bow))) return { id: BOW_STAGE, goal: `fire a ${bow}`, level, items: [{ item: bow, count: 1 }] };
    }
    return null;
}
// Arrows for the bow the account fires: the best tier that the bow and the Ranged level allow and that its coins pay for in
// a batch (a consumable, so a margin stays), unless it holds a stock of that tier or better. `bowLevel` is the level of the bow
// it will wield.
// The arrows are a consumable and the stage buys again when they run low, so it is bounded: it fires only when the account holds
// under AMMO_LOW arrows of the tier or better (a bought batch of AMMO_BATCH lasts hundreds of thousands of Ranged experience:
// the band loses 0.67 to 2.02 arrows per 1,000 experience), it never replaces a running band (its place is AMMO_MARKET, not the
// weapon market), and a batch at the price caps may cost at most half of the account's coins.
export const AMMO_BATCH = 300, AMMO_LOW = 50;
export function ammoStageFor(a: Acct, inp: Inputs, bowLevel: number): KitStage | null {
    const top = Math.min(a.skills.Ranged ?? 1, bowLevel), buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + AMMO_STAGE));
    // Bronze arrows are the Ranged band's own kit (its batch), so a stage never orders them.
    for (const [arrow, tier] of [...ARROWS].reverse().sort((x, y) => y[1] - x[1])) {
        if (tier > top || arrow === 'bronze arrow') continue;
        const held = ARROWS.filter(([, t]) => t >= tier && t <= top).reduce((n, [name]) => n + (a.items[name] ?? 0), 0);
        if (held >= AMMO_LOW) return null;
        const count = AMMO_BATCH - held, quote = inp.market?.[arrow];
        if (hasStock(inp, arrow) || (!buyRetired && quote && count * quote.limit + KIT_CASH_RESERVE + KIT_COIN_MARGIN <= (a.items.coin ?? 0) && count * quote.limit * 2 <= (a.items.coin ?? 0)))
            return { id: AMMO_STAGE, goal: `fire ${arrow}s`, items: [{ item: arrow, count }] };
    }
    return null;
}
// Every bow and arrow stage of an account that trains Ranged, in the order that they buy: the bow first, then the arrows
// that the new bow fires.
export function rangedStagesFor(a: Acct, inp: Inputs): KitStage[] {
    const bow = bowStageFor(a, inp), ammo = ammoStageFor(a, inp, Math.max(ownedBowLevel(a), bow?.level ?? 0));
    return [...(bow ? [bow] : []), ...(ammo ? [ammo] : [])];
}
export function armourItemsFor(a: Acct, inp: Inputs, styles: KitStyles = { melee: true, ranged: true }): { id: string; band: number; items: string[]; goal: string }[] {
    const out: { id: string; band: number; items: string[]; goal: string }[] = [];
    if (styles.melee && (a.skills.Defence ?? 1) >= 40) {
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + RUNE_ARMOUR_BAND));
        const torso = questDone(a, 'Dragon Slayer') ? 'rune platebody' : 'rune chainbody';
        const heldTorso = (a.items['rune platebody'] ?? 0) > 0 || (!questDone(a, 'Dragon Slayer') && (a.items['rune chainbody'] ?? 0) > 0);
        const need = [
            ...(heldTorso ? [] : [torso]),
            ...((a.items['rune plateleg'] ?? 0) > 0 || (a.items['rune plateskirt'] ?? 0) > 0 ? [] : ['rune plateleg']),
            ...((a.items['rune full helm'] ?? 0) > 0 ? [] : ['rune full helm']),
            ...((a.items['rune kiteshield'] ?? 0) > 0 ? [] : ['rune kiteshield']),
        ].filter(item => hasStock(inp, item) || (!buyRetired && hasMarket(inp, item)));
        if (need.length) out.push({ id: RUNE_ARMOUR_BAND, band: ARMOUR_BAND, items: need, goal: 'wear rune armour' });
    }
    if (styles.ranged && (a.skills.Ranged ?? 1) >= 40) {
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + DHIDE_ARMOUR_BAND));
        const bodyReady = (a.skills.Defence ?? 1) >= 40 && questDone(a, 'Dragon Slayer');
        const need = [
            ...(bodyReady && !(a.items['dragonhide body'] ?? 0) ? ['dragonhide body'] : []),
            ...((a.items['dragonhide chap'] ?? 0) > 0 ? [] : ['dragonhide chap']),
            ...((a.items['dragon vambrace'] ?? 0) > 0 ? [] : ['dragon vambrace']),
        ].filter(item => hasStock(inp, item) || (!buyRetired && hasMarket(inp, item)));
        if (need.length) out.push({ id: DHIDE_ARMOUR_BAND, band: RANGED_ARMOUR_BAND, items: need, goal: 'wear green dragonhide armour' });
    }
    return out;
}
export function toolUpgradeNeed(a: Acct, routeDemand: ReadonlySet<string>): string | null {
    const miningDemand = ['iron ore', 'mithril bar', 'adamantite bar', 'steel bar', 'rune essence', 'coal'].some(x => routeDemand.has(x));
    const wcDemand = ['yew log', 'maple log', 'yew shortbow', 'magic log', 'magic logs', 'magic shortbow', 'unstrung magic shortbow', 'arrow shaft'].some(x => routeDemand.has(x));
    if (miningDemand) {
        const mining = a.skills.Mining ?? 1;
        for (const [lvl, item] of PICKAXE_LADDER) {
            if (mining < lvl) continue;
            if (PICKAXE_LADDER.filter(([l]) => l >= lvl).some(([, p]) => (a.items[p] ?? 0) > 0)) break;
            return item;
        }
    }
    if (wcDemand && (a.skills.Woodcutting ?? 1) >= 60) {
        const wc = a.skills.Woodcutting ?? 1;
        for (const [lvl, item] of AXE_LADDER) {
            if (wc < lvl) continue;
            if (AXE_LADDER.filter(([l]) => l >= lvl).some(([, x]) => (a.items[x] ?? 0) > 0)) break;
            return item;
        }
    }
    return null;
}
