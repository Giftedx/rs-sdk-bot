import {describe,expect,test} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,cpSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPages,ourNamesFile,pageHash,PAGES_CHECK_MS,pushAuditedSite,pushPublicCommit,pushSingleCommit,run,verifyStaticBundle,watchPush} from './publish';
import {publicView} from './publish-relay';

// A site folder as rs-fleet-command scripts/import-page.ts and export-viewer.ts make it: relative page links, webp
// sprites, the keyboard handler turned into gameKeys, client-shell.js inside FleetShim.ready, and the 3D viewer in viewer/.
function importedSite(bundle:string){
 const dashDir=fileURLToPath(new URL('.',import.meta.url));
 mkdirSync(bundle,{recursive:true});
 for(const f of ['index.html','xp-tracker.js','client-shell.js','client-shell.css','client-viewer.css','map-shell.js','map-shell.css','operations.js','operations.css','items.json','RUNELITE-LICENSE.txt']){
  let text=readFileSync(join(dashDir,f),'utf8');
  if(/\.(html|css|js)$/i.test(f)){
   text=text.replace(/\/(client-shell|client-viewer|map-shell|operations|xp-tracker|items|worldmap)\.(css|js|png|json)/g,'$1.$2')
    .replace(/['"]\/client-assets\//g,m=>m[0]+'client-assets/')
    .replace(/items\.png/g,'items.webp')
    .replace(/worldmap\.png/g,'worldmap.webp');
  }
  if(f==='index.html')text=text.replace('<head>','<head><base href="./"><script src="config.js"></script><script src="shim.js"></script>');
  if(f==='client-shell.js'){
   const controls="  };\n  window.addEventListener('keydown',gameKeys,true);\n  const gameFrame=$('#rsw');\n  function bindViewerControls(){\n    if(!gameFrame.contentDocument)return;\n    gameFrame.contentWindow.addEventListener('keydown',gameKeys,true);\n  }\n  gameFrame.addEventListener('load',bindViewerControls);\n  bindViewerControls();\n  window.atlasClient=";
   text=text.replace("  window.addEventListener('keydown',e=>{",'  const gameKeys=e=>{').replace(/  \},true\);\r?\n  window\.atlasClient=/,controls);
   text='FleetShim.ready.then(() => {\n'+text+'\n});\n';
  }
  writeFileSync(join(bundle,f),text);
 }
 writeFileSync(join(bundle,'items.webp'),'webp');
 writeFileSync(join(bundle,'worldmap.webp'),'webp');
 writeFileSync(join(bundle,'config.js'),'window.FLEET_CONFIG={};');writeFileSync(join(bundle,'shim.js'),'window.FleetShim={};');
 cpSync(join(dashDir,'client-assets'),join(bundle,'client-assets'),{recursive:true});
 mkdirSync(join(bundle,'viewer','static','js'),{recursive:true});
 writeFileSync(join(bundle,'viewer','index.html'),'<!doctype html><html><head><script src="bridge.js?v=42e9cad153"></script><link rel="stylesheet" href="client-viewer.css?v=e1632fb598"></head><body><script src="static/js/main.1.js?v=fc08ccca44"></script></body></html>');
 writeFileSync(join(bundle,'viewer','bridge.js'),'window.bridge=1;');
 writeFileSync(join(bundle,'viewer','client-viewer.css'),'body{margin:0}');
 writeFileSync(join(bundle,'viewer','favicon.png'),'png');
 // A script resolves a link from the page that loads it (viewer/), not from its own folder.
 writeFileSync(join(bundle,'viewer','static','js','main.1.js'),'el.innerHTML=\'<img src="favicon.png">\';');
 writeFileSync(join(bundle,'public.json'),JSON.stringify({bots:[{name:'⟦MAIN⟧',inWorld:true}],roster:[]}));
}

test('the page hash follows the page files and ignores the data files beside them',()=>{
 const dir=mkdtempSync(join(tmpdir(),'page-hash-'));
 try{
  expect(pageHash(dir)).toBeNull();
  writeFileSync(join(dir,'index.html'),'<html>1</html>');writeFileSync(join(dir,'shim.js'),'x');
  const first=pageHash(dir);expect(first).toMatch(/^[0-9a-f]{16}$/);
  writeFileSync(join(dir,'public.json'),'{"now":1}');writeFileSync(join(dir,'map.bin'),'m');
  expect(pageHash(dir)).toBe(first);
  writeFileSync(join(dir,'shim.js'),'y');expect(pageHash(dir)).not.toBe(first);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('each site push lists every current account for the viewer nameplates, never the main account',()=>{
 expect(ourNamesFile(['Woodpecker','Hiltsdeep','Woodpecker','MainGuy','maingUY','bad name!','',42,'Abracadickra'],'MainGuy')).toBe(JSON.stringify(['Abracadickra','Hiltsdeep','Woodpecker']));
 expect(ourNamesFile(null,'MainGuy')).toBeNull();
 expect(ourNamesFile({names:['Woodpecker']},'MainGuy')).toBeNull();
 expect(ourNamesFile(['MainGuy'],'MainGuy')).toBeNull();
});

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

test('verifyStaticBundle enforces sibling import-page contracts including relative webp bundles and keyboard hooks',()=>{
 const dashDir=fileURLToPath(new URL('.',import.meta.url));
 const contractAudit=verifyStaticBundle(dashDir,'Haggis',{allowDevFiles:true,verifyImportContract:true});
 expect(contractAudit).toMatchObject({ok:true,missing:[],leaks:[]});

 const dir=mkdtempSync(join(tmpdir(),'dash-import-'));
 try{
  const bundle=join(dir,'site');
  mkdirSync(bundle);
  for(const f of ['index.html','xp-tracker.js','client-shell.js','client-shell.css','client-viewer.css','map-shell.js','map-shell.css','operations.js','operations.css','items.json','RUNELITE-LICENSE.txt']){
   let text=readFileSync(join(dashDir,f),'utf8');
   if(/\.(html|css|js)$/i.test(f)){
    text=text.replace(/\/(client-shell|client-viewer|map-shell|operations|xp-tracker|items|worldmap)\.(css|js|png|json)/g,'$1.$2')
     .replace(/['"]\/client-assets\//g,m=>m[0]+'client-assets/')
     .replace(/items\.png/g,'items.webp')
     .replace(/worldmap\.png/g,'worldmap.webp');
   }
   if(f==='index.html')text=text.replace('<head>','<head><base href="./"><script src="config.js"></script><script src="shim.js"></script>');
   writeFileSync(join(bundle,f),text);
  }
  writeFileSync(join(bundle,'items.webp'),'webp');
  writeFileSync(join(bundle,'worldmap.webp'),'webp');
  writeFileSync(join(bundle,'config.js'),'window.FLEET_CONFIG={};');writeFileSync(join(bundle,'shim.js'),'window.FleetShim={};');
  cpSync(join(dashDir,'client-assets'),join(bundle,'client-assets'),{recursive:true});
  writeFileSync(join(bundle,'public.json'),JSON.stringify({bots:[{name:'⟦MAIN⟧',inWorld:true}],roster:[]}));

  const webpAudit=verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true});
  expect(webpAudit).toMatchObject({ok:true,missing:[],leaks:[]});

  writeFileSync(join(bundle,'client-shell.js'),readFileSync(join(bundle,'client-shell.js'),'utf8').replace('  window.atlasClient=','  window.brokenClient='));
  const brokenAudit=verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true});
  expect(brokenAudit.ok).toBe(false);
  expect(brokenAudit.missing).toContain('contract:connectViewerControls-keydown-end');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// A page comment that named shim.js once made import-page.ts leave both script tags out; that page shows no data.
test('verifyStaticBundle refuses an imported page that does not load config.js and shim.js',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dash-noshim-'));
 try{
  const bundle=join(dir,'site');
  importedSite(bundle);
  expect(verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true}).ok).toBe(true);
  writeFileSync(join(bundle,'index.html'),readFileSync(join(bundle,'index.html'),'utf8').replace('<script src="config.js"></script><script src="shim.js"></script>',''));
  const audit=verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true});
  expect(audit.ok).toBe(false);
  expect(audit.missing).toEqual(expect.arrayContaining(['import-contract -> index.html loads config.js','import-contract -> index.html loads shim.js']));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('verifyStaticBundle passes an imported site: links from viewer/ resolve in viewer/, and the gameKeys handler meets the contract',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dash-imported-'));
 try{
  const bundle=join(dir,'site');
  importedSite(bundle);
  expect(verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true})).toMatchObject({ok:true,missing:[],leaks:[]});

  // A relative link names a file beside the page, so a file at the site root does not answer a link from viewer/.
  writeFileSync(join(bundle,'only-at-root.js'),'');
  writeFileSync(join(bundle,'viewer','index.html'),readFileSync(join(bundle,'viewer','index.html'),'utf8').replace('</head>','<script src="only-at-root.js"></script></head>'));
  const misplaced=verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true});
  expect(misplaced.ok).toBe(false);
  expect(misplaced.missing).toEqual(['viewer/index.html -> viewer/only-at-root.js']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('verifyStaticBundle refuses an imported site whose gameKeys handler lost its viewer binding',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dash-imported-keys-'));
 try{
  const bundle=join(dir,'site');
  importedSite(bundle);
  const shell=join(bundle,'client-shell.js');
  writeFileSync(shell,readFileSync(shell,'utf8').replace("gameFrame.contentWindow.addEventListener('keydown',gameKeys,true);",''));
  const audit=verifyStaticBundle(bundle,'Haggis',{verifyImportContract:true,allowWebpImages:true});
  expect(audit.ok).toBe(false);
  expect(audit.missing).toEqual(['contract:connectViewerControls-imported']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a site that fails the audit is not pushed, and a site that passes it is',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dash-gate-'));
 try{
  const pushed:string[]=[];
  const push=async(d:string)=>{pushed.push(d);return 'pushed';};
  // The publisher copies main's site/ into the site worktree; with no site/ on main only the data files are there.
  const bare=join(dir,'bare');mkdirSync(bare);writeFileSync(join(bare,'public.json'),'{"bots":[]}');
  const refused=await pushAuditedSite(bare,push);
  expect(pushed).toEqual([]);
  expect(refused.result).toMatch(/^audit-failed \(import-contract -> index\.html, /);
  expect(refused.audit.ok).toBe(false);

  const good=join(dir,'good');importedSite(good);
  const sent=await pushAuditedSite(good,push);
  expect(pushed).toEqual([good]);
  expect(sent).toMatchObject({result:'pushed',audit:{ok:true}});

  // A leak names the file, never the account.
  writeFileSync(join(good,'public.json'),JSON.stringify({bots:[{name:'Haggis'}]}));
  const leak=await pushAuditedSite(good,push);
  expect(pushed).toEqual([good]);
  expect(leak.result).toBe('audit-failed (leak public.json)');

  // An audit that cannot read the folder refuses it too, and the cycle goes on to its log line.
  writeFileSync(join(good,'public.json'),'{"bots":[]}');
  writeFileSync(join(good,'client-assets','spellbook.json'),'{');
  const broken=await pushAuditedSite(good,push);
  expect(pushed).toEqual([good]);
  expect(broken.result).toMatch(/^audit-failed \(audit error: /);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

describe('the Pages build check after a site push',()=>{
 const repo='owner/dash',commit='e'.repeat(40),now=10_000_000;
 const fake=(answers:Record<string,{ok:boolean;out:string}>)=>{
  const calls:string[]=[];
  const api=async(...args:string[])=>{const key=args.join(' ');calls.push(key);return answers[key]??{ok:false,out:`no answer for ${key}`};};
  return {calls,api};
 };
 const GET='api repos/owner/dash/pages/builds/latest',POST='api -X POST repos/owner/dash/pages/builds';
 const build=(status:string,sha=commit,message:string|null=null)=>({ok:true,out:JSON.stringify({status,commit:sha,error:{message}})});

 // One push, made one check period before now.
 const one=(rebuilt=false)=>({pushes:[{commit,at:now-PAGES_CHECK_MS}],dueAt:now,rebuilt});

 test('asks nothing before the check is due, or with no push to check',async()=>{
  const {calls,api}=fake({});
  const watch={pushes:[{commit,at:now}],dueAt:now+1,rebuilt:false};
  expect(await checkPages(watch,now,api,repo)).toEqual({watch,note:''});
  expect(await checkPages(null,now,api,repo)).toEqual({watch:null,note:''});
  expect(calls).toEqual([]);
 });

 test('a built page costs one call and ends the check',async()=>{
  const {calls,api}=fake({[GET]:build('built')});
  expect(await checkPages(one(),now,api,repo)).toEqual({watch:null,note:' pages=built'});
  expect(calls).toEqual([GET]);
 });

 test('a build still running at the check is stuck: one rebuild request, then one more check',async()=>{
  const {calls,api}=fake({[GET]:build('building'),[POST]:{ok:true,out:'{"status":"queued"}'}});
  const r=await checkPages(one(),now,api,repo);
  expect(r).toEqual({watch:{...one(),dueAt:now+PAGES_CHECK_MS,rebuilt:true},note:' pages=stuck rebuild=requested'});
  expect(calls).toEqual([GET,POST]);
 });

 test('an errored build gives its reason and gets a rebuild',async()=>{
  const {api}=fake({[GET]:build('errored',commit,'Deployment failed, try again later.'),[POST]:{ok:true,out:'{}'}});
  const r=await checkPages(one(),now,api,repo);
  expect(r.note).toBe(' pages=errored (Deployment failed, try again later.) rebuild=requested');
  expect(r.watch?.rebuilt).toBe(true);
 });

 test('a page built from a commit before the pushes is behind and gets a rebuild',async()=>{
  const {calls,api}=fake({[GET]:build('built','a'.repeat(40)),[POST]:{ok:true,out:'{}'}});
  expect((await checkPages(one(),now,api,repo)).note).toBe(' pages=behind rebuild=requested');
  expect(calls).toEqual([GET,POST]);
 });

 test('after the one rebuild the check reports and stops',async()=>{
  const built=fake({[GET]:build('built')});
  expect(await checkPages(one(true),now,built.api,repo)).toEqual({watch:null,note:' pages=built after rebuild'});
  const stuck=fake({[GET]:build('building')});
  expect(await checkPages(one(true),now,stuck.api,repo)).toEqual({watch:null,note:' pages=stuck rebuild=spent'});
  expect(stuck.calls).toEqual([GET]);
 });

 test('a failed read or a refused rebuild ends the check with the reason',async()=>{
  const unread=fake({[GET]:{ok:false,out:'HTTP 503: Service Unavailable'}});
  expect(await checkPages(one(),now,unread.api,repo)).toEqual({watch:null,note:' pages=unread (HTTP 503: Service Unavailable)'});
  expect(unread.calls).toEqual([GET]);
  const refused=fake({[GET]:build('errored'),[POST]:{ok:false,out:'HTTP 403: Resource not accessible'}});
  expect(await checkPages(one(),now,refused.api,repo)).toEqual({watch:null,note:' pages=errored rebuild=refused (HTTP 403: Resource not accessible)'});
 });

 test('pushes more often than the check period keep the first deadline, so the check still runs',async()=>{
  // PUBLIC_EVERY_S=60: a push every cycle. Each later push joins the check; none of them moves its deadline.
  const t0=now-PAGES_CHECK_MS,[a,b,c]=['a','b','c'].map(x=>x.repeat(40));
  let watch=watchPush(null,a!,t0);
  expect(watch).toEqual({pushes:[{commit:a,at:t0}],dueAt:now,rebuilt:false});
  watch=watchPush(watch,b!,t0+60_000);watch=watchPush(watch,c!,t0+120_000);
  expect(watch.dueAt).toBe(now);
  // The newest push is 60 s old, so its running build is no fault.
  const young=fake({[GET]:build('building',c)});
  expect(await checkPages(watch,now,young.api,repo)).toEqual({watch:null,note:' pages=building'});
  expect(young.calls).toEqual([GET]);
  // A page built from an earlier push counts while every later push is still young.
  const earlier=fake({[GET]:build('built',b)});
  expect(await checkPages(watch,now,earlier.api,repo)).toEqual({watch:null,note:' pages=built'});
  // Read later (as after a rebuild): a later push older than the check period with no build leaves the page behind.
  const late=fake({[GET]:build('built',a),[POST]:{ok:true,out:'{}'}});
  expect((await checkPages(watch,now+120_000,late.api,repo)).note).toBe(' pages=behind rebuild=requested');
  // A build of an early push that still runs one check period after that push is stuck.
  const hung=fake({[GET]:build('building',a),[POST]:{ok:true,out:'{}'}});
  expect((await checkPages(watch,now,hung.api,repo)).note).toBe(' pages=stuck rebuild=requested');
 });
});

test('pushSingleCommit refreshes the author timestamp when amending an older commit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-data-')),remote=join(dir,'remote'),data=join(dir,'data');
 const git=async(cwd:string,...args:string[])=>{
  const result=await run(['git',...args],cwd,5000);
  if(!result.ok)throw Error(result.out);
  return result.out;
 };
 try{
  await git(dir,'init','-q','--bare',remote);
  mkdirSync(data);
  await git(data,'init','-q','-b','data');
  await git(data,'config','user.name','Publisher test');
  await git(data,'config','user.email','publisher@example.test');
  await git(data,'remote','add','origin',remote);
  writeFileSync(join(data,'control.json'),'{"v":1}');
  await git(data,'add','-A');
  await git(data,'commit','-q','--date=2020-01-01T00:00:00Z','-m','Old commit');
  const beforeSec=Math.floor(Date.now()/1000);
  writeFileSync(join(data,'control.json'),'{"v":2}');
  expect(await pushSingleCommit(data,'data','Publish control')).toBe('pushed');
  const authorSec=Number(await git(data,'log','-1','--format=%at'));
  expect(authorSec).toBeGreaterThanOrEqual(beforeSec-5);
  expect(await git(data,'rev-list','--count','HEAD')).toBe('1');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('verifyStaticBundle flags secret account leaks in secondary static scripts and stylesheets',()=>{
 const dashDir=fileURLToPath(new URL('.',import.meta.url));
 const dir=mkdtempSync(join(tmpdir(),'dash-leak-'));
 try{
  const bundle=join(dir,'site');
  mkdirSync(bundle);
  for(const f of ['index.html','client-shell.js','client-shell.css','operations.js','operations.css','map-shell.js','map-shell.css','client-viewer.css','xp-tracker.js','items.png','worldmap.png']){
   if(existsSync(join(dashDir,f)))cpSync(join(dashDir,f),join(bundle,f));
  }
  cpSync(join(dashDir,'client-assets'),join(bundle,'client-assets'),{recursive:true});
  writeFileSync(join(bundle,'public.json'),JSON.stringify({bots:[],roster:[]}));
  writeFileSync(join(bundle,'map-shell.js'),readFileSync(join(bundle,'map-shell.js'),'utf8')+'\n// Haggis\n');
  const leak=verifyStaticBundle(bundle,'Haggis');
  expect(leak.ok).toBe(false);
  expect(leak.leaks).toContain('map-shell.js');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
