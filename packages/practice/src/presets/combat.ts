import type { SaveConfig } from '../preset-types';

export const COMBAT_PRESETS: Record<string, SaveConfig> = {
    // ---- Combat measurement (scripts/measure/combat-melee.ts, research/combat-measure.md). Falador castle courtyard,
    // multiway (maps/multiway.csv "falador"), 11 ground-floor White Knights (falador.npc:1-30: HP 52, defence 21,
    // attackrate 7, not aggressive). Worn: rune full helm 1163, amulet of strength 1725, rune scimitar 1333, rune
    // chainbody 1113 (the platebody needs Dragon Slayer), rune kiteshield 1201, rune platelegs 1079, leather gloves
    // 1059, leather boots 1061; all tradeable, so a helper can supply them. 20 lobsters (379).
    // Spot gb: the Gnome battlefield west of the Tree Gnome Village (maps/multiway.csv "gnome battlefield"), 41 Khazard
    // troopers (gnome_battlefield.npc:1-40: HP 22, defence 12-13, attackrate 5-6, no huntmode), open ground.
    // Higher-HP multiway spots (research/combat-measure.md section 4): iw = Ice Queen lair, 6 ice warriors within 4 tiles
    // (all.npc icewarrior_queen: HP 59, att/str/def 47, huntmode cowardly, huntrange 5); ks = Kalphite lair, 5 soldiers
    // within 10 tiles on plane 2 (kalphite.npc:62-95: HP 90, att/str/def 70, cowardly, huntrange 5, poison 20);
    // sk = Temple of Ikov dungeon, 9 skeletons (all.npc skeleton id 93: HP 59, def 36, cowardly, huntrange 1).
    ...Object.fromEntries([['wk', { x: 2979, z: 3340, level: 0 }], ['gb', { x: 2525, z: 3242, level: 0 }], ['iw', { x: 2866, z: 9946, level: 0 }], ['ks', { x: 3467, z: 9484, level: 2 }], ['sk', { x: 2650, z: 9889, level: 0 }]].flatMap(([spot, position]) => [40, 70, 90].flatMap(lv => {
        const base: SaveConfig = {
            position: position as { x: number; z: number; level: number },
            skills: { Attack: lv, Strength: lv, Defence: lv, Hitpoints: lv },
            equipment: [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })),
            inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
        };
        // Cannon variant: %mcannon (varp 0) = 11 (^mcannon_complete, quest.constant:43), %ownedmcannon (varp 4) = -1 (null;
        // a 0 save value reads as a placed cannon: "You cannot construct more than one Cannon"), cannon base/stand/barrels/
        // furnace (6/8/10/12), 1,000 cannonballs (2), 16 lobsters.
        const cannon: SaveConfig = {
            ...base,
            varps: { 0: 11, 4: -1 },
            inventory: [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1000 }], Array.from({ length: 16 }, () => ({ id: 379, count: 1 }))),
        };
        return [[`combat_${spot}_${lv}`, base], [`combat_${spot}_${lv}_cannon`, cannon]];
    }))),
    // Defence top-up as the Haggis plan reaches it (research/combat-measure.md section 7): Attack, Strength, Hitpoints 99,
    // Defence 93 (Monkey Madness 500,000 + longrange side 179,700 = 679,700 XP), same gear and food as combat_<spot>_<band>.
    // Run with STYLE=3 (scimitar "block", defensive: Defence XP).
    ...Object.fromEntries([['gb', { x: 2525, z: 3242, level: 0 }], ['iw', { x: 2866, z: 9946, level: 0 }], ['sk', { x: 2650, z: 9889, level: 0 }]].map(([spot, position]) => [`combat_${spot}_def93`, {
        position: position as { x: number; z: number; level: number },
        skills: { Attack: 99, Strength: 99, Defence: 93, Hitpoints: 99 },
        equipment: [[1163, 0], [1725, 2], [1333, 3], [1113, 4], [1201, 5], [1079, 7], [1059, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! })),
        inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
    } satisfies SaveConfig])),
    // Cannon at the Wilderness poison spiders (level 37, multiway, 62 spawns, maps/m51_59.jm2): 1,500 cannonballs, 700 rune
    // arrows, 18 sharks 385, 2 antipoison 2446, 3 prayer potions 2434, cannon parts, %mcannon = 11. Bow sets wear the band
    // 40 ranged kit above with the magic shortbow. _h = Haggis at the Ranged row (Attack 99, Prayer 99); _s = a Ranged
    // specialist (Attack 1, Strength 1, Defence 40, Hitpoints 55, Prayer 1), _sp = the same with Prayer 43. _sci sets hold a
    // scimitar instead (rune 1333 at Attack 99, iron 1323 at Attack 1): the cannon rolls with the worn weapon's style
    // (player_combat.rs2:52, %damagetype). _h80 starts at Ranged 80 for the upper bands.
    ...((): Record<string, SaveConfig> => {
        const pack = [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1500 }], [...Array(18).fill(385), 2446, 2446, 2434, 2434, 2434].map(id => ({ id, count: 1 })));
        const kit = (weapon: number) => [[1169, 0], [1731, 2], [weapon, 3], [1135, 4], [1099, 7], [1065, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }))
            .concat(weapon === 861 ? [{ id: 892, count: 700, slot: 13 }] : []);
        const set = (skills: Record<string, number>, weapon = 861): SaveConfig => ({ position: { x: 3287, z: 3810, level: 0 }, skills, equipment: kit(weapon), varps: { 0: 11, 4: -1 }, inventory: pack });
        const haggis = { Attack: 99, Strength: 99, Defence: 89, Hitpoints: 97, Prayer: 99, Ranged: 55 };
        const spec = { Attack: 1, Strength: 1, Defence: 40, Hitpoints: 55, Ranged: 55 };
        return {
            cannon_spiders_h: set(haggis),
            cannon_spiders_h80: set({ ...haggis, Ranged: 80 }),
            cannon_spiders_s: set(spec),
            // 43 Prayer points restore 17 a dose, so this set carries 9 prayer potions and 12 sharks.
            cannon_spiders_sp: { ...set({ ...spec, Prayer: 43 }), inventory: pack.slice(0, 5).concat([...Array(12).fill(385), 2446, 2446, ...Array(9).fill(2434)].map(id => ({ id, count: 1 }))) },
            cannon_spiders_h_sci: set(haggis, 1333),
            cannon_spiders_s_sci: set({ ...spec, Prayer: 43 }, 1323),
        };
    })(),
    // Ranged with a bow at the Gnome battlefield (spot gb), bands 40 / 70 / 90 in Ranged, Defence and Hitpoints. Band 40:
    // yew shortbow 857 (Ranged 40, tier40.rs2:64) and green d'hide body 1135, chaps 1099, vambraces 1065; bands 70 and 90:
    // magic shortbow 861 (Ranged 50) and black d'hide body 2503 (Ranged 70, Defence 40), chaps 2497, vambraces 2491.
    // All: coif 1169, amulet of power 1731, leather boots 1061, 3,000 rune arrows 892 in the ammo slot (13), 20 lobsters.
    // The _cannon variant swaps 4 lobsters for the cannon parts and 1,000 cannonballs, as above.
    ...Object.fromEntries([40, 70, 90].flatMap(lv => {
        const [bow, body, chaps, vamb] = lv < 70 ? [857, 1135, 1099, 1065] : [861, 2503, 2497, 2491];
        const base: SaveConfig = {
            position: { x: 2525, z: 3242, level: 0 },
            skills: { Ranged: lv, Defence: lv, Hitpoints: lv },
            equipment: [[1169, 0], [1731, 2], [bow, 3], [body, 4], [chaps, 7], [vamb, 9], [1061, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }))
                .concat([{ id: 892, count: 3000, slot: 13 }]),
            inventory: Array.from({ length: 20 }, () => ({ id: 379, count: 1 })),
        };
        const cannon: SaveConfig = {
            ...base,
            varps: { 0: 11, 4: -1 },
            inventory: [6, 8, 10, 12].map(id => ({ id, count: 1 })).concat([{ id: 2, count: 1000 }], Array.from({ length: 16 }, () => ({ id: 379, count: 1 }))),
        };
        return [[`combat_rb_${lv}`, base], [`combat_rb_${lv}_cannon`, cannon]];
    })),
};
