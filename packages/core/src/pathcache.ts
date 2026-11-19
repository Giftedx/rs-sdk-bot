import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// rs-sdk's initPathfinding() costs about 14 s per process: 12.8 s of it is allocateIfAbsent for 136,704 zones in
// rsmod's wasm memory (measured). Every proof run and every bot process paid it. This saves that wasm
// memory once after a cold build and copies it back into a fresh instance before initPathfinding() runs. The
// zones are then already present, so allocateIfAbsent returns at once; __set and the door unmasking are
// idempotent and rebuild pathfinding.ts's own JS-side door index. The snapshot is keyed on the wasm,
// collision data and initializer policy bytes, so an input change rebuilds it even when size/mtime match.

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
const WASM = vendor('server/vendor/rsmod-pathfinder/rsmod_bg.wasm');
const DATA = vendor('sdk/collision-data.json');
const INITIALIZER = vendor('sdk/pathfinding.ts');
export const DEFAULT_CACHE = join(repoRoot, '.practice', 'cache', 'rsmod-pathfinding.snap');
const PAGE=65536;
const MAX_HEADER=65536;
const sha256=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');

const DOORS = join(repoRoot, 'knowledge', 'doors.json');
// Open diagonal doors (shape 9): the collision export leaves their loc collision on the tile, which seals the
// building for the route search. The walker opens them like any door (walk.ts openNearestDoor).
export function diagonalDoors(file=DOORS): {x:number;z:number;level:number}[] {
    try{return (JSON.parse(readFileSync(file,'utf8')) as {x:number;z:number;level:number;shape?:number;kind:string}[])
        .filter(d=>d.shape===9&&d.kind==='open').map(({x,z,level})=>({x,z,level}));}catch{return [];}
}
export function openDiagonalDoors(rsmod:{changeLoc(x:number,z:number,y:number,w:number,l:number,blockrange:boolean,route:boolean,add:boolean):void},doors=diagonalDoors()):number {
    for(const d of doors)rsmod.changeLoc(d.x,d.z,d.level,1,1,true,false,false);
    return doors.length;
}

// The key reads and hashes the 27.5 MB collision file, and one process asks for it from the snapshot, the leg cache, the
// area labels and the route worker. A call with the default files keeps its key while the four files keep their size and
// their modification time, so a process hashes them once. A call that names its files is always exact: it hashes the bytes.
let defaultKey:{stamp:string;key:string}|null=null;
const fileStamp=(file:string)=>{try{const s=statSync(file);return s.size+':'+s.mtimeMs;}catch{return 'missing';}};
export function pathfindingSourceKey(wasmFile?:string,collisionFile?:string,doorsFile?:string,initializerFile?:string): string {
    const named=wasmFile!==undefined||collisionFile!==undefined||doorsFile!==undefined||initializerFile!==undefined;
    const files=[wasmFile??WASM,collisionFile??DATA,doorsFile??DOORS,initializerFile??INITIALIZER];
    if(named)return hashedSourceKey(files[0]!,files[1]!,files[2]!,files[3]!);
    const stamp=files.map(fileStamp).join(',');
    if(defaultKey&&defaultKey.stamp===stamp)return defaultKey.key;
    const key=hashedSourceKey(files[0]!,files[1]!,files[2]!,files[3]!);
    defaultKey={stamp,key};
    return key;
}
function hashedSourceKey(wasmFile:string,collisionFile:string,doorsFile:string,initializerFile:string): string {
    return JSON.stringify({v:5,wasm:sha256(readFileSync(wasmFile)),data:sha256(readFileSync(collisionFile)),initializer:sha256(readFileSync(initializerFile)),diagonal:sha256(Buffer.from(JSON.stringify(diagonalDoors(doorsFile))))});
}

type SnapshotHeader={format:2;key:string;bytes:number;sha256:string};
function snapshotHeader(bytes:Buffer,total:number,key:string):{header:SnapshotHeader;offset:number}|null {
    if(bytes.length<4)return null;
    const length=bytes.readUInt32LE(0),offset=4+length;
    if(length<1||length>MAX_HEADER||offset>bytes.length||offset>total)return null;
    try{
        const header=JSON.parse(bytes.subarray(4,offset).toString('utf8')) as SnapshotHeader;
        if(header?.format!==2||header.key!==key||!Number.isSafeInteger(header.bytes)||header.bytes<=0
            ||header.bytes%PAGE!==0||header.bytes!==total-offset||typeof header.sha256!=='string'||!/^[a-f0-9]{64}$/.test(header.sha256))return null;
        return {header,offset};
    }catch{return null;}
}

// Content checks follow OpenRS2's checksum/read-corruption tests and Displee's
// archive-content CRC pattern. This snapshot format is local, not a game format.
export function decodePathfindingSnapshot(bytes:Buffer,key:string):Uint8Array|null {
    const parsed=snapshotHeader(bytes,bytes.length,key);
    if(!parsed)return null;
    const payload=bytes.subarray(parsed.offset);
    return sha256(payload)===parsed.header.sha256?payload:null;
}

function readFully(fd:number,bytes:Buffer,position:number):boolean {
    let offset=0;
    while(offset<bytes.length){
        const n=readSync(fd,bytes,offset,bytes.length-offset,position+offset);
        if(n===0)return false;
        offset+=n;
    }
    return true;
}

export function verifyPathfindingSnapshotFile(file:string,key:string):boolean {
    const fd=openSync(file,'r');
    try{
        const total=fstatSync(fd).size,prefix=Buffer.alloc(4);
        if(!readFully(fd,prefix,0))return false;
        const length=prefix.readUInt32LE(0);
        if(length<1||length>MAX_HEADER||length+4>total)return false;
        const bytes=Buffer.alloc(4+length);
        if(!readFully(fd,bytes,0))return false;
        const parsed=snapshotHeader(bytes,total,key);
        if(!parsed)return false;
        const digest=createHash('sha256'),chunk=Buffer.alloc(PAGE);
        for(let pos=parsed.offset;pos<total;pos+=PAGE){
            const size=Math.min(PAGE,total-pos),part=chunk.subarray(0,size);
            if(!readFully(fd,part,pos))return false;
            digest.update(part);
        }
        return digest.digest('hex')===parsed.header.sha256;
    }finally{closeSync(fd);}
}

// Copies the payload into WASM memory. A page that memory.grow() added is zero already, so a zero page of the payload
// beyond `had` bytes is not written: writing it would make the operating system commit and map the page (about half of
// the 1,593 pages of the snapshot are zero). A page below `had` is always written: it may hold other bytes.
export function copyNonZeroPages(payload:Uint8Array,target:Uint8Array,had:number):void {
    const zero=new Uint8Array(PAGE);
    for(let at=0;at<payload.length;at+=PAGE){
        const page=payload.subarray(at,Math.min(at+PAGE,payload.length));
        if(at>=had&&Buffer.compare(page,zero.subarray(0,page.length))===0)continue;
        target.set(page,at);
    }
}

// Stage the checked payload before changing WASM memory. A failed read remains
// an optional cache miss, even when it happens after some payload bytes arrive.
// This uses one transient payload buffer, bounded by the checked file length. It is not zero-filled: readFully fills all of it
// and the hash covers all of it before any byte is used.
export function restorePathfindingSnapshotFile(file:string,key:string,memory:WebAssembly.Memory):boolean {
    let fd:number|undefined,payload:Buffer|undefined;
    try {
        fd=openSync(file,'r');
        const total=fstatSync(fd).size,head=Buffer.alloc(Math.min(total,4+MAX_HEADER));
        const parsed=readFully(fd,head,0)?snapshotHeader(head,total,key):null;
        if(!parsed)return false;
        payload=Buffer.allocUnsafe(parsed.header.bytes);
        if(!readFully(fd,payload,parsed.offset)||sha256(payload)!==parsed.header.sha256)return false;
    } catch { return false; }
    finally { if(fd!==undefined)try{closeSync(fd);}catch{/* The cache is optional. */} }
    const had=memory.buffer.byteLength,need=payload.length/PAGE-had/PAGE;
    if(need>0)try{memory.grow(need);}catch{return false;}
    copyNonZeroPages(payload,new Uint8Array(memory.buffer,0,payload.length),had);
    return true;
}

export function writePathfindingSnapshot(file:string,key:string,payload:Uint8Array):void {
    if(payload.length<=0||payload.length%PAGE!==0)throw Error('Invalid pathfinding snapshot memory length');
    const head=Buffer.from(JSON.stringify({format:2,key,bytes:payload.length,sha256:sha256(payload)}));
    if(head.length>MAX_HEADER)throw Error('Pathfinding snapshot header too large');
    const len=Buffer.alloc(4);len.writeUInt32LE(head.length);
    mkdirSync(dirname(file),{recursive:true});
    const temporary=`${file}.${process.pid}.tmp`;
    // Keep the previous completed file until persisted bytes have passed a
    // streamed check. The payload is a view; no full-memory concat/copy is needed.
    writeFileSync(temporary,len);appendFileSync(temporary,head);appendFileSync(temporary,payload);
    if(!verifyPathfindingSnapshotFile(temporary,key))throw Error('Pathfinding snapshot write verification failed');
    renameSync(temporary,file);
}

let loaded: Promise<{ restored: boolean; ms: number }> | null = null;

export function loadPathfinding(opts: { cacheFile?: string } = {}): Promise<{ restored: boolean; ms: number }> {
    loaded ??= load(opts.cacheFile ?? DEFAULT_CACHE).catch(error=>{loaded=null;throw error;});
    return loaded;
}

// Level, start x and z, end x and z of the searches that run before a snapshot is written (a short and a long one).
const WARM_ROUTES: [number, number, number, number, number][] = [[0, 3222, 3218, 3087, 3230], [0, 2655, 3283, 3185, 3436]];

async function load(file: string): Promise<{ restored: boolean; ms: number }> {
    const t0 = Date.now();
    // Same specifier as sdk/pathfinding.ts imports, so this is the same module instance and the same wasm memory.
    const rsmod: any = await import(vendor('server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'));
    const memory: WebAssembly.Memory = rsmod.__wasm.memory;
    const k = pathfindingSourceKey();
    const restored=restorePathfindingSnapshotFile(file,k,memory);
    // collision-lazy.ts then skips parsing zones and tiles: the restored grid already holds them.
    if(restored)(globalThis as { __rsPathRestored?: boolean }).__rsPathRestored = true;
    const { initPathfinding } = await import(vendor('sdk/pathfinding.ts'));
    initPathfinding();
    openDiagonalDoors(rsmod);
    if (!restored) {
        // The first route search grows the WASM memory for its scratch grid (a new backing buffer and a copy of the old
        // one: about 190 MB of RSS, scripts/measure/wasm-grow-memory.ts). Two searches here grow it once, and the
        // snapshot holds the grown memory, so a process that restores it never grows at its first route.
        try {
            const sdk = await import(vendor('sdk/pathfinding.ts'));
            for (const [level, sx, sz, dx, dz] of WARM_ROUTES) sdk.findLongPath(level, sx, sz, dx, dz);
        } catch { /* The snapshot is still valid without the growth. */ }
        try { writePathfindingSnapshot(file,k,new Uint8Array(memory.buffer)); }
        catch { /* A cache write failure does not invalidate the initialized grid. */ }
    }
    return { restored, ms: Date.now() - t0 };
}
