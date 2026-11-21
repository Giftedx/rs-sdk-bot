import {test,expect} from 'bun:test';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {existsSync,lstatSync,unlinkSync} from 'node:fs';
import {dangerContent,materializeSwarmRuntime,privateAuthorityPath} from '../src/swarm-recovery-chain';
import {prepareCoinProofRoot,removeCoinProofRoot} from '../src/coin-courier-proof';
import {capabilityRevision} from '../../core/src/worker-release';
import {loadDanger} from '../../core/src/randomevents';
// The copy of this test holds the danger content alone (dangerContent: the npc pack and the npc configs), not the
// whole content tree of over 10,000 files, which made the copy and its removal most of the test's time. The copy is
// made by the code of the recovery proof, and the test proves that the list is enough: the copied runtime must load
// as many danger entries as this checkout does. The whole tree is copied by the recovery proof itself
// (proveSwarmRecoveryContinuation), which is its own practice check.
test('the actual copied worker runtime loads its immutable danger content before any connection',()=>{
 const source=resolve(import.meta.dir,'../../..'),root=prepareCoinProofRoot(source,tmpdir()),links:string[]=[];
 try{
  links.push(...materializeSwarmRuntime(source,root,dangerContent));
  expect(capabilityRevision(['scripts/session-check.ts'],root)).toBe(capabilityRevision(['scripts/session-check.ts'],source));
  const p=Bun.spawnSync([process.execPath,'-e','import {loadDanger} from "./packages/core/src/randomevents";const lite=await import("./vendor/rs-sdk/server/webclient/src/lite/session.ts");console.log(JSON.stringify({danger:loadDanger().size,lite:typeof lite.startSession}));'],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
  expect(p.exitCode,p.stderr.toString()).toBe(0);const result=JSON.parse(p.stdout.toString().trim());expect(result.danger).toBe(loadDanger().size);expect(result.lite).toBe('function');expect(loadDanger().size).toBeGreaterThan(0);
 }finally{for(const p of links)if(existsSync(p)&&lstatSync(p).isSymbolicLink())unlinkSync(p);expect(removeCoinProofRoot(root)).toBe(true);}
},90_000);
// A push writes objects/tmp_objdir-incoming-XXXXXX/NN/<38 hex> under the remote: 77 characters past a 185 character
// case folder passes the Windows limit of 260. The authority must sit under the short private root.
test('the private Git authority is under the private root, not under the delivery case folder',()=>{
 const root=join(tmpdir(),'coin-proof-x'),directory=join('F:\\dev\\.practice\\deliveries\\d-1\\cases','bounded-swarm-new-mission');
 const remote=privateAuthorityPath(root),under=(parent:string)=>{const rel=relative(parent,remote);return rel.length>0&&!rel.startsWith('..')&&!isAbsolute(rel);};
 expect(under(root)).toBe(true);expect(under(directory)).toBe(false);
 expect(remote.length+'/objects/tmp_objdir-incoming-XXXXXX/NN/'.length+38).toBeLessThan(root.length+120);
});
