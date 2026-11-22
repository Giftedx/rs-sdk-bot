// Harness-owned native proof. Import and --verify never launch services or workers.
// No presets, stat setters, quest setters, teleports or staged essence.
import {resolve} from 'node:path';
import {freshRuneStages} from './fresh-rune-supply-proof/contracts';
import {diagnoseFreshRuneCooking,diagnoseFreshRuneEssence,proveFreshRuneAirRecovery} from './fresh-rune-supply-proof/diagnostics';
import {proveFreshRuneStage,proveFreshRuneSupply} from './fresh-rune-supply-proof/runner';
import {verifyFreshRuneSupply} from './fresh-rune-supply-proof/verify';

export type {FreshRuneStackDeps,FreshRuneStage} from './fresh-rune-supply-proof/contracts';
export {
 PORT_STEP_MS,PORT_WAIT_MS,POSTCRAFT_XP,airRecoveryPositions,freshRuneChildTimeout,freshRuneStages,freshRuneStageWorker,
} from './fresh-rune-supply-proof/contracts';
export {waitForProofPorts,withFreshRuneStack} from './fresh-rune-supply-proof/stack';
export {
 freshRuneAirRecoveryChecks,freshRuneCookingDiagnosticChecks,freshRuneCookingDiagnosticInput,freshRuneDefaultSkills,
 freshRuneEssenceDiagnosticChecks,freshRuneEssenceDiagnosticInput,freshRunePostCraftChecks,freshRuneRecoveryContentsEqual,
 freshRuneSavedResult,freshRuneSupplyChecks,freshRuneSupportedInterruption,
} from './fresh-rune-supply-proof/checks';
export {freshRunePublishedStages,freshRuneStageInput,verifyFreshRuneAirRecovery,verifyFreshRuneSupply} from './fresh-rune-supply-proof/verify';
export {diagnoseFreshRuneCooking,diagnoseFreshRuneEssence,proveFreshRuneAirRecovery} from './fresh-rune-supply-proof/diagnostics';
export {proveFreshRuneStage,proveFreshRuneSupply} from './fresh-rune-supply-proof/runner';

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('harness must set DELIVERY_DIR');
  const directory=resolve(process.env.DELIVERY_DIR);
  const stage=freshRuneStages.find(s=>process.argv[2]==='--stage-'+s);
  const report=process.argv[2]==='--air-recovery'?await proveFreshRuneAirRecovery(directory):stage?await proveFreshRuneStage(directory,stage):process.argv[2]==='--verify'?verifyFreshRuneSupply(directory):process.argv[2]==='--diagnose-essence'
   ?await diagnoseFreshRuneEssence(directory,process.argv[3]??'',resolve(process.argv[4]??'')):process.argv[2]==='--diagnose-cooking'
   ?await diagnoseFreshRuneCooking(directory,process.argv[3]??'',resolve(process.argv[4]??'')):await proveFreshRuneSupply(directory);
  console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
