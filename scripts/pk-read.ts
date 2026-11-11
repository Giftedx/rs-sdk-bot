// Reading an opponent in a player fight: what its armour is weak to, and which style it will attack with next.
// A fixed loop fights every opponent the same way; a skilled player looks first. scripts/pk.ts uses both readers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Style } from './pk';

type Defence = { stab: number; slash: number; crush: number; magic: number; ranged: number };
const KEYS = { stabdefence: 'stab', slashdefence: 'slash', crushdefence: 'crush', magicdefence: 'magic', rangedefence: 'ranged' } as const;
let byName: Map<string, Defence> | undefined;
// The defence bonuses of every wearable item, from the content's item configs (param=stabdefence,21 and so on).
function defences(root = resolve(import.meta.dir, '..', 'vendor/rs-sdk/server/content/scripts')): Map<string, Defence> {
    if (byName) return byName;
    byName = new Map();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) { walk(path); continue; }
            if (!entry.endsWith('.obj')) continue;
            let name = '';
            for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
                const head = /^\[(.+)\]$/.exec(line);
                if (head) { name = head[1]!; continue; }
                const param = /^param=(\w+),(-?\d+)$/.exec(line), key = param && KEYS[param[1] as keyof typeof KEYS];
                if (!name || !key) continue;
                if (!byName!.has(name)) byName!.set(name, { stab: 0, slash: 0, crush: 0, magic: 0, ranged: 0 });
                byName!.get(name)![key] = Number(param![2]);
            }
        }
    };
    walk(root);
    return byName;
}
// The summed defence bonus of worn items against each of our styles. Melee is the stab bonus: the dragon dagger stabs.
export function armourDefence(wornNames: readonly string[], table = defences()): Record<Style, number> {
    const sum = { melee: 0, ranged: 0, magic: 0 };
    for (const name of wornNames) { const d = table.get(name); if (d) { sum.melee += d.stab; sum.ranged += d.ranged; sum.magic += d.magic; } }
    return sum;
}
// Our styles from the opponent's weakest defence to its strongest.
export const weakestFirst = (defence: Record<Style, number>): Style[] => (['magic', 'ranged', 'melee'] as Style[]).sort((a, b) => defence[a] - defence[b]);

// Which style an opponent attacks with next, from the order of the weapons it has shown. It counts each change from
// one style to another; a prediction needs the same change seen twice and in at least 60% of the changes from that style.
export class StylePredictor {
    private counts = new Map<Style, Map<Style, number>>();
    private last: Style | null = null;
    observe(style: Style): void {
        if (style === this.last) return;
        if (this.last) {
            const row = this.counts.get(this.last) ?? new Map<Style, number>();
            row.set(style, (row.get(style) ?? 0) + 1);
            this.counts.set(this.last, row);
        }
        this.last = style;
    }
    predict(): Style | null {
        const row = this.last && this.counts.get(this.last);
        if (!row) return null;
        const total = [...row.values()].reduce((a, b) => a + b, 0), [style, n] = [...row].sort((a, b) => b[1] - a[1])[0]!;
        return n >= 2 && n / total >= 0.6 ? style : null;
    }
    // Every style the opponent has shown.
    seen(): Set<Style> { return new Set([...(this.last ? [this.last] : []), ...this.counts.keys()]); }
}
