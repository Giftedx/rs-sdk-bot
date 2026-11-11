import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs } from './config';
import { parsePack } from './pack';
import { contentRoot } from './paths';

// Each NPC that attacks a player without being attacked first, read from the pinned content.
//
// An NPC with a `huntmode` looks for a player within `huntrange` tiles of its own tile (engine Npc.ts huntPlayers).
// The hunt config (*.hunt) gives the rule: `type=player` with `find_newmode=opplayer2` or `applayer2` is an attack.
// With `check_nottoostrong=outside_wilderness` the NPC skips a player outside the Wilderness whose combat level is
// above two times the NPC's `vislevel`.
//
// The table does not hold the other hunt checks (line of sight, a worn item, an AFK player): an NPC in the table can
// attack, and a check can still stop it.
export interface NpcHunter {
    range: number;
    // Tiles the NPC walks from its spawn tile (`wanderrange`, 5 when the config has none: NpcType.ts:101).
    wander: number;
    // The NPC's visible combat level, for the too-strong rule.
    level: number;
    // true: the too-strong rule applies outside the Wilderness.
    tooStrong: boolean;
}

let cached: ReadonlyMap<number, NpcHunter> | undefined;

export function npcHunters(): ReadonlyMap<number, NpcHunter> {
    if (cached) return cached;
    const root = contentRoot();
    const hunts = new Map<string, boolean>();
    for (const file of listConfigFiles('.hunt')) {
        for (const block of parseConfigs(readFileSync(join(root, file), 'utf8'), file)) {
            const mode = block.props.find_newmode?.[0];
            if (block.props.type?.[0] !== 'player' || (mode !== 'opplayer2' && mode !== 'applayer2')) continue;
            hunts.set(block.name, block.props.check_nottoostrong?.[0] === 'outside_wilderness');
        }
    }
    // One NPC can have blocks in several files: the values of all its blocks count.
    const props = new Map<string, Record<string, string>>();
    for (const file of listConfigFiles('.npc')) {
        for (const block of parseConfigs(readFileSync(join(root, file), 'utf8'), file)) {
            const own = props.get(block.name) ?? {};
            for (const key of ['huntmode', 'huntrange', 'vislevel', 'wanderrange']) if (block.props[key]?.[0] !== undefined) own[key] = block.props[key]![0]!;
            props.set(block.name, own);
        }
    }
    const out = new Map<number, NpcHunter>();
    for (const [id, name] of parsePack(readFileSync(join(root, 'pack/npc.pack'), 'utf8'))) {
        const own = props.get(name), tooStrong = own?.huntmode === undefined ? undefined : hunts.get(own.huntmode);
        const range = Number(own?.huntrange ?? 0);
        if (tooStrong === undefined || !(range > 0)) continue;
        const level = Number(own?.vislevel ?? -1), wander = Number(own?.wanderrange ?? 5);
        out.set(id, { range, wander: Number.isFinite(wander) ? wander : 5, level: Number.isFinite(level) ? level : -1, tooStrong });
    }
    cached = out;
    return out;
}
