import {expect,test} from 'bun:test';
import {planProgressiveSkiller,planStunSuperheatSmithing,readBankJobArgument,bankJobStep,resolveSkillerStep,validateBankJob,inventoryRecipes,jewelleryRecipes,miningProfiles,firemakingOptions,prayerOptions,agilityOptions} from './aio-skiller';
import {magicOptions} from './magic-order';
import {parseStep} from '../packages/core/src/chain-step';
import {resolvePvpStep} from './aio-pvp';
import {resolveRouteStep} from './aio-route-step';

test('environment overrides retain route identity and explicit positionals replace defaults',()=>{
 const harpoon=resolveSkillerStep('fishing','harpoon',['CAP=500']);
 expect(harpoon.args).toEqual(['gather','fishing','harpoon','harpoon']);
 expect(harpoon.env.CAP).toBe('500');
 expect(resolvePvpStep('pilot',['CAP=100']).args).toEqual(['10','20']);
 expect(resolvePvpStep('pilot',['3','10']).args).toEqual(['3','10']);
 expect(resolveRouteStep({script:'scripts/example.ts',defaultArgs:['default'],defaultEnv:{MODE:'a'}},['MODE=b'])).toEqual({script:'scripts/example.ts',args:['default'],env:{MODE:'b'}});
});

test('progression hands level targets to the actual worker interfaces',()=>{
 for(const skill of ['woodcutting','fishing','thieving']){
  for(const band of planProgressiveSkiller(skill,1,99))expect(Number(band.step.env.TARGET)).toBe(band.toLevel);
 }
 for(const band of planProgressiveSkiller('firemaking',1,99))expect(firemakingOptions(band.step.env).target).toBe(band.toLevel);
 for(const band of planProgressiveSkiller('magic',1,99)){
  if(band.method==='order')expect(magicOptions(band.step.env).target).toBe(band.toLevel);
  else if(band.method==='splash')expect(Number(band.step.args[2])).toBe(band.toLevel);
  else expect(Number(band.step.args[0])).toBe(band.toLevel);
 }
 for(const band of planProgressiveSkiller('agility',1,99)){
  expect(band.step.script).toBe('scripts/aio-skiller.ts');
  expect(band.step.args.slice(0,2)).toEqual(['agility','order']);
  expect(agilityOptions(band.step.args[2]!,band.step.args[3]!,band.step.env).target).toBe(band.toLevel);
 }
 expect(planProgressiveSkiller('runecraft',44,99)[0]!.step.args).toEqual(['runecraft','bank-craft','99']);
});

test('manufacturing and ore bands carry valid finite jobs with native unlocked recipes',()=>{
 for(const skill of ['cooking','fletching','crafting','mining']){
  for(const band of planProgressiveSkiller(skill,1,99)){
   if(band.step.script!=='scripts/aio-skiller.ts')continue;
   const job=readBankJobArgument(band.step.args[1]!);
   expect(()=>validateBankJob(job)).not.toThrow();
   expect(job.target).toBe(band.unitsNeeded);
   if(skill==='cooking')expect(job.targetLevel).toBe(band.toLevel);
   expect(job.cap).toBeGreaterThan(job.returnTicks);
   const native=job.family==='inventory'?inventoryRecipes().find(r=>r.name===job.recipe):job.family==='jewellery'?jewelleryRecipes().find(r=>r.name===job.recipe):job.family==='mining'?miningProfiles().find(r=>r.name===job.recipe):undefined;
   if(native)expect(native.level).toBeLessThanOrEqual(band.fromLevel);
   if(native&&'xp' in native)expect(native.xp).toBe(true);
   // Chain serialization must retain the exact embedded policy without a generated file dependency.
   const text=[band.step.script,...band.step.args].join(' ');
   expect(readBankJobArgument(parseStep(text).args[1]!)).toEqual(job);
  }
 }
 const lowCraft=planProgressiveSkiller('crafting',1,5)[0]!;
 expect(lowCraft.step.script).not.toBe('scripts/soften-clay.ts');
 expect(readBankJobArgument(lowCraft.step.args[1]!).recipe).toBe('leather:leather_gloves');
});

test('cooking progression retains a base-level goal for chicken, trout and random wine outcomes',()=>{
 const bands=planProgressiveSkiller('cooking',1,99);
 expect(bands.map(b=>readBankJobArgument(b.step.args[1]!).targetLevel)).toEqual([15,35,99]);
 expect(bands.map(b=>readBankJobArgument(b.step.args[1]!).family)).toEqual(['cooking','cooking','wine']);
});

test('bank profiles resolve through AIO, survive chains and reject invalid recipes before login',()=>{
 const step=bankJobStep({family:'inventory',recipe:'leather:leather_gloves',target:3,batch:3,cap:1000,returnTicks:100,members:false});
 expect(resolveSkillerStep('bank-job',step.args[1])).toEqual(step);
 expect(()=>readBankJobArgument('--job='+encodeURIComponent(JSON.stringify({family:'inventory',recipe:'missing',target:1,batch:1,cap:1000,returnTicks:100,members:false})))).toThrow('unknown inventory recipe');
});

test('prayer plans its worker minimum milestone and funds the full bounded burial count',()=>{
 const band=planProgressiveSkiller('prayer',1,15)[0]!;
 expect(band.toLevel).toBe(43);
 const opts=prayerOptions(['bun','worker','Example',...band.step.args],band.step.env);
 expect(opts.target).toBe(43);
 expect(opts.maximum).toBe(band.unitsNeeded);
 expect(opts.reserve).toBeGreaterThanOrEqual(6);
 expect(opts.cap).toBeGreaterThan(1500);
});

test('progression refuses unavailable unlocks, non-XP activities and invalid rates',()=>{
 expect(()=>planProgressiveSkiller('herblore',1,20)).toThrow('quest unlock');
 expect(()=>planProgressiveSkiller('foraging',1,20)).toThrow('no XP progression');
 for(const rate of [NaN,Infinity,0,-1])expect(()=>planProgressiveSkiller('firemaking',1,20,rate)).toThrow('invalid progressive');
});

test('stun superheat plan stages bronze then iron superheat casts for Smithing 1-41', () => {
 expect(() => planStunSuperheatSmithing(1, 42)).toThrow('Magic 43');
 const full = planStunSuperheatSmithing(1, 43);
 expect(full.map(b => [b.metal, b.fromSmithing, b.toSmithing, b.casts])).toEqual([
  ['bronze', 1, 15, 12],
  ['iron', 15, 41, 45],
 ]);
 expect(full[0]!.step).toEqual({ script: 'scripts/microbot-magic-items.ts', args: ['superheat:bronze', '-', '12', '200'], env: {} });
 expect(planStunSuperheatSmithing(20, 43).map(b => b.metal)).toEqual(['iron']);
 expect(planStunSuperheatSmithing(41, 43)).toEqual([]);
});

// Item ids: iron ore 440, coal 453, gold ore 444, iron bar 2351, steel bar 2353, hammer 2347.
const smithBand=(b:ReturnType<typeof planProgressiveSkiller>[number])=>`${b.fromLevel}-${b.toLevel} ${b.method} ${b.step.env.PRODUCT_ID??b.step.args[1]} x${b.unitsNeeded}`;
test('a smithing tier is planned only with inputs that the account owns or that an earlier band of the plan makes',()=>{
 // 40 iron bars and a hammer: the iron platebody is the step. 4 platebodies reach Smithing 48.
 const bars=planProgressiveSkiller('smithing',40,55,25,{2351:40,2347:1});
 expect(bars.map(smithBand)).toEqual(['40-48 anvil 1115 x4','48-55 anvil 1115 x4','53-55 anvil 1119 x0']);
 expect(bars[0]!.step.env.MAX_MAKE).toBe('4');
 expect(bars[2]!.shortfall).toContain('anvil 1119 needs 5x2353;');
 // No bars but iron ore: the step smelts the bars that the platebodies need, then smiths them.
 const ore=planProgressiveSkiller('smithing',40,48,25,{440:60,2347:1});
 expect(ore.map(smithBand)).toEqual(['40-48 smelt iron x15','43-48 anvil 1115 x3']);
 // Bars but no hammer, and gold ore: the step smelts gold.
 expect(smithBand(planProgressiveSkiller('smithing',40,48,25,{2351:40,444:30})[0]!)).toBe('40-48 smelt gold x23');
 // Nothing owned: no step, and the band names what each unlocked tier lacks.
 const none=planProgressiveSkiller('smithing',40,55,25,{});
 expect(none).toHaveLength(1);
 expect(none[0]!.unitsNeeded).toBe(0);
 expect(none[0]!.shortfall).toContain('anvil 1115 needs 5x2351 1x2347;');
 expect(none[0]!.shortfall).toContain('smelt gold needs 1x444');
 // The stock ends before the level: the plan stops at a band that names the shortfall.
 const few=planProgressiveSkiller('smithing',40,48,25,{2351:10,2347:1});
 expect(few.map(b=>[smithBand(b),!!b.shortfall])).toEqual([['40-48 anvil 1115 x2',false],['44-48 anvil 1115 x0',true]]);
});
test('with no stock known the smithing plan smelts each bar that its anvil bands use',()=>{
 const plan=planProgressiveSkiller('smithing',1,99);
 const stock=new Map<number,number>();
 const bar:Record<string,number>={bronze:2349,iron:2351,steel:2353,gold:2357,mithril:2359,adamantite:2361,runite:2363},uses:Record<string,number>={1115:2351,1119:2353,1121:2359,1123:2361};
 for(const b of plan){
  expect(b.unitsNeeded).toBeGreaterThan(0);
  if(b.method==='smelt')stock.set(bar[b.step.args[1]!]!,(stock.get(bar[b.step.args[1]!]!)??0)+b.unitsNeeded);
  else{const id=uses[b.step.env.PRODUCT_ID!]!;stock.set(id,(stock.get(id)??0)-5*b.unitsNeeded);expect(stock.get(id)!,smithBand(b)).toBeGreaterThanOrEqual(0);}
 }
 expect(plan.at(-1)!.toLevel).toBe(99);
 expect(plan.filter(b=>b.method==='anvil').map(b=>b.step.env.PRODUCT_ID)).toEqual(expect.arrayContaining(['1115','1119','1121','1123']));
 expect(plan.some(b=>['gold','runite'].includes(b.step.args[1]!))).toBe(false);
});
test('other skills plan the same bands with and without a stock',()=>{
 for(const skill of ['cooking','mining','magic','prayer','runecraft','thieving'])
  expect(planProgressiveSkiller(skill,1,99,25,{}).map(b=>[b.fromLevel,b.toLevel,b.method,b.unitsNeeded])).toEqual(planProgressiveSkiller(skill,1,99).map(b=>[b.fromLevel,b.toLevel,b.method,b.unitsNeeded]));
});
