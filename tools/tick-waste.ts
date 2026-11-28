// Tick waste per script family from the swarm logs: each LEDGER line (packages/core/src/ledger.ts) is tagged by its
// structured `script=` field or the RESULT line after it in the same job. Lists scripts by standing-still, idle and
// move ticks, plus top live standing-still offenders from status files and per-account breakdowns.
// wasteShare() gives each family's idle+move share.
// A run's worker release comes from the `RELEASE` line after its START (packages/core/src/bot/rules.ts releaseLine);
// a run without one is `unknown`. `--latest` counts, for each family, only the runs on the release of its newest run.
// `--since-hours <n>` filters per-run using each run's timestamp (START/RELEASE/LEDGER/line timestamp when present,
// falling back to file mtime only when no run timestamp exists).
// Usage: bun tools/tick-waste.ts [min ticks per family, default 2000] [--latest] [--since-hours <n>] [--by-account]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SIG: [string, RegExp][] = [
  ['goldfarm', /coinsGained=|picks=\d+ fails=/],
  ['thieving60', /thieving=\d+/],
  ['fishing30', /fishing=\d+ xp=/],
  ['shop-buyer', /boughtTotal=|shop-buyer\b|rune-shop\b|^shop-to-bid\b/],
  ['cook-food', /cookedTotal=|cookedPer1kTicks|\bcook\b.*cooked=/i],
  ['gather-fish', /caughtTotal=|lobsters?=|fish=\d|^banked_karambwan/],
  ['gather-feathers', /feathers=\d+ gained=/],
  ['quest-sweep', /^quest-sweep /],
  ['walk-to', /^walk-to\b|arrived at \d+,\d+/],
  ['quest', /qp=|alreadyComplete|questMsg|flag=complete|\bquest\b|^(?:talk|walk(?!-to)|step|bars|herbloreXp|torch|tick)\b/],
  ['fletch', /^mode=(headless|arrows|shafts|steel|bows)|\bfletch(?:ing)?\b/i],
  ['smelt', /^mode=(iron|steel|bronze|gold|mithril|smith)\b|\bsmelt\b|\bsmith(?:ing)?\b/i],
  ['enchant', /"magicXp":.*"product":|"product":2552\b|\benchant\b/i],
  ['alch', /^alch\b|\balch(?:ed|s|ing)?\b|highAlch|lowAlch/i],
  ['bank-artisan', /"recipe":"(?:identify:|brew:|silver_sickle)|^herblore\b|^finite\b/i],
  ['essence', /^essence |\bessence\b/],
  ['shark-supply', /newBankedSharks=/],
  ['rune-bank-craft', /runecraft=\d+ trips=|rune-bank-craft|mode=craft talismansReady=/],
  ['fleet-trade', /^(?:fleet-trade|transferred|exact|fan-in|fan-out|waiting)\b|\bfleet-trade\b/],
  ['travel', /^travel\b|travelled|traveled/i],
  ['bank-logistics', /^(?:give-to-banker|take-from-banker|bank-deposit|deposit|bank-job|inspect|inspection)\b/],
  ['ge-market', /^ge[- ]|offers=|filled=|collected=|"phase":"(?:settled|unplaced)"|"foodUsed":/],
  ['combat', /^mode=(?:cow|giant|imp|chicken|goblin|guard|crabs?|combat|melee|ranged|magic|train)\b|^ticks=\d+ kills=\d+|^chicken-qualification\b|^ranged\b|\bkills=\d+/i],
  ['agility', /^agility-order\b|\bagility\b|laps=\d+/i],
  ['magic', /^magic-order\b/i],
  ['prayer', /\bprayer\b|buried=\d+/i],
  ['firemaking', /\bfiremaking\b|burned=\d+/i],
  ['mining', /\bmining\b|mined=\d+|ores?=\d+/i],
  ['crafting', /\bcrafting\b|spun=\d+|bowstrings?=\d+/i],
  ['pk-squad', /^PK run\b|\bpk-?squad\b|\bpk-?hunt\b|\bsquad\b.*kills=/i],
  ['specialist-99', /^level=99 xp=/],
  ['gather-yews', /wood|logs=|chops/i],
  ['stop file', /^stop file/],
  ['session ended', /^session ended/],
];

const SCRIPT_FAMILY_MAP: [RegExp, string][] = [
  [/^aio-skiller:gather\/yew/i, 'gather-yews'],
  [/^aio-skiller:gather\/(?:fish|lobster|trout|salmon|fly|cage|harpoon|shrimp)/i, 'gather-fish'],
  [/^aio-skiller:gather\/feather/i, 'gather-feathers'],
  [/^aio-skiller:gather\/essence/i, 'essence'],
  [/^aio-skiller:gather\/(?:mine|mining|ore|iron|coal|copper|tin|clay)/i, 'mining'],
  [/^aio-skiller:artisan\/fletch/i, 'fletch'],
  [/^aio-skiller:artisan\/(?:smith|smelt)/i, 'smelt'],
  [/^aio-skiller:artisan\/cook/i, 'cook-food'],
  [/^aio-skiller:artisan\/craft/i, 'crafting'],
  [/^aio-skiller:artisan\/(?:fire|fm)/i, 'firemaking'],
  [/^aio-skiller:artisan\/alch/i, 'alch'],
  [/^aio-skiller:artisan\/prayer/i, 'prayer'],
  [/^aio-skiller:(?:runecraft|rune-bank-craft)/i, 'rune-bank-craft'],
  [/^aio-skiller:agility/i, 'agility'],
  [/^aio-skiller:thiev/i, 'thieving60'],
  [/^aio-logistics:walk-to/i, 'walk-to'],
  [/^aio-logistics:travel/i, 'travel'],
  [/^aio-logistics:fleet-trade/i, 'fleet-trade'],
  [/^aio-logistics:(?:give-to-banker|take-from-banker|deposit|inspect)/i, 'bank-logistics'],
  [/^aio-market:(?:shop-buyer|earth-shop|rune-shop)/i, 'shop-buyer'],
  [/^aio-market:(?:ge|buy|sell|market)/i, 'ge-market'],
  [/^aio-combat:/i, 'combat'],
  [/^aio-quester(?::|$)/i, 'quest'],
  [/^quest-sweep$/i, 'quest-sweep'],
  [/^shop-buyer$/i, 'shop-buyer'],
  [/^goldfarm$/i, 'goldfarm'],
  [/^shark-supply$/i, 'shark-supply'],
  [/^pk-squad$/i, 'pk-squad'],
];

// `idleBy`: idle ticks by reason (ledger.ts idleWhy), from the LEDGER lines that carry `idleBy=`. `release`: set only by
// `latest`, the release the family's numbers come from.
export type Waste = {
  runs: number;
  ticks: number;
  idle: number;
  move: number;
  anim: number;
  stun: number;
  dialog: number;
  standStill: number;
  maxStandStill: number;
  idleBy: Record<string, number>;
  release?: string;
};

export type AccountWaste = {
  runs: number;
  ticks: number;
  idle: number;
  standStill: number;
  move: number;
  maxStandStill: number;
  idleBy: Record<string, number>;
  families: string[];
};

export type LiveTickOffender = {
  name: string;
  script: string | null;
  at: number;
  ticks: number;
  standStillPct: number;
  windowStandStillPct: number;
  currentStandStill: number;
  maxStandStill: number;
  why: string | null;
  pos: string | null;
};

// The idle reasons of one LEDGER line: `idleBy=combat:12,after:walkTo:3` -> {combat: 12, 'after:walkTo': 3}.
export const idleReasons = (line: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of (line.match(/ idleBy=(\S*)/)?.[1] ?? '').split(',').filter(Boolean)) {
    const at = part.lastIndexOf(':');
    if (at > 0) out[part.slice(0, at)] = (out[part.slice(0, at)] ?? 0) + Number(part.slice(at + 1));
  }
  return out;
};

export const scriptFamilyOf = (script: string): string => {
  const clean = script.trim();
  if (!clean) return '?';
  return SCRIPT_FAMILY_MAP.find(([re]) => re.test(clean))?.[1] ?? clean;
};

export const familyOf = (result: string) =>
  SIG.find(([, re]) => re.test(result))?.[0] ?? ('other:' + (result.split(/[\s=]/)[0] ?? '').slice(0, 16));

const workerLine = (line: string) => line.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, '');
const lineBotPrefix = (line: string): string | null => line.match(/^\s*(?:\|\s*)?\[([^\]]+)\]\s*/)?.[1] ?? null;

function parseStandingStill(line: string, idle: number, reasons: Record<string, number>): { standStill: number; maxStandStill: number } {
  const ssMatch = line.match(/ standStill=(\d+)/);
  const standStill = ssMatch
    ? Number(ssMatch[1])
    : Math.max(0, idle - (reasons.combat ?? 0) - (reasons.hurt ?? 0));
  const msMatch = line.match(/ maxStandStill=(\d+)/);
  let maxStandStill = msMatch ? Number(msMatch[1]) : 0;
  if (!msMatch && standStill > 0) {
    const liMatch = line.match(/ longestIdle=(\d+)@/);
    if (liMatch) maxStandStill = Number(liMatch[1]);
  }
  return { standStill, maxStandStill };
}

function emptyWaste(release?: string): Waste {
  return {
    runs: 0, ticks: 0, idle: 0, move: 0, anim: 0, stun: 0, dialog: 0,
    standStill: 0, maxStandStill: 0, idleBy: {},
    ...(release !== undefined ? { release } : {}),
  };
}

export interface TickWasteOptions {
  latest?: boolean;
  sinceHours?: number;
  now?: number;
}

const MIN_EPOCH_MS = 1_500_000_000_000;
const MAX_EPOCH_MS = 4_102_444_800_000;
const ISO_TS_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/;
const KV_EPOCH_RE = /\b(?:at|ts|time)=(\d{13})\b/;
const JSON_EPOCH_RE = /"(?:at|loggedOutAt|started|timestamp)"\s*:\s*(\d{13})\b/;

// Extracts an epoch-ms timestamp from a log line (key-value `at=<ms>`, ISO-8601 UTC timestamp, or JSON epoch field).
export function extractLineTimestamp(line: string): number | null {
  const kv = line.match(KV_EPOCH_RE);
  if (kv) {
    const ms = Number(kv[1]);
    if (ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS) return ms;
  }
  const iso = line.match(ISO_TS_RE);
  if (iso) {
    const ms = Date.parse(iso[1]!);
    if (Number.isFinite(ms) && ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS) return ms;
  }
  const json = line.match(JSON_EPOCH_RE);
  if (json) {
    const ms = Number(json[1]);
    if (ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS) return ms;
  }
  return null;
}

function scanLogs(dir: string, opts: TickWasteOptions = {}) {
  const agg = new Map<string, Waste>();
  const byRelease = new Map<string, Map<string, Waste>>();
  const newest = new Map<string, string>();
  const byAccount = new Map<string, { runs: number; ticks: number; idle: number; standStill: number; move: number; maxStandStill: number; idleBy: Record<string, number>; families: Set<string> }>();
  if (!existsSync(dir)) return { agg, byRelease, newest, byAccount };
  const now = opts.now ?? Date.now();
  const minMtime = opts.sinceHours && opts.sinceHours > 0 ? now - opts.sinceHours * 3_600_000 : 0;
  const files = readdirSync(dir)
    .map(f => {
      try { return { f, at: statSync(`${dir}/${f}`).mtimeMs }; }
      catch { return null; }
    })
    .filter((x): x is { f: string; at: number } => !!x && x.at >= minMtime)
    .sort((a, b) => a.at - b.at || (a.f < b.f ? -1 : 1));

  for (const { f, at: fileAt } of files) {
    const fileBot = f.replace(/^host-/, '').replace(/\.log(\.\d+)?$/, '');
    const lines = readFileSync(`${dir}/${f}`, 'latin1').split(/\r?\n/);
    let release = 'unknown';
    let releaseScript: string | null = null;
    let hostScript: string | null = null;
    let runAt: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineTs = extractLineTimestamp(line);
      if (line.startsWith('SWARM_JOB ')) {
        release = 'unknown';
        releaseScript = null;
        hostScript = null;
        runAt = lineTs;
        continue;
      }
      const body = workerLine(line);
      const hostStart = body.match(/^HOST start .* script=(\S+)/);
      if (hostStart) {
        hostScript = hostStart[1]!.split(/[\\/]/).pop()?.replace(/\.ts$/i, '') ?? null;
        runAt = lineTs;
        continue;
      }
      if (body.startsWith('START ')) {
        runAt = lineTs;
        continue;
      }
      const rel = body.match(/^RELEASE (\S+)(?:\s+script=(\S+))?/);
      if (rel) {
        release = rel[1]!;
        if (rel[2]) releaseScript = rel[2]!;
        if (lineTs !== null) runAt = lineTs;
        continue;
      }
      if (!line.includes('LEDGER ticks=')) {
        if (lineTs !== null) runAt = lineTs;
        continue;
      }
      const m = body.match(/^LEDGER ticks=(\d+).* move=(\d+) anim=(\d+) dialog=(\d+) stun=(\d+) idle=(\d+)/);
      if (!m) continue;
      const reasons = idleReasons(line);
      const { standStill, maxStandStill } = parseStandingStill(line, +m[6]!, reasons);
      const botPrefix = lineBotPrefix(line);
      const botName = body.match(/ bot=(\S+)/)?.[1] ?? botPrefix ?? fileBot;
      const explicitScript = body.match(/ script=(\S+)/)?.[1] ?? releaseScript;
      let key = explicitScript ? scriptFamilyOf(explicitScript) : '?';
      let postTs: number | null = null;
      for (let k = i + 1; k < Math.min(lines.length, i + 80); k++) {
        const next = lines[k]!;
        if (next.startsWith('SWARM_JOB ')) break;
        const nextPrefix = lineBotPrefix(next);
        if (botPrefix && nextPrefix && nextPrefix !== botPrefix) continue;
        const nextBody = workerLine(next);
        if (nextBody.startsWith('LEDGER ticks=') || nextBody.startsWith('START ')) break;
        if (postTs === null && k <= i + 20) postTs = extractLineTimestamp(next);
        if (key === '?' && next.includes('RESULT ')) {
          const r = nextBody.match(/^RESULT (?:ok|fail) (.*)$/);
          if (r) key = familyOf(r[1]!);
        }
        if (key !== '?' && (lineTs !== null || runAt !== null || postTs !== null)) break;
      }
      if (key === '?' && hostScript) key = scriptFamilyOf(hostScript);
      const effectiveAt = lineTs ?? runAt ?? postTs ?? fileAt;
      runAt = null;
      if (minMtime > 0 && effectiveAt < minMtime) continue;
      const add = (e: Waste) => {
        e.runs++;
        e.ticks += +m[1]!;
        e.move += +m[2]!;
        e.anim += +m[3]!;
        e.dialog += +m[4]!;
        e.stun += +m[5]!;
        e.idle += +m[6]!;
        e.standStill += standStill;
        if (maxStandStill > e.maxStandStill) e.maxStandStill = maxStandStill;
        for (const [why, n] of Object.entries(reasons)) e.idleBy[why] = (e.idleBy[why] ?? 0) + n;
        return e;
      };
      agg.set(key, add(agg.get(key) ?? emptyWaste()));
      const fam = byRelease.get(key) ?? new Map<string, Waste>();
      fam.set(release, add(fam.get(release) ?? emptyWaste(release)));
      byRelease.set(key, fam);
      newest.set(key, release);

      const acct = byAccount.get(botName) ?? { runs: 0, ticks: 0, idle: 0, standStill: 0, move: 0, maxStandStill: 0, idleBy: {}, families: new Set<string>() };
      acct.runs++;
      acct.ticks += +m[1]!;
      acct.idle += +m[6]!;
      acct.standStill += standStill;
      acct.move += +m[2]!;
      if (maxStandStill > acct.maxStandStill) acct.maxStandStill = maxStandStill;
      for (const [why, n] of Object.entries(reasons)) acct.idleBy[why] = (acct.idleBy[why] ?? 0) + n;
      if (key !== '?') acct.families.add(key);
      byAccount.set(botName, acct);
    }
  }
  return { agg, byRelease, newest, byAccount };
}

export function tickWaste(dir = '.practice/swarm-logs', opts: TickWasteOptions = {}): Map<string, Waste> {
  const { agg, byRelease, newest } = scanLogs(dir, opts);
  if (!opts.latest) return agg;
  return new Map([...byRelease].map(([key, fam]) => [key, fam.get(newest.get(key)!)!]));
}

export function tickWasteByAccount(dir = '.practice/swarm-logs', opts: TickWasteOptions = {}): Map<string, AccountWaste> {
  const { byAccount } = scanLogs(dir, opts);
  return new Map([...byAccount].map(([name, a]) => [name, {
    runs: a.runs, ticks: a.ticks, idle: a.idle, standStill: a.standStill, move: a.move,
    maxStandStill: a.maxStandStill, idleBy: a.idleBy, families: [...a.families].sort(),
  }]));
}

// Live standing-still / high-waste offenders from fresh status files (.practice/live/status/*.json).
export function liveTickOffenders(statusDir = '.practice/live/status', opts: { now?: number; maxAgeMs?: number } = {}): LiveTickOffender[] {
  if (!existsSync(statusDir)) return [];
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 30_000;
  const out: LiveTickOffender[] = [];
  for (const f of readdirSync(statusDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(join(statusDir, f), 'utf8'));
      if (!doc || typeof doc.name !== 'string' || doc.result || !Number.isFinite(doc.at) || now - doc.at > maxAgeMs) continue;
      const ts = doc.tickStats;
      if (ts && typeof ts === 'object' && Number.isFinite(ts.ticks)) {
        const topWhy = ts.currentStandStillWhy ?? (Array.isArray(ts.topIdleBy) && ts.topIdleBy[0] ? String(ts.topIdleBy[0][0]) : null);
        out.push({
          name: doc.name,
          script: typeof ts.script === 'string' ? ts.script : (typeof doc.goal === 'string' ? doc.goal : null),
          at: doc.at,
          ticks: ts.ticks,
          standStillPct: Number(ts.standStillPct) || 0,
          windowStandStillPct: Number(ts.windowStandStillPct) || 0,
          currentStandStill: Number(ts.currentStandStill) || 0,
          maxStandStill: Number(ts.maxStandStill) || 0,
          why: topWhy,
          pos: ts.currentStandStillAt ?? (doc.pos ? `${doc.pos.x},${doc.pos.z}` : null),
        });
        continue;
      }
      const tl = String(doc.timeline ?? '');
      if (!tl.length) continue;
      let idleCount = 0;
      for (let i = 0; i < tl.length; i++) if (tl[i] === 'i') idleCount++;
      const trailing = tl.match(/i+$/)?.[0].length ?? 0;
      const pct = Math.round((1000 * idleCount) / tl.length) / 10;
      out.push({
        name: doc.name,
        script: typeof doc.goal === 'string' ? doc.goal : null,
        at: doc.at,
        ticks: tl.length,
        standStillPct: pct,
        windowStandStillPct: pct,
        currentStandStill: trailing,
        maxStandStill: trailing,
        why: null,
        pos: doc.pos ? `${doc.pos.x},${doc.pos.z}` : null,
      });
    } catch { /* ignore unreadable/in-flight status write */ }
  }
  return out.sort((a, b) => b.currentStandStill - a.currentStandStill || b.windowStandStillPct - a.windowStandStillPct || a.name.localeCompare(b.name));
}

// Walks that went round a fare (packages/core/src/walk: WALK_DETOUR) and paid crossings that failed (WALK_FARE_FAIL),
// by account. `extra` sums the planner's extra ticks (cost - paidCost) and walkPath's extra path tiles
// (roundTiles - throughTiles); a tile costs about one tick on foot.
export type FareWaste = { detours: number; extra: number; fareFails: number };
export function fareWaste(dir = '.practice/swarm-logs'): Map<string, FareWaste> {
  const out = new Map<string, FareWaste>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const text = readFileSync(`${dir}/${f}`, 'latin1');
    if (!text.includes('WALK_DETOUR') && !text.includes('WALK_FARE_FAIL')) continue;
    const bot = f.replace(/^host-/, '').replace(/\.log(\.\d+)?$/, '');
    const e = out.get(bot) ?? { detours: 0, extra: 0, fareFails: 0 };
    for (const line of text.split(/\r?\n/)) {
      const body = workerLine(line);
      if (body.startsWith('WALK_FARE_FAIL ')) e.fareFails++;
      if (!body.startsWith('WALK_DETOUR ')) continue;
      e.detours++;
      try {
        const d = JSON.parse(body.slice('WALK_DETOUR '.length)) as { extra?: number; throughTiles?: number; roundTiles?: number };
        e.extra += Math.max(0, d.extra ?? ((d.roundTiles ?? 0) - (d.throughTiles ?? 0)));
      } catch { /* a cut line counts as a detour with no extra */ }
    }
    out.set(bot, e);
  }
  return out;
}

// Idle+move share per family with at least `minTicks` measured ticks.
export const wasteShare = (agg: Map<string, Waste>, minTicks = 2000): Record<string, number> =>
  Object.fromEntries([...agg].filter(([, e]) => e.ticks >= minTicks).map(([k, e]) => [k, (e.idle + e.move) / e.ticks]));

export function parseTickWasteArgs(argv: readonly string[]): { latest: boolean; sinceHours?: number; minTicks: number; byAccount: boolean } {
  let latest = false;
  let sinceHours: number | undefined;
  let minTicks = 2000;
  let byAccount = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--latest') { latest = true; continue; }
    if (a === '--by-account') { byAccount = true; continue; }
    if (a === '--since-hours') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) sinceHours = n;
      continue;
    }
    if (a.startsWith('--since-hours=')) {
      const n = Number(a.slice('--since-hours='.length));
      if (Number.isFinite(n) && n > 0) sinceHours = n;
      continue;
    }
    if (/^\d+$/.test(a)) minTicks = Number(a);
  }
  return { latest, ...(sinceHours !== undefined ? { sinceHours } : {}), minTicks, byAccount };
}

if (import.meta.main) {
  const { latest, sinceHours, minTicks, byAccount } = parseTickWasteArgs(process.argv.slice(2));
  const opts: TickWasteOptions = { latest, ...(sinceHours !== undefined ? { sinceHours } : {}) };
  const rows = [...tickWaste(undefined, opts)].filter(([, e]) => e.ticks >= minTicks).sort((a, b) => (b[1].standStill + b[1].move) - (a[1].standStill + a[1].move));
  if (latest) console.log('Each family counts only the runs on the release of its newest run (`unknown`: from before RELEASE lines).');
  if (sinceHours !== undefined) console.log(`Filtered to runs in the last ${sinceHours} h (falling back to file mtime when un-timestamped).`);
  console.log('script'.padEnd(26), 'runs', 'ticks'.padStart(8), 'stand%', 'idle%', 'move%', 'anim%', 'maxStrk', 'wasteTicks', ' idle reasons (share of the idle ticks that carry one)');
  for (const [k, e] of rows.slice(0, 30)) {
    const named = Object.values(e.idleBy).reduce((n, v) => n + v, 0);
    const why = named ? Object.entries(e.idleBy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, n]) => `${w} ${(100 * n / named).toFixed(0)}%`).join(', ') : '-';
    console.log(
      k.padEnd(26),
      String(e.runs).padStart(4),
      String(e.ticks).padStart(8),
      (100 * e.standStill / e.ticks).toFixed(0).padStart(6),
      (100 * e.idle / e.ticks).toFixed(0).padStart(5),
      (100 * e.move / e.ticks).toFixed(0).padStart(5),
      (100 * e.anim / e.ticks).toFixed(0).padStart(5),
      String(e.maxStandStill).padStart(7),
      String(e.idle + e.move).padStart(10),
      ' ' + why + (e.release ? `  [release ${e.release}]` : ''),
    );
  }
  const live = liveTickOffenders().filter(o => o.currentStandStill >= 10 || o.windowStandStillPct >= 30);
  if (live.length) {
    console.log('\ntop live standing-still / high-waste offenders (.practice/live/status)');
    console.log('account'.padEnd(18), 'script'.padEnd(24), 'nowStrk', 'winStand%', 'maxStrk', 'why', 'pos');
    for (const o of live.slice(0, 15)) {
      console.log(
        o.name.padEnd(18),
        (o.script ?? '?').slice(0, 24).padEnd(24),
        String(o.currentStandStill).padStart(7),
        o.windowStandStillPct.toFixed(0).padStart(9),
        String(o.maxStandStill).padStart(7),
        (o.why ?? '-').padEnd(18),
        o.pos ?? '-',
      );
    }
  }
  if (byAccount || rows.length > 0) {
    const accts = [...tickWasteByAccount(undefined, opts)]
      .filter(([, a]) => a.ticks >= Math.min(minTicks, 500))
      .sort((a, b) => b[1].standStill - a[1].standStill);
    if (accts.length) {
      console.log('\nper-account standing-still breakdown');
      console.log('account'.padEnd(18), 'runs', 'ticks'.padStart(8), 'stand%', 'idle%', 'maxStrk', 'families');
      for (const [name, a] of accts.slice(0, byAccount ? 40 : 15)) {
        console.log(
          name.padEnd(18),
          String(a.runs).padStart(4),
          String(a.ticks).padStart(8),
          (100 * a.standStill / a.ticks).toFixed(0).padStart(6),
          (100 * a.idle / a.ticks).toFixed(0).padStart(5),
          String(a.maxStandStill).padStart(7),
          a.families.slice(0, 3).join(', ') || '-',
        );
      }
    }
  }
  const fares = [...fareWaste()].sort((a, b) => b[1].extra - a[1].extra);
  if (fares.length) {
    console.log('\nfare detours (WALK_DETOUR, WALK_FARE_FAIL)');
    console.log('account'.padEnd(26), 'detours', 'extraTicks', 'fareFails');
    for (const [bot, e] of fares.slice(0, 20)) console.log(bot.padEnd(26), String(e.detours).padStart(7), String(e.extra).padStart(10), String(e.fareFails).padStart(9));
  }
}
