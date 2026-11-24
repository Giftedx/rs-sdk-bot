import { buildFishing } from './fishing';
import { buildAxes, buildPickaxes } from './gathering';
import { applies, cite, configBlocks, emptyRecord, itemId, lines, loadRungs, skillToolsJsonPath, walk } from './readers';
import { CHEST, GRIND, GRINDABLES, MEMBERS, S, SPECS, fromSpec } from './specs';
import type { AxeRow, PickaxeRow, Rung, ToolRecord } from './types';

export { skillToolsJsonPath };

// Grindable secondaries: pestle_and_mortar held, applies to potion rungs whose inputs include the ground product.
function grindRecords(rungs: Rung[], gaps: string[]): ToolRecord[] {
    const tool = cite(GRIND, /if \(\$used_with ! pestle_and_mortar\)/);
    const members = cite(GRIND, MEMBERS);
    if (!tool) { gaps.push(`herblore: pestle_and_mortar check not found in ${GRIND}`); return []; }
    const herbRungs = rungs.filter(r => r.skill === 'herblore');
    const out: ToolRecord[] = [];
    const made = new Set<string>();
    for (const [raw, ob] of configBlocks(GRINDABLES)) {
        const p = ob.params.grindable_ingredient_refined;
        if (!p) continue;
        const hits: string[] = [];
        for (const r of herbRungs) {
            if (r.inputs.some(i => i.debugname === p.value)) hits.push(r.id);
        }
        const rec = emptyRecord(`herblore/grind-${raw}`, 'herblore', { kinds: ['potion'], idPattern: null, rungs: hits }, tool.src);
        rec.items.push({ anyOf: ['pestle_and_mortar'], ids: [itemId('pestle_and_mortar')], hold: 'held', role: 'tool', src: tool.src });
        rec.consumed.push({ item: raw, id: itemId(raw), perAction: 1, src: `${GRINDABLES}:${p.line}`, note: `ground into ${p.value}` });
        if (members) rec.conditions.push({ text: members.text, src: members.src });
        rec.note = `makes ${p.value}, a potion secondary`;
        made.add(p.value);
        out.push(rec);
    }
    // A *_dust secondary with no grind recipe has no known tool.
    const dusts = new Set<string>();
    for (const r of herbRungs) {
        for (const i of r.inputs) {
            const n = i.debugname ?? '';
            if (n.endsWith('_dust') && !made.has(n)) dusts.add(n);
        }
    }
    for (const d of dusts) gaps.push(`herblore: ${d} is a potion input but ${GRINDABLES} has no grind recipe that makes it`);
    return out;
}

// Methods with no item check: scan the trigger scripts and list every inv/worn check found, so an empty list is evidence.
function scanRecord(id: string, skill: string, kinds: string[], dir: string, rungs: Rung[], idPattern?: RegExp, exclude?: RegExp): ToolRecord {
    const files = (dir.endsWith('.rs2') ? [dir] : walk(dir, '.rs2')).filter(f => !exclude || !exclude.test(f));
    const rec = emptyRecord(id, skill, applies(rungs, skill, kinds, idPattern), dir);
    for (const f of files) lines(f).forEach((t, i) => {
        const m = /inv_total\((inv|worn), *([a-z0-9_]+)\)|inv_getobj\(worn/.exec(t);
        if (m) rec.conditions.push({ text: t.trim(), src: `${f}:${i + 1}` });
    });
    rec.note = rec.conditions.length
        ? `scan of ${files.length} script file(s) found the item checks in conditions; none is a tool gate for this method`
        : `scan of ${files.length} script file(s) found no inv or worn item check`;
    return rec;
}

/** Build the complete `knowledge/skill-tools.json` payload. */
export function buildSkillTools() {
    const gaps: string[] = [];
    const rungs = loadRungs();
    if (!rungs.length) gaps.push('knowledge/ladders.json missing or empty; appliesTo.rungs are empty');
    const axes = buildAxes(gaps);
    const pickaxes = buildPickaxes(gaps);
    const fishing = buildFishing(rungs, gaps);
    const records: ToolRecord[] = [];
    for (const sp of SPECS) records.push(fromSpec(sp, rungs));
    // Per-tier woodcutting and mining records feed the axe and pickaxe tables into the record list.
    const wc = records.find(r => r.id === 'woodcutting/axe')!;
    const mn = records.find(r => r.id === 'mining/pickaxe')!;
    const pickRec = (p: PickaxeRow): ToolRecord => ({
        ...emptyRecord(`mining/pickaxe/${p.item}`, 'mining', mn.appliesTo, p.holdSrc),
        minLevel: p.miningLevel, levelSrc: p.miningLevelSrc,
        items: [{ anyOf: [p.item], ids: [p.id], hold: p.hold, role: 'tool', src: p.holdSrc, note: `wield Attack ${p.wieldAttack ?? '?'} (${p.wieldSrc}); mining_rate ${p.miningRate} (${p.miningRateSrc})` }],
    });
    const axeRec = (a: AxeRow): ToolRecord => ({
        ...emptyRecord(`woodcutting/axe/${a.item}`, 'woodcutting', wc.appliesTo, a.holdSrc),
        minLevel: null, levelSrc: a.woodcuttingLevelSrc,
        items: [{ anyOf: [a.item], ids: [a.id], hold: a.hold, role: 'tool', src: a.holdSrc, note: `wield Attack ${a.wieldAttack ?? '?'} (${a.wieldSrc}); levelrequire param ${a.paramLevelrequire} (${a.paramSrc}) is not read by woodcut.rs2` }],
        note: 'woodcutting_axe_checker has no Woodcutting level check',
    });
    records.push(...axes.map(axeRec), ...pickaxes.map(pickRec), ...fishing, ...grindRecords(rungs, gaps));
    records.push(
        scanRecord('thieving/pickpocket', 'thieving', ['pickpocket'], `${S}skill_thieving/scripts/pickpocketing`, rungs),
        scanRecord('thieving/stall', 'thieving', ['stealing'], `${S}skill_thieving/scripts/stalls`, rungs),
        scanRecord('thieving/trapped-chest', 'thieving', ['trapped_chest'], CHEST, rungs, /^(?!.*chest_steel_arrowtips$)/),
        scanRecord('agility/course', 'agility', ['course'], `${S}skill_agility/scripts`, rungs),
        scanRecord('prayer/bury', 'prayer', ['bury'], `${S}skill_prayer/scripts/bury_bone.rs2`, rungs),
    );
    // The trapped-chest scan covers the whole file; mark the lockpick line as belonging to the locked-chest record.
    const tc = records.find(r => r.id === 'thieving/trapped-chest')!;
    tc.note = `${tc.note}. Only chest_steel_arrowtips calls attempt_locked_chest (lockpick); see thieving/locked-chest`;
    for (const r of records) if (!r.id.startsWith('fishing/spot/')) for (const g of r.gaps) gaps.push(`${r.id}: ${g}`);
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.skill] = (counts[r.skill] ?? 0) + 1;
    return {
        generatedBy: 'bun packages/knowledge/src/skill-tools.ts',
        notes: [
            'src is a content-relative path and 1-based line under vendor/rs-sdk/server/content.',
            'hold: held = in the inventory; worn = equipped; either = equipped right hand or inventory.',
            'A name that starts with _ is a content category (loc or obj) as the trigger writes it.',
            'role: tool = needed and kept; bait = needed and consumed per success; access = needed to reach the method; bonus = optional, changes the result.',
            'consumed.perAction null means the amount depends on the stack held (see note).',
            'appliesTo.rungs lists the knowledge/ladders.json rung ids the record covers.',
        ],
        counts, axes, pickaxes, records, gaps,
    };
}
