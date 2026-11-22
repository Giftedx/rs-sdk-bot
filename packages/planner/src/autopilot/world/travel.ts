// World geometry, bank/shop places, ferry fares, meeting places, and template reachability checks.
import { norm, type Spot, type Template } from './model';
import { AIO_PLACES, ARMY_BANK, COW_FIELD, SPLASH_FENCE, STRIKE_TILE, TROOPER_FIELD } from './capacity';

// The reach rule: a job goes only to an account that has a way to its place. One route query between the Varrock
// side and Kandarin runs for more than 30 s (research/walking.md, Planner reach rule), so the planner asks none. It
// uses the regions of the shared walker's ferry rule (scripts/walk-to.ts walkWithFerryFallback; scripts/autopilot.test.ts
// keeps the fares equal):
// - From the east side to Ardougne the walker takes two ferries, and it wants the fare before it plans: 60 coins, or
//   70 from the Al Kharid side of the toll gate. It takes the coins from a bank, so the pack and the bank count.
// - From Kandarin to the east side it walks to the Ardougne north bank and takes the two ferries: 60 coins.
// - From the east side to the rest of Kandarin it walks over White Wolf Mountain. It refuses that walk to an account
//   that a wolf there can kill (Inputs.mountain), and such an account has no way.
// - An account on Karamja leaves by one ferry: 30 coins. No donor can meet it there (meetFor).
// A start on Tutorial Island counts as Lumbridge: the walker skips the tutorial first. A floor above the ground counts
// as the ground under it. An unknown start (no status, a live session, a cave) has no rule, and neither has a place
// outside these regions or a template with no place.
export const FERRY_FARE = 30, TOLL = 10;
const LUMBRIDGE: Spot = { x: 3222, z: 3218 };
const onTutorialIsland = (p: Spot) => p.x >= 3050 && p.x <= 3160 && p.z >= 3050 && p.z <= 3140;
// The ground of Karamja, in three steps so that Rimmington stays out. Measured on the collision map: the steps hold
// 26,315 of the 26,625 tiles of the island's connected ground and no tile of the mainland.
export const onKaramja = (p: Spot) => p.x >= 2704 && p.z >= 2939 && p.x <= (p.z <= 3149 ? 2959 : p.z <= 3193 ? 2948 : p.z <= 3247 ? 2812 : 0);
const inEast = (p: Spot) => !onKaramja(p) && p.x >= 2870 && p.x <= 3280 && p.z >= 3150 && p.z <= 3510;
const inKandarin = (p: Spot) => !onKaramja(p) && p.x >= 2440 && p.x < 2870 && p.z >= 3040 && p.z <= 3530;
// Walled West Ardougne compound: city doors stay shut until Biohazard completes and world.route finds no exit across the wall.
export const inWestArdougne = (p: Spot) => p.x >= 2496 && p.x <= 2557 && p.z >= 3264 && p.z <= 3335;
const ardougneTarget = (p: Spot) => p.x >= 2600 && p.x <= 2690 && p.z >= 3260 && p.z <= 3360;
// The tile a job's worker walks to first, by resource: the Ardougne north bank for the cow field, its two Magic tiles
// and the troopers; the bank of each shop (scripts/shop-buyer.ts PROFILES bankSpot; scripts/autopilot.test.ts keeps
// them equal); the Catherby and Seers' Village banks; the flax field. Left out: a place that the worker reaches by its
// own travel (the black dragons by teleport, Jakut in Zanaris, a quest) and a place outside the regions.
// A knight spot is not its own first walk: scripts/goldfarm.ts takes an account from far away to the Ardougne south
// bank and walks to the knight from there (scripts/autopilot.test.ts keeps the tile equal), so each spot has the ferry
// rule of Ardougne, the spot west of the rule's Ardougne box too.
export const KNIGHT_BANK: Spot = { x: 2654, z: 3283 };
export const SEERS_BANK: Spot = { x: 2727, z: 3492 }, DRAYNOR_BANK: Spot = { x: 3092, z: 3243 };
const CATHERBY_BANK: Spot = { x: 2809, z: 3441 }, VARROCK_EAST_BANK: Spot = { x: 3253, z: 3420 };
export const PLACES: Readonly<Record<string, Spot>> = {
    [COW_FIELD]: ARMY_BANK, [STRIKE_TILE]: ARMY_BANK, [SPLASH_FENCE]: ARMY_BANK, [TROOPER_FIELD]: ARMY_BANK,
    'catherby:lobster': CATHERBY_BANK, [AIO_PLACES.flax]: { x: 2744, z: 3445 }, [AIO_PLACES.yews]: SEERS_BANK,
    'shop:ardy': { x: 2654, z: 3283 }, 'shop:catherby': CATHERBY_BANK, 'shop:catherby_arrows': CATHERBY_BANK, 'shop:dargaud': SEERS_BANK, 'shop:magic_guild': { x: 2612, z: 3093 },
    'shop:magic_guild_elemental': { x: 2612, z: 3093 }, 'shop:alfonse': { x: 2654, z: 3283 }, 'shop:tiadeche': { x: 2654, z: 3283 },
    'shop:oziach': { x: 3094, z: 3491 }, 'shop:herquin': { x: 2946, z: 3368 }, 'shop:gem_trader': { x: 3269, z: 3167 },
    'shop:tenzing': { x: 2946, z: 3368 }, 'shop:jukat_dagger': { x: 3152, z: 9578 }, 'shop:taverley': { x: 2934, z: 3376 },
    'shop:siegfried': { x: 2654, z: 3283 }, 'shop:helemos': { x: 2946, z: 3368 }, 'shop:bob': DRAYNOR_BANK,
    'aio:water-altar': DRAYNOR_BANK, 'squad:cosmic-altar': DRAYNOR_BANK, 'fighter:wizards-tower': DRAYNOR_BANK, 'squad:catherby-sharks': CATHERBY_BANK,
    'squad:crystal-chest': { x: 2946, z: 3368 }, 'squad:heroes-fountain': { x: 2946, z: 3368 },
    'squad:shilo-karambwanji': { x: 2852, z: 2955 }, 'squad:shilo-karambwan': { x: 2852, z: 2955 }, 'squad:catherby-cooking': CATHERBY_BANK,
    'squad:seers-magic-trees': SEERS_BANK, 'squad:seers-fletch': SEERS_BANK,
    'squad:varrock-smithing': { x: 3185, z: 3436 }, 'squad:al-kharid-craft': { x: 3269, z: 3167 },
    'squad:rimmington-gold': { x: 2946, z: 3368 }, 'squad:hobgoblin-snape': { x: 2946, z: 3368 },
    'squad:chaos-temple-wine': { x: 2946, z: 3368 }, 'squad:edgeville-unicorns': { x: 3092, z: 3496 },
    'squad:ardougne-giants': { x: 3092, z: 3496 }, 'squad:taverley-druids': { x: 2946, z: 3368 },
    'squad:taverley-scales': { x: 2946, z: 3368 }, 'squad:taverley-black-dragons': { x: 2946, z: 3368 },
    'squad:karamja-red-spiders-eggs': ARMY_BANK,
    'squad:herblore-bank': CATHERBY_BANK, 'squad:magic-enchant': DRAYNOR_BANK,
    'squad:ardougne-blood-chest': ARMY_BANK, 'squad:varrock-earth-altar': VARROCK_EAST_BANK,
    'squad:isafdar-berries': ARMY_BANK, 'squad:taverley-black-knights': { x: 2946, z: 3368 },
    'squad:barbarian-planks': SEERS_BANK, 'squad:gnome-toads': { x: 2449, z: 3482 },
    'shop:sarim': DRAYNOR_BANK, 'shop:betty': DRAYNOR_BANK, 'shop:aubury': VARROCK_EAST_BANK, 'shop:lowe': VARROCK_EAST_BANK, 'shop:zaff': { x: 3185, z: 3436 },
    'shop:zeke': { x: 3269, z: 3167 }, 'shop:dommik': { x: 3269, z: 3167 }, 'shop:dommik_moulds': { x: 3269, z: 3167 }, 'shop:jiminua': { x: 2654, z: 3283 }, 'shop:nurmof': { x: 3013, z: 3355 }, 'shop:scavvo': { x: 3185, z: 3436 },
    'shop:skulgrimen': SEERS_BANK, 'shop:shantay': { x: 3269, z: 3167 }, 'shop:horvik': VARROCK_EAST_BANK, 'shop:louie': { x: 3269, z: 3167 },
    'shop:valaine': { x: 3185, z: 3436 }, 'shop:wydin_choc': DRAYNOR_BANK, 'shop:thessalia': VARROCK_EAST_BANK, 'shop:thessalia_gown': VARROCK_EAST_BANK, 'shop:baker': { x: 2654, z: 3283 },
};
// A template's place: its first resource with one. A chicken pen carries its tile, and a knight spot has the bank.
export function placeOf(t: Pick<Template, 'resources'>): Spot | undefined {
    for (const r of t.resources ?? []) {
        if (r.startsWith('knight:')) return KNIGHT_BANK;
        const m = r.match(/^pen:(\d+),(\d+)$/);
        if (m) return { x: Number(m[1]), z: Number(m[2]) };
        if (PLACES[r]) return PLACES[r];
    }
    return undefined;
}
// The coins the way from `pos` to `place` costs in ferry fares and the toll: 0 for a way with no fare or with no rule,
// null for no way. `mountain`: the account may walk over White Wolf Mountain.
export function wayCost(pos: Spot | undefined, place: Spot | undefined, mountain: boolean): number | null {
    if (!pos || !place) return 0;
    const at = onTutorialIsland(pos) ? LUMBRIDGE : pos;
    if (inWestArdougne(at) !== inWestArdougne(place)) return null;
    if (onKaramja(at)) return onKaramja(place) ? 0 : FERRY_FARE;
    if (inEast(at) && ardougneTarget(place)) return 2 * FERRY_FARE + (at.x >= 3250 && at.z <= 3230 ? TOLL : 0);
    if (inEast(at) && inKandarin(place)) return mountain ? 0 : null;
    if (inKandarin(at) && inEast(place)) return 2 * FERRY_FARE;
    return 0;
}
// Where a coin order meets an account that stands at `pos`: the Ardougne north bank for a start in Kandarin, which
// has no way east without the fare; null on Karamja or inside West Ardougne, where no order can reach the account; else Varrock West (undefined).
export function meetFor(pos: Spot | undefined): 'ardougne' | null | undefined {
    return !pos ? undefined : onKaramja(pos) || inWestArdougne(pos) ? null : inKandarin(pos) ? 'ardougne' : undefined;
}
// The template with `fare` more coins in its coin need.
export function withFare(t: Template, fare: number): Template {
    const key = Object.keys(t.needs?.items ?? {}).find(i => norm(i) === 'coin') ?? 'coins';
    return { ...t, needs: { ...t.needs, items: { ...t.needs?.items, [key]: (t.needs?.items?.[key] ?? 0) + fare } } };
}
