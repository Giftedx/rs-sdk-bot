// The last n lines of a JSON-lines file, read from its end in chunks: a 10 MB log costs the bytes of its tail, not its size.
// tailLines is the pure part; cachedTail keeps a parsed tail until the file's size or time changes.
import {closeSync,fstatSync,openSync,readSync,statSync} from 'node:fs';

const CHUNK=256*1024;
export function tailLines(file:string,n:number):string[]{
 let fd:number;
 try{fd=openSync(file,'r');}catch{return [];}
 try{
  const size=fstatSync(fd).size;let pos=size,text:Buffer=Buffer.alloc(0);
  // n+1 newlines from the end hold n whole lines; the first partial line is dropped unless the read reached byte 0.
  while(pos>0){
   const len=Math.min(CHUNK,pos);pos-=len;
   const buf=Buffer.alloc(len);readSync(fd,buf,0,len,pos);
   text=Buffer.concat([buf,text]);
   let newlines=0;for(let i=0;i<text.length;i++)if(text[i]===10&&++newlines>n)break;
   if(newlines>n)break;
  }
  const lines=text.toString('utf8').split('\n');
  if(pos>0)lines.shift();
  return lines.filter(Boolean).slice(-n);
 }catch{return [];}
 finally{closeSync(fd);}
}

export function tailJsonlFile<T>(file:string,n:number):T[]{
 return tailLines(file,n).flatMap(l=>{try{return [JSON.parse(l) as T];}catch{return [];}});
}

const tails=new Map<string,{key:string;n:number;rows:unknown[]}>();
export function cachedTail<T>(file:string,n:number):T[]{
 let key:string;
 try{const s=statSync(file);key=s.size+':'+s.mtimeMs;}catch{return [];}
 const hit=tails.get(file);
 if(hit&&hit.key===key&&hit.n===n)return hit.rows as T[];
 const rows=tailJsonlFile<T>(file,n);tails.set(file,{key,n,rows});return rows;
}
