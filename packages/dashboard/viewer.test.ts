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
