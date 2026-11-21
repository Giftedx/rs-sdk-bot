// PvP builds for the spar bench: one table gives both the start state of an account (what it wears and carries) and
// how the fight loop uses it (its switch weapons and style turns). Items are named as in the content pack
// (vendor/rs-sdk/server/content/pack/obj.pack), so a wrong name fails at load and not in a fight.
// `cost` is the shop value of a kit (knowledge/items.json), the measure for "the same kills with a cheaper kit".
export * from '../packages/planner/src/pk-kits';
