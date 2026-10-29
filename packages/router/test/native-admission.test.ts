import{test,expect}from'bun:test';
import{withNativeStartup,nativeDeferralEvidence,NATIVE_STARTUP_GB,SOURCE_STARTUP_GB}from'../src/delivery-cli';

function fixture(){let now=0,free=11,stopped=false,starts=0;const observations:any[]=[];
 const deps={now:()=>now,freeGB:()=>free,stopped:()=>stopped,sleep:async(ms:number)=>{now+=ms;},progress:(v:any):void=>{observations.push(v);}};
 return{deps,observations,start:async()=>++starts,starts:()=>starts,setFree:(v:number)=>{free=v;},stop:()=>{stopped=true;}};
}
test('source reserve differs from the unchanged native startup threshold',()=>{
 expect(SOURCE_STARTUP_GB).toBe(11);expect(NATIVE_STARTUP_GB).toBe(12);
});
test('the actual delivery admission wrapper never calls its child starter below12GiB',async()=>{
 const f=fixture();f.deps.sleep=async()=>{expect(f.starts()).toBe(0);f.setFree(12);};
 expect(await withNativeStartup(f.start,f.deps,2000)).toBe(1);expect(f.starts()).toBe(1);
 expect(f.observations.map(v=>v.state)).toEqual(['waiting-native-headroom','native-ready']);
});
test('a stop while waiting refuses before child creation even when RAM becomes ready',async()=>{
 const f=fixture();f.deps.sleep=async()=>{f.stop();f.setFree(13);};
 await expect(withNativeStartup(f.start,f.deps,2000)).rejects.toThrow('owner stopped');expect(f.starts()).toBe(0);
});
test('bounded headroom wait and invalid readings never create a native child',async()=>{
 const f=fixture();await expect(withNativeStartup(f.start,f.deps,2000)).rejects.toThrow('startup headroom');expect(f.starts()).toBe(0);
 for(const value of [NaN,Infinity,-1]){const x=fixture();x.setFree(value);await expect(withNativeStartup(x.start,x.deps,2000)).rejects.toThrow('memory observation');expect(x.starts()).toBe(0);}
});
test('a stop or RAM loss during admission recording is checked again before starting',async()=>{
 const stopped=fixture();stopped.setFree(12);stopped.deps.progress=()=>stopped.stop();
 await expect(withNativeStartup(stopped.start,stopped.deps,2000)).rejects.toThrow('owner stopped');expect(stopped.starts()).toBe(0);
 const low=fixture();low.setFree(12);low.deps.progress=()=>low.setFree(11);
 await expect(withNativeStartup(low.start,low.deps,2000)).rejects.toThrow('startup headroom');expect(low.starts()).toBe(0);
});
test('the real admission timeout produces host-deferral report fields; other errors never do',async()=>{
 const f=fixture();let reason='';try{await withNativeStartup(f.start,f.deps,1000);}catch(error){reason=String(error);}
 expect(nativeDeferralEvidence(reason)).toEqual({hostDeferred:true});expect(f.starts()).toBe(0);
 for(const other of ['check failed','Error: native admission owner stopped; no child started','child stdout HOST_DEFERRED_NATIVE_HEADROOM: text'])expect(nativeDeferralEvidence(other)).toEqual({});
});
