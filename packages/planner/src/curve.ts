// Level curve of this server, copied from server/engine/src/engine/entity/Player.ts:77-99.
// The engine stores tenths of XP: levelExperience[i] = floor(acc / 4) * 10, acc += floor(L + 2^(L/10) * 300).
// (The original game uses 2^(L/7); this server is flatter.) Values here are whole XP.
const TABLE: number[] = (() => {
    const t: number[] = [];
    let acc = 0;
    for (let i = 0; i < 99; i++) {
        const level = i + 1;
        acc += Math.floor(level + Math.pow(2.0, level / 10.0) * 300.0);
        t.push((Math.floor(acc / 4) * 10) / 10);
    }
    return t;
})();

// Whole XP needed to reach `level` (1..99).
export function xpForLevel(level: number): number {
    if (level <= 1) return 0;
    return TABLE[Math.min(level, 99) - 2]!;
}

export function levelForXp(xp: number): number {
    for (let i = 97; i >= 0; i--) if (xp >= TABLE[i]!) return Math.min(i + 2, 99);
    return 1;
}
