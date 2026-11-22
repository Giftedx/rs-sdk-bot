// Harness entry only. No game or server work occurs on import or with --verify.
import {resolve} from 'node:path';
import type {Mode} from './agility-order-proof/contracts';
import {run} from './agility-order-proof/runner';
import {verify,verifyGnome} from './agility-order-proof/verify';

export type {FallFiles,FallOutcome,FallSample} from './agility-order-proof/contracts';
export {
 ARDOUGNE_CONFIGURATION,ARDOUGNE_ENTRY_CONFIGURATION,ARDOUGNE_PLAN,DRAYNOR_START,FALL_SAMPLE_PLAN,
 FOOD_RECOVERY_CONFIGURATION,GNOME_CONSUMER_CONFIGURATION,GNOME_CONSUMER_PLAN,GNOME_FOOD_CONFIGURATION,
 GNOME_FOOD_PLAN,GNOME_FOOD_RESTART_CONFIGURATION,GNOME_FRESH_MS,GNOME_SCOPE,GNOME_STEPS,
 INFLIGHT_FOOD_CONFIGURATION,INITIALIZATION_CONFIGURATION,NATIVE_DEADLINE_MS,NATIVE_FORMAT,
 agilityFixturePreset,fallSampleAdmitted,interruptionDeadlineMs,restartInitialProjection,sources,trainedLevel,
} from './agility-order-proof/contracts';
export {
 agilityInitializationChecks,agilitySaveChecks,agilitySaveDifferences,childChecks,draynorEntryChecks,
 fallRecoveryCheck,fallSampleChecks,fallSampleOutcome,femiGateVarp,initializationEvidenceChecks,
 interruptionSaveChecks,readFallSamples,retainedApproachChecks,sampleFalls,savedCoursePosition,
 strongholdGateCrossed,verifyFallSamples,zeroFallObserved,
} from './agility-order-proof/save-checks';
export {
 ardougneEntryChecks,foodRecoveryChecks,gnomeFoodChecks,gnomeScope,healSequence,inflightFoodChecks,
 inflightFoodOutcome,settlementEvidence,sharedSettlementChecks,verifyFoodRecovery,verifyInflightFood,
} from './agility-order-proof/food-checks';
export {
 gnomeConsumerCaseChecks,restartChainChecks,verificationReport,verify,verifyArdougneEntry,
 verifyDraynorEvidence,verifyGnome,verifyGnomeConsumer,verifyGnomeFood,verifyRetainedApproachEvidence,
} from './agility-order-proof/verify';

if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through the agility-order delivery harness');
 const directory=resolve(process.env.DELIVERY_DIR);
 const flag=process.argv[2],retained=flag?.startsWith('--course-approach=')?flag.slice('--course-approach='.length):undefined;
 const modes:Record<string,Mode>={'--draynor-entry':'draynor','--food-recovery':'food-recovery','--gnome-food-recovery':'gnome-food',
  '--ardougne-entry':'ardougne','--gnome-consumer':'gnome-consumer'};
 if(flag&&flag!=='--verify'&&flag!=='--verify-gnome'&&!Object.hasOwn(modes,flag)&&retained===undefined)throw Error('unknown agility proof mode');
 const report=flag==='--verify'?verify(directory):flag==='--verify-gnome'?verifyGnome(directory)
  :await run(directory,retained!==undefined?'course-approach':flag?modes[flag]!:'full',retained);
 if(flag==='--verify'||flag==='--verify-gnome')console.log(JSON.stringify(report));
 process.exitCode=report.ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
