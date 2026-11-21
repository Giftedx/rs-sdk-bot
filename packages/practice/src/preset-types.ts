// Mirrors SaveConfig in vendor/rs-sdk/sdk/test/utils/save-generator.ts. createSaveData sets tutorial varp 281 = 1000 itself.
export interface SaveConfig {
    position?: { x: number; z: number; level?: number };
    skills?: Record<string, number>;
    inventory?: Array<{ id: number; count: number }>;
    equipment?: Array<{ id: number; count: number; slot: number }>;
    bank?: Array<{ id: number; count: number }>;
    coins?: number;
    varps?: Record<number, number>;
}
