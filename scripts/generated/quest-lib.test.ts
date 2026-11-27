import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BotSDK} from '../../vendor/rs-sdk/sdk';
import {
 BURST_SETTLE_TICKS,
 BUTTON_CONTINUE,
 BUTTON_OK,
 CHOICE_ROOTS,
 CONTINUE_ROOTS,
 clickDialoguePage,
 converseDialogue,
 createDialogueBurster,
 isContinueOnlyOptions,
 liveDialoguePage,
 type DialoguePage,
} from './quest-lib';

test.each([
 "You're a sailor? Could you take me to the island of Crandor?",
 'Yes (take all) + [one] \\ two.*',
])('a selected dialogue answer stays literal through SDK matching: %s', async text => {
 const sdk=Object.create(BotSDK.prototype) as BotSDK;
 const actions:unknown[]=[];
 Object.assign(sdk,{state:{dialog:{isOpen:true,pageId:'page-7',options:[{text,index:2,componentId:2496}]}},
  sendAction:async(action:unknown)=>{actions.push(action);return{success:true};}});
 expect(await clickDialoguePage(sdk,{text})).toEqual({success:true});
 expect(actions).toEqual([{type:'clickDialogOption',optionIndex:2,guard:{pageId:'page-7',componentId:2496},reason:'SDK'}]);
});

test('literal dialogue selection keeps a stale page refusal without an index fallback', async () => {
 const text='Take one (1)?';
 const sdk=Object.create(BotSDK.prototype) as BotSDK;
 const actions:unknown[]=[];
 const refusal={success:false,reason:'stale_dialog',message:'page changed'};
 Object.assign(sdk,{state:{dialog:{isOpen:true,pageId:'page-7',options:[{text,index:2,componentId:2496}]}},
  sendAction:async(action:unknown)=>{actions.push(action);return refusal;}});
 expect(await clickDialoguePage(sdk,{text})).toBe(refusal);
 expect(actions).toHaveLength(1);
 expect(actions[0]).toMatchObject({type:'clickDialogOption',guard:{pageId:'page-7',componentId:2496}});
});

test('quest handoff belongs only to its matching named or explicit session',()=>{
 const root=resolve(import.meta.dir,'../..');
 const bot=pathToFileURL(resolve(root,'packages/core/src/bot.ts')).href;
 const library=pathToFileURL(resolve(root,'scripts/generated/quest-lib.ts')).href;
 const code=`import {mock} from 'bun:test';import assert from 'node:assert/strict';
 const botUrl=${JSON.stringify(bot)},libraryUrl=${JSON.stringify(library)};
 const actual=await import(botUrl);let opened=[];let tick=0;const callbacks=new Set();
 const make=name=>({name,tick:()=>tick,ended:new Promise(()=>{}),onTick:cb=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getState:()=>({player:{lifeId:1,respawnCount:0,worldX:2548,worldZ:3119,level:0},inventory:[],recentDialogs:[],gameMessages:[]}),getInventory:()=>[],getDialog:()=>({isOpen:false}),getSkill:()=>({level:99,baseLevel:99}),getSkillXp:()=>0},direct:async()=>{throw Error('first-owned-direct:'+name);}});
 const main=make('Main'),helper=make('Helper');
 mock.module(botUrl,()=>({...actual,openBot:async name=>{opened.push(name);assert.equal(name,'Helper');return helper;}}));
 const {openQuest}=await import(libraryUrl);
 const cases=[{options:{session:helper},selected:'Helper',acks:0,opened:[]},{options:{name:'Helper'},selected:'Helper',acks:0,opened:['Helper']},{options:{name:'main'},selected:'Main',acks:1,opened:[]},{options:{session:main},selected:'Main',acks:1,opened:[]},{options:{},selected:'Main',acks:1,opened:[]}];
 const timer=setInterval(()=>{tick++;for(const cb of callbacks)cb();},1);
 try{for(const c of cases){let acks=0;opened=[];globalThis.QUEST_SESSION=main;globalThis.QUEST_SESSION_TAKEN=()=>{acks++;delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;};await assert.rejects(openQuest(c.options),new RegExp('first-owned-direct:'+c.selected));assert.equal(acks,c.acks);assert.deepEqual(opened,c.opened);if(!c.acks)assert.equal(globalThis.QUEST_SESSION,main);delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;}opened=[];await assert.rejects(openQuest({name:'Helper'}),/first-owned-direct:Helper/);assert.deepEqual(opened,['Helper']);console.log('QUEST_HANDOFF_OWNER_SIX_CASES');}finally{clearInterval(timer);delete globalThis.QUEST_SESSION;delete globalThis.QUEST_SESSION_TAKEN;}`;
 const result=Bun.spawnSync(['bun','-e',code],{cwd:root,env:{...process.env,Q_BURST:'0'},stdout:'pipe',stderr:'pipe',timeout:30000,windowsHide:true});
 if(result.exitCode!==0)throw Error(result.stderr.toString()||result.stdout.toString());
 expect(result.exitCode).toBe(0);expect(result.stdout.toString()).toContain('QUEST_HANDOFF_OWNER_SIX_CASES');
});

test('burst guards reject empty options, choice modals, input prompts, and non-continue chat roots', () => {
 expect(CONTINUE_ROOTS.size).toBeGreaterThan(0);
 expect(CHOICE_ROOTS.size).toBeGreaterThan(0);
 for (const id of CHOICE_ROOTS) expect(CONTINUE_ROOTS.has(id)).toBe(false);

 expect(isContinueOnlyOptions([])).toBe(false);
 expect(isContinueOnlyOptions([{ text: 'Click here to continue', buttonType: BUTTON_OK }])).toBe(false);
 expect(isContinueOnlyOptions([{ text: 'Click here to continue', buttonType: 3 }], true)).toBe(false);
 expect(isContinueOnlyOptions([{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }], true)).toBe(true);

 const continueRoot = [...CONTINUE_ROOTS][0]!;
 const choiceRoot = [...CHOICE_ROOTS][0]!;
 const writes: number[] = [];
 let liveOptions: Array<{ text: string; buttonType?: number }> = [];
 const client = {
  chatModalId: continueRoot,
  resumedPauseButton: false,
  dialogInputOpen: false,
  writeOpcode: (op: number) => { writes.push(op); },
  out: { p2: () => {} },
  getDialogOptions: () => liveOptions,
 };
 const burster = createDialogueBurster({
  enabled: true,
  client: () => client,
  tick: () => 10,
  textSeq: () => 1,
  continueRoots: CONTINUE_ROOTS,
 });
 const sdkPage: DialoguePage = {
  isOpen: true,
  isWaiting: false,
  options: [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }],
 };

 burster.begin(true);
 // Empty live options (P_COUNTDIALOG or loading frame) refuses burst.
 expect(burster.tryBurst(sdkPage, undefined, false)).toBe(false);

 // Input dialog open refuses burst even when options look like continue.
 liveOptions = [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }];
 client.dialogInputOpen = true;
 expect(burster.tryBurst(sdkPage, undefined, false)).toBe(false);
 client.dialogInputOpen = false;

 // Non-continue chat root refuses burst.
 client.chatModalId = choiceRoot;
 expect(burster.tryBurst(sdkPage, undefined, false)).toBe(false);
 client.chatModalId = continueRoot;

 // BUTTON_OK option on live page refuses burst even if text mentions continue.
 liveOptions = [{ text: 'Click here to continue', buttonType: BUTTON_OK }];
 expect(burster.tryBurst(sdkPage, undefined, false)).toBe(false);

 // Genuine continue root + continue button bursts cleanly and latches resumedPauseButton.
 liveOptions = [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }];
 expect(burster.tryBurst(sdkPage, undefined, false)).toBe(true);
 expect(writes).toHaveLength(5);
 expect(client.resumedPauseButton).toBe(true);
});

test('stopOpen=true disables burst and inspects every single-step dialogue page in place', async () => {
 const rootId = [...CONTINUE_ROOTS][0]!;
 let tick = 0;
 let page = 0;
 let bursts = 0;
 const clicks: number[] = [];
 const pages = [
  'Speak to Bravek if you need help.',
  'He really needs to take his medicine.',
  'Come back later.',
 ];
 const client = {
  chatModalId: rootId,
  resumedPauseButton: false,
  writeOpcode: () => { bursts++; },
  out: { p2: () => {} },
  getDialogOptions: () => [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }],
 };
 const burster = createDialogueBurster({
  enabled: true,
  client: () => client,
  tick: () => tick,
  textSeq: () => page + 1,
  continueRoots: CONTINUE_ROOTS,
  onBurst: () => { bursts++; },
 });
 burster.begin(false);
 const ok = await converseDialogue({
  tick: () => tick,
  stopped: () => false,
  guard: async () => {},
  dialog: () => ({ isOpen: true, isWaiting: false, options: [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }] }),
  live: () => liveDialoguePage(client),
  click: async () => { clicks.push(page); page++; return { success: true }; },
  wait: async () => { tick++; },
  fail: async msg => { throw Error(msg); },
  log: () => {},
  planGrace: () => false,
  settleBurst: () => { burster.settle(); },
  burst: (opt, choice, dlg) => burster.tryBurst(dlg, opt, choice),
 }, [], () => /really needs to/i.test(pages[page] ?? ''), 20, { allowBurst: false });

 expect(ok).toBe(true);
 expect(bursts).toBe(0);
 expect(clicks).toEqual([0]);
 expect(page).toBe(1);
});

test('burst transitions cleanly into choice dialog and falls back on unchanged reopen or settlement delay', async () => {
 const continueRoot = [...CONTINUE_ROOTS][0]!;
 const choiceRoot = [...CHOICE_ROOTS][0]!;
 // Part A: unchanged reopen on tick+1 falls back to single-step instead of looping bursts.
 let tick = 0;
 let seq = 1;
 let burstCount = 0;
 let clicks = 0;
 const client = {
  chatModalId: continueRoot,
  resumedPauseButton: false,
  writeOpcode: () => {},
  out: { p2: () => {} },
  getDialogOptions: () => [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }],
 };
 const burster = createDialogueBurster({
  enabled: true,
  client: () => client,
  tick: () => tick,
  textSeq: () => seq,
  continueRoots: CONTINUE_ROOTS,
  onBurst: () => { burstCount++; },
 });
 const fallbackReasons: string[] = [];
 burster.begin(true);
 const unchangedOk = await converseDialogue({
  tick: () => tick,
  stopped: () => false,
  guard: async () => {},
  dialog: () => ({ isOpen: true, isWaiting: client.resumedPauseButton, options: [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }] }),
  live: () => liveDialoguePage(client),
  click: async () => { clicks++; seq++; return { success: true }; },
  wait: async () => {
   tick++;
   // Server clears resumedPauseButton without advancing textSeq -> unchanged reopen.
   if (tick === 1) client.resumedPauseButton = false;
  },
  fail: async msg => { throw Error(msg); },
  log: () => {},
  planGrace: () => false,
  settleBurst: () => { const r = burster.settle(); if (r.reason) fallbackReasons.push(r.reason); },
  burst: (opt, choice, dlg) => burster.tryBurst(dlg, opt, choice),
 }, [], () => seq >= 3, 20);
 expect(unchangedOk).toBe(true);
 expect(burstCount).toBe(1);
 expect(clicks).toBe(2);
 expect(fallbackReasons).toEqual(['unchanged']);

 // Part B: stuck settlement clears resumedPauseButton after BURST_SETTLE_TICKS and completes single-step + choice.
 tick = 0; seq = 1; burstCount = 0; clicks = 0; fallbackReasons.length = 0;
 client.chatModalId = continueRoot;
 client.resumedPauseButton = false;
 const liveOpts = [{ text: 'Click here to continue', buttonType: BUTTON_CONTINUE }];
 client.getDialogOptions = () => liveOpts;
 burster.begin(true);
 const delayedOk = await converseDialogue({
  tick: () => tick,
  stopped: () => false,
  guard: async () => {},
  dialog: () => ({
   isOpen: client.chatModalId !== -1,
   isWaiting: client.resumedPauseButton,
   options: liveOpts,
  }),
  live: () => liveDialoguePage(client),
  click: async opt => {
   clicks++;
   if (opt?.text === 'Yes') { client.chatModalId = -1; return { success: true }; }
   client.chatModalId = choiceRoot;
   liveOpts.splice(0, liveOpts.length, { text: 'Yes', buttonType: BUTTON_OK }, { text: 'No', buttonType: BUTTON_OK });
   seq++;
   return { success: true };
  },
  wait: async () => { tick++; },
  fail: async msg => { throw Error(msg); },
  log: () => {},
  planGrace: () => false,
  settleBurst: () => { const r = burster.settle(); if (r.reason) fallbackReasons.push(r.reason); },
  burst: (opt, choice, dlg) => burster.tryBurst(dlg, opt, choice),
 }, [/^Yes$/], () => client.chatModalId === -1, BURST_SETTLE_TICKS + 10);
 expect(delayedOk).toBe(true);
 expect(burstCount).toBe(1);
 expect(clicks).toBe(2);
 expect(fallbackReasons).toEqual(['settlement']);
});

test('consecutive openQuest calls on one session route burst page text to the active quest and restore hooks on dispose', async () => {
 const { openQuest } = await import('./quest-lib');
 const root = [...CONTINUE_ROOTS][0]!;
 const com = { id: root + 1, layerId: root, text: '' };
 const origIfMutable = () => com;
 const origSendClickDialog = async () => ({ success: true });
 const origClickByText = async () => ({ success: true });
 let tick = 10;
 const callbacks = new Set<() => void>();
 const session: any = {
  name: 'SharedBot',
  tick: () => tick,
  ended: new Promise(() => {}),
  onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
  client: { ifMutable: origIfMutable, chatModalId: -1, writeOpcode: () => {}, out: { p2: () => {} } },
  sdk: {
   getState: () => ({ player: { lifeId: 1, respawnCount: 0, worldX: 2478, worldZ: 3463, level: 1 }, inventory: [], recentDialogs: [], gameMessages: [] }),
   getInventory: () => [],
   getDialog: () => ({ isOpen: false }),
   getSkill: () => ({ level: 99, baseLevel: 99 }),
   getSkillXp: () => 0,
   sendClickDialog: origSendClickDialog,
   clickDialogByText: origClickByText,
  },
  direct: async () => ({ success: true }),
 };
 const timer = setInterval(() => { tick++; for (const cb of callbacks) cb(); }, 1);
 try {
  const q1 = await openQuest({ session, burst: true });
  session.client.ifMutable(com.id).text = 'First quest line';
  expect(q1.sawText(/first quest line/i)).toBe(true);
  await q1.dispose();
  expect(session.client.ifMutable).toBe(origIfMutable);
  expect(session.sdk.sendClickDialog).toBe(origSendClickDialog);
  expect(session.sdk.clickDialogByText).toBe(origClickByText);

  const q2 = await openQuest({ session, burst: true });
  session.client.ifMutable(com.id).text = 'I will take care of this! Go back to the King.';
  expect(q2.sawText(/go back to the king/i)).toBe(true);
  await q2.dispose();
  expect(session.client.ifMutable).toBe(origIfMutable);
 } finally {
  clearInterval(timer);
 }
});

import {RETREAT_TELEPORTS,retreatTeleport,retreatTeleportsFor,retreatTiles,retreatFailure,fightRefusal} from './quest-lib';
test('a retreat casts the first teleport it can, and none while a quest item would be destroyed', () => {
 expect(retreatTeleport(RETREAT_TELEPORTS,c=>c==='magic:ardougne_teleport')).toBe('magic:ardougne_teleport');
 expect(retreatTeleport(RETREAT_TELEPORTS,()=>false)).toBeUndefined();
 expect(retreatTeleportsFor('magic:ardougne_teleport',false)[0]).toBe('magic:ardougne_teleport');
 expect(retreatTeleportsFor('magic:ardougne_teleport',false).filter(c=>c==='magic:ardougne_teleport')).toHaveLength(1);
 expect(retreatTeleportsFor('magic:ardougne_teleport',true)).toEqual([]);
 expect(retreatTeleportsFor(undefined,false)).toBe(RETREAT_TELEPORTS);
});
test('retreat walk tiles go straight away first, then every other direction and nearer', () => {
 // Biohazard: the bot at 2550,3327 level 1, the mourner at 2551,3327.
 const tiles=retreatTiles({x:2550,z:3327},{x:2551,z:3327},30);
 expect(tiles[0]).toEqual({x:2520,z:3327});
 expect(tiles).toHaveLength(24);
 expect(new Set(tiles.map(t=>`${t.x},${t.z}`)).size).toBe(24);
 expect(tiles.slice(0,8).every(t=>Math.max(Math.abs(t.x-2550),Math.abs(t.z-3327))===30)).toBe(true);
 expect(tiles.at(-1)).toEqual({x:2558,z:3327});
 expect(retreatTiles({x:10,z:10},undefined,30)[0]).toEqual({x:40,z:10});
});
test('a retreat that ends in a death says died, with the hitpoints the retreat started at', () => {
 expect(retreatFailure('wait condition',true,7,31,'no walk tile accepted, fought back')).toBe('died during wait condition (retreat from hp 7 of 31, no walk tile accepted, fought back)');
 expect(retreatFailure('wait condition',false,7,31,'walked to 2520,3327')).toBe('retreat during wait condition: hp 7 of 31, no food, walked to 2520,3327');
});
test('a quest fight does not start under half the base hitpoints with no food', () => {
 expect(fightRefusal(9,31,false)).toBe('hp 9 of 31, no food');
 expect(fightRefusal(9,31,true)).toBeUndefined();
 expect(fightRefusal(16,31,false)).toBeUndefined();
});
