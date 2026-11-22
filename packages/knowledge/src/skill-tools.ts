// Tools and held items each skill method needs, read from the content scripts.
// Usage: bun packages/knowledge/src/skill-tools.ts   writes knowledge/skill-tools.json.
// Every fact carries `src` = content-relative path and 1-based line. A fact the scripts do not state is a `gaps` entry.
// A name that starts with `_` is a content category (loc or obj), as the trigger writes it.
import { writeFileSync } from 'node:fs';
import { buildSkillTools, skillToolsJsonPath } from './skill-tools/build';

export type {
    AppliesTo,
    AxeRow,
    Cite,
    Condition,
    Consume,
    Hold,
    ItemNeed,
    LocNeed,
    PickaxeRow,
    ToolRecord,
} from './skill-tools/types';
export { cite, lines } from './skill-tools/readers';
export { buildAxes, buildPickaxes } from './skill-tools/gathering';
export { buildFishing } from './skill-tools/fishing';
export { buildSkillTools } from './skill-tools/build';

if (import.meta.main) {
    const out = buildSkillTools();
    writeFileSync(skillToolsJsonPath(), JSON.stringify(out, null, 1) + '\n');
    console.log(`skill-tools: ${out.records.length} records, ${out.axes.length} axes, ${out.pickaxes.length} pickaxes, ${out.gaps.length} gaps`);
    console.log(JSON.stringify(out.counts));
}
