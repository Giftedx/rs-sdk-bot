// Watcher of a gang squad run (scripts/pk-squad.ts): it reads the squad's log and the accounts' status files, logs in
// nothing and starts no process. While all is well it prints one summary line every few minutes. It exits with one
// line that names the event when a person must look:
//   death              an account died (a "SQUAD died" or "PK died" line, a RESULT with died=1 or more, or an account
//                      that stands at the Lumbridge spawn after it stood in the Wilderness)
//   in-danger          an account in the Wilderness at LOW_HP or less with no food and no escape teleport
//   fail-result        a RESULT fail line
//   logout-unconfirmed a LOGOUT line with a word that is not "logged-out"
//   bank-trip          a bank trip that ended with a fault (the bank lacks a piece of the pack), or no trips left
//   kit-missing        an account walked into the Wilderness with no body armour, no leg armour, no weapon or no food
//   session-dropped    an account's session ended with no logout of ours
//   no-kill            no kill line in NO_KILL_MINUTES
//   process-gone       the process PID ended, or the log and every status file are quiet for QUIET_MINUTES
//   supervisor-end     the swarm's supervisor ended the job with a reason that is not "done"
//   ended              the run ended with RESULT ok and no death (exit code 0; every other event exits 1)
// Usage: bun scripts/squad-watch.ts <log file> <account> [<account> ...] [KEY=value ...]
//   STATUS=.practice/status  NO_KILL_MINUTES=20  QUIET_MINUTES=4  SUMMARY_MINUTES=5  LOW_HP=30  POLL_SECONDS=5
//   PID=<process id of the squad or its supervisor>  FROM=end (default: only lines written after the start) | start
//   REPEAT=1 (a repeating swarm job: a RESULT ok with no death does not end the watch)
// The swarm writes the log of an orchestrate job to .practice/swarm-logs/<first account>.log.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FOOD_ORDER, ITEMS, wildernessLevel } from './pk';
import { squadEscapeSpell } from './pk-squad';

export type WatchEvent = { kind: string; account: string; detail: string };
export type Config = { noKillMs: number; quietMs: number; lowHp: number; repeat: boolean };
export type StatusView = { name: string; at: number; hp: number; maxHp: number; x: number; z: number; magic: number;
    inventory: { id: number; name: string; count: number }[]; equipment: { id: number; name: string; count: number; slot: number }[] };
export type Watch = { startedAt: number; kills: number; deaths: number; trips: number; fallbacks: number; hpLost: number; lastKillAt: number; lastLineAt: number;
    seen: Map<string, { hp: number; wild: number }>; killsBy: Map<string, number> };
export const newWatch = (now: number): Watch => ({ startedAt: now, kills: 0, deaths: 0, trips: 0, fallbacks: 0, hpLost: 0, lastKillAt: now, lastLineAt: now, seen: new Map(), killsBy: new Map() });

const edible = (name: string) => FOOD_ORDER.some(re => re.test(name));
const antipoisons = ITEMS.antipoison as readonly number[];
// An account that died stands near the Lumbridge spawn (scripts/pk-squad.ts hold uses the same box).
const atSpawn = (s: { x: number; z: number }) => Math.max(Math.abs(s.x - 3222), Math.abs(s.z - 3218)) <= 40;

// One log line. Returns the event that ends the watch, or null. Counts kills and fallbacks on the way.
export function readLine(w: Watch, line: string, now: number, cfg: Pick<Config, 'repeat'>): WatchEvent | null {
    w.lastLineAt = now;
    const tag = line.match(/^\[([A-Za-z0-9_ -]{1,12})\] (.*)$/), account = tag?.[1] ?? '-', text = tag?.[2] ?? line;
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^PK kill (\S+)/))) { w.kills++; w.lastKillAt = now; w.killsBy.set(m[1]!, (w.killsBy.get(m[1]!) ?? 0) + 1); return null; }
    if (/^SQUAD coordinated fallback/.test(text)) { w.fallbacks++; return null; }
    if (/^SQUAD died\b/.test(text) || /^PK died to /.test(text)) { w.deaths++; return { kind: 'death', account, detail: text }; }
    if ((m = text.match(/^SQUAD bank trip: (.*)$/))) return { kind: 'bank-trip', account, detail: m[1]! };
    if (/^SQUAD no trips left/.test(text)) return { kind: 'bank-trip', account, detail: 'no trips left' };
    if ((m = text.match(/^SQUAD session ended: (.*)$/))) return { kind: 'session-dropped', account, detail: m[1]! };
    if ((m = line.match(/^LOGOUT (.*)$/)) && m[1]!.trim().split(/\s+/).some(word => word !== 'logged-out')) return { kind: 'logout-unconfirmed', account: '-', detail: m[1]!.trim() };
    if ((m = line.match(/^RESULT fail (.*)$/))) return { kind: 'fail-result', account: '-', detail: m[1]! };
    if ((m = line.match(/^RESULT ok (.*)$/))) {
        const died = Number(m[1]!.match(/\bdied=(\d+)/)?.[1] ?? 0);
        if (died > 0) { w.deaths = Math.max(w.deaths, died); return { kind: 'death', account: '-', detail: m[1]! }; }
        return cfg.repeat ? null : { kind: 'ended', account: '-', detail: m[1]! };
    }
    if ((m = line.match(/^SUPERVISE end (\S+)(.*)$/)) && m[1] !== 'done') return { kind: 'supervisor-end', account: '-', detail: `${m[1]}${m[2]}` };
    return null;
}

// One read of the status files. Returns the event that ends the watch, or null. Counts trips and the HP lost between
// two reads (a sample: damage that an account ate back between two reads is not seen).
export function readStatuses(w: Watch, statuses: readonly StatusView[], now: number, cfg: Config): WatchEvent | null {
    let event: WatchEvent | null = null;
    for (const s of statuses) {
        const wild = wildernessLevel(s.z), before = w.seen.get(s.name);
        if (before) {
            if (s.hp < before.hp) w.hpLost += before.hp - s.hp;
            if (before.wild > 0 && wild === 0 && !atSpawn(s)) w.trips++;
            if (before.wild > 0 && atSpawn(s)) { w.deaths++; event ??= { kind: 'death', account: s.name, detail: `stands at ${s.x},${s.z} after Wilderness level ${before.wild}` }; }
            if (before.wild === 0 && wild > 0) {
                const worn = (slot: number) => s.equipment.some(e => e.slot === slot);
                const lacks = [worn(4) ? null : 'body armour', worn(7) ? null : 'leg armour', worn(3) ? null : 'weapon', s.inventory.some(i => edible(i.name)) ? null : 'food'].filter((x): x is string => !!x);
                if (lacks.length) event ??= { kind: 'kit-missing', account: s.name, detail: `walked into the Wilderness with no ${lacks.join(', no ')}` };
            }
        }
        w.seen.set(s.name, { hp: s.hp, wild });
        if (wild > 0 && s.hp <= cfg.lowHp && !s.inventory.some(i => edible(i.name))
            && squadEscapeSpell(s.z, s.inventory, s.equipment.map(e => e.id), s.magic) === null && ![...s.inventory, ...s.equipment].some(i => /^amulet of glory\([1-4]\)$/i.test(i.name)))
            event ??= { kind: 'in-danger', account: s.name, detail: `HP ${s.hp} at Wilderness level ${wild} with no food and no escape teleport` };
    }
    if (!event && now - Math.max(w.lastKillAt, w.startedAt) > cfg.noKillMs) event = { kind: 'no-kill', account: '-', detail: `no kill for ${Math.round((now - Math.max(w.lastKillAt, w.startedAt)) / 60_000)} minutes` };
    const newest = Math.max(w.lastLineAt, ...statuses.map(s => s.at));
    if (!event && now - newest > cfg.quietMs) event = { kind: 'process-gone', account: '-', detail: `no log line and no status write for ${Math.round((now - newest) / 60_000)} minutes` };
    return event;
}

// The supplies each account has left in its pack and quiver, as "name:sharks/arrows/law/antipoison".
export function supplies(statuses: readonly StatusView[]): string {
    return statuses.map(s => {
        const count = (test: (i: { id: number; name: string }) => boolean) => s.inventory.filter(test).reduce((n, i) => n + i.count, 0);
        return `${s.name}:${count(i => edible(i.name))}/${s.equipment.find(e => e.slot === 13)?.count ?? 0}/${count(i => i.id === 563)}/${count(i => antipoisons.includes(i.id))}`;
    }).join(' ');
}
export function summary(w: Watch, statuses: readonly StatusView[], now: number): string {
    const minutes = Math.max(1, Math.round((now - w.startedAt) / 60_000));
    return `SQUAD_WATCH ok minutes=${minutes} kills=${w.kills} (${[...w.killsBy].map(([n, k]) => `${n} ${k}`).join(', ') || 'none'}) deaths=${w.deaths} hpLostSampled=${w.hpLost} hpPerKill=${w.kills ? Math.round(w.hpLost / w.kills) : '-'}`
        + ` trips=${w.trips} fallbacks=${w.fallbacks} hp=${statuses.map(s => `${s.name}:${s.hp}`).join(' ') || '-'} food/arrows/law/antipoison=${supplies(statuses) || '-'}`;
}
export const eventLine = (w: Watch, e: WatchEvent) => `SQUAD_WATCH event=${e.kind} account=${e.account} detail=${JSON.stringify(e.detail)} kills=${w.kills} deaths=${w.deaths} trips=${w.trips}`;

// A status file (packages/core/src/status.ts) as the watcher's view, or null for a file that is not there yet.
export function statusView(raw: any): StatusView | null {
    if (!raw || typeof raw.name !== 'string' || !raw.pos || !raw.hp) return null;
    const rows = (list: any) => (Array.isArray(list) ? list : []).filter((i: any) => Number.isSafeInteger(i?.id) && typeof i.name === 'string');
    return { name: raw.name, at: Number(raw.at) || 0, hp: Number(raw.hp.now) || 0, maxHp: Number(raw.hp.max) || 0, x: raw.pos.x, z: raw.pos.z,
        magic: (Array.isArray(raw.skills) ? raw.skills : []).find((k: any) => k?.name === 'Magic')?.level ?? 1,
        inventory: rows(raw.inventory).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count })), equipment: rows(raw.equipment).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count, slot: i.slot })) };
}

// The lines that a log file gained since `offset`, with the new offset. A last line with no line end waits.
export function tail(file: string, offset: number): { lines: string[]; offset: number } {
    if (!existsSync(file)) return { lines: [], offset };
    const fd = openSync(file, 'r');
    try {
        const size = fstatSync(fd).size, from = size < offset ? 0 : offset;
        if (size === from) return { lines: [], offset: from };
        const buffer = Buffer.alloc(Math.min(size - from, 4 * 1024 * 1024));
        const read = readSync(fd, buffer, 0, buffer.length, from), text = buffer.subarray(0, read).toString('utf8'), end = text.lastIndexOf('\n');
        if (end < 0) return { lines: [], offset: from };
        return { lines: text.slice(0, end).split(/\r?\n/).filter(Boolean), offset: from + Buffer.byteLength(text.slice(0, end + 1)) };
    } finally { closeSync(fd); }
}

if (import.meta.main) {
    const args = process.argv.slice(2), kv = Object.fromEntries(args.filter(a => /^[A-Z_]+=/.test(a)).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
    const [log, ...accounts] = args.filter(a => !/^[A-Z_]+=/.test(a));
    const get = (k: string, d: string) => kv[k] ?? process.env[k] ?? d;
    if (!log || !accounts.length) { console.log('SQUAD_WATCH event=usage account=- detail="bun scripts/squad-watch.ts <log file> <account> [<account> ...] [KEY=value ...]"'); process.exit(2); }
    const cfg: Config = { noKillMs: Number(get('NO_KILL_MINUTES', '20')) * 60_000, quietMs: Number(get('QUIET_MINUTES', '4')) * 60_000, lowHp: Number(get('LOW_HP', '30')), repeat: get('REPEAT', '0') === '1' };
    const statusDir = get('STATUS', join('.practice', 'status')), pid = Number(get('PID', '0')), summaryMs = Number(get('SUMMARY_MINUTES', '5')) * 60_000, pollMs = Number(get('POLL_SECONDS', '5')) * 1000;
    const alive = (id: number) => { try { process.kill(id, 0); return true; } catch { return false; } };
    const statuses = () => accounts.flatMap(name => { try { const view = statusView(JSON.parse(readFileSync(join(statusDir, `${name}.json`), 'utf8'))); return view ? [view] : []; } catch { return []; } });
    const w = newWatch(Date.now());
    let offset = get('FROM', 'end') === 'start' || !existsSync(log) ? 0 : statSync(log).size, lastSummary = Date.now();
    const end = (e: WatchEvent): never => { console.log(summary(w, statuses(), Date.now())); console.log(eventLine(w, e)); process.exit(e.kind === 'ended' ? 0 : 1); };
    console.log(`SQUAD_WATCH start log=${log} accounts=${accounts.join(',')} from=${offset}${pid ? ` pid=${pid}` : ''}`);
    for (;;) {
        const now = Date.now(), next = tail(log, offset);
        offset = next.offset;
        for (const line of next.lines) { const e = readLine(w, line, now, cfg); if (e) end(e); }
        const views = statuses(), event = readStatuses(w, views, now, cfg);
        if (event) end(event);
        if (pid && !alive(pid)) {
            // The last lines of an ended process are read before the watch names it gone.
            for (const line of tail(log, offset).lines) { const e = readLine(w, line, now, cfg); if (e) end(e); }
            end({ kind: 'process-gone', account: '-', detail: `process ${pid} ended with no RESULT line` });
        }
        if (now - lastSummary >= summaryMs) { console.log(summary(w, views, now)); lastSummary = now; }
        await Bun.sleep(pollMs);
    }
}
