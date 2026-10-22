import type { ConfigBlock } from './config';
import type { Spawn } from './jm2';
import { invert } from './items';

export interface Npc {
    id: number;
    name: string;
    debugname: string;
    combat: number;
    src: string;
    spawns: { x: number; z: number; level: number; src: string }[];
}

export function buildNpcs(blocks: ConfigBlock[], pack: Map<number, string>, spawns: Spawn[]): Npc[] {
    const ids = invert(pack);
    const byId = new Map<number, Npc['spawns']>();
    for (const s of spawns) byId.set(s.id, [...(byId.get(s.id) ?? []), { x: s.x, z: s.z, level: s.level, src: s.src }]);
    const out: Npc[] = [];
    for (const b of blocks) {
        const id = ids.get(b.name);
        if (id === undefined) continue;
        out.push({
            id,
            name: b.props.name?.[0] ?? b.name,
            debugname: b.name,
            combat: Number(b.props.vislevel?.[0] ?? 0),
            src: `${b.file}:${b.line}`,
            spawns: byId.get(id) ?? [],
        });
    }
    return out.sort((a, b) => a.id - b.id);
}
