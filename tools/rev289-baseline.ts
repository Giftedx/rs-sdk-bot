// Authoritative Rev 289 (Lost City Jan 17, 2005) baseline parser shared by tools/check-rev289-*.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Rev289Baseline {
    maxObjId: number;
    maxNpcId: number;
    maxLocId: number;
    objById: Map<number, string>;
    objIdsByDebug: Map<string, number>;
    objNames: Set<string>;
    objNameById: Map<number, string>;
    npcById: Map<number, string>;
    npcNames: Set<string>;
    locById: Map<number, string>;
    skills: Set<string>;
    prayers: Set<string>;
    spells: Set<string>;
    questNames: Set<string>;
    specwepDebugs: Set<string>;
}

function walkExt(dir: string, ext: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walkExt(p, ext, out);
        else if (f.endsWith(ext)) out.push(p);
    }
    return out;
}

function parsePack(path: string): { byId: Map<number, string>; byDebug: Map<string, number>; maxId: number } {
    const byId = new Map<number, string>();
    const byDebug = new Map<string, number>();
    let maxId = -1;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const id = Number(line.slice(0, idx));
        const dbg = line.slice(idx + 1).trim();
        if (!Number.isSafeInteger(id) || id < 0 || !dbg) continue;
        byId.set(id, dbg);
        byDebug.set(dbg, id);
        if (id > maxId) maxId = id;
    }
    return { byId, byDebug, maxId };
}

/** Loads authoritative Rev 289 baselines directly from vendor/rs-sdk/server/content and PlayerStat.ts. */
export function loadRev289Baseline(repoRoot = resolve(import.meta.dir, '..')): Rev289Baseline {
    const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');
    const obj = parsePack(join(content, 'pack', 'obj.pack'));
    const npc = parsePack(join(content, 'pack', 'npc.pack'));
    const loc = parsePack(join(content, 'pack', 'loc.pack'));

    const objNames = new Set<string>();
    const objNameById = new Map<number, string>();
    const specwepDebugs = new Set<string>();
    for (const f of walkExt(join(content, 'scripts'), '.obj')) {
        let cur = '';
        for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            const head = /^\[([^\]]+)\]$/.exec(line);
            if (head) { cur = head[1]!; continue; }
            if (!cur) continue;
            if (line.startsWith('name=')) {
                const name = line.slice(5).trim();
                objNames.add(name);
                const id = obj.byDebug.get(cur);
                if (id !== undefined) objNameById.set(id, name);
            } else if (line === 'param=specwep,^true') {
                specwepDebugs.add(cur);
            }
        }
    }
    for (const [id, dbg] of obj.byId) {
        if (!objNameById.has(id)) {
            objNameById.set(id, dbg);
            objNames.add(dbg);
        }
    }

    const npcNames = new Set<string>();
    for (const f of walkExt(join(content, 'scripts'), '.npc')) {
        for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            if (line.startsWith('name=')) npcNames.add(line.slice(5).trim().toLowerCase());
        }
    }
    for (const dbg of npc.byId.values()) npcNames.add(dbg.toLowerCase());

    const playerStatText = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'engine', 'src', 'engine', 'entity', 'PlayerStat.ts'), 'utf8');
    const enumBlock = playerStatText.split('enum PlayerStat {')[1]?.split('}')[0] ?? '';
    const skills = new Set<string>();
    for (const m of enumBlock.matchAll(/\b([A-Z]+)\b/g)) {
        const s = m[1]!.toLowerCase();
        if (s && !s.startsWith('stat')) skills.add(s);
    }

    const prayersText = readFileSync(join(content, 'scripts', 'skill_prayer', 'configs', 'prayers.dbrow'), 'utf8');
    const prayers = new Set<string>();
    for (const m of prayersText.matchAll(/^data=name,(.+)$/gm)) prayers.add(m[1]!.trim().toLowerCase());

    const magicIf = readFileSync(join(content, 'scripts', 'skill_magic', 'interfaces', 'magic.if'), 'utf8');
    const spells = new Set<string>();
    for (const m of magicIf.matchAll(/^text=Level\s+\d+\s*:\s*(.+)$/gm)) spells.add(m[1]!.trim().toLowerCase());

    const questNames = new Set<string>();
    const questRewardsPath = join(repoRoot, 'packages', 'dashboard', 'client-assets', 'quest-rewards.json');
    if (existsSync(questRewardsPath)) {
        for (const q of Object.keys(JSON.parse(readFileSync(questRewardsPath, 'utf8')))) questNames.add(q.toLowerCase());
    }

    return {
        maxObjId: obj.maxId,
        maxNpcId: npc.maxId,
        maxLocId: loc.maxId,
        objById: obj.byId,
        objIdsByDebug: obj.byDebug,
        objNames,
        objNameById,
        npcById: npc.byId,
        npcNames,
        locById: loc.byId,
        skills,
        prayers,
        spells,
        questNames,
        specwepDebugs,
    };
}
