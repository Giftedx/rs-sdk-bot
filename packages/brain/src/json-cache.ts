// Stat-validated in-memory JSON cache for large static/generated knowledge tables.
// Every lookup checks size + mtimeMs via statSync so on-disk updates invalidate immediately.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

interface CachedJsonEntry {
    readonly stamp: string;
    readonly value: unknown;
}

const MAX_CACHE_ENTRIES = 64;
const jsonCache = new Map<string, CachedJsonEntry>();

export function fileStatStamp(filePath: string): string {
    try {
        const st = statSync(filePath);
        return `${st.size}:${st.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

export function readJsonStatCached<T>(filePath: string): T | null {
    const resolved = resolve(filePath);
    const stamp = fileStatStamp(resolved);
    if (stamp === 'missing') {
        jsonCache.delete(resolved);
        return null;
    }
    const hit = jsonCache.get(resolved);
    if (hit && hit.stamp === stamp) {
        return hit.value as T;
    }
    try {
        const value = JSON.parse(readFileSync(resolved, 'utf8')) as T;
        if (jsonCache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = jsonCache.keys().next().value;
            if (oldestKey !== undefined) jsonCache.delete(oldestKey);
        }
        jsonCache.set(resolved, { stamp, value });
        return value;
    } catch {
        jsonCache.delete(resolved);
        return null;
    }
}

export function clearBrainJsonCache(): void {
    jsonCache.clear();
}
