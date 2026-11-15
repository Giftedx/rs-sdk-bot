import {test,expect} from 'bun:test';import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';import {inProcessSdkConfig,startInProcessSession} from '../src/inprocess';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listAttempts} from '../src/session-lifecycle';

test('in-process market HTTP reads use the actual remote game origin without credential query fields',async()=>{
 const old=globalThis.fetch,urls:URL[]=[];globalThis.fetch=(async(input:RequestInfo|URL)=>{const url=new URL(String(input));urls.push(url);const body=url.pathname.endsWith('/status')?{enabled:true}:url.pathname.endsWith('/items')?{items:[]}:url.pathname.endsWith('/history')?{buckets:[]}:{id:1331};return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
 try{const sdk=new BotSDK(inProcessSdkConfig({name:'fixture',password:'not-a-real-secret',server:'rs-sdk-demo.fly.dev'}));await sdk.getGEAvailability();await sdk.getMarketItems('adamant scimitar');await sdk.getMarketItem(1331);await sdk.getMarketHistory(1331);expect(urls).toHaveLength(4);for(const url of urls){expect(url.origin).toBe('https://rs-sdk.maxbittker.com');expect(url.pathname.startsWith('/api/market/')).toBe(true);expect(url.searchParams.has('bot')).toBe(false);expect(url.searchParams.has('password')).toBe(false);expect(url.href.includes('not-a-real-secret')).toBe(false);}}
 finally{globalThis.fetch=old;}
});

test('practice uses its explicit HTTP port and every in-process SDK stays detached from browser/reconnect loops',()=>{
 for(const server of ['localhost:8888','localhost:9999','127.0.0.1:9876','[::1]:8888']){const c=inProcessSdkConfig({name:'fixture',password:'x',server});expect(c.browserLaunchUrl).toBe('http://'+server+'/bot');expect(c.autoLaunchBrowser).toBe(false);expect(c.autoReconnect).toBe(false);}
 expect(inProcessSdkConfig({name:'fixture',password:'x'}).browserLaunchUrl).toBe('http://localhost:8888/bot');
 for(const server of ['rs-sdk.maxbittker.com','custom.example:7443','rs-sdk-demo.fly.dev:7443','rs-sdk-demo.fly.dev.evil.example'])
  expect(inProcessSdkConfig({name:'fixture',password:'x',server}).browserLaunchUrl).toBe('https://'+server+'/bot');
});

test('bootstrap dials the canonical demo while producer identity and admission stay on the logical server',async()=>{
 const root=mkdtempSync(join(tmpdir(),'canonical-dial-'));
 try{
  for(const server of ['rs-sdk-demo.fly.dev','rs-sdk.maxbittker.com','localhost:8888','custom.example:7443','rs-sdk-demo.fly.dev:7443']){
   const opts={name:'fixture',password:'fixture-secret',server},sdk=new BotSDK(inProcessSdkConfig(opts)),calls:string[]=[];
   const deps={sdk,Actions:class {} as any,cacheDir:root,lifecycle:{root},recordOwned:()=>{},
    beforeConnect:()=>{calls.push('admit');},async startSession(o:any){calls.push(o.host);throw Error('fixture stops before network');}};
   await expect(startInProcessSession(opts,deps)).rejects.toThrow('fixture stops before network');
   expect(calls).toEqual(['admit',server==='rs-sdk-demo.fly.dev'?'rs-sdk.maxbittker.com':server]);
   expect(listAttempts('fixture',server,{root})[0]?.receipt).toMatchObject({server,account:'fixture'});
  }
  const blocked={name:'blocked',password:'fixture-secret',server:'rs-sdk-demo.fly.dev'};
  let connected=false;
  await expect(startInProcessSession(blocked,{sdk:new BotSDK(inProcessSdkConfig(blocked)),Actions:class {} as any,cacheDir:root,lifecycle:{root},
   beforeConnect:()=>{throw Error('admission refused');},async startSession(){connected=true;throw Error('must not dial');}})).rejects.toThrow('admission refused');
  expect(connected).toBe(false);
  expect(listAttempts('blocked',blocked.server,{root})).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
