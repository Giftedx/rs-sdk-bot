// Combat kit selection, cast/arrow budgeting, and kill-style checks for gathered drops.
import {
    ARROWS,
    ARROWS_PER_KILL,
    BOWS,
    CASTS_MIN,
    EASY_KILL,
    KILL_SOURCES,
    SPELLS,
    STAFF_RUNE,
    type Gather,
    type Item,
} from './sources';

export type MagicKit = { staff?: number; component: string; level: number; maxhit: number; runes: Record<number, number> };
export type KillStyle = 'melee' | 'ranged' | 'magic';

// The strongest strike the Magic level allows whose runes, less the one a staff owned covers, are owned for CASTS_MIN casts
// (TheFullMonty: Magic 99, a staff of fire, air and mind runes: Fire Strike at 2 air and 1 mind a cast).
// `casts`: the casts the runes must cover. The plan asks for CASTS_MIN; a fight asks for one more kill's casts, so a
// series that has spent most of its budget still takes its last easy animal (a chicken after a bear).
// `sold`: a rune a shop sells counts as covered; the sweep's shop plan buys the kit's shortfall with its other
// consumables (Quickhandjob: Magic 29, fire runes and nothing else; Aubury sells the air and mind runes).
const STAFF_IDS = Object.keys(STAFF_RUNE).map(Number);
const REVERSED_SPELLS = [...SPELLS].reverse().map(sp => ({
    ...sp,
    runeEntries: Object.entries(sp.runes).map(([id, n]) => [Number(id), n] as const),
}));

function countOwned(owned: readonly Item[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (let i = 0; i < owned.length; i++) {
        const item = owned[i]!;
        counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
    }
    return counts;
}

export function magicKit(owned: readonly Item[], magic: number, casts = CASTS_MIN, sold: (id: number) => boolean = () => false): MagicKit | null {
    const counts = countOwned(owned);
    const have = (id: number) => counts.get(id) ?? 0;
    const staffs: (number | undefined)[] = [];
    for (let i = 0; i < STAFF_IDS.length; i++) {
        const id = STAFF_IDS[i]!;
        if (have(id) >= 1) staffs.push(id);
    }
    staffs.push(undefined);
    for (let si = 0; si < REVERSED_SPELLS.length; si++) {
        const sp = REVERSED_SPELLS[si]!;
        if (sp.level > magic) continue;
        for (let st = 0; st < staffs.length; st++) {
            const staff = staffs[st];
            const covered = staff === undefined ? undefined : STAFF_RUNE[staff];
            let ok = true;
            for (let ri = 0; ri < sp.runeEntries.length; ri++) {
                const [id, n] = sp.runeEntries[ri]!;
                if (id === covered) continue;
                if (have(id) < n * casts && !sold(id)) { ok = false; break; }
            }
            if (!ok) continue;
            const runes: Record<number, number> = {};
            for (let ri = 0; ri < sp.runeEntries.length; ri++) {
                const [id, n] = sp.runeEntries[ri]!;
                if (id !== covered) runes[id] = n;
            }
            return { staff, component: sp.component, level: sp.level, maxhit: sp.maxhit, runes };
        }
    }
    return null;
}

// Casts a kill takes: the animal's hitpoints over half the spell's max hit (the mean of a hit), at three hits in five,
// plus one; the strike goes out every five ticks whether or not the last one landed.
export const castsPerKill = (id: number, maxhit: number) => {
    const src = KILL_SOURCES[id];
    return src ? Math.ceil(src.hp / (maxhit / 2) / 0.6) + 1 : 0;
};

// Casts for the series: a chance drop's kills are the attempts the drop may take, so the plan buys runes for the series;
// a fight asks castsPerKill, one animal's casts, so a series that has spent most of its budget still takes its next animal.
export const castsFor = (id: number, count: number, maxhit: number) => {
    const src = KILL_SOURCES[id];
    if (!src) return 0;
    const kills = src.chance < 1 ? killAttempts(id, count) : count;
    return kills * castsPerKill(id, maxhit);
};

// The arrows are the kind owned in the greatest number (UnderMyKilt: 21 bronze, 19 iron): the shortfall for a long kill
// series is bought, and bronze arrows are the kind most shops sell.
export function rangedKit(owned: readonly Item[]): { bow: number; arrows: number } | null {
    const counts = countOwned(owned);
    const have = (id: number) => counts.get(id) ?? 0;
    const bow = BOWS.find(id => have(id) >= 1);
    let arrows: number | undefined;
    let bestCount = -1;
    for (let i = 0; i < ARROWS.length; i++) {
        const id = ARROWS[i]!;
        const c = have(id);
        if (c >= ARROWS_PER_KILL && c > bestCount) { bestCount = c; arrows = id; }
    }
    return bow !== undefined && arrows !== undefined ? { bow, arrows } : null;
}

// The drops a kill series takes: its own item and every later kill item of the same animal still short (the four
// beads fall from the same imps, so a red bead lying by a black-bead kill is picked up, not killed for again).
export const sharedDrops = (gathers: readonly Gather[], g: Gather, held: (id: number) => number, targets: ReadonlyMap<number, number>): number[] => [
    g.id,
    ...gathers
        .filter(o => o !== g && o.how === 'kill' && KILL_SOURCES[o.id]?.npcs.some(n => KILL_SOURCES[g.id]?.npcs.includes(n)) && held(o.id) < (targets.get(o.id) ?? held(o.id) + o.count))
        .map(o => o.id),
];

// Kills allowed for `count` drops: half again the expected number, plus three misses.
export const killAttempts = (id: number, count: number) => Math.ceil(count / (KILL_SOURCES[id]?.chance ?? 1) * 1.5) + 3;

// The style that beats the animal. An easy animal that drops every kill (a chicken, a rat) dies to bare hands and costs
// no arrows or runes, but only for an account with no kit: a wielded bow fires an arrow and a wielded staff with
// autocast casts on every attack, so with a kit the kill is the kit's and its ammunition is budgeted (a staff account's
// bare-hand rat spent the mind runes its bear needed). Otherwise the highest level that beats the animal's combat level wins: melee by the Attack level,
// the bow by Ranged, the strike spell by Magic (Ranged and Magic are 1 without a kit). The sweep's melee is bare-handed,
// so it also needs a Strength level at or above the animal's combat level: an Attack level in the sixties with Strength
// near 1 does not beat a bear or a series of goblins. A drop by chance (goblin mail) is a series of kills and takes the
// stronger style even against an easy animal.
export function killStyle(id: number, attack: number, ranged = 1, magic = 1, strength = attack): KillStyle | null {
    const src = KILL_SOURCES[id];
    if (!src) return null;
    const c = src.combat;
    if (c <= EASY_KILL && src.chance === 1 && ranged <= 1 && magic <= 1) return 'melee';
    const styles: [KillStyle, number][] = [
        ['melee', c < attack && strength >= c ? attack : 0],
        ['ranged', c < ranged ? ranged : 0],
        ['magic', c < magic ? magic : 0],
    ];
    const best = styles.filter(([, level]) => level > 0).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
}

// Arrows for the kills: ARROWS_PER_KILL for each drop that comes every kill (a bear's 27 hitpoints), two for each attempt
// of a series of kills whose animal dies to one arrow (a goblin's 5).
export const arrowsFor = (id: number, count: number) =>
    (KILL_SOURCES[id]?.chance ?? 1) < 1 ? 2 * killAttempts(id, count) : (KILL_SOURCES[id]?.arrows ?? ARROWS_PER_KILL) * count;

export const canKill = (id: number, attack: number, ranged = 1, magic = 1, strength = attack) =>
    killStyle(id, attack, ranged, magic, strength) !== null;
