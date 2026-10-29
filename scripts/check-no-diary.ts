// No-diary rule (AGENTS.md "Keep knowledge small"): docs, plans, research and configs state what is true now. Git
// commits are the only history. This check flags history in prose: dates, before/after wording, update logs and
// attempt stories. Text in backticks, quotes and link targets is exempt (paths, game text, file names).
// Usage: bun scripts/check-no-diary.ts [--list]   exit 1 when a flagged line exists.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const DIARY: { id: string; re: RegExp }[] = [
    { id: 'date', re: /\b20\d\d-[01]\d-[0-3]\d\b/ },
    { id: 'before-after', re: /\((?:was|previously|before|formerly)\b|\b(?:previously|formerly|used to|no longer|anymore|any more)\b/i },
    { id: 'history-verb', re: /\b(?:was|were|has been|have been) (?:replaced|superseded|fixed|retired|removed|added|changed|moved|renamed|dropped|reverted|resolved|flipped|rejected|revoked)\b/i },
    { id: 'update-log', re: /\b(?:update[sd]?\s*[:(]|\*\*resolved\b|superseded\b|earlier (?:finding|version|script|run|claim|plan)|next owner|as of\b)/i },
    { id: 'attempt-story', re: /\b(?:first|second|third|another|retried|earlier|later) (?:attempt|try|tries|pass|session)\b|\b(?:this|last|that) (?:session|night|morning|week)\b|\b(?:today|yesterday|overnight|tonight)\b/i },
];

// Exempt spans: `code`, "quotes", link targets (...) after ], and bare file paths.
export function prose(line: string): string {
    return line.replace(/`[^`]*`/g, ' ').replace(/"[^"]*"/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(/\S*[\\/]\S*/g, ' ');
}

export function flag(text: string): { line: number; id: string; text: string }[] {
    const out: { line: number; id: string; text: string }[] = [];
    let fence = false;
    text.split(/\r?\n/).forEach((raw, i) => {
        if (/^\s*```/.test(raw)) { fence = !fence; return; }
        if (fence) return;
        const p = prose(raw);
        for (const d of DIARY) if (d.re.test(p)) { out.push({ line: i + 1, id: d.id, text: raw.trim().slice(0, 160) }); break; }
    });
    return out;
}

// The files the rule covers: hand-written Markdown outside generated and vendored trees, plus swarm.json job notes.
export function covered(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', 'vendor', '.git', '.practice', '.claude', '.superpowers', 'archive'].includes(e.name)) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.md') && !GENERATED.has(relative(root, p).replace(/\\/g, '/'))) files.push(p);
        }
    };
    walk(root);
    return files.sort();
}
// Written by generators (do not hand-edit): knowledge/build.ts, planner rank-cli.ts, scripts/learn.ts.
const GENERATED = new Set(['knowledge/BUILD.md', 'research/board-ranking.md', 'research/learning-report.md',
    // Attribution notices keep upstream dates and revisions as license evidence.
    'knowledge/ubermouse/NOTICE.md']);

export function check(root: string) {
    const results: { file: string; flags: ReturnType<typeof flag> }[] = [];
    for (const f of covered(root)) results.push({ file: relative(root, f).replace(/\\/g, '/'), flags: flag(readFileSync(f, 'utf8')) });
    const swarm = join(root, 'swarm.json');
    if (existsSync(swarm) && statSync(swarm).isFile()) {
        const plan = JSON.parse(readFileSync(swarm, 'utf8'));
        const notes = (plan.jobs ?? []).filter((j: { note?: string }) => j.note).map((j: { note: string; account?: string }, i: number) => ({ line: i + 1, id: 'job-note', text: `${j.account ?? '?'}: ${j.note.slice(0, 120)}` }));
        results.push({ file: 'swarm.json', flags: notes });
    }
    return results.filter(r => r.flags.length);
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..');
    const results = check(root), total = results.reduce((n, r) => n + r.flags.length, 0);
    if (process.argv.includes('--list')) for (const r of results) for (const f of r.flags) console.log(`${r.file}:${f.line} [${f.id}] ${f.text}`);
    else for (const r of results.sort((a, b) => b.flags.length - a.flags.length)) console.log(`${String(r.flags.length).padStart(5)} ${r.file}`);
    console.log(`no-diary: ${total} flagged lines in ${results.length} files`);
    process.exit(total ? 1 : 0);
}
