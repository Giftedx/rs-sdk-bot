import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../paths';
import { ABSENT_TRAVEL, F, S, SAIL_PROCS } from './files';
import {
    MOVE_COORD_RE, constant, coordOn, find, hitAt, lines, loadNpcTravelEnv, num, parseCoord, radiusOn,
} from './lookup';
import { EXCLUDED, SPECS } from './specs';
import type { At, ExcludedRecord, SrcTile, TravelRecord } from './types';

export function buildNpcTravel(): { records: TravelRecord[]; excluded: ExcludedRecord[] } {
    const { npcBlocks, npcs, planks } = loadNpcTravelEnv();
    const disembark = find(`${S}general_use/scripts/gangplank.rs2`, '[oploc1,_gangplank_disembark]').src;
    const records: TravelRecord[] = [];
    for (const s of SPECS) {
        const npc = npcs.get(s.npc);
        if (!npc) throw new Error(`npc-travel: ${s.npc} not in npcs.json`);
        const block = npcBlocks.get(s.npc);
        const trig = hitAt(s.trigger);
        const opLabel = block?.props[`op${s.op}`]?.[0] ?? null;
        const opSrc = block?.propLines[`op${s.op}`]?.[0] ? `${block.file}:${block.propLines[`op${s.op}`]![0]}` : null;
        if (s.trigger.needle.startsWith('[opnpc1,_')) {
            const cat = s.trigger.needle.slice(9, -1);
            if (block?.props.category?.[0] !== cat) throw new Error(`npc-travel: ${s.npc} is not in category ${cat}`);
        }
        const options = (s.options ?? []).map(o => {
            const text = typeof o === 'string' ? o : o.text, file = typeof o === 'string' ? s.optionsFile! : o.file;
            return { text, src: find(file, `"${text}"`).src };
        });
        let to: TravelRecord['to'] = null;
        let toCandidates: SrcTile[] | undefined;
        let returnTo: TravelRecord['returnTo'];
        let candidateRadius: TravelRecord['candidateRadius'];
        if (s.candidates) {
            const head = find(s.candidates.file, '[essence_mine_teleports]').n;
            toCandidates = lines(s.candidates.file).flatMap((t, i) => {
                const m = i >= head && t.match(/^val=\d+,(\d+_\d+_\d+_\d+_\d+)$/);
                return m ? [{ ...parseCoord(m[1]!), src: `${s.candidates!.file}:${i + 1}` }] : [];
            });
            const rh = hitAt(s.candidates.returnRadius), rc = constant(s.candidates.returnConst);
            returnTo = { ...parseCoord(rc.value), src: rc.src, radius: radiusOn(rh), radiusSrc: rh.src };
            if (s.to?.radius) { const r = hitAt(s.to.radius); candidateRadius = { radius: radiusOn(r), src: r.src }; }
        } else if (s.to) {
            const hit = hitAt(s.to.at);
            const c = coordOn(hit);
            const steps = [...c.steps];
            let { x, z, level } = c;
            for (const o of s.to.offsets ?? []) {
                const oh = hitAt(o), m = oh.text.match(MOVE_COORD_RE);
                if (!m) throw new Error(`npc-travel: no movecoord on ${oh.src}`);
                x += Number(m[1]); level += Number(m[2]); z += Number(m[3]);
                steps.push(oh.src);
            }
            if ([...SAIL_PROCS].some(p => hit.text.includes(p))) {
                const proc = hit.text.includes('~set_sail(')
                    ? find(F.sail, 'p_telejump($destination);')
                    : hit.text.includes('~set_sail_cairn(')
                        ? find(F.shanks, 'p_telejump($destination);')
                        : find(F.miscSailor, 'p_telejump($dest);');
                steps.push(proc.src);
            }
            to = { x, z, level, raw: c.raw, src: c.src, steps };
            if (s.to.radius) { const r = hitAt(s.to.radius); to.radius = radiusOn(r); to.radiusSrc = r.src; }
        }
        let fromRows = npc.spawns;
        let fromFilter: TravelRecord['fromFilter'];
        if (s.from) { fromRows = fromRows.filter(s.from.keep); fromFilter = { rule: s.from.rule, src: hitAt(s.from.at).src }; }
        const fare: TravelRecord['fare'] = 'at' in s.fare && !Array.isArray(s.fare.at)
            ? (() => {
                const h = hitAt(s.fare.at as At);
                const m = h.text.match(/coins,\s*(\d+)/);
                if (!m || Number(m[1]) !== s.fare.coins) throw new Error(`npc-travel: fare mismatch on ${h.src}`);
                return { coins: Number(m[1]), src: h.src };
            })()
            : 'free' in s.fare ? { coins: 0, src: null, rule: s.fare.free }
            : { coins: null, src: null, rule: (s.fare as { rule: string }).rule, ruleSrc: (s.fare.at as At[]).map(a => hitAt(a).src) };
        const requires = (s.requires ?? []).map(r => {
            const names = Array.isArray(r.constant) ? r.constant : [r.constant];
            return { varp: r.varp, op: r.op, constant: r.constant, value: Array.isArray(r.constant) ? names.map(num) : num(names[0]!), src: hitAt(r.at).src };
        });
        let deck: TravelRecord['deck'] = { onDeck: false };
        if (to && to.level === 1) {
            const near = planks.filter(p => p.level === 1).map(p => ({ p, d: Math.max(Math.abs(p.x - to!.x), Math.abs(p.z - to!.z)) })).sort((a, b) => a.d - b.d)[0];
            deck = { onDeck: true, ...(near && near.d <= 8 ? { gangplank: { loc: near.p.name, id: near.p.id, x: near.p.x, z: near.p.z, level: near.p.level, distance: near.d, src: near.p.src, handler: disembark } } : {}) };
        }
        const gaps = [...(s.gaps ?? [])];
        if (deck.onDeck && !deck.gangplank) gaps.push('Arrival is on a ship deck (level 1) but no gangplank_disembark loc lies within 8 tiles.');
        if (!fromRows.length) gaps.push('No static spawn matches this NPC branch.');
        if (!opLabel) gaps.push(`npc config has no op${s.op} label.`);
        records.push({
            id: `${s.npc}:${s.destination.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
            kind: s.kind, destination: s.destination,
            npc: { debugname: npc.debugname, name: npc.name, id: npc.id, src: npc.src },
            op: { index: s.op, label: opLabel, src: opSrc, trigger: trig.src },
            options,
            ...(s.button ? { button: { component: s.button.component, src: hitAt(s.button).src } } : {}),
            from: fromRows, ...(fromFilter ? { fromFilter } : {}),
            to, ...(toCandidates ? { toCandidates, candidateRadius } : {}), ...(returnTo ? { returnTo } : {}),
            fare,
            items: (s.items ?? []).map(i => ({ item: i.item, use: i.use, src: hitAt(i.at).src })),
            requires,
            members: s.members ? { checked: true, src: hitAt(s.members).src } : { checked: false },
            deck, notes: s.notes ?? [], gaps,
        });
    }
    const ids = new Set<string>();
    for (const r of records) { if (ids.has(r.id)) throw new Error(`npc-travel: duplicate id ${r.id}`); ids.add(r.id); }
    const excluded = EXCLUDED.map(e => ({ npc: e.npc, src: hitAt(e.at).src, reason: e.reason }));
    return { records, excluded };
}

export function runNpcTravelCli(): void {
    const { records, excluded } = buildNpcTravel();
    writeFileSync(join(knowledgeDir(), 'npc-travel.json'), JSON.stringify({
        note: 'Generated by bun packages/knowledge/src/npc-travel.ts. Do not edit by hand. src is content-relative path:line.',
        absent: ABSENT_TRAVEL,
        records, excluded,
    }, null, 1) + '\n');
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    console.log(`npc-travel: ${records.length} records, ${excluded.length} excluded`);
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
}
