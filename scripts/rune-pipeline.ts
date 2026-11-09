type Publications={tick:()=>number;onTick:(cb:()=>void)=>()=>void};
export type CraftBoundary={tick:()=>number|undefined;dispose:()=>void};

export function runeHandoffPipeline(value=process.env.RUNE_HANDOFF_PIPELINE??'0',craftAfter='inventory'){
 if(value!=='0'&&value!=='1')throw Error('RUNE_HANDOFF_PIPELINE must be0 or1');
 if(value==='1'&&craftAfter!=='trade-message')throw Error('the handoff pipeline requires trade-message crafting');
 return value==='1';
}
export function observeCraftCompletion(s:Publications,complete:()=>boolean,stop:()=>boolean):CraftBoundary{
 let anchor:number|undefined,scheduled=false,disposed=false,off=()=>{};
 const dispose=()=>{if(disposed)return;disposed=true;off();};
 off=s.onTick(()=>{
  if(disposed||scheduled)return;
  if(stop()){dispose();return;}
  if(!complete())return;
  scheduled=true;
  // The shim publishes all catch-up ticks synchronously after a packet drain.
  // Anchor after that loop, never at its first copy of the completed snapshot.
  queueMicrotask(()=>{if(disposed)return;if(!stop()&&complete())anchor=s.tick();dispose();});
 });
 if(disposed)off();
 return {tick:()=>anchor,dispose};
}
export function pipelineOpeningReady(s:Pick<Publications,'tick'>,boundary:CraftBoundary){
 const at=boundary.tick();
 // Input decoding precedes delay clearing: three publications can still reject OPPLAYER.
 return at!==undefined&&s.tick()-at>=4;
}
