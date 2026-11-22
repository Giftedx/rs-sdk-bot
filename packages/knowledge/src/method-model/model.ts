import { activityFacts } from './activities';
import { gatheringFacts } from './gathering';
import { productionFacts } from './production';
import { facts } from './timing';
import type { Content, Facts, ModelInput } from './types';

/** Facts for one rung. Unknown parts become a gap that names the missing fact. */
export function modelRung(c: Content, r: ModelInput): Facts {
    const rowName = r.id.slice(r.id.indexOf('/') + 1);
    const modeled = gatheringFacts(c, r) ?? productionFacts(c, r, rowName) ?? activityFacts(c, r, rowName);
    if (modeled) return modeled;
    if (/gear$/.test(r.kind)) return facts({ xpNote: 'gear unlock: this rung is a wield or wear level, not an XP action' });
    return facts({ gaps: [`no model for rung kind ${r.kind}`] });
}
