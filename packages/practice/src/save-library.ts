// Practice save library: named player saves that a qualification or rehearsal loads to start mid-route.
// Snapshot: GET /save/<account> from save-endpoint.ts while the account is online, else its .sav file after logout.
// Load: writes the bytes as <account>.sav and replaces the account's market checkpoint, which PlayerLoading.load
// prefers over the file. The save format has no username, so any snapshot loads under any practice account.
// Practice only: every endpoint URL must be a local server, and load refuses an online account.
// Usage: bun packages/practice/src/save-library.ts list
//        bun packages/practice/src/save-library.ts snapshot <account> <name> --segment <text> [--port 8899]
//        bun packages/practice/src/save-library.ts load <name> <account> [--port 8899]
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parsePracticeSave} from '../../../scripts/measure/fleet-player-save';
import {isLocalServer} from '../../core/src/localserver';
import {rsSdkRoot} from './paths';

export const LIBRARY_DIR = resolve(import.meta.dir, '..', 'saves');
export const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching',
    'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Stat18', 'Stat19', 'Runecraft'] as const;
// Saved inventory types (InvType ids): 93 pack, 94 worn, 95 bank.
const CONTAINERS = {inventory: 93, worn: 94, bank: 95} as const;
export const DEFAULT_SAVE_PORT = 8899;

export type Items = Record<string, number>;
export interface SaveSummary {
    position: {x: number; z: number; level: number};
    // Skills with XP or a level above 1. Level is the saved current level; xp is whole XP.
    skills: Record<string, {level: number; xp: number}>;
    inventory: Items;
    worn: Items;
    bank: Items;
    varps: number;
}
export interface LibraryEntry {
    name: string;
    file: string;
    sha256: string;
    source: {account: string; via: 'endpoint' | 'file'; tick: number | null};
    segment: string;
    engine: {rsSdk: string; saveVersion: number};
    summary: SaveSummary;
}
export interface Library {entries: LibraryEntry[]}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ENTRY = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function summarize(bytes: Uint8Array): SaveSummary & {version: number} {
    const s = parsePracticeSave(bytes);
    const items = (type: number) => {
        const out: Items = {};
        for (const i of s.inventories[type] ?? []) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const skills: SaveSummary['skills'] = {};
    for (const k of s.skills) if (k.rawExperience > 0 || k.level > 1) skills[SKILLS[k.index]!] = {level: k.level, xp: k.xp};
    return {version: s.version, position: s.position, skills, inventory: items(CONTAINERS.inventory), worn: items(CONTAINERS.worn),
        bank: items(CONTAINERS.bank), varps: Object.keys(s.vars).length};
}

export function readLibrary(dir = LIBRARY_DIR): Library {
    const path = join(dir, 'library.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {entries: []};
}

function writeLibrary(lib: Library, dir: string) {
    mkdirSync(dir, {recursive: true});
    lib.entries.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(join(dir, 'library.json'), JSON.stringify(lib, null, 2) + '\n');
}

export function entryBytes(entry: LibraryEntry, dir = LIBRARY_DIR): Uint8Array {
    const bytes = readFileSync(join(dir, entry.file));
    if (sha(bytes) !== entry.sha256) throw new Error(`library save ${entry.name} does not match its sha256`);
    return bytes;
}

export function findEntry(name: string, dir = LIBRARY_DIR): LibraryEntry {
    const e = readLibrary(dir).entries.find(e => e.name === name);
    if (!e) throw new Error(`no library save named ${name}`);
    return e;
}

export function rsSdkRevision(root = rsSdkRoot()): string {
    const r = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], {stdout: 'pipe', stderr: 'pipe', windowsHide: true});
    return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown';
}

// Adds or replaces one entry. The CRC and layout are checked before anything is written.
export function addEntry(input: {name: string; bytes: Uint8Array; source: LibraryEntry['source']; segment: string; rsSdk: string},
    dir = LIBRARY_DIR): LibraryEntry {
    if (!ENTRY.test(input.name)) throw new Error(`invalid library name ${input.name}: lowercase letters, digits and dashes`);
    if (!input.segment.trim()) throw new Error('a library save needs the route segment it represents');
    const {version, ...summary} = summarize(input.bytes);
    const entry: LibraryEntry = {name: input.name, file: `${input.name}.sav`, sha256: sha(input.bytes), source: input.source,
        segment: input.segment, engine: {rsSdk: input.rsSdk, saveVersion: version}, summary};
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, entry.file), input.bytes);
    const lib = readLibrary(dir);
    lib.entries = [...lib.entries.filter(e => e.name !== entry.name), entry];
    writeLibrary(lib, dir);
    return entry;
}

export function endpointBase(port: number, host = 'localhost'): string {
    if (!isLocalServer(`${host}:${port}`)) throw new Error(`save endpoint must be the local practice server, not ${host}`);
    return `http://${host === 'localhost' ? '127.0.0.1' : host}:${port}`;
}

export async function onlineState(account: string, port = DEFAULT_SAVE_PORT): Promise<{tick: number; online: boolean; pendingLogout: boolean}> {
    const r = await fetch(`${endpointBase(port)}/online/${encodeURIComponent(account)}`);
    if (!r.ok) throw new Error(`save endpoint /online answered ${r.status}`);
    return await r.json() as {tick: number; online: boolean; pendingLogout: boolean};
}

export async function endpointTick(port = DEFAULT_SAVE_PORT): Promise<number> {
    const r = await fetch(`${endpointBase(port)}/tick`);
    if (!r.ok) throw new Error(`save endpoint /tick answered ${r.status}`);
    return ((await r.json()) as {tick: number}).tick;
}

export function playerSavePath(account: string, root = rsSdkRoot()): string {
    if (!/^[a-z0-9]{1,12}$/i.test(account)) throw new Error(`invalid practice account ${account}`);
    return join(root, 'server/engine/data/players/main', `${account.toLowerCase()}.sav`);
}

// Online: the endpoint's in-memory save, no logout. Offline: the save file the last logout wrote.
export async function captureSave(account: string, port = DEFAULT_SAVE_PORT, root = rsSdkRoot()): Promise<{bytes: Uint8Array; source: LibraryEntry['source']}> {
    const r = await fetch(`${endpointBase(port)}/save/${encodeURIComponent(account)}`);
    if (r.ok) return {bytes: new Uint8Array(await r.arrayBuffer()), source: {account, via: 'endpoint', tick: Number(r.headers.get('x-tick'))}};
    if (r.status !== 404) throw new Error(`save endpoint /save answered ${r.status}`);
    const state = await r.json() as {pendingLogout?: boolean};
    if (state.pendingLogout) throw new Error(`${account} is logging out; its save file is not final yet`);
    return {bytes: readFileSync(playerSavePath(account, root)), source: {account, via: 'file', tick: null}};
}

export async function snapshot(account: string, name: string, segment: string, opts: {port?: number; dir?: string; root?: string} = {}): Promise<LibraryEntry> {
    const root = opts.root ?? rsSdkRoot();
    const {bytes, source} = await captureSave(account, opts.port, root);
    return addEntry({name, bytes, source, segment, rsSdk: rsSdkRevision(root)}, opts.dir);
}

// PlayerLoading.load reads `accounts.save` before the file when the market store holds the account.
export function replaceCheckpoint(dbPath: string, account: string, bytes: Uint8Array): boolean {
    if (!existsSync(dbPath)) return false;
    const db = new Database(dbPath);
    try {
        db.exec('PRAGMA busy_timeout=5000');
        const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
        if (!table) return false;
        return db.query('UPDATE accounts SET save=? WHERE owner=?').run(bytes, account.toLowerCase()).changes > 0;
    } finally { db.close(); }
}

export function engineSaveVersion(root = rsSdkRoot()): number {
    const src = readFileSync(join(root, 'server/engine/src/engine/entity/PlayerLoading.ts'), 'utf8');
    const m = src.match(/SAV_VERSION: number = (\d+)/);
    if (!m) throw new Error('engine SAV_VERSION not found');
    return Number(m[1]);
}

// The account must be offline: a logged-in or lingering player keeps its in-memory state and overwrites the file.
export async function loadSnapshot(name: string, account: string, opts: {port?: number; dir?: string; root?: string; online?: (a: string) => Promise<boolean>} = {}):
    Promise<{entry: LibraryEntry; path: string; checkpointReplaced: boolean}> {
    const root = opts.root ?? rsSdkRoot();
    const entry = findEntry(name, opts.dir);
    const bytes = entryBytes(entry, opts.dir);
    if (entry.engine.saveVersion > engineSaveVersion(root)) throw new Error(`${name} is save version ${entry.engine.saveVersion}; this engine reads up to ${engineSaveVersion(root)}`);
    const online = opts.online ?? (async (a: string) => { const s = await onlineState(a, opts.port); return s.online || s.pendingLogout; });
    if (await online(account)) throw new Error(`${account} is online on practice; log it out before loading ${name}`);
    const path = playerSavePath(account, root);
    mkdirSync(join(path, '..'), {recursive: true});
    writeFileSync(path, bytes);
    const db = process.env.GE_DATABASE ? resolve(root, 'server/engine', process.env.GE_DATABASE) : join(root, 'server/engine/data/market.sqlite');
    return {entry, path, checkpointReplaced: replaceCheckpoint(db, account, bytes)};
}

function flag(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
    const [cmd, a, b, ...rest] = process.argv.slice(2);
    const port = Number(flag(rest, '--port') ?? DEFAULT_SAVE_PORT);
    if (cmd === 'list') {
        for (const e of readLibrary().entries) {
            const skills = Object.entries(e.summary.skills).map(([k, v]) => `${k} ${v.level}`).join(', ');
            console.log(`${e.name}\t${e.segment}\t${e.summary.position.x},${e.summary.position.z},${e.summary.position.level}\t${skills}`);
        }
    } else if (cmd === 'snapshot' && a && b) {
        const segment = flag(rest, '--segment');
        if (!segment) throw new Error('snapshot needs --segment <text>');
        console.log(JSON.stringify(await snapshot(a, b, segment, {port}), null, 2));
    } else if (cmd === 'load' && a && b) {
        const r = await loadSnapshot(a, b, {port});
        console.log(`LOADED ${r.entry.name} -> ${b} ${r.path} checkpointReplaced=${r.checkpointReplaced}`);
    } else {
        console.error('usage: save-library.ts list | snapshot <account> <name> --segment <text> [--port N] | load <name> <account> [--port N]');
        process.exitCode = 2;
    }
}
