import { test, expect } from 'bun:test';
import { idsFor, supplyBill, liveHelperStatuses } from '../src/supply-bill';
import {unitValue} from '../src/autopilot';

const items = [{ id: 536, name: 'Dragon bones' }, { id: 99, name: 'Unfinished potion', debugname: 'ranarrvial' }, { id: 109, name: 'Unfinished potion', debugname: 'dwarfweedvial' }, { id: 2970, name: 'Mort myre fungi' }];

test('bill lines map to pinned item ids, including unfinished potions and plural names', () => {
    expect(idsFor('dragon bones', items)).toEqual([536]);
    expect(idsFor('ranarr potion (unf)', items)).toEqual([99]);
    expect(idsFor('dwarf weed potion (unf)', items)).toEqual([109]);
    expect(idsFor('mort myre fungus', items)).toEqual([2970]);
});
test('an exact kit part keeps its identity in the persisted bill and ignores other colours', () => {
    const catalog=[{id:2503,name:'Dragonhide body'},{id:2501,name:'Dragonhide body'}];
    const bill=supplyBill([{item:'black dragonhide body',itemId:2503,count:1}],catalog,
        [{name:'A',bank:[{id:2501,count:20}]}]);
    expect(bill[0]).toMatchObject({itemId:2503,ids:[2503],owned:0,short:1});
});

test('the shortfall subtracts stock across helpers and lists the holders', () => {
    const bill = supplyBill([{ item: 'dragon bones', count: 560 }, { item: 'rune armour set', count: 1 }], items,
        [{ name: 'A', bank: [{ id: 536, count: 300 }] }, { name: 'B', inventory: [{ id: 536, count: 100 }] }]);
    expect(bill[0]).toMatchObject({ need: 560, owned: 400, short: 160, holders: [{ account: 'A', count: 300 }, { account: 'B', count: 100 }] });
    expect(bill[1]).toMatchObject({ short: 1, ids: [] });
});

test('independently observed bank and carried counts do not add the same base item twice', () => {
    const catalog=[{id:53,name:'Headless arrow'}];
    const rows=supplyBill([{item:'headless arrows',count:15}],catalog,[
        {name:'Moved',inventory:[{id:53,count:8}],equipment:[{id:53,count:2}],bank:[{id:54,baseId:53,count:9}]},
        {name:'Separate',bank:[{id:53,count:4}]},
    ]);
    expect(rows[0]).toMatchObject({owned:14,short:1,holders:[{account:'Moved',count:10},{account:'Separate',count:4}]});
});

test('plain and noted demand draw from one base stock pool', () => {
    const catalog=[{id:1995,name:'Unfermented wine'}];
    const rows=supplyBill([
        {item:'unfermented wine (noted)',count:600},
        {item:'unfermented wine',count:600},
    ],catalog,[{name:'Holder',bank:[{id:1996,baseId:1995,count:600}]}]);
    expect(rows).toEqual([{
        item:'unfermented wine (noted)',aliases:['unfermented wine'],need:1200,owned:600,short:600,ids:[1995],
        holders:[{account:'Holder',count:600}],
    }]);
});

test('overlapping name matches require exact IDs before stock can cover either demand', () => {
    const rows=supplyBill([{item:'part',count:1},{item:'parts',count:1}],
        [{id:1,name:'Part'},{id:2,name:'Parts'}],[{name:'Holder',bank:[{id:1,count:1}]}]);
    expect(rows.map(r=>[r.owned,r.short,r.ids])).toEqual([[0,1,[]],[0,1,[]]]);
});

test('the shortfall premium still applies to a merged item alias', () => {
    const rows=supplyBill([{item:'mort myre fungus',count:1},{item:'mort myre fungi',count:1}],items,[]);
    expect(rows).toHaveLength(1);
    expect(unitValue('mort myre fungi',rows,{'mort myre fungi':10})).toBe(20);
});

test('the bill counts the other fleet side’s snapshot, not this side’s own', async () => {
    const { liveHelperStatuses } = await import('../src/supply-bill');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const base = mkdtempSync(join(tmpdir(), 'bill-')), snaps = join(base, 'snaps');
    mkdirSync(join(base, '.practice/status'), { recursive: true }); mkdirSync(snaps);
    writeFileSync(join(base, '.practice/status/Giver.json'), JSON.stringify({ name: 'Giver', server: 'rs-sdk-demo.fly.dev', bank: [{ id: 379, count: 5 }] }));
    writeFileSync(join(snaps, 'cloud.json'), JSON.stringify({ side: 'cloud', accounts: [{ name: 'Taker', server: 'rs-sdk-demo.fly.dev', bank: [{ id: 379, count: 7 }] }, { name: 'Giver', server: 'rs-sdk-demo.fly.dev' }] }));
    writeFileSync(join(snaps, 'local.json'), JSON.stringify({ side: 'local', accounts: [{ name: 'Old', server: 'rs-sdk-demo.fly.dev' }] }));
    expect(liveHelperStatuses(base, snaps, 'local').map(s => s.name).sort()).toEqual(['Giver', 'Taker']);
});

test('default shared snapshots use FLEET_DIR and prevent a covered global arrow requirement becoming surplus production',async()=>{
    const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
    const {join}=await import('node:path');const {tmpdir}=await import('node:os');
    const base=mkdtempSync(join(tmpdir(),'global-bill-')),fleet=join(base,'.practice/fleet-data/fleet'),old=process.env.FLEET_DIR;
    try{
        process.env.FLEET_DIR=fleet;
        for(const dir of [join(base,'.practice/status'),join(fleet,'snapshots'),join(base,'fleet/snapshots')])mkdirSync(dir,{recursive:true});
        const live='rs-sdk-demo.fly.dev',holding=(name:string,count:number,server=live)=>({name,server,bank:[{id:53,count}]});
        writeFileSync(join(base,'.practice/status/Swordswallow.json'),JSON.stringify(holding('Swordswallow',270)));
        writeFileSync(join(base,'.practice/status/Practice.json'),JSON.stringify(holding('Practice',9999,'localhost:8888')));
        writeFileSync(join(fleet,'snapshots/local.json'),JSON.stringify({side:'local',accounts:[holding('LocalBank',3486),holding('SWORDSWALLOW',1000),holding('Haggis',9999)]}));
        writeFileSync(join(fleet,'snapshots/cloud.json'),JSON.stringify({side:'cloud',accounts:[holding('OldCloud',9999)]}));
        writeFileSync(join(fleet,'snapshots/claude-cloud.json'),JSON.stringify({side:'claude-cloud',accounts:[holding('OtherCloud',15)]}));
        writeFileSync(join(base,'fleet/snapshots/local.json'),JSON.stringify({side:'local',accounts:[holding('Legacy',10)]}));
        const statuses=liveHelperStatuses(base,undefined,'cloud');
        expect(statuses.map(s=>s.name).sort()).toEqual(['LocalBank','OtherCloud','Swordswallow']);
        const rows=supplyBill([{item:'headless arrows',count:3615}],[{id:53,name:'Headless arrow'}],statuses);
        expect(rows[0]).toMatchObject({owned:3771,short:0,holders:[{account:'LocalBank',count:3486},{account:'Swordswallow',count:270},{account:'OtherCloud',count:15}]});
        // A caller's explicit snapshot directory remains authoritative over the configured default.
        const explicit=liveHelperStatuses(base,join(base,'fleet/snapshots'),'cloud');
        expect(supplyBill([{item:'headless arrows',count:3615}],[{id:53,name:'Headless arrow'}],explicit)[0]).toMatchObject({owned:280,short:3335});
    }finally{if(old===undefined)delete process.env.FLEET_DIR;else process.env.FLEET_DIR=old;rmSync(base,{recursive:true,force:true});}
});
