import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIDS_FILE, fetchMarket, marketQuotes, marketRows, writeMarketCache, MARKET_CACHE_MS, MARKET_FILE } from './market-cache';
import { marketStale } from './fleet-agent';
import { fileTables, marketValue, unitValue } from '../packages/core/src/loot';

test('a market row has a price only with at least 3 trades', () => {
    expect(marketRows([{ id: 1127, name: 'Rune platebody', vwap: 266666.6, trades: 3, bid: 80000, ask: null }, { id: 554, name: 'Fire rune', vwap: 9, trades: 1, bid: 4 }, { name: 'no id' }]))
        .toEqual({ 1127: { name: 'Rune platebody', price: 266666.6, bid: 80000, ask: null, trades: 3 }, 554: { name: 'Fire rune', price: null, bid: 4, ask: null, trades: 1 } });
});

test('market rows preserve validated seller counts, including an observed empty book', () => {
    const rows = marketRows([{ id: 1, sellQuantity: 7 }, { id: 2, sellQuantity: 0 }, { id: 3, sellQuantity: -1 },
        { id: 4, sellQuantity: 1.5 }, { id: 5, sellQuantity: '2' }, { id: 6 }]);
    expect(rows[1]!.sell).toBe(7);
    expect(rows[2]!.sell).toBe(0);
    for (const id of [3, 4, 5, 6]) expect(rows[id]!).not.toHaveProperty('sell');
});

test('shared acquisition quotes keep their age and require explicit valid supply observations', () => {
    const now = 10_000_000, at = now - 1000;
    const items = { 1: { ask: 8, bid: 3, sell: 7 }, 2: { ask: null, bid: null, sell: 0 },
        3: { ask: 8, bid: 3 }, 4: { ask: 8, bid: 3, sell: -1 }, 5: { ask: '8', bid: 3, sell: 7 },
        6: { ask: 8, bid: -3, sell: 7 }, 7: { ask: 8, bid: 3, sell: 1.5 }, bad: { ask: 8, bid: 3, sell: 7 } };
    expect(marketQuotes({ at, items }, now)).toEqual({ 1: { at, ask: 8, bid: 3, sell: 7 }, 2: { at, ask: null, bid: null, sell: 0 } });
    for (const stamp of [0, now + 1, now - MARKET_CACHE_MS]) expect(marketQuotes({ at: stamp, items }, now)).toEqual({});
    for (const raw of [null, {}, { at, items: [] }]) expect(marketQuotes(raw, now)).toEqual({});
});

test('publishing a market cache preserves its observation time and leaves unrelated temporary files alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'market-publish-')), at = 123456;
    try {
        const items = marketRows([{ id: 1, name: 'Supply', ask: 8, bid: 3, sellQuantity: 0 }]);
        mkdirSync(join(root, '.practice'));
        writeFileSync(join(root, MARKET_FILE) + '.tmp', 'another writer');
        writeMarketCache(root, items, at);
        expect(JSON.parse(readFileSync(join(root, MARKET_FILE), 'utf8'))).toEqual({ at, items });
        expect(readFileSync(join(root, MARKET_FILE) + '.tmp', 'utf8')).toBe('another writer');
        expect(readdirSync(join(root, '.practice')).sort()).toEqual(['market-all.json', 'market-all.json.tmp']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent market publishers expose one complete snapshot without temporary-file collisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'market-concurrent-'));
    try {
        const source = new URL('./market-cache.ts', import.meta.url).href;
        const records = [1, 2].map(id => ({ at: id * 1000, items: marketRows([{ id, name: `writer${id}`, ask: 8, bid: 3, sellQuantity: id }]) }));
        const children = records.map(record => Bun.spawn([process.execPath, '--eval',
            `import {writeMarketCache} from ${JSON.stringify(source)};for(let i=0;i<32;i++)writeMarketCache(${JSON.stringify(root)},${JSON.stringify(record.items)},${record.at});`,
        ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true }));
        const results = await Promise.all(children.map(async child => ({ code: await child.exited, error: await new Response(child.stderr).text() })));
        expect(results).toEqual([{ code: 0, error: '' }, { code: 0, error: '' }]);
        expect(records).toContainEqual(JSON.parse(readFileSync(join(root, MARKET_FILE), 'utf8')));
        expect(readdirSync(join(root, '.practice'))).toEqual(['market-all.json']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

async function renameFailureCase(code:string,failures:number){
    const root=mkdtempSync(join(tmpdir(),'market-replace-'));
    try{
        const source=new URL('./market-cache.ts',import.meta.url).href;
        const child=Bun.spawn([process.execPath,'--eval',`
            import {mock} from 'bun:test';
            import {join} from 'node:path';
            const fs=await import('node:fs'),root=${JSON.stringify(root)},file=join(root,'.practice','market-all.json');
            const previous={at:1000,items:{1:{name:'Old',price:4,bid:3,ask:5,trades:3,sell:2}}};
            fs.mkdirSync(join(root,'.practice'));fs.writeFileSync(file,JSON.stringify(previous));
            let attempts=0,injected=0;const observed=[],nativeErrors=[],rename=fs.renameSync;
            mock.module('node:fs',()=>({...fs,renameSync:(from,to)=>{
                attempts++;observed.push(JSON.parse(fs.readFileSync(file,'utf8')));
                if(injected<${failures}){injected++;throw Object.assign(Error('fixture replacement refused'),{code:${JSON.stringify(code)}});}
                try{rename(from,to);}catch(failure){nativeErrors.push(failure.code);throw failure;}
            }}));
            const {writeMarketCache}=await import(${JSON.stringify(source)});
            let error=null;
            try{writeMarketCache(root,{2:{name:'New',price:7,bid:6,ask:8,trades:3,sell:9}},2000);}
            catch(failure){error={code:failure.code,message:failure.message};}
            process.stdout.write(JSON.stringify({attempts,injected,nativeErrors,observed,error,cache:JSON.parse(fs.readFileSync(file,'utf8')),files:fs.readdirSync(join(root,'.practice'))}));
        `],{stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:5000});
        const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
        expect(exitCode).toBe(0);
        if(exitCode!==0)throw Error(stderr);
        return JSON.parse(stdout);
    }finally{rmSync(root,{recursive:true,force:true});}
}

for(const code of ['EPERM','EBUSY','EACCES'])test(`market publication preserves its prior snapshot while retrying ${code}`,async()=>{
    const result=await renameFailureCase(code,2);
    expect(result.error).toBeNull();
    expect(result.injected).toBe(2);
    expect(result.attempts).toBe(result.injected+result.nativeErrors.length+1);
    expect(result.attempts).toBeLessThanOrEqual(21);
    for(const code of result.nativeErrors)expect(['EPERM','EBUSY','EACCES']).toContain(code);
    expect(result.observed).toEqual(Array.from({length:result.attempts},()=>({at:1000,items:{1:{name:'Old',price:4,bid:3,ask:5,trades:3,sell:2}}})));
    expect(result.cache).toEqual({at:2000,items:{2:{name:'New',price:7,bid:6,ask:8,trades:3,sell:9}}});
    expect(result.files).toEqual(['market-all.json']);
});

test('market publication propagates a non-retryable rename error and cleans its temporary file',async()=>{
    const result=await renameFailureCase('ENOENT',2);
    expect(result.error).toEqual({code:'ENOENT',message:'fixture replacement refused'});
    expect(result.attempts).toBe(1);
    expect(result.cache).toEqual({at:1000,items:{1:{name:'Old',price:4,bid:3,ask:5,trades:3,sell:2}}});
    expect(result.files).toEqual(['market-all.json']);
});

test('market publication bounds persistent replacement failures and leaves the old snapshot intact',async()=>{
    const result=await renameFailureCase('EPERM',100);
    expect(result.error).toEqual({code:'EPERM',message:'fixture replacement refused'});
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.attempts).toBeLessThanOrEqual(21);
    expect(result.cache).toEqual({at:1000,items:{1:{name:'Old',price:4,bid:3,ask:5,trades:3,sell:2}}});
    expect(result.files).toEqual(['market-all.json']);
});

test('fetchMarket reads every page of 100 and pauses between them', async () => {
    const urls: string[] = [];
    let pauses = 0;
    const page = (offset: number) => ({ total: 150, items: [{ id: offset + 1, name: `i${offset}`, vwap: 10, trades: 5 }] });
    const all = await fetchMarket(async url => { urls.push(url); return page(Number(url.match(/offset=(\d+)/)![1])); }, async () => { pauses++; });
    expect(urls.every(url=>url.startsWith('https://rs-sdk.maxbittker.com/api/market/items?'))).toBe(true);
    expect(urls.map(u => u.replace(/^.*\?/, ''))).toEqual(['limit=100&offset=0', 'limit=100&offset=100']);
    expect(pauses).toBe(1);
    expect(Object.keys(all)).toEqual(['1', '101']);
    await expect(fetchMarket(async () => ({ total: -1, items: [] }), async () => {})).rejects.toThrow('invalid market page');
});

test('market value: the lower of the VWAP and the bid; no price, no value', () => {
    expect(marketValue({ price: 266666.6, bid: 80000 })).toBe(80000);
    expect(marketValue({ price: 5000.9, bid: null })).toBe(5000);
    expect(marketValue({ price: null, bid: 80000 })).toBe(0);
    expect(marketValue(undefined)).toBe(0);
});

test('market value: an item with no bid is not worth its wash-traded VWAP', () => {
    // Rows of .practice/market-all.json: a VWAP in the tens of thousands, no bid, a base price of a few coins.
    expect(marketValue({ price: 29076.3, bid: null, ask: 213, base: 1 })).toBe(4);
    expect(marketValue({ price: 67125.7, bid: null, ask: 894, base: 18 })).toBe(72);
    expect(marketValue({ price: 59501.4, bid: null, ask: 46999, base: 6 })).toBe(24);
    expect(marketValue({ price: 51031.4, bid: null, ask: 36560, base: 2 })).toBe(8);
    // A bid keeps the lower of the VWAP and the bid, whatever the base price.
    expect(marketValue({ price: 29076, bid: 20000, ask: 213, base: 1 })).toBe(20000);
});

test('the loot tables value an item at its market price over the alchemy floor', () => {
    const root = mkdtempSync(join(tmpdir(), 'market-'));
    mkdirSync(join(root, 'knowledge')); mkdirSync(join(root, '.practice'));
    writeFileSync(join(root, 'knowledge', 'items.json'), JSON.stringify([{ id: 1127, name: 'Rune platebody', debugname: 'rune_platebody', cost: 65000, tradeable: true },
        { id: 1163, name: 'Rune full helm', debugname: 'rune_full_helm', cost: 35200, tradeable: true }]));
    writeFileSync(join(root, MARKET_FILE), JSON.stringify({ at: 1, items: { 1127: { price: 266666, bid: 80000, trades: 3 }, 1163: { price: 5000, bid: null, trades: 4 } } }));
    const t = fileTables(root);
    expect(unitValue(1127, t)).toBe(80000);
    // A market price under the alchemy floor does not lower the value.
    expect(unitValue(1163, t)).toBe(Math.floor(35200 * 0.6));
});

test('fresh dashboard quotes cannot hide missing or stale shop-to-bid recommendations', () => {
    const root = mkdtempSync(join(tmpdir(), 'market-stale-'));
    try {
        expect(marketStale(root)).toBe(true);
        writeMarketCache(root, {});
        expect(marketStale(root)).toBe(true);
        writeFileSync(join(root, BIDS_FILE), '{}');
        expect(marketStale(root)).toBe(false);
        const now = Date.now(), old = (now - MARKET_CACHE_MS - 60_000) / 1000;
        utimesSync(join(root, BIDS_FILE), old, old);
        writeMarketCache(root, {}, now);
        expect(marketStale(root, now)).toBe(true);
        utimesSync(join(root, BIDS_FILE), now / 1000, now / 1000);
        expect(marketStale(root, now)).toBe(false);
        utimesSync(join(root, MARKET_FILE), old, old);
        expect(marketStale(root, now)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shopLots lists the shops whose open bids make a lot worth a walk, the largest first', async () => {
    const { shopLots, marketRows } = await import('./market-cache');
    const { scanProfiles, lotValue } = await import('../packages/workers/src/market');
    const items = marketRows([
        { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334, trades: 200, vwap: 230 },
        { id: 560, name: 'Death rune', basePrice: 30, bid: 250, buyQuantity: 40, trades: 9, vwap: 260 },
        { id: 556, name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1_000_000, trades: 9, vwap: 20 },
    ]);
    expect(items[313]).toMatchObject({ base: 3, want: 38_334 });
    const profiles = { sarim: { items: [{ re: /^fishing bait$/i }] }, betty: { items: [{ re: /death rune/i }, { re: /air rune/i }] } };
    const lots = shopLots(items, profiles, scanProfiles, lotValue);
    // Bait clears 1,020,500 at most (5,000 units); 40 death runes clear 8,300, under the 20,000 floor; air runes lose money.
    expect(lots).toEqual([{ profile: 'sarim', value: 1_020_500, items: [{ id: 313, name: 'Fishing bait', bid: 218, want: 38_334, margin: 204 }] }]);
    expect(shopLots(items, profiles, scanProfiles, lotValue, 5000).map(l => l.profile)).toEqual(['sarim', 'betty']);
});
