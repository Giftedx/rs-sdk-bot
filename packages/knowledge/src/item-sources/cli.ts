import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { knowledgeDir } from '../paths';
import { buildItemSources } from './build';
import { repoRoot } from './model';
import { counts, gapsMarkdown, serializeItemSources } from './report';
import { defaultMarket, readMarket } from './stock-adapter';

export function runItemSourcesCli(argv: readonly string[]): void {
    if (argv.includes('--owned')) {
        console.error('owned fleet stock lives outside packages/knowledge; run: bun scripts/item-sources.ts --owned');
        process.exit(2);
    }
    const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const practice = resolve(arg('--practice') ?? join(repoRoot, '.practice'));
    const marketFile = arg('--market');
    const market = marketFile ? readMarket(resolve(marketFile)) : defaultMarket(practice);
    const rows = buildItemSources({ market, owned: null });
    const file = arg('--out') ?? join(knowledgeDir(), 'item-sources.json');
    writeFileSync(file, serializeItemSources(rows, market, null));
    writeFileSync(join(knowledgeDir(), 'item-sources-gaps.md'), gapsMarkdown(rows, market));
    console.log(JSON.stringify(counts(rows)));
}
