// Needs analysis, kit/style staging, finite route/army/squad demand synthesis, and pure planning orchestration.
import { ownsWearableMeleeWeapon, type CombatFocus } from '../gear-progression';
import { GEAR_GE_ID, GEAR_GE_PILOT, GEAR_SHOP_PILOT, gearJobFor, gearShopId } from '../gear-want-jobs';
import { SQUAD_FOOD_HEAL, squadKeeps, squadRows, squadTarget } from '../squad';
import {
    AMMO_MARKET, ARMOUR_BAND, ARMOUR_MARKET, ARMY_BANK, PLACES, RANGED_ARMOUR_BAND, WEAPON_BAND, WEAPON_MARKET,
    bandLeft, combatLevel, meetFor, norm, pairKey, placeOf, questDone, wayCost, withFare,
    type Acct, type Assignment, type Funding, type GoalNeed, type Inputs, type KitLine, type KitStage, type Lack, type Stock, type Template,
} from './world';
import {
    ARROWS, AXE_LADDER, BOWS, BOW_STAGE, AMMO_STAGE, COW_WEAPONS, DHIDE_ARMOUR_BAND, FEEDS, FOOD_HEAL, FUND_RESERVE,
    KIT_BUY, KIT_BUY_SCRIPT, KIT_CASH_RESERVE, KIT_COIN_MARGIN, KIT_PRICE_CAPS, OBSERVATION_FRESH_MS,
    PICKAXE_LADDER, PILOT_FALLBACK_SHARE, RUNE_ARMOUR_BAND, SHOP_SUPPLIED, SQUAD_UNIT_COST, TRAIN_SHARE, VALUE_TICKS,
    WEAPON, WEAPON_STAGES, billUnits, feedUnits, foodHeal, jobValue, selfServePilot, specialistStagingNeeds, usableTool,
} from './pricing';
import { FRAIL_FOOD_BUY, FRAIL_FOOD_BUY_ID, buildBand } from './catalogue';
import { SQUAD_RESTOCK, exactItemIds } from './claims';

// The combat style an account trains, for its gear wants: the style of the band it runs now, else of the next army band it has levels
// left in (the lowest band number first). An account off the army with no such job, or with no band left, has none.
const SKILL_STYLE: Readonly<Record<string, CombatFocus>> = { Attack: 'melee', Strength: 'melee', Defence: 'melee', Hitpoints: 'melee', Ranged: 'ranged', Magic: 'magic' };
export function accountStyle(a: Acct, templates: readonly Template[], currentId: string | undefined, army: boolean): CombatFocus | null {
    const own = templates.find(t => t.id === currentId)?.trains?.skill;
    if (own && SKILL_STYLE[own]) return SKILL_STYLE[own]!;
    if (!army) return null;
    const next = templates.filter(t => t.tier === 'goal' && !t.filler && t.trains && SKILL_STYLE[t.trains.skill] && bandLeft(t, a) > 0).sort((x, y) => (x.band ?? 0) - (y.band ?? 0) || x.id.localeCompare(y.id))[0];
    return next?.trains ? SKILL_STYLE[next.trains.skill]! : null;
}

const isShort = (a: Acct, needs: Template['needs']) => (!needs?.shortOf || Object.entries(needs.shortOf).some(([i, n]) => (a.items[norm(i)] ?? 0) < n))
    && Object.entries(needs?.holds ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n);
// The gear check selects a whole loadout, so it is cached for the holdings object of an account (one per plan input) and
// the levels and quests that it reads.
const meleeCache = new WeakMap<object, Map<string, boolean>>();
const ownsMelee = (a: Acct): boolean => {
    const key = `${a.skills.Attack ?? 1}|${a.skills.Strength ?? 1}|${[...(a.quests ?? [])].join(',')}`;
    let by = meleeCache.get(a.items);
    if (!by) meleeCache.set(a.items, by = new Map());
    let owned = by.get(key);
    if (owned === undefined) by.set(key, owned = ownsWearableMeleeWeapon(a.items, a.skills, a.quests));
    return owned;
};
const weaponLine = (a: Acct): Lack => ({ of: COW_WEAPONS.filter(([, attack]) => (a.skills.Attack ?? 1) >= attack).map(([item]) => item), count: 1 });
const frailShort = (a: Acct, needs: Template['needs']) => !needs?.frail || (a.skills.Hitpoints ?? 10) >= needs.frail.hitpoints ? 0
    : Math.max(0, needs.frail.count - needs.frail.of.reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0));
const healthMet = (a: Acct, needs: Template['needs']) => !needs?.hpAboveHalf
    || (Number.isFinite(a.currentHP) && a.currentHP! > Math.ceil((a.skills.Hitpoints ?? 10) / 2));
const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }): boolean =>
    (a.combat ?? combatLevel(a.skills)) >= (needs?.combat ?? 0)
    && healthMet(a, needs)
    && (!needs?.meleeWeapon || ownsMelee(a))
    && (needs?.quests ?? []).every(q => questDone(a, q))
    && (a.questPoints ?? 0) >= (needs?.questPoints ?? 0)
    && frailShort(a, needs) === 0
    && Object.entries(needs?.skills ?? {}).every(([s, l]) => (skillOverride?.skill === s ? Math.max(skillOverride.to, a.skills[s] ?? 1) : a.skills[s] ?? 1) >= l)
    && Object.entries(needs?.items ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n)
    && Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
    && Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n)
    && isShort(a, needs)
    && foodHeal(a) >= (needs?.food ?? 0)
    && (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0) >= (needs?.pieces?.count ?? 0)
    && (needs?.anyOf === undefined || needs.anyOf.some(alt => meets(a, alt, skillOverride)));
// The coins a template needs beyond what the account holds, and its needs without the coin line.
const coinShort = (a: Acct, needs: Template['needs']) => Math.max(0, (Object.entries(needs?.items ?? {}).find(([i]) => norm(i) === 'coin')?.[1] ?? 0) - (a.items.coin ?? 0));
const withoutCoins = (needs: Template['needs']): Template['needs'] => ({ ...needs, items: Object.fromEntries(Object.entries(needs?.items ?? {}).filter(([i]) => norm(i) !== 'coin')) });

// What an account still lacks of these needs, each as a short phrase: a level, a quest, a holding. The coin line and
// holdings that a purchase fixes are listed too, so a vacant slot names the first thing that stops its template.
export function unmet(a: Acct, needs: Template['needs']): string[] {
    if (!needs) return [];
    const out: string[] = [];
    const combat = a.combat ?? combatLevel(a.skills);
    if (combat < (needs.combat ?? 0)) out.push(`combat ${needs.combat}`);
    for (const q of needs.quests ?? []) if (!questDone(a, q)) out.push(`quest ${q}`);
    if ((a.questPoints ?? 0) < (needs.questPoints ?? 0)) out.push(`${needs.questPoints} quest points`);
    for (const [s, l] of Object.entries(needs.skills ?? {})) if ((a.skills[s] ?? 1) < l) out.push(`${s} ${l}`);
    for (const [s, l] of Object.entries(needs.under ?? {})) if ((a.skills[s] ?? 1) >= l) out.push(`${s} under ${l}`);
    for (const [i, n] of Object.entries(needs.items ?? {})) if ((a.items[norm(i)] ?? 0) < n) out.push(`${n - (a.items[norm(i)] ?? 0)} ${norm(i)}`);
    for (const [i, n] of Object.entries(needs.holdsUnder ?? {})) if ((a.items[norm(i)] ?? 0) >= n) out.push(`fewer than ${n} ${norm(i)}`);
    for (const [i, n] of Object.entries(needs.holds ?? {})) if ((a.items[norm(i)] ?? 0) < n) out.push(`${n} ${norm(i)} from its own job`);
    if (needs.shortOf && !isShort(a, { shortOf: needs.shortOf })) out.push(`to be short of ${Object.keys(needs.shortOf).join(' or ')}`);
    if (needs.pieces) { const n = needs.pieces.count - needs.pieces.of.reduce((sum, i) => sum + (a.items[norm(i)] ?? 0), 0); if (n > 0) out.push(`${n} of ${needs.pieces.of.join('/')}`); }
    if (needs.meleeWeapon && !ownsMelee(a)) out.push('a wearable melee weapon');
    if (foodHeal(a) < (needs.food ?? 0)) out.push(`${needs.food} HP of food`);
    if (!healthMet(a, needs)) out.push('current Hitpoints above half');
    if (frailShort(a, needs) > 0) out.push(`${frailShort(a, needs)} of ${needs.frail!.of.slice(0, 3).join('/')}`);
    if (needs.anyOf && !needs.anyOf.some(alt => meets(a, alt))) {
        const alts = needs.anyOf.map(alt => unmet(a, alt)).sort((x, y) => x.length - y.length);
        out.push(...(alts[0] ?? []));
    }
    return out;
}
// The kit lines an account still lacks for these needs, or null when a level it does not have (or a holding it must
// not have) stops the job: no item fixes that. The coin line is not a kit line (coinShort). Of several `anyOf`
// kits the account takes one whose every line it `can` get (a buy: 250 fire runes, not a fire staff no market sells),
// then the one with the fewest missing units.
export function kitLacks(a: Acct, needs: Template['needs'], can: (item: string, count: number) => boolean = () => true): Lack[] | null {
    if (!healthMet(a, needs) || (a.combat ?? combatLevel(a.skills)) < (needs?.combat ?? 0) || !(needs?.quests ?? []).every(q => questDone(a, q))
        || (a.questPoints ?? 0) < (needs?.questPoints ?? 0)
        || !Object.entries(needs?.skills ?? {}).every(([s, l]) => (a.skills[s] ?? 1) >= l)
        || !Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
        || !Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n) || !isShort(a, needs)) return null;
    const out: Lack[] = [];
    for (const [i, n] of Object.entries(needs?.items ?? {})) {
        const short = n - (a.items[norm(i)] ?? 0);
        if (norm(i) !== 'coin' && short > 0) out.push({ of: [norm(i)], count: short });
    }
    if (needs?.meleeWeapon && !ownsMelee(a)) out.push(weaponLine(a));
    const hp = (needs?.food ?? 0) - foodHeal(a);
    if (hp > 0) out.push({ of: ['trout'], count: Math.ceil(hp / FOOD_HEAL.trout!) });
    const pieces = (needs?.pieces?.count ?? 0) - (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0);
    if (pieces > 0) out.push({ of: needs!.pieces!.of.map(norm), count: pieces });
    const frail = frailShort(a, needs);
    if (frail > 0) out.push({ of: needs!.frail!.of.map(norm), count: frail });
    if (needs?.anyOf) {
        const units = (lacks: readonly Lack[]) => lacks.reduce((n, l) => n + l.count, 0), blocked = (lacks: readonly Lack[]) => lacks.filter(l => !l.of.some(i => can(i, l.count))).length;
        const kits = needs.anyOf.map(alt => kitLacks(a, alt, can)).filter((k): k is Lack[] => k !== null).sort((x, y) => blocked(x) - blocked(y) || units(x) - units(y));
        if (!kits.length) return null;
        out.push(...kits[0]!);
    }
    return out;
}
// The most of each item any goal band needs to start, by norm() name: a donor keeps that many, so it never gives away
// its own kit. For `own`, also the batch a band works out for that account (the runes its Magic still casts). A band
// for build accounts only is left out: its kit (310 arrow shafts and feathers) is not a kit of the donors. So is a `once`
// quest: its pack (700 fire runes for Hero's Quest) is one account's single run, not a stock every donor keeps.
export function kitReserve(templates: readonly Template[], own?: Acct): Record<string, number> {
    const reserve: Record<string, number> = {};
    const count = (needs: Template['needs']) => {
        for (const [i, n] of Object.entries(needs?.items ?? {})) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        for (const i of needs?.pieces?.of ?? []) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, needs!.pieces!.count);
        for (const alt of needs?.anyOf ?? []) count(alt);
    };
    for (const t of templates) if (t.tier === 'goal' && !t.buildOnly && !t.once && !t.noReserve) {
        count(t.needs);
        if (own && t.batchFor) for (const [i, n] of Object.entries(t.batchFor(own))) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        // A band that needs a melee weapon keeps the cheap weapon an account holds: giving away its only one ends the band at once. An
        // account of known holdings (`own`) keeps the weapons it holds; every other donor (another side's, a local account outside the
        // roster) keeps one of each, since its own band is not known here.
        if (t.needs?.meleeWeapon) for (const [weapon] of COW_WEAPONS) if (!own || (own.items[weapon] ?? 0) > 0) reserve[weapon] = Math.max(reserve[weapon] ?? 0, 1);
    }
    delete reserve.coin;
    return reserve;
}
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
    const step = (l: KitLine) => [KIT_BUY_SCRIPT, `ITEM_ID=${l.id}`, `QUANTITY=${l.quantity}`, ...(l.held > 0 ? [`EXPECTED_OWNED=${l.held}`] : []), `LIMIT_PRICE=${l.limit}`,
        `CASH_RESERVE=${cashReserve}`, `ORDER_KEY=${account.toLowerCase()}-kit${seq}-${l.id}-${l.held}to${l.held + l.quantity}`, 'ORDER_MS=900000', 'FILL_WAIT_TICKS=200'].join(' ');
    return { id: KIT_BUY + band.id, family: 'kit-buy', script: 'scripts/chain.ts', args: lines.map(step), env: { ROUNDS: '1' }, role: 'supply',
        goal: `buy ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} on the Grand Exchange to ${band.goal}`, repeats: false, yields: () => [] };
}

const hasMarket = (inp: Inputs, item: string) => !!inp.market?.[item];
const hasStock = (inp: Inputs, item: string) => !!(inp.stock ?? []).some(s => (s.items[item] ?? 0) > 0);
function weaponStageFor(a: Acct, inp: Inputs): { id: string; item: string; goal: string } | null {
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
type KitStyles = { melee: boolean; ranged: boolean };
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
const kitStylesOf = (style: CombatFocus | null): KitStyles => ({ melee: style === null || style === 'melee', ranged: style === null || style === 'ranged' });
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
function rangedStagesFor(a: Acct, inp: Inputs): KitStage[] {
    const bow = bowStageFor(a, inp), ammo = ammoStageFor(a, inp, Math.max(ownedBowLevel(a), bow?.level ?? 0));
    return [...(bow ? [bow] : []), ...(ammo ? [ammo] : [])];
}
function armourItemsFor(a: Acct, inp: Inputs, styles: KitStyles = { melee: true, ranged: true }): { id: string; band: number; items: string[]; goal: string }[] {
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
function toolUpgradeNeed(a: Acct, routeDemand: ReadonlySet<string>): string | null {
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

export function goalNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const route: GoalNeed[] = inp.bill.filter(r => r.short > 0).map(r => ({ names: [r.item, ...(r.aliases ?? [])].map(norm), short: r.short, consumer: `Overall route: ${r.item}` }));
    const routeDemand = new Set(route.flatMap(r => r.names));
    const needs = [...route];
    const budget = (consumer: string, cost: () => number, account?: string) => {
        const coins = cost();
        if (coins > 0) needs.push({ names: ['coin'], short: coins, consumer, budget: cost, account });
    };
    const price = (item: string) => inp.market?.[item]?.limit ?? KIT_PRICE_CAPS[item] ?? inp.prices[item] ?? 0;
    const startable = (a: Acct, listed: Template) => {
        if (listed.wilderness && !inp.allowWilderness) return undefined;
        const lower = a.name.toLowerCase(), t = buildBand(listed, a, inp.builds?.get(lower), inp.buildQuests?.get(lower), inp.buildBefore?.get(lower));
        return !t || t.tier !== 'goal' || bandLeft(t, a) <= 0 || (t.pilot && !inp.pilots?.has(t.id)) || inp.retired?.has(pairKey(a.name, t.id)) ? undefined : t;
    };
    // A `once` quest is one account's run: only the first army account (by name, as the kit tier takes them) that can
    // start it asks for its pack, so 21 accounts that meet the Temple of Ikov journal do not ask for 21 packs.
    const onceOwner = new Map<string, string>();
    for (const listed of inp.templates) if (listed.once) {
        const owner = [...mine].sort((x, y) => x.name.localeCompare(y.name)).find(a => inp.army?.has(a.name.toLowerCase()) && !!startable(a, listed) && kitLacks(a, listed.needs, item => !!inp.market?.[item]) !== null);
        if (owner) onceOwner.set(listed.id, owner.name.toLowerCase());
    }
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower)) continue;
        const kit = new Map<string, { count: number; bands: Set<string> }>();
        let cash = 0, keep = 0;
        const bands: { template: Template; lacks?: Lack[] }[] = [];
        for (const listed of inp.templates) {
            const t = startable(a, listed);
            if (!t || (t.once && onceOwner.get(t.id) !== lower)) continue;
            const lacks = kitLacks(a, t.needs, item => !!inp.market?.[item]);
            if (lacks === null) continue;
            bands.push({ template: t, lacks: lacks.length ? lacks : undefined });
            cash = Math.max(cash, ...Object.entries(t.needs?.items ?? {}).filter(([item]) => norm(item) === 'coin').map(([, count]) => count));
            keep = Math.max(keep, t.keepCoins?.(a) ?? 0);
            const batch = t.batchFor?.(a) ?? t.batch;
            for (const lack of lacks) {
                const choices = [...lack.of].sort((x, y) => Number(!!inp.market?.[y]) - Number(!!inp.market?.[x]) || (price(x) || Infinity) - (price(y) || Infinity) || x.localeCompare(y));
                const item = choices[0];
                if (!item) continue;
                const count = Math.max(lack.count, (batch?.[item] ?? 0) - (a.items[item] ?? 0));
                const entry = kit.get(item) ?? { count: 0, bands: new Set<string>() };
                entry.count = Math.max(entry.count, count); entry.bands.add(t.id); kit.set(item, entry);
            }
        }
        bands.sort((x, y) => (x.template.band ?? 0) - (y.template.band ?? 0));
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) kit.set(wStage.item, { count: 1, bands: new Set([wStage.id]) });
        for (const arm of armourItemsFor(a, inp, styles)) for (const item of arm.items) if (!kit.has(item)) kit.set(item, { count: 1, bands: new Set([arm.id]) });
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) for (const { item, count } of stage.items) if (!kit.has(item)) kit.set(item, { count, bands: new Set([stage.id]) });
        const toolItem = toolUpgradeNeed(a, routeDemand);
        if (toolItem && !kit.has(toolItem)) kit.set(toolItem, { count: 1, bands: new Set(['tool-upgrade']) });
        const lines = [...kit].map(([item, entry]) => {
            const need: GoalNeed = { names: [item], short: entry.count, consumer: `army kit ${a.name}: ${[...entry.bands].join(', ')}`, account: lower };
            needs.push(need);
            return { need, price: price(item) };
        });
        budget(`army kit ${a.name}`, () => {
            const cost = lines.reduce((n, l) => n + (l.need.short + (l.need.bought ?? 0)) * l.price, 0);
            return cash + keep + cost + (cost > 0 ? KIT_CASH_RESERVE + KIT_COIN_MARGIN : 0);
        }, lower);
    }
    for (const need of route) if (!need.names.includes('coin')) {
        const cost = Math.max(0, ...need.names.map(item => inp.market?.[item]?.limit ?? inp.prices[item] ?? 0));
        if (cost > 0) budget(need.consumer, () => (need.short + (need.bought ?? 0)) * cost);
    }
    // The gang squad's stock targets, after every kit line: a row has no coin budget, so it never takes coins that a
    // member's own kit buy or a route purchase needs, and it never counts toward their funding.
    for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) needs.push({ names: row.names, short: row.short, consumer: row.consumer, account: row.account });
    if (inp.squad?.active) {
        const arrowTarget = squadTarget('arrow', inp.squad.hours);
        for (const m of inp.squad.members) {
            const shortPoison = Math.max(0, arrowTarget - (m.items['rune arrow(p)'] ?? 0));
            if (shortPoison > 0 && !needs.some(n => n.account === m.name.toLowerCase() && n.names[0] === 'rune arrow(p)')) {
                needs.push({ names: ['rune arrow(p)'], short: shortPoison, consumer: `gang squad ${m.name}: poison rune arrows`, account: m.name.toLowerCase() });
            }
        }
    }
    for (const row of specialistStagingNeeds(inp, mine)) needs.push(row);
    return needs;
}

export function plan(input: Inputs): Assignment[] {
    let inp: Inputs = { ...input, templates: input.templates.filter(t => (!t.wilderness || !!input.allowWilderness) && (!t.once || (!!input.questsDone && !!t.quest && !input.questsDone.has(norm(t.quest.name))))) };
    // An active squad's members never give their kit or supplies to another account's order: they leave the donor stock
    // and the coin donors, and only the squad's own restock (below) reads their stock, above their squad reserve.
    const squadNames = new Set(inp.squad?.active ? (inp.squad.all ?? inp.squad.members.map(m => m.name)).map(n => n.toLowerCase()) : []);
    const memberStock = (inp.stock ?? []).filter(s => squadNames.has(s.name.toLowerCase()));
    // Only the members that are free (`members`: observed, with no live session or stop file) may send each other stock: a held member is in `all`, not here.
    const freeMembers = new Set((inp.squad?.active ? inp.squad.members : []).map(m => m.name.toLowerCase()));
    if (squadNames.size) inp = { ...inp, stock: (inp.stock ?? []).filter(s => !squadNames.has(s.name.toLowerCase())), donors: (inp.donors ?? []).filter(d => !squadNames.has(d.name.toLowerCase())) };
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    // An active squad's members take no band, kit buy or supply job: they are held for the squad's staging, and only its restock
    // (below) gives them anything.
    const demand = goalNeeds(inp, mine.filter(a => !squadNames.has(a.name.toLowerCase()))), fed = new Map<string, number>();
    const values = { ...inp, coinValue: 1, bill: demand.map(d => ({ item: d.names[0]!, aliases: d.names.slice(1), short: d.short, need: d.short, owned: 0, ids: [], holders: [] })) };
    const localByName = new Map(mine.map(a => [a.name.toLowerCase(), a]));
    const earnedCoins = new Map<string, number>();
    const bridges = new Map<string, { recipient: string; target: number }>(), bridged = new Set<string>();
    const fundingDonors = (inp.donors ?? []).filter(d => !inp.unfundable?.has(d.name.toLowerCase()) && !inp.running?.has(d.name.toLowerCase())
        && (inp.owners.get(d.name.toLowerCase())?.side ?? inp.side) === inp.side);
    const fareCache = new Map<string, number | null>();
    const cachedWayCost = (from: Parameters<typeof wayCost>[0], to: Parameters<typeof wayCost>[1], mountain: boolean): number | null => {
        if (!to) return 0;
        if (!from) return wayCost(from, to, mountain);
        const k = `${from.x},${from.z},${from.level ?? 0}>${to.x},${to.z},${to.level ?? 0}:${mountain ? 1 : 0}`;
        if (fareCache.has(k)) return fareCache.get(k)!;
        const c = wayCost(from, to, mountain);
        fareCache.set(k, c);
        return c;
    };
    const canGiveCache = new Map<string, boolean>();
    const canGiveCoins = (name: string, recipient: string) => {
        const lower = recipient.toLowerCase(), fromKey = name.toLowerCase(), cacheKey = `${fromKey}>${lower}`;
        if (canGiveCache.has(cacheKey)) return canGiveCache.get(cacheKey)!;
        const to = localByName.get(lower), from = localByName.get(fromKey);
        let ok = false;
        if (to && fromKey !== lower && !inp.unfundable?.has(lower)) {
            const meet = meetFor(to.pos);
            if (meet !== null) {
                const fare = cachedWayCost(from?.pos, meet === 'ardougne' ? ARMY_BANK : PLACES['shop:zaff'], from ? inp.mountain?.(from) ?? true : true);
                ok = fare !== null && (fare === 0 || (from?.items.coin ?? 0) >= fare);
            }
        }
        canGiveCache.set(cacheKey, ok);
        return ok;
    };
    // Own kit cash stays with its recipient. A free donor contributes only transferable surplus, once across all
    // recipients. One donor must be able to give each credited share: several small, unusable trades are no funding.
    let fundingEpoch = 0;
    let cachedFunding: { epoch: number; value: { army: Map<string, number>; kits: Map<string, number>; route: number } } | undefined;
    const funding = () => {
        if (cachedFunding?.epoch === fundingEpoch) return cachedFunding.value;
        const army = new Map<string, number>();
        let route = 0;
        for (const d of demand) if (d.budget) {
            if (d.account) army.set(d.account, (army.get(d.account) ?? 0) + d.budget());
            else route += d.budget();
        }
        const cash = new Map(mine.map(a => [a.name.toLowerCase(), (a.items.coin ?? 0) + (earnedCoins.get(a.name.toLowerCase()) ?? 0)]));
        const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE - (army.get(d.name.toLowerCase()) ?? 0))]));
        const given = new Map<string, number>(), lacks = new Map<string, number>();
        for (const [name, cost] of [...army].sort(([x], [y]) => x.localeCompare(y))) {
            let short = Math.max(0, cost - (cash.get(name) ?? 0));
            const donor = [...pool].filter(([from, left]) => left > 0 && canGiveCoins(from, name)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
            if (donor && short > 0) {
                const coins = Math.min(short, donor[1]);
                short -= coins; pool.set(donor[0], donor[1] - coins);
                given.set(donor[0].toLowerCase(), (given.get(donor[0].toLowerCase()) ?? 0) + coins);
            }
            lacks.set(name, short);
        }
        let available = [...cash].reduce((n, [name, coins]) => n + Math.max(0, coins - Math.max(army.get(name) ?? 0, bridges.get(name)?.target ?? 0) - (given.get(name) ?? 0)), 0);
        for (const [name, coins] of pool) if (!cash.has(name.toLowerCase()) && mine.some(a => canGiveCoins(name, a.name))) available += coins;
        const value = { army: lacks, kits: army, route: Math.max(0, route - available) };
        cachedFunding = { epoch: fundingEpoch, value };
        return value;
    };
    // Banked inputs already cover their downstream need. Reserve direct bill stock and army kits before treating
    // an input as spare; producing it again would count the same route requirement twice.
    const inputStock = new Map<string, number>();
    const armyKits = mine.filter(a => inp.army?.has(a.name.toLowerCase())).map(a => [a, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a)] as const);
    for (const item of Object.keys(FEEDS)) {
        const holders = new Map<string, number>();
        for (const a of inp.accounts) holders.set(a.name.toLowerCase(), a.items[item] ?? 0);
        for (const s of inp.stock ?? []) holders.set(s.name.toLowerCase(), Math.max(holders.get(s.name.toLowerCase()) ?? 0, s.items[item] ?? 0));
        const rows = inp.bill.filter(r => [r.item, ...(r.aliases ?? [])].some(name => norm(name) === item));
        const held = Math.max([...holders.values()].reduce((n, count) => n + count, 0), rows.reduce((n, r) => n + r.owned, 0));
        const army = armyKits.reduce((n, [a, kit]) => n + Math.min(a.items[item] ?? 0, kit[item] ?? 0), 0);
        inputStock.set(item, Math.max(0, held - rows.reduce((n, r) => n + r.need, 0) - army));
    }
    let demandCacheEpoch = -1, directCache = new Map<string, number>(), strictDirectCache = new Map<string, number>(), downstreamCache = new Map<string, number>();
    const ensureDemandCaches = () => {
        if (demandCacheEpoch === fundingEpoch) return;
        demandCacheEpoch = fundingEpoch;
        directCache = new Map<string, number>();
        strictDirectCache = new Map<string, number>();
        downstreamCache = new Map<string, number>();
        for (const d of demand) if (!d.budget && d.short > 0) {
            for (const name of new Set(d.names.flatMap(n => [n, norm(n)]))) directCache.set(name, (directCache.get(name) ?? 0) + d.short);
            if (d.names.length === 1) {
                for (const name of new Set([d.names[0]!, norm(d.names[0]!)]))
                    strictDirectCache.set(name, (strictDirectCache.get(name) ?? 0) + d.short);
            }
        }
    };
    const direct = (item: string, strict = false) => { ensureDemandCaches(); return (strict ? strictDirectCache : directCache).get(item) ?? 0; };
    const downstream = (item: string) => {
        ensureDemandCaches();
        if (downstreamCache.has(item)) return downstreamCache.get(item)!;
        const val = demand.reduce((n, d) => n + (d.names.includes(item) ? 0 : d.short * Math.max(0, ...d.names.map(name => feedUnits(item, name)))), 0);
        downstreamCache.set(item, val);
        return val;
    };
    const needed = (item: string, account?: string, strict = false) => {
        if (item !== 'coin') return direct(item, strict) + (strict ? 0 : Math.max(0, downstream(item) - (inputStock.get(item) ?? 0) - (fed.get(item) ?? 0)));
        const cash = funding();
        const lower = account?.toLowerCase(), bridge = lower ? bridges.get(lower) : undefined;
        const own = lower ? bridged.has(lower) ? 0 : cash.army.get(lower) ?? 0 : [...cash.army.values()].reduce((n, coins) => n + coins, 0);
        const gift = bridge ? Math.max(0, bridge.target - (localByName.get(lower!)?.items.coin ?? 0) - (earnedCoins.get(lower!) ?? 0)) : 0;
        return direct(item) + cash.route + own + gift;
    };
    const finiteOrder = (t: Template, a: Acct): Template | null => {
        const p = t.production; if (!p) return t.script === 'scripts/train-prayer.ts' && t.env?.BURY_HELD === '1'
            ? { ...t, repeats: false, env: { ...t.env, AUTOPILOT_ORDER: String(inp.kitSeq?.get(a.name.toLowerCase()) ?? 0) } } : t;
        const dem = Math.ceil(needed(norm(p.output), a.name, !!p.strictOutput) / p.outputPerUnit);
        if (dem < 1) return null;
        const available = Math.min(...Object.entries(p.inputs).map(([item, n]) => Math.max(0, Math.floor(((a.items[norm(item)] ?? 0) - (p.reserves?.[item] ?? 0)) / n))));
        const units = Math.min(p.maximum, dem, available > 0 ? available : Infinity), items = { ...t.needs?.items };
        for (const [item, n] of Object.entries(p.inputs)) items[item] = n * units + (p.reserves?.[item] ?? 0);
        const resized = p.resize(units, a.items[norm(p.output)] ?? 0);
        const baseline = JSON.stringify([a.items[norm(p.output)] ?? 0, ...Object.keys(p.inputs).sort().map(item => [norm(item), a.items[norm(item)] ?? 0])]);
        return { ...t, ...resized, env: { ...t.env, ...resized.env, AUTOPILOT_ORDER: baseline }, repeats: false,
            needs: { ...t.needs, items }, production: { ...p, maximum: units } };
    };
    const consume = (item: string, count: number, account?: string, bought = false) => {
        for (const d of demand) if (count > 0 && !d.budget && d.names.some(n => n === item || norm(n) === item) && (account === undefined || d.account === account.toLowerCase())) {
            const used = Math.min(d.short, count); d.short -= used; count -= used;
            if (bought) d.bought = (d.bought ?? 0) + used;
            if (used > 0) fundingEpoch++;
        }
        return count;
    };
    const reserveKit = (account: string, lines: readonly { item: string; quantity: number }[], bought = true) => {
        for (const l of lines) consume(norm(l.item), l.quantity, account, bought);
    };
    const reserveOutput = (t: Template, a: Acct) => {
        const strict = !!t.production?.strictOutput;
        for (const f of t.yields(a)) {
            const item = norm(f.item), count = Math.min(t.production && item === norm(t.production.output) ? t.production.maximum * t.production.outputPerUnit : Math.max(0, f.perTick) * VALUE_TICKS, needed(item, a.name, strict));
            const rest = consume(item, count);
            if (item === 'coin') { earnedCoins.set(a.name.toLowerCase(), (earnedCoins.get(a.name.toLowerCase()) ?? 0) + rest); if (rest > 0) fundingEpoch++; }
            else if (rest > 0) fed.set(item, (fed.get(item) ?? 0) + rest);
        }
    };
    const valueOf = (t: Template, a: Acct) => jobValue(t, a, values, item => needed(item, a.name, !!t.production?.strictOutput)) * (onList(t) ? 1 : PILOT_FALLBACK_SHARE);
    // `fare`: the ferry fare inside the coin need of the candidate's template.
    type Cand = { account: string; template: Template; value: number; resources: string[]; reason: string; coins?: number; fare?: number; goal?: { band: number; left: number }; lacks?: Lack[];
        supply?: { template: Template; account: Acct; share: number }; kit?: readonly KitLine[] };
    const cands: Cand[] = [];
    // Keep qualified coin opportunities until the kit tier has used existing funds. A helper gets value only if
    // the finite transfer below chooses it; a coin opportunity alone never gives an account work.
    const makesCoins = (t: Template, a: Acct) => t.yields(a).some(f => norm(f.item) === 'coin' && f.perTick > 0);
    const onList = (t: Template) => !t.pilot || !!inp.pilots?.has(t.id);
    const admitted = (t: Template, a?: Acct) => onList(t) || (!!inp.pilotFallback && selfServePilot(t) && !(a && (inp.army?.has(a.name.toLowerCase()) || squadNames.has(a.name.toLowerCase()))));
    const shopLine = (l: Lack) => !l.of.some(i => inp.market?.[i]) && l.of.some(i => SHOP_SUPPLIED.has(i));
    // A donor can fund the account: it has no enabled job, and a meeting place that it can reach (meetFor).
    const meetOf = new Map(mine.map(a => [a.name, meetFor(a.pos)]));
    const fundable = (a: Acct) => (!!inp.donors?.length || !!inp.stock?.some(s => s.side !== inp.side && (s.items.coin ?? 0) > FUND_RESERVE))
        && !inp.unfundable?.has(a.name.toLowerCase()) && meetOf.get(a.name) !== null;
    // The jobs an account could start but for coins of a ferry fare: the constraint of a slot that ends vacant.
    const fareShort = new Map<string, { id: string; coins: number; fare: number; resources: string[] }[]>();
    const lacksFare = (a: Acct, t: Template, fare: number) => { fareShort.set(a.name, [...(fareShort.get(a.name) ?? []), { id: t.id, coins: coinShort(a, t.needs), fare, resources: t.resources ?? [] }]); };
    // Why a slot ends vacant (AGENTS.md: a vacant slot names its constraint). A template that stops at a gate before it
    // is a candidate leaves the gate here. Only an account that ends with no job reads its list (vacancy, below).
    type Miss = { template: Template; gate: 'retired' | 'pilot' | 'demand' | 'reach' | 'roster' | 'needs' | 'coins' };
    const misses = new Map<string, Miss[]>();
    const miss = (a: Acct, template: Template, gate: Miss['gate']) => { const list = misses.get(a.name); if (list) list.push({ template, gate }); else misses.set(a.name, [{ template, gate }]); };
    for (const a of mine) for (const listed of inp.templates) {
        if (listed.squadOnly && !inp.squad?.active && !(inp.specialists?.length ?? 0)) continue;
        if (squadNames.has(a.name.toLowerCase())) continue;
        const band = buildBand(listed, a, inp.builds?.get(a.name.toLowerCase()), inp.buildQuests?.get(a.name.toLowerCase()), inp.buildBefore?.get(a.name.toLowerCase()));
        if (!band) continue;
        if (inp.retired?.has(pairKey(a.name, band.id))) { miss(a, band, 'retired'); continue; }
        if (!admitted(band, a)) { miss(a, band, 'pilot'); continue; }
        // The reach rule (wayCost): no candidate for a place with no way from where the account stands. The ferry fare
        // of the way is a coin need of the job, so an account without the fare is funded as for any coin need.
        const finite = finiteOrder(band, a); if (!finite) { miss(a, band, 'demand'); continue; }
        const selected = inp.templateFor?.(finite, a) ?? finite;
        const place = placeOf(selected);
        // Surface combat and goldfarm workers only walk/route from ground level (level 0); upstairs accounts wait until recovered.
        if ((selected.script === 'scripts/gather-combat.ts' || selected.script === 'scripts/goldfarm.ts') && (place?.level ?? 0) === 0 && a.pos && a.pos.level !== 0) {
            miss(a, selected, 'reach');
            continue;
        }
        const fare = cachedWayCost(a.pos, place, inp.mountain?.(a) ?? true);
        if (fare === null) { miss(a, selected, 'reach'); continue; }
        const t = fare ? withFare(selected, fare) : selected;
        if (t.quest && t.tier !== 'goal') {
            const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
            if (questDone(a, t.quest.name)) continue;
            if (lacks === null || coinShort(a, t.needs) > 0) { miss(a, t, lacks === null ? 'needs' : 'coins'); continue; }
            const after: Acct = { ...a, quests: new Set([...(a.quests ?? []), norm(t.quest.name)]) }, before = cands.length;
            for (const u of t.quest.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(after, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, after);
                if (value > 0 || makesCoins(u, after)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `completes ${t.quest.name} for ${u.id}`, supply: { template: u, account: after, share: TRAIN_SHARE }, ...(lacks.length ? { lacks } : {}) });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.tier === 'goal') {
            // One candidate per goal band whose target an army account has not met; never for anyone else. A band's
            // target is a skill level, or a quest: that one stands until the account's status lists the quest complete,
            // and an account whose status names no quests gets none.
            const left = bandLeft(t, a);
            if (left <= 0) continue;
            if (!inp.army?.has(a.name.toLowerCase())) { miss(a, t, kitLacks(a, t.needs) === null ? 'needs' : 'roster'); continue; }
            const goal = { band: t.band ?? 0, left }, reason = t.trains ? `army band ${goal.band}: ${t.trains.skill} to ${t.trains.to}` : t.quest ? `army band ${goal.band}: ${t.quest.name}` : `army band ${goal.band}: ${t.stock!.to} ${t.stock!.item}`;
            // Keep only a confirmed live instance of this exact band. A parked enabled job still needs its full kit
            // before a new start. kitLacks preserves the band's level, quest and under-target admission rules.
            if (inp.running?.has(a.name.toLowerCase()) && inp.current?.get(a.name.toLowerCase()) === t.id && kitLacks(a, t.needs) !== null) {
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
                continue;
            }
            if (fare && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) lacksFare(a, t, fare);
            // Notes remain owned stock for acquisition, but the held-normal Prayer worker can bury only id526.
            // This gates a new execution; the active instance above and missing-kit acquisition below keep their rules.
            const usableNormalBones = t.script !== 'scripts/train-prayer.ts' || t.env?.BURY_HELD !== '1' || t.env?.BONE_ID !== undefined
                || (a.items['bone (unnoted)'] ?? 0) >= (t.needs?.items?.bones ?? 0);
            if (meets(a, t.needs) && usableNormalBones) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
            else if (usableNormalBones && fundable(a) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)))
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, coins: coinShort(a, t.needs), fare });
            else {
                // Acquisition chooses the source, purchase batch and price after donor arbitration.
                const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
                if (lacks?.length) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, lacks, coins: coinShort(a, t.needs) });
                else miss(a, t, 'needs');
            }
            continue;
        }
        if (t.provides) {
            // A shop step for a maker. The item is the one input the maker lacks: every other need is met.
            const item = norm(t.provides.item), held: Acct = { ...a, items: { ...a.items, [item]: Math.max(1, a.items[item] ?? 0) } }, before = cands.length;
            if ((a.items[item] ?? 0) >= 1) continue;
            if (coinShort(a, t.needs) > 0 || !meets(a, withoutCoins(t.needs))) { miss(a, t, coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)) ? 'coins' : 'needs'); continue; }
            for (const u of t.provides.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(held, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, held);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `buys a ${t.provides.item} for ${u.id}`, supply: { template: u, account: held, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.trains) {
            if ((a.skills[t.trains.skill] ?? 1) >= t.trains.to) continue;
            if (!meets(a, t.needs)) { miss(a, t, 'needs'); continue; }
            const trained: Acct = { ...a, skills: { ...a.skills, [t.trains.skill]: t.trains.to } }, before = cands.length;
            for (const u of t.trains.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                // The frail rule counts what the account holds when the unlocked job starts, which is not known yet.
                if (!meets(a, { ...u.needs, frail: undefined }, t.trains)) continue;
                const value = TRAIN_SHARE * valueOf(u, trained);
                if (value > 0 || makesCoins(u, trained)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `trains ${t.trains.skill} ${t.trains.to} for ${u.id}`, supply: { template: u, account: trained, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
        } else if (meets(a, t.needs)) {
            const value = valueOf(t, a);
            if (value > 0 || makesCoins(t, a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), supply: { template: t, account: a, share: 1 } });
            else miss(a, t, 'demand');
        } else if (coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) {
            const value = valueOf(t, a);
            if (value > 0 && fare) lacksFare(a, t, fare);
            if ((value > 0 || makesCoins(t, a)) && fundable(a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), coins: coinShort(a, t.needs), fare, supply: { template: t, account: a, share: 1 } });
            else miss(a, t, value > 0 || makesCoins(t, a) ? 'coins' : 'demand');
        } else if (t.needs?.frail && frailShort(a, t.needs) > 0 && meets(a, { ...t.needs, frail: undefined })) {
            // Spare owned food precedes the existing full food purchase. Both
            // routes require finite coin demand and a free knight spot.
            const value = TRAIN_SHARE * valueOf(t, a), lacks = kitLacks(a, t.needs);
            if (lacks?.length && (value > 0 || makesCoins(t, a))) cands.push({ account: a.name,
                template: { ...t, id: FRAIL_FOOD_BUY_ID, batchFor: account => Object.fromEntries(t.needs!.frail!.of.map(item => [norm(item), (account.items[norm(item)] ?? 0) + FRAIL_FOOD_BUY])) },
                value, resources: t.resources ?? [], reason: `prepares food for ${t.family}`, lacks, supply: { template: t, account: a, share: TRAIN_SHARE } });
            else miss(a, t, 'demand');
        } else {
            const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]), value = valueOf(t, a);
            if (lacks?.length && value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: `prepares ${t.goal}`, lacks, coins: coinShort(a, t.needs),
                supply: { template: t, account: a, share: 1 } });
            else miss(a, t, lacks === null ? 'needs' : 'demand');
        }
    }
    // Progressive weapon & armour kit buys precede combat bands. Owned stock can supply them without a market quote.
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower) || squadNames.has(lower)) continue;
        const bands = cands.filter(c => c.account === a.name && c.goal).sort((x, y) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left);
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) {
            const template: Template = { id: wStage.id, item: wStage.item, attack: 30, goal: wStage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: { [wStage.item]: 1 } } } as Template & { item: string; attack: number };
            cands.push({ account: a.name, template, value: 0, resources: [WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages 1 ${wStage.item}`, goal: { band: WEAPON_BAND, left: 0 }, lacks: [{ of: [wStage.item], count: 1 }] });
        }
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) {
            const template: Template = { id: stage.id, goal: stage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true,
                needs: { items: Object.fromEntries(stage.items.map(i => [i.item, i.count])) } };
            cands.push({ account: a.name, template, value: 0, resources: [stage.id === AMMO_STAGE ? AMMO_MARKET : WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages ${stage.items.map(i => `${i.count} ${i.item}`).join(', ')}`,
                goal: { band: WEAPON_BAND + (stage.id === AMMO_STAGE ? 0.01 : 0), left: 0 }, lacks: stage.items.map(i => ({ of: [i.item], count: i.count })) });
        }
        for (const arm of armourItemsFor(a, inp, styles)) {
            const needsItems = Object.fromEntries(arm.items.map(i => [i, 1]));
            const template: Template = { id: arm.id, goal: arm.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: needsItems } };
            cands.push({ account: a.name, template, value: 0, resources: [ARMOUR_MARKET], reason: `army band ${arm.band}: stages ${arm.items.join(', ')}`, goal: { band: arm.band, left: 0 }, lacks: arm.items.map(i => ({ of: [i], count: 1 })) });
        }
    }
    // On a value tie an account keeps the template it holds: a level change must not move it to another spot of the
    // same worth, which would replace a running job with a fresh one that changes nothing useful.
    const keeps = (c: Cand) => inp.current?.get(c.account.toLowerCase()) === c.template.id ? 1 : 0;
    const used = new Map(Object.entries(inp.taken ?? {})), done = new Map<string, Assignment>();
    // A candidate's worth with the holders taken so far: each holder of a resource scales it by that resource's shared
    // rate, so a third farmer on a spot is worth less than a second and new farmers spread over the spots. The place an
    // account already holds keeps its full worth: crowding counts only against a move, so a farmer stays put until its
    // spot is full (capacity is a hard limit below), and sides do not chase each other's lagging claims.
    const worth = (c: Cand) => c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : (used.get(r) ?? 0)),
        c.supply ? c.supply.share * valueOf(c.supply.template, c.supply.account) : c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // Donor coins above the reserve, spent as funded candidates take them; a funded account gives nothing.
    // A donor that gives stays free this pass, so the fleet agent can log it in for the trade.
    const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)])), gave = new Set<string>();
    // Accounts that give an item this pass, and accounts that leave a coin job so a kit order can reach them.
    const gaveItems = new Set<string>(), vacated = new Map<string, string>();
    const take = (c: Cand, value: number, far = false) => {
        if (c.lacks || (!c.goal && value <= 0) || done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        if (far && (ready.has(c.account) || inp.unfundable?.has(c.account.toLowerCase()) || inp.running?.has(c.account.toLowerCase()))) return;
        const selected = finiteOrder(c.template, localByName.get(c.account.toLowerCase())!); if (!selected) return;
        let fund: Funding | undefined;
        if (c.coins) {
            const from = cashSource(c.account, c.coins, far);
            if (!from) return;
            if (pool.has(from)) pool.set(from, pool.get(from)! - c.coins); gave.add(from);
            fund = { from, to: c.account, coins: c.coins, template: c.template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) };
        }
        pool.delete(c.account);
        for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
        const bridge = bridges.get(c.account.toLowerCase()), reason = bridge ? `${c.reason} for ${bridge.recipient}'s army kit, up to ${bridge.target} coins including donor reserve` : c.reason;
        done.set(c.account, { account: c.account, template: selected, value, reason: fund ? `${reason}, funded ${c.coins} coins by ${fund.from}${c.fare ? `, ferry fare ${c.fare}` : ''}` : reason, resources: c.resources, ...(fund ? { fund } : {}) });
        if (c.supply) reserveOutput(c.supply.template.id === selected.id ? selected : c.supply.template, c.supply.account);
        if (c.kit) reserveKit(c.account, c.kit);
    };
    // The goal tier first: each army account takes the earliest band it can (a full band's resource sends it to the
    // next), the account nearest its target first; it never competes with coin jobs on coins per tick.
    const goalOrder = (x: Cand, y: Cand) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // A quest the account holds comes before every band: a stop in the middle of a quest leaves the account wherever
    // the quest stood (live: an account on Lost City, band 3.6, was moved to the rune buy of band 2).
    // Then the kit tier: an army account with no band it can start gets the kit of its earliest band, before any coin
    // job. This side's available spare stock supplies the kit before a repurchase. Its item orders start without
    // the cross-side sync lead. A remote transfer retains that lead, so an affordable local purchase precedes it.
    // A running band, an open purchase or a productive remote recipient keeps its assignment.
    const reserve = kitReserve(inp.templates), byName = new Map(mine.map(a => [a.name, a]));
    const stock = [...(inp.stock ?? [])].sort((x, y) => Number(y.side === inp.side) - Number(x.side === inp.side));
    // What a donor keeps of an item: the most a band needs to start. An army account of this side keeps that only for
    // the bands it has still to do, so a maxed account gives all it holds (live: two maxed accounts held 41 dragon
    // bones, 1,900 nature runes and 29,000 feathers while others waited for a donor of another side). The levels of
    // another side's account are not read here: it keeps the reserve of every band.
    const ownReserve = new Map<string, Record<string, number>>();
    const squadKeep = inp.squad?.active ? squadKeeps(inp.squad.hours) : undefined, squadMember = new Set((inp.squad?.all ?? inp.squad?.members.map(m => m.name) ?? []).map(n => n.toLowerCase()));
    const keepsOf = (s: Stock) => {
        if (squadKeep && squadMember.has(s.name.toLowerCase())) return { ...reserve, ...Object.fromEntries(Object.entries(squadKeep).map(([i, n]) => [i, Math.max(n, reserve[i] ?? 0)])) };
        const a = s.side === inp.side ? byName.get(s.name) : undefined;
        if (!a || !inp.army?.has(a.name.toLowerCase())) return reserve;
        if (!ownReserve.has(a.name)) ownReserve.set(a.name, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a));
        return ownReserve.get(a.name)!;
    };
    const spare = (s: Stock, item: string) => Math.max(0, (s.items[item] ?? 0) - (keepsOf(s)[item] ?? 0));
    // Remote stock has already passed the publishing side's freshness, ownership and free-account checks. Its
    // cash keeps the same reserve as local donors and is used only by the idle-recipient fallback below.
    const cashSource = (recipient: string, coins: number, far: boolean): string | undefined => {
        const own = [...pool].filter(([name, left]) => left >= coins && !done.has(name) && !gaveItems.has(name) && canGiveCoins(name, recipient)).sort((x, y) => y[1] - x[1])[0]?.[0];
        if (own || !far) return own;
        return stock.filter(s => s.side !== inp.side && !gave.has(s.name) && !gaveItems.has(s.name) && !done.has(s.name)
            && !inp.unfundable?.has(s.name.toLowerCase()) && !inp.running?.has(s.name.toLowerCase())
            && !inp.noSend?.has(`${s.name}>${recipient}`.toLowerCase()) && (s.items.coin ?? 0) - FUND_RESERVE >= coins && canGiveCoins(s.name, recipient))
            .sort((x, y) => (y.items.coin ?? 0) - (x.items.coin ?? 0) || x.name.localeCompare(y.name))[0]?.name;
    };
    const banded = (id: string) => byId.get(id)?.tier === 'goal' && !byId.get(id)?.filler;
    const goalNow = (account: string) => { const id = inp.current?.get(account.toLowerCase()); return !!id && (id.startsWith(KIT_BUY) || banded(id)); };
    const acquire = (c: Cand, step: 'buy' | 'send', far: boolean) => {
        const a = byName.get(c.account)!, busy = !!inp.unfundable?.has(c.account.toLowerCase()), buyId = KIT_BUY + c.template.id;
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account)) return;
        if (!c.goal && (worth(c) <= 0 || inp.running?.has(c.account.toLowerCase()))) return;
        // Another side's stock and coins are asked only for an account with no job it can start and none running: such
        // a trade needs the account offline until the other side's agent runs it, up to the order's window (live: 13
        // of 14 accounts stood parked at once, most for 1 to 13 items of another side, one with 123,028 coins for 3
        // air runes that a shop sells).
        if (far && (busy || ready.has(c.account))) return;
        // An account in a running band job keeps the rule it had before the kit tier: its live holdings dip while it
        // works (food eaten, runes cast), and a kit buy must not replace a band that is still running. A weapon or
        // armour buy is the exception: the band does not use the item up, the account lacks it for as long as the
        // band runs (live: Attack 99, Strength 99, Defence 94 and 1,090,000 coins with a bronze sword, held on the
        // Defence band), and one buy run pays back on every later tick. The buy below starts only from the account's
        // own coins: a busy account takes no funding and no item order.
        const now = inp.current?.get(c.account.toLowerCase());
        const wornKit = c.resources.includes(WEAPON_MARKET) || c.resources.includes(ARMOUR_MARKET);
        if (busy && now && !now.startsWith(KIT_BUY) && banded(now) && !wornKit) return;
        // No kit for a band whose place is full: the account tries its next band.
        if (c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        const reachesMeet = (name: string) => { const p = byName.get(name), cost = cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true); return cost !== null && (cost === 0 || (p!.items.coin ?? 0) >= cost); };
        const donorFor = (item: string, count: number, remote = far) => stock.find(s => (s.side !== inp.side) === remote && s.name.toLowerCase() !== c.account.toLowerCase() && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= count
            && !inp.noSend?.has(`${s.name}>${c.account}`.toLowerCase()) && reachesMeet(s.name));
        // Fund the worker's own cash prerequisite first, then reobserve before acquiring its missing items.
        // fundOrders parks the intended worker until this one owned transfer settles.
        if (c.coins) {
            if (busy) return;
            const mountain = inp.mountain?.(a) ?? true, toMeet = cachedWayCost(a.pos, ARMY_BANK, mountain), fromMeet = cachedWayCost(ARMY_BANK, placeOf(c.template), mountain);
            // The cash transfer precedes the item trip. Its recipient can use that staged cash for the meeting
            // fare, and must still retain the consumer's cash and return fare after the item arrives.
            const canMeet = toMeet !== null && fromMeet !== null;
            const itemSource = (item: string, count: number) => donorFor(item, count, false) ?? (far ? donorFor(item, count, true) : undefined);
            const obtainable = (item: string, count: number) => !!c.template.ownSupply?.includes(item) || !c.template.shopKit && !!inp.market?.[item] || canMeet && !!itemSource(item, count);
            const lacks = kitLacks(a, c.template.needs, obtainable);
            if (!lacks || lacks.some(l => !l.of.some(item => obtainable(item, l.count)))) return;
            const owned = canMeet && lacks.some(l => l.of.some(item => !!itemSource(item, l.count)));
            const detour = a.pos && owned ? Math.max(0, toMeet! + fromMeet! - (cachedWayCost(a.pos, placeOf(c.template), mountain) ?? 0)) : 0;
            const coins = c.coins + detour;
            const from = cashSource(c.account, coins, far);
            if (!from) return;
            if (pool.has(from)) pool.set(from, pool.get(from)! - coins); gave.add(from); pool.delete(c.account);
            done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `funds ${coins} coins before preparing ${c.template.id}`, resources: [],
                fund: { from, to: c.account, coins, template: c.template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) } });
            return;
        }
        if (step === 'buy' && (c.template.shopKit || cachedWayCost(a.pos, PLACES['shop:zaff'], inp.mountain?.(a) ?? true) === null)) return;
        const own = (l: Lack) => l.of.some(i => !!c.template.ownSupply?.includes(i));
        const picks = c.lacks!.filter(l => !shopLine(l) && !own(l)).map(l => { const item = l.of.filter(i => inp.market?.[i] && usableTool(a, i)).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]; return item ? { item, count: l.count } : null; });
        if (step === 'buy' && picks.length && picks.every(p => p !== null) && !inp.retired?.has(pairKey(c.account, buyId))) {
            // The batch when the account can pay for it, else only what the band needs to start. A one-line band with
            // `partBatch` takes as much of its batch as the account can pay for.
            const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
            // `held` is what the buy script will count (EXPECTED_OWNED, the order key): the unnoted units. The batch top-up counts every unit, notes included.
            const sized = (batch: boolean): KitLine[] => picks.map(p => { const owned = a.items[p!.item] ?? 0, held = a.exact ? a.exact[p!.item] ?? 0 : owned, m = inp.market![p!.item]!; return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(p!.count, batch ? (batchOf?.[p!.item] ?? 0) - owned : 0) }; });
            const price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0), coins = a.items.coin ?? 0;
            const keep = Math.max(c.template.keepCoins?.(a) ?? 0, ...Object.entries(c.template.needs?.items ?? {}).filter(([item]) => norm(item) === 'coin').map(([, count]) => count));
            const free = coins - keep;
            // The buy script refuses a round whose escrow and reserve pass the coins it finds, and the status that sized the buy is older than
            // the run: KIT_COIN_MARGIN keeps the planned buy under the coins by what a few minutes of fares, food and fees can take.
            const room = KIT_CASH_RESERVE + KIT_COIN_MARGIN;
            const full = sized(true), start = sized(false), part = Math.floor((free - room) / (full[0]?.limit ?? 1));
            const frailFood = c.template.id === FRAIL_FOOD_BUY_ID;
            const lines = frailFood || price(full) + room <= free ? full
                : c.template.partBatch && full.length === 1 && part > start[0]!.quantity ? [{ ...full[0]!, quantity: Math.min(full[0]!.quantity, part) }]
                : c.template.partBatch && full.length > 1 ? proportionalLines(full, start, free - room) : start;
            const template = kitBuyTemplate(c.template, c.account, lines, inp.kitSeq?.get(c.account.toLowerCase()) ?? 0, KIT_CASH_RESERVE + keep), cost = price(lines), short = cost + room - free;
            const what = lines.map(l => `${l.quantity} ${l.item}`).join(', ');
            // A `once` quest buys its kit for one account at a time, and for QUEST_DEMAND_PLACES quests at a time: the buy holds
            // the places of the quest, and the run that follows holds them too.
            const purchaseResources = c.template.id === WEAPON.id || c.template.id.startsWith('army-weapon-') || c.template.id.startsWith('army-armour-') || c.template.once || frailFood ? c.resources : [];
            const reservePurchase = () => { for (const r of purchaseResources) used.set(r, (used.get(r) ?? 0) + 1); reserveKit(c.account, lines); if (c.supply) reserveOutput(c.supply.template, c.supply.account); };
            const buyReason = `${c.goal && c.template.kitFirst ? `army band ${c.goal.band}: ` : ''}buys ${what} for ${c.template.id}, at most ${cost} coins`;
            if (short <= 0) { done.set(c.account, { account: c.account, template, value: 0, reason: buyReason, resources: purchaseResources }); reservePurchase(); return; }
            if (frailFood) return;
            if (!busy && meetOf.get(c.account) !== null) {
                // A coin donor of this side, else a free account of another side with coins above the reserve.
                const from = cashSource(c.account, short, far);
                if (from) {
                    if (pool.has(from)) pool.set(from, pool.get(from)! - short);
                    gave.add(from); pool.delete(c.account);
                    done.set(c.account, { account: c.account, template, value: 0, reason: `${c.reason}, funded ${short} coins by ${from} to buy ${what}`, resources: purchaseResources, fund: { from, to: c.account, coins: short, template: template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) } });
                    reservePurchase();
                    return;
                }
            }
        }
        if (step === 'buy') return;
        // An item order meets at the Ardougne north bank (scripts/autopilot.ts itemOrder). A party of this side whose
        // place is known must have a way there and hold the fare of that way. A party with no known place has no rule.
        if (!reachesMeet(c.account)) return;
        // A market alternative can be unaffordable while a donor holds another complete kit. Reconsider the choice
        // against this pass's reachable, unreserved stock, including donors already taken by another account.
        const lacks = kitLacks(a, c.template.needs, (item, count) => !!donorFor(item, count)) ?? [];
        // One order per pass. A line no market sells goes first, so the lines left at the end are one buy.
        const sold = (l: Lack) => Number(l.of.some(i => !!inp.market?.[i]));
        for (const l of lacks.sort((x, y) => sold(x) - sold(y))) for (const item of l.of) {
            const from = donorFor(item, l.count);
            if (!from) continue;
            // A donor of this side sends the band's batch, as a buy would bring it, as far as its spare stock goes: one
            // trade, not one for every start amount. Another side's donor sends what the band needs to start.
            const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
            const count = far ? l.count : Math.min(spare(from, item), Math.max(l.count, (batchOf?.[item] ?? 0) - (a.items[item] ?? 0)));
            // A trade needs the account offline with no stop file (scripts/fleet-agent.ts). One in a coin job leaves that
            // job on this pass and gets the order on the next; one already on a band or a kit buy keeps it.
            // The donor is held for this account, so a second account does not leave its job for the same stock.
            if (busy) { if (!goalNow(c.account)) { vacated.set(c.account, `vacant: leaves its job for ${count} ${item} from ${from.name} for ${c.template.id}`); gaveItems.add(from.name); pool.delete(from.name); } return; }
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(c.account);
            const resources = c.template.id === FRAIL_FOOD_BUY_ID ? c.resources : [];
            for (const resource of resources) used.set(resource, (used.get(resource) ?? 0) + 1);
            const sendId = exactItemIds().get(item);
            done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `${c.reason}, sent ${count} ${item} by ${from.name}`, resources, send: { from: from.name, to: c.account, item, count, template: c.template.id, ...(sendId !== undefined ? { itemId: sendId } : {}) } });
            reserveKit(c.account, [{ item, quantity: count }], false);
            if (c.supply) reserveOutput(c.supply.template, c.supply.account);
            return;
        }
    };
    // This side's own coins and stock before another side's: a trade across sides waits on the other side's agent,
    // and the account stands vacant meanwhile (live: five accounts parked for donors of another side, one for 22
    // bones, while this side's maxed accounts held what they needed).
    const kits = [...cands.filter(c => c.goal && c.lacks).sort(goalOrder), ...cands.filter(c => !c.goal && c.lacks).sort(order)];
    // The accounts with a job of any tier that they can start now with what they hold.
    const ready = new Set(cands.filter(c => !c.lacks && !c.coins && (c.goal || worth(c) > 0)).map(c => c.account));
    // An active gang squad's supply jobs take their places first: a goal band that takes the same shop (army-hunt-supply holds
    // shop:lowe) would leave the squad's line with no place. A place that a running job of its current template holds stays
    // with that job, and an account that runs a job keeps it. An account with a goal band (ready, or short of its kit) keeps the
    // band's way: the squad's supply goes first to the accounts with no band.
    if (inp.squad?.active || (inp.specialists?.length ?? 0) > 0) {
        const runningHolds = new Set(cands.filter(k => inp.running?.has(k.account.toLowerCase()) && inp.current?.get(k.account.toLowerCase()) === k.template.id).flatMap(k => k.resources));
        const banded = new Set(cands.filter(k => k.goal).map(k => k.account));
        for (const c of cands.filter(c => c.template.squadOnly && !banded.has(c.account) && !inp.running?.has(c.account.toLowerCase()) && !c.resources.some(r => runningHolds.has(r))).sort((p, q) => worth(q) - worth(p)))
            take(c, worth(c));
    }
    for (const c of cands.filter(c => c.goal && !c.lacks && !!c.template.quest && keeps(c)).sort(goalOrder)) take(c, 0);
    for (const c of cands.filter(c => c.goal && !c.template.filler).sort(goalOrder)) {
        if (!c.lacks) {
            if (c.template.family === 'shop-buyer' && !inp.running?.has(c.account.toLowerCase()))
                for (const kit of kits.filter(kit => kit.account === c.account && kit.goal?.band === c.goal!.band)) acquire(kit, 'send', false);
            take(c, 0);
        }
        else if (c.template.kitFirst) { acquire(c, 'send', false); acquire(c, 'buy', false); }
    }
    for (const c of kits) acquire(c, 'send', false);
    for (const c of kits) acquire(c, 'buy', false);
    for (const step of ['buy', 'send'] as const) for (const c of kits) acquire(c, step, true);
    // The gang squad's restock, after every kit order: a free donor of this side sends a member that is short a line it
    // holds above its own reserve, one order for a member in a pass. The member must be a plannable, offline account
    // that no kit order or job took; a member that runs a hand job is restocked when it is free.
    if (inp.squad?.active) for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) {
        const member = byName.get([...byName.keys()].find(n => n.toLowerCase() === row.account) ?? '');
        if (!member || done.has(member.name) || gave.has(member.name) || gaveItems.has(member.name) || vacated.has(member.name) || inp.unfundable?.has(row.account)) continue;
        const cost = (p: Acct | undefined) => cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true);
        for (const item of row.names) {
            const from = [...stock, ...memberStock.filter(s => freeMembers.has(s.name.toLowerCase()))].find(s => s.side === inp.side && s.name.toLowerCase() !== row.account && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= 1
                && !inp.noSend?.has(`${s.name}>${member.name}`.toLowerCase()) && (cost(byName.get(s.name)) ?? -1) >= 0 && (cost(member) ?? -1) >= 0);
            if (!from) continue;
            // A food row is in lobsters (squad.ts): a donor's item is counted by the HP it heals against the lobster's.
            const count = Math.min(spare(from, item), item in SQUAD_FOOD_HEAL ? Math.ceil(row.short * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL[item]!) : row.short);
            const sendId = exactItemIds().get(item);
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(member.name);
            done.set(member.name, { account: member.name, template: SQUAD_RESTOCK, value: 0, reason: `restocks ${count} ${item} for the gang squad, sent by ${from.name}`, resources: [],
                send: { from: from.name, to: member.name, item, count, template: SQUAD_RESTOCK.id, ...(sendId !== undefined ? { itemId: sendId } : {}) } });
            break;
        }
    }
    // Then the filler bands, for an army account that no band and no kit took.
    for (const c of cands.filter(c => c.goal && !c.lacks && c.template.filler).sort(goalOrder)) take(c, 0);
    // The gear pass: an account that no band, kit or send took and that has a want above the gain floor (gear-want-jobs.ts)
    // buys it before any coin job, from its own coins only. A running training session is replaced only for a larger gain.
    const gearValue = new Map<string, number>();
    for (const a of mine) {
        const lower = a.name.toLowerCase(), rows = inp.gearWants?.get(lower);
        if (!rows?.length || done.has(a.name) || gave.has(a.name) || gaveItems.has(a.name) || vacated.has(a.name)) continue;
        // Both jobs are pilots: nothing starts live until the `aio` list of swarm.json names `gear-ge` or `gear-shop` (Inputs.pilots).
        // The room keeps what the account's bands keep (keepCoins), as the kit buy of a band does.
        const keepCoins = Math.max(0, ...inp.templates.filter(t => t.tier === 'goal' && bandLeft(t, a) > 0 || t.id === inp.current?.get(lower)).map(t => t.keepCoins?.(a) ?? 0));
        const job = gearJobFor(rows, { coins: a.items.coin ?? 0, room: KIT_CASH_RESERVE + KIT_COIN_MARGIN + keepCoins, running: !!inp.running?.has(lower),
            held: id => !inp.pilots?.has(id === GEAR_GE_ID ? GEAR_GE_PILOT : GEAR_SHOP_PILOT) || !!inp.retired?.has(pairKey(a.name, id === GEAR_GE_ID ? KIT_BUY + id : id)) });
        if (!job) continue;
        const place = job.kind === 'ge' ? ARMOUR_MARKET : `shop:${job.profile}`;
        if ((used.get(place) ?? 0) >= (inp.capacity?.[place] ?? 1)) continue;
        used.set(place, (used.get(place) ?? 0) + 1);
        gearValue.set(a.name, job.value);
        const bonus = `${job.gain.toFixed(1)} points of bonus`;
        if (job.kind === 'ge') {
            const lines: KitLine[] = job.lines.map(l => ({ item: l.name, id: l.id, quantity: 1, held: 0, limit: l.limit }));
            const template = kitBuyTemplate({ id: GEAR_GE_ID, goal: 'wear better gear' } as Template, a.name, lines, inp.kitSeq?.get(lower) ?? 0, KIT_CASH_RESERVE);
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${lines.map(l => l.item).join(', ')} on the market for ${bonus}, at most ${job.cost} coins` });
        } else {
            const items = job.items.map(i => i.name.replace(/[^a-zA-Z0-9 '-]/g, c => `\\${c}`)).join('|');
            const template: Template = { id: gearShopId(job.profile), family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: [job.profile, '1500'],
                env: { ITEMS: items, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(job.spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(job.spend) },
                role: 'supply', goal: `buy ${job.items.map(i => i.name).join(', ')} from the ${job.shop} to wear better gear`, repeats: false, resources: [place], yields: () => [] };
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${job.items.map(i => i.name).join(', ')} at ${job.shop} for ${bonus}, at most ${job.spend} coins` });
        }
    }
    // A recipient that cannot earn its kit may need a helper to become a donor. Reserve one helper for one finite
    // recipient, including the donor's retained cash. Compare full estimated ticks: earning on the recipient avoids
    // that reserve and wins whenever it costs less. Existing donors and kit orders have already had their turn.
    const cash = funding();
    const coinOptions = cands.filter(c => !c.goal && c.supply && makesCoins(c.supply.template, c.supply.account));
    const free = (c: Cand) => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account)
        && c.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1))
        && (!c.coins || [...pool].some(([name, coins]) => !done.has(name) && coins >= c.coins! && canGiveCoins(name, c.account)));
    for (const [recipient, short] of [...cash.army].sort(([x], [y]) => x.localeCompare(y))) {
        const owner = localByName.get(recipient)!;
        if (short <= 0 || done.has(owner.name) || gave.has(owner.name) || gaveItems.has(owner.name) || vacated.has(owner.name)) continue;
        const gap = Math.max(0, (cash.kits.get(recipient) ?? 0) - (owner.items.coin ?? 0) - (earnedCoins.get(recipient) ?? 0));
        const options = coinOptions.filter(c => free(c) && !bridges.has(c.account.toLowerCase())
            && (c.account.toLowerCase() === recipient || (!(cash.army.get(c.account.toLowerCase()) ?? 0) && canGiveCoins(c.account, recipient)
                && (!inp.unfundable?.has(c.account.toLowerCase()) || (inp.current?.get(c.account.toLowerCase()) === c.template.id && c.template.id === c.supply!.template.id)))))
            .map(c => {
                const lower = c.account.toLowerCase(), own = lower === recipient, target = FUND_RESERVE + gap;
                const coins = own ? short : Math.max(0, target - (localByName.get(lower)?.items.coin ?? 0) - (earnedCoins.get(lower) ?? 0));
                const rate = c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : used.get(r) ?? 0),
                    c.supply!.share * jobValue(c.supply!.template, c.supply!.account, values, item => item === 'coin' ? Infinity : 0));
                return { c, own, target, ticks: rate > 0 ? coins / rate : Infinity };
            }).filter(x => Number.isFinite(x.ticks))
            .sort((x, y) => x.ticks - y.ticks || Number(y.own) - Number(x.own) || keeps(y.c) - keeps(x.c) || x.c.account.localeCompare(y.c.account) || x.c.template.id.localeCompare(y.c.template.id));
        const chosen = options[0];
        if (chosen && !chosen.own) { bridges.set(chosen.c.account.toLowerCase(), { recipient: owner.name, target: chosen.target }); bridged.add(recipient); fundingEpoch++; }
    }
    // The supply tier, re-sorted after every assignment: each job reserves the useful output it can bring before
    // the next pass, and each resource holder lowers the worth of candidates that share its resource.
    let rest = cands.filter(c => !c.goal && !c.lacks && !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account));
    let dirty = true;
    const scores = new Map<Cand, number>();
    while (rest.length) {
        if (dirty) {
            rest = rest.filter(c => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account) && !c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            if (!rest.length) break;
            scores.clear();
            for (const c of rest) scores.set(c, worth(c));
            rest.sort((x, y) => scores.get(y)! - scores.get(x)! || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id));
            dirty = false;
        }
        const c = rest.shift()!;
        const v = scores.get(c)!;
        if (v <= 0) break;
        const prevDone = done.size;
        take(c, v);
        if (done.size !== prevDone) dirty = true;
    }
    // A fully owned recipe or band may lack only its cash/fare. Keep local work and its donor arbitration first;
    // only a remaining idle slot asks remote cash through the same Funding order.
    for (const c of [...cands.filter(c => c.goal && !c.lacks && c.coins).sort(goalOrder), ...cands.filter(c => !c.goal && !c.lacks && c.coins).sort(order)]) take(c, worth(c), true);
    // A vacant slot names its constraint: the fare it lacks for a job whose place is still free, when that is all it lacks.
    const noFare = (a: Acct) => { const x = fareShort.get(a.name)?.find(x => x.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1)));
        return x ? `vacant: lacks ${x.coins} coins for the way to ${x.id} (ferry fare ${x.fare}), and no free account can give them` : undefined; };
    // More jobs than free bot slots: the best keep theirs. An account whose bot holds a slot now (a confirmed live session,
    // or a run that the swarm lists, a start inside its window included) keeps a job whatever the count, so a hand job that
    // the owner enables never stops a running planner job, and a kit buy that replaces a running band keeps its account's
    // slot. The rest rank by goal band and the levels left, then supply jobs by worth, and fill the slots that remain. The
    // others wait for a slot (the swarm admits no more).
    const waits = new Map<string, string>();
    if (inp.slots !== undefined) {
        // A fund or send assignment starts an order that logs in two accounts (the recipient and the donor): it costs two bots.
        const cost = (x: Assignment) => x.fund || x.send ? 2 : 1;
        const jobs = [...done.values()].filter(x => x.template);
        if (jobs.reduce((n, x) => n + cost(x), 0) > inp.slots) {
            const holds = (x: Assignment) => !!inp.running?.has(x.account.toLowerCase()) || !!inp.holding?.has(x.account.toLowerCase());
            // The gang squad's stock comes first while the squad is active: its restock, then its supply jobs, then the goal bands.
            // The squad is the live consumer of these lines: a bank trip that is short of one of them ends the squad's run.
            const rank = (x: Assignment): number[] => {
                const id = x.template!.id, c = cands.find(k => k.account === x.account && (k.template.id === id || KIT_BUY + k.template.id === id));
                if (id === SQUAD_RESTOCK.id) return [0, -2, 0];
                if (c?.template.squadOnly) return [0, -1, -worth(c)];
                return c?.goal ? [0, c.goal.band, c.goal.left] : c ? [1, -worth(c), 0] : gearValue.has(x.account) ? [0, 1e6, -gearValue.get(x.account)!] : [2, 0, 0];
            };
            const holders = jobs.filter(holds);
            let room = Math.max(0, inp.slots - holders.reduce((n, x) => n + cost(x), 0));
            const others = jobs.filter(x => !holds(x)).map(x => ({ x, r: rank(x) })).sort((p, q) => { for (let i = 0; i < 3; i++) if (p.r[i] !== q.r[i]) return p.r[i]! - q.r[i]!; return p.x.account.localeCompare(q.x.account); });
            for (const { x } of others) {
                if (cost(x) <= room) { room -= cost(x); continue; }
                done.delete(x.account);
                if (x.fund) gave.delete(x.fund.from);
                if (x.send) gaveItems.delete(x.send.from);
                waits.set(x.account, `vacant: waits for a bot slot (${inp.slots} free, ${holders.length} held by running bots): ${x.template!.id} ranks below the jobs that hold them`);
            }
        }
    }
    // The first gate that stopped the account's nearest template (see `misses`), or what its candidates met.
    const full = (c: Cand) => c.resources.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
    const vacancy = (a: Acct): string => {
        const list = misses.get(a.name) ?? [], has = (gate: Miss['gate']) => list.filter(m => m.gate === gate);
        // The nearest job the account could do but for one gate: a candidate that no pass took, then a template that
        // stopped before it was a candidate.
        const job = (): string | undefined => {
            const own = cands.filter(c => c.account === a.name).sort((x, y) => Number(!!y.goal) - Number(!!x.goal) || (x.goal?.band ?? 0) - (y.goal?.band ?? 0) || worth(y) - worth(x) || x.template.id.localeCompare(y.template.id));
            for (const c of own) {
                const id = c.template.id, place = full(c);
                if (place) return `${id} has no free place on ${place}`;
                if (c.lacks) return `${id} needs ${c.lacks.map(l => `${l.count} ${l.of[0]}`).join(', ')} and no source gives them`;
                if (c.coins) return `${id} needs ${c.coins} coins and no free account can give them`;
            }
            const coins = has('coins').find(m => !(m.template.resources ?? []).some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            const crowded = has('coins')[0]?.template.resources?.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
            if (crowded && !coins) return `${has('coins')[0]!.template.id} has no free place on ${crowded}`;
            if (coins) return `${coins.template.id} needs ${coinShort(a, coins.template.needs)} coins and no free account can give them`;
            const none = has('demand')[0];
            const needs = has('needs').map(m => ({ m, lacking: unmet(a, m.template.needs) })).filter(x => x.lacking.length)
                .sort((x, y) => x.lacking.length - y.lacking.length || x.m.template.id.localeCompare(y.m.template.id))[0];
            if (needs && (!none || needs.lacking.length <= 1)) return `${needs.m.template.id} needs ${needs.lacking.join(', ')}`;
            if (none) return `${none.template.id} has no finite demand`;
            const reach = has('reach')[0];
            if (reach) return `${reach.template.id} has no way from where the account stands`;
            const pilot = has('pilot').find(m => meets(a, m.template.needs));
            if (pilot) return `${pilot.template.id} is a pilot that the aio list does not name`;
            const retired = has('retired')[0];
            if (retired) return `${retired.template.id} is retired for this account`;
            return undefined;
        };
        // With no finite demand no supply job has value, whatever it lacks; a goal band still stands apart from demand.
        // An observation that is too old to offer stock is a cause of "no source", so the reason says so.
        const sourceless = (text: string | undefined) => {
            if (!text || !/ and no source/.test(text)) return text;
            const notes: string[] = [];
            if (inp.now !== undefined && a.observedAt !== undefined && inp.now - a.observedAt > OBSERVATION_FRESH_MS) notes.push(`its own observation is ${Math.round((inp.now - a.observedAt) / 3_600_000 * 10) / 10} h old`);
            if (inp.unobserved?.length) notes.push(`${inp.unobserved.length} free accounts have no observation under ${OBSERVATION_FRESH_MS / 60_000} minutes old, so their stock is not offered`);
            return notes.length ? `${text} (${notes.join('; ')})` : text;
        };
        const roster = has('roster')[0], other = sourceless(demand.some(d => d.short > 0) ? job() : 'no finite route or army supply demand');
        if (roster) return `vacant: not on the army roster (${has('roster').length} bands, nearest ${roster.template.id})${other ? `; otherwise ${other}` : ''}`;
        return `vacant: ${other ?? 'no template meets its skills and holdings'}`;
    };
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass'
        : gaveItems.has(a.name) ? 'vacant: gives a kit item this pass' : waits.get(a.name) ?? vacated.get(a.name) ?? noFare(a) ?? vacancy(a) });
}
