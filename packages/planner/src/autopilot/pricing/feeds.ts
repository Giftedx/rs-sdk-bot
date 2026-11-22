// Downstream item conversion graph (FEEDS), recipe conversion ratios (feedUnits), and bill demand rollup (billUnits).
import type { BillRow } from '../../supply-bill';
import { norm } from '../world';

// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
// A steel bar is on no line of the bill: it is needed while cannonballs are short (one bar casts 4, cannonballs.rs2).
export const FEEDS: Record<string, string[]> = {
    feather: ['headless arrow', 'rune arrow', 'rune arrow(p)'],
    'arrow shaft': ['headless arrow', 'rune arrow', 'rune arrow(p)'],
    'raw lobster': ['lobster'],
    'raw karambwanji': ['raw karambwan', 'cooked karambwan'],
    'raw karambwan': ['cooked karambwan'],
    cake: ['chocolate cake'],
    'chocolate bar': ['chocolate cake', 'chocolate dust'],
    log: ['arrow shaft', 'headless arrow', 'rune arrow', 'rune arrow(p)'],
    logs: ['arrow shaft', 'headless arrow', 'rune arrow', 'rune arrow(p)'],
    flax: ['bow string'],
    'magic log': ['magic shortbow', 'unstrung magic shortbow'],
    'bow string': ['magic shortbow', 'yew shortbow'],
    'unstrung magic shortbow': ['magic shortbow'],
    'rune essence': ['air rune', 'water rune', 'earth rune', 'fire rune', 'cosmic rune'],
    'steel bar': ['cannonball', 'nail'],
    'gold ore': ['gold bar'],
    'gold bar': ['sapphire ring', 'ring of recoil', 'emerald ring', 'ring of dueling(8)', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'uncut sapphire': ['sapphire', 'sapphire ring', 'ring of recoil'],
    sapphire: ['sapphire ring', 'ring of recoil'],
    'sapphire ring': ['ring of recoil'],
    'uncut emerald': ['emerald', 'emerald ring', 'ring of dueling(8)'],
    emerald: ['emerald ring', 'ring of dueling(8)'],
    'emerald ring': ['ring of dueling(8)'],
    'uncut dragonstone': ['dragonstone', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    dragonstone: ['dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'dragonstone ring': ['ring of wealth'],
    'unstrung dragonstone amulet': ['strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'strung dragonstone amulet': ['amulet of glory', 'amulet of glory(4)'],
    'amulet of glory': ['amulet of glory(4)'],
    'amulet of glory(1)': ['amulet of glory(4)'],
    'amulet of glory(2)': ['amulet of glory(4)'],
    'amulet of glory(3)': ['amulet of glory(4)'],
    'ball of wool': ['strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'cosmic rune': ['ring of recoil', 'ring of dueling(8)', 'amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'air rune': ['ring of dueling(8)'],
    'earth rune': ['amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'water rune': ['amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'runite bar': ['rune arrowtips', 'rune arrow', 'rune arrow(p)', 'rune full helm', 'rune platebody', 'rune plateleg', 'rune kiteshield'],
    'runite ore': ['runite bar'],
    coal: ['runite bar'],
    'rune arrowtip': ['rune arrow', 'rune arrow(p)'],
    'rune arrowtips': ['rune arrow', 'rune arrow(p)'],
    'headless arrow': ['rune arrow', 'rune arrow(p)'],
    'rune arrow': ['rune arrow(p)'],
    dragonhide_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    dragon_leather_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    'dragon dagger': ['dragon dagger(p)'],
    'weapon poison': ['dragon dagger(p)', 'rune arrow(p)'],
    'crystal key': ['uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    keyhalf1: ['crystal key', 'uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    keyhalf2: ['crystal key', 'uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'vial of water': [
        'guam potion (unf)', 'tarromin potion (unf)', 'harralander potion (unf)', 'ranarr potion (unf)', 'toadflax potion (unf)',
        'irit potion (unf)', 'avantoe potion (unf)', 'kwuarm potion (unf)', 'snapdragon potion (unf)', 'cadantine potion (unf)',
        'lantadyme potion (unf)', 'dwarf weed potion (unf)', 'torstol potion (unf)', 'marrentill potion (unf)',
        'prayer potion(3)', 'prayer potion(4)', 'super attack(3)', 'super attack(4)', 'super strength(3)', 'super strength(4)',
        'super defence(3)', 'super defence(4)', 'ranging potion(3)', 'ranging potion(4)',
        'super energy(3)', 'super energy(4)', 'agility potion(3)', 'agility potion(4)',
        'super restore(3)', 'super restore(4)', 'magic potion(3)', 'magic potion(4)', 'zamorak potion(3)', 'zamorak potion(4)',
        'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)', 'weapon poison',
    ],
    'harralander': ['harralander potion (unf)'],
    'unidentified harralander': ['harralander', 'harralander potion (unf)'],
    'lantadyme': ['lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'unidentified lantadyme': ['lantadyme', 'lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'lantadyme potion (unf)': ['magic potion(3)', 'magic potion(4)'],
    'potato cactu': ['magic potion(3)', 'magic potion(4)'],
    'magic potion(3)': ['magic potion(4)'],
    'torstol': ['torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'unidentified torstol': ['torstol', 'torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'torstol potion (unf)': ['zamorak potion(3)', 'zamorak potion(4)'],
    jangerberrie: ['zamorak potion(3)', 'zamorak potion(4)'],
    'zamorak potion(3)': ['zamorak potion(4)'],
    'snapdragon': ['snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'unidentified snapdragon': ['snapdragon', 'snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'snapdragon potion (unf)': ['super restore(3)', 'super restore(4)'],
    "red spiders' egg": ['super restore(3)', 'super restore(4)'],
    'super restore(3)': ['super restore(4)'],
    'ranarr weed': ['ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'unidentified ranarr': ['ranarr weed', 'ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'ranarr potion (unf)': ['prayer potion(3)', 'prayer potion(4)'],
    'snape grass': ['prayer potion(3)', 'prayer potion(4)'],
    'prayer potion(3)': ['prayer potion(4)'],
    'toadflax': ['toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'unidentified toadflax': ['toadflax', 'toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'toadflax potion (unf)': ['agility potion(3)', 'agility potion(4)'],
    'swamp toad': ["toad's leg", 'agility potion(3)', 'agility potion(4)'],
    "toad's leg": ['agility potion(3)', 'agility potion(4)'],
    'agility potion(3)': ['agility potion(4)'],
    avantoe: ['avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'unidentified avantoe': ['avantoe', 'avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'avantoe potion (unf)': ['super energy(3)', 'super energy(4)'],
    'mort myre fungi': ['super energy(3)', 'super energy(4)'],
    'super energy(3)': ['super energy(4)'],
    'irit leaf': ['irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'unidentified irit': ['irit leaf', 'irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'irit potion (unf)': ['super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'eye of newt': ['super attack(3)', 'super attack(4)'],
    'super attack(3)': ['super attack(4)'],
    kwuarm: ['kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'unidentified kwuarm': ['kwuarm', 'kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'kwuarm potion (unf)': ['super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'limpwurt root': ['super strength(3)', 'super strength(4)'],
    'super strength(3)': ['super strength(4)'],
    cadantine: ['cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'unidentified cadantine': ['cadantine', 'cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'cadantine potion (unf)': ['super defence(3)', 'super defence(4)'],
    'white berrie': ['super defence(3)', 'super defence(4)'],
    'super defence(3)': ['super defence(4)'],
    'dwarf weed': ['dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'unidentified dwarf weed': ['dwarf weed', 'dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'dwarf weed potion (unf)': ['ranging potion(3)', 'ranging potion(4)'],
    'wine of zamorak': ['ranging potion(3)', 'ranging potion(4)'],
    'ranging potion(3)': ['ranging potion(4)'],
    marrentill: ['marrentill potion (unf)', 'antipoison(3)'],
    'unidentified marentill': ['marrentill', 'marrentill potion (unf)', 'antipoison(3)'],
    'marrentill potion (unf)': ['antipoison(3)'],
    'unicorn horn': ['unicorn horn dust', 'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'unicorn horn dust': ['antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'superantipoison(3)': ['superantipoison(4)'],
    'blue dragon scale': ['dragon scale dust', 'weapon poison', 'rune arrow(p)'],
    'dragon scale dust': ['weapon poison', 'rune arrow(p)'],
};
const POTION_FEED_FOUR = new Set([
    'prayer potion(4)', 'super attack(4)', 'super strength(4)', 'super defence(4)',
    'ranging potion(4)', 'super energy(4)', 'agility potion(4)', 'superantipoison(4)',
    'super restore(4)', 'magic potion(4)', 'zamorak potion(4)', 'restore potion(4)',
]);
export const feedUnits = (item: string, output: string) => {
    if (!(FEEDS[item] ?? []).includes(output)) return 0;
    if (item === 'log' || item === 'logs') return 1 / 15;
    if (item === 'raw karambwanji') return 3;
    if (item === 'steel bar') return output === 'nail' ? 0.5 : 1 / 4;
    if (item === 'air rune' && output === 'ring of dueling(8)') return 3;
    if ((item === 'earth rune' || item === 'water rune') && (output === 'amulet of glory' || output === 'amulet of glory(4)' || output === 'ring of wealth')) return 15;
    if ((item === 'weapon poison' || item === 'dragon scale dust' || item === 'blue dragon scale' || item === 'kwuarm' || item === 'unidentified kwuarm' || item === 'kwuarm potion (unf)') && output === 'rune arrow(p)') return 1 / 5;
    if (item === 'runite bar') return output === 'rune arrowtips' || output === 'rune arrow' || output === 'rune arrow(p)' ? 1 / 15 : output === 'rune platebody' ? 5 : output === 'rune full helm' ? 2 : output === 'rune plateleg' || output === 'rune kiteshield' ? 3 : 1;
    if (item === 'coal') return 8;
    if (item === 'dragonhide_black' || item === 'dragon_leather_black') return output === 'black_dragonhide_body' ? 3 : output === 'black_dragonhide_chaps' ? 2 : 1;
    if (POTION_FEED_FOUR.has(output)) return 4 / 3;
    return 1;
};

export const billUnits = (item: string, bill: readonly BillRow[]) => bill.reduce((n, r) => {
    const names = [r.item, ...(r.aliases ?? [])].map(norm);
    return n + Math.max(0, r.short) * (names.includes(item) ? 1 : Math.max(0, ...names.map(name => feedUnits(item, name))));
}, 0);
