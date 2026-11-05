// Adapter for the reviewed, already-built viewer. No vendor rebuild or service worker.
export const VIEWER_MANIFEST_SHA256='277B2245634318664CE4A1D8D9C14D3DF2F7B6AAC6E74E5AD39A376E57FFF87C';

export function viewerAssetRoute(pathname:string):{root:'static'|'caches';relative:string}|'bad'|null {
    let decoded:string;try{decoded=decodeURIComponent(pathname);}catch{return 'bad';}
    const root=decoded.startsWith('/static/')?'static':decoded.startsWith('/caches/')?'caches':null;
    if(!root)return null;
    const relative=decoded.slice(8);
    if(!relative||relative.split('/').some(p=>!p||p==='..'||p==='.')||/[\\\x00-\x1f%:]/.test(relative))return 'bad';
    return {root,relative};
}

// Kept self-contained: only this function is serialized into the /viewer/ entry.
// A geometry draw followed by a screen present is not a promise that every tile loaded.
export function installViewerBridge(host:any) {
    let privacyReady=false,renderReady=false,feedConnected:boolean|null=null,failed=false,announced=false;
    // The feed sends the roster about every 30 s: one that arrives while the scene loads waits here for the ready state.
    let heldRoster:(()=>void)|null=null;
    let hiddenNames=new Set<string>(),publishedFollow:string|null=null,publishedWorldMap=false,publishedCamera='',freeCameraPolls=0;
    // A hosted page must not hold the hidden name itself: its list carries "h:<FNV-1a of the lower-case name>" entries.
    // The bridge then renames a matching roster player to HIDDEN_ALIAS before the viewer reads the message, and gives
    // the viewer that alias to hide. Names keep the one character set the list allows, so a plain loop hashes them.
    const HIDDEN_ALIAS='Hidden',hiddenHashes=new Set<string>(),learned=new Set<string>();
    // Feed messages wait until the name filter has loaded, so a roster that arrives first is filtered too.
    let filterLoaded=false;const held:(()=>void)[]=[];
    const fnv=(value:string)=>{let h=0x811c9dc5;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(16).padStart(8,'0');};
    const undo:(()=>void)[]=[];
    // The loading text names the step still open: the private-name filter, or the first drawn frame.
    const emit=(detail=!privacyReady?'Loading the 3D world… applying the name filter.':!renderReady?'Loading the 3D world… drawing the first frame.':'3D world ready.')=>{
        if(host.parent===host)return;
        const state=failed?'error':privacyReady&&renderReady?'ready':'loading';
        if(state==='ready'&&heldRoster){const send=heldRoster;heldRoster=null;send();}
        host.parent.postMessage({viewerState:{state,privacyReady,renderReady,feedConnected,detail}},host.location.origin);
        if(state==='ready'&&!announced){announced=true;for(const restore of undo.splice(0))restore();}
    };
    const fail=(detail:string)=>{failed=true;privacyReady=false;emit(detail);};
    const url=new host.URL(host.location.href),hidden=url.searchParams.get('hideNamesFrom');
    let hiddenUrl:any;
    try{hiddenUrl=new host.URL(hidden,host.location.href);}catch{fail('Private name filter URL is unavailable.');return;}
    if(!hidden||hiddenUrl.origin!==host.location.origin||!hiddenUrl.pathname.endsWith('/api/hidden-names')||hiddenUrl.search){fail('Private name filter must use this dashboard.');return;}
    const glType=host.WebGL2RenderingContext;
    if(!glType){fail('WebGL2 is unavailable; use the 2D map.');return;}
    emit('Loading the private name filter and a rendered geometry frame.');
    const fetch=host.fetch.bind(host);
    host.fetch=async(input:any,init:any)=>{
        let target:any;try{target=new host.URL(typeof input==='string'?input:input?.url??String(input),host.location.href);}catch{return fetch(input,init);}
        let response:any;
        try{response=await fetch(input,init);}catch(e){if(target.href===hiddenUrl.href)fail('Private name filter could not be loaded.');throw e;}
        if(target.href!==hiddenUrl.href)return response;
        if(!response.ok){fail('Private name filter could not be loaded.');return response;}
        const json=response.json.bind(response);
        response.json=async()=>{
            try{
                const list=await json();
                if(!Array.isArray(list)||list.length<1||list.length>64||list.some(n=>typeof n!=='string'||!/^(?:[A-Za-z0-9_ -]{1,12}|h:[0-9a-f]{8})$/.test(n)))throw new Error('invalid name filter');
                const names=list.filter(n=>!n.startsWith('h:'));
                for(const n of list)if(n.startsWith('h:'))hiddenHashes.add(n.slice(2));
                hiddenNames=new Set([...names.map(n=>n.toLowerCase()),...learned]);
                filterLoaded=true;for(const deliver of held.splice(0))deliver();
                // embed.ts applies its hidden Set in the promise continuation.
                // Two animation turns follow that actual .json() consumption.
                host.requestAnimationFrame(()=>host.requestAnimationFrame(()=>{if(!failed){privacyReady=true;emit();}}));
                return hiddenHashes.size?[...names,HIDDEN_ALIAS]:list;
            }catch(e){fail('Private name filter was not applied; the viewer stays hidden.');throw e;}
        };
        return response;
    };
    const context=new WeakMap<object,{geometry:boolean}>(),extensions=new WeakSet<object>();
    const mainCanvas=(gl:any)=>gl.canvas?.tagName==='CANVAS'&&gl.canvas.isConnected===true&&gl.canvas.tabIndex===0&&gl.canvas.width>=32&&gl.canvas.height>=32;
    const record=(gl:any,count:number,instances:number)=>{
        if(failed||announced||!mainCanvas(gl)||!(count>0&&instances>0))return;
        let state=context.get(gl);if(!state){state={geometry:false};context.set(gl,state);}
        if(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)!==null){if(count>6)state.geometry=true;}
        else if(state.geometry){state.geometry=false;host.requestAnimationFrame(()=>{if(!failed){renderReady=true;emit();}});}
    };
    const patch=(object:any,key:string,wrap:(original:any)=>any)=>{
        const original=object[key];if(typeof original!=='function')return;
        object[key]=wrap(original);undo.push(()=>{object[key]=original;});
    };
    const proto=glType.prototype;
    for(const [key,countIndex,instanceIndex] of [['drawElements',1,-1],['drawArrays',2,-1],['drawElementsInstanced',1,4],['drawArraysInstanced',2,3]] as const)
        patch(proto,key,original=>function(this:any,...args:any[]){const result=original.apply(this,args);record(this,Number(args[countIndex]),instanceIndex<0?1:Number(args[instanceIndex]));return result;});
    patch(proto,'clear',original=>function(this:any,...args:any[]){const result=original.apply(this,args);if(this.getParameter(this.DRAW_FRAMEBUFFER_BINDING)!==null){const state=context.get(this);if(state)state.geometry=false;}return result;});
    patch(proto,'getExtension',original=>function(this:any,name:string){
        const ext=original.call(this,name),gl=this;
        if(ext&&/multi_draw/i.test(name)&&!extensions.has(ext)){
            extensions.add(ext);
            for(const key of ['multiDrawElementsInstancedWEBGL','multiDrawArraysInstancedWEBGL'])patch(ext,key,draw=>function(this:any,...args:any[]){
                const result=draw.apply(this,args),arrays=key.includes('Arrays');
                const counts=args[arrays?3:1],instances=args[arrays?5:6],countOffset=args[arrays?4:2],instanceOffset=args[arrays?6:7],draws=args[arrays?7:8];
                // The pinned PicoGL adapter supplies offsets0 for both arrays.
                if(countOffset===0&&instanceOffset===0&&counts&&instances)for(let i=0;i<Math.min(Number(draws),counts.length);i++)record(gl,Number(counts[i]),Number(instances[i]));
                return result;
            });
        }
        return ext;
    });
    const Socket=host.WebSocket;
    if(Socket)host.WebSocket=class extends Socket {
        constructor(address:any,protocols?:any){
            super(address,protocols);
            try{if(new host.URL(String(address),host.location.href).pathname==='/worldfeed'){
                this.addEventListener('open',()=>{feedConnected=true;emit();});
                this.addEventListener('close',()=>{feedConnected=false;emit();});
                this.addEventListener('error',()=>{feedConnected=false;emit();});
                // The viewer reads the feed through onmessage: it gets each message with hash-listed names renamed.
                let accessor:any=null;for(let p=Socket.prototype;p&&!accessor;p=Object.getPrototypeOf(p))accessor=Object.getOwnPropertyDescriptor(p,'onmessage');
                const rename=(event:any)=>{
                    if(!hiddenHashes.size||typeof event?.data!=='string')return event;
                    let data:string=event.data;
                    if(data.includes('"roster"'))try{const m=JSON.parse(data);if(m.t==='roster'&&Array.isArray(m.p))for(const p of m.p)if(Array.isArray(p)&&typeof p[1]==='string'&&/^[A-Za-z0-9_ -]{1,12}$/.test(p[1])&&hiddenHashes.has(fnv(p[1].toLowerCase()))){learned.add(p[1].toLowerCase());hiddenNames.add(p[1].toLowerCase());}}catch{/* not JSON: left as it is */}
                    for(const name of learned)data=data.replace(new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi'),HIDDEN_ALIAS);
                    return data===event.data?event:new host.MessageEvent('message',{data,origin:event.origin});
                };
                if(accessor?.set){let handler:any=null;Object.defineProperty(this,'onmessage',{configurable:true,get:()=>handler,set:(fn:any)=>{handler=fn;accessor.set.call(this,typeof fn==='function'?(event:any)=>{if(!filterLoaded){if(held.length<5000)held.push(()=>fn.call(this,rename(event)));return;}fn.call(this,rename(event));}:fn);}});}
                const names=new Map<number,string>(),seenChat=new Set<string>();
                // Opponent information (RuneLite opponentinfo): what the followed player faces (fe: an npc nid, or
                // 32768 + a player slot) and that entity's hitpoints, which the feed sends with each hitmark.
                const faces=new Map<number,number>(),npcs=new Map<number,{t?:number;hp?:[number,number]}>(),playerHp=new Map<number,[number,number]>();let publishedOpponent='null';
                const hp=(v:any):[number,number]|undefined=>Array.isArray(v)&&v.length===2&&v.every((n:any)=>Number.isFinite(n))?[v[0],v[1]]:undefined;
                const mask=(value:string)=>{for(const name of hiddenNames)value=value.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'⟦MAIN⟧');return value;};
                this.addEventListener('message',(event:any)=>{
                    if(typeof event.data!=='string'||event.data.length>2_000_000)return;
                    let message:any;try{message=JSON.parse(event.data);}catch{return;}
                    if(message.t==='roster'&&Array.isArray(message.p)){
                        for(const p of message.p)if(Array.isArray(p)&&typeof p[0]==='number'&&typeof p[1]==='string')names.set(p[0],p[1]);
                        // The page's own data can be minutes old; each roster is the full list of players online now.
                        const sendRoster=()=>host.parent.postMessage({atlasRoster:{players:message.p.filter((p:any)=>Array.isArray(p)&&typeof p[1]==='string'&&[p[2],p[3],p[4],p[5]].every(Number.isFinite)).map((p:any)=>[hiddenHashes.has(fnv(p[1].toLowerCase()))?'⟦MAIN⟧':mask(p[1]),p[2],p[3],p[4],p[5]])}},host.location.origin);
                        if(host.parent!==host&&!failed){if(privacyReady&&renderReady)sendRoster();else heldRoster=sendRoster;}
                    }
                    if(message.t==='tick'){
                        if(message.reset){faces.clear();npcs.clear();playerHp.clear();}
                        for(const r of Array.isArray(message.p)?message.p:[]){if(typeof r?.i!=='number')continue;if(r.f){faces.delete(r.i);playerHp.delete(r.i);}if(typeof r.fe==='number')r.fe<0?faces.delete(r.i):faces.set(r.i,r.fe);const h=hp(r.hp);if(h)playerHp.set(r.i,h);}
                        for(const r of Array.isArray(message.n)?message.n:[]){if(typeof r?.i!=='number')continue;const e=r.f?{}:npcs.get(r.i)??{};if(typeof r.t==='number')e.t=r.t;const h=hp(r.hp);if(h)e.hp=h;npcs.set(r.i,e);}
                        for(const i of Array.isArray(message.rp)?message.rp:[]){faces.delete(i);playerHp.delete(i);}
                        for(const i of Array.isArray(message.rn)?message.rn:[])npcs.delete(i);
                        if(privacyReady&&renderReady&&!failed&&host.parent!==host){
                            const follow=new host.URL(host.location.href).searchParams.get('follow')?.toLowerCase();let slot:number|undefined;
                            if(follow)for(const [i,n] of names)if(n.toLowerCase()===follow){slot=i;break;}
                            const fe=slot==null?undefined:faces.get(slot);let opponent:any=null;
                            // Shown once the target has taken a hit, as RuneLite shows it in combat, not for talk or pickpocketing.
                            if(fe!=null&&fe>=32768){const h=playerHp.get(fe-32768),n=names.get(fe-32768);if(h&&n)opponent={kind:'player',name:mask(n),hp:h};}
                            else if(fe!=null){const e=npcs.get(fe);if(e?.hp&&e.t!=null)opponent={kind:'npc',type:e.t,hp:e.hp};}
                            const key=JSON.stringify(opponent);if(key!==publishedOpponent){publishedOpponent=key;host.parent.postMessage({atlasOpponent:opponent},host.location.origin);}
                        }
                    }
                    if(message.t!=='tick'||!Array.isArray(message.p)||!privacyReady||!renderReady||failed||host.parent===host)return;
                    for(const p of message.p){
                        if(typeof p.ch!=='string'||typeof p.i!=='number'||!names.has(p.i))continue;
                        const key=String(message.k)+':'+p.i+':'+p.ch;
                        if(seenChat.has(key))continue;seenChat.add(key);if(seenChat.size>500)seenChat.delete(seenChat.values().next().value!);
                        host.parent.postMessage({atlasChat:{key:mask(key),name:mask(names.get(p.i)!),text:mask(p.ch).slice(0,500)}},host.location.origin);
                    }
                });
            }}catch{/* Non-feed sockets do not affect readiness. */}
        }
    };
    // The page's minimap stands in for the viewer's own (hidden by client-viewer.css): its compass and world-map buttons
    // press the viewer's, which stay in the page for this.
    let pageFollow='',pageFollowPolls=0;
    const releaseFollow=()=>{
        const button=host.document?.querySelector('.live-follow button');if(!button)return false;
        button.click();freeCameraPolls=0;
        const url=new host.URL(host.location.href);publishedFollow=url.searchParams.get('follow');
        // Native Stop can leave the URL unchanged until the camera next moves.
        // Remove the released target before the URL relay can select it again.
        if(host.history?.replaceState){url.searchParams.delete('follow');host.history.replaceState(host.history.state,'',url.href);publishedFollow=null;}
        return true;
    };
    host.addEventListener('message',(event:any)=>{
        if(event.origin!==host.location.origin||event.source!==host.parent||!event.data||typeof event.data!=='object')return;
        if(event.data.atlasCompass===true)host.document?.querySelector('.minimap-container .compass')?.click();
        if(event.data.atlasOpenWorldMap===true)host.document?.querySelector('.minimap-container .worldmap-icon')?.click();
        if(typeof event.data.follow==='string'){freeCameraPolls=0;publishedFollow=null;pageFollow=event.data.follow.toLowerCase();pageFollowPolls=20;}
        if(event.data.atlasFreeCamera===true){freeCameraPolls=10;releaseFollow();}
    });
    // The page owns the account order: [ and ] step through its accounts, not through every online player.
    host.addEventListener('keydown',(event:any)=>{
        if(event.key!=='['&&event.key!==']')return;
        event.stopImmediatePropagation();event.preventDefault();
        if(host.parent!==host)host.parent.postMessage({atlasStep:event.key===']'?1:-1},host.location.origin);
    },true);
    host.addEventListener('error',()=>fail('The 3D viewer reported an error; use the 2D map.'));
    // A graphics reset leaves a black canvas. The page reloads the viewer after this failure. The event does not bubble.
    host.document?.addEventListener?.('webglcontextlost',()=>fail('The 3D view lost its graphics context.'),true);
    host.addEventListener('unhandledrejection',(event:any)=>{if(event.reason?.name!=='AbortError')fail('The 3D viewer could not finish loading; use the 2D map.');});
    // The pinned viewer publishes its current follow target in its URL. Relay
    // that documented state; do not depend on unbuilt debug globals.
    host.setInterval?.(()=>{
        if(!privacyReady||!renderReady||failed||host.parent===host)return;
        if(freeCameraPolls){
            if(releaseFollow())return;
            if(!new host.URL(host.location.href).searchParams.get('follow'))freeCameraPolls=0;
            else if(--freeCameraPolls===0)fail('The 3D follow could not stop. Use the 2D map.');
            return;
        }
        const worldMap=!!host.document?.querySelector('.worldmap-modal-overlay');
        if(worldMap!==publishedWorldMap){publishedWorldMap=worldMap;host.parent.postMessage({atlasWorldMap:worldMap},host.location.origin);}
        // The viewer keeps its camera in its own URL (cx, cz in tiles, y = yaw 0-2047): the page's minimap turns with it.
        const params=new host.URL(host.location.href).searchParams,cx=Number(params.get('cx')),cz=Number(params.get('cz')),yaw=Number(params.get('y'));
        if(params.has('cx')&&Number.isFinite(cx)&&Number.isFinite(cz)&&Number.isFinite(yaw)){const key=cx+','+cz+','+yaw;if(key!==publishedCamera){publishedCamera=key;host.parent.postMessage({atlasCamera3d:{x:cx,z:cz,yaw:yaw&2047}},host.location.origin);}}
        const follow=params.get('follow');
        // The viewer writes its URL late. Until the URL names the page's choice, the old name there is not a new follow.
        if(pageFollowPolls){
            if(follow?.toLowerCase()===pageFollow){pageFollowPolls=0;publishedFollow=follow;return;}
            if(--pageFollowPolls)return;
        }
        if(!follow||follow===publishedFollow||!/^[A-Za-z0-9_ -]{1,12}$/.test(follow))return;
        publishedFollow=follow;
        host.parent.postMessage({atlasFollow:hiddenNames.has(follow.toLowerCase())?'⟦MAIN⟧':follow},host.location.origin);
    },500);
}

export const viewerBridgeSource=()=>`(${installViewerBridge.toString()})(window);`;
