const bindings = new WeakMap();

export function bindInternalSources(result, sources) { bindings.set(result, sources); }
export function internalSources(result) { return bindings.get(result) ?? null; }
