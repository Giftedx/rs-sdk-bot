// Native LiteClient bridge for the missing SDK spell-on-location action.
// Mirrors lite/actions.ts useItemOnLoc routing and Client.ts TGT_LOC.
// OpLocTDecoder.ts reads x,z,loc,spellCom as four unsigned shorts.
export function spellOnNativeLoc(client:unknown,x:number,z:number,locId:number,spellComponent:number){
 const c=client as any;
 if(![x,z,locId,spellComponent].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535))throw Error('invalid spell location');
 if(!c||typeof c.toSceneTile!=='function'||typeof c.routeToLoc!=='function'||typeof c.locSceneInfo!=='function'||typeof c.writeOpcode!=='function'||typeof c.out?.p2!=='function')throw Error('spell-on-location requires native LiteClient');
 if(!c.isInGame()||!c.localPlayer)throw Error('spell-on-location not in game');
 const dest=c.toSceneTile(x,z);
 if(!dest||!c.locSceneInfo(dest.x,dest.z,locId))throw Error('spell-on-location target absent from scene');
 const routed=c.routeToLoc(dest.x,dest.z,locId);
 // ClientProt.OPLOCT = 218 in the pinned native protocol.
 c.writeOpcode(218);c.out.p2(x);c.out.p2(z);c.out.p2(locId);c.out.p2(spellComponent);
 return{success:true,routed};
}
// Per-session adapter keeps the normal ownership guard and command recorder.
// Never install globally; the session owner restores the exact method in finally.
export function installSpellLocBridge(client:unknown){
 const c=client as any;
 if(!c||typeof c.executeBotAction!=='function')throw Error('spell-on-location native executor unavailable');
 const original=c.executeBotAction;
 const bridge=function(this:unknown,action:any){
  return action?.type==='spellOnLoc'?spellOnNativeLoc(c,action.x,action.z,action.locId,action.spellComponent):original.call(c,action);
 };
 c.executeBotAction=bridge;
 return()=>{if(c.executeBotAction===bridge)c.executeBotAction=original;};
}
