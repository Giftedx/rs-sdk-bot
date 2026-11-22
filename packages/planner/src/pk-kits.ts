// PvP builds for the spar bench: one table gives both the start state of an account (what it wears and carries) and
// how the fight loop uses it (its switch weapons and style turns). Items are named as in the content pack
// (vendor/rs-sdk/server/content/pack/obj.pack), so a wrong name fails at load and not in a fight.
// `cost` is the shop value of a kit (knowledge/items.json), the measure for "the same kills with a cheaper kit".
// Facade entry point re-exporting kit specs, lookup accessors, route calculators, and god/dragon comparisons
// from cohesive acyclic submodules under ./pk-kits/.
import { createKitRoutes } from './pk-kits/routes';

export type { KitSpec } from './pk-kits/model';
export { combatLevel, itemId, trained } from './pk-kits/model';
export { KITS, kitCost, kitItems, kitOptions, kitSkills, kitSwitches } from './pk-kits/kits';
export type { DragonSpecComparison, GodLoadoutSpec, GodName } from './pk-kits/god-specs';
export { GOD_LOADOUTS, buildGodSpellKit, compareDragonSpecs, godCapeStaffConflict } from './pk-kits/god-specs';

const routes = createKitRoutes('Mage Arena');
export const QUEST_VARP = routes.QUEST_VARP;
export const QUEST_CHAIN = routes.QUEST_CHAIN;
export const kitRoute = routes.kitRoute;
export const kitVarps = routes.kitVarps;
export const levelsBeforeRoute = routes.levelsBeforeRoute;
export const overBuild = routes.overBuild;
