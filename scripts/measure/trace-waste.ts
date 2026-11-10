// Ranks the cases of a trace folder by the ticks they lose to refused actions.
// Usage: bun scripts/measure/trace-waste.ts [dir=.practice/aio-bench/trace] [min ticks=10]
// The folder comes from `BENCH_TRACE=<dir> bun run bench <pattern> --no-keep`. In `<case>.actions` a line
// `in <Message> ok=false` is an action that the engine refused with no message (the player was delayed, or a window
// was open). The script then waits its whole bound before it sends again. The loss of one refusal is the quiet
// gap after it: the ticks until the script sends anything again.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Refusal = { tick: number; kind: string; lost: number; delayed: boolean; modal: boolean; at: string };

export function refusals(text: string): Refusal[] {
    const sends: { tick: number; kind: string; ok: boolean; delayed: boolean; modal: boolean; at: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
        const m = /^t=(\d+) \S+ in (\S+) ok=(true|false) delayed=(true|false) modal=(\d+) .* at=(\S+)$/.exec(line);
        if (m) sends.push({ tick: Number(m[1]), kind: m[2]!, ok: m[3] === 'true', delayed: m[4] === 'true', modal: m[5] !== '0', at: m[6]! });
    }
    const out: Refusal[] = [];
    for (let i = 0; i < sends.length; i++) {
        const s = sends[i]!;
        // A walk click or a page click that is refused costs nothing by itself: the script does not wait on it.
        if (s.ok || s.kind === 'MoveClick' || s.kind === 'ResumePauseButton' || s.kind === 'CloseModal') continue;
        // The loss is the quiet gap after the refusal: the ticks until the script sends anything again. A refusal
        // that the script follows with a new send in the next ticks costs little; a script that waits its bound
        // shows a long gap.
        const next = sends[i + 1];
        if (next) out.push({ tick: s.tick, kind: s.kind, lost: next.tick - s.tick, delayed: s.delayed, modal: s.modal, at: s.at });
    }
    return out;
}

if (import.meta.main) {
    const dir = process.argv[2] ?? '.practice/aio-bench/trace', min = Number(process.argv[3] ?? 10);
    const rows = readdirSync(dir).filter(f => f.endsWith('.actions')).map(f => {
        const all = refusals(readFileSync(join(dir, f), 'utf8')).filter(r => r.lost >= 4);
        const lost = all.reduce((n, r) => n + r.lost, 0);
        const worst = [...all].sort((a, b) => b.lost - a.lost).slice(0, 3).map(r => `${r.kind}@t${r.tick}:${r.lost}`).join(' ');
        return { name: f.slice(0, -8), count: all.length, lost, worst };
    }).filter(r => r.lost >= min).sort((a, b) => b.lost - a.lost);
    console.log(`case${' '.repeat(34)}refused  ticks lost  worst`);
    for (const r of rows) console.log(`${r.name.padEnd(38)}${String(r.count).padStart(7)}  ${String(r.lost).padStart(10)}  ${r.worst}`);
    console.log(`\n${rows.length} cases lose ${min} ticks or more: ${rows.reduce((n, r) => n + r.lost, 0)} ticks in all`);
}
