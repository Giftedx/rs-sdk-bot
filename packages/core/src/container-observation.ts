// Readiness belongs to this connection, not to a globally cached component.
const equipment = new WeakMap<object, boolean>();
export function equipmentObserved(client: object): boolean { return equipment.get(client) === true; }
export function setEquipmentObserved(client: object, ready: boolean): void { equipment.set(client, ready); }
