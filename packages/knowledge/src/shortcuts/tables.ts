import type { Script } from './types';

export const MOVE_PROCS: Record<string, { dest?: number; rel?: [number, number]; damage?: number }> = {
    forcemove: { dest: 0 }, forcewalk: { dest: 0 }, forcewalk2: { dest: 0 }, agility_force_move: { dest: 2 },
    agility_walk: { rel: [0, 1] }, clipped_telewalk: { rel: [0, 1] },
    agility_exactmove: { dest: 4 }, agility_climb_up: { dest: 1 }, climb_ladder: { dest: 0 },
    agility_instant_fail: { dest: 0, damage: 1 }, agility_delay_fail: { dest: 1, damage: 2 },
};
export const MOVE_CMDS: Record<string, number> = { p_telejump: 0, p_teleport: 0, p_walk: 0, p_exactmove: 1 };
export const DAMAGE_PROCS = new Set(['damage_self']);
export const QUEUE_CMDS = /^(queue|weakqueue|strongqueue|longqueue)$/;
export const OP_NEG: Record<string, string> = { '=': '!', '!': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
export const MAX_RUNS = 256;
export const MAX_CAPPED = 3; // placements of one handler that may hit MAX_RUNS before the rest of its placements are skipped
export const MAX_STEPS = 20000;

export const EXPR_PREC: Record<string, number> = {
    '|': 1, '&': 2, '=': 3, '!': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5,
};

// Loc shape names in index order (server/engine/tools/pack/Compiler.ts, locshapeInfo).
export const LOC_SHAPES = [
    'wall_straight', 'wall_diagonalcorner', 'wall_l', 'wall_squarecorner', 'walldecor_straight_nooffset', 'walldecor_straight_offset',
    'walldecor_diagonal_offset', 'walldecor_diagonal_nooffset', 'walldecor_diagonal_both', 'wall_diagonal', 'centrepiece_straight', 'centrepiece_diagonal',
    'roof_straight', 'roof_diagonal_with_roofedge', 'roof_diagonal', 'roof_l_concave', 'roof_l_convex', 'roof_flat', 'roofedge_straight',
    'roofedge_diagonalcorner', 'roofedge_l', 'roofedge_squarecorner', 'grounddecor',
];

// Random events are off on this server; doors.json owns door and gate opening.
export const SKIP_CALL_FILE = /^scripts\/(macro events|doors)\//;
export const SKIP_CALL_NAME = /^(open_and_close_\w+|open_door\w*|close_door\w*|open_gate\w*|close_gate\w*|doubledoor\w*|open_double\w*|open_outer_gate)$/;
export const SKIP_VALUE_FILE = /^scripts\/macro events\//;

export const MOVE_TEXT = /\b(p_telejump|p_teleport|p_exactmove|p_walk)\s*\(|~(forcemove|forcewalk2?|agility_\w+|clipped_telewalk|climb_ladder)\s*\(/;
export const OPS = ['oploc1', 'oploc2', 'oploc3', 'oploc4', 'oploc5', 'oplocu'] as const;

export const skipCall = (s: Script): boolean => SKIP_CALL_FILE.test(s.file) || SKIP_CALL_NAME.test(s.name);

// Ladders and stairs are in transports.json, doors in doors.json. Gathering, processing and leaning scripts
// step the player next to the loc; they are not transport.
export const skipBuildFile = (f: string): boolean =>
    /^scripts\/(ladders\+stairs|macro events|doors)\//.test(f)
    || /^scripts\/skill_(?!agility|runecraft)/.test(f)
    || /general_use\/scripts\/(pickables|spade|water_sources|shear_sheep|windmills|haybales)\.rs2$/.test(f)
    || /game_duelarena\/scripts\/duel_arena_lean\.rs2$/.test(f);
