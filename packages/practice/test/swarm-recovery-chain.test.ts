import {test,expect} from 'bun:test';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {existsSync,lstatSync,unlinkSync} from 'node:fs';
import {materializeSwarmRuntime} from '../src/swarm-recovery-chain';
import {prepareCoinProofRoot,removeCoinProofRoot} from '../src/coin-courier-proof';
import {capabilityRevision} from '../../core/src/worker-release';
import {loadDanger} from '../../core/src/randomevents';
test('the actual copied worker runtime loads its immutable danger content before any connection',()=>{
 const source=resolve(import.meta.dir,'../../..'),root=prepareCoinProofRoot(source,tmpdir()),links:string[]=[];
 try{
  links.push(...materializeSwarmRuntime(source,root));
  expect(capabilityRevision(['scripts/session-check.ts'],root)).toBe(capabilityRevision(['scripts/session-check.ts'],source));
  const p=Bun.spawnSync([process.execPath,'-e','import {loadDanger} from "./packages/core/src/randomevents";console.log(loadDanger().size);'],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
  expect(p.exitCode).toBe(0);expect(Number(p.stdout.toString().trim())).toBe(loadDanger().size);expect(loadDanger().size).toBeGreaterThan(0);
 }finally{for(const p of links)if(existsSync(p)&&lstatSync(p).isSymbolicLink())unlinkSync(p);expect(removeCoinProofRoot(root)).toBe(true);}
},30000);
