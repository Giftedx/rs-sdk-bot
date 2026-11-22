// Shared line-plan geometry for Firemaking line probes and Haggis rehearsals.
import { FIREMAKING, ladder, objId } from './floor-bands';

export const PACK = 27;
export const CHUNK = 28;

export function planOf(rows: string) {
    const tiles: { x: number; z: number; row: number }[] = [];
    rows.split(';').forEach((r, ri) => {
        const [z, sx, ex] = r.split(',').map(Number);
        for (let x = sx!; x >= ex!; x--) tiles.push({ x, z: z!, row: ri });
    });
    const logs: { id: number; band: string }[] = [];
    for (const st of ladder(FIREMAKING)) {
        for (let i = 0; i < st.actions; i++) logs.push({ id: objId(Object.keys(st.band.inputs)[0]!), band: st.band.name });
    }
    if (tiles.length < logs.length) throw new Error(`line has ${tiles.length} tiles, need ${logs.length}`);
    return logs.map((l, i) => ({ ...l, ...tiles[i]! }));
}
