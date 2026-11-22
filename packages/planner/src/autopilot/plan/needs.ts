// Account combat style selection, template needs matching, kit shortfalls, and donor kit reserve ceilings.
import { ownsWearableMeleeWeapon, type CombatFocus } from '../../gear-progression';
import { bandLeft, combatLevel, norm, questDone, type Acct, type Lack, type Template } from '../world';
import { COW_WEAPONS, FOOD_HEAL, foodHeal } from '../pricing';

// The combat style an account trains, for its gear wants: the style of the band it runs now, else of the next army band it has levels
// left in (the lowest band number first). An account off the army with no such job, or with no band left, has none.
export const SKILL_STYLE: Readonly<Record<string, CombatFocus>> = { Attack: 'melee', Strength: 'melee', Defence: 'melee', Hitpoints: 'melee', Ranged: 'ranged', Magic: 'magic' };
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
export const frailShort = (a: Acct, needs: Template['needs']) => !needs?.frail || (a.skills.Hitpoints ?? 10) >= needs.frail.hitpoints ? 0
    : Math.max(0, needs.frail.count - needs.frail.of.reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0));
const healthMet = (a: Acct, needs: Template['needs']) => !needs?.hpAboveHalf
    || (Number.isFinite(a.currentHP) && a.currentHP! > Math.ceil((a.skills.Hitpoints ?? 10) / 2));
export const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }): boolean =>
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
export const coinShort = (a: Acct, needs: Template['needs']) => Math.max(0, (Object.entries(needs?.items ?? {}).find(([i]) => norm(i) === 'coin')?.[1] ?? 0) - (a.items.coin ?? 0));
export const withoutCoins = (needs: Template['needs']): Template['needs'] => ({ ...needs, items: Object.fromEntries(Object.entries(needs?.items ?? {}).filter(([i]) => norm(i) !== 'coin')) });

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
