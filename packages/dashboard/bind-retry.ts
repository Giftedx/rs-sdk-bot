// A reload starts the successor while the old process still closes its socket, so the first bind can fail with
// EADDRINUSE. The successor asks again every waitMs for tries times; any other error, or the last failure, is thrown.
export async function bindRetry<T>(start:()=>T,opts:{tries?:number;waitMs?:number;sleep?:(ms:number)=>Promise<unknown>;log?:(line:string)=>void}={}):Promise<T>{
 const tries=opts.tries??40,waitMs=opts.waitMs??500,sleep=opts.sleep??((ms:number)=>new Promise(r=>setTimeout(r,ms)));
 for(let attempt=1;;attempt++){
  try{return start();}
  catch(error){
   const busy=(error as NodeJS.ErrnoException)?.code==='EADDRINUSE';
   if(!busy||attempt>=tries)throw error;
   opts.log?.(`dashboard: port busy, bind attempt ${attempt} of ${tries}`);
   await sleep(waitMs);
  }
 }
}
