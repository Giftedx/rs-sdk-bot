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
 // View i stands at x = i * 100. numbers[i] is the view's number in the asked order (data-pane), as the viewer sets it.
 let shown=0,numbers:number[]|null=null,extra:any[]=[];
 const panes=(n:number)=>[...Array.from({length:n},(_,i)=>({dataset:{pane:String(numbers?numbers[i]:i)},style:{zIndex:String(i)},getBoundingClientRect:()=>({left:i*100,right:i*100+100,top:0,bottom:100})})),...extra];
 b.host.document={querySelector:()=>null,querySelectorAll:(q:string)=>q==='.multi-view .multi-pane[data-pane]'?panes(shown):[]};
 installViewerBridge(b.host);
 // True when the message goes on to the viewer's own listener.
 const send=(data:any,from:any=b.host.parent,origin='http://localhost:3102')=>{let stopped=false;for(const f of on.message)f({origin,source:from,data,stopImmediatePropagation:()=>{stopped=true;}});return !stopped;};
 const click=(x:number,up=x,target='CANVAS',button=0)=>{for(const f of on.pointerdown??[])f({clientX:x,clientY:50,button,target:{tagName:target}});for(const f of on.pointerup??[])f({clientX:up,clientY:50,button,target:{tagName:target}});};
 const ready=async()=>{await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();};
 const move=(x:number,target='CANVAS')=>{for(const f of on.pointermove??[])f({clientX:x,clientY:50,target:{tagName:target}});};
 const leave=()=>{for(const f of on.pointerout??[])f({relatedTarget:null});};
 // True when the key stops at the bridge.
 const key=(k:string,more:any={})=>{let stopped=false;for(const f of on.keydown??[])f({key:k,shiftKey:false,ctrlKey:false,altKey:false,metaKey:false,target:{tagName:'CANVAS'},...more,stopImmediatePropagation:()=>{stopped=true;},preventDefault:()=>{}});return stopped;};
 const of=(k:string)=>b.messages.filter(m=>k in m.data).map(m=>m.data[k]);
 return {...b,send,click,move,leave,key,of,ready,panes:(n:number,order:number[]|null=null,over:any[]=[])=>{shown=n;numbers=order;extra=over;},picks:()=>b.messages.filter(m=>'viewerMultiPick' in m.data).map(m=>m.data)};
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

test('the tiling messages reach the viewer only from the page and only with values in range',()=>{
 const b=multiBridge();
 for(const good of [{mode:'grid'},{mode:'main',main:'Ann',gap:4,ratio:0.62,animate:true,color:'#1e1e1e'},{main:'⟦MAIN⟧'},{main:3},{gap:0},{gap:24},{ratio:0.5},{ratio:0.8},{animate:false},{}])expect(b.send({multiLayout:good})).toBe(true);
 for(const bad of [{mode:'spiral'},{mode:1},{main:'<b>'},{main:16},{main:-1},{main:1.5},{gap:25},{gap:-1},{gap:2.5},{gap:'4'},{ratio:0.49},{ratio:0.81},{ratio:'0.6'},{animate:1},{color:'red'},{color:'#12345'},{color:'#1e1e1e;x'},{mode:'grid',extra:1},{__proto__:null,toString:1},['grid'],'grid',null,5])expect(b.send({multiLayout:bad})).toBe(false);
 expect(b.send({multiOrder:['Bob','Ann','⟦MAIN⟧']})).toBe(true);
 for(const bad of [['Ann','ann'],['<b>'],'Ann',null,Array.from({length:17},(_,i)=>'Bot'+i)])expect(b.send({multiOrder:bad})).toBe(false);
 for(const good of ['Ann','⟦MAIN⟧',0,15])expect(b.send({multiFocus:good})).toBe(true);
 for(const bad of ['<b>','ThirteenChars',16,-1,1.5,null,['Ann']])expect(b.send({multiFocus:bad})).toBe(false);
 expect(b.send({multiChrome:false})).toBe(true);expect(b.send({multiChrome:true})).toBe(true);
 for(const bad of [0,'false',null])expect(b.send({multiChrome:bad})).toBe(false);
 // One bad part stops the whole message, and so does another sender.
 expect(b.send({multiLayout:{mode:'main'},multiFocus:'<b>'})).toBe(false);
 expect(b.send({multiLayout:{mode:'main'}},{})).toBe(false);expect(b.send({multiOrder:['Ann']},b.host.parent,'https://example.com')).toBe(false);
 expect(b.send({multiFocus:'Ann'},{})).toBe(false);expect(b.send({multiChrome:false},b.host.parent,'https://example.com')).toBe(false);
});

test('a click names the view by its number in the asked order, after a new order and while views cross',async()=>{
 const b=multiBridge();await b.ready();
 b.send({multi:['Ann','Bob','Cat']});b.panes(3);
 // The viewer puts the listed views first and keeps the others: Cat, Ann, Bob. The view at x = 0 is still Ann's.
 b.send({multiOrder:['Cat']});b.panes(3,[1,2,0]);
 b.click(50);b.click(250);
 expect(b.picks()).toEqual([{viewerMultiPick:'Ann',index:1},{viewerMultiPick:'Cat',index:0}]);
 // A refused order changes nothing.
 b.send({multiOrder:['Bob','bob']});b.send({multiOrder:['Bob']},{});b.click(150);
 expect(b.picks().at(-1)).toEqual({viewerMultiPick:'Bob',index:2});
 // Two views over one point while they move: the one drawn last (the higher z-index) is the one clicked.
 const over={dataset:{pane:'2'},style:{zIndex:'9'},getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:100})};
 b.panes(2,[1,0],[over]);b.click(50);
 expect(b.picks().at(-1)).toEqual({viewerMultiPick:'Bob',index:2});
 // A view that closes has no number and is not counted; a number outside the asked list is no view.
 b.panes(3,[1,7,0]);b.click(150);expect(b.picks()).toHaveLength(4);
});

test('the view under the pointer is reported to the page when it changes',async()=>{
 const b=multiBridge();
 b.send({multi:['Ann','Bob']});b.panes(2);b.move(50);
 expect(b.of('viewerMultiHover')).toEqual([]);
 await b.ready();
 b.move(60);b.move(70);b.move(150);b.move(150,'INPUT');b.move(50);b.leave();b.leave();
 expect(b.of('viewerMultiHover')).toEqual([1,-1,0,-1]);
 expect(b.messages.at(-1)!.origin).toBe('http://localhost:3102');
 // No wall: no report.
 b.send({multi:[]});b.move(50);b.leave();
 expect(b.of('viewerMultiHover')).toHaveLength(4);
});

test('the wall keys pressed in the viewer go to the page and not to the camera, only while the wall is open',()=>{
 const b=multiBridge();
 // No wall: the arrows are the camera's. The wall key and the step keys go to the page.
 for(const k of ['ArrowLeft','h','Enter',' ','1','f','Escape','?'])expect(b.key(k)).toBe(false);
 expect(b.key('\\')).toBe(true);expect(b.key(']')).toBe(true);
 expect(b.of('atlasWallKey')).toEqual([{key:'\\',shift:false}]);expect(b.of('atlasStep')).toEqual([1]);
 b.send({multi:['Ann','Bob']});
 const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','h','j','k','l','Enter',' ','1','9','f','?','Escape'];
 for(const k of keys)expect(b.key(k)).toBe(true);
 expect(b.key('ArrowLeft',{shiftKey:true})).toBe(true);expect(b.key('H',{shiftKey:true})).toBe(true);
 expect(b.of('atlasWallKey').slice(1)).toEqual([...keys.map(key=>({key,shift:false})),{key:'ArrowLeft',shift:true},{key:'H',shift:true}]);
 expect(b.messages.at(-1)!.origin).toBe('http://localhost:3102');
 // Other keys, keys with Ctrl, Alt or Meta, and keys typed in a field stay in the viewer.
 const before=b.of('atlasWallKey').length;
 for(const k of ['w','a','0','x','Tab','F5'])expect(b.key(k)).toBe(false);
 expect(b.key('ArrowLeft',{ctrlKey:true})).toBe(false);expect(b.key('f',{metaKey:true})).toBe(false);expect(b.key('Enter',{altKey:true})).toBe(false);
 expect(b.key('Enter',{target:{tagName:'INPUT'}})).toBe(false);expect(b.key('\\',{target:{tagName:'TEXTAREA'}})).toBe(false);
 expect(b.of('atlasWallKey')).toHaveLength(before);
 b.send({multi:[]});expect(b.key('ArrowLeft')).toBe(false);
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

function groundBrowser(){
 const b=browser(),hostListeners:Function[]=[];
 b.host.addEventListener=(t:string,fn:Function)=>{if(t==='message')hostListeners.push(fn);};
 class Socket {
  listeners:Function[]=[];handler:any=null;constructor(..._args:any[]){}
  addEventListener(t:string,fn:Function){if(t==='message')this.listeners.push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.listeners)f(e);this.handler?.(e);}}
 b.host.WebSocket=Socket;b.host.MessageEvent??=class{data:any;origin:any;constructor(_t:string,i:any){this.data=i.data;this.origin=i.origin;}};
 installViewerBridge(b.host);
 const socket:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed'),seen:any[]=[];socket.onmessage=(e:any)=>seen.push(JSON.parse(e.data));
 const page=(data:any,origin=b.host.location.origin,source=b.host.parent)=>{for(const f of hostListeners)f({data,origin,source,stopImmediatePropagation(){}});};
 const zone=()=>seen.at(-1).w??[];
 // What the viewer draws: rs-world WorldState applies the zone records of each tick in order. oa adds a pile, od deletes
 // the first pile of that type on the tile, oc changes the pile with the old count, else the first of that type.
 const drawn=()=>{
  const tiles=new Map<string,[number,number][]>();let area:any=null;
  for(const m of seen)for(const r of m.w??[]){
   const key=`${r.x},${r.z},${r.l}`,list=tiles.get(key)??[];
   if(r.e==='za'){const inside=(a:any,x:number,z:number)=>a&&x>=a.x&&x<a.x+a.w&&z>=a.z&&z<a.z+a.h;for(const k of [...tiles.keys()]){const [x,z]=k.split(',').map(Number) as [number,number];if(r.r||!inside(area,x,z)||!inside(r,x,z))tiles.delete(k);}area=r;continue;}
   if(r.e==='oa'&&r.id>=0&&r.n>=1)list.push([r.id,r.n]);
   if(r.e==='od'){const i=list.findIndex(p=>p[0]===r.id);if(i>=0)list.splice(i,1);}
   if(r.e==='oc'&&r.n>=1){const p=list.find(p=>p[0]===r.id&&p[1]===r.n0)??list.find(p=>p[0]===r.id);if(p)p[1]=r.n;}
   list.length?tiles.set(key,list):tiles.delete(key);
  }
  return Object.fromEntries(tiles);
 };
 return {b,socket,seen,page,zone,drawn};
}
test('ground items from the page reach the viewer as oa records inside the held area, and leave as od records',async()=>{
 const {b,socket,page,zone,drawn}=groundBrowser();await b.consume();
 page({botGround:[[3218,3242,0,526,1],[3218,3242,0,526,1],[3219,3242,0,995,40],[3500,3500,0,995,1]]});
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 // The pile outside the held area is not sent: the viewer would drop it.
 expect(zone()).toEqual([{e:'za',x:3200,z:3200,w:96,h:96,r:1},{e:'oa',x:3218,z:3242,l:0,id:526,n:1},{e:'oa',x:3218,z:3242,l:0,id:526,n:1},{e:'oa',x:3219,z:3242,l:0,id:995,n:40}]);
 // With nothing new, a tick reaches the viewer as the feed sent it.
 socket.message({t:'tick',k:2,ms:600});expect(zone()).toEqual([]);
 // One bone picked up, and the coins stack grows: every pile of a changed type on the tile is deleted and added again.
 page({botGround:[[3218,3242,0,526,1],[3219,3242,0,995,45]]});
 socket.message({t:'tick',k:3,ms:600});
 expect(zone()).toEqual([{e:'od',x:3218,z:3242,l:0,id:526},{e:'od',x:3218,z:3242,l:0,id:526},{e:'oa',x:3218,z:3242,l:0,id:526,n:1},{e:'od',x:3219,z:3242,l:0,id:995},{e:'oa',x:3219,z:3242,l:0,id:995,n:45}]);
 expect(drawn()).toEqual({'3218,3242,0':[[526,1]],'3219,3242,0':[[995,45]]});
});
test('a later pile of one type leaves the viewer, not the first one (the viewer deletes the first pile of a type)',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,20]]});
 socket.message({t:'tick',k:2,ms:600});
 expect(drawn()).toEqual({'3219,3242,0':[[995,10],[995,20]]});
 page({botGround:[[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:3,ms:600});
 expect(drawn()).toEqual({'3219,3242,0':[[995,10]]});
 page({botGround:[[3219,3242,0,995,20]]});
 socket.message({t:'tick',k:4,ms:600});
 expect(drawn()).toEqual({'3219,3242,0':[[995,20]]});
});
test('an obj that the feed itself sends is not added again, and a reset adds the page rows again',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1},{e:'oa',x:3218,z:3242,l:0,id:526,n:1}]});
 page({botGround:[[3218,3242,0,526,1],[3218,3242,0,526,1]]});
 socket.message({t:'tick',k:2,ms:600});
 expect(drawn()).toEqual({'3218,3242,0':[[526,1],[526,1]]});
 socket.message({t:'tick',k:3,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 expect(drawn()).toEqual({'3218,3242,0':[[526,1],[526,1]]});
});
test('feed del and count records that hit a pile of the bridge are repaired on the same tick',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 page({botGround:[[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:2,ms:600});
 // A public pile of 10 appears beside the bridge's private 10: the account sees both, the feed sends one.
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:3,ms:600,w:[{e:'oa',x:3219,z:3242,l:0,id:995,n:10}]});
 expect(drawn()).toEqual({'3219,3242,0':[[995,10],[995,10]]});
 // The feed changes its pile to 30, and the viewer changes the first pile of 10, which is the bridge's.
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,30]]});
 socket.message({t:'tick',k:4,ms:600,w:[{e:'oc',x:3219,z:3242,l:0,id:995,n0:10,n:30}]});
 expect(drawn()['3219,3242,0']!.map(p=>p[1]).sort((a,c)=>a-c)).toEqual([10,30]);
 // The feed's pile leaves, and the viewer deletes the first pile of coins: the private 10 stays.
 page({botGround:[[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:5,ms:600,w:[{e:'od',x:3219,z:3242,l:0,id:995}]});
 expect(drawn()).toEqual({'3219,3242,0':[[995,10]]});
});
test('a feed del that hits a pile of the bridge leaves no ghost pile after the private pile goes',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 page({botGround:[[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:2,ms:600});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:3,ms:600,w:[{e:'oa',x:3219,z:3242,l:0,id:995,n:10}]});
 page({botGround:[[3219,3242,0,995,10]]});
 socket.message({t:'tick',k:4,ms:600,w:[{e:'od',x:3219,z:3242,l:0,id:995}]});
 expect(drawn()).toEqual({'3219,3242,0':[[995,10]]});
 page({botGround:[]});
 socket.message({t:'tick',k:5,ms:600});
 expect(drawn()).toEqual({});
});
test('a public pile and a private pile of one type on a tile each show once',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1},{e:'oa',x:3219,z:3242,l:0,id:995,n:20}]});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,20]]});
 socket.message({t:'tick',k:2,ms:600});
 expect(drawn()['3219,3242,0']!.map(p=>p[1]).sort((a,c)=>a-c)).toEqual([10,20]);
});
test('ground rows from another sender or with a bad row change nothing',async()=>{
 const {b,socket,page,zone}=groundBrowser();await b.consume();
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 page({botGround:[[3218,3242,0,526,1]]},'https://evil.example');
 page({botGround:[[3218,3242,0,526,1],[3218,3242,9,526,1]]});
 page({botGround:Array.from({length:1001},()=>[3218,3242,0,526,1])});
 socket.message({t:'tick',k:2,ms:600});
 expect(zone()).toEqual([]);
});
test('a feed count change and del after a private pile keep the feed order: the surviving public pile stays',async()=>{
 const {b,socket,page,drawn}=groundBrowser();await b.consume();
 const at={x:3219,z:3242,l:0,id:995};
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 page({botGround:[[3219,3242,0,995,10]]});socket.message({t:'tick',k:2,ms:600});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,20]]});socket.message({t:'tick',k:3,ms:600,w:[{e:'oa',...at,n:20}]});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,20],[3219,3242,0,995,10]]});socket.message({t:'tick',k:4,ms:600,w:[{e:'oa',...at,n:10}]});
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,20],[3219,3242,0,995,30]]});socket.message({t:'tick',k:5,ms:600,w:[{e:'oc',...at,n0:10,n:30}]});
 expect(drawn()['3219,3242,0']!.map(p=>p[1]).sort((a,c)=>a-c)).toEqual([10,20,30]);
 // The feed deletes its first pile, the 20.
 page({botGround:[[3219,3242,0,995,10],[3219,3242,0,995,30]]});socket.message({t:'tick',k:6,ms:600,w:[{e:'od',...at}]});
 expect(drawn()['3219,3242,0']!.map(p=>p[1]).sort((a,c)=>a-c)).toEqual([10,30]);
 page({botGround:[]});socket.message({t:'tick',k:7,ms:600});
 expect(drawn()).toEqual({'3219,3242,0':[[995,30]]});
});
test('respawn timers: a loc change to a watched depleted form marks the tile, a del ends it, and the page gets the list',async()=>{
 const {b,socket,page}=groundBrowser();await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 const lists=()=>b.messages.filter(m=>m.data.atlasDepleted).map(m=>m.data.atlasDepleted);
 page({respawnWatch:[450]});
 socket.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 socket.message({t:'tick',k:5,ms:600,w:[{e:'la',x:3210,z:3220,l:0,id:450,s:10,r:0},{e:'la',x:3211,z:3220,l:0,id:1276,s:10,r:0}]});
 expect(lists().at(-1)).toEqual({tick:5,list:[[3210,3220,0,450,5]]});
 socket.message({t:'tick',k:9,ms:600,w:[{e:'ld',x:3210,z:3220,l:0,s:10,r:0}]});
 expect(lists().at(-1)).toEqual({tick:9,list:[]});
 // A depleted loc in the snapshot of a newly held zone has no start tick.
 socket.message({t:'tick',k:12,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1},{e:'la',x:3230,z:3230,l:0,id:450,s:10,r:0}]});
 expect(lists().at(-1)).toEqual({tick:12,list:[[3230,3230,0,450,null]]});
 page({respawnWatch:[-1]});
 expect(lists().length).toBe(3);
});
test('respawn timers: a closed main feed and a new watch list send the page an empty list',async()=>{
 const b=browser(),hostListeners:Function[]=[];
 b.host.addEventListener=(t:string,fn:Function)=>{if(t==='message')hostListeners.push(fn);};
 class Socket {
  on:Record<string,Function[]>={};handler:any=null;constructor(..._args:any[]){}
  addEventListener(t:string,fn:Function){(this.on[t]??=[]).push(fn);}
  get onmessage(){return this.handler;}set onmessage(fn:any){this.handler=fn;}
  message(m:any){const e={data:JSON.stringify(m),origin:'wss://x'};for(const f of this.on.message??[])f(e);this.handler?.(e);}
  close(){for(const f of this.on.close??[])f({});}}
 b.host.WebSocket=Socket;b.host.MessageEvent??=class{data:any;origin:any;constructor(_t:string,i:any){this.data=i.data;this.origin=i.origin;}};
 installViewerBridge(b.host);await b.consume();b.geometry();b.present();b.frame();b.frame();b.frame();
 const page=(data:any)=>{for(const f of hostListeners)f({data,origin:b.host.location.origin,source:b.host.parent,stopImmediatePropagation(){}});};
 const last=()=>b.messages.filter(m=>m.data.atlasDepleted).at(-1)?.data.atlasDepleted;
 const s1:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');s1.onmessage=()=>{};
 page({respawnWatch:[450]});
 s1.message({t:'tick',k:1,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1}]});
 s1.message({t:'tick',k:5,ms:600,w:[{e:'la',x:3210,z:3220,l:0,id:450,s:10,r:0}]});
 expect(last().list.length).toBe(1);
 s1.close();
 expect(last().list).toEqual([]);
 const s2:any=new b.host.WebSocket('wss://rs-sdk-demo.fly.dev/worldfeed');s2.onmessage=()=>{};
 s2.message({t:'tick',k:9,ms:600,w:[{e:'za',x:3200,z:3200,w:96,h:96,r:1},{e:'la',x:3210,z:3220,l:0,id:450,s:10,r:0}]});
 expect(last().list.length).toBe(1);
 page({respawnWatch:[451]});
 expect(last().list).toEqual([]);
});
