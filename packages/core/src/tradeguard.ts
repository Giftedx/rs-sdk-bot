import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const verifiedFile = join(root, '.practice/owned-accounts.json');
const cached = new Map<string, { at:number; version:number; names:Set<string> }>();

// Called only after successful game authentication. This proves control, unlike a locally created bot.env.
export function recordOwnedAccount(name: string, server: string): void {
    let entries: Record<string, { server:string; at:number }> = {};
    try { entries=JSON.parse(readFileSync(verifiedFile,'utf8')); } catch { /* first verified login */ }
    entries[name.toLowerCase()]={server:server.toLowerCase(),at:Date.now()};
    mkdirSync(join(root,'.practice'),{recursive:true});
    writeFileSync(verifiedFile,JSON.stringify(entries));
    cached.clear();
}

// Credentials stay in bot.env. A previous live status or a verified login also proves account control.
export function ownedAccounts(server: string): Set<string> {
    let version=0;
    try { version=statSync(verifiedFile).mtimeMs; } catch { /* no verified registry yet */ }
    const hit=cached.get(server);
    if(hit && hit.version===version && Date.now()-hit.at<5000) return new Set(hit.names);
    const dir = resolve(import.meta.dir, '../../../vendor/rs-sdk/bots');
    const names = new Set<string>();
    let verified: Record<string,{server:string}>={};
    try { verified=JSON.parse(readFileSync(verifiedFile,'utf8')); } catch { /* status bootstrap below */ }
    for (const name of readdirSync(dir)) {
        if (name.startsWith('_')) continue;
        try {
            const env = readFileSync(join(dir, name, 'bot.env'), 'utf8');
            const host = env.match(/^SERVER=(.*)$/m)?.[1]?.trim() || 'localhost:8888';
            if (host.toLowerCase() !== server.toLowerCase() || !/^PASSWORD=\S+/m.test(env)) continue;
            let proved=verified[name.toLowerCase()]?.server===server.toLowerCase();
            if(!proved) {
                try {
                    const status=JSON.parse(readFileSync(join(root,'.practice/status',`${name}.json`),'utf8'));
                    proved=status.name?.toLowerCase()===name.toLowerCase() && status.server?.toLowerCase()===server.toLowerCase() && !!status.pos && (status.skills?.length??0)>0;
                } catch { /* credentials alone are not proof */ }
            }
            if(proved) names.add(name.toLowerCase());
        } catch { /* not an account directory */ }
    }
    cached.set(server,{at:Date.now(),version,names});
    return new Set(names);
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
