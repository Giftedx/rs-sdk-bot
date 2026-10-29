import {test,expect} from 'bun:test';import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';import {inProcessSdkConfig} from '../src/inprocess';

test('in-process market HTTP reads use the actual remote game origin without credential query fields',async()=>{
 const old=globalThis.fetch,urls:URL[]=[];globalThis.fetch=(async(input:RequestInfo|URL)=>{const url=new URL(String(input));urls.push(url);const body=url.pathname.endsWith('/status')?{enabled:true}:url.pathname.endsWith('/items')?{items:[]}:url.pathname.endsWith('/history')?{buckets:[]}:{id:1331};return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
 try{const sdk=new BotSDK(inProcessSdkConfig({name:'fixture',password:'not-a-real-secret',server:'rs-sdk-demo.fly.dev'}));await sdk.getGEAvailability();await sdk.getMarketItems('adamant scimitar');await sdk.getMarketItem(1331);await sdk.getMarketHistory(1331);expect(urls).toHaveLength(4);for(const url of urls){expect(url.origin).toBe('https://rs-sdk-demo.fly.dev');expect(url.pathname.startsWith('/api/market/')).toBe(true);expect(url.searchParams.has('bot')).toBe(false);expect(url.searchParams.has('password')).toBe(false);expect(url.href.includes('not-a-real-secret')).toBe(false);}}
 finally{globalThis.fetch=old;}
});

test('practice uses its explicit HTTP port and every in-process SDK stays detached from browser/reconnect loops',()=>{
 for(const server of ['localhost:8888','localhost:9999','127.0.0.1:9876','[::1]:8888']){const c=inProcessSdkConfig({name:'fixture',password:'x',server});expect(c.browserLaunchUrl).toBe('http://'+server+'/bot');expect(c.autoLaunchBrowser).toBe(false);expect(c.autoReconnect).toBe(false);}
 expect(inProcessSdkConfig({name:'fixture',password:'x'}).browserLaunchUrl).toBe('http://localhost:8888/bot');
});
