// Bun WebSockets require an explicit proxy option; fetch already uses the
// inherited environment proxy. Keep game sockets on that same approved route.
export function gameSocketOptions(url:string|URL,protocols:string|string[]|Bun.WebSocketOptions|undefined,proxy:string):Bun.WebSocketOptions{
    const options:Bun.WebSocketOptions=typeof protocols==='string'?{protocols:[protocols]}:Array.isArray(protocols)?{protocols}:{...protocols};
    const target=new URL(url);
    if(target.protocol==='wss:'&&target.hostname==='rs-sdk-demo.fly.dev')options.proxy??=proxy;
    return options;
}
let installed=false;
export function installGameWebSocketProxy():void{
    const proxy=process.env.HTTPS_PROXY??process.env.https_proxy;
    if(installed||process.env.FLEET_SIDE!=='cloud'||!proxy)return;
    const selectedProxy=proxy;
    const Native=globalThis.WebSocket as typeof WebSocket & {new(url:string|URL,options:Bun.WebSocketOptions):WebSocket};
    globalThis.WebSocket=class extends Native{
        constructor(url:string|URL,protocols?:string|string[]|Bun.WebSocketOptions){super(url,gameSocketOptions(url,protocols,selectedProxy));}
    };
    installed=true;
}
