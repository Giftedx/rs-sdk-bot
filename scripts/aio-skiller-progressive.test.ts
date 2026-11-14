import {expect,test} from 'bun:test';
import {planProgressiveSkiller,readBankJobArgument,bankJobStep,resolveSkillerStep,validateBankJob,inventoryRecipes,jewelleryRecipes,miningProfiles,firemakingOptions,prayerOptions,agilityOptions} from './aio-skiller';
import {magicOptions} from './magic-order';
import {parseStep} from '../packages/core/src/chain-step';
import {resolvePvpStep} from './aio-pvp';
import {resolveRouteStep} from './aio-route-step';

test('environment overrides retain route identity and explicit positionals replace defaults',()=>{
 const harpoon=resolveSkillerStep('fishing','harpoon',['CAP=500']);
 expect(harpoon.args).toEqual(['harpoon']);
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
  else expect(Number(band.step.args[0])).toBe(band.toLevel);
 }
 for(const band of planProgressiveSkiller('agility',1,99))expect(agilityOptions(band.step.args[0]!,band.step.args[1]!,band.step.env).target).toBe(band.toLevel);
 expect(planProgressiveSkiller('runecraft',44,99)[0]!.step.args).toEqual(['99']);
});

test('manufacturing and ore bands carry valid finite jobs with native unlocked recipes',()=>{
 for(const skill of ['cooking','fletching','crafting','mining']){
  for(const band of planProgressiveSkiller(skill,1,99)){
   if(band.step.script!=='scripts/aio-skiller.ts')continue;
   const job=readBankJobArgument(band.step.args[1]!);
   expect(()=>validateBankJob(job)).not.toThrow();
   expect(job.target).toBe(band.unitsNeeded);
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
