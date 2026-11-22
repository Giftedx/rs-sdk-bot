import presetsJson from './presets-data.json';
import type { QuestSavePreset } from './types';

let overridePresets: Readonly<Record<string, QuestSavePreset>> | null = null;
const embeddedPresets = presetsJson as unknown as Readonly<Record<string, QuestSavePreset>>;

export function registerQuestPresets(presets: Readonly<Record<string, QuestSavePreset>> | null): void {
    overridePresets = presets;
}

export function presetConfig(key: string): QuestSavePreset | undefined {
    return overridePresets?.[key] ?? embeddedPresets[key];
}

export function questPresetKeys(): string[] {
    const keys = new Set<string>(Object.keys(embeddedPresets));
    if (overridePresets) {
        for (const k of Object.keys(overridePresets)) {
            if (k.startsWith('quest_')) keys.add(k);
        }
    }
    return [...keys].sort();
}
