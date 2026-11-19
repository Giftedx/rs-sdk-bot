// Heap of one tick ledger over a long session: every row kept (keep = 1e9, the method before) against the ring
// (the default keep). Each mode runs in its own bun process.
// Usage: bun scripts/measure/ledger-memory.ts [ticks=500000]
import { startLedger } from '../../packages/core/src/ledger';

const mode = process.argv[2];
const ticks = Number(process.argv[mode === 'all' || mode === 'ring' ? 3 : 2] ?? 500_000);

if (mode === 'all' || mode === 'ring') {
    let t = 0, state: any = { tick: 0, player: { worldX: 0, worldZ: 0, level: 0, animId: -1, combat: { inCombat: false, lastDamageTick: -1 } }, skills: [], dialog: { isOpen: false } };
    const cbs: (() => void)[] = [];
    const led = startLedger({ sdk: { getState: () => state }, onTick: cb => { cbs.push(cb); return () => {}; }, tick: () => t }, () => 'walkTo', mode === 'all' ? 1e9 : undefined);
    Bun.gc(true);
    const before = process.memoryUsage();
    for (let i = 0; i < ticks; i++) {
        t++;
        state = { ...state, tick: t, player: { ...state.player, worldX: i % 3 === 0 ? i : state.player.worldX } };
        for (const cb of cbs) cb();
    }
    Bun.gc(true);
    const after = process.memoryUsage();
    const summary = led.stop();
    console.log(`${mode.padEnd(4)} ${ticks} ticks, rows held ${led.rows.length}, heap +${((after.heapUsed - before.heapUsed) / 2 ** 20).toFixed(1)} MB, rss +${Math.round((after.rss - before.rss) / 2 ** 20)} MB, idle ${summary.counts.idle}, longestIdle ${summary.longestIdle[0]?.length}`);
    process.exit(0);
}
for (const m of ['all', 'ring']) {
    const p = Bun.spawnSync(['bun', import.meta.path, m, String(ticks)], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
    process.stdout.write(p.stdout.toString());
}
