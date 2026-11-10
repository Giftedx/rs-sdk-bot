// The world feed sends the roster on one socket as a full frame, then as changes:
//   {t:'roster', k, p: [[slot, name, x, z, level, combat], ...], npcs}            the full frame
//   {t:'roster', k, d:1, lv: [slot, ...], j: [row, ...], m: [[slot, x, z, level, combat?], ...], npcs}   the changes
// lv lists the slots that left, j the rows that joined or changed, m the players that moved. An m row holds the
// combat level only when it changed.
// RosterFeed keeps the rows of one socket and gives each roster message back as a full frame.
export type RosterRow = [slot: number, name: string, x: number, z: number, level: number, combat: number];

export class RosterFeed {
    private rows = new Map<number, RosterRow>();
    private full = false;

    // A message that is not a roster comes back as it is. So does a change frame that has no full frame before it.
    expand<T>(message: T): T {
        const m = message as any;
        if (m?.t !== 'roster') return message;
        if (Array.isArray(m.p)) {
            this.rows.clear();
            for (const r of m.p) if (Array.isArray(r)) this.rows.set(r[0], [...r] as RosterRow);
            this.full = true;
            return message;
        }
        if (!this.full) return message;
        for (const slot of Array.isArray(m.lv) ? m.lv : []) this.rows.delete(slot);
        for (const r of Array.isArray(m.j) ? m.j : []) if (Array.isArray(r)) this.rows.set(r[0], [...r] as RosterRow);
        for (const r of Array.isArray(m.m) ? m.m : []) {
            const row = Array.isArray(r) ? this.rows.get(r[0]) : undefined;
            if (row) { row[2] = r[1]; row[3] = r[2]; row[4] = r[3]; if (r.length > 4) row[5] = r[4]; }
        }
        return { t: 'roster', k: m.k, p: [...this.rows.values()].map(r => [...r]), npcs: m.npcs } as T;
    }
}
