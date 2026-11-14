import type { ConfigBlock } from './config';
import { invert } from './items';

// Every item that can be worn, from its own config block: slot, the bonuses of the equipment screen, attack speed and
// range, the bow and arrow tier, the special attack, and what it takes to wear (levelrequire/scripts/tier*.rs2).
export const BONUS_PARAMS = {
    stabattack: 'stabAttack', slashattack: 'slashAttack', crushattack: 'crushAttack', magicattack: 'magicAttack', rangeattack: 'rangeAttack',
    stabdefence: 'stabDefence', slashdefence: 'slashDefence', crushdefence: 'crushDefence', magicdefence: 'magicDefence', rangedefence: 'rangeDefence',
    strengthbonus: 'strength', rangebonus: 'rangeStrength', prayerbonus: 'prayer',
} as const;
export type Bonus = (typeof BONUS_PARAMS)[keyof typeof BONUS_PARAMS];
export const BONUSES = Object.values(BONUS_PARAMS) as Bonus[];
export type Skill = 'attack' | 'strength' | 'defence' | 'ranged' | 'magic';

export interface Gear {
    id: number;
    debugname: string;
    name: string;
    slot: string; // wearpos
    covers: string[]; // wearpos2/wearpos3: slots this item also takes (a two-handed weapon covers lefthand)
    bonuses: Record<Bonus, number>; // 0 where the config gives none
    attackRate?: number; // ticks between attacks (param attackrate)
    attackRange?: number; // tiles (param attackrange)
    tier?: number; // param levelrequire: a bow fires arrows of its tier or lower (player_ranged.rs2:97)
    special?: { energy: number; pvp: boolean }; // param sa_energy (of 1000); pvp: pvp_special_attack.rs2 has a case
    requires: { skills: Partial<Record<Skill, number>>; quest?: string; note?: string; src?: string };
    members: boolean;
    tradeable: boolean;
    cost: number;
    staffOnly?: boolean; // named next to a staffmodlevel check (appearance.rs2: poisoned_dagger_p, every bonus 255)
    src: string; // the [debugname] header line
}

// Items a script names on a line that checks staffmodlevel: kit for the server's staff, not for players.
export function parseStaffItems(files: readonly { text: string }[]): Set<string> {
    const out = new Set<string>();
    for (const { text } of files) for (const line of text.split(/\r?\n/)) if (/staffmodlevel/.test(line)) for (const m of line.matchAll(/=\s*([a-z0-9_]+)\s*\)/g)) out.add(m[1]!);
    return out;
}

// The quests the levelrequire labels name (levelrequire.rs2: each checks that quest's varp before the levels).
const QUESTS: Record<string, string> = {
    zanaris: 'Lost City', heroes: "Heroes' Quest", regicide: 'Regicide', legends: "Legends' Quest", dragon_slayer: 'Dragon Slayer', viking: 'The Fremennik Trials',
};
const SKILLS: readonly Skill[] = ['attack', 'strength', 'defence', 'ranged', 'magic'];

// `[opheld2,<item>] @levelrequire_<label>(<levels...>, last_slot);` -> the levels in the order the label names its skills.
export function parseRequirements(files: readonly { text: string; file: string }[]): Map<string, Gear['requires']> {
    const out = new Map<string, Gear['requires']>();
    for (const { text, file } of files) {
        text.split(/\r?\n/).forEach((line, i) => {
            const m = /^\[opheld2,(\w+)\]\s*@levelrequire_(\w+)\(([^)]*)\)/.exec(line);
            if (!m) return;
            const [, item, label, argText] = m;
            const args = argText!.split(',').map(a => a.trim()).filter(a => a !== 'last_slot').map(Number);
            const src = `${file}:${i + 1}`;
            if (label === 'iban_staff') { out.set(item!, { skills: { magic: 50, attack: 50 }, note: 'Iban staff', src }); return; }
            const questKey = Object.keys(QUESTS).find(k => label!.startsWith(`${k}_quest`) || (k === 'viking' && label!.startsWith('viking_quest')));
            const skills = label!.split('_').filter((t): t is Skill => (SKILLS as readonly string[]).includes(t));
            const req: Gear['requires'] = { skills: {}, src };
            skills.forEach((s, j) => { if (Number.isFinite(args[j])) req.skills[s] = args[j]!; });
            if (questKey) req.quest = QUESTS[questKey];
            out.set(item!, req);
        });
    }
    return out;
}

// The weapons with a case in pvp_special_attack.rs2's switch_obj.
export function parsePvpSpecials(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.matchAll(/case ([\w, ]+) : @/g)) for (const n of m[1]!.split(',')) out.add(n.trim());
    return out;
}

// The default= of each param block (.param files): a param an item does not set takes it (combat.param: attackrate
// 4, attackrange 0, sa_energy 1000).
export function paramDefaults(blocks: ConfigBlock[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const b of blocks) { const d = b.props.default?.[0]; if (d !== undefined && /^-?\d+$/.test(d)) out.set(b.name, Number(d)); }
    return out;
}

export function buildGear(blocks: ConfigBlock[], pack: Map<number, string>, requirements: Map<string, Gear['requires']>, pvpSpecials: Set<string>, defaults = new Map<string, number>(), staff = new Set<string>()): Gear[] {
    const ids = invert(pack);
    const out: Gear[] = [];
    for (const b of blocks) {
        const slot = b.props.wearpos?.[0];
        const id = ids.get(b.name);
        if (!slot || id === undefined) continue;
        const bonuses = Object.fromEntries(BONUSES.map(k => [k, 0])) as Record<Bonus, number>;
        const param = (key: string) => { const v = b.props.param?.find(p => p.startsWith(key + ',')); return v === undefined ? undefined : Number(v.slice(key.length + 1)); };
        for (const [key, name] of Object.entries(BONUS_PARAMS)) bonuses[name] = param(key) ?? 0;
        // A special weapon with no sa_energy costs the param's default; a weapon with no attackrate attacks at its default.
        const special = pvpSpecials.has(b.name) || param('sa_energy') !== undefined;
        const energy = special ? param('sa_energy') ?? defaults.get('sa_energy') : undefined;
        const weapon = slot === 'righthand';
        out.push({
            id, debugname: b.name, name: b.props.name?.[0] ?? b.name, slot,
            covers: [b.props.wearpos2?.[0], b.props.wearpos3?.[0]].filter((x): x is string => !!x),
            bonuses,
            ...(param('attackrate') !== undefined || weapon ? { attackRate: param('attackrate') ?? defaults.get('attackrate') ?? 4 } : {}),
            ...(param('attackrange') !== undefined ? { attackRange: param('attackrange') } : {}),
            ...(param('levelrequire') !== undefined ? { tier: param('levelrequire') } : {}),
            ...(energy !== undefined ? { special: { energy, pvp: pvpSpecials.has(b.name) } } : {}),
            requires: requirements.get(b.name) ?? { skills: {} },
            members: b.props.members?.[0] === 'yes',
            tradeable: b.props.tradeable?.[0] !== 'no',
            cost: Number(b.props.cost?.[0] ?? 1),
            ...(staff.has(b.name) ? { staffOnly: true } : {}),
            src: `${b.file}:${b.line}`,
        });
    }
    return out.sort((a, b) => a.id - b.id);
}
