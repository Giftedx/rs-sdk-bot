// Register a completed native qualification from this machine or a downloaded practice artifact root.
import {readFileSync} from 'node:fs';import {join,resolve} from 'node:path';
import {deliveryTask} from './delivery-cli';import {registerAcceptedProgressionDelivery} from './progression-qualification-native';
const root=resolve(import.meta.dir,'../../..');
export async function registerProgressionArtifact(directory:string,practiceRoot=join(root,'.practice'),additionalProof?:{directory:string;practiceRoot?:string}){
 const task=deliveryTask('ranged-train'),report=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));
 return registerAcceptedProgressionDelivery(task,{...report,directory:resolve(directory)},root,resolve(practiceRoot),additionalProof);
}
if(import.meta.main){
 try{
  const [directory,...args]=process.argv.slice(2),flags=new Map<string,string>();
  if(!directory)throw Error('Usage: bun packages/router/src/progression-qualification-cli.ts <native-delivery-directory> [--practice-root <artifact-root>] [--method-proof <folder>] [--method-practice-root <root>]');
  for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!['--practice-root','--method-proof','--method-practice-root'].includes(key)||!value||flags.has(key))throw Error('invalid progression artifact option');flags.set(key,value);}
  if(flags.has('--method-practice-root')&&!flags.has('--method-proof'))throw Error('method practice root needs a method proof');
  const additional=flags.has('--method-proof')?{directory:resolve(flags.get('--method-proof')!),...(flags.has('--method-practice-root')?{practiceRoot:resolve(flags.get('--method-practice-root')!)}:{})}:undefined;
  console.log(JSON.stringify(await registerProgressionArtifact(resolve(directory),flags.get('--practice-root'),additional),null,2));
 }catch(error){console.error(String(error));process.exitCode=1;}
}
