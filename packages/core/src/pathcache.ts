import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// rs-sdk's initPathfinding() costs about 14 s per process: 12.8 s of it is allocateIfAbsent for 136,704 zones in
// rsmod's wasm memory (measured 2026-10-22). Every proof run and every bot process paid it. This saves that wasm
// memory once after a cold build and copies it back into a fresh instance before initPathfinding() runs. The
// zones are then already present, so allocateIfAbsent returns at once; __set and the door unmasking are
// idempotent and rebuild pathfinding.ts's own JS-side door index. The snapshot is keyed on the wasm and
// collision-data bytes, so an input change rebuilds it even when size/mtime match.

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
const WASM = vendor('server/vendor/rsmod-pathfinder/rsmod_bg.wasm');
const DATA = vendor('sdk/collision-data.json');
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

export function pathfindingSourceKey(wasmFile=WASM,collisionFile=DATA,doorsFile=DOORS): string {
    return JSON.stringify({v:3,wasm:sha256(readFileSync(wasmFile)),data:sha256(readFileSync(collisionFile)),diagonal:sha256(Buffer.from(JSON.stringify(diagonalDoors(doorsFile))))});
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
    loaded ??= load(opts.cacheFile ?? DEFAULT_CACHE);
    return loaded;
}

async function load(file: string): Promise<{ restored: boolean; ms: number }> {
    const t0 = Date.now();
    // Same specifier as sdk/pathfinding.ts imports, so this is the same module instance and the same wasm memory.
    const rsmod: any = await import(vendor('server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'));
    const memory: WebAssembly.Memory = rsmod.__wasm.memory;
    const k = pathfindingSourceKey();
    let restored = false;
    if (existsSync(file)) {
        const buf = readFileSync(file);
        const snap=decodePathfindingSnapshot(buf,k);
        if (snap) {
            const need = snap.length / PAGE - memory.buffer.byteLength / PAGE;
            if (need > 0) memory.grow(need);
            new Uint8Array(memory.buffer).set(snap);
            restored = true;
        }
    }
    const { initPathfinding } = await import(vendor('sdk/pathfinding.ts'));
    initPathfinding();
    openDiagonalDoors(rsmod);
    if (!restored) {
        writePathfindingSnapshot(file,k,new Uint8Array(memory.buffer));
    }
    return { restored, ms: Date.now() - t0 };
}
