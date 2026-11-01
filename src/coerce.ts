/**
 * Coercion helpers: turn unknown config values into typed ones with explicit
 * fallbacks. Centralized so every read of a volatile field behaves the same.
 *
 * @module dsh-model-failover/coerce
 */

import type { FailoverEntry } from './types.js'

/** A finite non-negative number, or the fallback. */
export function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The value when it is of the expected (structural) type, else undefined. */
export function valueOf<T>(value: unknown): T | undefined {
  return value as T | undefined
}

/** Structurally-valid entries from an unknown list; everything else is dropped. */
export function entriesOf(value: unknown): FailoverEntry[] {
  const list = valueOf<unknown[]>(value)
  if (!Array.isArray(list)) return []
  const entries: FailoverEntry[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.provider === 'string' && typeof entry.model === 'string') {
      entries.push({ provider: entry.provider, model: entry.model })
    }
  }
  return entries
}

/** A non-empty trimmed string, or undefined. */
export function stringOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** A list of non-empty trimmed strings; anything else yields []. */
export function stringListOf(value: unknown): string[] {
  const list = valueOf<unknown[]>(value)
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const text = stringOf(item)
    if (text !== undefined) out.push(text)
  }
  return out
}

/** A boolean, or the fallback when absent/ill-typed. */
export function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** A finite number, or the fallback. */
export function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
