// Memory of a supervisor that reads a long child output: the whole output in one string (the method before) against
// keepOutput (packages/practice/src/supervise.ts). Each method runs in its own bun process.
// Usage: bun scripts/measure/supervise-output-memory.ts [megabytes=400]
import { keepOutput } from '../../packages/practice/src/supervise';

const mode = process.argv[2];
const megabytes = Number(process.argv[mode === 'whole' || mode === 'kept' ? 3 : 2] ?? 400);
const childScript = `const f='x'.repeat(199)+'\\n';const block=f.repeat(5000);for(let i=0;i<${Math.ceil(megabytes)};i++)process.stdout.write(block);process.stdout.write('LEDGER ticks=900\\nRESULT ok done\\n')`;

if (mode === 'whole' || mode === 'kept') {
    const p = Bun.spawn(['bun', '-e', childScript], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
    const quiet = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    let kept: string;
    if (mode === 'whole') {
        let text = '';
        const reader = p.stdout.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
        kept = text;
    } else kept = await keepOutput(p.stdout, l => l.startsWith('RESULT') ? 'RESULT' : /^LEDGER ticks=\d+/.test(l) ? 'LEDGER' : null);
    clearInterval(timer);
    process.stdout.write = quiet;
    peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`${mode.padEnd(6)} child output ${megabytes} MB, held ${(kept.length / 2 ** 20).toFixed(1)} MB, peak rss ${Math.round(peak / 2 ** 20)} MB, end rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`);
    process.exit(0);
}
for (const m of ['whole', 'kept']) {
    const p = Bun.spawnSync(['bun', import.meta.path, m, String(megabytes)], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
    process.stdout.write(p.stdout.toString());
}
