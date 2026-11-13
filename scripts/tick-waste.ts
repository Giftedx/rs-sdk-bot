// Tick waste per script family from the swarm logs: each LEDGER line (packages/core/src/ledger.ts) is tagged by the
// RESULT line after it in the same job. Lists scripts by idle+move ticks, the time a bot is logged in without working.
// wasteShare() gives each family's idle+move share for the autopilot (packages/planner/src/autopilot.ts).
// Usage: bun scripts/tick-waste.ts [min ticks per family, default 2000]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
const SIG: [string, RegExp][] = [['goldfarm', /coinsGained=|picks=\d+ fails=/], ['thieving60', /thieving=\d+/], ['fishing30', /fishing=\d+ xp=/], ['shop-buyer', /boughtTotal=/],
 ['cook-food', /cookedTotal=|cookedPer1kTicks/], ['gather-fish', /caughtTotal=|lobsters?=|fish=\d/], ['gather-feathers', /feathers=\d+ gained=/], ['quest-sweep', /^quest-sweep /],
 ['quest script', /qp=|alreadyComplete|questMsg|flag=complete/], ['fletch', /^mode=(headless|arrows|shafts|steel|bows)/], ['smelt', /^mode=(iron|steel|bronze|gold|mithril)/], ['essence', /^essence /],
 ['shark-supply', /newBankedSharks=/], ['rune-bank-craft', /runecraft=\d+ trips=/], ['stop file', /^stop file/], ['session ended', /^session ended/], ['gather-yews', /wood|logs=|chops/i]];
// `idleBy`: idle ticks by reason (ledger.ts idleWhy), from the LEDGER lines that carry `idleBy=`.
export type Waste = { runs: number; ticks: number; idle: number; move: number; anim: number; stun: number; dialog: number; idleBy: Record<string, number> };
// The idle reasons of one LEDGER line: `idleBy=combat:12,after:walkTo:3` -> {combat: 12, 'after:walkTo': 3}.
export const idleReasons = (line: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of (line.match(/ idleBy=(\S*)/)?.[1] ?? '').split(',').filter(Boolean)) {
    const at = part.lastIndexOf(':');
    if (at > 0) out[part.slice(0, at)] = (out[part.slice(0, at)] ?? 0) + Number(part.slice(at + 1));
  }
  return out;
};
export const familyOf = (result: string) => SIG.find(([, re]) => re.test(result))?.[0] ?? ('other:' + result.split(/[\s=]/)[0]!.slice(0, 16));

const workerLine = (line: string) => line.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, '');

export function tickWaste(dir = '.practice/swarm-logs'): Map<string, Waste> {
  const agg = new Map<string, Waste>();
  if (!existsSync(dir)) return agg;
  for (const f of readdirSync(dir)) {
    const lines = readFileSync(`${dir}/${f}`, 'latin1').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes('LEDGER ticks=')) continue;
      const m = workerLine(line).match(/^LEDGER ticks=(\d+).* move=(\d+) anim=(\d+) dialog=(\d+) stun=(\d+) idle=(\d+)/);
      if (!m) continue;
      let key = '?';
      for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
        const next = lines[k]!;
        if (next.startsWith('SWARM_JOB ')) break;
        if (!next.includes('RESULT ')) continue;
        const r = workerLine(next).match(/^RESULT (?:ok|fail) (.*)$/);
        if (r) { key = familyOf(r[1]!); break; }
      }
      const e = agg.get(key) ?? { runs: 0, ticks: 0, idle: 0, move: 0, anim: 0, stun: 0, dialog: 0, idleBy: {} };
      e.runs++; e.ticks += +m[1]!; e.move += +m[2]!; e.anim += +m[3]!; e.dialog += +m[4]!; e.stun += +m[5]!; e.idle += +m[6]!;
      for (const [why, n] of Object.entries(idleReasons(line))) e.idleBy[why] = (e.idleBy[why] ?? 0) + n;
      agg.set(key, e);
    }
  }
  return agg;
}

// Idle+move share per family with at least `minTicks` measured ticks.
export const wasteShare = (agg: Map<string, Waste>, minTicks = 2000): Record<string, number> =>
  Object.fromEntries([...agg].filter(([, e]) => e.ticks >= minTicks).map(([k, e]) => [k, (e.idle + e.move) / e.ticks]));

if (import.meta.main) {
  const rows = [...tickWaste()].filter(([, e]) => e.ticks >= Number(process.argv[2] ?? 2000)).sort((a, b) => (b[1].idle + b[1].move) - (a[1].idle + a[1].move));
  console.log('script'.padEnd(26), 'runs', 'ticks'.padStart(8), 'idle%', 'move%', 'anim%', 'wasteTicks', ' idle reasons (share of the idle ticks that carry one)');
  for (const [k, e] of rows.slice(0, 30)) {
    const named = Object.values(e.idleBy).reduce((n, v) => n + v, 0);
    const why = named ? Object.entries(e.idleBy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, n]) => `${w} ${(100 * n / named).toFixed(0)}%`).join(', ') : '-';
    console.log(k.padEnd(26), String(e.runs).padStart(4), String(e.ticks).padStart(8), (100 * e.idle / e.ticks).toFixed(0).padStart(5), (100 * e.move / e.ticks).toFixed(0).padStart(5), (100 * e.anim / e.ticks).toFixed(0).padStart(5), String(e.idle + e.move).padStart(9), ' ' + why);
  }
}
