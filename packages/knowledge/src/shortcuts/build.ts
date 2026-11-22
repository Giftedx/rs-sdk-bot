import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs } from '../config';
import { buildDbTables } from '../dbtables';
import { parseJm2, type LocSpawn } from '../jm2';
import { parsePack } from '../pack';
import { contentRoot, knowledgeDir } from '../paths';
import { kindOf, mapAssumptions, minimize, rollFailed } from './assumptions';
import { runAll } from './interpreter';
import { parseScripts, stripComments } from './parser';
import { MAX_CAPPED, MAX_RUNS, MOVE_TEXT, OPS, skipBuildFile } from './tables';
import {
    Unsupported,
    type BuildInput, type BuildOutput, type Coord, type Ctx, type Placement, type RunResult,
    type Script, type ShortcutEdge, type ShortcutGap,
} from './types';

export function movingScripts(scripts: Map<string, Script>): Set<string> {
    const moving = new Set<string>();
    const text = new Map([...scripts].map(([k, s]) => [k, s.body.map(b => b.text).join('\n')]));
    for (const [k, t] of text) if (MOVE_TEXT.test(t)) moving.add(k);
    for (let changed = true; changed;) {
        changed = false;
        for (const [k, t] of text) {
            if (moving.has(k)) continue;
            const calls = [...t.matchAll(/~(\w+)/g)].map(m => `proc,${m[1]}`)
                .concat([...t.matchAll(/@(\w+)/g)].map(m => `label,${m[1]}`), [...t.matchAll(/\b(?:weak|strong|long)?queue\((\w+)/g)].map(m => `queue,${m[1]}`));
            if (calls.some(c => moving.has(c))) { moving.add(k); changed = true; }
        }
    }
    return moving;
}

export function buildShortcuts(inp: BuildInput): BuildOutput {
    const scripts = parseScripts(inp.scriptFiles);
    const constants = new Map<string, { value: string; src: string }>();
    for (const { text, file } of inp.constantFiles) stripComments(text).forEach((l, i) => {
        const m = l.match(/^\^(\w+)\s*=\s*(.+)$/);
        if (m && !constants.has(m[1]!)) constants.set(m[1]!, { value: m[2]!.trim(), src: `${file}:${i + 1}` });
    });
    const ctx: Ctx = { scripts, constants, locConfigs: inp.locConfigs, paramTypes: new Map(), questVarps: inp.questVarps, moving: movingScripts(scripts), ast: new Map(), db: new Map(inp.dbTables.map(t => [t.table, t.rows])) };
    const ids = new Map([...inp.locPack].map(([id, n]) => [n, id]));
    const placements = new Map<string, Placement[]>();
    for (const l of inp.locs) {
        const n = inp.locPack.get(l.id);
        if (n) { let a = placements.get(n); if (!a) placements.set(n, a = []); a.push({ locName: n, id: l.id, x: l.x, z: l.z, level: l.level, shape: l.shape, angle: l.angle, src: l.src }); }
    }

    // Trigger for one loc and option: its own [oplocN,name], else its category's [oplocN,_category].
    const triggerFor = (loc: string, op: string) => scripts.get(`${op},${loc}`) ?? (() => { const c = inp.locConfigs.get(loc)?.props.category?.[0]; return c ? scripts.get(`${op},_${c}`) : undefined; })();

    const targets = new Map<Script, string[]>();
    const changeTargets = (t: Script) => { let v = targets.get(t); if (!v) { v = [...t.body.map(b => b.text).join('\n').matchAll(/\bloc_change\s*\(\s*(\w+)/g)].map(m => m[1]!); targets.set(t, v); } return v; };
    const edges: ShortcutEdge[] = [], gaps: ShortcutGap[] = [];
    const handlers = new Set<string>();
    const capped = new Map<string, number>();
    const queue: Placement[] = [...[...placements.values()].flat()];
    const seen = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
        const p = queue[qi++]!;
        const pk = `${p.locName},${p.x},${p.z},${p.level}`;
        if (seen.has(pk)) continue; seen.add(pk);
        if (inp.excludeLocNames.has(p.locName)) continue;
        for (const op of OPS) {
            const trig = triggerFor(p.locName, op);
            if (!trig || skipBuildFile(trig.file)) continue;
            const key = `${trig.type},${trig.name}`;
            const handler = `${trig.file}:${trig.line}`;
            const option = op === 'oplocu' ? 'opu' : `op${op.slice(5)}`;
            const optionText = op === 'oplocu' ? 'Use' : inp.locConfigs.get(p.locName)?.props[option]?.[0] ?? null;
            const moving = ctx.moving.has(key);
            const changes = changeTargets(trig).some(n => OPS.some(o => { const t = triggerFor(n, o); return !!t && !skipBuildFile(t.file) && ctx.moving.has(`${t.type},${t.name}`); }));
            if (!moving && !changes) continue;
            let out: ReturnType<typeof runAll>;
            const t0 = performance.now(); if (process.env.SHORTCUTS_TRACE) console.error(`run ${handler} ${pk}`);
            if ((capped.get(handler) ?? 0) >= MAX_CAPPED) { if (moving) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: `not run: this handler passed ${MAX_RUNS} condition branches on ${MAX_CAPPED} other placements` }); continue; }
            try { out = runAll(ctx, trig, p); }
            catch (err) { if (err instanceof Unsupported) { if (moving) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: err.message }); continue; } throw err; }
            if (out.gap?.startsWith('more than')) capped.set(handler, (capped.get(handler) ?? 0) + 1);
            // A loc_change in a run that does not move adds the new loc at this tile; its own triggers run later.
            for (const r of out.results) if (!r.st.moved) for (const c of r.st.changes) {
                const id = ids.get(c.locName);
                if (id !== undefined && !inp.excludeLocNames.has(c.locName)) queue.push({ ...p, locName: c.locName, id, via: { locName: p.via?.locName ?? p.locName, option, src: c.line } });
            }
            const ms = performance.now() - t0;
            if (process.env.SHORTCUTS_DEBUG && ms > 200) console.error(`slow ${Math.round(ms)}ms ${handler} ${pk} runs=${out.results.length}`);
            if (!moving) continue;
            handlers.add(handler);
            const movedRuns = out.results.filter(r => r.st.moved);
            // One gap record per placement and handler; it lists each distinct reason once.
            const why = new Set<string>();
            if (out.gap) why.add(out.gap);
            for (const r of movedRuns) if (!r.st.pos) why.add(r.st.posWhy ?? 'destination not resolved');
            if (why.size) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: [...why].slice(0, 4).join(' | ') + (why.size > 4 ? ` | +${why.size - 4} more` : '') });
            // A run that assumes an obstacle timer is still running (`%x_used >= map_clock`) is the "being used" refusal.
            const busy = (r: RunResult) => r.assumptions.some(a => a.value === 'T' && /^[^@]*(>=?) map_clock/.test(a.key));
            const done = movedRuns.filter(r => !busy(r) && r.st.pos && !(r.st.pos.c.x === p.x && r.st.pos.c.z === p.z && r.st.pos.c.level === p.level));
            const merged = new Map<string, ShortcutEdge>();
            const outcome = (r: RunResult) => JSON.stringify([r.st.pos, r.st.fee, r.st.consumes]);
            const isFail = (r: RunResult) => r.assumptions.some(rollFailed);
            const success = minimize(done.filter(r => !isFail(r)), outcome);
            const fails = done.filter(isFail);
            for (const r of success) {
                const b = mapAssumptions(r.assumptions);
                // The failure run that matches this run on every other assumption.
                const keys = new Map(r.assumptions.map(a => [a.key, a.value]));
                const fail = fails.find(f => f.assumptions.every(a => rollFailed(a) || !keys.has(a.key) || keys.get(a.key) === a.value));
                const fa = fail?.assumptions.find(rollFailed);
                const req = b.requires;
                const pos = r.st.pos!;
                const e: ShortcutEdge = {
                    kind: kindOf(trig.file, req, fa?.sym.meta?.stat),
                    locName: p.locName, id: p.id, option, optionText,
                    from: { x: p.x, z: p.z, level: p.level }, to: pos.c, exact: pos.exact,
                    ...(Object.keys(req).length ? { requires: req } : {}),
                    ...(r.st.fee ? { fee: r.st.fee } : {}),
                    ...(r.st.consumes.length ? { consumes: r.st.consumes } : {}),
                    ...(b.side.length ? { side: b.side } : {}),
                    ...(b.choices.length ? { choices: b.choices } : {}),
                    ...(b.conditions.length ? { conditions: b.conditions } : {}),
                    ...(fa && fail ? { failure: { stat: fa.sym.meta!.stat!, low: fa.sym.meta!.low!, high: fa.sym.meta!.high!, src: `${fa.file}:${fa.line}`, to: fail.st.pos?.c ?? null, exact: !!fail.st.pos?.exact, damage: fail.st.damage } } : {}),
                    ...(p.via ? { via: p.via } : {}),
                    twoWay: false,
                    src: p.src, toSrc: r.st.moveSrc!, handler,
                    ...(b.requireSrc.length ? { requireSrc: b.requireSrc } : {}),
                };
                // Runs with the same arrival and needs merge; a world condition is kept only when every merged run assumes it.
                const k = JSON.stringify([e.to, e.exact, e.requires, e.side, e.choices, e.fee, e.consumes]);
                const old = merged.get(k);
                if (!old) { merged.set(k, e); continue; }
                const common = (old.conditions ?? []).filter(c => e.conditions?.includes(c));
                if (common.length) old.conditions = common; else delete old.conditions;
                if (!old.failure && e.failure) old.failure = e.failure;
            }
            edges.push(...merged.values());
        }
    }
    const near = (a: Coord, b: Coord) => a.level === b.level && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 3;
    for (const e of edges) e.twoWay = edges.some(o => o !== e && near(o.from, e.to) && near(o.to, e.from));
    edges.sort((a, b) => a.kind.localeCompare(b.kind) || a.locName.localeCompare(b.locName) || a.from.x - b.from.x || a.from.z - b.from.z || a.from.level - b.from.level || a.to.x - b.to.x || a.to.z - b.to.z);
    return { edges, gaps, handlers: handlers.size };
}

export function loadInput(): BuildInput {
    const root = contentRoot();
    const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
    const locs: LocSpawn[] = [];
    for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) locs.push(...parseJm2(f, read(`maps/${f}`)).locs);
    const kd = knowledgeDir();
    const json = <T>(f: string): T => JSON.parse(readFileSync(join(kd, f), 'utf8')) as T;
    const exclude = new Set<string>([
        ...json<{ locName: string }[]>('transports.json').map(t => t.locName),
        ...json<{ loc: string }[]>('doors.json').map(d => d.loc),
    ]);
    return {
        scriptFiles: listConfigFiles('.rs2').map(f => ({ text: read(f), file: f })),
        constantFiles: listConfigFiles('.constant').map(f => ({ text: read(f), file: f })),
        locConfigs: new Map(listConfigFiles('.loc').flatMap(f => parseConfigs(read(f), f)).map(b => [b.name, b])),
        locPack: parsePack(read('pack/loc.pack')),
        locs,
        questVarps: new Set(json<{ varp: string }[]>('quests.json').map(q => q.varp)),
        excludeLocNames: exclude,
        dbTables: buildDbTables(listConfigFiles('.dbtable').flatMap(f => parseConfigs(read(f), f)), listConfigFiles('.dbrow').flatMap(f => parseConfigs(read(f), f))),
    };
}

export function runShortcutsCli(): void {
    const out = buildShortcuts(loadInput());
    const counts: Record<string, number> = {};
    for (const e of out.edges) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const file = join(knowledgeDir(), 'shortcuts.json');
    writeFileSync(file, JSON.stringify({
        note: 'Generated by packages/knowledge/src/shortcuts.ts. Player start is the loc tile until a script line sets it; exact=false marks player-relative arrival. map_members is taken as true. requires.varps/items/worn/useItem/coins are not checked by transportAllowed.',
        counts: { edges: out.edges.length, gaps: out.gaps.length, handlers: out.handlers, byKind: counts },
        edges: out.edges, gaps: out.gaps,
    }, null, 1) + '\n');
    console.log(`wrote ${file}${existsSync(file) ? '' : ' (missing)'}`);
    console.log(`edges ${out.edges.length}, gaps ${out.gaps.length}, handlers ${out.handlers}`);
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
}
