import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { botPathOverlays, contentionView, farmsView, hiscoreRows, lookupView, overtakeView, resolveBotDestination, rivalsView, rosterView, valueBoardRows, wildernessBandFor, wildernessInfo, wildernessOverlayData, wildernessView, WILDERNESS_BANDS, WILDERNESS_HOTSPOTS } from './world-view';

const now = 1_000_000;
const roster = new Map([
    ['zezima', { name: 'Zezima', x: 2585, z: 3300, level: 0, combat: 99, seen: now - 1000 }],
    ['mybot', { name: 'MyBot', x: 2583, z: 3296, level: 0, combat: 40, seen: now - 2000 }],
    ['upstairs', { name: 'Upstairs', x: 2582, z: 3297, level: 1, combat: 10, seen: now - 1000 }],
    ['gone', { name: 'Gone', x: 2582, z: 3297, level: 0, combat: 10, seen: now - 60_000 }],
]);
const fleet = new Set(['mybot']);

test('hiscore player rows keep skill boards above level 1', () => {
    const html = '<td>Overall</td> <td>12</td> <td>1,881</td> <td>3h 58m 1s</td> <td>Attack</td> <td>1,234</td> <td>75</td> <td>3h 2m 1s</td> <td>Defence</td> <td>9</td> <td>1</td> <td>5s</td>';
    expect(hiscoreRows(html, ['Overall', 'Attack', 'Defence', 'Magic'])).toEqual([{ board: 'Overall', rank: 12, level: 1881, time: '3h 58m 1s' }, { board: 'Attack', rank: 1234, level: 75, time: '3h 2m 1s' }]);
});
test('the roster lists players seen in the last 30 seconds', () => {
    expect(rosterView(roster, now).map(r => r[0])).toEqual(['MyBot', 'Upstairs', 'Zezima']);
    expect(rosterView(roster, now)[2]).toEqual(['Zezima', 2585, 3300, 0, 99]);
});
test('rivals mark fleet accounts, online players and their tile', () => {
    const v = rivalsView(new Map([['Attack', { at: 5, rows: [{ rank: 1, name: 'Zezima', level: 99, ticks: 100 }, { rank: 2, name: 'MyBot', level: 90, ticks: 200 }, { rank: 3, name: 'Gone', level: 80, ticks: 300 }] }]]), roster, fleet, new Map([['Attack', { rank: 2, name: 'MyBot' }]]), now);
    expect(v[0]!.ours).toEqual({ rank: 2, name: 'MyBot' });
    expect(v[0]!.rows.map(r => [r.name, r.fleet, r.online, r.x])).toEqual([['Zezima', false, true, 2585], ['MyBot', true, true, 2583], ['Gone', false, false, null]]);
});
test('spot contention counts other players near a claimed tile or named spot on its plane', () => {
    const ext = new Map([
        ...roster,
        ['auburyvisitor', { name: 'AuburyVisitor', x: 3253, z: 3403, level: 0, combat: 50, seen: now - 500 }],
    ]);
    const v = contentionView([{ side: 'local', resources: ['knight:2582,3297', 'shop:aubury', 'unknown:place'] }, { bad: 1 }], ext, fleet, now);
    expect(v.find(s => s.resource === 'knight:2582,3297')).toEqual({ side: 'local', resource: 'knight:2582,3297', kind: 'knight', x: 2582, z: 3297, others: ['Zezima'], ours: ['MyBot'] });
    expect(v.find(s => s.resource === 'shop:aubury')).toEqual({ side: 'local', resource: 'shop:aubury', kind: 'shop', x: 3253, z: 3402, others: ['AuburyVisitor'], ours: [] });
    expect(v.find(s => s.resource === 'unknown:place')).toEqual({ side: 'local', resource: 'unknown:place', kind: 'unknown', x: null, z: null, others: [], ours: [] });
});

test('wildernessInfo computes wilderness level and combat bracket for surface and dungeon Wilderness tiles', () => {
    expect(wildernessInfo({ x: 3094, z: 3555, level: 0 }, 90)).toEqual({ wild: 5, minCombat: 85, maxCombat: 95 });
    expect(wildernessInfo({ x: 3100, z: 9928, level: 0 }, 5)).toEqual({ wild: 2, minCombat: 3, maxCombat: 7 });
    expect(wildernessInfo({ x: 3222, z: 3222, level: 0 }, 90)).toEqual({ wild: 0, minCombat: null, maxCombat: null });
    expect(wildernessInfo({ x: 2800, z: 9950, level: 0 }, 90)).toEqual({ wild: 0, minCombat: null, maxCombat: null });
    expect(lookupView('WildyPker', null, null, { x: 3094, z: 3555, level: 0, combat: 100, seen: now - 100 }, now).wild).toEqual({ wild: 5, minCombat: 95, maxCombat: 105 });
});

test('wildernessView lists online Wilderness sightings sorted with rivals first and deeper levels higher', () => {
    const ext = new Map([
        ...roster,
        ['wildy1', { name: 'Wildy1', x: 3094, z: 3555, level: 0, combat: 100, seen: now - 500 }],
        ['deeppk', { name: 'DeepPk', x: 3180, z: 3780, level: 0, combat: 120, seen: now - 500 }],
        ['wildybot', { name: 'MyBot', x: 3100, z: 3600, level: 0, combat: 40, seen: now - 500 }],
        ['stalewild', { name: 'StaleWild', x: 3100, z: 3600, level: 0, combat: 80, seen: now - 60_000 }],
    ]);
    expect(wildernessView(ext, fleet, now).map(r => [r.name, r.fleet, r.wild])).toEqual([
        ['DeepPk', false, 33],
        ['Wildy1', false, 5],
        ['MyBot', true, 11],
    ]);
});
test('a spot that several claims of one side name is listed once; another side keeps its own row', () => {
    const v = contentionView([{ side: 'local', resources: ['knight:2582,3297'] }, { side: 'local', resources: ['knight:2582,3297', 'knight:2582,3297'] }, { side: 'cloud', resources: ['knight:2582,3297'] }], roster, fleet, now);
    expect(v.map(s => s.side + ' ' + s.resource).sort()).toEqual(['cloud knight:2582,3297', 'local knight:2582,3297']);
});
test('a lookup carries the hiscore rows and the last world-feed sighting', () => {
    expect(lookupView('Zezima', [], 7, roster.get('zezima'), now)).toEqual({ name: 'Zezima', at: 7, rows: [], online: true, x: 2585, z: 3300, plane: 0, combat: 99, lastSeen: now - 1000, worn: null, wornAt: null });
    expect(lookupView('Zezima', [], 7, roster.get('zezima'), now, [{ slot: 'Weapon', name: 'Bronze sword' }], 8)).toMatchObject({ worn: [{ slot: 'Weapon', name: 'Bronze sword' }], wornAt: 8 });
    expect(lookupView('Nobody', null, null, undefined, now).online).toBe(false);
});

// The optional eighth argument is the feed observation. Omitting it keeps legacy callers compatible.
const observedLookup=lookupView as (...args:any[])=>any;
const lookupRows=[{board:'Overall',rank:23,level:72,time:'1h'}],lookupWorn=[{slot:'Weapon',name:'Bronze sword'}];
const seenPlayer={x:3200,z:3300,level:2,combat:50,seen:now-1000};

test('explicit fresh lookup feed receipts date positive and negative presence without changing historical facts',()=>{
 for(const feedAt of [now,now-29_999]){
  const present=observedLookup('ProbeFriend',lookupRows,7,seenPlayer,now,lookupWorn,8,feedAt);
  expect(present).toMatchObject({online:true,presenceObservedAt:feedAt,rows:lookupRows,at:7,worn:lookupWorn,wornAt:8,lastSeen:seenPlayer.seen,x:3200,z:3300});
  for(const seen of [undefined,{...seenPlayer,seen:now-60_000}]){
   const absent=observedLookup('ProbeFriend',lookupRows,7,seen,now,lookupWorn,8,feedAt);
   expect(absent).toMatchObject({online:false,presenceObservedAt:feedAt,rows:lookupRows,worn:lookupWorn});
  }
 }
});

test('explicit unknown, stale, invalid and future lookup feed observations cannot assert positive or negative presence',()=>{
 for(const feedAt of [null,undefined,0,-1,NaN,Infinity,String(now),now+1,now-30_000])for(const seen of [undefined,seenPlayer,{...seenPlayer,seen:now-60_000}]){
  const value=observedLookup('ProbeFriend',lookupRows,7,seen,now,lookupWorn,8,feedAt);
  expect(value).toMatchObject({online:null,presenceObservedAt:null,name:'ProbeFriend',at:7,rows:lookupRows,worn:lookupWorn,wornAt:8,lastSeen:seen?.seen??null});
 }
});

test('a fresh lookup feed does not make invalid, future or expired player sightings positive',()=>{
 for(const seen of [0,-1,undefined,null,NaN,Infinity,String(now),now+1,now-30_000]){
  expect(observedLookup('ProbeFriend',lookupRows,7,{...seenPlayer,seen},now,null,null,now).online).not.toBe(true);
 }
 // Existing callers with no feed argument retain the exact legacy shape, including explicit empty hiscores.
 expect(lookupView('Nobody',[],7,undefined,now)).toEqual({name:'Nobody',at:7,rows:[],online:false,x:null,z:null,plane:null,combat:null,lastSeen:null,worn:null,wornAt:null});
});

const serverSource=readFileSync(new URL('./server/routes.ts',import.meta.url),'utf8');
const playerRouteAt=serverSource.indexOf("        if (url.pathname === '/api/player') {"),playerRouteEnd=serverSource.indexOf("        if (url.pathname === '/api/viewer-health')",playerRouteAt);
if(playerRouteAt<0||playerRouteEnd<0)throw Error('Missing native player lookup route');
const playerRoute=serverSource.slice(playerRouteAt,playerRouteEnd);

async function nativeLookup(world:any,seen:any,name='ProbeFriend'){
 let calls=0;
 const hit={name:'ProbeFriend',rows:lookupRows,at:7,worn:lookupWorn,wornAt:8};
 const env={url:new URL('http://dashboard.test/api/player?name='+encodeURIComponent(name)),MAIN:'PrivateMain',world,roster:new Map(seen?[['probefriend',seen]]:[]),lookupView,Date:{now:()=>now},Response,
  lookupPlayer:async()=>{calls++;return hit;}};
 const response=await new Function(...Object.keys(env),playerRoute)(...Object.values(env)) as Response;
 return {status:response.status,body:await response.json(),calls};
}

test('the native lookup endpoint binds presence to the actual connected feed observation',async()=>{
 for(const world of [{connected:true,tickAt:now-1000},{connected:true,tickAt:now-40_000},{connected:true,tickAt:0},{connected:true,tickAt:undefined},{connected:true,tickAt:now+1},{connected:false,tickAt:now-1000}])for(const seen of [undefined,seenPlayer]){
  const endpoint=await nativeLookup(world,seen),fresh=world.connected&&world.tickAt===now-1000;
  expect(endpoint.status).toBe(200);expect(endpoint.calls).toBe(1);
  for(const value of [endpoint.body])expect(value).toMatchObject({online:fresh?!!seen:null,presenceObservedAt:fresh?now-1000:null,at:7,rows:lookupRows,worn:lookupWorn,wornAt:8});
 }
});

test('native player-route validation and hidden-account privacy run before lookup or presence projection',async()=>{
 for(const name of ['PrivateMain','pRiVaTe_MaIn']){
  const result=await nativeLookup({connected:true,tickAt:now},seenPlayer,name);expect(result.status).toBe(404);expect(result.calls).toBe(0);expect(result.body).toEqual({error:'not available'});
 }
 const invalid=await nativeLookup({connected:true,tickAt:now},seenPlayer,'<invalid>');expect(invalid.status).toBe(400);expect(invalid.calls).toBe(0);expect(invalid.body).not.toHaveProperty('rows');
});

test('death-recap route blocks normalized variants of the hidden main account',async()=>{
 const start=serverSource.indexOf("        if (url.pathname === '/api/death-recap') {"),end=serverSource.indexOf("        if (url.pathname === '/api/hidden-names')",start);
 const route=serverSource.slice(start,end);
 for(const name of ['PrivateMain','Private_Main','Private Main','<bad>']){
  let called=false;
  const env={url:new URL('http://dashboard.test/api/death-recap?name='+encodeURIComponent(name)),MAIN:'PrivateMain',Response,recapCache:new Map(),root:'',world:{tickMs:400},isLocalServer:()=>false,deathRecap:()=>{called=true;return null;}};
  const res=await new Function(...Object.keys(env),route)(...Object.values(env)) as Response;
  expect(res.status).toBe(404);
  expect(called).toBe(false);
 }
});

test('farms group numbered series and random names, without fleet accounts, and count them at our spots', () => {
    const r = new Map<string, any>([
        ...[1, 2, 3, 40].map(i => [`money ${i}`, { name: `Money ${String(i).padStart(2, '0')}`, x: 2660, z: 3300, level: 0, combat: 3, seen: now }] as [string, any]),
        ...['671nb2fxy', '6728br6td', '67297mfwb'].map(n => [n, { name: n, x: 1, z: 2, level: 0, combat: 3, seen: now }] as [string, any]),
        ['mmthv2350', { name: 'mmthv2350', x: 1, z: 2, level: 0, combat: 3, seen: now }], ['solo1', { name: 'Solo1', x: 1, z: 2, level: 0, combat: 3, seen: now }],
    ]);
    const f = farmsView(r, new Set(['mmthv2350']), [{ resource: 'knight:2660,3300', others: ['Money 01', 'Money 02', 'Zed'] }], now);
    expect(f.map(g => [g.label, g.count])).toEqual([['Money ##', 4], ['67… (9 characters, random)', 3]]);
    expect(f[0]!.range).toEqual([1, 40]);expect(f[0]!.atSpots).toEqual([{ resource: 'knight:2660,3300', count: 2 }]);
    expect(f.flatMap(g => g.names)).not.toContain('mmthv2350');
});
test('overtake gives the XP and hours to pass the next rows; a 99 that is slower needs a new account', () => {
    const xpFor = (l: number) => l * 1000;
    const tops = new Map([['Attack', { rows: [{ rank: 1, name: 'Top', level: 99, ticks: 9000 }, { rank: 2, name: 'Next', level: 80, ticks: 5000 }, { rank: 3, name: 'Same', level: 70, ticks: 100 }] }], ['Overall', { rows: [] }]]);
    const acct = { name: 'Mine', skills: [{ name: 'Attack', level: 70, xp: 70_500 }], ranks: [{ board: 'Attack', rank: 4, level: 70, time: '1h 0m 0s' }], goalSkill: 'Attack', xpPerHour: 4750 };
    const [v] = overtakeView(tops, [acct], xpFor);
    expect([v.board, v.account, v.rank, v.seconds, v.xpPerHour]).toEqual(['Attack', 'Mine', 4, 3600, 4750]);
    expect(v.targets.map((x: any) => [x.rank, x.newAccount, x.goal, x.xpNeeded, x.hours])).toEqual([[3, false, 71, 500, 500 / 4750], [1, true, null, null, null]]);
    const maxed = overtakeView(tops, [{ ...acct, skills: [{ name: 'Attack', level: 99, xp: 99_000 }], ranks: [{ board: 'Attack', rank: 2, level: 99, time: '9h 0m 0s' }] }], xpFor)[0];
    expect(maxed.targets).toEqual([{ rank: 1, name: 'Top', level: 99, seconds: 3600, newAccount: true, goal: null, xpNeeded: null, hours: null, deadline: null }]);
    // Our 1 h of board time is already over theirs (800 s): level 80 does not pass them, 81 does; a 99 we are slower than needs a new account.
    const slow = overtakeView(new Map([['Attack', { rows: [{ rank: 1, name: 'Top', level: 99, ticks: 7500 }, { rank: 2, name: 'Quick', level: 80, ticks: 2000 }] }]]), [acct], xpFor)[0];
    expect(slow.targets.map((x: any) => [x.name, x.goal, x.newAccount])).toEqual([['Quick', 81, false], ['Top', null, true]]);
    // With time to spare, their level is enough, before the deadline: 10 XP at 4,750 XP/hr is about 8 s; 2 h are left.
    const roomy = overtakeView(new Map([['Attack', { rows: [{ rank: 1, name: 'Far', level: 71, ticks: 27000 }] }]]), [{ ...acct, skills: [{ name: 'Attack', level: 70, xp: 70_990 }] }], xpFor)[0].targets[0];
    expect([roomy.goal, roomy.xpNeeded, roomy.deadline]).toEqual([71, 10, 7200]);
    expect(overtakeView(tops, [{ ...acct, goalSkill: 'Mining' }], xpFor)[0].targets[1].hours).toBeNull();
});

test('value boards: rank, name and exact value per row; only the first table (Runite adds This week and Today)', () => {
    const row = (rank: number, name: string, cell: string, img = '') => `<tr>\n<td align="right">${rank}</td>\n${img}<td><a href="/hiscores/player/${name}?profile=main" class="c">${name}</a></td>\n${cell}\n</tr>`;
    const outfit = row(1, 'soko', '<td align="right" class="yellow" title="1,366,450 gp">1366K</td>', '<td><img src="/sprite/player/x.png"></td>\n') + row(2, 'brotha', '<td align="right" class="yellow" title="1,149,713 gp">1149K</td>');
    expect(valueBoardRows('<table>' + outfit + '</table>')).toEqual([{ rank: 1, name: 'soko', value: 1366450, text: '1366K' }, { rank: 2, name: 'brotha', value: 1149713, text: '1149K' }]);
    const runite = row(1, 'xulvexi', '<td align="right" class="yellow">2,463</td>') + row(2, 'goo001', '<td align="right" class="yellow">1,948</td>') + row(1, 'ukwih8pbm', '<td align="right" class="yellow">338</td>');
    expect(valueBoardRows(runite).map(r => [r.rank, r.name, r.value])).toEqual([[1, 'xulvexi', 2463], [2, 'goo001', 1948]]);
});

test('wilderness danger bands, rev-289 hotspots and bot pathing overlays obey boundaries and main-account hiding', () => {
    expect(WILDERNESS_BANDS.map(b => [b.id, b.minWild, b.maxWild, b.zMin, b.zMax])).toEqual([
        ['tele', 1, 20, 3520, 3680],
        ['glory', 21, 30, 3680, 3760],
        ['deep', 31, 56, 3760, 3968],
    ]);
    expect(WILDERNESS_HOTSPOTS.map(h => h.id)).toEqual([
        'edgeville-ditch', 'chaos-temple', 'green-dragons', 'lava-maze', 'rogues-castle', 'mage-bank',
    ]);
    for (const h of WILDERNESS_HOTSPOTS) expect(wildernessInfo(h).wild).toBe(h.wild);
    expect(wildernessBandFor({ x: 3094, z: 3679, level: 0 })?.id).toBe('tele');
    expect(wildernessBandFor({ x: 3094, z: 3680, level: 0 })?.id).toBe('glory');
    expect(wildernessBandFor({ x: 3094, z: 3759, level: 0 })?.id).toBe('glory');
    expect(wildernessBandFor({ x: 3094, z: 3760, level: 0 })?.id).toBe('deep');
    expect(wildernessBandFor({ x: 3222, z: 3222, level: 0 })).toBeNull();

    expect(resolveBotDestination({ target: { x: 3067, z: 3856, level: 0, label: 'Lava Maze' } })).toEqual({ x: 3067, z: 3856, level: 0, label: 'Lava Maze' });
    expect(resolveBotDestination({ spot: 'shop:aubury' })).toEqual({ x: 3253, z: 3402, level: 0, label: 'shop:aubury' });
    expect(resolveBotDestination({ goal: 'Green Dragons hunt', phase: 'patrol' })).toEqual({ x: 3092, z: 3810, level: 0, label: 'Green Dragons' });

    const bots = [
        { name: 'Haggis', pos: { x: 3094, z: 3490, level: 0 }, target: { x: 3236, z: 3610, label: 'Chaos Temple' } },
        { name: 'Roamer1', pos: { x: 3094, z: 3530, level: 0 }, phase: 'heading to Mage Bank' },
        { name: 'PracticeBot', practice: true, pos: { x: 3094, z: 3530, level: 0 }, target: { x: 3067, z: 3856 } },
    ];
    expect(botPathOverlays(bots).map(p => [p.name, p.band, p.wild, p.label])).toEqual([
        ['main', 'tele', 12, 'Chaos Temple'],
        ['Roamer1', 'deep', 55, 'Mage Bank / Arena'],
    ]);
    expect(botPathOverlays(bots, { publicView: true }).map(p => p.name)).toEqual(['Roamer1']);
    expect(wildernessOverlayData().hotspots).toHaveLength(6);
});
