import { expect, test } from 'bun:test';
import { ARROW_METALS,nativeArrowProfile,runNativeArrows,planHeadless, runHeadless, planSteel, runSteel, planOakBows, runOakBows } from "./fletch-arrows";
import type { Session } from "../packages/core/src/inprocess";

test('headless plan rounds to15 and preserves both input reserves', () => {
    expect(planHeadless(720, 500)).toBe(390);
    expect(planHeadless(720, 120)).toBe(15);
    expect(planHeadless(200, 100)).toBe(0);
});

function fixture(options: { shafts?: number; feathers?: number; stalled?: boolean; partialWithdraw?: boolean; steel?: boolean; level?: number; headless?: number; tips?: number; debitOnly?: boolean; iron?: boolean; unknown?: boolean; staleDeposit?: boolean; metal?:typeof ARROW_METALS[number]; afterPaid?:()=>void; foreignItem?:boolean } = {}) {
    let tick = 0, xp = 10000, bankOpen = false, generation = 0;
    const listeners = new Set<() => void>();
    const queued: (() => void)[] = [];
    type Item = { id: number; name: string; count: number; slot: number; optionsWithIndex: [] };
    const inventory: Item[] = [{ id: 995, name: 'Coins', count: 5000, slot: 0, optionsWithIndex: [] },
        { id: 946, name: 'Knife', count: 1, slot: 1, optionsWithIndex: [] }, { id: 315, name: 'Shrimps', count: 1, slot: 2, optionsWithIndex: [] },
        { id: 315, name: 'Shrimps', count: 1, slot: 3, optionsWithIndex: [] }];
    const bank = [{ id: 52, name: 'Arrow shaft', count: options.shafts ?? 720, slot: 0 }, { id: 314, name: 'Feather', count: options.feathers ?? 500, slot: 1 },
        { id: 53, name: 'Headless arrow', count: options.headless ?? 30, slot: 2 },
        { id: 41, name: 'Steel arrowtips', count: options.iron ? 20 : (options.tips ?? 20), slot: 3 }, { id: 886, name: 'Steel arrow', count: 7, slot: 4 }, {id:40,name:'Iron arrowtips',count:options.iron?(options.tips??90):0,slot:5},{id:884,name:'Iron arrow',count:7,slot:6}];
    const selected=options.metal?nativeArrowProfile(options.metal):undefined;if(selected){bank.push({id:selected.tip,name:selected.tipName,count:options.tips??35,slot:bank.length},{id:selected.product,name:options.metal+' arrow',count:7,slot:bank.length+1});const seen=new Set<number>();for(let i=bank.length-1;i>=0;i--){if(seen.has(bank[i]!.id))bank.splice(i,1);else seen.add(bank[i]!.id);}bank.forEach((i,n)=>i.slot=n);}
    const deposits: number[] = [];
    const state = () => ({ player: { worldX: 3092, worldZ: 3243, level: 0, lifeId: 1, respawnCount: 0 }, bank: { isOpen: bankOpen, items: bank }, inventory, interface: { isOpen: bankOpen } });
    const timer = setInterval(() => { for (const action of queued.splice(0)) action(); tick++; for (const cb of [...listeners]) cb(); }, 1);
    const count = (id: number) => inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const add = (id: number, name: string, amount: number) => {
        const item = inventory.find(i => i.id === id);
        if (item) item.count += amount;
        else inventory.push({ id, name, count: amount, slot: Math.max(...inventory.map(i => i.slot), -1) + 1, optionsWithIndex: [] });
    };
    const s = { name: 'test', tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        ended: new Promise(() => {}), direct: async () => {},
        bankObservation:()=>bankOpen&&!options.unknown?{generation,at:Date.now(),items:bank.map(i=>({...i}))}:undefined, sdk: { getState: state, getInventory: () => inventory, getDialog: () => ({ isOpen: false }),
            getSkill: () => ({ level: options.level ?? 32, baseLevel: 32 }), getSkillXp: () => xp,
            sendUseItemOnItem: async (aSlot:number,bSlot:number) => { const aId=inventory.find(i=>i.slot===aSlot)?.id,bId=inventory.find(i=>i.slot===bSlot)?.id; queued.push(() => {
                if (options.stalled) return;
                if (aId===53 && (bId===40||bId===41||bId===selected?.tip)) {
                    inventory.find(i => i.id === 53)!.count -= 15;
                    inventory.find(i => i.id === bId)!.count -= 15;
                    if (!options.debitOnly) {add(selected?.product??(bId===40?884:886),selected?options.metal+' arrow':bId===40?'Iron arrow':'Steel arrow',15);xp+=selected?15*selected.rawXpPerArrow*25/10:bId===40?937.5:1875;} for(let n=inventory.length-1;n>=0;n--)if(inventory[n]!.count===0)inventory.splice(n,1);if(options.foreignItem)add(9999,'foreign',1);options.afterPaid?.();
                    return;
                }
                inventory.find(i => i.id === 52)!.count -= 15;
                inventory.find(i => i.id === 314)!.count -= 15;
                add(53, 'Headless arrow', 15); xp += 375;
            }); return { success: true }; },
        }, bot: {
            openBank: async () => { bankOpen = true; generation++; return { success: true }; }, closeBank: async () => { bankOpen = false; return { success: true }; },
            withdrawItem: async (item: { id: number }, amount: number) => {
                const source = bank.find(i => i.id === item.id)!;
                const actual = options.partialWithdraw ? 5 : amount;
                source.count -= actual; add(source.id, source.name, actual); generation++;
                return { success: actual === amount, amountWithdrawn: actual };
            },
            depositItem: async (item: Item) => {
                deposits.push(item.id);
                const amount = count(item.id);
                bank.find(i => i.id === item.id)!.count += amount; if(!options.staleDeposit)generation++;
                for (let n = inventory.length - 1; n >= 0; n--) if (inventory[n]!.id === item.id) inventory.splice(n, 1);
                return { success: true, amountDeposited: amount };
            },
        },
    } as unknown as Session;
    return { s, bank, inventory, deposits, stop: () => clearInterval(timer), count };
}
const opts = { cap: 500, maximum: 390, shaftReserve: 200, featherReserve: 100 };

test('full fake-session bank processing proves390new output, XP and untouched kit/reserves', async () => {
    const f = fixture();
    try {
        const r = await runHeadless(f.s, opts);
        expect(r).toMatchObject({ ok: true, made: 390, banked: 390, planned: 390, actions: 26, xpGain: 9750,
            shaftBank: 330, featherBank: 110, headlessBank: 420, heldHeadless: 0, reserveMet: true, preserved: true, targetMet: true, stop: 'max-make', died: false });
        expect(f.inventory.map(i => [i.id, i.count])).toEqual([[995, 5000], [946, 1], [315, 1], [315, 1]]);
        expect(new Set(f.deposits).size).toBe(f.deposits.length);
    } finally { f.stop(); }
});

test('insufficient input cleanly stops without consuming reserves or claiming target success', async () => {
    const f = fixture({ shafts: 200, feathers: 100 });
    try { expect(await runHeadless(f.s, opts)).toMatchObject({ ok: true, made: 0, banked: 0, actions: 0, shaftBank: 200, featherBank: 100, targetMet: false, stop: 'input-insufficient' }); }
    finally { f.stop(); }
});

test('three failed item uses stop once and return all raw inputs to the bank', async () => {
    const f = fixture({ stalled: true });
    try { expect(await runHeadless(f.s, opts)).toMatchObject({ ok: false, made: 0, banked: 0, actions: 3, shaftBank: 720, featherBank: 500, preserved: true, stop: 'no-progress' }); }
    finally { f.stop(); }
});

test('a short withdrawal returns its actual partial quantity without consuming inputs', async () => {
    const f = fixture({ partialWithdraw: true });
    try {
        const r = await runHeadless(f.s, opts);
        expect(r).toMatchObject({ ok: false, made: 0, shaftBank: 720, featherBank: 500, preserved: true });
        expect(r.failure).toContain('withdrawal incomplete');
    } finally { f.stop(); }
});

const steelOpts = { cap: 500, maximum: 15, headlessReserve: 200, tipReserve: 5, outputReserve: 15 };
test('fresh fletcher allocation explicitly permits100/100 reserves and195heads; defaults stay200/100', async () => {
    const f = fixture({ shafts: 295, feathers: 295 });
    try { expect(await runHeadless(f.s, { cap: 500, maximum: 195, shaftReserve: 100, featherReserve: 100 })).toMatchObject({ ok: true, made: 195, banked: 195, xpGain: 4875, shaftBank: 100, featherBank: 100, preserved: true, targetMet: true }); expect(planHeadless(295, 295)).toBe(90); }
    finally { f.stop(); }
});
test('oak plan respects the explicit25 target and exact logs/string reserves', () => {
    expect(planOakBows(50, 556, 25, 10, 500)).toBe(25);
    expect(planOakBows(12, 501, 25, 10, 500)).toBe(1);
    expect(planOakBows(10, 500, 25, 10, 500)).toBe(0);
});
function oakFixture(options: { level?: number; stall?: 'shape' | 'string'; debitOnly?: boolean; noKnife?: boolean; unknown?: boolean; notes?: boolean; shortConversion?: boolean; logs?: number; strings?: number } = {}) {
    type Item = { id: number; count: number; name: string; slot: number };
    const names: Record<number, string> = { 1521: 'Oak logs', 1777: 'Bow string', 56: 'Oak longbow (u)', 845: 'Oak longbow', 946: 'Knife', 995: 'Coins', 315: 'Shrimps' };
    let tick = 0, xp = 5000, generation = 0, open = false;
    const inventory: Item[] = [{ id: 995, name: 'Coins', count: 84, slot: 0 }, { id: 315, name: 'Shrimps', count: 2, slot: 1 }];
    const bank: Item[] = [ { id: 1521, name: names[1521]!, count: options.logs ?? 50, slot: 0 }, { id: 1777, name: names[1777]!, count: options.strings ?? 556, slot: 1 }, { id: 845, name: names[845]!, count: 7, slot: 2 } ];
    if (options.notes) {
        bank[0]!.count = 0; bank[1]!.count = 0; bank[2]!.count = 0;
        inventory.push({ id: 1522, name: 'Oak logs', count: 30, slot: 2 }, { id: 1778, name: 'Bow string', count: 30, slot: 3 });
    }
    if (!options.noKnife) bank.push({ id: 946, name: 'Knife', count: 1, slot: 3 });
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const cb of listeners) cb(); }, 1);
    const count = (id: number) => inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const add = (items: Item[], id: number, amount: number) => {
        if (items === inventory && [1521, 1777, 56, 845].includes(id)) {
            for (let n = 0; n < amount; n++) items.push({ id, count: 1, name: names[id]!, slot: Math.max(-1, ...items.map(i => i.slot)) + 1 });
            expect(items.length).toBeLessThanOrEqual(28);
            return;
        }
        const found = items.find(i => i.id === id);
        if (found) found.count += amount; else items.push({ id, count: amount, name: names[id]!, slot: Math.max(-1, ...items.map(i => i.slot)) + 1 });
    };
    const debit = (id: number) => { const item = inventory.find(i => i.id === id)!; item.count--; if (!item.count) inventory.splice(inventory.indexOf(item), 1); };
    const s = { tick: () => tick, ended: new Promise(() => {}), onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        bankObservation: () => options.unknown || !generation ? null : ({ generation, at: tick, items: bank }), direct: async () => {},
        sdk: { getInventory: () => inventory, getSkillXp: () => xp, getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 10 : options.level ?? 25, baseLevel: name === 'Hitpoints' ? 10 : 25 }),
            getState: () => ({ player: { lifeId: 1, respawnCount: 0 }, bank: { isOpen: open, items: bank }, interface: { isOpen: open } }), getDialog: () => ({ isOpen: false }),
            sendUseItemOnItem: async () => {
                if (options.stall !== 'string') { debit(56); debit(1777); if (!options.debitOnly) { add(inventory, 845, 1); xp += 625; } }
                return { success: true };
            } },
        bot: { openBank: async () => { open = true; generation++; return { success: true }; }, closeBank: async () => { open = false; return { success: true }; },
            withdrawItem: async (item: Item, amount: number) => { item.count -= amount; add(inventory, item.id, amount); generation++; return { success: true }; },
            depositItem: async (item: Item) => { const amount = count(item.id), raw = item.id === 1522 ? 1521 : item.id === 1778 ? 1777 : item.id; add(bank, raw, amount - (options.shortConversion && raw !== item.id ? 1 : 0)); for (let n = inventory.length - 1; n >= 0; n--) if (inventory[n]!.id === item.id) inventory.splice(n, 1); generation++; return { success: true }; },
            fletchLogs: async (product: string) => { expect(product).toBe('Long Bow'); if (options.stall !== 'shape') { debit(1521); add(inventory, 56, 1); xp += 625; } return { success: true }; }
        } } as unknown as Session;
    return { s, stop: () => clearInterval(timer), inventory };
}
const oakOpts = { cap: 600, maximum: 25, logReserve: 25, stringReserve: 500 };
test('oak450 uses bounded inventory batches, banks every new bow and leaves configured stock reserves', async () => {
    expect(planOakBows(450, 475, 450, 0, 25)).toBe(450);
    expect(planOakBows(449, 475, 450, 0, 25)).toBe(449);
    const f = oakFixture({ logs: 450, strings: 475 });
    try { expect(await runOakBows(f.s, { cap: 5000, maximum: 450, logReserve: 0, stringReserve: 25 })).toMatchObject({ ok: true, shaped: 450, made: 450, banked: 450, planned: 450, actions: 900, logsUsed: 450, stringsUsed: 450, xpGain: 562500, logBank: 0, stringBank: 25, targetMet: true, preserved: true }); }
    finally { f.stop(); }
});
test('oak450 requested with only30 available banks30 and stops partial instead of waiting or claiming450', async () => {
    const f = oakFixture({ logs: 30, strings: 55 });
    try { expect(await runOakBows(f.s, { cap: 5000, maximum: 450, logReserve: 0, stringReserve: 25 })).toMatchObject({ ok: true, made: 30, banked: 30, planned: 30, actions: 60, logBank: 0, stringBank: 25, targetMet: false, stop: 'input-insufficient', preserved: true }); }
    finally { f.stop(); }
});
test('oak converts only incoming known notes before planning:30each becomes25new banked bows and5raw of each', async () => {
    const f = oakFixture({ notes: true });
    try { expect(await runOakBows(f.s, { ...oakOpts, logReserve: 5, stringReserve: 5 })).toMatchObject({ ok: true, made: 25, banked: 25, logBank: 5, stringBank: 5, preserved: true, targetMet: true, notesConverted: 60 }); expect(f.inventory.some(i => i.id === 1522 || i.id === 1778)).toBe(false); }
    finally { f.stop(); }
});
test('oak refuses short note conversion before any shaping, rather than resetting its conservation baseline', async () => {
    const f = oakFixture({ notes: true, shortConversion: true });
    try { const r = await runOakBows(f.s, { ...oakOpts, logReserve: 5, stringReserve: 5 }); expect(r.ok).toBe(false); expect(r.actions).toBe(0); expect(r.failure).toContain('note conversion'); }
    finally { f.stop(); }
});
test('oak shapes and strings25, proving both XP stages/debits and exact new bank output while keeping every kit asset', async () => {
    const f = oakFixture();
    try { expect(await runOakBows(f.s, oakOpts)).toMatchObject({ ok: true, shaped: 25, made: 25, banked: 25, planned: 25, shapeXp: 15625, stringXp: 15625, xpGain: 31250, logsUsed: 25, stringsUsed: 25, logBank: 25, stringBank: 531, bowBank: 32, preserved: true, targetMet: true }); }
    finally { f.stop(); }
});
test('oak current skill gate leaves owned inputs banked, without pretending target completion', async () => {
    const f = oakFixture({ level: 24 });
    try { expect(await runOakBows(f.s, oakOpts)).toMatchObject({ ok: true, made: 0, actions: 0, logBank: 50, stringBank: 556, stop: 'skill-required', targetMet: false, preserved: true }); }
    finally { f.stop(); }
});
for (const stall of ['shape', 'string'] as const) test(`oak ${stall} stops after exactly3 unchanged actions and banks remaining materials`, async () => {
    const f = oakFixture({ stall });
    try { expect(await runOakBows(f.s, oakOpts)).toMatchObject({ ok: false, made: 0, banked: 0, actions: stall === 'shape' ? 3 : 4, stop: 'no-progress', preserved: true, targetMet: false }); }
    finally { f.stop(); }
});
test('oak input debit without new bow is failure rather than production or another retry', async () => {
    const f = oakFixture({ debitOnly: true });
    try { expect(await runOakBows(f.s, oakOpts)).toMatchObject({ ok: false, made: 0, banked: 0, shaped: 1, stringsUsed: 1, actions: 2, targetMet: false, preserved: false }); }
    finally { f.stop(); }
});
test('oak refuses unknown bank state and does not manufacture ready inventory', async () => {
    const f = oakFixture({ unknown: true });
    try { expect(await runOakBows(f.s, oakOpts)).toMatchObject({ ok: false, made: 0, actions: 0, targetMet: false }); }
    finally { f.stop(); }
});
test('oak requires an actual owned knife', async () => {
    const f = oakFixture({ noKnife: true });
    try { const r = await runOakBows(f.s, oakOpts); expect(r.ok).toBe(false); expect(r.failure).toContain('owned knife required'); expect(r.actions).toBe(0); }
    finally { f.stop(); }
});
test('steel plans full15 batches within configured input reserves', () => {
    expect(planSteel(390, 20)).toBe(15);
    expect(planSteel(214, 20)).toBe(0);
    expect(planSteel(390, 35, 30, 200, 5)).toBe(30);
});
test('steel proves both debits, new bank delta, actual XP and retained output/kit', async () => {
    const f = fixture({ steel: true, headless: 390 });
    try {
        expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: true, made: 15, banked: 15, actions: 1, xpGain: 1875,
            headlessUsed: 15, tipsUsed: 15, headlessBank: 375, tipBank: 5, arrowBank: 22, heldArrows: 0,
            reserveMet: true, outputReserveMet: true, targetMet: true, preserved: true, stop: 'max-make' });
        expect(f.inventory.map(i => [i.id, i.count])).toEqual([[995, 5000], [946, 1], [315, 1], [315, 1]]);
        expect(new Set(f.deposits).size).toBe(f.deposits.length);
    } finally { f.stop(); }
});
test('steel requires current Fletching30 even when base32 and leaves all inputs banked', async () => {
    const f = fixture({ steel: true, headless: 390, level: 29 });
    try { expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: true, made: 0, actions: 0, headlessBank: 390, tipBank: 20, targetMet: false, stop: 'skill-required' }); }
    finally { f.stop(); }
});
test('steel stops offline when only reserve stock remains', async () => {
    const f = fixture({ steel: true, headless: 200, tips: 5 });
    try { expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: true, made: 0, actions: 0, reserveMet: true, targetMet: false, stop: 'input-insufficient' }); }
    finally { f.stop(); }
});
test('steel three failed uses return every withdrawn input', async () => {
    const f = fixture({ steel: true, headless: 390, stalled: true });
    try { expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: false, made: 0, actions: 3, headlessUsed: 0, tipsUsed: 0, headlessBank: 390, tipBank: 20, stop: 'no-progress', preserved: true }); }
    finally { f.stop(); }
});
test('steel partial withdrawal cleans up without consuming inputs', async () => {
    const f = fixture({ steel: true, headless: 390, partialWithdraw: true });
    try { expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: false, made: 0, actions: 0, headlessBank: 390, tipBank: 20, preserved: true }); }
    finally { f.stop(); }
});
test('steel output floor is explicit and never counts preexisting stock as new production', async () => {
    const f = fixture({ steel: true, headless: 390 });
    try { expect(await runSteel(f.s, { ...steelOpts, outputReserve: 30 })).toMatchObject({ ok: true, made: 15, banked: 15, arrowBank: 22, outputReserveMet: false, targetMet: false }); }
    finally { f.stop(); }
});
test('steel detects debits without output and reports actual loss instead of retrying', async () => {
    const f = fixture({ steel: true, headless: 390, debitOnly: true });
    try { expect(await runSteel(f.s, steelOpts)).toMatchObject({ ok: false, made: 0, banked: 0, actions: 1, headlessUsed: 15, tipsUsed: 15, headlessBank: 375, tipBank: 5 }); }
    finally { f.stop(); }
});

const ironOpts={cap:500,maximum:90,headlessReserve:200,tipReserve:0,outputReserve:0};
test('iron recipe consumes90 of each input, banks90 new arrows and keeps300 headless reserved',async()=>{
 const f=fixture({iron:true,headless:390});try{
  const r=await (runSteel as any)(f.s,ironOpts,'iron');
  expect(r).toMatchObject({ok:true,made:90,banked:90,headlessUsed:90,tipsUsed:90,headlessBank:300,tipBank:0,arrowBank:97,xpGain:5625,targetMet:true,preserved:true});
  expect(f.bank.find(i=>i.id===884)?.count).toBe(97);expect(f.bank.find(i=>i.id===41)?.count).toBe(20);expect(f.bank.find(i=>i.id===886)?.count).toBe(7);
 }finally{f.stop();}
});
test('iron current level14 preserves ingredients; current15 can craft',async()=>{
 for(const level of [14,15]){const f=fixture({iron:true,headless:390,level});try{
  const r=await (runSteel as any)(f.s,ironOpts,'iron');expect(r.made).toBe(level===14?0:90);expect(r.targetMet).toBe(level===15);
 }finally{f.stop();}}
});
test('iron partial stock is explicit best effort and cannot satisfy an exact90 order',async()=>{
 const f=fixture({iron:true,headless:390,tips:75});try{expect(await(runSteel as any)(f.s,ironOpts,'iron')).toMatchObject({ok:true,made:75,banked:75,planned:75,headlessBank:315,tipBank:0,targetMet:false});}finally{f.stop();}
});
test('iron unknown bank is not empty stock and withdraws nothing',async()=>{
 const f=fixture({iron:true,headless:390,unknown:true});try{const r=await(runSteel as any)(f.s,ironOpts,'iron');expect(r.ok).toBe(false);expect(r.made).toBe(0);expect(f.bank.find(i=>i.id===40)?.count).toBe(90);}finally{f.stop();}
});
test('iron debit without product fails after one action without another consumption attempt',async()=>{
 const f=fixture({iron:true,headless:390,debitOnly:true});try{expect(await(runSteel as any)(f.s,ironOpts,'iron')).toMatchObject({ok:false,made:0,actions:1,headlessUsed:15,tipsUsed:15});}finally{f.stop();}
});

test('all six exact native arrow profiles use fifteen-unit bank batches and preserve both reserves',async()=>{
 const expected=[[39,882,1,13],[40,884,15,25],[41,886,30,50],[42,888,45,75],[43,890,60,100],[44,892,75,125]];
 for(const [index,metal]of ARROW_METALS.entries()){const p=nativeArrowProfile(metal);expect([p.tip,p.product,p.level,p.rawXpPerArrow]).toEqual(expected[index]);expect(p.units).toBe(15);expect(p.tipName).toMatch(/arrowtips/);const f=fixture({metal,headless:230,tips:35,level:99});try{const r=await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,exact:{xpRate:25}},metal);expect(r).toMatchObject({ok:true,targetMet:true,made:30,banked:30,actions:2,headlessBank:200,tipBank:5,arrowBank:37});expect(r.xpGain).toBe(30*p.rawXpPerArrow*25/10);}finally{f.stop();}}
});
test('new exact arrow option refuses unknown metal and missing stock; unknown dispatch has one attempt',async()=>{
 expect(()=>nativeArrowProfile('dragon' as any)).toThrow('unsupported');
 for(const metal of ARROW_METALS){const f=fixture({metal,headless:230,tips:5,level:99});try{const r=await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,exact:{xpRate:25}},metal);expect(r.actions).toBe(0);expect(r.targetMet).toBe(false);}finally{f.stop();}}
 const f=fixture({metal:'rune',headless:230,level:99,stalled:true});try{expect(await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,exact:{xpRate:25}},'rune')).toMatchObject({ok:false,actions:1,made:0});}finally{f.stop();}
});

test('exact arrow ledger rejects unrelated paid-pack mutation and never dispatches again',async()=>{const f=fixture({metal:'rune',headless:230,level:99,foreignItem:true});try{const r=await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,exact:{xpRate:25}},'rune');expect(r.ok).toBe(false);expect(r.actions).toBe(1);expect(r.failure).toContain('whole-pack');expect(r).toMatchObject({uncertain:true});}finally{f.stop();}});
test('confirmed arrow stop enters bounded cleanup once and banks only the confirmed first batch',async()=>{let stopped=false,cleanup=0;const f=fixture({metal:'bronze',headless:230,level:99,afterPaid:()=>{stopped=true;}});try{const r=await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,stop:()=>stopped,exact:{xpRate:25,enterCleanup:()=>{cleanup++;}}},'bronze');expect(r).toMatchObject({ok:false,actions:1,made:15,banked:15,headlessBank:215,tipBank:20,arrowBank:22,uncertain:false});expect(cleanup).toBe(1);}finally{f.stop();}});
test('native arrow wrapper refuses missing original ownership before any bank or paid action',async()=>{const f=fixture({metal:'rune',level:99});let calls=0;(f.s as any).client={};(f.s.sdk as any).getEquipment=()=>[];(f.s.sdk as any).getStateAge=()=>0;const original=f.s.sdk.getState;(f.s.sdk as any).getState=()=>({...original(),skills:[]});(f.s.bot as any).openBank=async()=>{calls++;return{success:true};};try{await expect(runNativeArrows(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7},'rune')).rejects.toThrow('original owner');expect(calls).toBe(0);}finally{f.stop();}});

test('wrong declared native XP rate stops after one paid batch without another input or cleanup',async()=>{const f=fixture({metal:'rune',headless:230,level:99});try{const r=await runSteel(f.s,{cap:100,maximum:30,headlessReserve:200,tipReserve:5,outputReserve:7,exact:{xpRate:1}},'rune');expect(r).toMatchObject({ok:false,actions:1,uncertain:true});expect(r.failure).toContain('exact XP');expect(f.count(892)).toBe(15);}finally{f.stop();}});
