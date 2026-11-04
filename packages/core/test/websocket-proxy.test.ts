import {expect,test} from 'bun:test';
import {gameSocketOptions,proxiesGameSockets} from '../src/websocket-proxy';
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
});
test('loopback and unrelated sockets retain their routing; explicit socket options are preserved',()=>{
 expect(gameSocketOptions('ws://localhost:8888','binary','http://proxy:8080')).toEqual({protocols:['binary']});
 expect(gameSocketOptions('wss://other.example','binary','http://proxy:8080').proxy).toBeUndefined();
 expect(gameSocketOptions('wss://rs-sdk-demo.fly.dev',{protocols:['binary'],proxy:'http://configured:8080'},'http://proxy:8080').proxy).toBe('http://configured:8080');
});
