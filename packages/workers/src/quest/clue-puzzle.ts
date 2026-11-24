import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { watchProductionLife } from '../../../core/src/production-life';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { parseConfigs } from '../../../knowledge/src/config';
import { clueEffect, nativeCluePoint, nativeClueStepById, nativeClueSteps } from './clues';
import { applyClick, solve, solved } from './mm-puzzle';
import { REPO_ROOT } from './types';

const root = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content');

const packCache = new Map<string, Map<string, number>>();

function pack(file: string) {
    let out = packCache.get(file);
    if (out) return out;
    const text = readFileSync(resolve(root, 'pack', file), 'utf8');
    out = new Map<string, number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < lineEnd) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) out.set(text.slice(eq + 1, lineEnd), id);
        }
        pos = end + 1;
    }
    packCache.set(file, out);
    return out;
}

let pieces: Map<number, { tile: number; family: string }> | undefined;
function nativePieces() {
    if (pieces) return pieces;
    pieces = new Map();
    const ids = pack('obj.pack');
    for (const b of parseConfigs(readFileSync(resolve(root, 'scripts/minigames/game_trail/configs/trail.obj'), 'utf8'), 'trail.obj')) {
        if (b.props.category?.[0] !== 'trail_puzzle_piece') continue;
        const family = b.name.match(/^trail_slidingpuzzle([bcd])\d+$/)?.[1];
        const id = ids.get(b.name);
        const value = b.props.param?.find((v) => v.startsWith('puzzle_piece_id,'))?.split(',')[1];
        if (family && id !== undefined && value !== undefined) pieces.set(id, { family, tile: Number(value) + 1 });
    }
    return pieces;
}

export function readNativeTrailBoard(client: unknown, family: string): number[] | null {
    const c = client as any;
    if (c?.mainModalId !== componentId('trail_puzzle')) return null;
    const com = c?.ifType?.(componentId('trail_puzzle:com_2'));
    const raw = com?.linkObjType;
    if (!raw || raw.length < 25) return null;
    const pieceMap = nativePieces();
    const b: number[] = new Array(25);
    let seenMask = 0;
    for (let i = 0; i < 25; i++) {
        const id = Number(raw[i] ?? 0) - 1;
        let tile: number;
        if (id < 0) {
            tile = 0;
        } else {
            const piece = pieceMap.get(id);
            if (!piece || piece.family !== family) return null;
            tile = piece.tile;
        }
        if (!Number.isSafeInteger(tile) || tile < 0 || tile > 24) return null;
        const bit = 1 << tile;
        if ((seenMask & bit) !== 0) return null;
        seenMask |= bit;
        b[i] = tile;
    }
    return seenMask === 0x1ffffff ? b : null;
}

export function dispatchTrailPuzzleMove(client: unknown, slot: number, expectedTile: number, family: string) {
    const c = client as any;
    const b = readNativeTrailBoard(c, family);
    const before = b?.slice();
    if (!b || !Number.isSafeInteger(slot) || slot < 0 || slot > 24 || b[slot] !== expectedTile || !applyClick(b, slot)) {
        throw Error('native trail puzzle move precondition');
    }
    const raw = c.ifType(componentId('trail_puzzle:com_2')).linkObjType[slot];
    if (typeof c.writeOpcode !== 'function' || typeof c.out?.p2 !== 'function') {
        throw Error('native trail puzzle packet surface unavailable');
    }
    c.writeOpcode(79);
    c.out.p2(raw - 1);
    c.out.p2(slot);
    c.out.p2(componentId('trail_puzzle:com_2'));
    return { success: true, before, expected: b };
}

function install(client: unknown) {
    const c = client as any;
    const original = c?.executeBotAction;
    if (typeof original !== 'function') throw Error('native puzzle executor unavailable');
    const wrapper = function (a: any) {
        return a?.type === 'trailPuzzleMove' ? dispatchTrailPuzzleMove(c, a.slot, a.tile, a.family) : original.call(c, a);
    };
    c.executeBotAction = wrapper;
    return () => {
        if (c.executeBotAction === wrapper) c.executeBotAction = original;
    };
}

type PuzzleRecipe = {
    puzzleId: number;
    name: string;
    family: string;
    clue: number;
    npc: number | undefined;
    turninSource: string | null;
    zone: ReturnType<typeof nativeCluePoint> | undefined;
};

const PUZZLE_TURNINS: Record<string, { npc: string; file: string; zone?: string }> = {
    trail_clue_hard_riddle014: { npc: 'oziach', file: 'scripts/areas/area_edgeville/scripts/oziach.rs2' },
    trail_clue_hard_riddle016: { npc: 'wilough', file: 'scripts/areas/area_varrock/scripts/wilough.rs2' },
    trail_clue_hard_riddle017: { npc: 'general_bentnoze', file: 'scripts/areas/area_falador/scripts/goblin_village/general_bentnoze.rs2' },
    trail_clue_hard_riddle018: { npc: 'lord_iorwerth', file: 'scripts/quests/quest_regicide/scripts/lord_iorwerth.rs2' },
    trail_clue_hard_riddle019: { npc: 'examiner', file: 'scripts/quests/quest_itexam/scripts/examiner.rs2' },
    trail_clue_hard_riddle020: { npc: 'duel_monk', file: 'scripts/minigames/game_duelarena/scripts/hamid.rs2' },
    trail_clue_hard_riddle021: { npc: 'gnomepilot', file: 'scripts/areas/area_gnome/scripts/gnome_glider.rs2', zone: 'sindarpos' },
    trail_clue_hard_riddle025: { npc: 'gnome_heckelfunch', file: 'scripts/areas/area_gnome/scripts/heckel_funch.rs2' },
    trail_clue_hard_riddle026: { npc: 'gnometrainer', file: 'scripts/areas/area_gnome/scripts/gnome_trainer.rs2' },
};

type PuzzleBoxIndex = {
    byPuzzleId: Map<number, { name: string; family: string }>;
    familyByBoxName: Map<string, string>;
};

let puzzleBoxIndexCache: PuzzleBoxIndex | undefined;
let gliderConstantText: string | undefined;
const puzzleRecipeCache = new Map<number, PuzzleRecipe>();

function puzzleBoxIndex(): PuzzleBoxIndex {
    if (puzzleBoxIndexCache) return puzzleBoxIndexCache;
    const ids = pack('obj.pack');
    const byPuzzleId = new Map<number, { name: string; family: string }>();
    const familyByBoxName = new Map<string, string>();
    for (const file of ['trail.obj', 'trail_hard.obj']) {
        for (const b of parseConfigs(readFileSync(resolve(root, 'scripts/minigames/game_trail/configs', file), 'utf8'), file)) {
            if (b.props.category?.[0] !== 'trail_puzzle') continue;
            const family = b.props.param?.find((v) => v.startsWith('trail_puzzle,'))?.match(/trail_puzzle([bcd])$/)?.[1];
            if (family) familyByBoxName.set(b.name, family);
            const id = ids.get(b.name);
            if (id !== undefined && family && !byPuzzleId.has(id)) {
                byPuzzleId.set(id, { name: b.name, family });
            }
        }
    }
    puzzleBoxIndexCache = { byPuzzleId, familyByBoxName };
    return puzzleBoxIndexCache;
}

export function nativePuzzleRecipe(puzzleId: number): PuzzleRecipe {
    const cached = puzzleRecipeCache.get(puzzleId);
    if (cached) return { ...cached, ...(cached.zone ? { zone: { ...cached.zone } } : {}) };
    const { byPuzzleId, familyByBoxName } = puzzleBoxIndex();
    const box = byPuzzleId.get(puzzleId);
    if (!box) throw Error('unknown native puzzle box');
    const ids = pack('obj.pack');
    const npcs = pack('npc.pack');
    const clueName = box.name.replace(/_puzzlebox$/, '');
    const clue = ids.get(clueName);
    if (clue === undefined) throw Error('native puzzle clue unresolved');
    const turn = PUZZLE_TURNINS[clueName];
    let zone: ReturnType<typeof nativeCluePoint> | undefined;
    if (turn) {
        const text = readFileSync(resolve(root, turn.file), 'utf8');
        const expectedBox = text.match(/~trail_puzzle_complete\((trail_clue_\w+_puzzlebox)\)/)?.[1];
        const expectedFamily = expectedBox ? familyByBoxName.get(expectedBox) : undefined;
        if (
            expectedFamily !== box.family ||
            !text.includes('~progress_clue_hard(' + clueName + ',') ||
            !text.includes('~give_trail_puzzle(' + box.name + ',') ||
            !text.includes('[opnpc1,' + turn.npc + ']')
        ) {
            throw Error('native puzzle turn-in handler/family changed');
        }
        if (turn.zone) {
            gliderConstantText ??= readFileSync(resolve(root, 'scripts/areas/area_gnome/configs/glider.constant'), 'utf8');
            const constant = gliderConstantText.match(new RegExp('\\^' + turn.zone + '\\s*=\\s*(\\d+_\\d+_\\d+_\\d+_\\d+)'))?.[1];
            if (!constant) throw Error('native glider clue zone unmapped');
            zone = nativeCluePoint(constant);
        }
    }
    const recipe: PuzzleRecipe = {
        puzzleId,
        name: box.name,
        family: box.family,
        clue,
        npc: turn ? npcs.get(turn.npc) : undefined,
        turninSource: turn?.file ?? null,
        zone,
    };
    puzzleRecipeCache.set(puzzleId, recipe);
    return { ...recipe, ...(recipe.zone ? { zone: { ...recipe.zone } } : {}) };
}

function boardsEqual(a: readonly number[] | null, b: readonly number[]): boolean {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export async function solveNativeCluePuzzle(
    s: Session,
    puzzleId: number,
    cap: number,
    maxNodes = 25000,
    turnInNpcIndex?: number,
    stop: () => boolean = () => false,
) {
    if (
        !Number.isSafeInteger(puzzleId) ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        !Number.isSafeInteger(maxNodes) ||
        maxNodes < 1 ||
        maxNodes > 100000 ||
        (turnInNpcIndex !== undefined && (!Number.isSafeInteger(turnInNpcIndex) || turnInNpcIndex < 0))
    ) {
        throw Error('invalid native puzzle order');
    }
    const r = nativePuzzleRecipe(puzzleId);
    const life = watchProductionLife(s, stop);
    const start = s.tick();
    const over = () => life.stopped() || s.tick() - start >= cap;
    const stock = () => s.sdk.getInventory().map((i) => ({ id: i.id, count: i.count }));
    const before = stock();
    let box = s.sdk.getInventory().find((i) => i.id === puzzleId);
    let moves = 0;
    let detail = '';
    let boardSolved = false;
    let transition = false;
    let collected = false;
    let restore: (() => void) | undefined;
    try {
        if (over()) throw Error(life.reason() || 'native puzzle budget');
        const target = () =>
            s.sdk.getState()?.nearbyNpcs.find(
                (n) =>
                    n.index === turnInNpcIndex &&
                    n.id === r.npc &&
                    (!r.zone ||
                        (s.sdk.getState()?.player?.level === r.zone.level &&
                            Math.max(Math.abs((n.tileX ?? n.x) - r.zone.x), Math.abs((n.tileZ ?? n.z) - r.zone.z)) <= 8)),
            );
        if (turnInNpcIndex !== undefined) {
            if (before.filter((i) => i.id === r.clue).reduce((n, i) => n + i.count, 0) !== 1 || !target()) {
                throw Error('stage one original clue beside exact native puzzle NPC/zone');
            }
            if (s.sdk.getInventory().length > 19) throw Error('native puzzle requires nine reward slots');
        }
        if (before.some((i) => i.id !== puzzleId && i.id !== r.clue && !!nativeClueStepById(i.id))) {
            throw Error('stage only selected native clue and puzzle; board storage is shared');
        }
        if (!box) {
            if (turnInNpcIndex === undefined || !target()) throw Error('stage native puzzle box or exact collection NPC');
            if (s.sdk.getDialog()?.isOpen || (s.client as any)?.isChatBackInputOpen?.()) {
                throw Error('native puzzle collection requires closed existing dialogue');
            }
            await s.sdk.sendInteractNpc(target()!.index, 1);
            while (!over() && !s.sdk.getInventory().some((i) => i.id === puzzleId)) {
                const d = s.sdk.getDialog();
                if (d?.isOpen) {
                    if (d.options.length === 1 && /continue/i.test(d.options[0]!.text)) await s.sdk.sendClickDialog(d.options[0]!.index);
                    else throw Error('native puzzle collection dialogue choice unmapped');
                }
                await waitTicks(s, 1);
            }
            box = s.sdk.getInventory().find((i) => i.id === puzzleId);
            if (!box) throw Error('native puzzle collection debit/credit unobserved');
            collected = true;
            await s.direct({ type: 'closeModal', reason: 'SDK' });
        }
        if (stock().filter((i) => i.id === puzzleId).reduce((n, i) => n + i.count, 0) !== 1) {
            throw Error('stage exactly one native puzzle box');
        }
        restore = install(s.client);
        await s.sdk.sendUseItem(box.slot, 1);
        if (!(await waitUntil(s, () => !!readNativeTrailBoard(s.client, r.family) || over(), { timeoutTicks: Math.min(10, cap) }))) {
            throw Error('native puzzle board not observed');
        }
        if (over()) throw Error(life.reason() || 'native puzzle budget');
        const board = readNativeTrailBoard(s.client, r.family);
        if (!board) throw Error('native puzzle board invalid');
        const path = solve(board, 1.6, maxNodes);
        if (!path) throw Error('native puzzle search node budget; board remains unchanged');
        if (path.length > cap - (s.tick() - start)) throw Error('native puzzle path exceeds tick budget; no moves dispatched');
        const sim = board.slice();
        for (const slot of path) {
            if (over()) throw Error(life.reason() || 'native puzzle tick budget');
            const observed = readNativeTrailBoard(s.client, r.family);
            if (!boardsEqual(observed, sim)) throw Error('native puzzle board drift');
            await s.direct({ type: 'trailPuzzleMove', slot, tile: sim[slot], family: r.family, reason: 'SDK' });
            applyClick(sim, slot);
            moves++;
            if (
                !(await waitUntil(s, () => boardsEqual(readNativeTrailBoard(s.client, r.family), sim) || over(), {
                    timeoutTicks: Math.min(6, Math.max(1, cap - (s.tick() - start))),
                }))
            ) {
                throw Error('native puzzle slide unobserved');
            }
        }
        const finalBoard = readNativeTrailBoard(s.client, r.family);
        boardSolved = !!finalBoard && solved(finalBoard);
        if (!boardSolved) throw Error('native puzzle solved board not observed');
        if (turnInNpcIndex !== undefined) {
            if (r.npc === undefined) throw Error('native puzzle NPC turn-in mapping missing for ' + r.name);
            if (s.sdk.getInventory().length > 19) throw Error('native puzzle turn-in requires nine reward slots');
            const npc = target();
            if (!npc) throw Error('exact native puzzle turn-in NPC/zone not nearby');
            const step = nativeClueStepById(r.clue)!;
            if (before.filter((i) => i.id === r.clue).reduce((n, i) => n + i.count, 0) !== 1) {
                throw Error('stage exactly one original native puzzle clue');
            }
            const cursor = Math.max(-1, ...(s.sdk.getState()?.gameMessages ?? []).map((m) => m.observationId ?? m.tick));
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            await s.sdk.sendInteractNpc(npc.index, 1);
            while (!over()) {
                const completed = (s.sdk.getState()?.gameMessages ?? []).some(
                    (m) => m.type === 0 && (m.observationId ?? m.tick) > cursor && /completed the Treasure Trail/.test(m.text),
                );
                transition = clueEffect(step, before, stock(), completed).ok && !stock().some((i) => i.id === puzzleId && i.count > 0);
                if (transition) break;
                const d = s.sdk.getDialog();
                if (d?.isOpen) {
                    if (d.options.length === 1 && /continue/i.test(d.options[0]!.text)) await s.sdk.sendClickDialog(d.options[0]!.index);
                    else throw Error('native puzzle turn-in dialogue choice unmapped');
                }
                await waitTicks(s, 1);
            }
            if (!transition) throw Error('native puzzle clue/reward transition unobserved');
        }
    } catch (error) {
        detail = String(error);
    } finally {
        restore?.();
    }
    detail ||= life.reason();
    void nativeClueSteps;
    const preserved = before.every(
        (i) =>
            (i.id === puzzleId && turnInNpcIndex !== undefined) ||
            (i.id === r.clue && turnInNpcIndex !== undefined) ||
            stock().filter((j) => j.id === i.id).reduce((n, j) => n + j.count, 0) >=
                before.filter((j) => j.id === i.id).reduce((n, j) => n + j.count, 0),
    );
    return {
        ok: !detail && boardSolved && preserved && (turnInNpcIndex === undefined || transition),
        puzzle: r.name,
        moves,
        boardSolved,
        transition,
        collected,
        preserved,
        ticks: s.tick() - start,
        detail,
    };
}
