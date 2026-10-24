// Lite client fix for locs on bridged tiles (patches/rs-sdk.md item 4).
//
// On a tile whose level-1 map flag has LinkBelow (0x2), the browser client moves the raw map levels down by one
// (World.setBridge): what the player sees and opens on level L is the raw level L + 1 loc. The engine does the same
// (engine/src/engine/GameMap.ts:230-236, 263-266) and sends loc changes for level L.
// The lite client does not:
// - SceneLite answers wallType/sceneType(level L) from the raw level L of its loc index (lite/world/LocIndex.ts:12-15),
//   so nearbyLocs on a bridge lists the locs under it and not the door on it;
// - zone.ts:22-36 keys LOC_ADD_CHANGE / LOC_DEL by level L, but CollisionBuilder.ts:63-72 reads raw level L + 1 for
//   the bridge and drops the level-L entry (L - 1 < 0). An opened door on a bridge stays closed in the collision map.
// This wrapper keys the loc changes of bridged tiles by raw level (L + 1) and makes SceneLite read raw level L + 1
// for them. Seen on the fishing platform (Sea Slug, door 2765,3287): "I can't reach that!" at the broken glass.

const LINK_BELOW = 0x2;

// SceneLite.ts overlayKey.
const overlayKey = (layer: number, level: number, x: number, z: number): number =>
    ((layer & 0x3) * 0x40000000) + ((level & 0x3) * 0x10000000) + ((x & 0x3fff) * 0x4000) + (z & 0x3fff);

export function fixBridgedLocChanges(client: any): boolean {
    const world = client?.world;
    const index = client?.locIndex;
    if (!world || !index || world.__bridgeFix) return false;
    const proto = Object.getPrototypeOf(world);
    if (typeof proto.valueAt !== 'function' || !(world.overlay instanceof Map)) return false;
    const raw = (level: number, x: number, z: number): number =>
        level < 3 && (index.mapFlags(1, x, z) & LINK_BELOW) !== 0 ? level + 1 : level;

    const addLoc = proto.addLoc;
    const delLoc = proto.delLoc;
    const clearZone = proto.clearZoneOverlay;
    const valueAt = proto.valueAt;
    world.addLoc = (level: number, x: number, z: number, id: number, shape: number, angle: number) =>
        addLoc.call(world, raw(level, x, z), x, z, id, shape, angle);
    world.delLoc = (level: number, x: number, z: number, shape: number) =>
        delLoc.call(world, raw(level, x, z), x, z, shape);
    world.clearZoneOverlay = (level: number, x0: number, z0: number) => {
        clearZone.call(world, level, x0, z0);
        const overlay: Map<number, number> = world.overlay;
        for (let x = x0; x < x0 + 8; x++) for (let z = z0; z < z0 + 8; z++) {
            const r = raw(level, x, z);
            if (r === level) continue;
            for (let layer = 0; layer < 4; layer++) if (overlay.delete(overlayKey(layer, r, x, z))) world.collisionDirty = true;
        }
    };
    world.valueAt = (layer: number, level: number, sceneX: number, sceneZ: number) =>
        valueAt.call(world, layer, raw(level, world.baseX + sceneX, world.baseZ + sceneZ), sceneX, sceneZ);
    world.__bridgeFix = true;
    // Locs changed before the fix (the login zone sync) were keyed by scene level; rebuild routing from what is left.
    world.collisionDirty = true;
    return true;
}
