import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { renameRetry } from './atomic-file';

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
    const stamp=files.map(fileStamp).join(',')+':'+shouldWarmSnapshot();
    if(defaultKey&&defaultKey.stamp===stamp)return defaultKey.key;
    const key=hashedSourceKey(files[0]!,files[1]!,files[2]!,files[3]!);
    defaultKey={stamp,key};
    return key;
}
// The key of the data alone (wasm, collision data, initializer, doors), the same on every platform. The leg cache and the
// area labels hold values that do not depend on how the snapshot was saved, so they use this key, not the snapshot's.
let dataKeyMemo:{stamp:string;key:string}|null=null;
export function pathfindingDataKey(): string {
    const files=[WASM,DATA,DOORS,INITIALIZER],stamp=files.map(fileStamp).join(',');
    if(dataKeyMemo&&dataKeyMemo.stamp===stamp)return dataKeyMemo.key;
    const key=hashedSourceKey(files[0]!,files[1]!,files[2]!,files[3]!,4);
    dataKeyMemo={stamp,key};
    return key;
}
function hashedSourceKey(wasmFile:string,collisionFile:string,doorsFile:string,initializerFile:string,version=shouldWarmSnapshot()?5:4): string {
    return JSON.stringify({v:version,wasm:sha256(readFileSync(wasmFile)),data:sha256(readFileSync(collisionFile)),initializer:sha256(readFileSync(initializerFile)),diagonal:sha256(Buffer.from(JSON.stringify(diagonalDoors(doorsFile))))});
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
    const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try{
        // Keep the previous completed file until persisted bytes have passed a
        // streamed check. The payload is a view; no full-memory concat/copy is needed.
        writeFileSync(temporary,len);appendFileSync(temporary,head);appendFileSync(temporary,payload);
        if(!verifyPathfindingSnapshotFile(temporary,key))throw Error('Pathfinding snapshot write verification failed');
        renameRetry(temporary,file);
    }catch(error){
        try{unlinkSync(temporary);}catch{/* retain original error */}
        throw error;
    }
}

let loaded: Promise<{ restored: boolean; ms: number }> | null = null;

// Whether the file is a snapshot of the current source key: its header is read, not its payload. A login that finds
// none loads the route finder itself (inprocess.ts), so a cold build never happens inside a live session.
export function pathfindingSnapshotUsable(file=DEFAULT_CACHE,key?:string):boolean {
    let fd:number|undefined;
    try{
        fd=openSync(file,'r');
        const total=fstatSync(fd).size,head=Buffer.alloc(Math.min(total,4+MAX_HEADER));
        return readFully(fd,head,0)&&snapshotHeader(head,total,key??pathfindingSourceKey())!==null;
    }catch{return false;}
    finally{if(fd!==undefined)try{closeSync(fd);}catch{/* The cache is optional. */}}
}

// A process that never asked for the route finder still reaches it when a script calls an SDK function that
// initializes the collision grid (isTileWalkable, isFlagged, isZoneAllocated, findLongPath; not findDoorsAlongPath,
// which only reads the door index): sdk/pathfinding.ts then runs initPathfinding() itself,
// and its first read of the collision data (the preload collision-lazy.ts) calls this hook before the zones are read.
// The hook restores the snapshot, so the grid is the same as after loadPathfinding() and the 14 s of allocation do
// not run. Without a valid snapshot it does nothing and the SDK builds the grid itself; the snapshot is then written
// in the background by loadPathfinding().
let syncTried = false;
export function restorePathfindingOnFirstUse(file = DEFAULT_CACHE): boolean {
    if (syncTried || (globalThis as { __rsPathRestored?: boolean }).__rsPathRestored) return false;
    syncTried = true;
    let restored = false;
    try {
        const rsmod = require(vendor('server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'));
        restored = restorePathfindingSnapshotFile(file, pathfindingSourceKey(), rsmod.__wasm.memory);
    } catch { /* an optional cache */ }
    if (restored) (globalThis as { __rsPathRestored?: boolean }).__rsPathRestored = true;
    else queueMicrotask(() => { void loadPathfinding({ cacheFile: file }).catch(() => {}); });
    return restored;
}
// The hook reads the file that loadPathfinding() was given, the default file otherwise.
let hookFile = DEFAULT_CACHE;
(globalThis as { __rsPathEnsure?: () => void }).__rsPathEnsure = () => { restorePathfindingOnFirstUse(hookFile); };

export function loadPathfinding(opts: { cacheFile?: string } = {}): Promise<{ restored: boolean; ms: number }> {
    if (opts.cacheFile) hookFile = opts.cacheFile;
    loaded ??= load(opts.cacheFile ?? DEFAULT_CACHE).catch(error=>{loaded=null;throw error;});
    return loaded;
}

// The first route search grows the WASM memory for its scratch grid (a new backing buffer and a copy of the old one).
// Two searches before the snapshot is written grow it once, and the snapshot holds the grown memory, so a process that
// restores it never grows at its first route. Measured with scripts/measure/wasm-grow-memory.ts, RSS after the first
// route: Windows 517 MB before and 410 MB after; Linux 337 MB before and 377 MB after. The fleet runs on Windows, so only
// win32 warms the snapshot. The platform is part of the source key (a snapshot of the other kind is not used).
export const shouldWarmSnapshot = (platform: string = process.platform): boolean => platform === 'win32';
export function warmSnapshotGrid(sdk: { findLongPath(level: number, sx: number, sz: number, dx: number, dz: number): unknown }, platform: string = process.platform): number {
    if (!shouldWarmSnapshot(platform)) return 0;
    for (const [level, sx, sz, dx, dz] of WARM_ROUTES) sdk.findLongPath(level, sx, sz, dx, dz);
    return WARM_ROUTES.length;
}

// Level, start x and z, end x and z of the searches that run before a snapshot is written (a short and a long one).
const WARM_ROUTES: [number, number, number, number, number][] = [[0, 3222, 3218, 3087, 3230], [0, 2655, 3283, 3185, 3436]];

// Single-flight build of the snapshot across processes. A lock file beside the snapshot (`<file>.lock`, created with
// the exclusive flag, holding the owner's pid and time) names the one builder. The others poll until the snapshot is
// usable for their source key (a header check, pathfindingSnapshotUsable) and restore it.
// - A lock whose owner pid is dead, or that is older than `staleMs`, is removed (read again just before the removal, so a
//   lock that another process has taken in between stays).
// - A builder cannot refresh its lock: the grid build blocks its event loop for about 14 s. So a lock held by a LIVE pid
//   (a reused pid looks alive) can stay for `staleMs`. A waiter that has waited `waitMs` removes that lock once and goes
//   back to the exclusive create: one waiter wins and builds, the others wait one more round.
// - A second `waitMs` without a snapshot gives {state:'timeout'}: the caller fails (a login throws and retries) and does
//   not build, so a stuck lock never makes all waiters build at once.
// - {state:'unlocked'}: the cache folder or the lock file cannot be made (no access), so this process builds with no lock.
export type SnapshotBuild={state:'build';release():void}|{state:'ready'}|{state:'timeout'}|{state:'unlocked'};
const pidAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException)?.code==='EPERM';}};
const readLock=(lock:string):string|null=>{try{return readFileSync(lock,'utf8');}catch{return null;}};
// Removes the lock only if it still holds `seen`.
const removeLockIf=(lock:string,seen:string|null):boolean=>{
    if(readLock(lock)!==seen)return false;
    try{unlinkSync(lock);return true;}catch{return false;}
};
export async function acquireSnapshotBuild(file:string,key:string,opts:{waitMs?:number;pollMs?:number;staleMs?:number;alive?:(pid:number)=>boolean}={}):Promise<SnapshotBuild>{
    const {waitMs=120_000,pollMs=250,staleMs=300_000,alive=pidAlive}=opts,lock=`${file}.lock`;
    let round=1,deadline=Date.now()+waitMs,waitedOn:string|null=null;
    for(;;){
        if(pathfindingSnapshotUsable(file,key))return {state:'ready'};
        // A cache folder that cannot exist (a file in the way, no access) means: build, without a lock.
        try{mkdirSync(dirname(file),{recursive:true});}catch{return {state:'unlocked'};}
        try{
            const fd=openSync(lock,'wx');
            try{writeSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));}finally{closeSync(fd);}
            const release=()=>{try{if(JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}catch{/* gone */}};
            // A builder may have finished between the check above and this lock.
            if(pathfindingSnapshotUsable(file,key)){release();return {state:'ready'};}
            return {state:'build',release};
        }catch(e){
            if((e as NodeJS.ErrnoException)?.code!=='EEXIST')return {state:'unlocked'};
            const seen=readLock(lock);
            waitedOn??=seen;
            let dead=false;
            try{
                const owner=JSON.parse(seen??'') as {pid:number;at:number};
                dead=!alive(owner.pid)||Date.now()-owner.at>staleMs;
            }catch{
                // Not written yet, or damaged: only an old file is stale.
                try{dead=Date.now()-statSync(lock).mtimeMs>staleMs;}catch{/* gone */}
            }
            if(dead&&removeLockIf(lock,seen))continue;
        }
        if(Date.now()>=deadline){
            if(round>=2)return {state:'timeout'};
            // The first wait ended: the lock holder is not building (a killed builder whose pid a live process now
            // has). Take the lock away once; one waiter wins the exclusive create below, the rest wait a second round.
            round=2;deadline=Date.now()+waitMs;
            removeLockIf(lock,waitedOn); // only the lock that this waiter waited on, never a newer builder's
            continue;
        }
        await new Promise(r=>setTimeout(r,pollMs));
    }
}

async function load(file: string): Promise<{ restored: boolean; ms: number }> {
    const t0 = Date.now();
    // Same specifier as sdk/pathfinding.ts imports, so this is the same module instance and the same wasm memory.
    const rsmod: any = await import(vendor('server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'));
    const memory: WebAssembly.Memory = rsmod.__wasm.memory;
    const k = pathfindingSourceKey();
    // The first-use hook may have restored the snapshot already.
    let restored=(globalThis as { __rsPathRestored?: boolean }).__rsPathRestored===true||restorePathfindingSnapshotFile(file,k,memory),build:SnapshotBuild|null=null;
    // No usable snapshot: one process builds the grid and the others wait for its file (a build is about 14 s and
    // 400 MB, so 20 workers starting together must not each pay it).
    if(!restored){
        build=await acquireSnapshotBuild(file,k);
        // Two waits without a snapshot: fail, so a login throws and retries, and no waiter builds without the lock.
        if(build.state==='timeout')throw Error(`pathfinding snapshot build did not finish: ${file}.lock held for too long`);
        if(build.state==='ready')restored=restorePathfindingSnapshotFile(file,k,memory);
    }
    try{
        // collision-lazy.ts then skips parsing zones and tiles: the restored grid already holds them.
        if(restored)(globalThis as { __rsPathRestored?: boolean }).__rsPathRestored = true;
        const { initPathfinding } = await import(vendor('sdk/pathfinding.ts'));
        initPathfinding();
        openDiagonalDoors(rsmod);
        if (!restored) {
            try { warmSnapshotGrid(await import(vendor('sdk/pathfinding.ts'))); }
            catch { /* The snapshot is still valid without the growth. */ }
            try { writePathfindingSnapshot(file,k,new Uint8Array(memory.buffer)); }
            catch { /* A cache write failure does not invalidate the initialized grid. */ }
        }
    }finally{if(build?.state==='build')build.release();}
    return { restored, ms: Date.now() - t0 };
}
