// Autopilot band order constants, spot identifiers, quest demand rows, resource capacities, and shared-spot scaling.
import type { QuestDemandRow } from './model';

export const WEAPON_BAND = 3.5, WEAPON_MARKET = 'ge:weapon';
const WEAPON_BUYERS = 4;
export const ARMOUR_BAND = 3.55, RANGED_ARMOUR_BAND = 3.95, ARMOUR_MARKET = 'ge:armour';
const ARMOUR_BUYERS = 2;
export const AMMO_MARKET = 'ge:ammo';
export const QUEST_BAND = 3.6, LOST_CITY = 'quest:lostcity', LOST_CITY_PLACES = 1, LOST_CITY_MEALS = 10;
export const GRAIL_BAND = QUEST_BAND + 0.1, GRAIL_PLACE = 'quest:camelot', GRAIL_MEALS = 12;
const GRAIL_PLACES = 1;
export const FREMENNIK_BAND = QUEST_BAND + 0.05, FREMENNIK = 'quest:rellekka', FREMENNIK_MEALS = 4;
const FREMENNIK_PLACES = 1;
export const UPASS_BAND = QUEST_BAND + 0.06, REGICIDE_BAND = QUEST_BAND + 0.07, UPASS = 'quest:upass';
const UPASS_PLACES = 1;
export const ARMY_BANK = { x: 2615, z: 3332 } as const;

export const KNIGHT_SPOTS = ['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'];
export const CHICKEN_PENS = ['3229,3298', '3017,3288', '3187,3277', '3197,3353'];
// The pen at 3197,3353 is the yard of the Champions' Guild. Its door lets in an account with 32 quest points
// (championdoor in knowledge/doors.json), and the route search refuses the pen to any other account.
export const PEN_QUEST_POINTS: Readonly<Record<string, number>> = { '3197,3353': 32 };
// scripts/gather-feathers.ts stops when its pack holds TARGET feathers.
export const FEATHER_TARGET = 2000;
// scripts/shop-buyer.ts buys each item up to STOCK_TARGET (default 500), pack and bank. A run for an account that
// holds that many of every item buys nothing.
export const SHOP_STOCK = 500;
// Claim: four farmers can share one knight spot. A pickpocket does not hold the knight. Practice: 4 bots at one spot
// each earned 13.3-15.1 coins per tick (mean 14.7) against the 18.8 model, every run RESULT ok and logged out
// (goldfarm.ts at its default spot 2653,3302, 3 runs of 600 ticks and one of 9,000; research/bot-host.md section 3).
// Live (claude-cloud-3 swarm logs): two full 9,000-tick goldfarm runs, RESULT ok and logged out, made 7.46
// coins per tick with 3 holders on 2652,3318 and 7.57 with 3 holders on 2669,3298 (4 for its last part), against about
// 8.1 near-solo. Gap: one live run per condition, not three matched, so KNIGHT_SHARED_RATE is an estimate, applied
// once per holder; the planner's tick-waste discount and retirement still apply per job.
export const KNIGHT_SHARE = 4;
const KNIGHT_SHARED_RATE = 0.75;
// Ardougne north cow field: six army accounts at once on its ten cows. Practice (research/combat-measure.md), 8-kill
// runs: solo median 550 ticks; 3 triples 9/9 RESULT ok, median 590 per account; 3 sets of six fresh accounts 18/18
// RESULT ok, median 779, so six make about 1.5 times the field output of three. More than six is not measured.
export const COW_FIELD = 'cow:ardougne-north', COW_FIELD_CAPACITY = 6;
// Gnome battlefield Khazard troopers: about 41 on multiway ground. Practice, fourteen accounts at once, 3 sets: 42 of
// 42 RESULT ok at a median 38.4 Strength XP per tick an account (49.7 with nine, 56.7 with six, 61-63 alone), the
// slowest 29.5, and a field total 20% over nine (research/combat-measure.md, troopers shared). The cows give about 16,
// so every army account trains there. Gap: more than fourteen at once is not measured.
export const TROOPER_FIELD = 'trooper:battlefield', TROOPER_FIELD_CAPACITY = 14;
// The Wind Strike tile north of the Ardougne north bank (scripts/alch-train.ts STRIKE): one Guard dog, fought by one
// player at a time. Practice: of three accounts at once, one landed no cast in 200 ticks, in each of three sets.
export const STRIKE_TILE = 'strike:ardougne-guard-dog';
// Taverley's black dragons (scripts/black-dragon-camp.ts): two dragons, one camp tile. Practice: two accounts on the
// tile at once made six kills each with no stray and no hitpoint lost; more than two is not run. HUNT_BAND comes after
// every training band, so only an account with none of them left to start hunts. HIDE_TARGET is the hides one hunter
// gathers before the band stands down: a set of body, chaps and vambraces takes six.
export const BLACK_CAVE = 'cave:taverley-black-dragons', BLACK_CAVE_PLACES = 2;
export const SPLASH_FENCE = 'splash:ardougne-cow-fence', SPLASH_PLACES = 2;
// The places the AIO routes hold (aioTemplates). Each takes one account until a live pilot measures two.
export const AIO_PLACES = { flax: 'aio:seers-flax', yews: 'aio:seers-yews', ore: 'aio:varrock-east-mine', essence: 'aio:essence-mine', air: 'aio:air-altar', blood: 'aio:ardougne-blood-chests' } as const;
// The quests that no owned account has done, as sweep jobs for army accounts with time left (QUEST_DEMAND_BAND: after the
// build bands, before the open-ended fields). One account does each quest once: `once` stops the demand when any
// observed account has it done (Inputs.questsDone). `ticks`: the game ticks of the saved practice run (the bench case
// `quester:quest:<slug>`), which orders the bands, the cheapest first. `skills` and `quests` are the journal's asks
// (packages/dashboard/client-assets/quest-reqs.json) and `items` is the pack of the practice run
// (scripts/quest-sweep.ts presetFor), with `meals` of food; Hitpoints 90 stands where the practice run fell under 70
// Hitpoints with 99 in every skill (the saved `hpMin`). A quest is a `kitFirst` band: an account that lacks its pack gets the items from a donor, or buys them
// within the caps of questKitCaps, and one that cannot shows the missing item as the vacant reason. The table leaves out the quests that no one-account sweep can run: Shield of Arrav, Hero's Quest and
// Legends Quest open companion accounts (scripts/generated/quest-<slug>.ts take a helper name), the sweep refuses Hero's
// Quest (scripts/quest-sweep.ts), and Throne of Miscellania needs Hero's Quest. They wait for an owned-pair path. QUEST_DEMAND_PLACES: quest jobs at once.
export const QUEST_DEMAND_BAND = 5, QUEST_DEMAND = 'quest:demand', QUEST_DEMAND_PLACES = 2;
export const QUEST_DEMAND_ROWS: readonly QuestDemandRow[] = [
    { slug: 'elemental', name: 'Elemental Workshop', ticks: 188, skills: { Crafting: 20, Mining: 20, Smithing: 20 }, quests: [], items: { knife: 1, needle: 1, leather: 1, thread: 1, hammer: 1, 'rune pickaxe': 1, coal: 4 }, meals: 6 },
    { slug: 'chompybird', name: 'Big Chompy Bird Hunting', ticks: 387, skills: { Cooking: 30, Ranged: 30, Fletching: 5 }, quests: [], items: { knife: 1, chisel: 1, 'achey tree logs': 1, 'wolf bones': 1, feather: 8, 'ogre arrow': 6, potato: 1, onion: 1, 'equa leaves': 1, cabbage: 1, tomato: 1, 'doogle leaves': 1 }, meals: 2 },
    { slug: 'horror', name: 'Horror from the Deep', ticks: 655, skills: { Agility: 35 }, quests: [], items: { plank: 2, nails: 8, hammer: 1, 'swamp tar': 1, 'molten glass': 1, tinderbox: 1, 'bronze dagger': 1, 'bronze arrow': 1, 'air rune': 200, 'water rune': 100, 'earth rune': 100, 'fire rune': 100, 'blood rune': 40 }, meals: 12 },
    { slug: 'druidspirit', name: 'Nature Spirit', ticks: 665, skills: { Crafting: 18 }, quests: ['Priest in Peril', 'The Restless Ghost'], items: { wolfbane: 1, 'silver sickle': 1 }, meals: 4 },
    { slug: 'routequest', name: 'In Search of the Myreque', ticks: 696, skills: { Agility: 25 }, quests: ['Nature Spirit'], items: { 'silver sickle(b)': 1, 'druid pouch': 6, 'steel longsword': 1, 'steel sword': 2, 'steel dagger': 1, 'steel mace': 1, 'steel warhammer': 1, plank: 6, nails: 30, hammer: 1 }, meals: 6 },
    { slug: 'ikov', name: 'Temple of Ikov', ticks: 984, skills: { Thieving: 42, Ranged: 40 }, quests: [], items: { 'lit candle': 1, knife: 1, 'limpwurt root': 20, 'law rune': 1, 'air rune': 3, 'fire rune': 1 }, meals: 2 },
    { slug: 'trolllove', name: 'Troll Romance', ticks: 1004, skills: { Agility: 28 }, quests: ['Death Plateau', 'Troll Stronghold'], items: { 'maple logs': 1, 'iron bar': 1, rope: 1, 'bucket of wax': 1, 'swamp tar': 1, 'cake tin': 1, 'law rune': 6, 'fire rune': 6 }, meals: 14 },
    { slug: 'crest', name: 'Family Crest', ticks: 1030, skills: { Magic: 59, Crafting: 40, Mining: 40, Smithing: 40, Hitpoints: 90 }, quests: [], items: { shrimps: 1, "'perfect' gold bar": 2, ruby: 2, 'ring mould': 1, 'necklace mould': 1, 'antipoison(4)': 2, 'air rune': 100, 'water rune': 12, 'earth rune': 15, 'fire rune': 70, 'death rune': 24, 'law rune': 6 }, meals: 12, wilderness: true },
    { slug: 'mortton', name: 'Shades of Mortton', ticks: 1115, skills: { Crafting: 20, Herblore: 15, Firemaking: 5 }, quests: ['Priest in Peril'], items: { hammer: 1, tinderbox: 1, logs: 1, tarromin: 1, 'vial of water': 1, ashes: 1, 'serum 207 (3)': 2 }, meals: 2 },
    { slug: 'desertrescue', name: 'The Tourist Trap', ticks: 1217, skills: { Smithing: 20, Fletching: 10 }, quests: [], items: { hammer: 1, 'bronze bar': 5, feather: 40, 'waterskin(4)': 2 }, meals: 6 },
    { slug: 'biohazard', name: 'Biohazard', ticks: 1285, skills: {}, quests: ['Plague City'], items: { 'priest gown': 2, 'law rune': 4, 'water rune': 4 }, meals: 2 },
    { slug: 'dig', name: 'Digsite Quest', ticks: 1486, skills: { Thieving: 25, Agility: 10, Herblore: 10 }, quests: [], items: { 'law rune': 1, 'air rune': 3, 'fire rune': 1, 'cup of tea': 1, opal: 1, rope: 2, vial: 1, charcoal: 1, 'pestle and mortar': 1, tinderbox: 1 }, meals: 2 },
    { slug: 'tbwt', name: 'Tai Bwo Wannai Trio', ticks: 1488, skills: { Cooking: 30, Firemaking: 30, Agility: 15, Fishing: 5 }, quests: ['Jungle Potion'], items: { 'raw karambwan': 4, 'pestle and mortar': 1, 'iron spear': 1, 'agility potion(4)': 1, 'small fishing net': 1, 'jogre bones': 1, seaweed: 1, 'sliced banana': 1, 'karambwan vessel': 1, 'fire rune': 31, 'nature rune': 1, 'air rune': 18, 'mind rune': 9, 'amulet of glory(4)': 1 }, meals: 0 },
    { slug: 'itwatchtower', name: 'Watch Tower', ticks: 1951, skills: { Mining: 40, Agility: 25, Thieving: 15, Herblore: 14, Magic: 14, Hitpoints: 90 }, quests: [], items: { rope: 2, 'dragon bones': 1, 'gold bar': 1, 'death rune': 1, 'lit candle': 1, 'guam leaf': 1, 'vial of water': 1, 'ground bat bones': 1, jangerberries: 1, 'rune pickaxe': 1 }, meals: 8 },
    { slug: 'upass', name: 'Underground Pass', ticks: 2645, skills: { Thieving: 50, Ranged: 25, Hitpoints: 90 }, quests: ['Biohazard'], items: { shortbow: 1, 'iron arrow': 5, tinderbox: 1, rope: 1, bucket: 1, spade: 1 }, meals: 14 },
    { slug: 'viking', name: 'The Fremennik Trials', ticks: 2784, skills: { Crafting: 40, Woodcutting: 40, Fletching: 25, Hitpoints: 90 }, quests: [], items: { coins: 5300, beer: 1, tinderbox: 1, 'rune axe': 1, knife: 1, cabbage: 1, potato: 1, onion: 1, 'raw shark': 1 }, meals: 4 },
    { slug: 'zombiequeen', name: 'Shilo Village', ticks: 2977, skills: { Agility: 32, Crafting: 20, Prayer: 10, Hitpoints: 90 }, quests: ['Jungle Potion'], items: { spade: 1, 'lit candle': 1, rope: 1, chisel: 1, 'bronze wire': 1, bones: 3 }, meals: 14 },
    { slug: 'regicide', name: 'Regicide', ticks: 3195, skills: { Agility: 56, Crafting: 10, Hitpoints: 90 }, quests: ['Underground Pass'], items: { "king's message": 1, 'iron fire arrows': 2, rope: 2, shortbow: 1, tinderbox: 1, spade: 1, 'pestle and mortar': 1, pot: 1, limestone: 1, 'ball of wool': 4, 'law rune': 5, 'air rune': 3, 'water rune': 5, coal: 8, 'cooked rabbit': 1 }, meals: 30 },
];
// The Fremennik Trials and the Underground Pass share the place of their build templates, so one account does each.
export const questResource = (slug: string) => slug === 'viking' ? FREMENNIK : slug === 'upass' || slug === 'regicide' ? UPASS : `quest:${slug}`;

// CAPACITY: accounts at one resource at a time. Every number is policy (a place, a market or a spot holds this many), not a game fact.
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, 'squad:catherby-sharks': 3, 'squad:shilo-karambwanji': 2, 'squad:shilo-karambwan': 2, 'squad:catherby-cooking': 2, 'squad:herblore-bank': 4, 'squad:magic-enchant': 4, 'squad:al-kharid-craft': 3, 'squad:varrock-smithing': 2, 'squad:seers-fletch': 3, 'squad:crystal-chest': 2, 'squad:heroes-fountain': 2, 'squad:cosmic-altar': 2, 'squad:taverley-druids': 1, 'squad:taverley-black-knights': 2, 'squad:barbarian-planks': 1, 'squad:gnome-toads': 1, 'squad:taverley-scales': 2, 'squad:taverley-black-dragons': 2, 'squad:chaos-temple-wine': 2, 'squad:seers-magic-trees': 2, 'squad:edgeville-unicorns': 2, 'squad:ardougne-giants': 2, 'squad:hobgoblin-snape': 2, [WEAPON_MARKET]: WEAPON_BUYERS, [ARMOUR_MARKET]: ARMOUR_BUYERS, [LOST_CITY]: LOST_CITY_PLACES, [GRAIL_PLACE]: GRAIL_PLACES, [FREMENNIK]: FREMENNIK_PLACES, [UPASS]: UPASS_PLACES, [QUEST_DEMAND]: QUEST_DEMAND_PLACES, ...Object.fromEntries(QUEST_DEMAND_ROWS.map(q => [questResource(q.slug), 1])), ...Object.fromEntries(Object.values(AIO_PLACES).map(p => [p, 1])), [COW_FIELD]: COW_FIELD_CAPACITY, [TROOPER_FIELD]: TROOPER_FIELD_CAPACITY, [STRIKE_TILE]: 1, [SPLASH_FENCE]: SPLASH_PLACES, [BLACK_CAVE]: BLACK_CAVE_PLACES, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
export const SHARED: Readonly<Record<string, number>> = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARED_RATE]));
