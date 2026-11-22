import { mazeDoorId, mazeWalls } from './data';
import {
    CUBE, CUBE_COLOURS, CUBE_IF, CUBE_SHAPES, EMOTE_BOW, LAMP, LAMP_CONFIRM, LAMP_FIRST, LAMP_IF,
    LAMP_SKILLS, MAZE_REGION, MAZE_STATUE, MIME_ANIMS, MIME_FIRST_BUTTON, MIME_NPC, MIME_REGION,
    cheb, continueDialog, inRegion, invOf, meOf, optIndex,
    type JobSpec, type PathFinder, type Tile, type TileLevel, type WatcherContext,
} from './model';

/**
 * Cube solver: question text plus the obj ids set on the centre, side, and top model components.
 * Returns the 0-based answer button index, or -1 when the data does not decide it.
 */
export function solveCube(question: string, objs: (number | undefined)[]): number {
    const parts = objs.map(o => {
        if (o === undefined || o < 3063 || o > 3091 || (o - 3063) % 2 !== 0) return null;
        const i = (o - 3063) / 2;
        return { shape: CUBE_SHAPES[Math.floor(i / 3)]!, colour: CUBE_COLOURS[i % 3]! };
    });
    const colourQ = question.match(/what colour is the (\w+)/i);
    if (colourQ) return parts.findIndex(p => p?.shape === colourQ[1]!.toLowerCase());
    const shapeQ = question.match(/which shape is (\w+)/i);
    if (shapeQ) return parts.findIndex(p => p?.colour === shapeQ[1]!.toLowerCase());
    return -1;
}

/** Strange box solver job: opens the cube, reads the question/models, and clicks the matching button. */
export function createCubeJob(ctx: WatcherContext): JobSpec {
    let at = -99, answeredAt = -99, before = 0, answers = 0;
    return {
        name: 'strange_box', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick(), inv = invOf(st);
            const cubes = inv.filter(i => i.id === CUBE).reduce((n, i) => n + i.count, 0);
            if (cubes === 0) { ctx.say('strange_box', 'solved', `answers=${answers}`); return true; }
            const ifReader = ctx.getIfReader();
            if (!ifReader) { ctx.say('strange_box', 'no-interface-reader'); return true; }
            if (!ctx.canSend()) return false;
            if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
            if (st?.modalInterface === CUBE_IF.root && now - answeredAt >= 3) {
                const q = ifReader.text(CUBE_IF.question) ?? '';
                const pick = solveCube(q, CUBE_IF.models.map(c => ifReader.obj(c)));
                if (pick < 0) { ctx.say('strange_box', 'unreadable', JSON.stringify(q)); return true; }
                ctx.send({ type: 'clickComponent', componentId: CUBE_IF.buttons[pick] });
                before = cubes; answeredAt = now; answers++;
                ctx.say('strange_box', 'answer', `q=${JSON.stringify(q)} button=${pick + 1}`);
                return false;
            }
            if (st?.modalInterface !== CUBE_IF.root && now - at >= 4 && now - answeredAt >= 2) {
                if (answeredAt > 0 && cubes > before) ctx.say('strange_box', 'wrong-answer');
                const c = inv.find(i => i.id === CUBE)!;
                ctx.send({ type: 'useInventoryItem', slot: c.slot, optionIndex: optIndex(c.optionsWithIndex, /open/i, 1) });
                at = now;
            }
            return now - (ctx.jobs.get('strange_box')?.started ?? now) > 200;
        },
    };
}

/** Pick the skill to spend a genie lamp on from the configured skill or the highest session XP gain. */
export function lampTarget(st: any, lampSkill: string, xpStart: ReadonlyMap<string, number>): string | null {
    if (lampSkill === 'keep') return null;
    if (lampSkill !== 'auto') return LAMP_SKILLS.includes(lampSkill) ? lampSkill : null;
    let best: string | null = null, gain = 0;
    for (const k of st?.skills ?? []) {
        const n = String(k.name).toLowerCase();
        const g = (k.experience ?? 0) - (xpStart.get(n) ?? k.experience ?? 0);
        if (LAMP_SKILLS.includes(n) && g > gain) { gain = g; best = n; }
    }
    return best;
}

/** Genie XP lamp job: rubs the lamp, selects the target skill, and confirms. */
export function createLampJob(ctx: WatcherContext, skill: string): JobSpec {
    let at = -99, step = 0;
    const begin = ctx.tick();
    return {
        name: 'lamp', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick();
            const lamp = invOf(st).find(i => i.id === LAMP);
            if (!lamp) {
                if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
                ctx.say('genie', `lamp-${skill}`);
                return true;
            }
            if (now - begin > 40) { ctx.say('genie', 'lamp-failed'); return true; }
            if (!ctx.canSend() || now - at < 2) return false;
            if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
            if (st?.modalInterface === LAMP_IF) {
                ctx.send({ type: 'clickComponent', componentId: step === 0 ? LAMP_FIRST + LAMP_SKILLS.indexOf(skill) : LAMP_CONFIRM });
                step = step === 0 ? 1 : 0; at = now;
                return false;
            }
            ctx.send({ type: 'useInventoryItem', slot: lamp.slot, optionIndex: optIndex(lamp.optionsWithIndex, /rub/i, 1) });
            step = 0; at = now;
            return false;
        },
    };
}

/** Mime job: copies the mime's emote 4 times in a row until returned from the mime stage. */
export function createMimeJob(ctx: WatcherContext): JobSpec {
    let emote = -1, at = -99, clicks = 0;
    return {
        name: 'mime', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick(), p = meOf(st);
            if (!p || !inRegion(p, MIME_REGION)) { ctx.say('mime', 'returned', `clicks=${clicks}`); return true; }
            const mime = (st?.nearbyNpcs ?? []).find((n: any) => n.id === MIME_NPC);
            const i = mime ? MIME_ANIMS.indexOf(mime.animId) : -1;
            if (i >= 0) emote = i;
            const panel = st?.dialog?.isOpen && (st.dialog.allComponents ?? []).some((c: any) => c.id >= MIME_FIRST_BUTTON && c.id < MIME_FIRST_BUTTON + 8);
            if ((panel || (mime?.animId === EMOTE_BOW && emote >= 0)) && emote >= 0 && ctx.canSend() && now - at >= 3) {
                ctx.send({ type: 'clickComponent', componentId: MIME_FIRST_BUTTON + emote });
                at = now; clicks++;
                ctx.say('mime', 'emote', `i=${emote}`);
                emote = -1;
            } else if (st?.dialog?.isOpen && !panel) {
                continueDialog(st, ctx.canSend, ctx.send);
            }
            return false;
        },
    };
}

/** Expand waypoints to single steps and return the first unblocked wall-door the path crosses. */
function firstDoor(finder: PathFinder, p: TileLevel, to: Tile, blocked: any[]) {
    const pts = finder.findLongPath(p.level, p.x, p.z, to.x, to.z, 500, blocked);
    let cur = { x: p.x, z: p.z };
    const at = (q: Tile, r: Tile) => q.x === r.x && q.z === r.z;
    for (const w of pts) {
        while (cur.x !== w.x || cur.z !== w.z) {
            const next = { x: cur.x + Math.sign(w.x - cur.x), z: cur.z + Math.sign(w.z - cur.z) };
            for (const d of [finder.getDoorAt(p.level, cur.x, cur.z), finder.getDoorAt(p.level, next.x, next.z)]) {
                if (!d || blocked.some(b => b.x === d.x && b.z === d.z)) continue;
                // A straight wall on tile T, angle 0 west, 1 north, 2 east, 3 south: the step crosses it only
                // between T and its neighbour on that side.
                const [ox, oz] = [[-1, 0], [0, 1], [1, 0], [0, -1]][d.angle & 3]!;
                const side = { x: d.x + ox, z: d.z + oz };
                if ((at(cur, d) && at(next, side)) || (at(next, d) && at(cur, side))) return { door: d, before: { ...cur } };
            }
            cur = next;
        }
    }
    return null;
}

/** Maze job: routes to the centre shrine through wall-doors, blocking one-way doors, then touches the shrine. */
export function createMazeJob(ctx: WatcherContext): JobSpec {
    let at = -99, lastPos = '', moved = -99, doors = 0, shrineTries = 0;
    const blocked: any[] = [], wrongWay: any[] = [];
    let wallsRead = false;
    let lastDoor: any = null;

    return {
        name: 'maze', hold: true,
        tick() {
            const st = ctx.state(), now = ctx.tick(), p = meOf(st);
            if (!p || !inRegion(p, MAZE_REGION)) { ctx.say('maze', 'returned', `doors=${doors}`); return true; }
            if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
            if (ctx.newMessages.any(/right way/i) && lastDoor) {
                (wallsRead ? blocked : wrongWay).push(lastDoor);
                ctx.say('maze', 'wrong-way', `door=${lastDoor.x},${lastDoor.z}`);
                lastDoor = null; at = -99;
            }
            const finder = ctx.getPf();
            if (!ctx.canSend() || !finder) return false;
            if (!wallsRead) {
                wallsRead = true;
                blocked.push(...mazeWalls().map(([x, z]) => finder.getDoorAt(0, x, z)).filter(Boolean), ...wrongWay);
            }
            const pos = `${p.x},${p.z}`;
            if (pos !== lastPos) { lastPos = pos; moved = now; }
            // Act when the player has stood still for 2 ticks after the last click, or 10 ticks passed.
            if (now - at < 2 || (now - moved < 2 && now - at < 10)) return false;
            const statue = { x: MAZE_REGION.x0 + 31, z: MAZE_REGION.z0 + 31 };
            // The shrine (3x3) fills its walled room; the only way in is the wall-door on the east edge of
            // local (30,32) (maps/m45_71.jm2). Stand there, open it, then touch the shrine.
            const gate = { x: MAZE_REGION.x0 + 30, z: MAZE_REGION.z0 + 32 };
            if ((p.x === gate.x && p.z === gate.z) || inRegion(p, { x0: statue.x, x1: statue.x + 2, z0: statue.z, z1: statue.z + 2 })) {
                const touch = shrineTries++ % 2 === 1 || p.x !== gate.x;
                if (touch) ctx.send({ type: 'interactLoc', x: statue.x, z: statue.z, locId: MAZE_STATUE, optionIndex: 1 });
                else ctx.send({ type: 'interactLoc', x: gate.x, z: gate.z, locId: mazeDoorId(gate.x, gate.z) ?? 3628, optionIndex: 1 });
                at = now;
                ctx.say('maze', touch ? 'shrine' : 'gate', `from=${p.x},${p.z}`);
                return false;
            }
            const hit = firstDoor(finder, p, gate, blocked);
            if (!hit) { ctx.send({ type: 'walkTo', x: gate.x, z: gate.z, running: true }); at = now; return false; }
            const { door, before } = hit;
            if (cheb(p, before) > 10) { ctx.send({ type: 'walkTo', x: before.x, z: before.z, running: true }); at = now; return false; }
            const loc = (st?.nearbyLocs ?? []).find((l: any) => l.x === door.x && l.z === door.z && l.options?.some((o: string) => /open/i.test(o)));
            ctx.send({ type: 'interactLoc', x: door.x, z: door.z, locId: loc?.id ?? mazeDoorId(door.x, door.z) ?? 3628, optionIndex: 1 });
            lastDoor = door; doors++; at = now;
            ctx.say('maze', 'door', `at=${door.x},${door.z} from=${p.x},${p.z}`);
            return false;
        },
    };
}
