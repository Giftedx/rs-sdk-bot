import { cleanLines } from './text';

export function parsePack(text: string): Map<number, string> {
    const m = new Map<number, string>();
    for (const line of cleanLines(text)) {
        const eq = line.indexOf('=');
        if (eq > 0) m.set(Number(line.slice(0, eq)), line.slice(eq + 1));
    }
    return m;
}
