// Shared supply-board band definitions and ladder math from rev-289 content (25x XP rate).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { xpForLevel } from '../../planner/src/curve';

export const RATE = 25;
export interface Band { from: number; name: string; xp: number; inputs: Record<string, number>; out?: string }

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

export const FLETCHING: Band[] = [
    { from: 1, name: 'bronze arrow', xp: 19.5, inputs: { bronze_arrowheads: 15, headless_arrow: 15 } },
    { from: 15, name: 'iron arrow', xp: 37.5, inputs: { iron_arrowheads: 15, headless_arrow: 15 } },
    { from: 22, name: 'iron dart', xp: 38, inputs: { iron_dart_tip: 10, feather: 10 } },
    { from: 30, name: 'steel arrow', xp: 75, inputs: { steel_arrowheads: 15, headless_arrow: 15 } },
    { from: 45, name: 'mithril arrow', xp: 112.5, inputs: { mithril_arrowheads: 15, headless_arrow: 15 } },
    { from: 60, name: 'adamant arrow', xp: 150, inputs: { adamant_arrowheads: 15, headless_arrow: 15 } },
    { from: 75, name: 'rune arrow', xp: 187.5, inputs: { rune_arrowheads: 15, headless_arrow: 15 } },
    { from: 81, name: 'rune dart', xp: 188, inputs: { rune_dart_tip: 10, feather: 10 } },
];

export const CRAFTING: Band[] = [
    { from: 1, name: 'opal', xp: 15, inputs: { uncut_opal: 1 } },
    { from: 13, name: 'jade', xp: 20, inputs: { uncut_jade: 1 } },
    { from: 16, name: 'red topaz', xp: 25, inputs: { uncut_red_topaz: 1 } },
    { from: 20, name: 'sapphire', xp: 50, inputs: { uncut_sapphire: 1 } },
    { from: 27, name: 'emerald', xp: 67.5, inputs: { uncut_emerald: 1 } },
    { from: 34, name: 'ruby', xp: 85, inputs: { uncut_ruby: 1 } },
    { from: 43, name: 'diamond', xp: 107.5, inputs: { uncut_diamond: 1 } },
    { from: 55, name: 'dragonstone', xp: 137.5, inputs: { uncut_dragonstone: 1 } },
];

export const CRAFTING_DIAMOND: Band[] = CRAFTING.filter(b => b.name !== 'dragonstone');
export const FLETCHING_ARROWS: Band[] = FLETCHING.filter(b => !/dart/.test(b.name));

export const HERBLORE: Band[] = [
    { from: 1, name: 'identify guam', xp: 2.5, inputs: { unidentified_guam: 1 } },
    { from: 3, name: 'attack', xp: 25, inputs: { guamvial: 1, eye_of_newt: 1 }, out: '3dose1attack' },
    { from: 5, name: 'antipoison', xp: 37.5, inputs: { marrentillvial: 1, unicorn_horn_dust: 1 }, out: '3doseantipoison' },
    { from: 12, name: 'strength', xp: 50, inputs: { tarrominvial: 1, limpwurt_root: 1 }, out: '3dose1strength' },
    { from: 22, name: 'restore', xp: 62.5, inputs: { harralandervial: 1, red_spiders_eggs: 1 }, out: '3dosestatrestore' },
    { from: 26, name: 'energy', xp: 67.5, inputs: { harralandervial: 1, chocolate_dust: 1 }, out: '3dose1energy' },
    { from: 30, name: 'defence', xp: 75, inputs: { ranarrvial: 1, white_berries: 1 }, out: '3dose1defense' },
    { from: 34, name: 'agility', xp: 80, inputs: { toadflaxvial: 1, toads_legs: 1 }, out: '3dose1agility' },
    { from: 38, name: 'prayer', xp: 87.5, inputs: { ranarrvial: 1, snape_grass: 1 }, out: '3doseprayerrestore' },
    { from: 45, name: 'super attack', xp: 100, inputs: { iritvial: 1, eye_of_newt: 1 }, out: '3dose2attack' },
    { from: 48, name: 'super antipoison', xp: 106.3, inputs: { iritvial: 1, unicorn_horn_dust: 1 }, out: '3dose2antipoison' },
    { from: 50, name: 'fishing', xp: 112.5, inputs: { avantoevial: 1, snape_grass: 1 }, out: '3dosefisherspotion' },
    { from: 52, name: 'super energy', xp: 117.5, inputs: { avantoevial: 1, mortmyremushroom: 1 }, out: '3dose2energy' },
    { from: 55, name: 'super strength', xp: 125, inputs: { kwuarmvial: 1, limpwurt_root: 1 }, out: '3dose2strength' },
    { from: 60, name: 'weapon poison', xp: 137.5, inputs: { kwuarmvial: 1, dragon_scale_dust: 1 }, out: 'weapon_poison' },
    { from: 63, name: 'super restore', xp: 142.5, inputs: { snapdragonvial: 1, red_spiders_eggs: 1 }, out: '3dose2restore' },
    { from: 66, name: 'super defence', xp: 150, inputs: { cadantinevial: 1, white_berries: 1 }, out: '3dose2defense' },
    { from: 69, name: 'antifire', xp: 157.5, inputs: { lantadymevial: 1, dragon_scale_dust: 1 }, out: '3dose1antidragon' },
    { from: 72, name: 'ranging', xp: 162.5, inputs: { dwarfweedvial: 1, wine_of_zamorak: 1 }, out: '3doserangerspotion' },
    { from: 76, name: 'magic', xp: 172.5, inputs: { lantadymevial: 1, cactus_potato: 1 }, out: '3dose1magic' },
    { from: 78, name: 'zamorak', xp: 175, inputs: { torstolvial: 1, jangerberries: 1 }, out: '3dosepotionofzamorak' },
];

export const HERB_DROPS: { band: Band; count: number }[] = [
    { band: HERBLORE.find(b => b.name === 'attack')!, count: 270 },
    { band: HERBLORE.find(b => b.name === 'restore')!, count: 119 },
    { band: HERBLORE.find(b => b.name === 'prayer')!, count: 93 },
    { band: HERBLORE.find(b => b.name === 'super attack')!, count: 68 },
    { band: HERBLORE.find(b => b.name === 'fishing')!, count: 51 },
    { band: HERBLORE.find(b => b.name === 'super strength')!, count: 43 },
];

export const FIREMAKING: Band[] = [
    { from: 1, name: 'logs', xp: 40, inputs: { logs: 1 } },
    { from: 15, name: 'oak', xp: 60, inputs: { oak_logs: 1 } },
    { from: 30, name: 'willow', xp: 90, inputs: { willow_logs: 1 } },
    { from: 45, name: 'maple', xp: 135, inputs: { maple_logs: 1 } },
    { from: 60, name: 'yew', xp: 202.5, inputs: { yew_logs: 1 } },
    { from: 75, name: 'magic', xp: 303.8, inputs: { magic_logs: 1 } },
];

export const PRAYER: Band[] = [{ from: 1, name: 'dragon bones', xp: 72, inputs: { dragon_bones: 1 } }];
export const PRAYER_BIG: Band[] = [{ from: 1, name: 'big bones', xp: 15, inputs: { big_bones: 1 } }];

export const SMITHING: Band[] = [
    { from: 1, name: 'bronze dagger', xp: 12.5, inputs: { bronze_bar: 1 } },
    { from: 8, name: 'bronze sq shield', xp: 25, inputs: { bronze_bar: 2 } },
    { from: 9, name: 'bronze warhammer', xp: 37.5, inputs: { bronze_bar: 3 } },
    { from: 18, name: 'bronze platebody', xp: 62.5, inputs: { bronze_bar: 5 } },
    { from: 24, name: 'iron warhammer', xp: 75, inputs: { iron_bar: 3 } },
    { from: 33, name: 'iron platebody', xp: 125, inputs: { iron_bar: 5 } },
    { from: 48, name: 'steel platebody', xp: 187.5, inputs: { steel_bar: 5 } },
    { from: 68, name: 'mithril platebody', xp: 250, inputs: { mithril_bar: 5 } },
    { from: 88, name: 'adamant platebody', xp: 312.5, inputs: { adamantite_bar: 5 } },
];

export const MAGIC: Band[] = [
    { from: 7, name: 'enchant 1 sapphire ring', xp: 17.5, inputs: { sapphire_ring: 1, cosmicrune: 1, waterrune: 1 } },
    { from: 27, name: 'enchant 2 emerald ring', xp: 37, inputs: { emerald_ring: 1, cosmicrune: 1, airrune: 3 } },
    { from: 49, name: 'enchant 3 ruby ring', xp: 59, inputs: { ruby_ring: 1, cosmicrune: 1, firerune: 5 } },
    { from: 57, name: 'enchant 4 diamond ring', xp: 67, inputs: { diamond_ring: 1, cosmicrune: 1, earthrune: 10 } },
    { from: 68, name: 'enchant 5 dragonstone amulet', xp: 78, inputs: { strung_dragonstone_amulet: 1, cosmicrune: 1, earthrune: 15, waterrune: 15 } },
];

export const COOKING: Band[] = [
    { from: 1, name: 'sardine', xp: 40, inputs: { raw_sardine: 1 } },
    { from: 5, name: 'herring', xp: 50, inputs: { raw_herring: 1 } },
    { from: 15, name: 'trout', xp: 70, inputs: { raw_trout: 1 } },
    { from: 25, name: 'salmon', xp: 90, inputs: { raw_salmon: 1 } },
    { from: 35, name: 'wine', xp: 110, inputs: { grapes: 1, jug_water: 1 } },
];

export function statRandom(low: number, high: number, lvl: number): number {
    const L = Math.min(lvl, 99);
    return Math.min(1, (Math.floor((low * (99 - L)) / 98) + Math.floor((high * (L - 1)) / 98) + 1) / 256);
}

export const SUCCESS: Record<string, [number, number]> = {
    opal: [128, 250], jade: [90, 240], 'red topaz': [100, 245],
    logs: [64, 512], oak: [64, 512], willow: [64, 512], maple: [64, 512], yew: [64, 512], magic: [64, 512],
    wine: [48, 352], sardine: [118, 492], herring: [108, 472], trout: [88, 432], salmon: [68, 392],
};

export const odds = (b: Band, lvl: number) => { const r = SUCCESS[b.name]; return r ? statRandom(r[0], r[1], lvl) : 1; };

export interface Step { band: Band; from: number; to: number; actions: number; xpStart: number }

export function ladder(bands: Band[], start = 1, end = 99, successRate: (b: Band, lvl: number) => number = () => 1): Step[] {
    const out: Step[] = [];
    let xp = xpForLevel(start);
    for (let i = 0; i < bands.length; i++) {
        const b = bands[i]!;
        const next = Math.min(end, bands[i + 1]?.from ?? end);
        if (next <= start || xpForLevel(next) <= xp) continue;
        const from = Math.max(b.from, start);
        let n = 0;
        const x0 = xp;
        while (xp < xpForLevel(next)) {
            let lvl = 1; while (lvl < 99 && xpForLevel(lvl + 1) <= xp) lvl++;
            xp += b.xp * RATE * successRate(b, lvl); n++;
        }
        out.push({ band: b, from, to: next, actions: n, xpStart: x0 });
    }
    return out;
}

export function supplies(steps: Step[]): Record<string, number> {
    const t: Record<string, number> = {};
    for (const s of steps) for (const [k, v] of Object.entries(s.band.inputs)) t[k] = (t[k] ?? 0) + v * s.actions;
    return t;
}

let ids: Map<string, number> | null = null;
export function objId(name: string): number {
    if (!ids) {
        ids = new Map();
        const f = join(REPO_ROOT, 'vendor/rs-sdk/server/content/pack/obj.pack');
        for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) { const m = l.match(/^(\d+)=(\S+)$/); if (m) ids.set(m[2]!, Number(m[1])); }
    }
    const v = ids.get(name);
    if (v === undefined) throw new Error(`no obj ${name}`);
    return v;
}
