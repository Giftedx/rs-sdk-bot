import {exitRuneTower} from './rune-mysteries-route';

// --rune-carriers defaults to fresh kits plus the supplier's opening reserve.
// RUNE_STAGE_PURPOSE=existing-cohort requires only the finite receiver shortfalls.
export function runeStageRequirement(purpose:string|undefined,shortfalls:readonly {essence:number;talismans:number}[]){
 if(purpose!==undefined&&purpose!=='fresh'&&purpose!=='existing-cohort')throw Error('RUNE_STAGE_PURPOSE must be fresh or existing-cohort');
 const fresh=purpose!=='existing-cohort';
 return {essence:(fresh?432:0)+shortfalls.reduce((n,s)=>n+s.essence,0),talismans:(fresh?2:0)+shortfalls.reduce((n,s)=>n+s.talismans,0),airTalismans:fresh?1:0};
}

export async function exitRuneStageBasement(io:{
 position:()=>{worldX:number;worldZ:number;level:number};
 openDoor:(label:string,x:number,z:number)=>Promise<void>;
 dash:(label:string,x:number,z:number,tol:number)=>Promise<void>;
 climb:()=>Promise<void>;
 waitForLanding:()=>Promise<boolean>;
}){
 const p=io.position();
 if(p.worldZ<9000)return;
 if(p.level!==0||p.worldX<3100||p.worldX>3120||p.worldZ<9550||p.worldZ>9580)throw Error('Rune staging basement entry unsupported');
 // knowledge/doors.json and maps/m48_149.jm2 name both local doors.
 if(p.worldX>=3111&&p.worldZ<=9559){
  await io.openDoor('skull room exit',3111,9559);
  await io.dash('skull room corridor',3110,9559,0);
 }
 await io.dash('basement door approach',3109,9570,0);
 await io.openDoor('basement door exit',3108,9570);
 await io.dash('upward ladder approach',3104,9576,0);
 await io.climb();
 const landed=io.position();
 if(landed.worldX!==3105||landed.worldZ!==3162||landed.level!==0)throw Error('Rune staging upward ladder landing unobserved');
 await exitRuneTower(io,'Rune staging tower exit');
}

export function runeStageRoster(args:readonly string[]){
 const flag=args.at(-1),mode=flag==='--rune-carriers'?'carriers':flag==='--rune-opening'?'opening':null,names=args.slice(0,-1);
 if(!mode||names.length<(mode==='carriers'?2:1)||names.length>(mode==='carriers'?5:1)||names.some(n=>!/^[A-Za-z0-9]{1,12}$/.test(n)||/^(?:main|haggis)$/i.test(n))||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw Error('Rune staging requires one supplier and1..4 carriers, or one opening donor');
 return {mode,names} as {mode:'carriers'|'opening';names:string[]};
}
export function runeCarrierShortfall(items:readonly {id:number;count:number}[]){
 if(!Array.isArray(items)||items.some(i=>!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<0))throw Error('Rune staging bank stock unobserved');
 const count=(id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 return {essence:Math.max(0,405-count(1436)),talismans:Math.max(0,1-count(1446))};
}
export async function runeStageAuthenticate<T extends {name:string}>(name:string,open:()=>Promise<T>,owned:()=>ReadonlySet<string>):Promise<T>{
 const session=await open();
 if(session.name.toLowerCase()!==name.toLowerCase()||!owned().has(name.toLowerCase()))throw Error('Rune staging needs authenticated owned participants');
 return session;
}
