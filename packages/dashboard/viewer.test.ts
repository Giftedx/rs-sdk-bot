import {expect,test} from 'bun:test';
import {installViewerBridge,viewerAssetRoute,viewerBridgeSource} from './viewer';

function browser(list:unknown=['HiddenActor'],hide='http://localhost:3102/api/hidden-names') {
    const messages:{data:any;origin:string}[]=[],frames:(()=>void)[]=[];
    let requests=0,fetchFails=false;
    class GL {
        canvas={tagName:'CANVAS',isConnected:true,tabIndex:0,width:640,height:320};
        DRAW_FRAMEBUFFER_BINDING=1;
        framebuffer:any=null;
        getParameter(){return this.framebuffer;}
        clear(){}
        drawElements(_mode:number,_count:number,_type:number,_offset:number){}
        drawArrays(_mode:number,_start:number,_count:number){}
        drawElementsInstanced(_mode:number,_count:number,_type:number,_offset:number,_instances:number){}
        drawArraysInstanced(_mode:number,_start:number,_count:number,_instances:number){}
        extension:any={multiDrawElementsInstancedWEBGL(){},multiDrawArraysInstancedWEBGL(){}};
        getExtension(_name:string){return this.extension;}
    }
    const host:any={URL,location:{origin:'http://localhost:3102',href:'http://localhost:3102/viewer/?hideNamesFrom='+encodeURIComponent(hide)},
        parent:{postMessage(data:any,origin:string){messages.push({data,origin});}},WebGL2RenderingContext:GL,
        fetch:async()=>{requests++;if(fetchFails)throw new Error('offline');return new Response(JSON.stringify(list));},
        requestAnimationFrame(callback:()=>void){frames.push(callback);},addEventListener(){}};
    const gl=new GL();
    const frame=()=>{for(const callback of frames.splice(0))callback();};
    const geometry=()=>{gl.framebuffer={};gl.clear();gl.drawElementsInstanced(4,36,0,0,1);};
    const present=()=>{gl.framebuffer=null;gl.drawArraysInstanced(4,0,3,1);};
    const consume=async()=>{const response=await host.fetch(hide);return response.json();};
    const states=()=>messages.map(m=>m.data.viewerState);
    return {host,gl,frame,geometry,present,consume,states,messages,requests:()=>requests,failFetch:()=>{fetchFails=true;}};
}

test('viewer routes only explicit roots and rejects decoded or double-encoded traversal',()=>{
    expect(viewerAssetRoute('/static/js/main.a8aba595.js')).toEqual({root:'static',relative:'js/main.a8aba595.js'});
    expect(viewerAssetRoute('/caches/rs-sdk-289/main_file_cache.dat')).toEqual({root:'caches',relative:'rs-sdk-289/main_file_cache.dat'});
    expect(viewerAssetRoute('/api/state')).toBeNull();
    for(const path of ['/static/../server.ts','/static/%2e%2e%2fserver.ts','/caches/%252e%252e/file','/static/js%5csecret','/caches/C:/secret','/static/%00bad','/static/%zz','/static//js/x'])
        expect(viewerAssetRoute(path)).toBe('bad');
});
test('native map follow selection reaches the inspector only after rendering and private-name filtering',async()=>{
 const b=browser();let relay:any;b.host.setInterval=(fn:any)=>{relay=fn;};installViewerBridge(b.host);
 b.host.location.href+='&follow=HiddenActor';relay();expect(b.messages.some(m=>m.data.atlasFollow)).toBe(false);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();relay();
 expect(b.messages.filter(m=>m.data.atlasFollow).map(m=>m.data.atlasFollow)).toEqual(['⟦MAIN⟧']);
 b.host.location.href=b.host.location.href.replace('follow=HiddenActor','follow=Worker');relay();
 expect(b.messages.at(-1)!.data).toEqual({atlasFollow:'Worker'});
});

test('HTTP delivery without actual app JSON consumption never opens the privacy gate',async()=>{
    const b=browser();installViewerBridge(b.host);
    await b.host.fetch('http://localhost:3102/api/hidden-names');
    b.geometry();b.present();b.frame();b.frame();b.frame();
    expect(b.states().at(-1).renderReady).toBe(true);
    expect(b.states().every(s=>s.privacyReady===false&&s.state!=='ready')).toBe(true);
});

test('privacy becomes ready only two animation turns after app JSON consumption',async()=>{
    const b=browser();installViewerBridge(b.host);await b.consume();
    expect(b.states().at(-1).privacyReady).toBe(false);
    b.frame();expect(b.states().at(-1).privacyReady).toBe(false);
    b.frame();expect(b.states().at(-1).privacyReady).toBe(true);
    expect(b.states().at(-1).state).toBe('loading');
});

test('bad or empty private lists and fetch rejection stay closed with explicit error',async()=>{
    for(const value of [[],null,{},[''],['<not-a-name>'],Array(65).fill('Actor')]){
        const b=browser(value);installViewerBridge(b.host);
        await expect(b.consume()).rejects.toThrow();b.frame();b.frame();
        expect(b.states().at(-1).state).toBe('error');expect(b.states().at(-1).privacyReady).toBe(false);
    }
    const b=browser();b.failFetch();installViewerBridge(b.host);
    await expect(b.consume()).rejects.toThrow('offline');expect(b.states().at(-1).state).toBe('error');
});

test('clear, DOM availability and a screen quad without geometry cannot mean ready',async()=>{
    const b=browser();installViewerBridge(b.host);await b.consume();b.frame();b.frame();
    b.gl.framebuffer={};b.gl.clear();b.present();b.frame();
    expect(b.states().at(-1).renderReady).toBe(false);expect(b.states().at(-1).state).toBe('loading');
    b.gl.framebuffer={};b.gl.drawElementsInstanced(4,36,0,0,0);b.present();b.frame();
    expect(b.states().at(-1).renderReady).toBe(false);
});

test('only connected renderer canvas geometry then real screen present and RAF reaches ready',async()=>{
    const b=browser();installViewerBridge(b.host);await b.consume();b.frame();b.frame();
    b.gl.canvas.isConnected=false;b.geometry();b.present();b.frame();expect(b.states().at(-1).renderReady).toBe(false);
    b.gl.canvas.isConnected=true;b.gl.canvas.tabIndex=-1;b.geometry();b.present();b.frame();expect(b.states().at(-1).renderReady).toBe(false);
    b.gl.canvas.tabIndex=0;b.geometry();expect(b.states().at(-1).state).toBe('loading');
    b.present();expect(b.states().at(-1).state).toBe('loading');b.frame();
    expect(b.states().at(-1)).toMatchObject({state:'ready',renderReady:true,privacyReady:true,feedConnected:null});
    expect(b.messages.every(m=>m.origin==='http://localhost:3102')).toBe(true);
    expect(JSON.stringify(b.messages)).not.toContain('HiddenActor');
});

test('pinned PicoGL multidraw geometry and screen-array signatures also reach ready',async()=>{
    const b=browser();installViewerBridge(b.host);await b.consume();b.frame();b.frame();
    const extension=b.gl.getExtension('WEBGL_multi_draw_instanced');
    b.gl.framebuffer={};b.gl.clear();
    extension.multiDrawElementsInstancedWEBGL(4,new Int32Array([36]),0,0,new Int32Array([0]),0,new Int32Array([1]),0,1);
    b.gl.framebuffer=null;
    extension.multiDrawArraysInstancedWEBGL(4,new Int32Array([0]),0,new Int32Array([3]),0,new Int32Array([1]),0,1);
    b.frame();expect(b.states().at(-1).state).toBe('ready');
});

test('foreign hidden-list origin is rejected without a request; serialized bridge stays entry-local',async()=>{
    const bad=browser(['HiddenActor'],'https://foreign.example/api/hidden-names');
    installViewerBridge(bad.host);expect(bad.requests()).toBe(0);expect(bad.states().at(-1).state).toBe('error');
    const b=browser();new Function('window',viewerBridgeSource())(b.host);
    await b.consume();b.frame();b.frame();b.geometry();b.present();b.frame();
    expect(b.states().at(-1).state).toBe('ready');
});


test('public chat requires ready privacy and geometry, known roster identity and bounded deduplication',async()=>{
 const b=browser();class Socket {listeners=new Map<string,Function[]>();constructor(..._args:any[]){}addEventListener(t:string,fn:Function){this.listeners.set(t,[...(this.listeners.get(t)||[]),fn]);}message(m:any){for(const f of this.listeners.get('message')||[])f({data:JSON.stringify(m)});}}
 b.host.WebSocket=Socket;installViewerBridge(b.host);const socket=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
 socket.message({t:'roster',p:[[7,'HiddenActor',1,1,0,3],[8,'Worker',1,1,0,3]]});
 socket.message({t:'tick',k:1,p:[{i:7,ch:'hidden until ready'}]});expect(b.messages.some(m=>m.data.atlasChat)).toBe(false);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 const packet={t:'tick',k:2,p:[{i:7,ch:'Hello HiddenActor'},{i:8,ch:'Hello'},{i:999,ch:'Unknown identity'}]};socket.message(packet);socket.message(packet);
 const messages=b.messages.filter(m=>m.data.atlasChat);expect(messages).toHaveLength(2);
 expect(messages[0]!.data.atlasChat).toEqual({key:'2:7:Hello ⟦MAIN⟧',name:'⟦MAIN⟧',text:'Hello ⟦MAIN⟧'});
 expect(messages[1]!.data.atlasChat.name).toBe('Worker');expect(JSON.stringify(messages)).not.toContain('HiddenActor');
 expect(messages.every(m=>m.origin==='http://localhost:3102')).toBe(true);
});


test('native world-map open and close are relayed only after the viewer is ready',async()=>{
 const b=browser();let relay:any,open=false;b.host.setInterval=(fn:any)=>{relay=fn;};b.host.document={querySelector:()=>open?{}:null};installViewerBridge(b.host);
 open=true;relay();expect(b.messages.some(m=>m.data.atlasWorldMap!==undefined)).toBe(false);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();relay();relay();
 expect(b.messages.filter(m=>m.data.atlasWorldMap!==undefined).map(m=>m.data.atlasWorldMap)).toEqual([true]);
 open=false;relay();expect(b.messages.at(-1)!.data).toEqual({atlasWorldMap:false});
});

test('a hosted hash list renames the matching player before the viewer reads the feed and never needs the name',async()=>{
 const b=browser(['h:afac05c6'],'http://localhost:3102/sub/api/hidden-names');
 class Socket {listeners:Function[]=[];handler:any=null;constructor(..._args:any[]){}addEventListener(t:string,fn:Function){if(t==='message')this.listeners.push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.listeners)f(e);this.handler?.(e);}}
 b.host.WebSocket=Socket;b.host.MessageEvent=class {data:string;origin:string;constructor(_t:string,init:any){this.data=init.data;this.origin=init.origin;}};
 installViewerBridge(b.host);
 expect(await (await b.host.fetch('http://localhost:3102/sub/api/hidden-names')).json()).toEqual(['Hidden']);
 const socket:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed'),seen:string[]=[];socket.onmessage=(e:any)=>seen.push(e.data);
 socket.message({t:'roster',p:[[7,'HiddenActor',1,1,0,3],[8,'Worker',1,1,0,3]]});
 socket.message({t:'tick',k:3,p:[{i:7,ch:'hi hiddenactor'}]});
 expect(seen.join('')).not.toMatch(/hiddenactor/i);expect(JSON.parse(seen[0]!).p[0][1]).toBe('Hidden');expect(JSON.parse(seen[0]!).p[1][1]).toBe('Worker');
 b.frame();b.frame();b.geometry();b.present();b.frame();expect(b.states().at(-1).state).toBe('ready');
 expect(JSON.stringify(b.messages)).not.toMatch(/hiddenactor/i);
});

test('a roster that arrives before the hash list loads waits, then reaches the viewer renamed; chat never names the player',async()=>{
 const b=browser(['h:afac05c6'],'http://localhost:3102/sub/api/hidden-names');
 class Socket {listeners:Function[]=[];handler:any=null;constructor(..._args:any[]){}addEventListener(t:string,fn:Function){if(t==='message')this.listeners.push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.listeners)f(e);this.handler?.(e);}}
 b.host.WebSocket=Socket;b.host.MessageEvent=class {data:string;origin:string;constructor(_t:string,init:any){this.data=init.data;this.origin=init.origin;}};
 installViewerBridge(b.host);
 const socket:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed'),seen:string[]=[];socket.onmessage=(e:any)=>seen.push(e.data);
 socket.message({t:'roster',p:[[7,'HiddenActor',1,1,0,3],[8,'Worker',1,1,0,3]]});
 expect(seen).toEqual([]);
 await (await b.host.fetch('http://localhost:3102/sub/api/hidden-names')).json();
 expect(seen).toHaveLength(1);expect(JSON.parse(seen[0]!).p[0][1]).toBe('Hidden');
 b.frame();b.frame();b.geometry();b.present();b.frame();expect(b.states().at(-1).state).toBe('ready');
 socket.message({t:'tick',k:4,p:[{i:7,ch:'I am HiddenActor'}]});
 const chat=b.messages.filter(m=>m.data.atlasChat);expect(chat).toHaveLength(1);
 expect(JSON.stringify(chat)).not.toMatch(/hiddenactor/i);expect(seen.join('')).not.toMatch(/hiddenactor/i);
});

test('the 3D camera reaches the page after readiness, and the page presses the hidden minimap buttons', async () => {
 const b=browser();let relay:any;const listeners:any[]=[];const clicked:string[]=[];
 b.host.setInterval=(fn:any)=>{relay=fn;};b.host.addEventListener=(t:string,fn:any)=>{if(t==='message')listeners.push(fn);};
 b.host.document={querySelector:(q:string)=>q.includes('.minimap-container')||q==='.live-follow button'?{click:()=>clicked.push(q)}:null};
 installViewerBridge(b.host);
 b.host.location.href+='&cx=3200.50&cz=3210.25&y=512';relay();expect(b.messages.some(m=>m.data.atlasCamera3d)).toBe(false);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();relay();relay();
 expect(b.messages.filter(m=>m.data.atlasCamera3d).map(m=>m.data.atlasCamera3d)).toEqual([{x:3200.5,z:3210.25,yaw:512}]);
 for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{atlasCompass:true}});
 for(const f of listeners)f({origin:'https://evil.example',source:b.host.parent,data:{atlasOpenWorldMap:true}});
 for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{atlasOpenWorldMap:true}});
 for(const f of listeners)f({origin:'https://evil.example',source:b.host.parent,data:{atlasFreeCamera:true}});
 for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{atlasFreeCamera:true}});
 expect(clicked).toEqual(['.minimap-container .compass','.minimap-container .worldmap-icon','.live-follow button']);
});

test('Free camera waits for the native follow control to mount during loading',async()=>{
 const b=browser();let relay:any,available=false,clicks=0;const listeners:any[]=[];
 b.host.setInterval=(fn:any)=>{relay=fn;};b.host.addEventListener=(t:string,fn:any)=>{if(t==='message')listeners.push(fn);};
 b.host.document={querySelector:(q:string)=>q==='.live-follow button'&&available?{click:()=>clicks++}:null};
 installViewerBridge(b.host);
 for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{atlasFreeCamera:true}});
 relay();expect(clicks).toBe(0);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();available=true;
 relay();expect(clicks).toBe(1);
});

test('native Stop cannot echo a stale follow URL back into the account picker',async()=>{
 for(const hasHistory of [false,true]){
  const b=browser();let relay:any;const listeners:any[]=[];
  b.host.location.href+='&follow=Worker';b.host.setInterval=(fn:any)=>{relay=fn;};
  b.host.addEventListener=(t:string,fn:any)=>{if(t==='message')listeners.push(fn);};
  b.host.document={querySelector:(q:string)=>q==='.live-follow button'?{click:()=>{}}:null};
  if(hasHistory)b.host.history={state:null,replaceState:(_state:any,_title:any,url:string)=>{b.host.location.href=url;}};
  installViewerBridge(b.host);await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
  for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{atlasFreeCamera:true}});
  relay();relay();expect(b.messages.filter(m=>m.data.atlasFollow)).toHaveLength(0);
  if(hasHistory)expect(new URL(b.host.location.href).searchParams.has('follow')).toBe(false);
 }
});

test('a page follow change cannot be undone by the old name still in the viewer URL',async()=>{
 const b=browser();let relay:any;const listeners:any[]=[];
 b.host.location.href+='&follow=Worker';b.host.setInterval=(fn:any)=>{relay=fn;};
 b.host.addEventListener=(t:string,fn:any)=>{if(t==='message')listeners.push(fn);};
 installViewerBridge(b.host);await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();relay();
 const before=b.messages.filter(m=>m.data.atlasFollow).length;
 for(const f of listeners)f({origin:'http://localhost:3102',source:b.host.parent,data:{follow:'Other'}});
 relay();relay();expect(b.messages.filter(m=>m.data.atlasFollow)).toHaveLength(before);
 b.host.location.href=b.host.location.href.replace('follow=Worker','follow=Other');relay();relay();
 expect(b.messages.filter(m=>m.data.atlasFollow)).toHaveLength(before);
 b.host.location.href=b.host.location.href.replace('follow=Other','follow=Third');relay();
 expect(b.messages.at(-1)!.data).toEqual({atlasFollow:'Third'});
});

test('the [ and ] keys step through the page accounts, not the viewer roster',()=>{
 const b=browser();let key:any;
 b.host.addEventListener=(t:string,fn:any,capture?:boolean)=>{if(t==='keydown'&&capture)key=fn;};
 installViewerBridge(b.host);let stopped=0;
 const press=(k:string)=>key({key:k,stopImmediatePropagation:()=>stopped++,preventDefault:()=>{}});
 press(']');press('[');press('w');
 expect(b.messages.filter(m=>m.data.atlasStep).map(m=>m.data.atlasStep)).toEqual([1,-1]);expect(stopped).toBe(2);
});

test('opponent information: the followed player\'s target after a hit, renamed when hidden, cleared when it stops facing',async()=>{
 const b=browser();class Socket {listeners=new Map<string,Function[]>();constructor(..._args:any[]){}addEventListener(t:string,fn:Function){this.listeners.set(t,[...(this.listeners.get(t)||[]),fn]);}message(m:any){for(const f of this.listeners.get('message')||[])f({data:JSON.stringify(m)});}}
 b.host.WebSocket=Socket;installViewerBridge(b.host);b.host.location.href+='&follow=Worker';const socket=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
 socket.message({t:'roster',p:[[7,'HiddenActor',1,1,0,3],[8,'Worker',1,1,0,3]]});
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 const opp=()=>b.messages.filter(m=>'atlasOpponent' in m.data).map(m=>m.data.atlasOpponent);
 // Facing a knight with no hit yet (pickpocketing): nothing to show.
 socket.message({t:'tick',k:1,p:[{i:8,f:1,fe:23}],n:[{i:23,f:1,t:26}]});expect(opp()).toEqual([]);
 socket.message({t:'tick',k:2,n:[{i:23,hm:[[3,1]],hp:[9,12]}]});expect(opp()).toEqual([{kind:'npc',type:26,hp:[9,12]}]);
 socket.message({t:'tick',k:3,n:[{i:23,hm:[[3,1]],hp:[9,12]}]});expect(opp()).toHaveLength(1);
 socket.message({t:'tick',k:4,p:[{i:8,fe:32768+7},{i:7,hm:[[2,1]],hp:[5,10]}]});
 expect(opp()[1]).toEqual({kind:'player',name:'⟦MAIN⟧',hp:[5,10]});expect(JSON.stringify(b.messages)).not.toContain('HiddenActor');
 socket.message({t:'tick',k:5,p:[{i:8,fe:-1}]});expect(opp()[2]).toBeNull();
});

test('a roster held past the 30 s limit is dropped at the ready state',async()=>{
 const b=browser();class Socket {listeners=new Map<string,Function[]>();constructor(..._args:any[]){}addEventListener(t:string,fn:Function){this.listeners.set(t,[...(this.listeners.get(t)||[]),fn]);}message(m:any){for(const f of this.listeners.get('message')||[])f({data:JSON.stringify(m),origin:'wss://x'});}}
 b.host.WebSocket=Socket;installViewerBridge(b.host);const socket=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
 socket.message({t:'roster',p:[[8,'Worker',3201,3201,0,50]]});
 const now=Date.now;Date.now=()=>now()+30_001;
 try{await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();}finally{Date.now=now;}
 expect(b.states().at(-1).state).toBe('ready');expect(b.messages.some(m=>m.data.atlasRoster)).toBe(false);
});
test('the roster reaches the page live, with the hidden account as the mark only',async()=>{
 const b=browser();class Socket {listeners=new Map<string,Function[]>();constructor(..._args:any[]){}addEventListener(t:string,fn:Function){this.listeners.set(t,[...(this.listeners.get(t)||[]),fn]);}message(m:any){for(const f of this.listeners.get('message')||[])f({data:JSON.stringify(m)});}}
 b.host.WebSocket=Socket;installViewerBridge(b.host);const socket=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
 socket.message({t:'roster',p:[[7,'HiddenActor',3200,3200,0,126],[8,'Worker',3201,3201,0,50]]});expect(b.messages.some(m=>m.data.atlasRoster)).toBe(false);
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 // The roster that arrived during the load reaches the page at the ready state.
 expect(b.messages.filter(m=>m.data.atlasRoster)).toHaveLength(1);
 socket.message({t:'roster',p:[[7,'HiddenActor',3200,3200,0,126],[8,'Worker',3201,3201,0,50],[9,'Bad',null,3,0,1]]});
 const rosters=b.messages.filter(m=>m.data.atlasRoster);expect(rosters).toHaveLength(2);
 for(const r of rosters)expect(r.data.atlasRoster.players).toEqual([['⟦MAIN⟧',3200,3200,0,126],['Worker',3201,3201,0,50]]);
 expect(JSON.stringify(rosters)).not.toContain('HiddenActor');
});
