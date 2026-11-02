/**
 * Coercion helpers: turn unknown config values into typed ones with explicit
 * fallbacks. Centralized so every read of a volatile field behaves the same.
 *
 * @module dsh-model-failover/coerce
 */
/**
 * Unwrap a cosmokit volatile descriptor ({ get, [volatile.write] }) to its
 * current value. When the settings layer takes a namespace over, config
 * fields arrive as these descriptors; a plain read yields the wrapper object
 * and Array.isArray/typeof checks silently fail (the 2026-11-02 incident:
 * armed active → re-wired inactive within the same millisecond).
 * Non-descriptor values pass through untouched.
 */
export function unwrapVolatile(value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const get = value.get;
        if (typeof get === 'function') {
            try {
                return get();
            }
            catch {
                return value;
            }
        }
    }
    return value;
}
/** A finite non-negative number, or the fallback. */
export function finiteOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
/** The value when it is of the expected (structural) type, else undefined. */
export function valueOf(value) {
    return value;
}
/** Structurally-valid entries from an unknown list; everything else is dropped. */
export function entriesOf(value) {
    const list = valueOf(value);
    if (!Array.isArray(list))
        return [];
    const entries = [];
    for (const item of list) {
        if (item === null || typeof item !== 'object')
            continue;
        const entry = item;
        if (typeof entry.provider === 'string' && typeof entry.model === 'string') {
            entries.push({ provider: entry.provider, model: entry.model });
        }
    }
    return entries;
}
/** A non-empty trimmed string, or undefined. */
export function stringOf(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/** A list of non-empty trimmed strings; anything else yields []. */
export function stringListOf(value) {
    const list = valueOf(value);
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const item of list) {
        const text = stringOf(item);
        if (text !== undefined)
            out.push(text);
    }
    return out;
}
/** A boolean, or the fallback when absent/ill-typed. */
export function boolOf(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/** A finite number, or the fallback. */
export function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
