import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listedAccounts } from './fleet';

const root = resolve(import.meta.dir, '../../..');
const verifiedFile = join(root, '.practice/owned-accounts.json');
const OWNED_CACHE_MS = 5 * 60_000;

type BotScanCache = {
    at: number;
    dir: string;
    dirMtime: number;
    servers: Map<string, string>;
    statusVerified: Map<string, string>;
};
let botScan: BotScanCache | null = null;
let verifiedCache: { version: number; entries: Record<string, { server: string }> } | null = null;

function readBotServer(dir: string, name: string): string | null {
    try {
        const env = readFileSync(join(dir, name, 'bot.env'), 'utf8');
        if (!/^PASSWORD=\S+/m.test(env)) return null;
        return (env.match(/^SERVER=(.*)$/m)?.[1]?.trim() || 'localhost:8888').toLowerCase();
    } catch { return null; }
}

function getBotScan(dir: string, force = false): BotScanCache {
    const now = Date.now();
    if (!force && botScan && botScan.dir === dir && now - botScan.at < OWNED_CACHE_MS) return botScan;
    let dirMtime = 0;
    try { dirMtime = statSync(dir).mtimeMs; } catch { /* missing bots dir */ }
    const servers = new Map<string, string>();
    const statusVerified = new Map<string, string>();
    for (const name of readdirSync(dir)) {
        if (name.startsWith('_')) continue;
        const host = readBotServer(dir, name);
        if (!host) continue;
        const lower = name.toLowerCase();
        servers.set(lower, host);
        try {
            const status = JSON.parse(readFileSync(join(root, '.practice/status', `${name}.json`), 'utf8'));
            if (status.name?.toLowerCase() === lower && status.server?.toLowerCase() === host && !!status.pos && (status.skills?.length ?? 0) > 0) {
                statusVerified.set(lower, host);
            }
        } catch { /* credentials alone are not proof */ }
    }
    botScan = { at: now, dir, dirMtime, servers, statusVerified };
    return botScan;
}

function readVerifiedEntries(): Record<string, { server: string }> {
    let version = 0;
    try { version = statSync(verifiedFile).mtimeMs; } catch { /* no verified registry yet */ }
    if (verifiedCache && verifiedCache.version === version) return verifiedCache.entries;
    let entries: Record<string, { server: string }> = {};
    try { entries = JSON.parse(readFileSync(verifiedFile, 'utf8')); } catch { /* status bootstrap below */ }
    verifiedCache = { version, entries };
    return entries;
}

// Called only after successful game authentication. This proves control, unlike a locally created bot.env.
export function recordOwnedAccount(name: string, server: string): void {
    let entries: Record<string, { server:string; at:number }> = {};
    try { entries=JSON.parse(readFileSync(verifiedFile,'utf8')); } catch { /* first verified login */ }
    entries[name.toLowerCase()]={server:server.toLowerCase(),at:Date.now()};
    mkdirSync(join(root,'.practice'),{recursive:true});
    writeFileSync(verifiedFile,JSON.stringify(entries));
    verifiedCache = null;
}

// Credentials stay in bot.env. A previous live status or a verified login also proves account control.
// Keep the full directory scan cached across owned-accounts.json writes so a new specialist login never
// blocks an active supplier's trade tick on disk I/O.
export function ownedAccounts(server: string): Set<string> {
    const targetServer = server.toLowerCase();
    const dir = resolve(import.meta.dir, '../../../vendor/rs-sdk/bots');
    let scan = getBotScan(dir);
    const verified = readVerifiedEntries();
    const names = new Set<string>();
    for (const [lower, host] of scan.statusVerified) {
        if (host === targetServer) names.add(lower);
    }
    let dirChecked = false;
    for (const [key, entry] of Object.entries(verified)) {
        if (entry?.server?.toLowerCase() !== targetServer) continue;
        const lower = key.toLowerCase();
        let botServer = scan.servers.get(lower);
        if (botServer === undefined) {
            const found = readBotServer(dir, key) ?? readBotServer(dir, lower);
            if (found) {
                scan.servers.set(lower, found);
                botServer = found;
            } else if (!dirChecked) {
                dirChecked = true;
                let mtime = 0;
                try { mtime = statSync(dir).mtimeMs; } catch { /* ignore */ }
                if (mtime !== scan.dirMtime) {
                    scan = getBotScan(dir, true);
                    botServer = scan.servers.get(lower);
                }
            }
        }
        if (botServer === targetServer) names.add(lower);
    }
    return names;
}

// Trade partners: accounts this machine proved, plus every account fleet/owners.json lists on either side (a cloud
// account trades with a local one without either machine holding the other's credentials).
export function tradePartners(server: string): Set<string> {
    return new Set([...ownedAccounts(server), ...listedAccounts(server)]);
}

export function tradeRefusal(action: any, state: any, owned: ReadonlySet<string>): string | null {
    let partner: string | null | undefined;
    if (action.type === 'interactPlayer' && action.optionIndex === 4) {
        partner = state?.nearbyPlayers?.find((p: any) => p.index === action.playerIndex)?.name;
    } else if (['clickComponent', 'clickComponentWithOption'].includes(action.type) && [3420, 3546].includes(action.componentId)) {
        partner = state?.trade?.partner;
    } else return null;
    return partner && owned.has(partner.toLowerCase()) ? null : 'trade refused: partner is not a known owned account';
}
