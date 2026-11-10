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
    expect(viewerAssetRoute('/static/js/main.0123abcd.js')).toEqual({root:'static',relative:'js/main.0123abcd.js'});
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
 for(let i=0;i<30;i++)relay();expect(b.messages.filter(m=>m.data.atlasFollow)).toHaveLength(before);
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
test('a roster change frame reaches the viewer as it is and the page as a full roster',async()=>{
 const b=browser();class Socket {
  listeners:Function[]=[];handler:any=null;constructor(..._args:any[]){}
  addEventListener(t:string,fn:Function){if(t==='message')this.listeners.push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.listeners)f(e);this.handler?.(e);}}
 b.host.WebSocket=Socket;b.host.MessageEvent??=class{data:any;origin:any;constructor(_t:string,i:any){this.data=i.data;this.origin=i.origin;}};
 installViewerBridge(b.host);const socket:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed'),seen:any[]=[];socket.onmessage=(e:any)=>seen.push(JSON.parse(e.data));
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 socket.message({t:'roster',k:10,p:[[7,'Leaver',3200,3200,0,126],[8,'Worker',3201,3201,0,50]],npcs:4});
 const change={t:'roster',k:20,d:1,lv:[7],j:[[9,'Joiner',3100,3100,0,3]],m:[[8,3205,3206,1]],npcs:5};
 socket.message(change);
 expect(seen.at(-1)).toEqual(change);
 expect(b.messages.filter(m=>m.data.atlasRoster).at(-1)!.data.atlasRoster.players).toEqual([['Worker',3205,3206,1,50],['Joiner',3100,3100,0,3]]);
 // A second change builds on the rows the bridge holds.
 socket.message({t:'roster',k:30,d:1,lv:[],j:[],m:[[9,3101,3102,0,4]],npcs:5});
 expect(b.messages.filter(m=>m.data.atlasRoster).at(-1)!.data.atlasRoster.players).toEqual([['Worker',3205,3206,1,50],['Joiner',3101,3102,0,4]]);
});
test('a hash-listed player who joins in a change frame is renamed before the viewer reads it',async()=>{
 const b=browser(['h:afac05c6'],'http://localhost:3102/sub/api/hidden-names');
 class Socket {listeners:Function[]=[];handler:any=null;constructor(..._args:any[]){}addEventListener(t:string,fn:Function){if(t==='message')this.listeners.push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.listeners)f(e);this.handler?.(e);}}
 b.host.WebSocket=Socket;b.host.MessageEvent=class {data:string;origin:string;constructor(_t:string,init:any){this.data=init.data;this.origin=init.origin;}};
 installViewerBridge(b.host);await (await b.host.fetch('http://localhost:3102/sub/api/hidden-names')).json();
 const socket:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed'),seen:string[]=[];socket.onmessage=(e:any)=>seen.push(e.data);
 b.frame();b.frame();b.geometry();b.present();b.frame();
 socket.message({t:'roster',k:10,p:[[8,'Worker',1,1,0,3]],npcs:0});
 socket.message({t:'roster',k:20,d:1,lv:[],j:[[7,'HiddenActor',2,2,0,3]],m:[],npcs:0});
 socket.message({t:'tick',k:21,p:[{i:7,ch:'hi hiddenactor'}]});
 expect(JSON.parse(seen[1]!).j[0][1]).toBe('Hidden');expect(seen.join('')).not.toMatch(/hiddenactor/i);
 expect(b.messages.filter(m=>m.data.atlasRoster).at(-1)!.data.atlasRoster.players).toEqual([['Worker',1,1,0,3],['⟦MAIN⟧',2,2,0,3]]);
 expect(JSON.stringify(b.messages)).not.toMatch(/hiddenactor/i);
});
test('a hidden tab gets no roster from the feed: the bridge sends none and keeps its rows for the next change',async()=>{
 const b=browser();class Socket {listeners=new Map<string,Function[]>();constructor(..._args:any[]){}addEventListener(t:string,fn:Function){this.listeners.set(t,[...(this.listeners.get(t)||[]),fn]);}message(m:any){for(const f of this.listeners.get('message')||[])f({data:JSON.stringify(m),origin:'wss://x'});}}
 b.host.WebSocket=Socket;b.host.MessageEvent??=class{data:any;origin:any;constructor(_t:string,i:any){this.data=i.data;this.origin=i.origin;}};
 installViewerBridge(b.host);const socket=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');
 await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 socket.message({t:'roster',k:10,p:[[8,'Worker',3201,3201,0,50]],npcs:0});
 const sent=()=>b.messages.filter(m=>m.data.atlasRoster).length,before=sent();
 // Hidden: the viewer unsubscribes, so the feed sends ticks with no players and no roster.
 socket.message({t:'tick',k:11,ms:1});socket.message({t:'tick',k:12,ms:1});
 expect(sent()).toBe(before);expect(b.states().filter(Boolean).at(-1).state).toBe('ready');
 socket.message({t:'roster',k:40,d:1,lv:[],j:[],m:[[8,3300,3300,0]],npcs:0});
 expect(b.messages.filter(m=>m.data.atlasRoster).at(-1)!.data.atlasRoster.players).toEqual([['Worker',3300,3300,0,50]]);
});

function multiBridge(href=''){
 const b=browser(),on:Record<string,any[]>={};
 b.host.location.href+=href;
 b.host.addEventListener=(t:string,fn:any)=>{(on[t]??=[]).push(fn);};
 const panes=(n:number)=>Array.from({length:n},(_,i)=>({getBoundingClientRect:()=>({left:i*100,right:i*100+100,top:0,bottom:100})}));
 let shown=0;b.host.document={querySelector:()=>null,querySelectorAll:(q:string)=>q==='.multi-view .multi-pane'?panes(shown):[]};
 installViewerBridge(b.host);
 // True when the message goes on to the viewer's own listener.
 const send=(data:any,from:any=b.host.parent,origin='http://localhost:3102')=>{let stopped=false;for(const f of on.message)f({origin,source:from,data,stopImmediatePropagation:()=>{stopped=true;}});return !stopped;};
 const click=(x:number,up=x,target='CANVAS',button=0)=>{for(const f of on.pointerdown??[])f({clientX:x,clientY:50,button,target:{tagName:target}});for(const f of on.pointerup??[])f({clientX:up,clientY:50,button,target:{tagName:target}});};
 const ready=async()=>{await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();};
 return {...b,send,click,ready,panes:(n:number)=>{shown=n;},picks:()=>b.messages.filter(m=>'viewerMultiPick' in m.data).map(m=>m.data)};
}

test('the multi-view messages reach the viewer only from the page and only as a list of at most 16 names',()=>{
 const b=multiBridge();
 expect(b.send({multi:['Ann','Bob 2','⟦MAIN⟧']})).toBe(true);
 expect(b.send({multi:[]})).toBe(true);
 expect(b.send({multi:Array.from({length:16},(_,i)=>'Bot'+i),multiDistance:48})).toBe(true);
 expect(b.send({multi:Array.from({length:17},(_,i)=>'Bot'+i)})).toBe(false);
 for(const bad of ['Ann',[1],[''],['Ann','ann'],[' Ann'],['ThirteenChars'],['<b>'],[['Ann']],null,{0:'Ann',length:1}])expect(b.send({multi:bad})).toBe(false);
 for(const bad of [15,129,48.5,'48',null])expect(b.send({multiDistance:bad})).toBe(false);
 for(const good of [16,48,128])expect(b.send({multiDistance:good})).toBe(true);
 expect(b.send({multi:['Ann']},{})).toBe(false);
 expect(b.send({multi:['Ann']},b.host.parent,'https://example.com')).toBe(false);
 // Other messages are not this rule's business.
 expect(b.send({follow:'Ann'})).toBe(true);
});

test('a click in a view of the wall tells the page the asked name and the view number, after the viewer is ready',async()=>{
 const b=multiBridge();
 b.send({multi:['Ann','HiddenActor','Cat']});b.panes(3);
 b.click(150);expect(b.picks()).toEqual([]);
 await b.ready();
 b.click(50);b.click(250);
 expect(b.picks()).toEqual([{viewerMultiPick:'Ann',index:0},{viewerMultiPick:'Cat',index:2}]);
 expect(b.messages.at(-1)!.origin).toBe('http://localhost:3102');
 // A drag, a press on a control, another button, and a press that ends in another view are not clicks.
 b.click(50,70);b.click(50,50,'INPUT');b.click(50,50,'CANVAS',2);b.click(50,150);
 expect(b.picks()).toHaveLength(2);
 // A hidden name leaves the viewer as the mark.
 b.click(150);expect(b.picks().at(-1)).toEqual({viewerMultiPick:'⟦MAIN⟧',index:1});
 expect(JSON.stringify(b.picks())).not.toContain('HiddenActor');
 // The views must be the asked ones: no report while the count differs, and none after the wall closes.
 b.panes(2);b.click(50);b.panes(3);b.send({multi:[]});b.click(50);
 expect(b.picks()).toHaveLength(3);
});

test('a refused multi-view message does not change the names the bridge reports, and embed=1 leaves the report to the viewer',async()=>{
 const b=multiBridge();await b.ready();
 b.send({multi:['Ann','Bob']});b.send({multi:['Eve','Mal','Mal']});b.send({multi:['Eve','Bob']},{});b.panes(2);
 b.click(50);expect(b.picks()).toEqual([{viewerMultiPick:'Ann',index:0}]);
 const e=multiBridge('&embed=1');await e.ready();e.send({multi:['Ann','Bob']});e.panes(2);e.click(50);
 expect(e.picks()).toEqual([]);
});

test('a name in the viewer URL is not relayed as a follow while the wall is open',async()=>{
 const d=browser(),on:any[]=[];let relay:any;d.host.location.href+='&follow=Worker';d.host.setInterval=(fn:any)=>{relay=fn;};
 d.host.addEventListener=(t:string,fn:any)=>{if(t==='message')on.push(fn);};
 installViewerBridge(d.host);await d.consume();d.geometry();d.present();d.frame();d.frame();d.frame();
 const send=(data:any)=>{for(const f of on)f({origin:'http://localhost:3102',source:d.host.parent,data,stopImmediatePropagation:()=>{}});};
 const follows=()=>d.messages.filter(m=>'atlasFollow' in m.data).map(m=>m.data.atlasFollow);
 send({multi:['Ann','Bob']});for(let i=0;i<30;i++)relay();
 expect(follows()).toEqual([]);
 send({multi:[]});relay();expect(follows()).toEqual([]);
 d.host.location.href=d.host.location.href.replace('follow=Worker','follow=Third');relay();
 expect(follows()).toEqual(['Third']);
});
