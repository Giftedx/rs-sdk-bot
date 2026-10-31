// Tick waste per script family from the swarm logs: each LEDGER line (packages/core/src/ledger.ts) is tagged by the
// RESULT line after it. Lists scripts by idle+move ticks, the time a bot is logged in without working.
// Usage: bun scripts/tick-waste.ts [min ticks per family, default 2000]
import { readdirSync, readFileSync } from 'node:fs';
const SIG: [string, RegExp][] = [['goldfarm', /coinsGained=|picks=\d+ fails=/], ['thieving60', /thieving=\d+/], ['fishing30', /fishing=\d+ xp=/], ['shop-buyer', /boughtTotal=/],
 ['cook-food', /cookedTotal=|cookedPer1kTicks/], ['gather-fish', /caughtTotal=|lobsters?=|fish=\d/], ['gather-feathers', /feathers=\d+ gained=/], ['quest-sweep', /^quest-sweep /],
 ['quest script', /qp=|alreadyComplete|questMsg|flag=complete/], ['fletch', /^mode=(headless|arrows|shafts|steel|bows)/], ['smelt', /^mode=(iron|steel|bronze|gold|mithril)/], ['essence', /^essence /],
 ['shark-supply', /newBankedSharks=/], ['rune-bank-craft', /runecraft=\d+ trips=/], ['stop file', /^stop file/], ['session ended', /^session ended/], ['gather-yews', /wood|logs=|chops/i]];
const dir = '.practice/swarm-logs', agg = new Map<string, { runs: number; ticks: number; idle: number; move: number; anim: number; stun: number; dialog: number }>();
for (const f of readdirSync(dir)) {
  const lines = readFileSync(`${dir}/${f}`, 'latin1').split(/\r?\n/).map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, ''));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^LEDGER ticks=(\d+).* move=(\d+) anim=(\d+) dialog=(\d+) stun=(\d+) idle=(\d+)/);
    if (!m) continue;
    let key = '?';
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
      const r = lines[k]!.match(/^RESULT (?:ok|fail) (.*)$/);
      if (r) { const t = r[1]!; key = SIG.find(([, re]) => re.test(t))?.[0] ?? ('other:' + t.split(/[\s=]/)[0]!.slice(0, 16)); break; }
    }
    const e = agg.get(key) ?? { runs: 0, ticks: 0, idle: 0, move: 0, anim: 0, stun: 0, dialog: 0 };
    e.runs++; e.ticks += +m[1]!; e.move += +m[2]!; e.anim += +m[3]!; e.dialog += +m[4]!; e.stun += +m[5]!; e.idle += +m[6]!;
    agg.set(key, e);
  }
}
const rows = [...agg].filter(([, e]) => e.ticks >= Number(process.argv[2] ?? 2000)).sort((a, b) => (b[1].idle + b[1].move) - (a[1].idle + a[1].move));
console.log('script'.padEnd(26), 'runs', 'ticks'.padStart(8), 'idle%', 'move%', 'anim%', 'wasteTicks');
for (const [k, e] of rows.slice(0, 30)) console.log(k.padEnd(26), String(e.runs).padStart(4), String(e.ticks).padStart(8), (100 * e.idle / e.ticks).toFixed(0).padStart(5), (100 * e.move / e.ticks).toFixed(0).padStart(5), (100 * e.anim / e.ticks).toFixed(0).padStart(5), String(e.idle + e.move).padStart(9));
