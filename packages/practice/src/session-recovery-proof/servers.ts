import {Database} from 'bun:sqlite';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import {killTree} from '../../../core/src/proc';
import {readPracticeSave} from '../fleet-player-save';
import {authReplies,recoverySessionAuth} from './auth';
import {engine,root} from './boundary';
import {installAuthObserver,installButtonObserver,installLocObserver} from './observers';
import {reconcileSaves,type Save} from './reconcile';

export async function startPrivateEnvironment(o:{
 directory:string;workspace:string;loginPort:number;loginEnv:Record<string,string>;
 children:ReturnType<typeof Bun.spawn>[];junctions:string[];
}){
 const {directory,workspace,loginPort,loginEnv,children,junctions}=o;
 // Private world: fresh keys, private DB and saves. Only immutable packed content is linked.
 for(const folder of ['data/config','data/players/main'])mkdirSync(join(workspace,folder),{recursive:true});
 const keys=generateKeyPairSync('rsa',{modulusLength:1024,publicExponent:65537});
 writeFileSync(join(workspace,'data/config/public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
 writeFileSync(join(workspace,'data/config/private.pem'),keys.privateKey.export({type:'pkcs1',format:'pem'}));
 const jwk=keys.publicKey.export({format:'jwk'});
 for(const p of ['data/pack','data/raw','view']){symlinkSync(join(engine,p),join(workspace,p),'junction');junctions.push(join(workspace,p));}
 const worldConfig={easyStartup:false,website:{registration:false},web:{port:8890,managementPort:8896},node:{id:77,port:43651,members:true,autoSubscribeMembers:true,profile:'main',hopTime:45000},login:{enabled:true,host:'localhost',port:loginPort},friend:{enabled:false},logger:{enabled:false},db:{backend:'sqlite'}};
 writeFileSync(join(workspace,'data/config/world.json'),JSON.stringify(worldConfig,null,2));
 const db=new Database(join(workspace,'db.sqlite'));const migrations=join(engine,'prisma/singleworld/migrations');
 for(const name of readdirSync(migrations).sort()){const p=join(migrations,name,'migration.sql');if(existsSync(p))db.exec(readFileSync(p,'utf8'));}db.close();
 const observer=join(directory,'observe-auth.ts'),authTrace=join(directory,'auth-observations.log'),sealRequest=join(directory,'auth-seal-request'),sealAck=join(directory,'auth-sealed');
 writeFileSync(authTrace,'',{flag:'wx'});
 writeFileSync(observer,`import{createRequire}from'node:module';import{appendFileSync,existsSync,writeFileSync}from'node:fs';const req=createRequire(${JSON.stringify(join(engine,'package.json'))});const {WebSocketServer}=req('ws');const observer=(${installAuthObserver.toString()})(WebSocketServer,line=>{appendFileSync(${JSON.stringify(authTrace)},line+'\\n');console.log(line);});const timer=setInterval(()=>{if(existsSync(${JSON.stringify(sealRequest)})){observer.seal();writeFileSync(${JSON.stringify(sealAck)},'sealed');clearInterval(timer);}},50);timer.unref();`);
 // 127.0.0.1, not localhost: the login server binds 0.0.0.0 (IPv4 only, LoginServer.ts:379), and on this PC localhost
 // can resolve to ::1 first; the world's login client then never connects and every login reads "login server offline".
 const env={...process.env,DB_BACKEND:'sqlite',LOGIN_SERVER:'true',LOGIN_HOST:'127.0.0.1',LOGIN_PORT:String(loginPort),EASY_STARTUP:'false',NODE_ID:'77',NODE_PORT:'43651',NODE_MEMBERS:'true',NODE_TICKRATE:'150',WEB_PORT:'8890',WEB_MANAGEMENT_PORT:'8896',WEBSITE_REGISTRATION:'false',FRIEND_SERVER:'false',LOGGER_SERVER:'false'};
 // GameMap.init refuses to load packed locations without this immutable content/maps root.
 const nativeMapSource=resolve(engine,'../content');
 Object.assign(env,{BUILD_SRC_DIR:nativeMapSource});
 if(!existsSync(join(nativeMapSource,'maps')))throw Error('native recovery map source missing');
 const spawnServer=(args:string[],log:string,extra:Record<string,string>={})=>{const p=Bun.spawn(args,{cwd:workspace,env:{...env,...extra},stdout:Bun.file(join(directory,log+'.out.log')),stderr:Bun.file(join(directory,log+'.err.log')),windowsHide:true});children.push(p);return p;};
 const waitLog=async(p:ReturnType<typeof Bun.spawn>,file:string,pattern:RegExp)=>{const until=Date.now()+60000;while(Date.now()<until){if(p.exitCode!==null)throw Error('native server exited: '+file);if(existsSync(join(directory,file))&&pattern.test(readFileSync(join(directory,file),'utf8')))return;await Bun.sleep(200);}throw Error('native server readiness timeout: '+file);};
 const login=spawnServer([process.execPath,'--preload',observer,join(engine,'src/login.ts')],'login',loginEnv);await waitLog(login,'login.out.log',/Login server listening/);
 // The world observer attaches after app.ts has loaded its modules, so the preload never changes import order.
 // A missing or failed attach is recorded and the proof continues; the modal case keeps whatever was observed.
 const worldObserver=join(directory,'observe-world.ts'),buttonTrace=join(directory,'button-observations.log'),attachRequest=join(directory,'button-attach-request'),attachAck=join(directory,'button-attached');
 writeFileSync(buttonTrace,'',{flag:'wx'});
 const engineModule=(p:string)=>JSON.stringify(join(engine,'src',p));
 writeFileSync(worldObserver,`import{appendFileSync,existsSync,writeFileSync}from'node:fs';const trace=${JSON.stringify(buttonTrace)};const timer=setInterval(async()=>{if(!existsSync(${JSON.stringify(attachRequest)}))return;clearInterval(timer);try{const[n,b,d,c,r,w,s]=await Promise.all([${['engine/entity/NetworkPlayer.ts','network/game/client/handler/IfButtonHandler.ts','network/game/client/handler/IdkSaveDesignHandler.ts','cache/config/Component.ts','network/game/client/ClientGameProtRepository.ts','engine/World.ts','server/ws/WSClientSocket.ts'].map(p=>'import('+engineModule(p)+')').join(',')}]);(${installButtonObserver.toString()})({NetworkPlayer:n.NetworkPlayer,IfButtonHandler:b.default,IdkSaveDesignHandler:d.default,Component:c.default,Repository:r.default,World:w.default,WSClientSocket:s.default},line=>appendFileSync(trace,line+'\\n'));writeFileSync(${JSON.stringify(attachAck)},'attached');}catch{writeFileSync(${JSON.stringify(attachAck)},'failed');}},50);timer.unref();`);
 const locTrace=join(directory,'loc-observations.log');
 appendFileSync(worldObserver,`\nconst locTimer=setInterval(async()=>{if(!existsSync(${JSON.stringify(attachAck)}))return;clearInterval(locTimer);try{const[h,l,w]=await Promise.all([import(${engineModule('network/game/client/handler/OpLocHandler.ts')}),import(${engineModule('cache/config/LocType.ts')}),import(${engineModule('engine/World.ts')})]);(${installLocObserver.toString()})({OpLocHandler:h.default,LocType:l.default,World:w.default},line=>appendFileSync(${JSON.stringify(locTrace)},line+'\\n'));appendFileSync(${JSON.stringify(locTrace)},'LOC_ATTACHED\\n');}catch{appendFileSync(${JSON.stringify(locTrace)},'LOC_ATTACH_FAILED\\n');}},50);locTimer.unref();`);
 const world=spawnServer([process.execPath,'--preload',worldObserver,join(engine,'src/app.ts')],'world');await waitLog(world,'world.out.log',/World ready|World is ready|World started|world is ready/i);
 writeFileSync(attachRequest,'attach');
 for(const until=Date.now()+10000;!existsSync(attachAck)&&Date.now()<until;)await Bun.sleep(50);
 appendFileSync(buttonTrace,'BUTTON_ATTACH '+JSON.stringify({state:existsSync(attachAck)?readFileSync(attachAck,'utf8'):'timeout'})+'\n');
 return {jwk,worldConfig,observer,authTrace,sealRequest,sealAck,buttonTrace,login,world,loginLog:()=>readFileSync(authTrace,'utf8')};
}

// An owner process using the real per-account producer. The root chooses whether the controller can see it.
export async function createFixtureOwner(o:{
 publishControlModule:string;f:{name:string;envPath:string;server:string};dir:string;
 mode:'hold'|'warm'|'orphan'|'partial';lifecycle:string;source:string;children:ReturnType<typeof Bun.spawn>[];
}){
 const {publishControlModule,f,dir,mode,lifecycle,source,children}=o;
 const script=join(dir,'owner.ts'),ready=join(dir,'owner-ready.json'),release=join(dir,'owner-release'),takeover=join(dir,'owner-takeover'),warmFile=join(dir,'owner-warm.json');
 const core=(p:string)=>JSON.stringify(join(root,'packages/core/src',p));
 writeFileSync(script,`import{readFileSync,existsSync}from'node:fs';import{publishControlFile}from${JSON.stringify(publishControlModule)};import{connectInProcess}from${core('inprocess.ts')};import{logoutSession}from${core('bot.ts')};import{waitUntil}from${core('ticks.ts')};
const password=readFileSync(${JSON.stringify(f.envPath)},'utf8').match(/^PASSWORD=(.*)$/m)?.[1]?.trim()!,mode=${JSON.stringify(mode)};
const open=()=>connectInProcess({name:${JSON.stringify(f.name)},password,server:${JSON.stringify(f.server)},lifecycleRoot:${JSON.stringify(lifecycle)}});
const view=(s:any)=>{const x=s.sdk.getState();return{inGame:x?.inGame,player:x?.player&&{x:x.player.worldX,z:x.player.worldZ,level:x.player.level,hp:x.player.hp},inventory:x?.inventory?.map((i:any)=>({id:i.id,count:i.count})),equipment:x?.equipment?.map((i:any)=>({id:i.id,count:i.count}))};};
if(mode==='partial'){publishControlFile(${JSON.stringify(ready)},{at:Date.now(),pid:process.pid});await open();throw Error('partial owner unexpectedly connected');}
let s=await open();if(!await waitUntil(s,x=>x?.inGame&&x.player?.hp>0,{timeoutTicks:100,idleMs:10000}))throw Error('owner not ready');
const loggedInAt=Date.now(),first=s.lifecycle?.attemptId;
publishControlFile(${JSON.stringify(ready)},{at:Date.now(),loggedInAt,pid:process.pid,first,attemptId:s.lifecycle?.attemptId,state:view(s)});
if(mode==='warm'){const signal=Date.now()+300000;while(!existsSync(${JSON.stringify(takeover)})&&Date.now()<signal)await Bun.sleep(20);if(!existsSync(${JSON.stringify(takeover)}))throw Error('warm takeover signal timeout');
 const signalSeenAt=Date.now(),b=await open();if(!await waitUntil(b,x=>x?.inGame&&x.player?.hp>0,{timeoutTicks:100,idleMs:10000}))throw Error('warm takeover not ready');await s.close();s=b;
 publishControlFile(${JSON.stringify(warmFile)},{at:Date.now(),signalSeenAt,attemptId:s.lifecycle?.attemptId});}
const until=Date.now()+300000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<until)await Bun.sleep(50);
publishControlFile(${JSON.stringify(join(dir,'owner-after.json'))},{at:Date.now(),state:view(s)});console.log('OWNER_LOGOUT '+await logoutSession(s));await s.close();`);
 const p=Bun.spawn([process.execPath,script],{cwd:root,env:{...process.env,BOT_GOAL:'native-recovery-owner-fixture',COORDINATOR_RUN_ID:'native-owner-'+f.name,WORKER_RELEASE:source},stdout:Bun.file(join(dir,'owner.log')),stderr:Bun.file(join(dir,'owner.err')),windowsHide:true});children.push(p);
 const until=Date.now()+90000;while(!existsSync(ready)&&Date.now()<until){if(p.exitCode!==null)throw Error('owner fixture exited before ready: '+mode);await Bun.sleep(100);}
 if(!existsSync(ready))throw Error('owner fixture readiness timeout: '+mode);
 return {p,ready:JSON.parse(readFileSync(ready,'utf8')),
  // Warm only: the owner takes over its own live session now, so the window opens at a known point.
  takeover:async()=>{const signalAt=Date.now();writeFileSync(takeover,'takeover');const end=Date.now()+60000;
   while(!existsSync(warmFile)&&Date.now()<end){if(p.exitCode!==null)throw Error('owner fixture exited before warm takeover');await Bun.sleep(20);}
   if(!existsSync(warmFile))throw Error('owner warm takeover timeout');return {signalAt,...JSON.parse(readFileSync(warmFile,'utf8'))} as {signalAt:number;at:number;signalSeenAt:number;attemptId:string};},
  release:async()=>{const at=Date.now();writeFileSync(release,'release');const t=setTimeout(()=>void killTree(p.pid),60000);await p.exited;clearTimeout(t);return at;}};
}

// The capability's actual entry after a confirmed recovery: scripts/session-check.ts <account> logs in, sees the
// account in game and logs out. Its producer attempt goes to the checkout's own lifecycle tree (the CLI has no root
// option), and a fresh save after its logout must hold the same items, skills and tile.
export async function runSessionCheckCase(o:{
 f:{name:string;save:string;server:string};dir:string;before:Save;source:string;
 children:ReturnType<typeof Bun.spawn>[];freshSave:(f:{save:string},before:Save)=>Promise<boolean>;loginLog:()=>string;
}){
 const {f,dir,before,source,children,freshSave,loginLog}=o;
 const since=Date.now(),env:Record<string,string|undefined>={...process.env,FLEET_SIDE:'local',WORKER_RELEASE:source};delete env.COORDINATOR_RUN_ID;
 const cli=Bun.spawn([process.execPath,'scripts/session-check.ts',f.name],{cwd:root,env,stdout:Bun.file(join(dir,'session-check.out.log')),stderr:Bun.file(join(dir,'session-check.err.log')),windowsHide:true});
 children.push(cli);const t=setTimeout(()=>void killTree(cli.pid),120000);const code=await cli.exited;clearTimeout(t);
 const persisted=await freshSave(f,before);copyFileSync(f.save,join(dir,'session-check-after.sav'));
 const after=readPracticeSave(join(dir,'session-check-after.sav')),rec=reconcileSaves(before,after),text=readFileSync(join(dir,'session-check.out.log'),'utf8');
 const proof=readLogoutProof(f.name,f.server),session=recoverySessionAuth(authReplies(loginLog(),since,f.name),f.name);
 writeFileSync(join(dir,'session-check.json'),JSON.stringify({code,proof,session},null,2));
 return {sessionCheckExit:code===0,sessionCheckChecked:/^RESULT ok sessionChecked=1 /m.test(text),sessionCheckLogout:/^LOGOUT logged-out$/m.test(text),
  sessionCheckProducerConfirmed:proof.state==='confirmed',sessionCheckLoginAcknowledged:session.loginAcknowledged,sessionCheckLogoutAcknowledged:session.logoutAcknowledged,
  sessionCheckFreshSave:persisted,sessionCheckInventories:rec.inventories,sessionCheckSkills:rec.skills,sessionCheckPosition:rec.position};
}
