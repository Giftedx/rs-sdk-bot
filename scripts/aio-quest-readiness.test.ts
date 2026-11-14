import {test,expect} from 'bun:test';
import {assessQuestReadiness,prioritizeQuestsForAccount,resolveQuesterStep,runAioQuester} from './aio-quester';
import {presetFor,needs,wornKitPlan} from './quest-sweep';

const packFor = (quest: string) => Object.fromEntries(wornKitPlan(quest, needs(presetFor(quest), false, quest), [], [], []).need);

test('quest readiness sums repeated requirements and uses the same optional supplies as sweep', () => {
 const oneMail = assessQuestReadiness('gobdip', {288:1,1769:1,1767:1});
 expect(oneMail.ready).toBe(false);
 expect(oneMail.missingItems).toEqual({288:2});
 expect(assessQuestReadiness('gobdip', {288:3,1769:1,1767:1}).ready).toBe(true);
 expect(assessQuestReadiness('cook', {1944:1,1927:1,1933:1}).ready).toBe(true);
});

test('canonical quest aliases and journal names both prevent repeating completed quests', () => {
 for (const completed of ['rj', 'quest_romeojuliet', 'Romeo & Juliet']) {
  const q = assessQuestReadiness('quest_romeojuliet', {}, new Set([completed]));
  expect(q.slug).toBe('rj');
  expect(q.alreadyComplete).toBe(true);
  expect(q.ready).toBe(false);
 }
});

test('quest readiness includes required worn items and leaves missing preparation blocked', () => {
 const tree = packFor('tree');
 delete tree[1387];
 expect(assessQuestReadiness('tree', tree).missingItems).toEqual({1387:1});
 const unsupported = assessQuestReadiness('legends-owned', {});
 expect(unsupported.ready).toBe(false);
 expect(unsupported.blockers).toContain('quest sweep preparation unavailable');
});

test('known skill and quest gates must be met before a quest enters the ready queue', () => {
 const seaslug = packFor('seaslug');
 expect(assessQuestReadiness('seaslug', seaslug).ready).toBe(false);
 expect(assessQuestReadiness('seaslug', seaslug, new Set(), {Firemaking:29}).blockers).toEqual(['skill firemaking 29/30']);
 expect(assessQuestReadiness('seaslug', seaslug, new Set(), {Firemaking:30}).ready).toBe(true);
 expect(assessQuestReadiness('seaslug', seaslug, new Set(), {Firemaking:NaN}).ready).toBe(false);
 const grail = packFor('grail');
 expect(assessQuestReadiness('grail', grail).blockers).toContain("quest Merlin's Crystal incomplete or unknown");
 expect(assessQuestReadiness('grail', grail, new Set(['quest_arthur'])).blockers).toEqual([]);
 const q = prioritizeQuestsForAccount(seaslug, new Set(), ['seaslug'], {Firemaking:1});
 expect(q.readyNow).toHaveLength(0);
 expect(q.needsItems).toHaveLength(0);
 expect(q.blocked.map(e => e.slug)).toEqual(['seaslug']);
});

test('order-file quest modes keep the account adapter in generic Steps and require an order', async () => {
 for (const mode of ['hero-owned','legends-owned']) {
  expect(resolveQuesterStep(mode, ['order.json','CAP=1200'])).toEqual({script:'scripts/aio-quester.ts',args:[mode,'order.json'],env:{CAP:'1200'}});
  expect(resolveQuesterStep(`--mode=${mode}`, ['order.json']).script).toBe('scripts/aio-quester.ts');
  expect(() => resolveQuesterStep(mode, [])).toThrow('requires <order.json>');
  expect(() => resolveQuesterStep(mode, ['CAP=1200'])).toThrow('requires <order.json>');
  await expect(runAioQuester('Example', [`--mode=${mode}`])).rejects.toThrow('requires <order.json>');
 }
});
