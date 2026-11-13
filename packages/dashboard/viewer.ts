// Adapter for the reviewed rs-world build. The build runs as it is: the page talks to it by URL and message.
export const VIEWER_MANIFEST_SHA256='043962B28296F43B671677C2FE734D45C3D1281179B7A449712E96B45B578937';

export function viewerAssetRoute(pathname:string):{root:'static'|'caches';relative:string}|'bad'|null {
    let decoded:string;try{decoded=decodeURIComponent(pathname);}catch{return 'bad';}
    const root=decoded.startsWith('/static/')?'static':decoded.startsWith('/caches/')?'caches':null;
    if(!root)return null;
    const relative=decoded.slice(8);
    if(!relative||relative.split('/').some(p=>!p||p==='..'||p==='.')||/[\\\x00-\x1f%:]/.test(relative))return 'bad';
    return {root,relative};
}

export const once = (text: string, from: string | RegExp, to: string, what: string) => {
    const count = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, from.flags.includes('g') ? from.flags : from.flags + 'g')) ?? []).length;
    if (count !== 1) throw Error(`${what}: expected one match, found ${count}`);
    return text.replace(from, () => to.replace(/\$1/g, () => (typeof from === 'string' ? '$1' : text.match(from)![1]!)));
};

// What the dashboard needs from the rs-world build, each as a text that the viewer source leaves in the main bundle
// (branch fleet-v2). The page drives these; a build without one stops the export.
export const VIEWER_FEATURES: [what: string, text: string][] = [
    ['floor limit in the shader', 'float(modelInfo.plane) > u_maxPlane'],   // a floor change reloads no square
    ['first floor limit', '.get("ml")'],                                    // ?ml=<floor>
    ['floor limit message', 'setFloorLimit('],                              // {maxLevel}
    ['prewarm message', 'setWarmTiles('],                                   // {warm:[[x,z],...]}
    ['prewarm step', 'warmStep('],
    ['flight from free camera', 'visibleMapCount'],
    ['steps without a tile', 'moveCode('],
    ['follow change timing', 'viewerTiming'],
    ['multi-view status', 'viewerMulti'],                                   // {multi:[names]}, the Fleet wall
    ['multi-view frame', 'multi-pane'],                                     // the bridge finds a clicked view by it
    ['multi-view number', 'dataset.pane'],                                  // the view's place in the asked order
    ['tiling message', 'setMultiLayout('],                                  // {multiLayout:{mode,main,gap,ratio,rows,cols,strip,animate,color}}
    ['sizes of rows and columns', 'rowShares'],                             // rows, cols: the shares; strip: the Focus strip
    ['view order message', 'setMultiOrder('],                               // {multiOrder:[names]}
    ['view focus message', 'setMultiFocus('],                               // {multiFocus:name}
    ['page-drawn frames', 'setMultiChrome('],                               // {multiChrome:false}
    ['tiling report', 'layoutInfo('],                                       // {viewerMultiLayout}: the rectangles for the page's frames
    ['moves at the display rate', 'needsEveryFrame('],                      // no frame limit while views move
    ['way back to the single view', 'onClosed'],                            // the kept view grows to the full frame
    ['markers message', 'setOverlay('],                                     // {overlay:{tiles,pies,lines,players,npcs,ground}}: RuneLite-style highlights
    ['markers layer', 'drawMarkers('],                                      // drawn under the names at the ground height of each tile
];
export function checkViewerBundle(text: string) {
    for (const [what, feature] of VIEWER_FEATURES) if (!text.includes(feature)) throw Error(`${what}: the rs-world build lacks ${feature}`);
    return text;
}
// The build's own names for its entry files: asset-manifest.json is the one place that holds them.
export function viewerEntry(manifestText: string) {
    const files = JSON.parse(manifestText).files ?? {}, main = files['main.js'], css = files['main.css'];
    for (const p of [main, css]) if (typeof p !== 'string' || !/^\/static\/(?:js|css)\/[\w.-]+$/.test(p)) throw Error('asset-manifest.json names no main.js or main.css under /static/');
    return { main: main as string, css: css as string };
}

// Kept self-contained: only this function is serialized into the /viewer/ entry.
// A geometry draw followed by a screen present is not a promise that every tile loaded.
export function installViewerBridge(host:any) {
    let privacyReady=false,renderReady=false,feedConnected:boolean|null=null,failed=false,announced=false;
    // The feed sends the roster every 10 ticks: one that arrives while the scene loads waits here for the ready state.
    // The page takes a roster as new, so one older than the page's 30 s limit is dropped.
    let heldRoster:(()=>void)|null=null,heldRosterAt=0;
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
        if(state==='ready'&&heldRoster){const send=heldRoster;heldRoster=null;if(Date.now()-heldRosterAt<30_000)send();}
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
                // The viewer's PicoGL adapter supplies offset 0 for both arrays.
                if(countOffset===0&&instanceOffset===0&&counts&&instances)for(let i=0;i<Math.min(Number(draws),counts.length);i++)record(gl,Number(counts[i]),Number(instances[i]));
                return result;
            });
        }
        return ext;
    });
    // Ground items (RuneLite ground items). The live feed sends no obj, and no feed sends a private drop such as the loot
    // of an npc that one of our accounts killed. The page sends what our accounts see on the floor:
    // {botGround:[[x,z,level,id,count],...]}, at most 1000 rows. Each feed socket adds the change since its last tick to
    // the tick's zone records (w) as oa and od records, after the feed's own. An obj that the feed itself sends counts
    // first, so one pile shows once.
    let botGround:number[][]=[],groundVersion=0;
    // Respawn timers (RuneLite's Mining and Woodcutting plugins). The page sends the loc ids of depleted rocks and
    // stumps ({respawnWatch:[id,...]}, client-assets/resources.json). On the main view's feed, a loc change (la) to one of
    // them marks its tile depleted at that tick; a change to another loc, or a del (ld: back to the map's own loc), ends
    // it. A depleted loc in the snapshot of a newly held zone has no start tick (null). The page gets the list on each
    // change: {atlasDepleted:{tick, list:[[x, z, level, id, since]]}}. Only tiles inside the held area stay.
    let respawnWatch=new Set<number>(),mainFeed:any=null,depletedArea:{x:number;z:number;w:number;h:number}|null=null;
    const depleted=new Map<string,[number,number,number,number,number|null]>();
    // depletedSent: the page holds a list that is not empty. A cleared list reaches the page as an empty one.
    let depletedSent=false;
    const publishDepleted=(tick:number)=>{if(privacyReady&&renderReady&&!failed&&host.parent!==host){host.parent.postMessage({atlasDepleted:{tick,list:[...depleted.values()]}},host.location.origin);depletedSent=depleted.size>0;}};
    const clearDepleted=()=>{const had=depleted.size>0||depletedSent;depleted.clear();depletedArea=null;if(had)publishDepleted(0);};
    const trackDepleted=(m:any)=>{
        if(!respawnWatch.size||!Array.isArray(m.w)&&!m.reset)return;
        let changed=false;
        if(m.reset&&depleted.size){depleted.clear();changed=true;}
        for(const r of Array.isArray(m.w)?m.w:[]){
            if(r?.e==='za'&&[r.x,r.z,r.w,r.h].every(Number.isFinite)){
                const fresh=!!r.r,old=depletedArea;depletedArea={x:r.x,z:r.z,w:r.w,h:r.h};
                for(const [k,v] of [...depleted])if(fresh||!(v[0]>=r.x&&v[0]<r.x+r.w&&v[1]>=r.z&&v[1]<r.z+r.h)||!old){depleted.delete(k);changed=true;}
                continue;
            }
            if((r?.e!=='la'&&r?.e!=='ld')||![r.x,r.z,r.l].every(Number.isSafeInteger))continue;
            const key=r.x+','+r.z+','+r.l;
            if(r.e==='la'&&respawnWatch.has(r.id)){if(!depleted.has(key)){depleted.set(key,[r.x,r.z,r.l,r.id,m.reset||Array.isArray(m.w)&&m.w[0]?.e==='za'?null:m.k]);changed=true;}}
            else if(depleted.delete(key))changed=true;
        }
        if(changed)publishDepleted(m.k);
    };
    const groundRow=(r:any)=>Array.isArray(r)&&r.length===5&&r.every(Number.isSafeInteger)&&r[0]>=0&&r[0]<16384&&r[1]>=0&&r[1]<16384&&r[2]>=0&&r[2]<4&&r[3]>=0&&r[3]<65536&&r[4]>=1&&r[4]<2**31;
    const Socket=host.WebSocket;
    if(Socket)host.WebSocket=class extends Socket {
        constructor(address:any,protocols?:any){
            super(address,protocols);
            try{if(new host.URL(String(address),host.location.href).pathname==='/worldfeed'){
                // The first feed socket is the main view's: its area is the one the respawn timers follow.
                if(!mainFeed){mainFeed=this;clearDepleted();}
                this.addEventListener('open',()=>{feedConnected=true;emit();});
                this.addEventListener('close',()=>{feedConnected=false;emit();if(mainFeed===this){mainFeed=null;clearDepleted();}});
                this.addEventListener('error',()=>{feedConnected=false;emit();});
                // The viewer reads the feed through onmessage: it gets each message with hash-listed names renamed.
                let accessor:any=null;for(let p=Socket.prototype;p&&!accessor;p=Object.getPrototypeOf(p))accessor=Object.getOwnPropertyDescriptor(p,'onmessage');
                // The feed sends one full roster (p), then changes (d:1): lv slots that left, j rows that joined or changed,
                // m [slot,x,z,level,combat?] moves. The viewer applies changes itself. The bridge's own listener needs every
                // player, so there each change becomes a full roster.
                const rosterRows=new Map<number,any[]>();
                const fullRoster=(event:any)=>{
                    if(typeof event?.data!=='string'||event.data.length>2_000_000||!event.data.includes('"roster"'))return event;
                    try{
                        const m=JSON.parse(event.data);if(m.t!=='roster')return event;
                        if(Array.isArray(m.p)){rosterRows.clear();for(const r of m.p)if(Array.isArray(r))rosterRows.set(r[0],r);return event;}
                        for(const slot of Array.isArray(m.lv)?m.lv:[])rosterRows.delete(slot);
                        for(const r of Array.isArray(m.j)?m.j:[])if(Array.isArray(r))rosterRows.set(r[0],r);
                        for(const r of Array.isArray(m.m)?m.m:[]){const row=Array.isArray(r)?rosterRows.get(r[0]):undefined;if(row){row[2]=r[1];row[3]=r[2];row[4]=r[3];if(r.length>4)row[5]=r[4];}}
                        return new host.MessageEvent('message',{data:JSON.stringify({t:'roster',k:m.k,p:[...rosterRows.values()],npcs:m.npcs}),origin:event.origin});
                    }catch{/* not JSON: left as it is */}
                    return event;
                };
                // A hash-listed name enters in a full roster (p) or in a change (j).
                const rename=(event:any)=>{
                    if(!hiddenHashes.size||typeof event?.data!=='string')return event;
                    let data:string=event.data;
                    if(data.includes('"roster"'))try{const m=JSON.parse(data);if(m.t==='roster')for(const p of [...(Array.isArray(m.p)?m.p:[]),...(Array.isArray(m.j)?m.j:[])])if(Array.isArray(p)&&typeof p[1]==='string'&&/^[A-Za-z0-9_ -]{1,12}$/.test(p[1])&&hiddenHashes.has(fnv(p[1].toLowerCase()))){learned.add(p[1].toLowerCase());hiddenNames.add(p[1].toLowerCase());}}catch{/* not JSON: left as it is */}
                    for(const name of learned)data=data.replace(new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi'),HIDDEN_ALIAS);
                    return data===event.data?event:new host.MessageEvent('message',{data,origin:event.origin});
                };
                // The viewer keeps the objs of the zones in the held area (za): a reset (r) starts every zone again, and an
                // area change keeps only the zones in both areas. For each tile and type ("x,z,level,id") the bridge keeps
                // two lists of counts. `feed` is the feed's own piles in the feed's order: oa adds one at the end, od
                // deletes the first, oc changes the first of the old count, else the first. `view` is what the viewer draws,
                // in its order, by the viewer's own rules (rs-world WorldState): the same rules over the feed's records and
                // the bridge's. The viewer should draw the feed's piles, then the bridge's. When `view` differs from that,
                // the bridge deletes every pile of that type on the tile and adds them again in that order.
                let area:{x:number;z:number;w:number;h:number}|null=null,seenVersion=-1;
                const feedPiles=new Map<string,number[]>(),viewPiles=new Map<string,number[]>();
                const inArea=(a:typeof area,x:number,z:number)=>!!a&&x>=a.x&&x<a.x+a.w&&z>=a.z&&z<a.z+a.h;
                const apply=(map:Map<string,number[]>,g:string,r:any)=>{
                    const list=map.get(g)??[];
                    if(r.e==='oa'){if(r.id>=0&&r.n>=1)list.push(r.n);}
                    else if(r.e==='od')list.shift();
                    else if(r.n>=1&&list.length){const i=list.indexOf(r.n0);list[i>=0?i:0]=r.n;}
                    list.length?map.set(g,list):map.delete(g);
                };
                const addGround=(event:any)=>{
                    if(typeof event?.data!=='string'||event.data.length>2_000_000||!event.data.includes('"tick"'))return event;
                    // With the same rows and no area or obj change, the result is the same as last tick: nothing to add.
                    if(seenVersion===groundVersion&&!/"(?:za|oa|od|oc|reset)"/.test(event.data))return event;
                    let m:any;try{m=JSON.parse(event.data);}catch{return event;}
                    if(m?.t!=='tick')return event;
                    const w=Array.isArray(m.w)?m.w:[];
                    if(m.reset){feedPiles.clear();viewPiles.clear();}
                    for(const r of w){
                        if(r?.e==='za'&&[r.x,r.z,r.w,r.h].every(Number.isFinite)){
                            const next={x:r.x,z:r.z,w:r.w,h:r.h};
                            if(r.r){feedPiles.clear();viewPiles.clear();}
                            else for(const map of [feedPiles,viewPiles])for(const g of [...map.keys()]){const [x,z]=g.split(',').map(Number) as [number,number];if(!inArea(area,x,z)||!inArea(next,x,z))map.delete(g);}
                            area=next;
                        }else if((r?.e==='oa'||r?.e==='od'||r?.e==='oc')&&[r.x,r.z,r.l,r.id].every(Number.isSafeInteger)){
                            const g=`${r.x},${r.z},${r.l},${r.id}`;apply(feedPiles,g,r);apply(viewPiles,g,r);
                        }
                    }
                    seenVersion=groundVersion;
                    const want=new Map<string,number[]>();
                    if(area)for(const row of botGround){
                        if(!inArea(area,row[0]!,row[1]!))continue;
                        const g=row.slice(0,4).join(','),list=want.get(g)??[];list.push(row[4]!);want.set(g,list);
                    }
                    const add:any[]=[];
                    for(const g of new Set([...viewPiles.keys(),...want.keys()])){
                        const feed=feedPiles.get(g)??[],view=viewPiles.get(g)??[];
                        // A pile that the feed itself sends is not added again: each feed pile takes away one row of its count.
                        const ours=[...want.get(g)??[]];
                        for(const n of feed){const i=ours.indexOf(n);if(i>=0)ours.splice(i,1);}
                        const next=[...feed,...ours];
                        if(view.length===next.length&&view.every((n,i)=>n===next[i]))continue;
                        const [x,z,l,id]=g.split(',').map(Number);
                        for(let i=0;i<view.length;i++)add.push({e:'od',x,z,l,id});
                        for(const n of next)add.push({e:'oa',x,z,l,id,n});
                        next.length?viewPiles.set(g,next):viewPiles.delete(g);
                    }
                    if(!add.length)return event;
                    m.w=[...w,...add];
                    return new host.MessageEvent('message',{data:JSON.stringify(m),origin:event.origin});
                };
                const forViewer=(event:any)=>addGround(rename(event));
                if(accessor?.set){let handler:any=null;Object.defineProperty(this,'onmessage',{configurable:true,get:()=>handler,set:(fn:any)=>{handler=fn;accessor.set.call(this,typeof fn==='function'?(event:any)=>{if(!filterLoaded){if(held.length<5000)held.push(()=>fn.call(this,forViewer(event)));return;}fn.call(this,forViewer(event));}:fn);}});}
                const names=new Map<number,string>(),seenChat=new Set<string>();
                // Opponent information (RuneLite opponentinfo): what the followed player faces (fe: an npc nid, or
                // 32768 + a player slot) and that entity's hitpoints, which the feed sends with each hitmark.
                const faces=new Map<number,number>(),npcs=new Map<number,{t?:number;hp?:[number,number]}>(),playerHp=new Map<number,[number,number]>();let publishedOpponent='null';
                const hp=(v:any):[number,number]|undefined=>Array.isArray(v)&&v.length===2&&v.every((n:any)=>Number.isFinite(n))?[v[0],v[1]]:undefined;
                const mask=(value:string)=>{for(const name of hiddenNames)value=value.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'⟦MAIN⟧');return value;};
                this.addEventListener('message',(raw:any)=>{
                    const event=fullRoster(raw);
                    if(typeof event.data!=='string'||event.data.length>2_000_000)return;
                    let message:any;try{message=JSON.parse(event.data);}catch{return;}
                    if(message.t==='roster'&&Array.isArray(message.p)){
                        for(const p of message.p)if(Array.isArray(p)&&typeof p[0]==='number'&&typeof p[1]==='string')names.set(p[0],p[1]);
                        // The page's own data can be minutes old; each roster is the full list of players online now.
                        const sendRoster=()=>host.parent.postMessage({atlasRoster:{players:message.p.filter((p:any)=>Array.isArray(p)&&typeof p[1]==='string'&&[p[2],p[3],p[4],p[5]].every(Number.isFinite)).map((p:any)=>[hiddenHashes.has(fnv(p[1].toLowerCase()))?'⟦MAIN⟧':mask(p[1]),p[2],p[3],p[4],p[5]])}},host.location.origin);
                        if(host.parent!==host&&!failed){if(privacyReady&&renderReady)sendRoster();else{heldRoster=sendRoster;heldRosterAt=Date.now();}}
                    }
                    if(message.t==='tick'&&mainFeed===this)trackDepleted(message);
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
    // Multi-view (the page's Fleet wall). {multi} and {multiOrder} are lists of at most 16 different names, each a player
    // name or the hidden-name mark; {multiDistance} is 16 to 128 tiles; {multiFocus} and the main view are a name or a
    // view number; {multiLayout} holds only the keys below, each in its range; {multiChrome} is true or false. This
    // listener runs before the viewer's own: a message from another sender, or with another value, stops here.
    let multiAsked:string[]=[],multiDown:{x:number;y:number;pane:number}|null=null,multiHover=-1;
    const multiName=(n:any)=>typeof n==='string'&&(n==='⟦MAIN⟧'||/^[A-Za-z0-9_-](?:[A-Za-z0-9_ -]{0,10}[A-Za-z0-9_-])?$/.test(n));
    const validMulti=(list:any)=>Array.isArray(list)&&list.length<=16&&list.every(multiName)&&new Set(list.map((n:string)=>n.toLowerCase())).size===list.length;
    const multiView=(v:any)=>multiName(v)||Number.isInteger(v)&&v>=0&&v<16;
    const multiShares=(v:any)=>Array.isArray(v)&&v.length<=16&&v.every((n:any)=>typeof n==='number'&&n>0&&n<=1);
    const layoutRules:Record<string,(v:any)=>boolean>={rows:multiShares,cols:multiShares,strip:v=>v===0||typeof v==='number'&&v>=0.1&&v<=0.45,mode:v=>['grid','main','focus','columns'].includes(v),main:multiView,gap:v=>Number.isInteger(v)&&v>=0&&v<=24,ratio:v=>typeof v==='number'&&v>=0.5&&v<=0.8,animate:v=>typeof v==='boolean',color:v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)};
    const multiRules:Record<string,(v:any)=>boolean>={multi:validMulti,multiOrder:validMulti,multiDistance:v=>Number.isInteger(v)&&v>=16&&v<=128,multiFocus:multiView,multiChrome:v=>typeof v==='boolean',
        multiLayout:v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>Object.hasOwn(layoutRules,k)&&layoutRules[k]!(v[k]))};
    host.addEventListener('message',(event:any)=>{
        const data=event.data,keys=data&&typeof data==='object'?Object.keys(multiRules).filter(k=>k in data):[];
        if(keys.length){
            const ours=event.origin===host.location.origin&&event.source===host.parent;
            if(!ours||keys.some(k=>!multiRules[k]!(data[k]))){event.stopImmediatePropagation();return;}
            if('multi' in data){multiAsked=data.multi.slice();multiHover=-1;}
            // The viewer puts the listed views first and keeps the others in their order: the view numbers follow.
            if('multiOrder' in data){const left=multiAsked.slice(),first:string[]=[];for(const n of data.multiOrder){const i=left.findIndex(a=>a.toLowerCase()===n.toLowerCase());if(i>=0)first.push(left.splice(i,1)[0]!);}multiAsked=[...first,...left];}
        }
        if(event.origin!==host.location.origin||event.source!==host.parent||!event.data||typeof event.data!=='object')return;
        if('botGround' in event.data){const rows=event.data.botGround;if(Array.isArray(rows)&&rows.length<=1000&&rows.every(groundRow)){botGround=rows.map((r:number[])=>r.slice());groundVersion++;}}
        if('respawnWatch' in event.data){const ids=event.data.respawnWatch;if(Array.isArray(ids)&&ids.length<=64&&ids.every((n:any)=>Number.isSafeInteger(n)&&n>=0&&n<65536)){const next=new Set<number>(ids);if(next.size!==respawnWatch.size||[...next].some(n=>!respawnWatch.has(n))){respawnWatch=next;clearDepleted();}}}
        if(event.data.atlasCompass===true)host.document?.querySelector('.minimap-container .compass')?.click();
        if(event.data.atlasOpenWorldMap===true)host.document?.querySelector('.minimap-container .worldmap-icon')?.click();
        // The viewer writes its URL only when its camera rests. The name in the URL at a page follow is the old one.
        if(typeof event.data.follow==='string'){freeCameraPolls=0;publishedFollow=new host.URL(host.location.href).searchParams.get('follow');pageFollow=event.data.follow.toLowerCase();pageFollowPolls=20;}
        if(event.data.atlasFreeCamera===true){freeCameraPolls=10;pageFollow='';releaseFollow();}
    });
    // The viewer reports a click on a view only to a page that loads it with embed=1. This page loads it with embed=0,
    // so the bridge reports it: the main button pressed and released in one view, within 8 px. A view carries its number
    // in the asked order (data-pane); a view that closes carries none. Views that move can cross: the one drawn last
    // (the highest z-index) is on top. The page gets the name it asked for, and the mark for a hidden name.
    const paneAt=(event:any)=>{
        const panes=[...(host.document?.querySelectorAll?.('.multi-view .multi-pane[data-pane]')??[])];
        if(event.target?.tagName!=='CANVAS'||panes.length!==multiAsked.length)return -1;
        let hit=-1,top=-1;
        for(const p of panes as any[]){
            const r=p.getBoundingClientRect(),i=Number(p.dataset?.pane),z=Number(p.style?.zIndex)||0;
            if(event.clientX>=r.left&&event.clientX<r.right&&event.clientY>=r.top&&event.clientY<r.bottom&&Number.isInteger(i)&&i>=0&&i<multiAsked.length&&z>=top){hit=i;top=z;}
        }
        return hit;
    };
    // The page highlights the view under the pointer: it gets the view number when that changes, and -1 for none.
    const hover=(pane:number)=>{
        if(pane===multiHover)return;multiHover=pane;
        if(privacyReady&&renderReady&&!failed&&host.parent!==host)host.parent.postMessage({viewerMultiHover:pane},host.location.origin);
    };
    host.addEventListener('pointermove',(event:any)=>{if(multiAsked.length)hover(paneAt(event));},true);
    host.addEventListener('pointerout',(event:any)=>{if(multiAsked.length&&!event.relatedTarget)hover(-1);},true);
    if(url.searchParams.get('embed')!=='1'){
        host.addEventListener('pointerdown',(event:any)=>{multiDown=multiAsked.length&&event.button===0?{x:event.clientX,y:event.clientY,pane:paneAt(event)}:null;},true);
        host.addEventListener('pointerup',(event:any)=>{
            const down=multiDown;multiDown=null;
            if(!down||down.pane<0||down.pane!==paneAt(event)||Math.hypot(event.clientX-down.x,event.clientY-down.y)>8)return;
            if(!privacyReady||!renderReady||failed||host.parent===host)return;
            const name=multiAsked[down.pane];
            host.parent.postMessage({viewerMultiPick:hiddenNames.has(name.toLowerCase())?'⟦MAIN⟧':name,index:down.pane},host.location.origin);
        },true);
    }
    // The page owns the account order: [ and ] step through its accounts, not through every online player.
    // While the wall is open its keys go to the page and not to the viewer's camera: arrows and h j k l, Enter, Space,
    // 1 to 9, f, ? and Escape. The \ key opens and closes the wall.
    host.addEventListener('keydown',(event:any)=>{
        const plain=!event.ctrlKey&&!event.altKey&&!event.metaKey&&!/^(?:INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName??'');
        const wallKey=plain&&typeof event.key==='string'&&(event.key==='\\'||multiAsked.length>0&&/^(?:Arrow(?:Left|Right|Up|Down)|[hjklfHJKLF1-9? ]|Enter|Escape)$/.test(event.key));
        if(event.key!=='['&&event.key!==']'&&!wallKey)return;
        event.stopImmediatePropagation();event.preventDefault();
        if(host.parent===host)return;
        if(wallKey)host.parent.postMessage({atlasWallKey:{key:event.key,shift:!!event.shiftKey}},host.location.origin);
        else host.parent.postMessage({atlasStep:event.key===']'?1:-1},host.location.origin);
    },true);
    host.addEventListener('error',()=>fail('The 3D viewer reported an error; use the 2D map.'));
    // A graphics reset leaves a black canvas. The page reloads the viewer after this failure. The event does not bubble.
    host.document?.addEventListener?.('webglcontextlost',()=>fail('The 3D view lost its graphics context.'),true);
    host.addEventListener('unhandledrejection',(event:any)=>{if(event.reason?.name!=='AbortError')fail('The 3D viewer could not finish loading; use the 2D map.');});
    // The viewer publishes its current follow target in its URL. Relay
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
        // The views of a wall are the page's choice: a name that the viewer URL holds then is not a new follow.
        if(multiAsked.length){publishedFollow=follow;return;}
        // The viewer writes its URL late. Until the URL names the page's choice, the old name there is not a new follow.
        if(pageFollowPolls){
            if(follow?.toLowerCase()===pageFollow){pageFollowPolls=0;publishedFollow=follow;return;}
            if(--pageFollowPolls)return;
        }
        if(!follow||follow===publishedFollow||!/^[A-Za-z0-9_ -]{1,12}$/.test(follow))return;
        publishedFollow=follow;
        // The page's own choice, written late, is not news to the page.
        if(follow.toLowerCase()===pageFollow)return;
        host.parent.postMessage({atlasFollow:hiddenNames.has(follow.toLowerCase())?'⟦MAIN⟧':follow},host.location.origin);
    },500);
}

export const viewerBridgeSource=()=>`(${installViewerBridge.toString()})(window);`;
