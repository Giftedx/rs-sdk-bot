// Writes client-assets/thieving.json: the pickpocket roll of each NPC of the pinned server, by its display name, from
// skill_thieving/configs/pickpocking/pickpocket.dbrow, as {npc: [level, xp, low, high, stun ticks, stun damage]}.
// The XP is the server's: the row's experience (tenths, as stat_advance takes it) times the XP rate (XP_RATE, 25).
// thieving.rs2 picks the pocket when stat_random(thieving, success_chance) passes: floor(low*(99-L)/98) +
// floor(high*(L-1)/98) + 1 beats a roll of 0-255 (PlayerOps.ts STAT_RANDOM), with L the current Thieving level.
// Run: bun packages/dashboard/gen-thieving.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XP_RATE } from '../knowledge/src/method-model';

export type Pickpocket = [number, number, number, number, number, number];

export function parsePickpocket(dbrow: string, npcNames: Map<string, string>, rate = XP_RATE): Record<string, Pickpocket> {
    const out: Record<string, Pickpocket> = {};
    for (const block of dbrow.split(/^\[/m).slice(1)) {
        const all = (k: string) => [...block.matchAll(new RegExp(`^data=${k},(.*)$`, 'gm'))].map(m => m[1]!.trim());
        const one = (k: string) => all(k)[0];
        const chance = one('success_chance')?.split(',').map(Number);
        if (!chance || chance.length !== 2 || !chance.every(Number.isFinite)) continue;
        const row: Pickpocket = [Number(one('level')) || 1, Math.round(Number(one('experience') || 0) * rate) / 10, chance[0]!, chance[1]!, Number(one('stun_ticks')) || 0, Number(one('stun_damage')) || 0];
        // Several NPC types share a row (man, man2, al_kharid_man); each display name keeps the first row that names it.
        for (const npc of all('npc')) { const name = npcNames.get(npc); if (name && !out[name]) out[name] = row; }
    }
    return out;
}

// The chance (0-1) that one pickpocket passes at a Thieving level, as the engine rolls it.
export function pickChance(low: number, high: number, level: number): number {
    const L = Math.min(level, 99);
    return Math.min(Math.floor(low * (99 - L) / 98) + Math.floor(high * (L - 1) / 98) + 1, 256) / 256;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const npcs = JSON.parse(readFileSync(join(root, 'knowledge', 'npcs.json'), 'utf8')) as { debugname?: string; name?: string }[];
    const names = new Map(npcs.filter(n => n.debugname && n.name).map(n => [n.debugname!, n.name!]));
    const dbrow = readFileSync(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'skill_thieving', 'configs', 'pickpocking', 'pickpocket.dbrow'), 'utf8');
    const out = parsePickpocket(dbrow, names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'thieving.json'), JSON.stringify(out));
    console.log(`thieving.json: ${Object.keys(out).length} NPC names`);
}
