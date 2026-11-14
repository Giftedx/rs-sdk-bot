import {expect,test} from 'bun:test';
import {recommendNextAioJob,assessTribridReadiness} from './aio';
import {planAutoFighterBand} from './aio-fighter';
import {giantTraining,cowTraining} from './gather-combat';
import {QUEST_NAMES} from './quest-chain';

const maxed = Object.fromEntries(['Attack','Strength','Defence','Hitpoints','Ranged','Magic','Prayer','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Runecraft'].map(skill => [skill,99]));
const account = (skills = maxed, ownedItems: Record<number,number> = {}) => ({name:'Progress',skills,ownedItems});

test('fresh melee transitions use supported worker styles and stage cows before travelling', () => {
 const fresh = planAutoFighterBand({Attack:1,Strength:1,Defence:1,Hitpoints:10});
 expect(fresh.target).toBe('cow');
 expect(cowTraining(fresh.step.env.TRAIN_SKILL,Number(fresh.step.env.TARGET_LEVEL)).targetLevel).toBe(40);
 expect(fresh.step.env.COW_STAGE).toBe('1');
 const next = planAutoFighterBand({Attack:1,Strength:20,Defence:1,Hitpoints:20});
 expect(next.target).toBe('cow');
 expect(cowTraining(next.step.env.TRAIN_SKILL,Number(next.step.env.TARGET_LEVEL)).skill).toBe('Strength');
 expect(next.step.env.COW_STAGE).toBe('1');
 const faster = planAutoFighterBand({Attack:60,Strength:60,Defence:60,Hitpoints:60});
 expect(faster.target).toBe('trooper');
 expect(giantTraining(faster.step.env.TRAIN_SKILL,Number(faster.step.env.TARGET_LEVEL)).targetLevel).toBe(70);
});

test('PK recommendations keep all seven combat goals ahead of Wilderness admission', () => {
 const kit = assessTribridReadiness({}).required;
 const melee = recommendNextAioJob(account({...maxed,Strength:70},kit),'pk-tribrid');
 expect(melee.category).toBe('fighter');
 expect(melee.step?.env.TRAIN_SKILL).toBe('Strength');
 for (const skill of ['Ranged','Magic','Prayer','Hitpoints']) {
  const next = recommendNextAioJob(account({...maxed,[skill]:70},kit),'pk-tribrid');
  expect(next.step?.script).not.toBe('scripts/pk-live/live-pilot.ts');
  expect(next.reason).toContain(`${skill} 99`);
 }
 const hp = recommendNextAioJob(account({...maxed,Hitpoints:98},kit),'pk-tribrid');
 expect(hp.step?.env.TRAIN_SKILL).toBe('Hitpoints');
 expect(recommendNextAioJob(account(maxed,kit),'pk-tribrid').step?.script).toBe('scripts/pk-live/live-pilot.ts');
});

test('overall completion includes Hitpoints and complete accounts have no training job', () => {
 const hp = recommendNextAioJob(account({...maxed,Hitpoints:98}),'max-overall');
 expect(hp.step?.env.TRAIN_SKILL).toBe('Hitpoints');
 expect(hp.step?.env.TARGET_LEVEL).toBe('99');
 expect(recommendNextAioJob(account(),'max-overall')).toMatchObject({status:'complete',step:null});
 const herb = recommendNextAioJob(account({...maxed,Herblore:1}),'max-overall');
 expect(herb.status).toBe('blocked');
 expect(herb.reason).toContain('Druidic Ritual');
});

test('food acquisition hands caught fish to cooking before resuming knights', () => {
 const skills = {...maxed,Thieving:60,Fishing:40};
 expect(recommendNextAioJob(account(skills,{301:1}),'goldfarm').step?.script).toBe('scripts/gather-fish.ts');
 expect(recommendNextAioJob(account(skills),'goldfarm')).toMatchObject({status:'blocked',step:null});
 const cook = recommendNextAioJob(account(skills,{377:20}),'goldfarm');
 expect(cook.step?.script).toBe('scripts/cook-food.ts');
 expect(cook.step?.args).toEqual(['2000','lobster']);
 expect(recommendNextAioJob(account(skills,{379:20}),'goldfarm').step?.script).toBe('scripts/goldfarm.ts');
 expect(recommendNextAioJob(account({...skills,Cooking:1},{377:20}),'goldfarm')).toMatchObject({status:'blocked',step:null});
 expect(recommendNextAioJob(account({...skills,Cooking:15},{377:20,335:20}),'goldfarm').step?.args).toEqual(['2000','trout']);
 for (const food of [1891,1893,1895,1901,2309]) expect(recommendNextAioJob(account({...skills,Cooking:1,Fishing:1},{[food]:20}),'goldfarm').step?.script).toBe('scripts/goldfarm.ts');
});

test('invalid observations never appear as completed goals', () => {
 for (const level of [NaN,Infinity,100,0]) expect(recommendNextAioJob(account({...maxed,Hitpoints:level}),'max-overall')).toMatchObject({status:'blocked',step:null});
});

test('completed quest goals stop instead of launching an item worker without a quest', () => {
 const completedQuests = new Set(Object.keys(QUEST_NAMES));
 expect(recommendNextAioJob({...account(),completedQuests},'quest-sweep')).toMatchObject({status:'complete',step:null});
});
