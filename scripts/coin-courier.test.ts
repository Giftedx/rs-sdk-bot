import { beforeAll, test, expect } from 'bun:test';
import { parseCoins, exactCoinDelta, coinTradeObservation, meetingTiles, prepareCoinSlot } from './coin-courier';
import type { Session } from '../packages/core/src/inprocess';
import { loadPathfinding } from '../packages/core/src/pathcache';

// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts). The snapshot loader makes
// the same grid first, so the call in the test returns at once.
beforeAll(async () => { await loadPathfinding(); }, 120_000);

test('full donor banks an unrelated item before exact 45000-coin withdrawal', async () => {
    let pack = [{ id: 1446, name: 'Body talisman', count: 1, slot: 0 },
        ...Array.from({ length: 27 }, (_, slot) => ({ id: 1436, name: 'Rune essence', count: 1, slot: slot + 1 }))];
    let bank = [{ id: 995, name: 'Coins', count: 50000 }], generation = 1, deposits = 0;
    const session = {
        name: 'Giver', tick: () => generation, sdk: { getInventory: () => pack, getState: () => ({ inventory: pack }) },
        bankObservation: () => ({ generation, items: bank }),
        bot: {
            depositItem: async (item: typeof pack[number], amount: number) => {
                expect(item.id).toBe(1446); expect(amount).toBe(-1); deposits++;
                pack = pack.filter(i => i.id !== item.id); bank.push({ id: item.id, name: item.name, count: 1 }); generation++;
                return { success: true };
            },
            withdrawItem: async (_item: RegExp, amount: number) => {
                if (pack.length >= 28 && !pack.some(i => i.id === 995)) throw Error('no inventory space');
                bank[0]!.count -= amount; pack.push({ id: 995, name: 'Coins', count: amount, slot: 0 }); generation++;
            },
        },
    } as unknown as Session;
    await prepareCoinSlot(session, () => {});
    expect(pack.length).toBe(27);
    expect(bank.find(i => i.id === 1446)?.count).toBe(1);
    const before = { bank: bank[0]!.count, pack: 0 };
    await session.bot.withdrawItem(/^Coins$/, 45000);
    expect(bank[0]!.count).toBe(before.bank - 45000);
    expect(pack.find(i => i.id === 995)?.count).toBe(45000);
    expect(pack.filter(i => i.id === 1436).length).toBe(27);
    await prepareCoinSlot(session, () => {});
    expect(deposits).toBe(1); // A full pack with a coin stack needs no further deposit.
});

test('trade diagnostics retain unreachable counter geometry and exact holdings', () => {
    const trade = { isOpen: false, screen: null, partner: null, myAccepted: false, partnerAccepted: false, myOffer: [], theirOffer: [] };
    const session = {
        name: 'Giver', tick: () => 30,
        bankObservation: () => ({ generation: 3, items: [{ id: 995, count: 37655 }] }),
        sdk: {
            getState: () => ({ player: { worldX: 3186, worldZ: 3437, level: 0 }, bank: { isOpen: false }, secret: 'do not log' }),
            getInventory: () => [{ id: 995, count: 12354 }, { id: 1265, count: 1 }],
            getTradeState: () => trade,
            findNearbyPlayer: (pattern: RegExp) => {
                expect(pattern.test('Taker')).toBe(true);
                expect(pattern.test('Taker2')).toBe(false);
                return { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false };
            },
        },
    } as unknown as Session;
    expect(coinTradeObservation(session, 'Taker')).toEqual({
        account: 'Giver', tick: 30, position: { x: 3186, z: 3437, level: 0 },
        partner: { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false },
        bankOpen: false, bank: { generation: 3, coins: 37655 }, pack: 12354, trade,
    });
});

test('trade diagnostics keep missing entry evidence explicit', () => {
    const session = {
        name: 'Giver', tick: () => 0,
        sdk: { getState: () => null, getInventory: () => [], findNearbyPlayer: () => null, getTradeState: () => ({ isOpen: false }) },
    } as unknown as Session;
    expect(coinTradeObservation(session, 'Taker')).toMatchObject({ position: null, partner: null, bankOpen: null, bank: null, pack: 0 });
});

test('named consumer retains its CLI and shared bank', () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    expect(c.amount).toBe(2000000);
    expect([c.x, c.z]).toEqual([3185, 3436]);
});
test('meeting tiles are adjacent public floor joined to the bank tile, off the booth counter', async () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    const [a, b] = meetingTiles(c)!;
    expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBe(1);
    expect([a, b].every(t => t.level === 0 && t.x <= 3184)).toBe(true);
    expect(meetingTiles({ x: 3253, z: 3420 })).toBeNull();
    const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
    pf.initPathfinding();
    const joined = (from: { x: number; z: number }, to: { x: number; z: number }) => pf.findLongPath(0, from.x, from.z, to.x, to.z, 500)?.at(-1);
    for (const t of [a, b]) {
        expect(pf.isTileWalkable(0, t.x, t.z)).toBe(true);
        expect(joined({ x: c.x, z: c.z }, t)).toMatchObject({ x: t.x, z: t.z });
    }
    expect(joined(a, b)).toMatchObject({ x: b.x, z: b.z });
    // A tile behind the counter has no route to the meeting floor.
    expect(joined({ x: 3186, z: 3437 }, a)).not.toMatchObject({ x: a.x, z: a.z });
}, 60000);
test('amount, identity and bounds fail before login', () => {
    for (const amount of ['0', '-1', '1.5', 'NaN', '2147483648']) expect(() => parseCoins(['Giver', 'Taker', amount])).toThrow();
    expect(() => parseCoins(['Giver', 'giver', '1'])).toThrow();
    expect(() => parseCoins(['Haggis', 'Taker', '1'])).toThrow();
    expect(() => parseCoins(['Giver', 'Taker', '1', '--notes'])).toThrow();
});
test('both bank deltas must match, with original pocket coins retained', () => {
    const before = [{ bank: 3000, pack: 9 }, { bank: 50, pack: 7 }];
    const after = [{ bank: 2000, pack: 9 }, { bank: 1050, pack: 7 }];
    expect(exactCoinDelta(before, after, 1000)).toBe(true);
    expect(exactCoinDelta(before, [{ bank: 2000, pack: 9 }, { bank: 50, pack: 1007 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [{ bank: 1999, pack: 10 }, after[1]!], 1000)).toBe(false);
    expect(exactCoinDelta(before, [after[0]!, { bank: 1051, pack: 6 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [], 1000)).toBe(false);
});

test('owned coin endpoints reach the stack, new profiles, registration and every worker child',async()=>{
 const {selectCoinProofEndpoints,coinProofAccountEnv,startCoinProofStack,coinChildConfiguration,coinRegistrationArgs}=await import('../packages/practice/src/coin-courier-proof');
 const checked:number[]=[],samples=[0,0.01];
 const p=selectCoinProofEndpoints(port=>{checked.push(port);return port!==20003;},()=>samples.shift()!);
 expect(checked).toEqual([20000,20001,20002,20003,20200,20201,20202,20203]);
 expect(p.ports).toEqual({engine:20200,gateway:20201,management:20202,tcp:20203});
 expect(p.instance).toMatch(/^coin-[a-z0-9-]{1,25}$/);
 const original='SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nPASSWORD=fixture\r\n';
 const configured=coinProofAccountEnv(original,p);
 expect(configured).toContain(`SERVER=${p.server}\r\n`);
 expect(configured).toContain(`GATEWAY_URL=${p.gateway}\r\n`);
 expect(configured).toContain('PASSWORD=fixture\r\n');
 expect(()=>coinProofAccountEnv(original.replace('localhost:8888','rs-sdk-demo.fly.dev'),p)).toThrow('new practice account required');
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 let stops=0;
 const owned={logs:{engine:'',gateway:''},stop:async()=>{stops++;}};
 const stack=await startCoinProofStack(p,async opts=>{
  expect(opts).toEqual({ports:p.ports,instance:p.instance,tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [k,v] of Object.entries(p.env))expect(process.env[k]).toBe(v);
  return owned;
 });
 expect(stack).toBe(owned);await stack.stop();expect(stops).toBe(1);
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 await expect(startCoinProofStack(p,async()=>{throw Error('startup refused');})).rejects.toThrow('startup refused');
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 const registration=coinRegistrationArgs('fixture',p);
 expect(registration[0]).toBe('--eval');
 expect(registration[1]).toContain(JSON.stringify(`SERVER=${p.server}`));
 expect(registration[1]).toContain(JSON.stringify(`GATEWAY_URL=${p.gateway}`));
 expect(registration[1]).toContain('openBot(');
 expect(registration[1]).toContain('finish([session]');
 for(const args of [registration,['scripts/coin-courier.ts','donor','receiver','12345']]){
  const child=coinChildConfiguration(args,{CAP:'1600'},p,{GATEWAY_URL:'ws://localhost:7780',WEB_MANAGEMENT_PORT:'8898',ENGINE_MANAGEMENT_URL:'http://localhost:8898',NODE_PORT:'43594',GE_DATABASE:'data/market.sqlite'});
  expect(child.cmd).toEqual(['bun',...args]);
  expect(child.env).toMatchObject({...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'1600'});
  expect(child.env.GE_DATABASE).toBe(`data/market-${p.instance}.sqlite`);
  expect(child.env.ENGINE_MANAGEMENT_URL).toBe(`http://127.0.0.1:${p.ports.management}`);
  expect(child.windowsHide).toBe(true);
 }
 expect(()=>selectCoinProofEndpoints(()=>false,()=>0)).toThrow('owned practice ports unavailable');
});
