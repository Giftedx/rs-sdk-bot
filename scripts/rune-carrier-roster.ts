// The orchestrate supervisor forwards every participant, then the mode flag.
export function runeCarrierMeasurePacks(mode:string|undefined):number|undefined{
 if(!mode?.startsWith('--body-measure'))return;
 const match=/^--body-measure=([1-9][0-9]*)$/.exec(mode),n=Number(match?.[1]);
 if(!match||!Number.isSafeInteger(n)||n<12||n>48)throw Error('body measurement requires12..48 full packs');
 return n;
}
// --staged=<altar>:<level>: the altar name of scripts/rune-carrier-altar.ts and the target Runecraft level.
export function runeCarrierStaged(mode:string|undefined):{altar:string;target:number}|undefined{
 if(!mode?.startsWith('--staged'))return;
 const match=/^--staged=([a-z]+):([1-9][0-9]?)$/.exec(mode),target=Number(match?.[2]);
 if(!match||target<2||target>99)throw Error('staged carriers need --staged=<altar>:<level 2..99>');
 return {altar:match[1]!,target};
}
export function runeCarrierRoster(args:readonly string[]):string[]{
 const mode=args.at(-1);
 const measure=runeCarrierMeasurePacks(mode),staged=runeCarrierStaged(mode);
 const flag=(a:string)=>a==='--carriers'||a==='--body-continuation'||a.startsWith('--body-measure')||a.startsWith('--staged');
 if(!['--carriers','--body-continuation'].includes(mode??'')&&measure===undefined&&staged===undefined||args.filter(flag).length!==1)throw Error('carrier mode needs the complete roster followed by one mode flag');
 const names=args.slice(0,-1);
 if(names.length<3||names.length>17||names.some(n=>!/^[A-Za-z0-9]{1,12}$/.test(n))||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw Error('carrier mode needs one crafter and2..16 distinct owned carriers');
 if((mode==='--body-continuation'||measure!==undefined)&&names.length!==17)throw Error('body continuation requires the retained16 owned helpers');
 return names;
}
export function assertFreshRuneSkills(skills:readonly {name:string;baseLevel:number;experience:number}[]|null|undefined){
 if(skills?.length!==21||skills.some(s=>s.baseLevel!==(s.name==='Hitpoints'?10:1)||s.experience!==(s.name==='Hitpoints'?980:0)))throw Error('carrier fresh route requires the original fresh skills');
}
export function assertRuneDonor(player:{worldX:number;worldZ:number;level:number}|null|undefined,inventory:readonly {id:number;count:number}[]){
 const count=(id:number)=>inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 if(!player||player.level!==0||Math.max(Math.abs(player.worldX-3222),Math.abs(player.worldZ-3222))>1||count(1436)!==27||count(1438)!==1||inventory.some(i=>i.id!==1436&&i.id!==1438))throw Error('opening donor needs27 essence and an air talisman beside the tutorial exit');
}
