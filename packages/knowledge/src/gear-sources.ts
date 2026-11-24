// Where a wearable item comes from other than a shop stock line, read from the scripts:
//   npc: `inv_add(inv, <item>, n)` in a script file that has an `[opnpc<n>,<npc>]` trigger. A coin check just above it
//        (`inv_del(inv, coins, <n>)`) is the price. The gate is the first `if` line of that NPC trigger.
//   quest: the same call in a quest folder with no price (a reward or a step item), or in a `[queue,*complete*]` block.
//   clue: `inv_add(trail_rewardinv, <item>, n)` in the clue scroll reward procs (minigames/game_trail).
//   shopNpcs: the NPCs whose config names a shop (`param=owned_shop,<inv>`) with their spawn tiles.
// A gate that the scripts keep in a varp and stage is kept as text: it names a quest only when the file is in that
// quest's folder or the text holds that quest's own varp. A row whose gate names no quest, and a free row with no gate,
// are left out. A call that follows the loss of another item (an exchange) is left out.
// The gate text is the first `if` of the trigger, so it can be a gate for another branch of the dialogue; the quest is
// then the quest of the whole file, and the account must have completed it.
import type { ConfigBlock } from './config';

export interface NpcGate { text: string; src: string; quest?: string }
export interface NpcSource { npc: string; item: string; id: number; cost: number; gate?: NpcGate; src: string; at?: { x: number; z: number; level: number }[] }
export interface QuestSource { quest: string; item: string; id: number; src: string }
export interface ClueSource { tier: string; item: string; id: number; src: string }
export interface ShopNpc { shop: string; npc: string; spawns: { x: number; z: number; level: number }[] }
export interface GearSources { npc: NpcSource[]; quest: QuestSource[]; clue: ClueSource[]; shopNpcs: ShopNpc[] }

const SKIP_DIRS = /\/(_test|_unpack|tutorial|macro events|holidayevents|player)\//;
const HEAD = /^\[(\w+),([^\],]+)\]/;
const COIN_PRICE = /inv_del\(inv, coins, (\d+)\)/;

export interface QuestNames { folderToName: ReadonlyMap<string, string>; varpToName: ReadonlyMap<string, string> }

/** The quest name of a quest folder or varp: the quest list name, or the folder when the list has none. */
export function questNames(quests: readonly { varp: string; folder: string | null }[], listNames: ReadonlyMap<string, string>): QuestNames {
    const folderToName = new Map<string, string>(), varpToName = new Map<string, string>();
    for (const q of quests) {
        const folder = q.folder ?? '';
        const name = listNames.get(q.varp) ?? listNames.get(folder.replace(/^quest_/, '')) ?? folder;
        if (folder) folderToName.set(folder, name);
        varpToName.set(q.varp, name);
    }
    return { folderToName, varpToName };
}

export function parseScriptSources(files: readonly { text: string; file: string }[], itemIds: ReadonlyMap<string, number>, names: QuestNames): Pick<GearSources, 'npc' | 'quest' | 'clue'> {
    const npc: NpcSource[] = [], quest: QuestSource[] = [], clue: ClueSource[] = [];
    for (const { text, file } of files) {
        if (SKIP_DIRS.test(`/${file}`)) continue;
        if (!text.includes('inv_add(')) continue;
        const lines = text.split(/\r?\n/);
        const folder = /\/(quest_\w+)\//.exec(file)?.[1];
        const trail = /\/game_trail\/scripts\/(?:(\w+)\/)?/.exec(file);
        // The first NPC trigger of the file: the labels below it are its dialogue.
        let npcName: string | undefined, npcHead = -1;
        lines.forEach((l, i) => {
            const m = HEAD.exec(l);
            if (npcName === undefined && m && /^opnpc\d$/.test(m[1]!) && !m[2]!.startsWith('_')) { npcName = m[2]!; npcHead = i; }
        });
        let gate: NpcGate | undefined;
        if (npcHead >= 0) {
            for (let j = npcHead + 1; j < lines.length && !lines[j]!.startsWith('['); j++) {
                const m = /^\s*(?:\}\s*else\s*)?if\s*\((.*)\)\s*\{?\s*$/.exec(lines[j]!);
                if (!m) continue;
                const body = m[1]!;
                const varps = [...body.matchAll(/%(\w+)/g)].map(x => x[1]!);
                const quest = folder ? names.folderToName.get(folder) : varps.map(v => names.varpToName.get(v)).find(Boolean);
                gate = { text: body.trim(), src: `${file}:${j + 1}`, ...(quest ? { quest } : {}) };
                break;
            }
        }
        let head: RegExpExecArray | null = null, headAt = 0;
        lines.forEach((l, i) => {
            const h = HEAD.exec(l);
            if (h) { head = h; headAt = i; }
            if (trail) {
                const t = /inv_add\(trail_rewardinv, (\w+)/.exec(l);
                const id = t ? itemIds.get(t[1]!) : undefined;
                if (t && id !== undefined) clue.push({ tier: trail[1] ?? 'trail', item: t[1]!, id, src: `${file}:${i + 1}` });
                return;
            }
            const m = /inv_add\(inv, (\w+)/.exec(l);
            const id = m ? itemIds.get(m[1]!) : undefined;
            if (!m || id === undefined) return;
            let cost: number | undefined, exchange = false;
            for (let j = i - 1; j >= Math.max(headAt, i - 10); j--) {
                const c = COIN_PRICE.exec(lines[j]!);
                if (c && cost === undefined) cost = Number(c[1]);
                // Another item taken in the same step makes the call an exchange (a smith's or a swap), not a sale.
                const d = /inv_del\(inv, (\w+)/.exec(lines[j]!);
                if (d && d[1] !== 'coins') exchange = true;
            }
            const src = `${file}:${i + 1}`;
            const trigger = head?.[1], isComplete = trigger === 'queue' && /complete/.test(head![2]!);
            if (isComplete || (cost === undefined && folder)) {
                const q = folder ? names.folderToName.get(folder) : undefined;
                if (q) quest.push({ quest: q, item: m[1]!, id, src });
            } else if (npcName !== undefined && !exchange && (trigger === 'label' || /^opnpc\d$/.test(trigger ?? ''))
                // A sale with no gate text, or any row whose gate names a quest. A gate that the scripts keep in other
                // state (a held clue, a dialogue choice) is not understood, so its row is left out.
                && (gate ? gate.quest !== undefined : cost !== undefined)) {
                // An NPC of a quest folder with no `if` in its trigger still belongs to that quest.
                const questName = folder ? names.folderToName.get(folder) : undefined;
                const g = gate ?? (questName ? { text: 'quest folder', src, quest: questName } : undefined);
                npc.push({ npc: npcName, item: m[1]!, id, cost: cost ?? 0, ...(g ? { gate: g } : {}), src });
            }
        });
    }
    return { npc, quest, clue };
}

/** The NPCs that own a shop, with their spawn tiles. */
export function parseShopNpcs(blocks: readonly ConfigBlock[], spawnsOf: (debugname: string) => { x: number; z: number; level: number }[]): ShopNpc[] {
    const out: ShopNpc[] = [];
    for (const b of blocks) {
        for (const p of b.props.param ?? []) {
            const m = /^owned_shop,(\w+)$/.exec(p);
            if (m) out.push({ shop: m[1]!, npc: b.name, spawns: spawnsOf(b.name) });
        }
    }
    return out.sort((a, b) => a.shop.localeCompare(b.shop) || a.npc.localeCompare(b.npc));
}
