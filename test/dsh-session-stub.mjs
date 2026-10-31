/**
 * Test stub for the host module the plugin resolves at runtime. Mirrors the
 * real contract closely enough for unit tests: appendPluginRecord(session,
 * type, data) commits an ignorable plugin record; the fake session exposes
 * append(), which the stub forwards to so tests can observe type + payload.
 */
export function appendPluginRecord(session, type, data) {
  return session?.append?.(type, data)
}
