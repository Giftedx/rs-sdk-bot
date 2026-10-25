import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
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
const rosterSource=html.slice(html.indexOf('function hasStopProof('),html.indexOf('function roster(){'));
function rosterFunctions(){return new Function('S','E','ago','sel','ocIcon',rosterSource+';return{offlineGoal,offWhy,rowOff,operationPhase,hasStopProof,resultKind,nativeProofPanel,boundedLabel,controllerEvidence,cleanupBadge};')({now:600000},escape,()=> '1m','',()=>'<i>raw outcome</i>');}
const stopProof={kind:'host-stop-cleanup',outcome:'proved',level:'local-native',workerOutcome:'fail',goalMet:false,scope:'four sent inputs settled; assets banked'};

test('dashboard inline JavaScript parses without running browser or making requests',()=>{
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
    expect(scripts.length).toBeGreaterThan(0);for(const js of scripts)expect(()=>new Function(js)).not.toThrow();
});
test('offline roster keeps goal, failure and state readable while long raw controller note stays in title',()=>{
    const f=rosterFunctions(),raw='LONG_RAW_CONTROLLER_NOTE_'.repeat(100);
    const row=f.rowOff({name:'Worker',role:'crafting',operation:'blocked',currentGoal:'Make useful strings',lastRes:{text:'fail made=0 held=20',ok:false,at:1},planJob:{state:'disabled',goal:'Old goal',note:raw}});
    const visible=row.replace(/title="[^"]*"/g,'');
    expect(visible).toContain('worker failed');expect(visible).toContain('blocked');expect(visible).toContain('disabled');
    expect(visible).toContain('Make useful strings');expect(visible).not.toContain(raw);expect(row).toContain(raw);
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
