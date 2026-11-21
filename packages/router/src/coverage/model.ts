import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfigs } from '../../../knowledge/src/config';
import { QUEST_SOURCE } from '../../../core/src/quest-status';

export const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'] as const;
export const BANDS = [[1, 40], [40, 70], [70, 99]] as const;
export type Stage = 'none' | 'named' | 'practice' | 'live';
const RANK: Record<Stage, number> = { none: 0, named: 1, practice: 2, live: 3 };
export const better = (a: Stage, b: Stage): Stage => (RANK[a] >= RANK[b] ? a : b);

export type Held = { id?: number; baseId?: number; count?: number }[];
export interface Status { name?: string; server?: string; at?: number; skills?: { name: string; level: number }[]; quests?: { name: string; state: string }[]; bank?: Held | null; inventory?: Held | null; equipment?: Held | null }
export interface SideAccount { side: string; name: string; at: number; skills: { name: string; level: number }[]; quests?: string[]; bank?: Held | null; inventory?: Held | null; equipment?: Held | null }

// Our script for a quest folder: quest-<folder without quest_ and underscores>.ts unless named otherwise.
const SCRIPT_ALIAS: Record<string, string> = { quest_romeojuliet: 'quest-rj.ts', quest_scorpcatcher: 'quest-scorpion.ts', quest_blackarmgang: 'quest-arrav.ts',
    quest_arthur: 'quest-merlin.ts', quest_mcannon: 'dwarfcannon.ts', quest_itexam: 'quest-dig.ts', quest_waterfall: 'waterfall.ts', quest_elemental_workshop: 'quest-elemental.ts' };
export const questScript = (folder: string): string => SCRIPT_ALIAS[folder] ?? 'quest-' + folder.replace(/^quest_/, '').replace(/_/g, '') + '.ts';
// knowledge/quests.json has no row for these folders; points from research/quest-points-board.md (quest.constant lines).
export const QP_FALLBACK: Record<string, number> = { quest_cog: 1, quest_elemental_workshop: 1, quest_mm: 3, quest_troll_love: 2 };
export const VARP_FOLDER: Record<string, string> = { goblinquest: 'quest_gobdip', elenaquest: 'quest_elena', waterfall_quest: 'quest_waterfall', horrorquest: 'quest_horror' };

const defaultRoot = resolve(import.meta.dir, '../../../..');

// Journal labels are the names emitted by questFlags, not varps or script names.
export function questJournalNames(root = defaultRoot): Map<string, string> {
    return new Map(parseConfigs(readFileSync(join(root, QUEST_SOURCE), 'utf8'), QUEST_SOURCE)
        .filter(b => b.props.buttontype?.[0] === 'normal' && b.props.text?.[0])
        .map(b => [b.name === 'fortress' ? 'quest_blackknight' : `quest_${b.name}`, b.props.text![0]!]));
}
