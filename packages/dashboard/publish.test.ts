import {expect,test} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pushPublicCommit,run,verifyStaticBundle} from './publish';
import {publicView} from './publish-relay';

test('a command that outlives its limit is stopped and reported as a failure',async()=>{
 const start=Date.now();
 const r=await run([process.execPath,'-e','await Bun.sleep(30000)'],undefined,500);
 expect(r.ok).toBe(false);expect(r.out).toContain('stopped after');
 expect(Date.now()-start).toBeLessThan(10_000);
});

test('a stuck grandchild holding the output pipes does not hold the caller',async()=>{
 const code="Bun.spawn([process.execPath,'-e','await Bun.sleep(30000)'],{stdout:'inherit',stderr:'inherit'});await Bun.sleep(30000)";
 const start=Date.now();
 const r=await run([process.execPath,'-e',code],undefined,1000);
 expect(r.ok).toBe(false);expect(Date.now()-start).toBeLessThan(10_000);
});

test('a finished command gives its output, and a failed one its error text',async()=>{
 expect(await run([process.execPath,'-e','console.log("hello")'])).toEqual({ok:true,out:'hello'});
 const r=await run([process.execPath,'-e','console.error("broken");process.exit(3)']);
 expect(r.ok).toBe(false);expect(r.out).toBe('broken');
});

test('the public branch keeps its parent and sends a small pack for a snapshot-only change',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-pages-')),remote=join(dir,'remote'),site=join(dir,'site'),other=join(dir,'other');
 const git=async(cwd:string,...args:string[])=>{
  const result=await run(['git',...args],cwd,5000);
  if(!result.ok)throw Error(result.out);
  return result.out;
 };
 try{
  await git(dir,'init','-q','--bare',remote);
  mkdirSync(site);
  await git(site,'init','-q','-b','site');
  await git(site,'config','user.name','Publisher test');
  await git(site,'config','user.email','publisher@example.test');
  await git(site,'remote','add','origin',remote);
  writeFileSync(join(site,'viewer.bin'),randomBytes(256*1024));
  writeFileSync(join(site,'public.json'),'{"snapshot":1}');
  expect(await pushPublicCommit(site)).toBe('pushed');
  const first=await git(remote,'rev-parse','refs/heads/site');
  expect(await pushPublicCommit(site)).toBe('unchanged');
  expect(await git(remote,'rev-parse','refs/heads/site')).toBe(first);

  await git(dir,'clone','-q','-b','site',remote,other);
  await git(other,'config','user.name','Other publisher');
  await git(other,'config','user.email','other@example.test');
  await git(other,'commit','-q','--allow-empty','-m','Publish verified static build');
  await git(other,'push','-q','origin','site');
  const parent=await git(remote,'rev-parse','refs/heads/site');
  expect(parent).not.toBe(first);

  writeFileSync(join(site,'public.json'),'{"snapshot":2}');
  expect(await pushPublicCommit(site)).toBe('pushed');
  const head=await git(remote,'rev-parse','refs/heads/site');
  expect(await git(remote,'rev-parse',head+'^')).toBe(parent);
  expect(await git(remote,'diff','--name-only',parent,head)).toBe('public.json');
  expect(await git(remote,'show',head+':public.json')).toBe('{"snapshot":2}');
  expect(await git(site,'status','--porcelain')).toBe('');

  // Replay the receiver's advertised tip through Git's push protocol without a network connection.
  const line=parent+' refs/heads/site\0ofs-delta\n';
  const advertised=(line.length+4).toString(16).padStart(4,'0')+line+'0000';
  const request=Bun.spawnSync(['git','send-pack','--stateless-rpc','--thin','-q','.',head+':refs/heads/site'],{
   cwd:site,stdin:Buffer.from(advertised),stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:15_000,
  });
  expect(request.exitCode).toBe(0);
  expect(request.stdout.includes(Buffer.from('PACK'))).toBe(true);
  expect(request.stdout.length).toBeLessThan(4096);
 }finally{rmSync(dir,{recursive:true,force:true});}
},20_000);

test('verifyStaticBundle confirms zero 404 asset links in dashboard sources and clean public.json exports',()=>{
 const dashDir=fileURLToPath(new URL('.',import.meta.url));
 const liveAudit=verifyStaticBundle(dashDir,'Haggis',{allowDevFiles:true});
 expect(liveAudit.ok).toBe(true);
 expect(liveAudit.missing).toEqual([]);
 expect(liveAudit.leaks).toEqual([]);
 expect(liveAudit.checkedAssets).toBeGreaterThan(50);

 const dir=mkdtempSync(join(tmpdir(),'dash-bundle-'));
 try{
  const bundle=join(dir,'site');
  mkdirSync(bundle);
  for(const f of ['index.html','client-shell.js','client-shell.css','operations.js','operations.css','map-shell.js','map-shell.css','client-viewer.css','xp-tracker.js','items.png','worldmap.png']){
   if(existsSync(join(dashDir,f)))cpSync(join(dashDir,f),join(bundle,f));
  }
  cpSync(join(dashDir,'client-assets'),join(bundle,'client-assets'),{recursive:true});
  const pub=publicView({
   now:1_000_000,
   bots:[{name:'Haggis',inWorld:true,operation:'observed',bank:[{id:995,name:'Coins',count:99}]},{name:'Worker1',inWorld:true,operation:'observed'}],
   boards:[],roster:[],wilderness:[],events:[],results:[],
  },'Haggis');
  writeFileSync(join(bundle,'public.json'),JSON.stringify(pub));
  const cleanAudit=verifyStaticBundle(bundle,'Haggis');
  expect(cleanAudit).toMatchObject({ok:true,missing:[],leaks:[]});

  writeFileSync(join(bundle,'public.json'),JSON.stringify({bots:[{name:'Haggis'}]}));
  const leakAudit=verifyStaticBundle(bundle,'Haggis');
  expect(leakAudit.ok).toBe(false);
  expect(leakAudit.leaks).toContain('public.json');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
