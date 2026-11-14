// Deferred gates and the in-process queue can dispatch outside the issuing
// async context. Keep its validity check on the exact action until dispatch.
const actionScopes = new WeakMap<object, () => void>();

export function bindActionScope(action: object, check: () => void): void {
    const previous = actionScopes.get(action);
    actionScopes.set(action, previous ? () => { previous(); check(); } : check);
}

export function assertActionScope(action: unknown): void {
    if (action !== null && (typeof action === 'object' || typeof action === 'function')) actionScopes.get(action)?.();
}
