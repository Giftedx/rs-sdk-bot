// Writes client-assets/npc-defence.json: the defence of each attackable NPC of the pinned server, by its name, as a list of
// its variants [combat, defence level, magic level, stab, slash, crush, magic, range defence bonus, attack level, strength
// level, attack bonus, strength bonus, damage type (0 stab, 1 slash, 2 crush, -1 other), hitpoints, combat XP multiplier
// (param=combat_xp_multiplier, default 1000; random-event NPCs give 25), respawn rate in ticks (respawnrate=, default
// 100: one minute, engine NpcType.ts)], lowest combat first.
// From the content's .npc configs: defence= and magic= (a missing level is 1), param=stabdefence and the rest (a missing
// bonus is 0, skill_combat/configs/combat.param). The combat level is knowledge/npcs.json's. An NPC is attackable when
// one of its ops is Attack.
// The page rolls as the server does (npc_combat.rs2 npc_defence_roll_specific, player_combat_stat.rs2): the NPC's roll is
// (level + 9) x (bonus + 64), with the magic level for magic; the player's is (level + 8 + style) x (bonus + 64).
// Its melee (npc_combat_melee.rs2): attack roll (attack + 9) x (attack bonus + 64) against the player's (Defence + 8) x
// (defence bonus of its damage type + 64); max hit floor(((strength + 9) x (strength bonus + 64) + 320) / 640).
// It also writes client-assets/npc-hunt.json for the NPC aggression timer: each NPC variant (debug name) that hunts
// players and spawns, as [name, hunt kind, vislevel, [x, z, level, ...]] with that variant's own spawns
// (knowledge/npcs.json), so a variant that never spawns (kalphite_worker_chamber) does not count at the others' tiles.
// Hunt kind (Npc.ts huntAll, the .hunt configs): 1 the NPC hunts players outside the Wilderness only up to combat
// 2 x vislevel (check_nottoostrong=outside_wilderness), all players inside it; 2 it hunts all players; 3 as 2, and it
// never stops (check_afk=off). A huntmode of another type, or huntrange 0 (the default, NpcType.ts), does not hunt.
// With check_afk on (the default, HuntType.ts), a player who stays in two 21 x 21 areas for 1,000 ticks is not hunted
// (Player.ts zonesAfk). vislevel defaults to -1: with kind 1 that NPC hunts only in the Wilderness.
// Run: bun packages/dashboard/gen-npc-defence.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Defence = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
const DAMAGE: Record<string, number> = { '^stab_style': 0, '^slash_style': 1, '^crush_style': 2 };
const BONUS = ['stabdefence', 'slashdefence', 'crushdefence', 'magicdefence', 'rangedefence'] as const;
const DEF_ATTACK_RE = /^op\d=Attack\s*$/m;
const DEF_DAMAGE_RE = /^param=damagetype,(\S+)\s*$/m;
const DEF_XP_MULT_RE = /^param=combat_xp_multiplier,(\d+)\s*$/m;
const FIELD_RE_CACHE = new Map<string, RegExp>();
const PARAM_RE_CACHE = new Map<string, RegExp>();
const fieldMatch = (block: string, k: string): string | undefined => {
    let re = FIELD_RE_CACHE.get(k);
    if (!re) { re = new RegExp(`^${k}=(.*)$`, 'm'); FIELD_RE_CACHE.set(k, re); }
    return block.match(re)?.[1]?.trim();
};
const paramNum = (block: string, k: string): number => {
    let re = PARAM_RE_CACHE.get(k);
    if (!re) { re = new RegExp(`^param=${k},(-?\\d+)\\s*$`, 'm'); PARAM_RE_CACHE.set(k, re); }
    return Number(block.match(re)?.[1] ?? 0);
};

export function npcDefence(files: string[], combat: Map<string, number>): Record<string, Defence[]> {
    const out: Record<string, Defence[]> = {};
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const name = fieldMatch(block, 'name');
        if (!name || !DEF_ATTACK_RE.test(block)) continue;
        const debug = block.slice(0, block.indexOf(']'));
        const lvl = (k: string) => Number(fieldMatch(block, k) ?? 1) || 1, damage = block.match(DEF_DAMAGE_RE)?.[1] ?? '';
        const row: Defence = [combat.get(debug) ?? 0, lvl('defence'), lvl('magic'), paramNum(block, BONUS[0]), paramNum(block, BONUS[1]), paramNum(block, BONUS[2]), paramNum(block, BONUS[3]), paramNum(block, BONUS[4]), lvl('attack'), lvl('strength'), paramNum(block, 'attackbonus'), paramNum(block, 'strengthbonus'), DAMAGE[damage] ?? -1, lvl('hitpoints'), Number(block.match(DEF_XP_MULT_RE)?.[1] ?? 1000), Number(fieldMatch(block, 'respawnrate') ?? 100) || 100];
        const list = (out[name] ??= []);
        if (!list.some(r => r.every((v, i) => v === row[i]))) list.push(row);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a[0] - b[0]);
    return out;
}

// The hunt kind (1, 2 or 3, as above) of each huntmode name that hunts players, from the .hunt configs.
export function huntKinds(files: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const name = block.slice(0, block.indexOf(']'));
        if (fieldMatch(block, 'type') !== 'player') continue;
        out.set(name, fieldMatch(block, 'check_afk') === 'off' ? 3 : fieldMatch(block, 'check_nottoostrong') === 'outside_wilderness' ? 1 : 2);
    }
    return out;
}

export type Hunter = [string, number, number, number[]];
type Tile = { x: number; z: number; level?: number };

// The hunting variants that spawn: one row for each name, kind and vislevel, with the spawns of those variants only.
export function npcHunters(files: string[], hunts: Map<string, number>, npcs: { debugname?: string; spawns?: Tile[] }[]): Hunter[] {
    const kind = new Map<string, { name: string; kind: number; vis: number }>();
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const name = fieldMatch(block, 'name');
        if (!name) continue;
        const k = Number(fieldMatch(block, 'huntrange') ?? 0) >= 1 ? hunts.get(fieldMatch(block, 'huntmode') ?? '') ?? 0 : 0;
        if (k > 0) kind.set(block.slice(0, block.indexOf(']')), { name, kind: k, vis: Number(fieldMatch(block, 'vislevel') ?? -1) });
    }
    const by = new Map<string, { name: string; kind: number; vis: number; seen: Set<string>; flatTiles: number[] }>();
    for (const n of npcs) {
        const h = n.debugname ? kind.get(n.debugname) : undefined;
        if (!h || !n.spawns?.length) continue;
        const key = `${h.name}|${h.kind}|${h.vis}`;
        let g = by.get(key);
        if (!g) {
            g = { name: h.name, kind: h.kind, vis: h.vis, seen: new Set<string>(), flatTiles: [] };
            by.set(key, g);
        }
        for (const s of n.spawns) {
            if (!Number.isInteger(s.x) || !Number.isInteger(s.z)) continue;
            const lvl = s.level ?? 0;
            const tk = `${s.x},${s.z},${lvl}`;
            if (!g.seen.has(tk)) {
                g.seen.add(tk);
                g.flatTiles.push(s.x, s.z, lvl);
            }
        }
    }
    const out: Hunter[] = [];
    for (const g of by.values()) out.push([g.name, g.kind, g.vis, g.flatTiles]);
    out.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]);
    return out;
}

// The chance (0-1) that an attack roll beats a defence roll, both drawn from 0 up to the roll (randominc).
export function hitChance(attack: number, defence: number): number {
    return attack > defence ? 1 - (defence + 2) / (2 * (attack + 1)) : attack / (2 * (defence + 1));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const files = (d: string, ext: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p, ext) : f.endsWith(ext) ? [readFileSync(p, 'utf8')] : []; });
    const npcFiles = (d: string) => files(d, '.npc');
    const npcs = JSON.parse(readFileSync(join(root, 'knowledge', 'npcs.json'), 'utf8')) as { debugname?: string; combat?: number; spawns?: Tile[] }[];
    const combat = new Map(npcs.filter(n => n.debugname && Number.isFinite(n.combat)).map(n => [n.debugname!, n.combat!]));
    const out = npcDefence(npcFiles(scripts), combat);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-defence.json'), JSON.stringify(out));
    console.log(`npc-defence.json: ${Object.keys(out).length} attackable NPC names`);
    const hunt = npcHunters(npcFiles(scripts), huntKinds(files(scripts, '.hunt')), npcs);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-hunt.json'), JSON.stringify(hunt));
    console.log(`npc-hunt.json: ${hunt.length} hunting rows, ${hunt.reduce((n, r) => n + r[3].length / 3, 0)} spawns`);
}
