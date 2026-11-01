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
