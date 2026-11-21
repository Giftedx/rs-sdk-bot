import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameAction } from '../../../knowledge/src/actions';

// The source our workers are written in, lower-cased: scripts and package sources, not tests and not generated knowledge.
export function corpus(root: string): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'test', 'knowledge'].includes(e.name)) walk(p); }
            else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) parts.push(readFileSync(p, 'utf8'));
        }
    };
    walk(join(root, 'scripts'));
    for (const pkg of ['core', 'practice', 'router', 'planner']) walk(join(root, 'packages', pkg, 'src'));
    return parts.join('\n').toLowerCase();
}

// The display name needs five characters (so "Door" alone does not count).
const MIN_DEBUG_NAME = 4;
function actionNames(a: GameAction): string[] {
    const debug = a.subject.replace(/^_/, '').split(':')[0]!.toLowerCase();
    const name = a.name?.toLowerCase();
    return [...(debug.length >= MIN_DEBUG_NAME ? [debug] : []), ...(name && name.length >= 5 ? [name] : [])];
}
export function named(a: GameAction, text: string): boolean {
    return actionNames(a).some(term => text.includes(term));
}

// Scan once. A shared prefix selects candidates, and startsWith checks each full term.
function namesInCorpus(names: readonly string[], text: string): Set<string> {
    const byPrefix = new Map<string, Set<string>>();
    for (const name of names) {
        const prefix = name.slice(0, MIN_DEBUG_NAME);
        const matches = byPrefix.get(prefix) ?? new Set<string>();
        matches.add(name);
        byPrefix.set(prefix, matches);
    }
    const found = new Set<string>();
    for (let i = 0; i <= text.length - MIN_DEBUG_NAME && byPrefix.size; i++) {
        const prefix = text.slice(i, i + MIN_DEBUG_NAME), matches = byPrefix.get(prefix);
        if (!matches) continue;
        for (const name of matches) if (text.startsWith(name, i)) {
            found.add(name);
            matches.delete(name);
        }
        if (!matches.size) byPrefix.delete(prefix);
    }
    return found;
}

// Scripts a practice engine ran, as `trigger,subject` keys. Each line of the trace is a script name such as
// [oploc1,_door]; several engines append to one file, so a key can repeat. A missing file means no data yet.
export function firedActions(file: string): Set<string> {
    if (!existsSync(file)) return new Set();
    return new Set(readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => line.match(/^\[([^\],]+,[^\]]+)\]$/)?.[1] ?? []));
}
export const actionKey = (a: GameAction) => `${a.trigger},${a.subject}`;

export function domainStages(actions: GameAction[], text: string, fired: Set<string> = new Set()) {
    const by = new Map<string, { total: number; named: number; fired: number }>();
    const names = actions.map(actionNames), found = namesInCorpus(names.flat(), text);
    for (const [i, a] of actions.entries()) {
        const d = by.get(a.domain) ?? { total: 0, named: 0, fired: 0 };
        d.total++; if (names[i]!.some(term => found.has(term))) d.named++; if (fired.has(actionKey(a))) d.fired++;
        by.set(a.domain, d);
    }
    return [...by].map(([domain, d]) => ({ domain, actions: d.total, named: d.named, fired: d.fired, share: Math.round(100 * d.named / d.total) })).sort((a, b) => a.share - b.share || b.actions - a.actions);
}
