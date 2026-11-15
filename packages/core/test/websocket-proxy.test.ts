import {expect,test} from 'bun:test';
import {gameSocketOptions,proxiesGameSockets} from '../src/websocket-proxy';
import * as routing from '../src/websocket-proxy';

test('game dial addresses alias only the exact demo at its implicit secure port',()=>{
 const dial=(routing as unknown as {gameDialAddress:(address:string)=>string}).gameDialAddress;
 expect(typeof dial).toBe('function');
 expect(dial('rs-sdk-demo.fly.dev')).toBe('rs-sdk.maxbittker.com');
 expect(dial('https://rs-sdk-demo.fly.dev/api/market/items?q=a%20b#result')).toBe('https://rs-sdk.maxbittker.com/api/market/items?q=a%20b#result');
 expect(dial('wss://rs-sdk-demo.fly.dev/worldfeed?roster=1#feed')).toBe('wss://rs-sdk.maxbittker.com/worldfeed?roster=1#feed');
 for(const address of ['localhost:8888','ws://localhost:8888/worldfeed','http://rs-sdk-demo.fly.dev/crc','ws://rs-sdk-demo.fly.dev/worldfeed',
  'https://rs-sdk-demo.fly.dev:443/crc','wss://rs-sdk-demo.fly.dev:443/worldfeed','rs-sdk-demo.fly.dev:7443',
  'https://rs-sdk-demo.fly.dev.evil.example/crc','https://other.example/rs-sdk-demo.fly.dev','https://rs-sdk.maxbittker.com/crc'])
  expect(dial(address)).toBe(address);
});
test('every non-local side with a proxy routes game sockets through it; the local PC and a proxyless side do not',()=>{
 expect(proxiesGameSockets('cloud','http://proxy:8080')).toBe(true);
 expect(proxiesGameSockets('claude-cloud','http://proxy:8080')).toBe(true);
 expect(proxiesGameSockets('local','http://proxy:8080')).toBe(false);
 expect(proxiesGameSockets(undefined,'http://proxy:8080')).toBe(false);
 expect(proxiesGameSockets('claude-cloud',undefined)).toBe(false);
});
test('game sockets retain the binary protocol and use the approved cloud proxy',()=>{
 expect(gameSocketOptions('wss://rs-sdk-demo.fly.dev','binary','http://proxy:8080')).toEqual({protocols:['binary'],proxy:'http://proxy:8080'});
 expect(gameSocketOptions('wss://rs-sdk-demo.fly.dev:7443',['binary'],'http://proxy:8080').proxy).toBe('http://proxy:8080');
 expect(gameSocketOptions('wss://rs-sdk.maxbittker.com','binary','http://proxy:8080')).toEqual({protocols:['binary'],proxy:'http://proxy:8080'});
});
test('loopback and unrelated sockets retain their routing; explicit socket options are preserved',()=>{
 expect(gameSocketOptions('ws://localhost:8888','binary','http://proxy:8080')).toEqual({protocols:['binary']});
 expect(gameSocketOptions('wss://other.example','binary','http://proxy:8080').proxy).toBeUndefined();
 expect(gameSocketOptions('wss://rs-sdk.maxbittker.com.evil.example','binary','http://proxy:8080').proxy).toBeUndefined();
 expect(gameSocketOptions('ws://rs-sdk.maxbittker.com','binary','http://proxy:8080').proxy).toBeUndefined();
 expect(gameSocketOptions('wss://rs-sdk-demo.fly.dev',{protocols:['binary'],proxy:'http://configured:8080'},'http://proxy:8080').proxy).toBe('http://configured:8080');
 expect(gameSocketOptions('wss://rs-sdk.maxbittker.com',{protocols:['binary'],proxy:'http://configured:8080'},'http://proxy:8080').proxy).toBe('http://configured:8080');
});
