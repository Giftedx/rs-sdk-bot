import { OP_NEG } from './tables';
import type { Assumption, Built, Requirements, RunResult, ShortcutKind } from './types';

// True when the assumption is a stat_random roll that fails: `stat_random(..) = false` holds, or a bare or `= true` roll does not.
export function rollFailed(a: Assumption): boolean {
    if (a.sym.cls !== 'random' || !a.sym.text.startsWith('stat_random')) return false;
    const m = a.sym.text.match(/ (=|!) (true|false|0|1)$/);
    if (!m) return a.value === 'F';
    const holdsMeansFalse = (m[1] === '=') === (m[2] === 'false' || m[2] === '0');
    return holdsMeansFalse ? a.value === 'T' : a.value === 'F';
}

const normOp = (op: string, value: string) => value === 'T' ? op : (OP_NEG[op] ?? op);
function minNeeded(op: string, n: number): number | null { return op === '>=' ? n : op === '>' ? n + 1 : op === '=' ? n : null; }

export function mapAssumptions(as: Assumption[]): Built {
    const req: Requirements = {}; const side: string[] = [], choices: string[] = [], conditions: string[] = [], requireSrc: string[] = [];
    let failure: Built['failure'];
    for (const a of as) {
        const src = `${a.file}:${a.line}`;
        const m = a.key.match(/^(.*) (<=|>=|=|!|<|>) (.+)$/);
        const op = m ? normOp(m[2]!, a.value) : '', rhs = m?.[3] ?? '';
        const num = /^-?\d+$/.test(rhs) ? Number(rhs) : null;
        switch (a.sym.cls) {
            case 'skill': {
                const need = num !== null ? minNeeded(op, num) : null;
                if (need !== null) { (req.skills ??= []).push({ name: a.sym.meta!.skill!, level: need, src }); requireSrc.push(src); }
                else if (num !== null && (op === '<' || op === '<=')) conditions.push(`${a.sym.meta!.skill} ${op} ${num} (${src})`);
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'item': case 'worn': {
                const list = a.sym.cls === 'item' ? (req.items ??= []) : (req.worn ??= []);
                const obj = a.sym.meta!.item!;
                // "Holds none of X" only selects a branch (e.g. which pickaxe); it is a condition, not a need.
                if (m && num !== null && ((op === '<=' && num <= 0) || (op === '<' && num <= 1) || (op === '=' && num === 0))) { conditions.push(`without ${a.sym.cls === 'worn' ? 'worn ' : ''}${obj} (${src})`); break; }
                if (m && (num !== null)) {
                    if (obj === 'coins' && a.sym.cls === 'item') { const need = minNeeded(op, num); if (need !== null) req.coins = Math.max(req.coins ?? 0, need); else list.push({ item: obj, op, count: num, src }); }
                    else list.push({ item: obj, op, count: num, src });
                } else if (m) list.push({ item: obj, op, count: rhs, src });
                else conditions.push(`${a.detail} (${src})`);
                requireSrc.push(src); break;
            }
            case 'varp': {
                if (m) { (req.varps ??= []).push({ varp: a.sym.meta!.varp!, op, value: num ?? rhs, quest: true, src }); requireSrc.push(src); }
                else if (a.value.startsWith('c')) { (req.varps ??= []).push({ varp: a.sym.meta!.varp!, op: 'in', value: a.detail.replace(/^%\w+ = /, ''), quest: true, src }); requireSrc.push(src); }
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'useitem': {
                const item = m && op === '=' ? rhs : a.value.startsWith('c') ? a.detail.replace(/^last_useitem = /, '') : null;
                if (item && item !== 'default') { req.useItem = { item, src }; requireSrc.push(src); }
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'side': side.push(`${a.detail} (${src})`); break;
            case 'choice': choices.push(`${a.detail} (${src})`); break;
            case 'random':
                if (rollFailed(a)) failure = { a };
                else if (!a.sym.text.startsWith('stat_random')) conditions.push(`${a.detail} (${src})`);
                break;
            default: conditions.push(`${a.detail} (${src})`);
        }
    }
    if (req.skills?.length) { const top = req.skills.reduce((x, y) => y.level > x.level ? y : x); req.skill = { name: top.name, level: top.level }; }
    return { requires: req, side, choices, conditions, requireSrc: [...new Set(requireSrc)], ...(failure ? { failure } : {}) };
}

// Removes an assumption that two results with the same outcome take with opposite values; it does not decide that outcome.
export function minimize(rs: RunResult[], outcome: (r: RunResult) => string): RunResult[] {
    let list = rs.map(r => ({ ...r, assumptions: [...r.assumptions] }));
    for (let changed = true; changed;) {
        changed = false;
        outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!, b = list[j]!;
            if (outcome(a) !== outcome(b)) continue;
            const ka = new Map(a.assumptions.map(x => [x.key, x.value])), kb = new Map(b.assumptions.map(x => [x.key, x.value]));
            const diff = [...new Set([...ka.keys(), ...kb.keys()])].filter(k => ka.get(k) !== kb.get(k));
            const same = (x: Map<string, string>, y: Map<string, string>) => [...x].every(([k, v]) => k === diff[0] || y.get(k) === v);
            if (diff.length === 1 && ka.has(diff[0]!) && kb.has(diff[0]!) && same(ka, kb) && same(kb, ka)) {
                a.assumptions = a.assumptions.filter(x => x.key !== diff[0]);
                list.splice(j, 1); changed = true; break outer;
            }
            if (diff.length === 0) { list.splice(j, 1); changed = true; break outer; }
        }
    }
    return list;
}

export function kindOf(file: string, requires: Requirements, randomStat?: string): ShortcutKind {
    if (/skill_agility\/scripts\/(barbarian|gnome|wilderness)_course\.rs2$/.test(file) || file.includes('minigames/game_agilityarena/')) return 'course';
    // A passage in a quest folder is 'quest' even with an Agility need; the quest varps gate it.
    if (file.startsWith('scripts/quests/')) return 'quest';
    if (file.includes('skill_agility/') || requires.skills?.some(s => s.name === 'agility') || randomStat === 'agility') return 'shortcut';
    if (file.startsWith('scripts/minigames/')) return 'minigame';
    if (file.startsWith('scripts/tutorial/')) return 'tutorial';
    return 'passage';
}
