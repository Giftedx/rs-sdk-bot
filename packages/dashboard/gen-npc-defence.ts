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
// Run: bun packages/dashboard/gen-npc-defence.ts
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Defence = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
const DAMAGE: Record<string, number> = { '^stab_style': 0, '^slash_style': 1, '^crush_style': 2 };
const BONUS = ['stabdefence', 'slashdefence', 'crushdefence', 'magicdefence', 'rangedefence'];

export function npcDefence(files: string[], combat: Map<string, number>): Record<string, Defence[]> {
    const out: Record<string, Defence[]> = {};
    for (const text of files) for (const block of text.split(/^\[/m).slice(1)) {
        const debug = block.slice(0, block.indexOf(']')), field = (k: string) => block.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
        const name = field('name');
        if (!name || !/^op\d=Attack\s*$/m.test(block)) continue;
        const param = (k: string) => Number(block.match(new RegExp(`^param=${k},(-?\\d+)\\s*$`, 'm'))?.[1] ?? 0);
        const lvl = (k: string) => Number(field(k) ?? 1) || 1, damage = block.match(/^param=damagetype,(\S+)\s*$/m)?.[1] ?? '';
        const row: Defence = [combat.get(debug) ?? 0, lvl('defence'), lvl('magic'), ...BONUS.map(param), lvl('attack'), lvl('strength'), param('attackbonus'), param('strengthbonus'), DAMAGE[damage] ?? -1, lvl('hitpoints'), Number(block.match(/^param=combat_xp_multiplier,(\d+)\s*$/m)?.[1] ?? 1000), Number(field('respawnrate') ?? 100) || 100] as Defence;
        const list = (out[name] ??= []);
        if (!list.some(r => r.every((v, i) => v === row[i]))) list.push(row);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a[0] - b[0]);
    return out;
}

// The chance (0-1) that an attack roll beats a defence roll, both drawn from 0 up to the roll (randominc).
export function hitChance(attack: number, defence: number): number {
    return attack > defence ? 1 - (defence + 2) / (2 * (attack + 1)) : attack / (2 * (defence + 1));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), scripts = join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts');
    const npcFiles = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? npcFiles(p) : f.endsWith('.npc') ? [readFileSync(p, 'utf8')] : []; });
    const npcs = JSON.parse(readFileSync(join(root, 'knowledge', 'npcs.json'), 'utf8')) as { debugname?: string; combat?: number }[];
    const combat = new Map(npcs.filter(n => n.debugname && Number.isFinite(n.combat)).map(n => [n.debugname!, n.combat!]));
    const out = npcDefence(npcFiles(scripts), combat);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-defence.json'), JSON.stringify(out));
    console.log(`npc-defence.json: ${Object.keys(out).length} attackable NPC names`);
}
