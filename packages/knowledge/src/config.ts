import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { contentRoot } from './paths';
import { cleanLines } from './text';

export interface ConfigBlock {
    name: string;
    props: Record<string, string[]>;
    propLines: Record<string, number[]>; // 1-based line of each value in props
    file: string;
    line: number; // 1-based line of the [name] header
}

export function parseConfigs(text: string, file: string): ConfigBlock[] {
    const out: ConfigBlock[] = [];
    let cur: ConfigBlock | null = null;
    let lineNo = 0;
    let pos = 0;
    const total = text.length;
    while (pos <= total) {
        const nl = text.indexOf('\n', pos);
        let end = nl === -1 ? total : nl;
        lineNo++;
        if (end > pos && text.charCodeAt(end - 1) === 13) end--;
        const comment = text.indexOf('//', pos);
        if (comment >= 0 && comment < end) end = comment;
        let s = pos;
        while (s < end && text.charCodeAt(s) <= 32) s++;
        while (end > s && text.charCodeAt(end - 1) <= 32) end--;
        if (end > s) {
            if (text.charCodeAt(s) === 91 /* '[' */ && text.charCodeAt(end - 1) === 93 /* ']' */) {
                cur = { name: text.slice(s + 1, end - 1), props: {}, propLines: {}, file, line: lineNo };
                out.push(cur);
            } else if (cur) {
                const eq = text.indexOf('=', s);
                if (eq > s && eq < end) {
                    const key = text.slice(s, eq);
                    (cur.props[key] ??= []).push(text.slice(eq + 1, end));
                    (cur.propLines[key] ??= []).push(lineNo);
                }
            }
        }
        if (nl === -1) break;
        pos = nl + 1;
    }
    return out;
}

// Same file set the engine pack tool reads: every file with this extension under content/scripts,
// including _unpack/<rev>/ (each rev folder holds only that revision's additions). Paths are relative to the content root.
export function listConfigFiles(ext: string): string[] {
    const root = contentRoot();
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(ext)) out.push(relative(root, p).split(sep).join('/'));
        }
    };
    walk(join(root, 'scripts'));
    return out.sort();
}
