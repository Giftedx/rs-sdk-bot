// The drift check of the dagger gang: new observations against the behaviour record (scripts/pk-gang-record/*.json).
// A gang account whose behaviour moved away from its record gets a DRIFT line, so the record, the clones and the squad
// options are built again from data (research/gang-clones.md, "Keep it true").
//   bun scripts/measure/pk-gang-drift.ts feed [--data <checkout root>] <trace.jsonl> [...]
//     builds the measures of the new traces (files of scripts/measure/pk-gang-collect.ts) and compares each with the record
//   bun scripts/measure/pk-gang-drift.ts squad <kills> <Hitpoints lost> <ticks> <bench output> [...]
//     compares one live squad run with the clone's prediction: the mean of the `kills=` RESULT lines of the bench outputs
// Exit 1 when a DRIFT line is printed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addTrace, GANG, newRecord, targetFile } from './pk-gang-record';

type Hist = Record<string, number>;
const total = (h: Hist) => Object.values(h ?? {}).reduce((a, b) => a + b, 0);
const share = (h: Hist, key: string) => (total(h) ? (100 * (h[key] ?? 0)) / total(h) : 0);
const top = (h: Hist) => Math.max(0, ...Object.keys(h ?? {}).filter(k => Number.isFinite(Number(k))).map(Number));
export type Check = { measure: string; record: number | string; now: number | string; n: number; drift: boolean; why?: string };

// The checks of one gang account: `rec` is its committed data file and `now` the same file built from the new traces.
// A share is compared only with `minN` samples or more in the new traces, and drifts at `points` percentage points.
export function driftChecks(rec: any, now: any, minN = 20, points = 15): Check[] {
    const out: Check[] = [];
    const num = (measure: string, a: number, b: number, n: number, limit: number, need = minN) => out.push({ measure, record: Math.round(10 * a) / 10, now: Math.round(10 * b) / 10, n, drift: n >= need && Math.abs(a - b) > limit, ...(n < need ? { why: `under ${need} samples` } : {}) });
    // The kit: a worn set that the record does not hold.
    const worn = Object.keys(now.kit.worn.value ?? {}).filter(w => !(w in (rec.kit.worn.value ?? {})) && (now.kit.worn.value[w] ?? 0) >= 3);
    out.push({ measure: 'worn sets not in the record', record: Object.keys(rec.kit.worn.value ?? {}).length, now: worn.join(' | ') || 'none', n: total(now.kit.worn.value ?? {}), drift: worn.length > 0 });
    // The levels: a hiscore row that changed.
    const lv = (f: any) => f.levels.skills.value ?? {}, moved = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'].filter(s => lv(now)[s] !== undefined && lv(rec)[s] !== lv(now)[s]);
    out.push({ measure: 'combat levels that changed', record: 'the hiscore row', now: moved.map(s => `${s} ${lv(rec)[s]} -> ${lv(now)[s]}`).join(', ') || 'none', n: 1, drift: moved.length > 0 });
    // The attack: the share of 4-tick intervals, the share of specials, the highest splat.
    num('4-tick attack intervals in 100', share(rec.attack.ticksBetweenAttacks.value, '4'), share(now.attack.ticksBetweenAttacks.value, '4'), total(now.attack.ticksBetweenAttacks.value), points);
    const sp = (f: any) => f.attack.specials.value;
    num('specials in 100 attacks', sp(rec).attacks ? (100 * sp(rec).specials) / sp(rec).attacks : 0, sp(now).attacks ? (100 * sp(now).specials) / sp(now).attacks : 0, sp(now).attacks, 8, 50);
    const open = (f: any, kind: string) => top(f.attack.damage.value?.[`${kind} on a player without Protect from Melee`] ?? {});
    for (const kind of ['attack', 'special']) { const a = open(rec, kind), b = open(now, kind); out.push({ measure: `highest ${kind} splat with no Protect from Melee`, record: a, now: b, n: total(now.attack.damage.value?.[`${kind} on a player without Protect from Melee`] ?? {}), drift: b > a, ...(b > a ? { why: 'a higher hit: a potion or a new prayer' } : {}) }); }
    // Eating: an eat above the eat level of the record.
    const eat = (f: any) => top(f.eating.hpAtEat.value ?? {});
    out.push({ measure: 'highest Hitpoints at an eat', record: eat(rec), now: eat(now), n: now.eating.hpAtEat.n ?? 0, drift: (now.eating.hpAtEat.n ?? 0) >= 5 && Math.abs(eat(now) - eat(rec)) > 5 });
    // Prayer: the share of weapon changes that got a prayer change, and the share of attacks that met the right prayer.
    const lag = (f: any) => { const v = f.prayer.ticksFromWeaponChangeToPrayer.value, hit = total(v.whenTheOpponentFacesIt), miss = v.noChangeIn8Ticks.whenTheOpponentFacesIt; return { n: hit + miss, share: hit + miss ? (100 * hit) / (hit + miss) : 0 }; };
    num('weapon changes with a prayer change in 100', lag(rec).share, lag(now).share, lag(now).n, 25);
    const right = (f: any) => { const rows = Object.values(f.retreat.prayedAgainst.value ?? {}) as { attackAnimations: number; withTheProtectPrayerForItOn: number }[], a = rows.reduce((x, r) => x + r.attackAnimations, 0); return { n: a, share: a ? (100 * rows.reduce((x, r) => x + r.withTheProtectPrayerForItOn, 0)) / a : 0 }; };
    num('attacks on it with the right prayer on in 100', right(rec).share, right(now).share, right(now).n, 25);
    // Movement: the share of frames on the post, and the share of run steps.
    num('frames on the post in 100', rec.movement.place.value.post ?? 0, now.movement.place.value.post ?? 0, now.movement.place.n ?? 0, 25, 500);
    const run = (f: any) => { const s = f.movement.steps.value; return s.run + s.walk ? (100 * s.run) / (s.run + s.walk) : 0; };
    num('run steps in 100', run(rec), run(now), now.movement.steps.n ?? 0, 10, 500);
    // What the record holds as unknown and the new traces show: these do not drift, they close a gap.
    for (const [key, path] of [['a freeze on it', now.targets.frozen], ['a retreat or a death at 40 Hitpoints or less', now.retreat.at40HpOrLess], ['a death', now.death]] as const)
        if (path?.status === 'measured') out.push({ measure: `new sample: ${key}`, record: '-', now: `${path.n} in the new traces`, n: path.n, drift: false, why: 'build the record again with these traces' });
    return out;
}
// A live squad run against the clone's prediction: the Hitpoints lost a kill and the ticks a kill. `tolerance` is the
// error that the fidelity table of research/gang-clones.md states.
export function squadDrift(live: { kills: number; hpLost: number; ticks: number }, bench: { kills: number; hpLost: number; ticks: number }[], tolerance = 0.5): Check[] {
    const mean = (pick: (b: { kills: number; hpLost: number; ticks: number }) => number) => bench.reduce((a, b) => a + pick(b), 0) / Math.max(1, bench.length);
    const kills = mean(b => b.kills), per = (a: number, k: number) => (k ? a / k : Infinity);
    const row = (measure: string, l: number, b: number): Check => ({ measure, record: Math.round(b), now: Math.round(l), n: bench.length, drift: bench.length >= 3 && Number.isFinite(l) && Number.isFinite(b) && Math.abs(l - b) > tolerance * b });
    return [row('Hitpoints lost a kill (clone prediction against the live run)', per(live.hpLost, live.kills), per(mean(b => b.hpLost), kills)), row('ticks a kill', per(live.ticks, live.kills), per(mean(b => b.ticks), kills))];
}

if (import.meta.main) {
    const argv = process.argv.slice(2), mode = argv.shift(), root = resolve(import.meta.dir, '..', '..');
    const print = (name: string, checks: Check[]) => { let drift = 0; for (const c of checks) { if (c.drift) drift++; console.log(`${c.drift ? 'DRIFT' : 'ok   '} ${name} | ${c.measure} | record ${c.record} | now ${c.now} | n ${c.n}${c.why ? ` | ${c.why}` : ''}`); } return drift; };
    if (mode === 'feed' && argv.length) {
        const i = argv.indexOf('--data'), data = resolve(i >= 0 ? argv.splice(i, 2)[1]! : root);
        const pack = (file: string) => new Map(readFileSync(join(root, 'vendor/rs-sdk/server/content/pack', file), 'utf8').split(/\r?\n/).flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; }));
        const objs = pack('obj.pack'), seqs = pack('seq.pack'), zones = new Set(readFileSync(join(root, 'vendor/rs-sdk/server/content/maps/multiway.csv'), 'utf8').split(/\r?\n/));
        const rec = newRecord();
        for (const t of argv) addTrace(rec, t, readFileSync(resolve(data, t), 'utf8').split('\n'), p => zones.has([0, p.x >> 6, p.z >> 6, p.x & 56, p.z & 56].join('_')), id => seqs.get(id) ?? `seq${id}`, id => objs.get(id) ?? (id < 0 ? '' : `obj${id}`));
        let drift = 0;
        for (const n of GANG) drift += print(n, driftChecks(JSON.parse(readFileSync(join(root, 'scripts', 'pk-gang-record', `${n}.json`), 'utf8')), JSON.parse(JSON.stringify(targetFile(n, rec.acc[n]!, rec.group, undefined, 'none')))));
        console.log(`RESULT ${drift ? 'fail' : 'ok'} gang drift traces=${argv.length} drift=${drift}`);
        process.exit(drift ? 1 : 0);
    } else if (mode === 'squad' && argv.length >= 4) {
        const [kills, hpLost, ticks] = argv.slice(0, 3).map(Number), bench: { kills: number; hpLost: number; ticks: number }[] = [];
        for (const f of argv.slice(3)) for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) { const k = line.match(/RESULT ok.*?kills=(\d+)/), hp = line.match(/hpLost=(\d+)/), t = line.match(/ticks=(\d+)/); if (k && hp && t) bench.push({ kills: Number(k[1]), hpLost: Number(hp[1]), ticks: Number(t[1]) }); }
        const drift = print('squad', squadDrift({ kills: kills!, hpLost: hpLost!, ticks: ticks! }, bench));
        console.log(`RESULT ${drift ? 'fail' : 'ok'} gang drift bench runs=${bench.length} drift=${drift}`);
        process.exit(drift ? 1 : 0);
    } else { console.log('usage: bun scripts/measure/pk-gang-drift.ts feed [--data <root>] <trace.jsonl> [...] | squad <kills> <Hitpoints lost> <ticks> <bench output> [...]'); process.exit(2); }
}
