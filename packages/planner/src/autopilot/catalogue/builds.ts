// PK build quest route tables and goal band adaptation (`buildBand`).
import { norm, questDone, type Acct, type Template } from '../world';

// The quest route of each PK build (scripts/pk-kits.ts), by kit name: the quests that the items and varps of the kit
// need. No reward of those quests, or of the quests they need, gives a level over the kit: scripts/pk-kits.ts
// `kitRoute` works the route out from the wear rules and the quest rewards of the content, and scripts/pk-kits.test.ts
// keeps this table equal to it (research/pvp-fight-loop.md, "Quest routes of the builds"). A band of the route runs
// every quest of its chain. The fights of Lost City give their XP to Strength and Hitpoints: the quest script sets
// that style before each fight (quest-lib.ts strengthStyle). A kit with no entry has no route.
const LOST: readonly string[] = ['Lost City'], NONE: readonly string[] = [], TRIALS: readonly string[] = ['The Fremennik Trials'];
export const BUILD_QUESTS: Readonly<Record<string, readonly string[]>> = {
    'pure-bolt': NONE, 'pure-dds': LOST, 'pure-dds-msb': LOST, 'pure-r2h': NONE,
    'pure-hally': ['Regicide'], 'pure-ranger': NONE, 'pure-mage': NONE, 'pure-tribrid': LOST, 'pure-pray': LOST, 'rune-pure': LOST,
    zerker: ['Lost City', 'The Fremennik Trials'], dragon: LOST, 'range-tank': TRIALS, 'mage-tank': NONE, 'pure-scim': NONE, 'pure-dlong': LOST,
    'pure-knives': LOST, 'pure-pray31': LOST, 'pure-god': ['Mage Arena'], 'pure-max': LOST, 'addy-pure': LOST, def50: LOST, 'tank-range': TRIALS,
    'baby-pure': NONE, 'low-ranger': NONE, 'low-mage': NONE, 'low-addy': NONE, skiller: NONE,
    // The least build that fights the dagger gang at its post (combat 111).
    'live-walker-iron-snare-rune-nopot-b111': ['Dragon Slayer', 'Lost City'],
};
// A quest of a route with the quests that it needs and that have a band of their own: a band for one of those is on
// the route too (scripts/pk-kits.ts QUEST_CHAIN has the whole chain of each quest).
export const ROUTE_BEFORE: Readonly<Record<string, readonly string[]>> = { Regicide: ['Underground Pass'] };
const onRoute = (quests: readonly string[], name: string) => quests.some(q => norm(q) === norm(name) || (ROUTE_BEFORE[q] ?? []).some(b => norm(b) === norm(name)));
// A goal band for an account with a PK build, or null when the account must not take it. A build is its levels: one
// level over the Defence or Prayer of a build is a different build, and no account goes back. So such an account
// takes only bands that train one skill, and a band stops at the level of the build:
// - a skill at its level takes no band;
// - a band of scripts/gather-combat.ts whose TRAIN_SKILL is the skill of the band stops at the level (TARGET_LEVEL;
//   giantStyle picks a style that gives XP to that skill and to Hitpoints only). It buries no bones (GIANT_BURY):
//   bones give Prayer XP whatever the band trains;
// - a gather-combat band with another TRAIN_SKILL or a kill count (GIANT_KILLS) is refused: the kill count replaces
//   the level stop, and TRAIN_SKILL=Hitpoints keeps the style the account had, which can train any melee skill;
// - the Prayer band that buries held normal bones (scripts/train-prayer.ts) stops at the level: its target argument;
// - the adaptive Ranged worker stops at its target argument and delegates troopers without burying bones;
// - a band of another script that ends above the level is refused: that script has no proved stop;
// - a quest band is refused unless the quest is on the route of the build (BUILD_QUESTS): a quest reward gives XP in
//   skills nobody chose. A quest of the route is refused too while a skill of the account is over its level before
//   the route (`before`): the reward on top of that level ends over the build. A band that names the skills its
//   chain gives XP in (`gives`) checks only those: Regicide gives no Attack, so the Attack 61 that Underground Pass
//   gave does not refuse it;
// - while a quest of the route is open, a training band stops at the level before the route, not at the level of
//   the build: the quest brings the rest;
// - a stock band is refused: a fight for loot gives XP in skills nobody chose.
// A `buildOnly` band goes to no account without a build.
export function buildBand(t: Template, a: Acct, build?: Readonly<Record<string, number>>, quests: readonly string[] = [], before?: Readonly<Record<string, number>>): Template | null {
    if (!build) return t.buildOnly ? null : t;
    if (t.tier !== 'goal') return t;
    if (t.quest) return onRoute(quests, t.quest.name) && Object.entries(before ?? {}).every(([skill, level]) => skill === 'Hitpoints' || (t.gives && !t.gives.includes(skill)) || (a.skills[skill] ?? 1) <= level) ? t : null;
    if (t.id === 'army-quest-fletch-30') return null;
    if (!t.trains) return null;
    if (t.route && !(onRoute(quests, t.route) && !questDone(a, t.route))) return null;
    const open = quests.some(q => !questDone(a, q)), cap = build[t.trains.skill];
    const level = cap !== undefined && open && before?.[t.trains.skill] !== undefined ? Math.min(cap, before[t.trains.skill]!) : cap;
    const combat = t.script === 'scripts/gather-combat.ts';
    if (combat && (t.env?.TRAIN_SKILL !== t.trains.skill || t.env.GIANT_KILLS !== undefined)) return null;
    if (level === undefined) return combat ? { ...t, env: { ...t.env, GIANT_BURY: '0' } } : t;
    if ((a.skills[t.trains.skill] ?? 1) >= level) return null;
    const to = Math.min(t.trains.to, level);
    if (combat) return { ...t, env: { ...t.env, TARGET_LEVEL: String(to), GIANT_BURY: '0' }, trains: { ...t.trains, to } };
    if (t.script === 'scripts/ranged-train.ts' && t.trains.skill === 'Ranged') return { ...t, args: [String(to), ...(t.args ?? []).slice(1)], env: { ...t.env, TARGET_LEVEL: String(to) }, trains: { ...t.trains, to } };
    // Normal bones give 112.5 Prayer XP each, under the XP of one level from level 6 up, and the worker counts its
    // buries from the XP still needed (planPrayer). A band of bought bones (BONE_ID) is refused: one dragon bone gives
    // 1,800 XP, more than the level after 43.
    if (t.script === 'scripts/train-prayer.ts' && t.env?.BONE_ID === undefined && !t.batchFor) return { ...t, args: [String(to)], trains: { ...t.trains, to } };
    return t.trains.to <= level ? t : null;
}
