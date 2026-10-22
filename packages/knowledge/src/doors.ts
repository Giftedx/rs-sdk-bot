import { cleanLines } from './text';

export type DoorKind = 'open' | 'one_way' | 'key' | 'quest' | 'skill' | 'locked' | 'unknown';
export interface DoorNeed { skill?: string; level?: number; varp?: string; item?: string; side?: string }
export interface Trigger { body: string; src: string }
export type Triggers = Map<string, Trigger>; // key: `<type>,<name>`, e.g. `oploc1,brasskeydoor`, `label,open_x`

// Reads every [type,name] block from RuneScript files. A body runs to the next line that starts with `[`.
// A one-line trigger (`[oploc1,x] @label;`) keeps the text after the header as its body.
export function parseTriggers(files: { text: string; file: string }[]): Triggers {
    const out: Triggers = new Map();
    for (const { text, file } of files) {
        const lines = cleanLines(text);
        let key: string | null = null;
        let start = 0;
        let body: string[] = [];
        const flush = () => { if (key && !out.has(key)) out.set(key, { body: body.join('\n'), src: `${file}:${start}` }); };
        lines.forEach((l, i) => {
            const m = l.match(/^\[(\w+),([^\]]+)\](.*)$/);
            if (m) {
                flush();
                key = `${m[1]},${m[2]}`;
                start = i + 1;
                body = m[3]!.trim() ? [m[3]!.trim()] : [];
            } else if (key) {
                body.push(l);
            }
        });
        flush();
    }
    return out;
}

const REFUSAL = /(mes|mesbox|chatnpc\w*)\(.*(locked|won't|can't|cannot|not experienced|need|isn't)/i;
const OPEN_PROC = /~(open_door|open_door_reversed|open_and_close_door\w*|open_and_close_double\w*|doubledoor\w*|open_double\w*|open_gate|open_outer_gate)\b/i;

// Follows one `@label` or `~proc` call that the trigger body makes, so checks inside it count.
function expand(body: string, t: Triggers): string {
    let out = body;
    for (const m of body.matchAll(/@(\w+)/g)) out += '\n' + (t.get(`label,${m[1]}`)?.body ?? '');
    for (const m of body.matchAll(/~(\w+)/g)) {
        if (OPEN_PROC.test(`~${m[1]}`)) continue;
        out += '\n' + (t.get(`proc,${m[1]}`)?.body ?? '');
    }
    return out;
}

export function classifyDoor(loc: string, category: string | undefined, t: Triggers): { kind: DoorKind; need?: DoorNeed; trigger: string } {
    const trig = t.get(`oploc1,${loc}`) ?? (category ? t.get(`oploc1,_${category}`) : undefined);
    const useTrig = t.get(`oplocu,${loc}`);
    if (!trig && !useTrig) return { kind: 'unknown', trigger: '' };
    const src = trig?.src ?? useTrig!.src;
    const body = trig ? expand(trig.body, t) : '';

    if (useTrig && /last_useitem|inv_total/.test(useTrig.body)) {
        const item = [...useTrig.body.matchAll(/case\s+(\w+)\s*:/g)].map(m => m[1]!).find(c => c !== 'default');
        return { kind: 'key', need: item ? { item } : undefined, trigger: src };
    }
    const skill = body.match(/stat\((\w+)\)\s*<\s*(\d+)/);
    if (skill) return { kind: 'skill', need: { skill: skill[1], level: Number(skill[2]) }, trigger: src };
    const varp = body.match(/%(\w+)/);
    if (varp && REFUSAL.test(body)) return { kind: 'quest', need: { varp: varp[1] }, trigger: src };
    const side = body.match(/coord([xz])\(coord\)\s*([<>]=?)\s*coord[xz]\(loc_coord\)/);
    if (side && REFUSAL.test(body)) return { kind: 'one_way', need: { side: `refuses when player ${side[1]} ${side[2]} door ${side[1]}` }, trigger: src };
    if (OPEN_PROC.test(body)) return { kind: 'open', trigger: src };
    if (REFUSAL.test(body)) return { kind: 'locked', trigger: src };
    return { kind: 'unknown', trigger: src };
}
