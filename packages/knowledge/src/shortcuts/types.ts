import type { ConfigBlock } from '../config';
import type { DbRow, DbTable } from '../dbtables';
import type { LocSpawn } from '../jm2';

export type Coord = { x: number; z: number; level: number };
export type ShortcutKind = 'shortcut' | 'course' | 'passage' | 'quest' | 'minigame' | 'tutorial';
export interface SkillNeed { name: string; level: number; src: string }
export interface VarpNeed { varp: string; op: string; value: number | string; quest: boolean; src: string }
export interface ItemNeed { item: string; op: string; count: number | string; src: string }
export interface Requirements {
    skill?: { name: string; level: number }; // highest skill need, in the TransportRequirements shape
    skills?: SkillNeed[];
    varps?: VarpNeed[];
    items?: ItemNeed[]; // inv_total(inv, item)
    worn?: ItemNeed[]; // inv_total(worn, item)
    useItem?: { item: string; src: string }; // oplocu: item used on the loc
    coins?: number; // coins that must be held
}
export interface Failure { stat: string; low: number; high: number; src: string; to: Coord | null; exact: boolean; damage: string[] }
export interface ShortcutEdge {
    kind: ShortcutKind;
    locName: string;
    id: number;
    option: string; // op1..op5 or opu
    optionText: string | null;
    from: Coord; // placed loc tile
    to: Coord;
    exact: boolean; // false: `to` uses the approximate player start (loc tile) plus a player-relative offset
    requires?: Requirements;
    fee?: number; // coins removed by inv_del
    consumes?: string[];
    side?: string[]; // player-position conditions this edge assumes, e.g. `coordx(coord) > coordx(loc_coord) = false`
    choices?: string[]; // dialogue choices taken
    conditions?: string[]; // world or state conditions this edge assumes (npc_find, timers, non-quest varps)
    failure?: Failure;
    via?: { locName: string; option: string; src: string }; // closed loc whose option changes it into this loc
    twoWay: boolean; // another edge leaves within 3 tiles of `to` and lands within 3 tiles of `from`
    src: string; // placement line in maps/
    toSrc: string; // script line of the last movement
    handler: string; // trigger header line
    requireSrc?: string[];
}
export interface ShortcutGap { locName: string; option: string; handler: string; src: string; gap: string }

export interface Line { text: string; line: number }
export interface Script { type: string; name: string; params: { type: string; name: string }[]; body: Line[]; file: string; line: number }

export type Tok = { k: 'num' | 'coord' | 'str' | 'id' | 'var' | 'varp' | 'const' | 'proc' | 'label' | 'sym'; v: string; line: number };
export class Unsupported extends Error {}

export type Expr =
    | { k: 'num'; v: number } | { k: 'coord'; v: string } | { k: 'str'; v: string }
    | { k: 'var'; n: string } | { k: 'varp'; n: string } | { k: 'const'; n: string } | { k: 'id'; n: string }
    | { k: 'call'; n: string; args: Expr[]; proc: boolean; line: number }
    | { k: 'bin'; op: string; a: Expr; b: Expr } | { k: 'neg'; a: Expr };

export type Stmt =
    | { k: 'expr'; e: Expr; line: number }
    | { k: 'if'; c: Expr; then: Stmt[]; else?: Stmt[]; line: number }
    | { k: 'switch'; e: Expr; cases: { labels: (Expr | 'default')[]; body: Stmt[]; line: number }[]; line: number }
    | { k: 'while'; line: number }
    | { k: 'return'; es: Expr[]; line: number }
    | { k: 'def'; n: string; e?: Expr; line: number }
    | { k: 'assign'; targets: { n: string; local: boolean }[]; e: Expr; line: number }
    | { k: 'jump'; n: string; args: Expr[]; line: number };

export type Cls = 'skill' | 'item' | 'worn' | 'varp' | 'useitem' | 'side' | 'random' | 'choice' | 'dynamic';
export type Sym = { t: 'sym'; cls: Cls; text: string; line: number; meta?: { stat?: string; low?: number; high?: number; item?: string; varp?: string; skill?: string } };
export type V =
    | { t: 'int'; v: number; approx?: true } | { t: 'coord'; c: Coord; exact: boolean } | { t: 'bool'; v: boolean }
    | { t: 'name'; v: string } | { t: 'str' } | Sym
    | { t: 'cond'; sym: Sym; op: string; rhs: V; text: string; line: number }
    | { t: 'unk'; why: string }
    | { t: 'tuple'; vs: V[] };

export interface Placement { locName: string; id: number; x: number; z: number; level: number; shape: number; angle: number; src: string; via?: { locName: string; option: string; src: string } }
export interface Assumption { key: string; value: string; sym: Sym; detail: string; line: number; file: string }
export interface RunState {
    pos: { c: Coord; exact: boolean } | null; posWhy?: string;
    moved: boolean; moveSrc?: string;
    fee: number; consumes: string[]; damage: string[]; changes: { locName: string; line: string }[];
    queued: Script[]; steps: number;
}
export interface RunResult { assumptions: Assumption[]; st: RunState }
export interface Built { requires: Requirements; side: string[]; choices: string[]; conditions: string[]; requireSrc: string[]; failure?: { a: Assumption } }

export interface Ctx {
    scripts: Map<string, Script>;
    constants: Map<string, { value: string; src: string }>;
    locConfigs: Map<string, ConfigBlock>;
    paramTypes: Map<string, string>;
    questVarps: Set<string>;
    moving: Set<string>; // script keys whose body (transitively) moves the player
    ast: Map<string, Stmt[]>;
    db: Map<string, DbRow[]>;
}

export interface BuildInput {
    scriptFiles: { text: string; file: string }[];
    constantFiles: { text: string; file: string }[];
    locConfigs: Map<string, ConfigBlock>;
    locPack: Map<number, string>;
    locs: LocSpawn[];
    questVarps: Set<string>;
    excludeLocNames: Set<string>; // covered by transports.json or doors.json
    dbTables: DbTable[];
}
export interface BuildOutput { edges: ShortcutEdge[]; gaps: ShortcutGap[]; handlers: number }
