/**
 * Coercion helpers: turn unknown config values into typed ones with explicit
 * fallbacks. Centralized so every read of a volatile field behaves the same.
 *
 * @module dsh-model-failover/coerce
 */
import type { FailoverEntry } from './types.js';
/**
 * Unwrap a cosmokit volatile descriptor ({ get, [volatile.write] }) to its
 * current value. When the settings layer takes a namespace over, config
 * fields arrive as these descriptors; a plain read yields the wrapper object
 * and Array.isArray/typeof checks silently fail (the 2026-11-02 incident:
 * armed active → re-wired inactive within the same millisecond).
 * Non-descriptor values pass through untouched.
 */
export declare function unwrapVolatile<T>(value: unknown): T | undefined;
/** A finite non-negative number, or the fallback. */
export declare function finiteOr(value: unknown, fallback: number): number;
/** The value when it is of the expected (structural) type, else undefined. */
export declare function valueOf<T>(value: unknown): T | undefined;
/** Structurally-valid entries from an unknown list; everything else is dropped. */
export declare function entriesOf(value: unknown): FailoverEntry[];
/** A non-empty trimmed string, or undefined. */
export declare function stringOf(value: unknown): string | undefined;
/** A list of non-empty trimmed strings; anything else yields []. */
export declare function stringListOf(value: unknown): string[];
/** A boolean, or the fallback when absent/ill-typed. */
export declare function boolOf(value: unknown, fallback: boolean): boolean;
/** A finite number, or the fallback. */
export declare function numberOr(value: unknown, fallback: number): number;
