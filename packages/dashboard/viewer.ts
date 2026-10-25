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
    const undo:(()=>void)[]=[];
    const emit=(detail='A geometry frame was presented; terrain streaming may continue.')=>{
        if(host.parent===host)return;
        const state=failed?'error':privacyReady&&renderReady?'ready':'loading';
        host.parent.postMessage({viewerState:{state,privacyReady,renderReady,feedConnected,detail}},host.location.origin);
        if(state==='ready'&&!announced){announced=true;for(const restore of undo.splice(0))restore();}
    };
    const fail=(detail:string)=>{failed=true;privacyReady=false;emit(detail);};
    const url=new host.URL(host.location.href),hidden=url.searchParams.get('hideNamesFrom');
    let hiddenUrl:any;
    try{hiddenUrl=new host.URL(hidden,host.location.href);}catch{fail('Private name filter URL is unavailable.');return;}
    if(!hidden||hiddenUrl.origin!==host.location.origin||hiddenUrl.pathname!=='/api/hidden-names'||hiddenUrl.search){fail('Private name filter must use this dashboard.');return;}
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
                if(!Array.isArray(list)||list.length<1||list.length>64||list.some(n=>typeof n!=='string'||!/^[A-Za-z0-9_ -]{1,12}$/.test(n)))throw new Error('invalid name filter');
                // embed.ts applies its hidden Set in the promise continuation.
                // Two animation turns follow that actual .json() consumption.
                host.requestAnimationFrame(()=>host.requestAnimationFrame(()=>{if(!failed){privacyReady=true;emit();}}));
                return list;
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
            }}catch{/* Non-feed sockets do not affect readiness. */}
        }
    };
    host.addEventListener('error',()=>fail('The 3D viewer reported an error; use the 2D map.'));
    host.addEventListener('unhandledrejection',(event:any)=>{if(event.reason?.name!=='AbortError')fail('The 3D viewer could not finish loading; use the 2D map.');});
}

export const viewerBridgeSource=()=>`(${installViewerBridge.toString()})(window);`;
