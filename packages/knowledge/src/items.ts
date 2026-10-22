import type { ConfigBlock } from './config';

export interface Item {
    id: number;
    name: string;
    debugname: string;
    cost: number; // static config value; the Equipment and Bank boards score this, not market price
    members: boolean;
    tradeable: boolean;
    src: string;
}

export function invert(pack: Map<number, string>): Map<string, number> {
    const m = new Map<string, number>();
    for (const [id, name] of pack) m.set(name, id);
    return m;
}

export function buildItems(blocks: ConfigBlock[], pack: Map<number, string>): Item[] {
    const ids = invert(pack);
    const out: Item[] = [];
    for (const b of blocks) {
        const id = ids.get(b.name);
        if (id === undefined) continue;
        const costLine = b.propLines.cost?.[0];
        out.push({
            id,
            name: b.props.name?.[0] ?? b.name,
            debugname: b.name,
            cost: Number(b.props.cost?.[0] ?? 1), // engine default when cost= is absent
            members: b.props.members?.[0] === 'yes',
            tradeable: b.props.tradeable?.[0] === 'yes',
            src: `${b.file}:${costLine ?? b.line}`,
        });
    }
    return out.sort((a, b) => a.id - b.id);
}
