// Source decision: retained uZIWUW ownership failure + vendor/rs-sdk/server/engine/src/server/login/
// {LoginServer,LoginClient}.ts and src/3rdparty/ws-sync/ws-sync.js -> installed core recovery CLI proof:
// adapt request attribution, not admission. Acceptance: retained-sequence regressions and all five native gates.
// LoginServer sends response 0 for BOTH login and logout on a persistent world/login connection.
// Record only protocol identity, never messages or save/secret fields.
// Keep this function self-contained: its JS is used as the practice LoginServer preload.
export function installAuthObserver(Server:any,write:(line:string)=>void=(line)=>console.log(line),now:()=>number=Date.now){
 const original=Server.prototype.emit,seen=new WeakSet<object>();let connections=0,count=0,overflow=false,healthy=true,sealed=false;
 const log=(kind:string,row:object)=>{
  if(sealed){healthy=false;kind='AUTH_ERROR';row={code:'after-seal'};}
  try{if(count++<8192||kind==='AUTH_SEALED')write(kind+' '+JSON.stringify({at:now(),...row}));else if(!overflow){overflow=true;healthy=false;write('AUTH_ERROR '+JSON.stringify({at:now(),code:'record-limit'}));}}catch{healthy=false;/* original protocol still runs; final seal refuses */}
 };
 const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 Server.prototype.emit=function(event:unknown,...args:any[]){
  if(event==='connection'&&args[0]&&!seen.has(args[0])){
   const socket=args[0];seen.add(socket);const connection=++connections;
   log('AUTH_CONNECTION',{connection});
   try{
    const emit=socket.emit,send=socket.send;
    if(typeof emit!=='function'||typeof send!=='function')throw Error();
    socket.emit=function(event:unknown,...values:any[]){
     if(event==='message')try{
      const m=JSON.parse(String(values[0]));
      if(!m||typeof m!=='object')throw Error();
      if(m.type==='player_login'||m.type==='player_logout'||m.replyTo!==undefined){
       if(!id(m.replyTo)||!['player_login','player_logout'].includes(m.type)||typeof m.username!=='string'||!(/^[a-zA-Z0-9]{1,12}$/).test(m.username))throw Error();
       log('AUTH_REQUEST',{connection,replyTo:m.replyTo,type:m.type,account:m.username.toLowerCase()});
      }
     }catch{log('AUTH_ERROR',{connection,code:'request-shape'});}
     return Reflect.apply(emit,this,[event,...values]);
    };
    socket.send=function(...values:any[]){
     try{const r=JSON.parse(String(values[0]));if(!r||!id(r.replyTo)||!Number.isInteger(r.response))throw Error();
      log('AUTH_REPLY',{connection,replyTo:r.replyTo,response:r.response});
     }catch{log('AUTH_ERROR',{connection,code:'reply-shape'});}
     return Reflect.apply(send,this,values);
    };
   }catch{log('AUTH_ERROR',{connection,code:'install'});}
  }
  return Reflect.apply(original,this,[event,...args]);
 };
 log('AUTH_READY',{schema:1});
 return {seal(){log('AUTH_SEALED',{records:count,healthy});sealed=true;}};
}

// Read-only world dispatch observer for the modal case. Source: pinned NetworkPlayer.ts decodeIn/read (decoded
// opcodes per tick), IfButtonHandler.ts (component checks, protected executeScript) and Player.ts runScript
// (-1 = no protected access). It records component and player state, never message payloads or save fields.
// Keep this function self-contained: its JS is used as the practice world preload.
// While a player's main modal is open it also records, with wall-clock times: each websocket message the world
// buffers for that player (pinned web/websocket.ts message -> ClientSocket.buffer; length only) and each tick's
// decode read (available bytes). This separates a missing client write, a transport delay and a world scheduling delay.
export function installLocObserver(m:{OpLocHandler:any;LocType:any;World:any},write:(line:string)=>void){
 const handle=m.OpLocHandler.prototype.handle;
 m.OpLocHandler.prototype.handle=function(this:any,message:any,player:any){
  let evidence:unknown=null;
  try{const loc=m.World.getLoc(message.x,message.z,player.level,message.loc),type=loc?m.LocType.get(loc.type):null;evidence={account:player.username,packet:{x:message.x,z:message.z,loc:message.loc,op:message.op},player:{x:player.x,z:player.z,level:player.level,originX:player.originX,originZ:player.originZ,delayed:player.delayed},loc:loc?{type:loc.type,x:loc.x,z:loc.z}:null,options:type?.op??null};}catch{/* observation cannot change dispatch */}
  let result:unknown;try{result=Reflect.apply(handle,this,[message,player]);return result;}finally{try{write('LOC_HANDLE '+JSON.stringify({at:Date.now(),tick:m.World.currentTick,evidence,result}));}catch{/* observation cannot change dispatch */}}
 };
}

export function installButtonObserver(m:{NetworkPlayer:any;IfButtonHandler:any;IdkSaveDesignHandler:any;Component:any;Repository:any;World:any;WSClientSocket?:any},write:(line:string)=>void=(line)=>console.log(line),now:()=>number=Date.now){
 // IDK_SAVEDESIGN, IF_BUTTON, CLOSE_MODAL
 const watch=[27,86,93],live=new Set<string>();let count=0,wireCount=0,decoding:{packets:number[]}|null=null,button:{runs:object[]}|null=null;
 const int=(v:unknown)=>Number.isSafeInteger(v)?v as number:null,who=(p:any)=>typeof p?.username==='string'?p.username.toLowerCase():null;
 const read=(f:()=>unknown)=>{try{return f();}catch{return null;}};
 const row=(kind:string,value:object)=>kind+' '+JSON.stringify({tick:read(()=>int(m.World.currentTick)),at:read(()=>int(now())),...value});
 const log=(kind:string,value:object)=>{try{if(count++<4096)write(row(kind,value));}catch{/* observation cannot change dispatch */}};
 // A separate budget, so per-tick modal rows can never displace dispatch records.
 const wire=(kind:string,value:object)=>{try{if(wireCount++<8192)write(row(kind,value));}catch{/* observation cannot change transport */}};
 const S=m.WSClientSocket?.prototype,buffer=S?.buffer;
 if(S&&typeof buffer==='function')S.buffer=function(this:any,...args:any[]){
  const player=read(()=>this.player) as any,open=!!player&&int(player.modalMain)!==null&&int(player.modalMain)!==-1;
  const before=open?read(()=>int(this.available)):null;
  try{return Reflect.apply(buffer,this,args);}
  finally{if(open)wire('BUTTON_WIRE',{account:who(player),length:read(()=>int(args[0]?.length)),before,after:read(()=>int(this.available)),state:read(()=>int(this.state))});}
 };
 const P=m.NetworkPlayer.prototype,decodeIn=P.decodeIn,runScript=P.runScript,getDecoder=m.Repository.getDecoder;
 const ifHandle=m.IfButtonHandler.prototype.handle,idkHandle=m.IdkSaveDesignHandler.prototype.handle;
 P.decodeIn=function(this:any,...args:any[]){
  const before=read(()=>int(this.client?.available)),prev=decoding,own={packets:[] as number[]};decoding=own;
  try{return Reflect.apply(decodeIn,this,args);}
  finally{
   decoding=prev;
   const account=who(this);
   if(account&&!live.has(account)){live.add(account);log('BUTTON_LIVE',{account});}
   if(own.packets.some(o=>watch.includes(o))||int(this.modalMain)!==-1&&!!before)log('BUTTON_DECODE',{account,before,after:read(()=>int(this.client?.available)),packets:own.packets.slice(0,32),
    modalMain:int(this.modalMain),limits:[int(this.userLimit),int(this.clientLimit),int(this.restrictedLimit)]});
   else if(account&&int(this.modalMain)!==null&&int(this.modalMain)!==-1)wire('BUTTON_POLL',{account,before,modalMain:int(this.modalMain)});
  }
 };
 m.Repository.getDecoder=function(this:any,...args:any[]){
  if(decoding)read(()=>decoding!.packets.push(int(args[0]?.id)??-1));
  return Reflect.apply(getDecoder,this,args);
 };
 P.runScript=function(this:any,...args:any[]){
  const pre=button?{protect:this.protect===true,delayed:this.delayed===true}:null,state=Reflect.apply(runScript,this,args);
  if(button&&button.runs.length<4)button.runs.push({script:read(()=>typeof args[0]?.script?.name==='string'?args[0].script.name:null),protectRequested:args[1]===true,force:args[2]===true,...pre,state:int(state)});
  return state;
 };
 m.IfButtonHandler.prototype.handle=function(this:any,message:any,player:any,...rest:any[]){
  const com:any=read(()=>m.Component.get(message?.com)),root:any=com?read(()=>m.Component.get(com.rootLayer)):null;
  const row={account:who(player),com:int(message?.com),defined:!!com,buttonType:int(com?.buttonType),rootLayer:int(com?.rootLayer),rootOverlay:typeof root?.overlay==='boolean'?root.overlay:null,
   visible:com?read(()=>player.isComponentVisible(com)===true):null,modalMain:int(player?.modalMain),modalState:int(player?.modalState),protect:player?.protect===true,delayed:player?.delayed===true,
   busy:read(()=>player.busy()===true),resumeButton:read(()=>player.resumeButtons.includes(message.com)),activeScript:!!player?.activeScript,allowDesign:player?.allowDesign===true};
  const prev=button,own={runs:[] as object[]};button=own;let result:unknown='threw';
  try{result=Reflect.apply(ifHandle,this,[message,player,...rest]);return result;}
  finally{button=prev;log('BUTTON_HANDLE',{...row,result:typeof result==='boolean'?result:'threw',runs:own.runs,modalMainAfter:int(player?.modalMain),modalStateAfter:int(player?.modalState)});}
 };
 m.IdkSaveDesignHandler.prototype.handle=function(this:any,message:any,player:any,...rest:any[]){
  const allowDesign=player?.allowDesign===true;let result:unknown='threw';
  try{result=Reflect.apply(idkHandle,this,[message,player,...rest]);return result;}
  finally{log('BUTTON_DESIGN',{account:who(player),allowDesign,gender:int(message?.gender),result:typeof result==='boolean'?result:'threw',modalMain:int(player?.modalMain)});}
 };
 log('BUTTON_READY',{schema:1,wire:typeof buffer==='function',cwd:read(()=>process.cwd()),execPath:read(()=>process.execPath)});
}

// The records for one account, kept with the case evidence. Malformed lines are kept as a count, never copied.
export function buttonTraceFor(log:string,account:string){
 const a=account.toLowerCase(),rows:object[]=[];let malformed=0,ready=false,runtime:object|null=null;
 for(const line of log.split(/\r?\n/)){
  if(!line.startsWith('BUTTON_'))continue;
  const space=line.indexOf(' '),kind=line.slice(0,space);
  try{const r=JSON.parse(line.slice(space+1));if(kind==='BUTTON_READY'){ready=true;runtime={wire:r?.wire===true,cwd:typeof r?.cwd==='string'?r.cwd:null,execPath:typeof r?.execPath==='string'?r.execPath:null};}
   else if(r?.account===a)rows.push({kind,...r});}catch{malformed++;}
 }
 return {ready,malformed,runtime,rows};
}
