import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const html=readFileSync(process.env.DASH_PAGE || new URL('./index.html',import.meta.url),'utf8');

function viewerReady(state:any,selected:string|null){
 const code=html.slice(html.indexOf("window.addEventListener('message',e=>{"),html.indexOf('function syncWorld(){'));
 const sent:any[]=[];let handler:any;const frame={postMessage:(m:any)=>sent.push(m)},window:any={...state,addEventListener:(_t:string,f:any)=>handler=f};
 new Function('window','$','viewerMessage','viewerCanReveal','sel',`let VIEWER={origin:'http://test',state:'loading'},VIEWER_TIMER;const mode='3d',showViewerStatus=()=>{},viewerUnavailable=()=>{};${code}`)(window,()=>({contentWindow:frame}),()=>({state:'ready',privacyReady:true,renderReady:true}),()=>true,selected);
 return {sent,ready:()=>handler({source:frame,origin:'http://test',data:{}})};
}

test('Free camera intent is replayed when the 3D frame becomes ready',()=>{
 const v=viewerReady({atlasFreeCamera:true},null);v.ready();expect(v.sent).toEqual([{atlasFreeCamera:true}]);
});

test('a release for an offline account is replayed once when the 3D frame becomes ready',()=>{
 const v=viewerReady({atlasFreeCamera:true},'Away');v.ready();v.ready();expect(v.sent).toEqual([{atlasFreeCamera:true}]);
});

test('a follow chosen during loading is replayed once when the 3D frame becomes ready',()=>{
 const v=viewerReady({},'Worker');v.ready();v.ready();expect(v.sent).toEqual([{follow:'Worker'}]);
});

test('a chosen camera destination stays labelled as the destination, not the selected account position',()=>{
 const code=html.slice(html.indexOf('function syncWorld(){'),html.indexOf('function chainHud(){'));
 const follow={textContent:''};
 new Function('$',`const S={bots:[{name:'Worker',at:1}]},sel='Worker',mode='2d',VIEWER={url:null},window={atlasFreeCamera:true,atlasDestination:{x:3200,z:3450}},age=()=>'old',showViewerStatus=()=>{};${code};syncWorld();`)(()=>follow);
 expect(follow.textContent).toContain('3200, 3450');expect(follow.textContent).not.toContain('Worker');
});
test('following a visitor clears the free camera destination before rendering',()=>{
 const code=html.slice(html.indexOf('window.atlasFollow3d='),html.indexOf('\n',html.indexOf('window.atlasFollow3d=')));
 const sent:any[]=[];const window:any={atlasFreeCamera:true,atlasDestination:{x:3200,z:3450}};let rendered:any;
 new Function('window','$','render',`const mode='3d',VIEWER={state:'ready',origin:'http://viewer'};${code}`)(window,()=>({contentWindow:{postMessage:(m:any)=>sent.push(m)}}),()=>rendered={free:window.atlasFreeCamera,destination:window.atlasDestination,following:window.atlasFollowOther});
 expect(window.atlasFollow3d('Visitor')).toBe(true);
 expect(rendered).toEqual({free:false,destination:null,following:'Visitor'});
 expect(sent).toEqual([{follow:'Visitor'}]);
});
test('a shared visitor follow waits for the viewer and takes priority over the selected fleet account',()=>{
 const code=html.slice(html.indexOf('window.atlasFollow3d='),html.indexOf('\n',html.indexOf('window.atlasFollow3d=')));
 const sent:unknown[]=[];const window:any={atlasFreeCamera:true};
 new Function('window','$','render',`const mode='2d',VIEWER={state:'checking'};${code}`)(window,()=>({contentWindow:{postMessage:(m:unknown)=>sent.push(m)}}),()=>{});
 expect(window.atlasFollow3d('Visitor')).toBe(false);
 expect(window.atlasFollow3d('Visitor',true)).toBe(true);
 expect(sent).toEqual([]);
 const viewer=viewerReady(window,'Worker');
 viewer.ready();viewer.ready();
 expect(viewer.sent).toEqual([{follow:'Visitor'}]);
});
const source=html.slice(html.indexOf('function chainHud(){'),html.indexOf("$('#chain').addEventListener"));
for(const chain of [null,{cook:null,courier:null,farmers:[]},
    {cook:{name:'Cook',fresh:false,at:10},courier:null,farmers:[]},
    {cook:null,courier:{name:'Courier',fresh:false,at:10},farmers:[]}]) {
    test(`food chain renders missing participants: ${JSON.stringify(chain)}`,()=>{
        const el={style:{display:''},html:''};
        const run=new Function('S','$','put','icon','nf','E','ago',source+';chainHud();');
        expect(()=>run({chain,now:20},()=>el,(target:any,value:string)=>target.html=value,
            ()=>'',String,String,String)).not.toThrow();
        if(chain===null)expect(el.style.display).toBe('none');
        else if(chain.cook)expect(el.html).toContain('Cook');
        else if(chain.courier)expect(el.html).toContain('Courier');
    });
}

const escape=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
test('next action selects explicit instructions instead of presenting old proof as future work',()=>{
 const code=html.slice(html.indexOf('function nextAction(b){'),html.indexOf('function latestGain('));
 const run=new Function('b',code+';return nextAction(b);');
 expect(run({planJob:{note:'Two batches passed. Next: qualify iron production. Keep stocks.'}})).toBe('qualify iron production');
 expect(run({planJob:{note:'Next qualification: saved-state quest entry; keep main offline.'}})).toBe('saved-state quest entry; keep main offline');
 expect(run({planJob:{note:'Stock met. Before re-enable, prove refill.'}})).toBe('Before re-enable, prove refill');
 expect(run({planJob:{note:'Old proof passed.'}})).toBe('Review assignment note; next action not explicit');
 expect(run({})).toBe('Not assigned');
 expect(run({planJob:{note:'Next qualify gear.'},job:{note:'Next farm oak.'}})).toBe('qualify gear');
});
test('latest level gain requires recent successful live counters, not a heartbeat or old goal',()=>{
 const code=html.slice(html.indexOf('function latestGain('),html.indexOf('function roster(){'));
 const run=new Function('bots','now',code+';return latestGain(bots,now);');
 const good={name:'Worker',at:1000,result:'ok mode=cow trainSkill=Defence targetLevel=10',counters:{startLevel:1,finalLevel:14,selectedXp:1800}};
 expect(run([good],2000)?.name).toBe('Worker');
 for(const change of [{practice:true},{reserved:true},{at:3000},{at:0},{result:'fail trainSkill=Defence'},{result:''},{counters:{startLevel:14,finalLevel:14,selectedXp:1}},{counters:{startLevel:1,finalLevel:100,selectedXp:1}}])expect(run([{...good,...change}],2000)).toBeNull();
 expect(run([good],3601000)).toBeNull();
});
test('allocation separates useful demand waits, finished batches and repair holds',()=>{
 const source=html.slice(html.indexOf('function allocation(b){'),html.indexOf('const ALLOCATION='));
 const classify=new Function('b',source+';return allocation(b);');
 expect(classify({operation:'offline',planJob:{enabled:true,state:'waiting offline: no fresh demand'}})).toBe('demand');
 expect(classify({operation:'offline',planJob:{enabled:true,state:'ended: done after 1 runs'}})).toBe('next');
 expect(classify({operation:'blocked',planJob:{enabled:true,state:'ended: done after 1 runs'}})).toBe('repair');
 expect(classify({operation:'active-stale',planJob:{state:'running'}})).toBe('repair');
 expect(classify({operation:'offline',planJob:{enabled:false,state:'disabled'},job:{state:'ended: done'}})).toBe('held');
 expect(classify({operation:'reserved',planJob:{enabled:false}})).toBe('reserved');
 expect(classify({operation:'observed',planJob:{enabled:false}})).toBe('observed');
 expect(classify({operation:'offline'})).toBe('unknown');
 expect(classify({operation:'offline',job:{enabled:true,state:'ended: done'}})).toBe('next');
});
test('work metric shows capped earners coin stock without claiming earnings',()=>{
 const source=html.slice(html.indexOf('function workMetric(b){'),html.indexOf('function roster(){'));
 const metric=new Function('b','observedAt','compact','nf',source+';return workMetric(b);');
 const run=(b:any,fresh=true)=>metric(b,()=>fresh,String,String);
 expect(run({role:'thieving',inventory:[{id:995,count:100},{id:995,count:50}],xpPerTick:0}).text).toBe('150 gp');
 expect(run({role:'thieving',inventory:[]}).text).toBe('0 gp');
 expect(run({role:'thieving'}).text).toBe('?');
 expect(run({role:'thieving',inventory:[{id:995,count:-1}]}).text).toBe('?');
 expect(run({role:'thieving',inventory:[{id:995,count:100}]},false).text).toBe('—');
 expect(run({role:'smithing',xpPerTick:12}).text).toBe('12/t');
 expect(run({role:'smithing'}).text).toBe('?');
 expect(run({role:'thieving',inventory:[]}).title).toContain('not earnings or net profit');
});
const rosterSource=html.slice(html.indexOf('function hasStopProof('),html.indexOf('function roster(){'));
function rosterFunctions(){return new Function('S','E','ago','sel','ocIcon',rosterSource+';return{offlineGoal,offWhy,rowOff,operationPhase,hasStopProof,resultKind,nativeProofPanel,boundedLabel,controllerEvidence,cleanupBadge};')({now:600000},escape,()=> '1m','',()=>'<i>raw outcome</i>');}
const stopProof={kind:'host-stop-cleanup',outcome:'proved',level:'local-native',workerOutcome:'fail',goalMet:false,scope:'four sent inputs settled; assets banked'};

test('goal cards use current plan actions while preserving evidence metrics and unknown-plan fallback',()=>{
 const code=html.slice(html.indexOf('function goalPlanFor('),html.indexOf('function goalCards(){'));
 const titles=['Fleet & wealth','Collection & gear','Quests · unlocks · 99s','Specialist hiscores','Main Overall','Tick efficiency'];
 const planTitles=['Wealth / logistics / GE','Gear / collection','Coverage','Specialist hiscores','Main Overall','Efficiency / visibility'];
 const progress=titles.map((title,i)=>({title,metric:`evidence${i}`,next:'historical action'}));
 const run=new Function('S',code+';return goalMetrics();');
 const state={objectives:{available:true,progress,lanes:planTitles.map((title,i)=>({title,next:`current${i}`}))}};
 expect(run(state).map((g:any)=>g.next)).toEqual(progress.map((_,i)=>`current${i}`));
 expect(run(state).map((g:any)=>g.metric)).toEqual(progress.map(g=>g.metric));
 state.objectives.available=false;expect(run(state)[0].next).toBe('historical action');
 expect(progress[0]!.next).toBe('historical action');
});

test('dashboard commerce policy matches authorized GE use',()=>{
 expect(html).toContain('GE ENABLED · LIMIT ORDERS');expect(html).not.toContain('OWNED ONLY · NO GE');
});

test('host resources keep missing capacity and RAM headroom unknown',()=>{
 const code=html.slice(html.indexOf('function inspect(){'),html.indexOf('function connectionState(){'));
 const end=code.indexOf('\nfunction ',1),inspectCode=end<0?code:code.slice(0,end),procAt=html.indexOf('function procGroups('),procCode=html.slice(procAt,html.indexOf('\n',procAt));
 const run=new Function('S',`${procCode};let view='machine',detailPages=1,detailPage=0,captured;const innerWidth=1280,document={querySelectorAll:()=>[]},box={},world={parentElement:null},$=s=>s==='#inspector'?box:s==='#world-panel'?world:{},machine=()=>S.sys,row=(label,value,tone)=>({label,value,tone}),pagedRows=rows=>{captured=rows},age=()=>'',observedAt=()=>false;${inspectCode};inspect();return captured;`);
 const rows=run({capacity:{active:null,cap:null,fresh:false,headroomGB:null},sys:{freeGB:8,totalGB:32}});
 expect(rows.find((r:any)=>r.label==='Bots running').value).toBe('? / ?');
 expect(rows.find((r:any)=>r.label==='RAM headroom')).toEqual({label:'RAM headroom',value:'?',tone:'warn'});
 const procs=run({capacity:null,sys:{freeGB:8,totalGB:32,procs:[{pid:7,script:'app.ts',mb:1380},{pid:8,script:'coordinator-cli.ts',mb:1000},{pid:9,script:'coordinator-cli.ts',mb:1048}]}}).slice(-2);
 expect(procs.map((r:any)=>[r.label,r.value])).toEqual([['coordinator-cli.ts ×2','2,048 MB · 6.3%'],['app.ts','1,380 MB · 4.2% · 7']]);
});

test('dashboard inline JavaScript parses without running browser or making requests',()=>{
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
    expect(scripts.length).toBeGreaterThan(0);for(const js of scripts)expect(()=>new Function(js)).not.toThrow();
});
test('offline roster keeps goal, failure and state readable while long raw controller note stays in title',()=>{
    const f=rosterFunctions(),raw='LONG_RAW_CONTROLLER_NOTE_'.repeat(100);
    const row=f.rowOff({name:'Worker',role:'crafting',operation:'blocked',currentGoal:'Old worker goal',lastRes:{text:'fail made=0 held=20',ok:false,at:1},planJob:{state:'disabled',goal:'Make useful strings',note:raw}});
    const visible=row.replace(/title="[^"]*"/g,'');
    expect(visible).toContain('worker failed');expect(visible).toContain('blocked');expect(visible).toContain('disabled');
    expect(visible).toContain('Make useful strings');expect(visible).not.toContain('Old worker goal');expect(visible).not.toContain(raw);expect(row).toContain(raw);
    expect(f.offlineGoal({reserved:true,currentGoal:'private identity'})).toBe('private main · reserved');
});
test('raw milestones are labelled historical and stale named phases retain evidence',()=>{
    const f=rosterFunctions();expect(f.operationPhase({phaseShort:'picks=20 banked=0 held=20'})).toBe('Last recorded milestone · open detail for counters');
    expect(f.operationPhase({phaseShort:'Walking to bank',phaseSince:1})).toBe('Last phase: Walking to bank');
    expect(f.operationPhase({phaseShort:'fail held=20 bank not ready'})).toBe('fail held=20 bank not ready');
});
test('stop cleanup proof stays separate from failed work and never upgrades the raw worker outcome',()=>{
    const f=rosterFunctions(),rows=[{ok:true},{ok:true},{ok:false,nativeProof:stopProof},{ok:false},{ok:false}];
    expect(rows.map(f.resultKind)).toEqual(['ok','ok','stop-proof','fail','fail']);
    expect(f.hasStopProof({...stopProof,level:'unit'})).toBe(false);expect(f.hasStopProof({...stopProof,goalMet:true})).toBe(false);
    const body=f.nativeProofPanel({nativeProof:stopProof});expect(body).toContain('Stop cleanup proved · work stopped');expect(body).toContain('Raw worker result remains fail');
    expect(f.nativeProofPanel({nativeProof:{...stopProof,source:{matchesCurrent:false}}})).toContain('Historical source');
    const paused=f.offWhy({operation:'paused',outcome:'fail',result:'fail stop-file',nativeProof:stopProof});
    expect(paused.html).toContain('worker stopped');expect(paused.tip).toContain('fail stop-file');
});
test('non-shop goal completion, reserved account and known inspection tasks use accurate plain labels',()=>{
    const f=rosterFunctions();expect(f.boundedLabel({bounded:{targetMet:true,label:'Stock target met',counters:{buried:175}}})).toBe('Goal reached');
    expect(f.boundedLabel({bounded:{targetMet:true,label:'Stock target met',counters:{boughtTotal:40}}})).toBe('Stock target met');
    const reserved=f.rowOff({name:'private',reserved:true}).replace(/title="[^"]*"/g,'');expect(reserved).not.toContain('unmanaged');expect(reserved).toContain('reserved');
    expect(f.operationPhase({phaseShort:'fleet-bank-inspect.ts'})).toBe('Bank inspection');
    expect(f.operationPhase({phaseShort:'bank-owned-shaftsinker-food.ts'})).toBe('Owned food preparation');
});
test('long controller notes and raw results start closed; cleanup badge is additive only for proved cleanup',()=>{
    const f=rosterFunctions(),body=f.controllerEvidence({outcome:'fail',result:'fail stop-file held=0',planJob:{state:'paused',note:'Long raw controller note'}});
    expect(body).toContain('<details class="evidence">');expect(body).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
    expect(body).toContain('Controller notes and raw evidence');expect(body).toContain('Long raw controller note');expect(body).toContain('fail stop-file held=0');expect(body).toContain('Controller state: paused');
    expect(f.cleanupBadge({outcome:'fail',nativeProof:stopProof})).toContain('cleanup ✓');
    expect(f.cleanupBadge({outcome:'fail'})).toBe('');expect(f.resultKind({ok:false})).toBe('fail');
});
test('capacity renders fresh active/cap and RAM without turning unknown or stale queues into zero',()=>{
    const source=html.slice(html.indexOf('function capacityView(){'),html.indexOf('function machine(){'));
    const render=(capacity:any)=>{const nodes:any={'#k-win':{innerHTML:''},'#capacity':{innerHTML:''}};
        new Function('S','$','put',source+';capacityView();')({capacity,sys:{freeGB:8.4}},(id:string)=>nodes[id],(id:string,value:string)=>nodes[id].innerHTML=value);return nodes;};
    const fresh=render({fresh:true,active:2,cap:6,queued:0,freeGB:8.4,headroomGB:0.4});
    expect(fresh['#k-win'].innerHTML).toContain('2<small>/ 6');expect(fresh['#capacity'].innerHTML).toContain('8.4');expect(fresh['#capacity'].innerHTML).toContain('0.4');
    const stale=render({fresh:false,active:2,cap:6,queued:0,headroomGB:0.4});expect(stale['#k-win'].innerHTML).toContain('?<small>/ 6');expect(stale['#capacity'].innerHTML).toContain('<b>?</b>');
});
test('3D embed accepts only its same-origin viewer route and checks both message source and origin',()=>{
    const src=html.slice(html.indexOf('function viewerFrameUrl('),html.indexOf('function showViewerStatus(){'));
    const f=new Function(src+';return{viewerFrameUrl,viewerMessage,viewerStatusText,viewerCanReveal};')(),frame={};
    expect(f.viewerFrameUrl('/viewer/','http://127.0.0.1:3102').href).toBe('http://127.0.0.1:3102/viewer/');
    expect(f.viewerFrameUrl('viewer/','https://owner.github.io/rs-fleet-command/').href).toBe('https://owner.github.io/rs-fleet-command/viewer/');
    expect(()=>f.viewerFrameUrl('http://localhost:3000/','http://127.0.0.1:3102')).toThrow();
    expect(()=>f.viewerFrameUrl('/api/state','http://127.0.0.1:3102')).toThrow();
    const message={source:frame,origin:'http://127.0.0.1:3102',data:{viewerState:{state:'ready',renderReady:true,privacyReady:true}}};
    expect(f.viewerMessage(message,frame,message.origin)).toEqual(message.data.viewerState);
    expect(f.viewerCanReveal(message.data.viewerState)).toBe(true);
    expect(f.viewerCanReveal({...message.data.viewerState,renderReady:false})).toBe(false);
    expect(f.viewerCanReveal({...message.data.viewerState,privacyReady:false})).toBe(false);
    expect(f.viewerCanReveal({state:'ready'})).toBe(false);
    expect(f.viewerMessage({...message,source:{}},frame,message.origin)).toBeNull();
    expect(f.viewerMessage({...message,origin:'https://other.invalid'},frame,message.origin)).toBeNull();
    expect(f.viewerMessage({...message,data:{viewerTiming:{frames:4}}},frame,message.origin)).toBeNull();
});
test('3D loading, scene readiness and unavailable fallback have distinct persistent text',()=>{
    const src=html.slice(html.indexOf('function viewerStatusText('),html.indexOf('function showViewerStatus(){'));
    const label=new Function(src+';return viewerStatusText;')();
    expect(label({state:'loading'},'3d')).toContain('Loading 3D');
    expect(label({state:'ready',feed:false},'3d')).toContain('feed disconnected');
    expect(label({state:'ready',feed:null},'3d')).toContain('feed status unknown');
    expect(label({state:'unavailable',detail:'scene readiness timed out'},'2d')).toContain('3D unavailable · scene readiness timed out · showing 2D');
});

test('2D mode unloads the hidden WebGL viewer instead of retaining its scene in RAM',()=>{
    const src=html.slice(html.indexOf('function setMode('),html.indexOf('function viewerUnavailable('));
    const removed:string[]=[],nodes=new Map();
    const $=(id:string)=>{if(!nodes.has(id))nodes.set(id,{removeAttribute:(a:string)=>removed.push(id+':'+a),classList:{toggle(){}},style:{},contentWindow:{postMessage(){}}});return nodes.get(id);};
    const f=new Function('$','clearTimeout',`let VIEWER_REQUEST=0,VIEWER_TIMER,VIEWER={origin:'http://localhost:3102'},rswFor='old',mode='3d',S=null;function showViewerStatus(){};${src};setMode('2d');return{mode,rswFor};`);
    expect(f($,()=>{})).toEqual({mode:'2d',rswFor:null});expect(removed).toEqual(['#rsw:src']);
});

test('goal summaries distinguish recent ranks, old stock, model gates and skill-account pairs',()=>{
    const source=html.slice(html.indexOf('function specialistRows(){'),html.indexOf('function goalCards(){'));
    const S:any={now:1000000,bots:[
        {name:'Worker',at:999000,ranksAt:999000,skills:[{name:'Mining',level:99},{name:'Stat18',level:99}],ranks:[{board:'Mining',rank:2}]},
        {name:'Old',at:100,ranksAt:100,skills:[],ranks:[{board:'Mining',rank:1}]},
        {name:'Main',reserved:true,at:999000,ranksAt:999000,skills:[{name:'Mining',level:99}],ranks:[{board:'Mining',rank:1}]},
        {name:'Practice',practice:true,at:999000,ranksAt:999000,skills:[{name:'Mining',level:99}],ranks:[{board:'Mining',rank:1}]}
    ],boards:[{board:'Mining'},{board:'Equipment'}],collection:{distinct:84},capacity:{fresh:false},gates:{valid:false,gates:[{pass:true}]}};
    const key=(s:string)=>s.toLowerCase().replace(/^lava maze /,'').replace(/[^a-z]/g,'');
    const f=new Function('S','liveBots','observedAt','skills','ledger','boardKey',source+';return {specialistRows,goalMetrics};')(S,()=>S.bots.filter((b:any)=>!b.practice&&!b.reserved),(at:number,limit=300000)=>at>0&&at<=S.now&&S.now-at<limit,(b:any)=>b.skills.filter((s:any)=>!/^Stat\d+$/.test(s.name)),()=>null,key);
    expect(f.specialistRows()[0].best.name).toBe('Worker');expect(f.specialistRows()[1].best).toBeUndefined();
    const goals=f.goalMetrics();expect(goals).toHaveLength(6);expect(goals[0].metric).toBe('? active');expect(goals[1].metric).toBe('84 types');expect(goals[2].metric).toBe('1 × 99');expect(goals[3].metric).toBe('0 #1');expect(goals[4].metric).toBe('No check');expect(goals[5].metric).toBe('Unknown');
    S.bots[0].ranksAt=S.now+1;expect(f.specialistRows()[0].best.recent).toBe(false);
});

test('Runite inspector uses the known value-board record despite display-name differences',()=>{
    const source=html.slice(html.indexOf('function boardView(){'),html.indexOf('function inspect(){'));
    let rows:string[]=[];
    const run=new Function('S','chosenBoard','boardKey','specialistRows','pagedRows','row','E','age','nf','sgn',source+';boardView();');
    run({boards:[{board:'Runite',top:{name:'Leader',value:42}}],race:{rows:[{label:'Lava Maze Runite',rule:{kind:'value'}}]}},'Lava Maze Runite',(s:string)=>s.replace('Lava Maze ',''),()=>[],(r:string[])=>rows=r,(label:string,value:unknown)=>label+': '+value,String,()=>'? ',String,String);
    expect(rows).toContain('Record holder: Leader');expect(rows).toContain('Record time / value: 42');
});

function picked(bots:any[],state:any={}){
 const code=html.slice(html.indexOf('function pick(n){'),html.indexOf('\n',html.indexOf('function pick(n){')));
 const sent:any[]=[],window:any={atlasDestination:{x:1,z:2},atlasFollowOther:'Stranger',...state};
 const run=new Function('S','window','$','render',`let sel='Old',picked=false,view='',detailPage=1,rswFor='Old';const mode='3d',VIEWER={origin:'http://viewer'};${code};return n=>{pick(n);return {sel,rswFor};};`)({bots},window,()=>({contentWindow:{postMessage:(m:any)=>sent.push(m)}}),()=>{});
 return {run,sent,window};
}

test('pick follows an account in the world even when it was the last one chosen',()=>{
 const p=picked([{name:'Old',inWorld:true}],{atlasFreeCamera:true});
 expect(p.run('Old')).toEqual({sel:'Old',rswFor:null});
 expect(p.window.atlasFreeCamera).toBe(false);expect(p.window.atlasFollowOther).toBeNull();expect(p.window.atlasDestination).toBeNull();expect(p.sent).toEqual([]);
});

test('pick releases the camera for an account that is not in the world, with no viewer reload',()=>{
 const p=picked([{name:'Away',inWorld:false,pos:{x:3200,z:3200}}]);
 expect(p.run('Away').sel).toBe('Away');expect(p.window.atlasFreeCamera).toBe(true);expect(p.sent).toEqual([{atlasFreeCamera:true}]);
});
