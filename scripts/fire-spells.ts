// The fire spells a staff of fire casts (skill_combat/configs/magic/magic_combat_spells.dbrow): level, max hit, and
// the one rune besides fire (the staff) and air. The quest fights that cast them (Tree Gnome Village, The Grand Tree,
// Fight Arena) use the strongest the account can cast from its pack.
export const FIRE_SPELLS = [
    { comp: 'magic:fire_wave', level: 75, maxhit: 20, rune: 565 },
    { comp: 'magic:fire_blast', level: 59, maxhit: 16, rune: 560 },
    { comp: 'magic:fire_bolt', level: 35, maxhit: 12, rune: 562 },
] as const;
export const fireSpell = (magic: number, has: (id: number) => boolean): string =>
    FIRE_SPELLS.find(s => magic >= s.level && has(s.rune))?.comp ?? 'magic:fire_bolt';
// The rune of the strongest fire spell a Magic level allows.
export const fireRune = (magic: number): number => FIRE_SPELLS.find(s => magic >= s.level)?.rune ?? 562;
// A pack's cast runes for a fire spell above the account's Magic level, moved to the strongest spell it can cast
// (Fight Arena packs 60 blood runes for Fire Wave, Magic 75; at Magic 59-74 they become death runes, below that chaos).
export function fireRunesFor(pack: ReadonlyMap<number, number>, magic: number): Map<number, number> {
    const out = new Map(pack), allowed = fireRune(magic);
    for (const s of FIRE_SPELLS) {
        const n = out.get(s.rune);
        if (n === undefined || magic >= s.level) continue;
        out.delete(s.rune);
        out.set(allowed, (out.get(allowed) ?? 0) + n);
    }
    return out;
}
