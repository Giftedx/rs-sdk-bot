// Bun WebSockets require an explicit proxy option; fetch already uses the
// inherited environment proxy. Keep game sockets on that same approved route.
export function gameSocketOptions(url:string|URL,protocols:string|string[]|Bun.WebSocketOptions|undefined,proxy:string):Bun.WebSocketOptions{
    const options:Bun.WebSocketOptions=typeof protocols==='string'?{protocols:[protocols]}:Array.isArray(protocols)?{protocols}:{...protocols};
    const target=new URL(url);
    if(target.protocol==='wss:'&&target.hostname==='rs-sdk-demo.fly.dev')options.proxy??=proxy;
    return options;
}
// Every cloud side (cloud, claude-cloud, any other non-local FLEET_SIDE) reaches the game host through its environment
// proxy; the local PC has no proxy and keeps native sockets.
export function proxiesGameSockets(side:string|undefined,proxy:string|undefined):boolean{
    return !!proxy&&!!side&&side!=='local';
}
let installed=false;
export function installGameWebSocketProxy():void{
    const proxy=process.env.HTTPS_PROXY??process.env.https_proxy;
    if(installed||!proxiesGameSockets(process.env.FLEET_SIDE,proxy))return;
    const selectedProxy=proxy!;
    const Native=globalThis.WebSocket as typeof WebSocket & {new(url:string|URL,options:Bun.WebSocketOptions):WebSocket};
    globalThis.WebSocket=class extends Native{
        constructor(url:string|URL,protocols?:string|string[]|Bun.WebSocketOptions){super(url,gameSocketOptions(url,protocols,selectedProxy));}
    };
    installed=true;
}
