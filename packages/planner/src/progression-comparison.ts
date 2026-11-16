import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
export interface ProgressionRun{ok:boolean;mode:string;seed:number;source:string;entrySha256:string;target:number;ticks:number;elapsedMs:number;xpGain:number;checks:Record<string,boolean>;result?:{method?:string;targetMet?:boolean};evidence?:string}
export interface ProgressionComparison{ok:boolean;source:string|null;entrySha256:string|null;target:number|null;seeds:number[];rows:{mode:string;ticks:number[];elapsedMs:number[];medianTicks:number;xpPerTick:number[]}[];faster:boolean;errors:string[]}
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const median=(values:number[])=>{const rows=[...values].sort((a,b)=>a-b),mid=Math.floor(rows.length/2);return rows.length%2?rows[mid]!:(rows[mid-1]!+rows[mid]!)/2;};
export function compareProgressionRuns(runs:readonly ProgressionRun[]):ProgressionComparison{
 const result:ProgressionComparison={ok:false,source:runs[0]?.source??null,entrySha256:runs[0]?.entrySha256??null,target:runs[0]?.target??null,seeds:[],rows:[],faster:false,errors:[]};
 const modes=['chickens','troopers','adaptive'];
 if(!runs.length){result.errors.push('No matched native runs');return result;}
 for(const run of runs){
  if(!modes.includes(run.mode)||!Number.isSafeInteger(run.seed)||run.source!==result.source||run.entrySha256!==result.entrySha256||run.target!==result.target)result.errors.push('Native source, entry, target or comparison identity differs');
  if(!run.ok||run.result?.targetMet!==true||!positive(run.ticks)||!positive(run.elapsedMs)||!positive(run.xpGain)||!Object.keys(run.checks??{}).length||!Object.values(run.checks).every(v=>v===true))result.errors.push('Native stage, finite target, accounting or timing failed');
  if(!/^[a-f0-9]{64}$/i.test(run.source)||!/^[a-f0-9]{64}$/i.test(run.entrySha256))result.errors.push('Source and entry require SHA-256 bindings');
  if(run.mode==='chickens'&&run.result?.method!=='ranged/chickens'||run.mode==='troopers'&&run.result?.method!=='ranged/troopers')result.errors.push('Reported method differs from the comparison condition');
 }
 const seeds=[...new Set(runs.filter(r=>r.mode==='chickens').map(r=>r.seed))].sort((a,b)=>a-b);result.seeds=seeds;
 if(seeds.length<3)result.errors.push('At least three matched seeds per condition are required');
 for(const mode of modes){
  const rows=runs.filter(r=>r.mode===mode).sort((a,b)=>a.seed-b.seed);
  if(rows.length!==seeds.length||JSON.stringify(rows.map(r=>r.seed))!==JSON.stringify(seeds))result.errors.push('Missing or duplicated matched seeds for '+mode);
  if(rows.length)result.rows.push({mode,ticks:rows.map(r=>r.ticks),elapsedMs:rows.map(r=>r.elapsedMs),medianTicks:median(rows.map(r=>r.ticks)),xpPerTick:rows.map(r=>r.xpGain/r.ticks)});
 }
 const baseline=runs.filter(r=>r.mode==='chickens');
 result.faster=seeds.length>=3&&seeds.every(seed=>{
  const slow=baseline.find(r=>r.seed===seed),fast=runs.find(r=>r.seed===seed&&r.mode==='adaptive');
  return !!slow&&!!fast&&fast.ticks<slow.ticks&&fast.result?.method!=='ranged/chickens';
 });
 if(!result.faster)result.errors.push('The selected route did not finish faster than chickens on every matched seed');
 result.errors=[...new Set(result.errors)];result.ok=!result.errors.length;return result;
}

export function readProgressionRuns(folder:string):ProgressionRun[]{
 const rows:ProgressionRun[]=[];let files=0;
 const visit=(path:string)=>{for(const file of readdirSync(path,{withFileTypes:true})){
  if(++files>10000)throw Error('Proof folder exceeds the finite file scan bound');
  const target=join(path,file.name);
  if(file.isDirectory())visit(target);
  else if(file.name==='proof.json'){const row=JSON.parse(readFileSync(target,'utf8'));if(typeof row.mode==='string'&&typeof row.target==='number')rows.push(row);}
 }};
 visit(resolve(folder));return rows;
}
if(import.meta.main){
 const reports=readProgressionRuns(process.argv[2]??'.practice/progression-system/artifacts');
 const comparison=compareProgressionRuns(reports.filter(r=>r.target===83)),launch=reports.filter(r=>r.target===85&&r.mode==='adaptive');
 const launchSeeds=[...new Set(launch.map(r=>r.seed))].sort((a,b)=>a-b);
 const targetProof=launch.length===3&&JSON.stringify(launchSeeds)===JSON.stringify(comparison.seeds)&&launch.every(r=>r.ok&&r.result?.targetMet&&r.source===comparison.source&&r.entrySha256===comparison.entrySha256&&Object.values(r.checks).every(Boolean));
 const output={ok:comparison.ok&&targetProof,comparison,targetProof:{ok:targetProof,target:85,seeds:launchSeeds}};
 console.log('PROGRESSION_COMPARISON '+JSON.stringify(output));process.exitCode=output.ok?0:1;
}
