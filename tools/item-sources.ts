// Live item-source adapter: enriches knowledge/item-sources with owned fleet stock and .practice/market-all.json quotes.
// Usage: bun tools/item-sources.ts [--market <file>] [--owned] [--practice <dir>] [--out <file>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FLEET_DIR, mySide } from '../packages/core/src/fleet';
import { fleetStatusRows, ownerOfIn, readSnapshotFiles } from '../packages/core/src/fleet-snapshots';
import { buildItemSources, counts, defaultMarket, gapsMarkdown, ownedStockFromRows, readMarket, serializeItemSources, type Market, type OwnedStock } from '../packages/knowledge/src/item-sources';
import { knowledgeDir } from '../packages/knowledge/src/paths';
import { marketQuotes } from '../scripts/market-cache';

const repoRoot = resolve(import.meta.dir, '..');
const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

// Read local status files and synced fleet snapshots using canonical owner/freshness rules before aggregating stock.
export function readOwned(practice: string, fleetDir = join(FLEET_DIR(), 'snapshots'), side = mySide(), now = Date.now()): OwnedStock {
    const newestByAccount = new Map<string, any>();
    for (const statusDir of [join(practice, 'live', 'status'), join(practice, 'status')]) {
        if (!existsSync(statusDir)) continue;
        for (const f of readdirSync(statusDir).filter(file => file.endsWith('.json'))) {
            let row: any;
            try { row = json(join(statusDir, f)); } catch { continue; }
            if (!row || typeof row.name !== 'string') continue;
            const key = row.name.toLowerCase();
            const prev = newestByAccount.get(key);
            if (!prev || (typeof row.at === 'number' && row.at > (typeof prev.at === 'number' ? prev.at : -Infinity))) {
                newestByAccount.set(key, row);
            }
        }
    }
    const local = [...newestByAccount.values()];
    const accounts = fleetStatusRows(local, readSnapshotFiles(fleetDir), ownerOfIn(dirname(fleetDir)), side, LIVE_SERVER);
    return ownedStockFromRows(accounts, now);
}

export function readLiveMarket(file: string): Market {
    return readMarket(file, marketQuotes);
}

export function defaultLiveMarket(practice: string, research = join(repoRoot, 'research'), now = Date.now()): Market | null {
    return defaultMarket(practice, research, now, marketQuotes);
}

if (import.meta.main) {
    const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
    const practice = resolve(arg('--practice') ?? join(repoRoot, '.practice'));
    const marketFile = arg('--market');
    const market = marketFile ? readLiveMarket(resolve(marketFile)) : defaultLiveMarket(practice);
    const owned = process.argv.includes('--owned') ? readOwned(practice) : null;
    const rows = buildItemSources({ market, owned });
    const file = arg('--out') ?? (owned ? join(practice, 'coordinator/item-sources.json') : join(knowledgeDir(), 'item-sources.json'));
    writeFileSync(file, serializeItemSources(rows, market, owned, 'bun tools/item-sources.ts'));
    if (!owned) writeFileSync(join(knowledgeDir(), 'item-sources-gaps.md'), gapsMarkdown(rows, market));
    console.log(JSON.stringify(counts(rows)));
}
