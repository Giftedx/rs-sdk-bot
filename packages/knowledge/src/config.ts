import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { contentRoot } from './paths';
import { cleanLines } from './text';

export interface ConfigBlock {
    name: string;
    props: Record<string, string[]>;
    file: string;
    line: number; // 1-based line of the [name] header
}

export function parseConfigs(text: string, file: string): ConfigBlock[] {
    const out: ConfigBlock[] = [];
    let cur: ConfigBlock | null = null;
    cleanLines(text).forEach((line, i) => {
        if (!line) return;
        if (line.startsWith('[') && line.endsWith(']')) {
            cur = { name: line.slice(1, -1), props: {}, file, line: i + 1 };
            out.push(cur);
            return;
        }
        const eq = line.indexOf('=');
        if (cur && eq > 0) {
            const key = line.slice(0, eq);
            (cur.props[key] ??= []).push(line.slice(eq + 1));
        }
    });
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
