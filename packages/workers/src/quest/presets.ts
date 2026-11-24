import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuestSavePreset } from './types';

let overridePresets: Readonly<Record<string, QuestSavePreset>> | null = null;
let embeddedPresets: Readonly<Record<string, QuestSavePreset>> | undefined;

function getEmbeddedPresets(): Readonly<Record<string, QuestSavePreset>> {
    return (embeddedPresets ??= JSON.parse(
        readFileSync(join(import.meta.dir, 'presets-data.json'), 'utf8'),
    ) as Readonly<Record<string, QuestSavePreset>>);
}

export function registerQuestPresets(presets: Readonly<Record<string, QuestSavePreset>> | null): void {
    overridePresets = presets;
}

export function presetConfig(key: string): QuestSavePreset | undefined {
    return overridePresets?.[key] ?? getEmbeddedPresets()[key];
}

export function questPresetKeys(): string[] {
    const keys = new Set<string>(Object.keys(getEmbeddedPresets()));
    if (overridePresets) {
        for (const k of Object.keys(overridePresets)) {
            if (k.startsWith('quest_')) keys.add(k);
        }
    }
    return [...keys].sort();
}
