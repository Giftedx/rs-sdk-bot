// Death recap (RuneLite's Death Indicator, with the hits before it): the newest death in an account's tick records
// (packages/core/src/tick-record.ts, .practice/ticks/<script>/<account>-<startedAt>.ticks.ndjson.gz). The record of a
// running session has no gzip trailer yet: a sync flush reads what it holds. A death is a publication with
// player.isDead true after one without; the recap is of the last death in the record. The recap holds the tile, the hits taken in the 30 ticks before it with their
// source, the hitpoints of the last 20 publications, the last actions, what the account carried before it and what it
// still held after the respawn.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';

export type Item = { name: string; count: number };
export type DeathRecap = {
    account: string; script: string; file: string; tick: number; at: number | null;
    pos: { x: number; z: number; level: number } | null;
    killer: string | null;
    hits: { tick: number; damage: number; source: string }[];
    hp: [number, number][];
    actions: { tick: number; type: string }[];
    carried: Item[]; kept: Item[] | null; lost: Item[] | null;
};

const MAX_FILE_BYTES = 40 * 2 ** 20;
const items = (state: any): Item[] => {
    const out = new Map<string, number>();
    for (const list of [state?.inventory, state?.equipment]) for (const i of Array.isArray(list) ? list : []) if (i?.name && i.count > 0) out.set(i.name, (out.get(i.name) ?? 0) + i.count);
    return [...out].map(([name, count]) => ({ name, count }));
};
const minus = (a: Item[], b: Item[]): Item[] => {
    const left = new Map(b.map(i => [i.name, i.count]));
    return a.flatMap(i => { const n = i.count - (left.get(i.name) ?? 0); return n > 0 ? [{ name: i.name, count: n }] : []; });
};

// The source of a hit: the npc or player that the account faced when the hit came (the client's StateCollector
// names it by index), found among the npcs and players it saw. Index -1: the account faced no one.
function sourceName(event: any, state: any): string {
    if (!(event.sourceIndex >= 0)) return 'attacker not seen';
    const list = event.sourceType === 'npc' ? state?.nearbyNpcs : state?.nearbyPlayers;
    const who = Array.isArray(list) ? list.find((e: any) => e?.index === event.sourceIndex) : null;
    if (who?.name) return `${who.name}${Number.isFinite(who.combatLevel) ? ` (level ${who.combatLevel})` : ''}`;
    return event.sourceType === 'npc' ? `npc ${event.sourceIndex}` : `player ${event.sourceIndex}`;
}

// tickMs: the server's tick length, which dates the death from the session start; null (a practice server, whose
// lockstep ticks have no fixed length) leaves the time unknown.
export function recapFromLines(lines: string[], file = '', script = '', tickMs: number | null = null): DeathRecap | null {
    const state: Record<string, any> = {};
    const history: { tick: number; hp: number | null }[] = [];
    const actions: { tick: number; type: string }[] = [];
    let meta: any = null, firstTick: number | null = null, wasDead = false, found: DeathRecap | null = null, last: DeathRecap | null = null, before: Record<string, any> | null = null;
    for (const line of lines) {
        if (!line) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.k === 'meta') { meta = row; continue; }
        if (row.k === 'a') { actions.push({ tick: row.t, type: String(row.a?.type ?? 'action') }); if (actions.length > 40) actions.shift(); continue; }
        if (row.k !== 's' && row.k !== 'p') continue;
        for (const [key, value] of Object.entries(row.d ?? {})) state[key] = value;
        for (const key of row.x ?? []) delete state[key];
        firstTick ??= row.t;
        const dead = state.player?.isDead === true;
        if (found && !dead) {
            // The first publication alive again after the death: what the account still holds.
            found.kept = items(state); found.lost = minus(found.carried, found.kept); found = null;
        }
        if (dead && !wasDead && before) {
            const p = state.player, events = (Array.isArray(state.combatEvents) ? state.combatEvents : []).filter((e: any) => e?.type === 'damage_taken' && e.targetType === 'player' && e.tick >= row.t - 30 && e.tick <= row.t);
            // A hit of another player on an npc is damage_taken too: only a hit on the player counts (prayer-guard.ts).
            const hits = events.slice(-10).map((e: any) => ({ tick: e.tick, damage: e.damage, source: sourceName(e, state) }));
            found = last = {
                account: String(meta?.account ?? p?.name ?? ''), script: String(meta?.script ?? script), file, tick: row.t,
                at: Number.isFinite(meta?.startedAt) && firstTick != null && tickMs != null && tickMs > 0 ? meta.startedAt + (row.t - firstTick) * tickMs : null,
                pos: Number.isFinite(p?.worldX) ? { x: p.worldX, z: p.worldZ, level: p.level ?? 0 } : null,
                killer: hits.at(-1)?.source ?? null, hits,
                hp: [...history.slice(-19).map(h => [h.tick, h.hp] as [number, number]), [row.t, p?.hp ?? 0]],
                actions: actions.filter(a => a.tick >= row.t - 20 && a.tick <= row.t).slice(-12),
                carried: items(before), kept: null, lost: null,
            };
        }
        wasDead = dead;
        if (!dead) before = { ...state };
        history.push({ tick: row.t, hp: state.player?.hp ?? null });
        if (history.length > 40) history.shift();
    }
    return last;
}

// The newest death of an account over its newest records, at most `files` of them. Practice and live records alike.
export function deathRecap(root: string, account: string, files = 8, tickMsOf: (server: string) => number | null = () => null): DeathRecap | null {
    const dir = join(root, '.practice', 'ticks'), prefix = account.toLowerCase() + '-', found: { file: string; script: string; started: number }[] = [];
    let scripts: string[] = [];
    try { scripts = readdirSync(dir); } catch { return null; }
    for (const script of scripts) {
        let names: string[] = [];
        try { names = readdirSync(join(dir, script)); } catch { continue; }
        for (const name of names) if (name.startsWith(prefix) && name.endsWith('.ticks.ndjson.gz')) {
            const started = Number(name.slice(prefix.length, -'.ticks.ndjson.gz'.length));
            if (Number.isFinite(started)) found.push({ file: join(dir, script, name), script, started });
        }
    }
    found.sort((a, b) => b.started - a.started);
    let newest: DeathRecap | null = null;
    for (const f of found.slice(0, files)) {
        try {
            if (statSync(f.file).size > MAX_FILE_BYTES) continue;
            const text = gunzipSync(readFileSync(f.file), { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
            const lines = text.split('\n'), server = (() => { try { return String(JSON.parse(lines[0] ?? '{}').server ?? ''); } catch { return ''; } })();
            const r = recapFromLines(lines, f.file, f.script, tickMsOf(server));
            // The last death in the newest record that has one.
            if (r) { newest = r; break; }
        } catch { /* a damaged record */ }
    }
    return newest;
}
