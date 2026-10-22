import type { ConfigBlock } from './config';

export interface Shop {
    inv: string;
    file: string;
    src: string;
    stock: { item: string; count: number; restockTicks: number | null; src: string }[]; // null: the line gives no restock value
}

// An .inv block is a shop when it has stockN=item,count,restock lines.
export function buildShops(blocks: ConfigBlock[]): Shop[] {
    const out: Shop[] = [];
    for (const b of blocks) {
        const keys = Object.keys(b.props).filter(k => /^stock\d+$/.test(k)).sort((a, c) => Number(a.slice(5)) - Number(c.slice(5)));
        if (keys.length === 0) continue;
        const stock = keys.map(k => {
            const [item, count, restock] = b.props[k]![0]!.split(',');
            return { item: item!, count: Number(count), restockTicks: restock === undefined ? null : Number(restock), src: `${b.file}:${b.propLines[k]![0]}` };
        });
        out.push({ inv: b.name, file: b.file, src: `${b.file}:${b.line}`, stock });
    }
    return out;
}
