import {expect,test} from 'bun:test';
import {coinProofEndpoints,coinRegistrationArgs,registerCoinProofAccount} from './coin-courier-proof';
const endpoints=coinProofEndpoints({engine:21000,gateway:21001,management:21002,tcp:21003},'coin-auth-test');
const profile=`SERVER=${endpoints.server}\nGATEWAY_URL=${endpoints.gateway}\nPASSWORD=fixture-only\n`;
function fixture(){
 const events:string[]=[],session={}as any;
 const deps={readEnv:()=>profile,connect:async(options:any)=>{events.push('connect');expect(options).toEqual({name:'Fixture',password:'fixture-only',server:endpoints.server});return session;},
  ready:async(s:any)=>{expect(s).toBe(session);events.push('ready');},wait:async(s:any,ticks:number)=>{expect(s).toBe(session);expect(ticks).toBe(3);events.push('wait');},
  settle:async(sessions:any[],ok:boolean)=>{expect(sessions).toEqual([session]);events.push('settle:'+ok);return ok;}};
 return{deps,events};
}
test('owned practice registration uses an auth-only connection and confirmed settlement',async()=>{
 const {deps,events}=fixture();await registerCoinProofAccount('Fixture',endpoints,deps);
 expect(events).toEqual(['connect','ready','wait','settle:true']);
 const args=coinRegistrationArgs('Fixture',endpoints);expect(args[0]).toBe('--eval');expect(args[1]).toContain('registerCoinProofAccount(');expect(args[1]).not.toContain('openBot(');
});
test('registration rejects changed endpoints or profile before connecting',async()=>{
 for(const changed of [profile.replace(endpoints.server,'rs-sdk-demo.fly.dev'),profile+'SERVER=localhost:8888\n',profile.replace('PASSWORD=fixture-only','PASSWORD=')]){
  const {deps,events}=fixture();deps.readEnv=()=>changed;
  await expect(registerCoinProofAccount('Fixture',endpoints,deps)).rejects.toThrow();expect(events).toEqual([]);
 }
 const {deps,events}=fixture();await expect(registerCoinProofAccount('Fixture',{...endpoints,server:'rs-sdk-demo.fly.dev'},deps)).rejects.toThrow();expect(events).toEqual([]);
});
test('registration wait failure still settles its exact connection and failed logout rejects',async()=>{
 const {deps,events}=fixture();deps.wait=async()=>{throw Error('tick failure');};
 await expect(registerCoinProofAccount('Fixture',endpoints,deps)).rejects.toThrow('tick failure');expect(events).toEqual(['connect','ready','settle:false']);
 const second=fixture();second.deps.settle=async()=>false;
 await expect(registerCoinProofAccount('Fixture',endpoints,second.deps)).rejects.toThrow('practice registration logout failed');
});
