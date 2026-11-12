import { cleanLines } from './text';

export type DoorKind = 'open' | 'one_way' | 'key' | 'quest' | 'skill' | 'team' | 'locked' | 'conditional' | 'unknown';
export interface DoorNeed { skill?: string; level?: number; varp?: string; item?: string; side?: string; worn?:string; whenAxis?:boolean; minimum?:number;team?:0|1 }
export interface OpenDoorVariant {id:number;x:number;z:number;level:number;angle:number}
// Pinned doubledoors.rs2 uses door_open's straight-wall offset, then +3 for
// the left leaf and +1 for the right leaf. The pack/config supplies the ID.
export function openedTeamDoor(loc:string,at:{x:number;z:number;level:number;angle:number},id:number):OpenDoorVariant|undefined {
 const match=loc.match(/^castlewars_(?:saradomin|zamorak)_maindoor([lr])$/);if(!match||!Number.isInteger(at.angle)||at.angle<0||at.angle>3)return;
 const delta=[[-1,0],[0,1],[1,0],[0,-1]][at.angle]!;
 return {id,x:at.x+delta[0]!,z:at.z+delta[1]!,level:at.level,angle:(at.angle+(match[1]==='l'?3:1))%4};
}
export interface Trigger { body: string; src: string }
export type Triggers = Map<string, Trigger>; // key: `<type>,<name>`, e.g. `oploc1,brasskeydoor`, `label,open_x`

// Reads every [type,name] block from RuneScript files. A body runs to the next line that starts with `[`.
// A one-line trigger (`[oploc1,x] @label;`) keeps the text after the header as its body.
export function parseTriggers(files: { text: string; file: string }[]): Triggers {
    const out: Triggers = new Map();
    for (const { text, file } of files) {
        const lines = cleanLines(text);
        let key: string | null = null;
        let start = 0;
        let body: string[] = [];
        const flush = () => { if (key && !out.has(key)) out.set(key, { body: body.join('\n'), src: `${file}:${start}` }); };
        lines.forEach((l, i) => {
            const m = l.match(/^\[(\w+),([^\]]+)\](.*)$/);
            if (m) {
                flush();
                key = `${m[1]},${m[2]}`;
                start = i + 1;
                body = m[3]!.trim() ? [m[3]!.trim()] : [];
            } else if (key) {
                body.push(l);
            }
        });
        flush();
    }
    return out;
}

const REFUSAL = /(mes|mesbox|chatnpc\w*)\(.*(locked|won't|can't|cannot|not experienced|need|isn't)/i;
const OPEN_PROC = /~(open_door|open_door_reversed|open_and_close_door\w*|open_and_close_double\w*|doubledoor\w*|open_double\w*|open_gate|open_outer_gate)\b/i;

// Follows one `@label` or `~proc` call that the trigger body makes, so checks inside it count.
function expand(body: string, t: Triggers): string {
    let out = body;
    for (const m of body.matchAll(/@(\w+)/g)) out += '\n' + (t.get(`label,${m[1]}`)?.body ?? '');
    for (const m of body.matchAll(/~(\w+)/g)) {
        if (OPEN_PROC.test(`~${m[1]}`)) continue;
        out += '\n' + (t.get(`proc,${m[1]}`)?.body ?? '');
    }
    return out;
}

export function classifyDoor(loc: string, category: string | undefined, t: Triggers): { kind: DoorKind; need?: DoorNeed; trigger: string } {
    const trig = t.get(`oploc1,${loc}`) ?? (category ? t.get(`oploc1,_${category}`) : undefined);
    const useTrig = t.get(`oplocu,${loc}`);
    if (!trig && !useTrig) return { kind: 'unknown', trigger: '' };
    const src = trig?.src ?? useTrig!.src;
    const body = trig ? expand(trig.body, t) : '';
    const cw=loc.match(/^castlewars_(saradomin|zamorak)_maindoor[lr]$/);
    if(cw){const enemy=cw[1]==='saradomin'?'zamorak':'saradomin';if(body.includes(`%castlewars_team = ^castlewars_team_${enemy}`)&&/~check_axis_locactive\(coord\) = true/.test(body)&&/It's shut, you'll have to break it down\./.test(body))return {kind:'team',need:{team:cw[1]==='saradomin'?0:1,whenAxis:true},trigger:src};}
    // These thresholds are pinned quest constants, not generic varp truthiness.
    if(loc==='championdoor'&&/%qp\s*<\s*32/.test(body))return {kind:'quest',need:{varp:'qp',minimum:32},trigger:src};
    if(/^herodoor_[lr]$/.test(loc)&&/%heroquest\s*>=\s*\^hero_complete/.test(body))return {kind:'quest',need:{varp:'heroquest',minimum:15},trigger:src};
    if(/^legendsguilddoor[lr]$/.test(loc)&&/%legendsquest\s*>=\s*\^legends_returned_to_radimus/.test(body))return {kind:'quest',need:{varp:'legendsquest',minimum:50},trigger:src};
    if(/^legendsguildgate[lr]$/.test(loc)&&/%legendsquest\s*>\s*\^legends_not_started/.test(body)&&/if\s*\(\$entering = false\)/.test(body))return {kind:'quest',need:{varp:'legendsquest',minimum:1,whenAxis:true},trigger:src};
    // The goblin keep gate under the Observatory refuses only a player north of it, and only while its lock varp is 0
    // (quest_itgronigen.rs2, _observatory_dungeon_gate). The gate is a wall on the north edge of its tile (shape 0,
    // angle 1), so the refused player is not on the gate's own tile: whenAxis is false. The way out to the north stays open.
    if(/^keepgate_closed(?:_left)?$/.test(loc)&&/%itkeepgatelock\s*=\s*0\s*&\s*coordz\(coord\)\s*>\s*coordz\(loc_coord\)/.test(body))return {kind:'quest',need:{varp:'itkeepgatelock',minimum:1,whenAxis:false},trigger:src};

    if (useTrig && /last_useitem|inv_total/.test(useTrig.body)) {
        const item = [...useTrig.body.matchAll(/case\s+(\w+)\s*:/g)].map(m => m[1]!).find(c => c !== 'default');
        // The Phoenix hideout door (quest_blackarmgang.rs2 unlock_weaponstore_door) sets `$leaving = ~check_axis(...)`
        // and refuses only `if($leaving = false & $key_used = false)`: the leaving side opens with no key.
        const alias = body.match(/def_boolean\s+\$(\w+)\s*=\s*~check_axis(?:_locactive)?\([^;]+\);/);
        const guard = alias ? body.match(new RegExp('if\\s*\\(\\s*\\$' + alias[1] + '\\s*=\\s*(true|false)\\s*&[^)]*\\)\\s*\\{\\s*mes\\("[^"]*locked')) : null;
        const need: DoorNeed = { ...(item ? { item } : {}), ...(guard ? { whenAxis: guard[1] === 'true' } : {}) };
        return { kind: 'key', need: Object.keys(need).length ? need : undefined, trigger: src };
    }
    const skill = body.match(/stat\((\w+)\)\s*<\s*(\d+)/);
    if (skill) {
        const worn=body.match(/inv_total\(worn,\s*(\w+)\)\s*<\s*1/);
        const alias=body.match(/def_boolean\s+\$(\w+)\s*=\s*~check_axis(?:_locactive)?\([^;]+\);/);
        const aliasGuard=alias?body.match(new RegExp('if\\s*\\(\\s*\\$'+alias[1]+'\\s*=\\s*(true|false)\\b')):null;
        const directGuard=/if\s*\(\s*~check_axis\([^)]*\)\s*=\s*true\s*\)/.test(body);
        const whenAxis=directGuard?true:aliasGuard?aliasGuard[1]==='true':undefined;
        return {kind:'skill',need:{skill:skill[1],level:Number(skill[2]),...(worn?{worn:worn[1]}:{}),...(whenAxis!==undefined?{whenAxis}:{})},trigger:src};
    }
    const varp = body.match(/%(\w+)/);
    // A quest check inside `if (~check_axis(...) = true)` refuses only the entering side (sheepherder_gate.rs2:
    // leaving the plague-sheep pen is never checked); whenAxis lets the route keep it shut one way only.
    if (varp && REFUSAL.test(body)) return { kind: 'quest', need: { varp: varp[1], ...(/if\s*\(\s*~check_axis\([^)]*\)\s*=\s*true\s*\)/.test(body) ? { whenAxis: true } : {}) }, trigger: src };
    const side = body.match(/coord([xz])\(coord\)\s*([<>]=?)\s*coord[xz]\(loc_coord\)/);
    if (side && REFUSAL.test(body)) return { kind: 'one_way', need: { side: `refuses when player ${side[1]} ${side[2]} door ${side[1]}` }, trigger: src };
    // Open and refusal branches are not an unconditional Open operation. The thieving-door
    // handler takes an axis-derived entering flag, aliases it to locked, and may invert it via DB.
    // Do not guess a cardinal permitted side without the DB row and loc angle.
    if (OPEN_PROC.test(body) && REFUSAL.test(body)) {
        const axis = /~check_axis(?:_locactive)?\s*\(/.test(body);
        const enteringLock = /boolean\s+\$entering\b/.test(body)
            && /def_boolean\s+\$locked\s*=\s*\$entering\b/.test(body)
            && /if\s*\(\s*\$locked\s*=\s*true\s*\)/.test(body);
        if (axis && enteringLock) return { kind: 'one_way', need: { side: 'Open depends on entering side; locked_door.lock_inversed determines orientation' }, trigger: src };
        return { kind: 'conditional', trigger: src };
    }
    if (OPEN_PROC.test(body)) return { kind: 'open', trigger: src };
    if (REFUSAL.test(body)) return { kind: 'locked', trigger: src };
    return { kind: 'unknown', trigger: src };
}
